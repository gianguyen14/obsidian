import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, test } from 'node:test';

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
