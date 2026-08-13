import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..');
const electron = path.join(repoDir, 'node_modules', 'electron', 'dist', 'electron');
const packaged = process.argv.includes('--packaged');
const executable = packaged ? path.join(desktopDir, 'release', 'linux-unpacked', 'webobsidian') : electron;

async function debugPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForLocalWindow(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode})`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((item) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url));
      if (target) return target;
    } catch {
      // Electron or the embedded service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the local-first Electron window');
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-local-smoke-'));
const vault = path.join(root, 'vault');
await fs.mkdir(vault);
await fs.writeFile(path.join(vault, 'Desktop-only.md'), '# Desktop only\n');
await fs.writeFile(path.join(root, 'desktop-config.json'), JSON.stringify({
  vaultPath: vault,
  secret: 'desktop-smoke-secret-123456789',
  dataDirName: 'server-data-v3',
}));

const port = await debugPort();
const environment = { ...process.env, WEBOBSIDIAN_SERVER_URL: 'https://must-not-be-used.invalid' };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [
  ...(packaged ? [] : [path.join(desktopDir, 'dist', 'main.js')]),
  '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--ozone-platform=x11',
  `--user-data-dir=${root}`, `--remote-debugging-port=${port}`,
], { cwd: repoDir, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
child.stderr.on('data', (chunk) => { log = `${log}${chunk}`.slice(-12_000); });

try {
  const target = await waitForLocalWindow(port, child);
  const origin = new URL(target.url).origin;
  const health = await (await fetch(`${origin}/healthz`)).json();
  if (health?.ok !== true) throw new Error('Embedded service health check failed');
  if (target.url.includes('must-not-be-used.invalid')) throw new Error('Desktop still used the remote server');
  await fs.access(path.join(root, 'server-data-v3', 'settings.json'));
  console.log(`PASS: ${packaged ? 'packaged ' : ''}desktop owns a local vault service at ${origin}`);
} catch (error) {
  const serverLog = await fs.readFile(path.join(root, 'logs', 'server.log'), 'utf8').catch(() => '');
  if (serverLog) console.error(serverLog);
  if (log) console.error(log);
  throw error;
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await fs.rm(root, { recursive: true, force: true });
}
