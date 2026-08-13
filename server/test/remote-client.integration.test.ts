import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, test } from 'node:test';

/**
 * Guards the same-origin SPA used by the hosted web app and the embedded
 * Electron service, plus the remote API used by the Android prototype.
 *
 * Both clients load the SPA straight from the server's own origin rather than
 * bundling it. That single choice is what lets them reuse the browser code
 * unchanged: every request stays same-origin, so the session cookie, the
 * root-relative API paths, the `<img src>` attachment URLs and the WebSocket
 * upgrade all keep working with no base-URL or Bearer plumbing.
 *
 * These tests pin the three server behaviours that choice depends on. If one
 * breaks, the native clients break in ways that are hard to trace back here.
 */

const tempRoots: string[] = [];
const children: ChildProcess[] = [];

after(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function startServer(env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming healthy (${child.exitCode})`);
    }
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}

/** Raw HTTP upgrade so we can assert on the status line the server writes. */
function wsUpgrade(
  port: number,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('upgrade timed out'));
    }, 5000);
    const done = (value: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.on('connect', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n\r\n')) done(data.split('\r\n')[0]);
    });
    // A rejected upgrade may be closed without any response at all.
    socket.on('close', () => done(data.split('\r\n')[0] ?? ''));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('remote-client foundations: SPA fallback, same-origin policy, WS auth', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-remote-'));
  tempRoots.push(root);
  const dataDir = path.join(root, 'data');
  const vaultDir = path.join(root, 'vault');
  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(vaultDir, { recursive: true }),
  ]);

  // The SPA fallback only mounts when server/public exists (it is created by
  // `npm run build`). Create a stand-in so this test does not depend on a
  // prior build step, and remember whether we own it.
  const publicDir = path.resolve(import.meta.dirname, '..', 'public');
  const indexHtml = path.join(publicDir, 'index.html');
  let createdPublic = false;
  try {
    await fs.access(indexHtml);
  } catch {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(indexHtml, '<!doctype html><div id="root"></div>', 'utf8');
    createdPublic = true;
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer({
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    VAULT_PATH: vaultDir,
    ALLOWED_ROOTS: vaultDir,
    WEBOBSIDIAN_PASSWORD: '',
    // Production mode is the point of the CORS assertion below.
    NODE_ENV: 'production',
  });

  try {
    await waitForHealth(base, child);

    // 1. SPA fallback. Both clients open a deep link (or reload on one) and
    //    must receive index.html rather than a 404, otherwise the app dies on
    //    any route that is not "/".
    const deepLink = await fetch(`${base}/some/deep/note/path`);
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await deepLink.text(), /<div id="root">/);

    // API misses must stay JSON — the SPA fallback must not swallow them, or
    // clients get HTML where they parse JSON (the exact failure mode behind
    // the plugin-uninstall bug in PRD 1.7). Unauthenticated, the auth
    // middleware answers first with 401; either way it must not be HTML.
    const apiMiss = await fetch(`${base}/api/definitely-not-a-route`);
    assert.ok([401, 404].includes(apiMiss.status), `unexpected status ${apiMiss.status}`);
    assert.doesNotMatch(apiMiss.headers.get('content-type') ?? '', /text\/html/);
    assert.ok('error' in (await apiMiss.json()));

    // 2. No CORS in production. The native clients are same-origin by design,
    //    so they need no CORS. This asserts the converse: a foreign origin is
    //    NOT granted access. It is a defensive regression test — if someone
    //    later widens CORS to "make the mobile app work", this goes red and
    //    forces the security conversation instead of silently exposing the
    //    vault API to every website the user visits.
    const foreign = await fetch(`${base}/auth/status`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    assert.equal(foreign.headers.get('access-control-allow-credentials'), null);

    // 3. WebSocket upgrade is auth-gated, and the cookie is a valid credential
    //    for it. The browser WebSocket API cannot send an Authorization
    //    header, so cookie auth is the only path available to the clients —
    //    losing it would mean no live sync on desktop or mobile.
    assert.match(await wsUpgrade(port, {}), /401/);

    const setup = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    assert.equal(setup.status, 200);
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';', 1)[0];
    assert.match(cookie, /^webobsidian_token=/);

    // Workspace state is installation-local even when clients happen to use
    // one server. Sharing a vault must never share the note/tab being viewed.
    const workspaceA = 'browser_installation_a';
    const workspaceB = 'desktop_installation_b';
    const saveA = await fetch(`${base}/api/uistate/`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-Client-Id': 'tab-a',
        'X-Workspace-Id': workspaceA,
      },
      body: JSON.stringify({ activePath: 'Web-only.md' }),
    });
    assert.equal(saveA.status, 200);
    const readA = await fetch(`${base}/api/uistate/`, {
      headers: { Cookie: cookie, 'X-Workspace-Id': workspaceA },
    });
    const readB = await fetch(`${base}/api/uistate/`, {
      headers: { Cookie: cookie, 'X-Workspace-Id': workspaceB },
    });
    assert.deepEqual(await readA.json(), { activePath: 'Web-only.md' });
    assert.deepEqual(await readB.json(), {});

    const missingWorkspace = await fetch(`${base}/api/uistate/`, { headers: { Cookie: cookie } });
    assert.equal(missingWorkspace.status, 400);

    assert.match(await wsUpgrade(port, { Cookie: cookie }), /101/);
  } finally {
    if (createdPublic) await fs.rm(publicDir, { recursive: true, force: true });
  }
});
