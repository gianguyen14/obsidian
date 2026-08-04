import express, { type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';

import { config } from './config.js';
import { loadSettings, getSettings, setPasswordIfInitial } from './bootstrap.js';
import { errorHandler } from './middleware/error.js';
import { COOKIE_NAME } from './middleware/auth.js';
import { isPasswordSet, verifyToken } from './services/auth.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { searchRouter } from './routes/search.js';
import { settingsRouter } from './routes/settings.js';
import { gitRouter } from './routes/git.js';
import { keysRouter } from './routes/keys.js';
import { communityPluginsRouter, pluginsRouter } from './routes/plugins.js';
import { agentRouter } from './routes/agent.js';
import { uiStateRouter } from './routes/uistate.js';
import { sharesRouter, publicSharesRouter } from './routes/shares.js';
import { sharePageRouter } from './routes/sharepage.js';
import { initSearch, qmd } from './services/search.js';
import { buildLinkGraph, updateLinkGraphForFile } from './services/links.js';
import { buildFileIndex, indexFile, unindexFile } from './services/fileindex.js';
import { setBroadcaster, broadcast } from './services/realtime.js';
import { getVaultRoot, ensureVault, invalidateStat } from './services/vault.js';
import { startAutoSync } from './services/autosync.js';
import { assertVaultPathAllowed } from './services/pathpolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  process.exit(1);
});

async function main() {
  await loadSettings();
  const settings = await getSettings();
  await assertVaultPathAllowed(settings.vault.path, settings.vault.path);
  await setPasswordIfInitial();
  if (config.isProd && !isLoopbackHost(config.host) && !(await isPasswordSet())) {
    throw new Error(
      'Refusing to expose an unconfigured production instance. Set WEBOBSIDIAN_PASSWORD ' +
      'or bind HOST to 127.0.0.1 and complete first-run setup locally.',
    );
  }
  await ensureVault();

  const app = express();
  // Honour X-Forwarded-* per the deployment's proxy topology (TRUST_PROXY).
  // Default true (trust the immediate hop) so X-Forwarded-Proto-based `Secure`
  // cookies work behind the recommended reverse-proxy setup without extra config.
  // This is safe against F-03: the login rate limiter keys on the TCP socket
  // address (see middleware/ratelimit.ts), not the spoofable X-Forwarded-For.
  // Set TRUST_PROXY=false for a directly-exposed instance with no proxy.
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '32mb' }));
  app.use(cookieParser());

  // Per-request CSP nonce — used by the SSR share page's inline <script>.
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });
  // The loader itself is CSP-safe, but some otherwise browser-compatible
  // community plugins compile WebAssembly or unpack bundled dependencies with
  // `new Function`/`eval` (Breadcrumbs and Excalidraw are current examples).
  // Enable those capabilities only while community-plugin mode is active. The
  // unauthenticated public-share surface always keeps the strict policy.
  const strictSecurityHeaders = createSecurityHeaders(false);
  const pluginSecurityHeaders = createSecurityHeaders(true);
  app.use((req, res, next) => {
    const publicShare = req.path === '/share' || req.path.startsWith('/share/') || req.path.startsWith('/public/shares/');
    void getSettings()
      .then((current) => {
        const pluginMode = current.plugins.enabled.length > 0 && !publicShare;
        (pluginMode ? pluginSecurityHeaders : strictSecurityHeaders)(req, res, next);
      })
      .catch(next);
  });

  if (!config.isProd) {
    app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  }

  // Health (no auth) — for docker healthcheck
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Routes. NOTE: specific /api/* routers must be registered BEFORE the broad
  // '/api' search router, whose router-level requireAuth middleware would
  // otherwise gate every /api/* path (incl. /api/v1 and /api/keys) by prefix.
  app.use('/auth', authRouter);
  app.use('/api/v1', agentRouter); // agent API (api-key auth)
  app.use('/api/files', filesRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/git', gitRouter);
  app.use('/api/keys', keysRouter);
  app.use('/api/community-plugins', communityPluginsRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/uistate', uiStateRouter);
  app.use('/api/shares', sharesRouter); // manage public share links (auth)
  app.use('/public/shares', publicSharesRouter); // shared-note content (NO auth)
  app.use('/share', sharePageRouter); // SSR public share page (NO auth, SEO/OG meta)
  app.use('/api', searchRouter); // /api/search, /api/tags, /api/backlinks, /api/graph...

  // Static SPA (built into server/public)
  const publicDir = path.join(__dirname, '..', 'public');
  if (await dirExists(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/public')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  // Build search index + link graph
  console.log('[boot] indexing vault...');
  await initSearch();
  await buildLinkGraph();
  await buildFileIndex();
  console.log('[boot] index ready');

  const server = http.createServer(app);
  setupWebsocket(server);
  await setupWatcher();
  startAutoSync();

  server.listen(config.port, config.host, () => {
    console.log(`\n  WebObsidian server → http://${config.host}:${config.port}`);
    console.log(`  Vault: ${config.defaultVaultPath}`);
    console.log(`  Data:  ${config.dataDir}\n`);
  });
}

/**
 * Security headers shared by the strict app and community-plugin modes.
 * `unsafe-eval` does not allow inline script tags; it only permits dynamic code
 * generation required by trusted Obsidian plugin bundles. Public shares never
 * receive this relaxed variant.
 */
