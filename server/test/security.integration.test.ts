import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, test } from 'node:test';
import { generate } from 'otplib';

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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

async function jsonRequest(
  base: string,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function responseCookie(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';', 1)[0];
}

test('security-sensitive setup, session and vault boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-security-'));
  tempRoots.push(root);
  const dataDir = path.join(root, 'data');
  const vaultDir = path.join(root, 'vault');
  const outsideDir = path.join(root, 'outside');
  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(vaultDir, { recursive: true }),
    fs.mkdir(outsideDir, { recursive: true }),
  ]);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer({
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    VAULT_PATH: vaultDir,
    ALLOWED_ROOTS: vaultDir,
    WEBOBSIDIAN_PASSWORD: '',
    UPLOAD_MAX_BYTES: '1024',
    NODE_ENV: 'production',
  });
  await waitForHealth(base, child);

  const status = await jsonRequest(base, '/auth/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { passwordSet: boolean }).passwordSet, false);

  const defaultLogin = await jsonRequest(base, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password: '123456' }),
  });
  assert.equal(defaultLogin.status, 401);

  const weakSetup = await jsonRequest(base, '/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ password: 'too-short' }),
  });
  assert.equal(weakSetup.status, 400);

  const firstPassword = 'correct horse battery staple';
  const setup = await jsonRequest(base, '/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ password: firstPassword }),
  });
  assert.equal(setup.status, 200);
  const oldCookie = responseCookie(setup);
  assert.match(oldCookie, /^webobsidian_token=/);

  const secondSetup = await jsonRequest(base, '/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ password: 'another secure password' }),
  });
  assert.equal(secondSetup.status, 409);

  const bypass = await jsonRequest(base, '/api/settings', {
    method: 'PUT',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({ vault: { path: outsideDir, allowedRoots: [outsideDir] } }),
  });
  assert.equal(bypass.status, 403);
  const emptyPath = await jsonRequest(base, '/api/settings', {
    method: 'PUT',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({ vault: { path: '' } }),
  });
  assert.equal(emptyPath.status, 400);

  const symlink = path.join(vaultDir, 'outside-link');
  await fs.symlink(outsideDir, symlink, 'dir');
  const symlinkEscape = await jsonRequest(base, '/api/settings', {
    method: 'PUT',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({ vault: { path: symlink } }),
  });
  assert.equal(symlinkEscape.status, 403);

  const badTrash = await jsonRequest(base, '/api/settings', {
    method: 'PUT',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({ vault: { trash: '../outside' } }),
  });
  assert.equal(badTrash.status, 400);

  const upload = new FormData();
  upload.set('dir', 'attachments');
  upload.set('file', new Blob(['disk-backed upload']), 'safe.txt');
  const uploaded = await fetch(`${base}/api/files/upload`, {
    method: 'POST',
    headers: { Cookie: oldCookie },
    body: upload,
  });
  assert.equal(uploaded.status, 200);
  assert.equal(await fs.readFile(path.join(vaultDir, 'attachments', 'safe.txt'), 'utf8'), 'disk-backed upload');

  const oversized = new FormData();
  oversized.set('file', new Blob([Buffer.alloc(2048)]), 'oversized.bin');
  const rejectedUpload = await fetch(`${base}/api/files/upload`, {
    method: 'POST',
    headers: { Cookie: oldCookie },
    body: oversized,
  });
  assert.equal(rejectedUpload.status, 413);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads')), []);

  assert.equal((await jsonRequest(base, '/api/files/content', {
    method: 'PUT',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({ path: 'shared.md', content: '# Shared' }),
  })).status, 200);

  const drawing = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'webobsidian',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  });
  assert.equal((await jsonRequest(base, '/api/files/content', {
    method: 'PUT',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({ path: 'Drawing.excalidraw', content: drawing }),
  })).status, 200);
  const drawingRead = await jsonRequest(base, '/api/files/content?path=Drawing.excalidraw', {
    headers: { Cookie: oldCookie },
  });
  assert.equal(drawingRead.status, 200);
  assert.equal((await drawingRead.json() as { content: string }).content, drawing);

  // Excalidraw can issue overlapping autosaves (and multiple browser tabs can
  // save the same drawing at once). Every atomic write must use its own temp
  // file; timestamp-only names used to collide and make one request fail with
  // ENOENT while renaming the shared temp file.
  const concurrentDrawings = Array.from({ length: 64 }, (_, index) => JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'webobsidian',
    elements: [],
    appState: { name: `concurrent-${index}` },
    files: {},
  }));
  const concurrentWrites = await Promise.all(concurrentDrawings.map((content) =>
    jsonRequest(base, '/api/files/content', {
      method: 'PUT',
      headers: { Cookie: oldCookie },
      body: JSON.stringify({ path: 'Concurrent.excalidraw', content }),
    })));
  assert.deepEqual(concurrentWrites.map((response) => response.status), Array(64).fill(200));
  const concurrentRead = await jsonRequest(base, '/api/files/content?path=Concurrent.excalidraw', {
    headers: { Cookie: oldCookie },
  });
  assert.equal(concurrentRead.status, 200);
  assert.ok(concurrentDrawings.includes((await concurrentRead.json() as { content: string }).content));
  assert.deepEqual(
    (await fs.readdir(vaultDir)).filter((name) => name.includes('webobsidian-tmp-')),
    [],
  );

  // Community plugins are loaded through a same-origin ESM wrapper. This keeps
  // production CSP strict (no unsafe-eval), while preserving Obsidian's bundled
  // CommonJS `require('obsidian')` contract. Plugin data and nested resources
  // must remain confined to the plugin's own directory.
  const pluginDir = path.join(vaultDir, '.obsidian', 'plugins', 'runtime-smoke');
  await fs.mkdir(path.join(pluginDir, 'fonts'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify({
      id: 'runtime-smoke',
      name: 'Runtime smoke',
      version: '1.0.0',
      minAppVersion: '1.0.0',
      description: 'Exercises the browser compatibility runtime',
      author: 'WebObsidian',
    })),
    fs.writeFile(path.join(pluginDir, 'main.js'), "const { Plugin } = require('obsidian'); module.exports = class extends Plugin { onload() {} };"),
    fs.writeFile(path.join(pluginDir, 'styles.css'), '@font-face{font-family:smoke;src:url(fonts/test.woff2)}'),
    fs.writeFile(path.join(pluginDir, 'fonts', 'test.woff2'), Buffer.from([0, 1, 2, 3])),
  ]);

  const installedPlugins = await jsonRequest(base, '/api/plugins/', { headers: { Cookie: oldCookie } });
  assert.equal(installedPlugins.status, 200);
  assert.equal((await installedPlugins.json() as { plugins: { id: string }[] }).plugins[0]?.id, 'runtime-smoke');
  assert.equal((await jsonRequest(base, '/api/plugins/runtime-smoke/enabled', {
    method: 'PATCH', headers: { Cookie: oldCookie }, body: JSON.stringify({ enabled: true }),
  })).status, 200);

  const pluginModule = await jsonRequest(base, '/api/plugins/runtime-smoke/module.js', { headers: { Cookie: oldCookie } });
  assert.equal(pluginModule.status, 200);
  assert.match(pluginModule.headers.get('content-type') ?? '', /application\/javascript/);
  const moduleSource = await pluginModule.text();
  assert.match(moduleSource, /globalThis\.__webObsidianRequire\("runtime-smoke", name\)/);
  assert.match(moduleSource, /module\.exports = class extends Plugin/);
  const runtimeGlobal = globalThis as typeof globalThis & { __webObsidianRequire?: (id: string, name: string) => unknown };
  runtimeGlobal.__webObsidianRequire = (id, name) => {
    assert.equal(id, 'runtime-smoke');
    assert.equal(name, 'obsidian');
    return { Plugin: class {} };
  };
  try {
    const wrapped = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
    assert.equal(typeof wrapped.default, 'function');
  } finally {
    delete runtimeGlobal.__webObsidianRequire;
  }

  const emptyPluginData = await jsonRequest(base, '/api/plugins/runtime-smoke/data', { headers: { Cookie: oldCookie } });
  assert.deepEqual(await emptyPluginData.json(), { data: {} });
  assert.equal((await jsonRequest(base, '/api/plugins/runtime-smoke/data', {
    method: 'PUT', headers: { Cookie: oldCookie }, body: JSON.stringify({ data: { enabled: true, count: 3 } }),
  })).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(pluginDir, 'data.json'), 'utf8')), { enabled: true, count: 3 });

  const nestedPluginAsset = await jsonRequest(base, '/api/plugins/runtime-smoke/fonts/test.woff2', { headers: { Cookie: oldCookie } });
  assert.equal(nestedPluginAsset.status, 200);
  assert.match(nestedPluginAsset.headers.get('content-type') ?? '', /font\/woff2/);
  assert.deepEqual(Buffer.from(await nestedPluginAsset.arrayBuffer()), Buffer.from([0, 1, 2, 3]));
  const pluginTraversal = await jsonRequest(base, '/api/plugins/runtime-smoke/%2e%2e%2fmanifest.json', { headers: { Cookie: oldCookie } });
  assert.equal(pluginTraversal.status, 400);

  const shareResponse = await jsonRequest(base, '/api/shares', {
    method: 'POST',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({ path: 'shared.md' }),
  });
  const shareId = (await shareResponse.json() as { share: { id: string } }).share.id;
  assert.equal((await jsonRequest(base, `/api/shares/${shareId}`, {
    method: 'PATCH',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({ password: 'share password' }),
  })).status, 200);
  const unlocked = await jsonRequest(base, `/public/shares/${shareId}/unlock`, {
    method: 'POST',
    headers: { 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password: 'share password' }),
  });
  assert.equal(unlocked.status, 200);
  assert.match(unlocked.headers.get('set-cookie') ?? '', /;\s*Secure(?:;|$)/i);
  for (let i = 0; i < 9; i += 1) {
    const wrong = await jsonRequest(base, `/public/shares/${shareId}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ password: 'wrong password' }),
    });
    assert.equal(wrong.status, 401);
  }
  assert.equal((await jsonRequest(base, `/public/shares/${shareId}/unlock`, {
    method: 'POST',
    body: JSON.stringify({ password: 'wrong password' }),
  })).status, 429);

  const changed = await jsonRequest(base, '/auth/change-password', {
    method: 'POST',
    headers: { Cookie: oldCookie },
    body: JSON.stringify({
      currentPassword: firstPassword,
      newPassword: 'a newer and safer password',
    }),
  });
  assert.equal(changed.status, 200);
  const newCookie = responseCookie(changed);
  assert.match(newCookie, /^webobsidian_token=/);

  assert.equal((await jsonRequest(base, '/auth/me', { headers: { Cookie: oldCookie } })).status, 401);
  assert.equal((await jsonRequest(base, '/auth/me', { headers: { Cookie: newCookie } })).status, 200);

  child.kill('SIGTERM');
  await once(child, 'exit');

  const settingsFile = path.join(dataDir, 'settings.json');
  const persisted = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as { vault: { path: string } };
  persisted.vault.path = outsideDir;
  await fs.writeFile(settingsFile, JSON.stringify(persisted), 'utf8');
  const rejectedStartup = startServer({
    HOST: '127.0.0.1',
    PORT: String(await freePort()),
    DATA_DIR: dataDir,
    VAULT_PATH: vaultDir,
    ALLOWED_ROOTS: vaultDir,
    WEBOBSIDIAN_PASSWORD: '',
    NODE_ENV: 'production',
  });
  const [startupCode] = await once(rejectedStartup, 'exit') as [number | null, NodeJS.Signals | null];
  assert.notEqual(startupCode, 0);
});

test('corrupt settings fail closed without being overwritten', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-corrupt-'));
  tempRoots.push(root);
  const dataDir = path.join(root, 'data');
  const vaultDir = path.join(root, 'vault');
  await Promise.all([fs.mkdir(dataDir), fs.mkdir(vaultDir)]);
  const settingsFile = path.join(dataDir, 'settings.json');
  const corrupt = '{"auth":';
  await fs.writeFile(settingsFile, corrupt, 'utf8');
  const child = startServer({
    HOST: '127.0.0.1',
    PORT: String(await freePort()),
    DATA_DIR: dataDir,
    VAULT_PATH: vaultDir,
    ALLOWED_ROOTS: vaultDir,
    WEBOBSIDIAN_PASSWORD: '',
    NODE_ENV: 'production',
  });
  const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  assert.notEqual(code, 0);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), corrupt);
});

test('TOTP enrollment, recovery login, replay protection and Passkey options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-mfa-'));
  tempRoots.push(root);
  const dataDir = path.join(root, 'data');
  const vaultDir = path.join(root, 'vault');
  await Promise.all([fs.mkdir(dataDir), fs.mkdir(vaultDir)]);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer({
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    VAULT_PATH: vaultDir,
    ALLOWED_ROOTS: vaultDir,
    WEBOBSIDIAN_PASSWORD: '',
    NODE_ENV: 'production',
  });
  await waitForHealth(base, child);

  const password = 'a strong MFA test password';
  const setupPasswordResponse = await jsonRequest(base, '/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  assert.equal(setupPasswordResponse.status, 200);
  const initialCookie = responseCookie(setupPasswordResponse);

  const wrongPassword = await jsonRequest(base, '/auth/totp/setup/start', {
    method: 'POST',
    headers: { Cookie: initialCookie },
    body: JSON.stringify({ currentPassword: 'incorrect password' }),
  });
  assert.equal(wrongPassword.status, 401);

  const totpStart = await jsonRequest(base, '/auth/totp/setup/start', {
    method: 'POST',
    headers: { Cookie: initialCookie },
    body: JSON.stringify({ currentPassword: password }),
  });
  assert.equal(totpStart.status, 200);
  const totpSetup = await totpStart.json() as {
    setupId: string;
    secret: string;
    uri: string;
  };
  assert.match(totpSetup.uri, /^otpauth:\/\/totp\//);

  const firstCode = await generate({ secret: totpSetup.secret });
  const totpVerify = await jsonRequest(base, '/auth/totp/setup/verify', {
    method: 'POST',
    headers: { Cookie: initialCookie },
    body: JSON.stringify({ setupId: totpSetup.setupId, code: firstCode }),
  });
  assert.equal(totpVerify.status, 200);
  const enabledCookie = responseCookie(totpVerify);
  const enabledResult = await totpVerify.json() as { recoveryCodes: string[] };
  assert.equal(enabledResult.recoveryCodes.length, 10);
  assert.equal(new Set(enabledResult.recoveryCodes).size, 10);
  assert.equal((await jsonRequest(base, '/auth/me', {
    headers: { Cookie: initialCookie },
  })).status, 401);

  const persistedRaw = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8');
  assert.equal(persistedRaw.includes(totpSetup.secret), false);
  assert.equal(persistedRaw.includes(enabledResult.recoveryCodes[0]), false);

  const passwordLogin = await jsonRequest(base, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  assert.equal(passwordLogin.status, 200);
  assert.equal(passwordLogin.headers.get('set-cookie'), null);
  const passwordStep = await passwordLogin.json() as {
    requiresTwoFactor: boolean;
    twoFactorToken: string;
  };
  assert.equal(passwordStep.requiresTwoFactor, true);

  // The TOTP used during enrollment is protected against replay in the same
  // 30-second time step.
  assert.equal((await jsonRequest(base, '/auth/login/totp', {
    method: 'POST',
    body: JSON.stringify({
      twoFactorToken: passwordStep.twoFactorToken,
      code: firstCode,
    }),
  })).status, 401);

  const recoveryLogin = await jsonRequest(base, '/auth/login/totp', {
    method: 'POST',
    body: JSON.stringify({
      twoFactorToken: passwordStep.twoFactorToken,
      code: enabledResult.recoveryCodes[0],
    }),
  });
  assert.equal(recoveryLogin.status, 200);
  const recoveryCookie = responseCookie(recoveryLogin);
  const recoveryResult = await recoveryLogin.json() as {
    method: string;
    recoveryCodesRemaining: number;
  };
  assert.equal(recoveryResult.method, 'recovery');
  assert.equal(recoveryResult.recoveryCodesRemaining, 9);
  assert.equal((await jsonRequest(base, '/auth/me', {
    headers: { Cookie: enabledCookie },
  })).status, 401);
  assert.equal((await jsonRequest(base, '/auth/me', {
    headers: { Cookie: recoveryCookie },
  })).status, 200);

  const passkeyOverInsecureOrigin = await jsonRequest(base, '/auth/passkeys/register/options', {
    method: 'POST',
    headers: { Cookie: recoveryCookie, Origin: 'http://notes.example.com' },
    body: JSON.stringify({ currentPassword: password, name: 'Test key' }),
  });
  assert.equal(passkeyOverInsecureOrigin.status, 400);

  const passkeyOptions = await jsonRequest(base, '/auth/passkeys/register/options', {
    method: 'POST',
    headers: { Cookie: recoveryCookie, Origin: 'https://notes.example.com' },
    body: JSON.stringify({ currentPassword: password, name: 'Test key' }),
  });
  assert.equal(passkeyOptions.status, 200);
  const passkeyBody = await passkeyOptions.json() as {
    ceremonyId: string;
    options: { rp: { id: string }; authenticatorSelection?: { residentKey?: string } };
  };
  assert.equal(passkeyBody.options.rp.id, 'notes.example.com');
  assert.equal(passkeyBody.options.authenticatorSelection?.residentKey, 'required');
  const malformedPasskey = {
    id: 'not-a-real-credential',
    rawId: 'not-a-real-credential',
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: '', attestationObject: '' },
  };
  assert.equal((await jsonRequest(base, '/auth/passkeys/register/verify', {
    method: 'POST',
    headers: { Cookie: recoveryCookie },
    body: JSON.stringify({
      ceremonyId: passkeyBody.ceremonyId,
      response: malformedPasskey,
    }),
  })).status, 400);
  // Registration ceremonies are one-time even when verification fails.
  assert.equal((await jsonRequest(base, '/auth/passkeys/register/verify', {
    method: 'POST',
    headers: { Cookie: recoveryCookie },
    body: JSON.stringify({
      ceremonyId: passkeyBody.ceremonyId,
      response: malformedPasskey,
    }),
  })).status, 400);

  // A recovery code is single-use, including across fresh password steps.
  const secondPasswordStep = await jsonRequest(base, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  const secondToken = (await secondPasswordStep.json() as { twoFactorToken: string }).twoFactorToken;
  assert.equal((await jsonRequest(base, '/auth/login/totp', {
    method: 'POST',
    body: JSON.stringify({
      twoFactorToken: secondToken,
      code: enabledResult.recoveryCodes[0],
    }),
  })).status, 401);

  const disabled = await jsonRequest(base, '/auth/totp/disable', {
    method: 'POST',
    headers: { Cookie: recoveryCookie },
    body: JSON.stringify({
      currentPassword: password,
      code: enabledResult.recoveryCodes[1],
    }),
  });
  assert.equal(disabled.status, 200);
  const disabledCookie = responseCookie(disabled);
  const directLogin = await jsonRequest(base, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  assert.equal((await directLogin.json() as { requiresTwoFactor: boolean }).requiresTwoFactor, false);
  assert.equal((await jsonRequest(base, '/auth/me', {
    headers: { Cookie: disabledCookie },
  })).status, 200);
});