function createSecurityHeaders(allowPluginCodeGeneration: boolean) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          (_req, res) => `'nonce-${(res as Response).locals.cspNonce}'`,
          ...(allowPluginCodeGeneration ? ["'unsafe-eval'", "'wasm-unsafe-eval'"] : []),
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameSrc: ["'self'", 'blob:'],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Would break plain-HTTP self-hosting.
        upgradeInsecureRequests: null,
      },
    },
    // Allow social crawlers / other sites to load public share og:images.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
}

function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
}

// --- WebSocket: broadcast filesystem & UI-state events to connected clients ----
// Auth-gated: the WS stream leaks vault structure (paths of created/changed/deleted
// files), so the upgrade is rejected unless the request carries a valid session.
function setupWebsocket(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const token = cookieValue(req.headers.cookie, COOKIE_NAME) ?? bearerToken(req.headers.authorization);
    void (async () => {
      if (!token || !(await verifyToken(token))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    })();
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello' }));
  });
  setBroadcaster((msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  });
}

/** Parse a single cookie value out of a raw `Cookie:` header (no cookie-parser on upgrade). */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

// --- chokidar watcher: reflect external changes (git pull, direct edits) ---
async function setupWatcher() {
  const root = await getVaultRoot();
  // WEBOBSIDIAN_WATCH: 'auto' (default) = native inotify with automatic polling
  // fallback when the host watch limit is exceeded; 'polling' = force polling.
  const forcePolling = (process.env.WEBOBSIDIAN_WATCH ?? 'auto').toLowerCase() === 'polling';
  startWatcher(root, forcePolling);
}

function startWatcher(root: string, usePolling: boolean) {
  const watcher = chokidar.watch(root, {
    // Ignore VCS/dep/trash dirs AND `.obsidian` — the desktop Obsidian app
    // rewrites its workspace/state files constantly, which otherwise floods the
    // server with events (→ broadcasts → full tree refetches) and pins the CPU.
    ignored: (p) =>
      /(^|[/\\])(\.git|\.obsidian|node_modules|\.trash)([/\\]|$)/.test(p) ||
      /(^|[/\\])\.webobsidian-tmp-[^/\\]+$/.test(p),
    ignoreInitial: true,
    persistent: true,
    usePolling,
    interval: 1000,
    binaryInterval: 3000,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  // On a fresh VPS the kernel's `fs.inotify.max_user_watches` is often far below
  // the file count of a large vault, so native watching fails with ENOSPC/EMFILE.
  // Self-heal by transparently switching to polling (no inotify), and tell the
  // operator how to restore native (cheaper) watching.
  let degraded = false;
  watcher.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!usePolling && !degraded && (code === 'ENOSPC' || code === 'EMFILE')) {
      degraded = true;
      console.warn(
        `[watcher] native file watching hit ${code} (host inotify limit too low ` +
        `for this vault). Falling back to polling. For lower CPU, raise the limit: ` +
        `sudo sysctl -w fs.inotify.max_user_watches=524288`,
      );
      watcher.close().catch(() => {});
      startWatcher(root, true);
      return;
    }
    console.error('[watcher] error:', err);
  });

  const onChange = async (absPath: string, type: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    // keep the attachment/file index in sync for embed resolution
    if (type === 'add') indexFile(rel);
    else if (type === 'unlink') unindexFile(rel);
    // Drop the cached mtime/ctime so the next listTree re-stats just this file.
    invalidateStat(rel);
    if (/\.(md|markdown)$/i.test(rel)) {
      // Update only the changed file in the search + link indexes (O(1)) — a full
      // buildLinkGraph() re-reads every note in the vault and was the main CPU sink
      // when Obsidian touched files in the background.
      if (type === 'unlink') {
        qmd.remove(rel);
        await updateLinkGraphForFile(rel, true).catch(() => {});
      } else {
        await qmd.upsert(rel).catch(() => {});
        await updateLinkGraphForFile(rel).catch(() => {});
      }
    }
    broadcast({ type: 'fs', event: type, path: rel });
  };
  watcher
    .on('add', (p) => onChange(p, 'add'))
    .on('change', (p) => onChange(p, 'change'))
    .on('unlink', (p) => onChange(p, 'unlink'))
    .on('addDir', (p) => onChange(p, 'addDir'))
    .on('unlinkDir', (p) => onChange(p, 'unlinkDir'));
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
