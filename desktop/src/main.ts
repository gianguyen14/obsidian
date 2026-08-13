import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  session,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isLocalAppUrl, isSafeExternalUrl, parseDesktopConfig, type DesktopConfig } from './localConfig';

const configFile = () => path.join(app.getPath('userData'), 'desktop-config.json');
const dataDir = (value: DesktopConfig) => path.join(app.getPath('userData'), value.dataDirName);
const logFile = () => path.join(app.getPath('userData'), 'logs', 'server.log');

let serverProc: ChildProcess | null = null;
let serverPort = 0;
let mainWindow: BrowserWindow | null = null;

async function readConfig(): Promise<DesktopConfig> {
  try {
    const parsed = parseDesktopConfig(JSON.parse(await fs.readFile(configFile(), 'utf8')));
    if (parsed) return parsed;
  } catch {
    // First launch or an obsolete remote-client config.
  }
  return { secret: randomBytes(24).toString('hex'), dataDirName: 'server-data-v3' };
}

async function writeConfig(value: DesktopConfig): Promise<void> {
  await fs.mkdir(path.dirname(configFile()), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(value, null, 2), { mode: 0o600 });
}

function serverEntry(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'dist', 'index.mjs')
    : path.join(__dirname, '..', '.gen', 'server', 'dist', 'index.mjs');
}

function baseUrl(): string {
  return `http://127.0.0.1:${serverPort}`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function augmentedPath(): string {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const parts = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of extra) if (!parts.includes(entry)) parts.push(entry);
  return parts.join(path.delimiter);
}

interface ApiResult {
  status: number;
  setCookie: string[];
}

function apiRequest(method: string, url: string, body?: unknown): Promise<ApiResult> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method, url });
    if (body !== undefined) request.setHeader('Content-Type', 'application/json');
    request.on('response', (response) => {
      const rawCookies = response.headers['set-cookie'] ?? [];
      const setCookie = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
      response.on('data', () => {});
      response.on('end', () => resolve({ status: response.statusCode ?? 0, setCookie }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await apiRequest('GET', `${baseUrl()}/healthz`)).status === 200) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The local WebObsidian service did not become ready in time.');
}

function sessionToken(cookies: string[]): string | null {
  for (const cookie of cookies) {
    const match = /^webobsidian_token=([^;]+)/.exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

async function autoLogin(secret: string): Promise<void> {
  try {
    const response = await apiRequest('POST', `${baseUrl()}/auth/login`, { password: secret });
    const token = sessionToken(response.setCookie);
    if (response.status !== 200 || !token) return;
    await session.defaultSession.cookies.set({
      url: baseUrl(),
      name: 'webobsidian_token',
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });
  } catch {
    // Existing local installations may require their previous password.
  }
}

async function startServer(value: DesktopConfig): Promise<void> {
  serverPort = await freePort();
  await fs.mkdir(dataDir(value), { recursive: true });
  await fs.mkdir(path.dirname(logFile()), { recursive: true });

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(serverPort),
    DATA_DIR: dataDir(value),
    VAULT_PATH: value.vaultPath,
    ALLOWED_ROOTS: Array.from(new Set([os.homedir(), value.vaultPath].filter(Boolean))).join(','),
    WEBOBSIDIAN_PASSWORD: value.secret,
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
    PATH: augmentedPath(),
  };

  serverProc = spawn(process.execPath, [serverEntry()], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = (await fs.open(logFile(), 'a')).createWriteStream();
  serverProc.stdout?.pipe(log);
  serverProc.stderr?.pipe(log);
  serverProc.once('exit', (code, signal) => {
    if (!app.isPackaged) console.error(`[local-server] exited code=${code} signal=${signal}`);
    serverProc = null;
  });

  await waitForHealth();
  await autoLogin(value.secret);
}

async function pickVault(firstLaunch: boolean): Promise<string> {
  const result = await dialog.showOpenDialog({
    title: 'Choose your local vault',
    message: 'This vault belongs only to this desktop installation.',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder',
  });
  if (!result.canceled && result.filePaths[0]) return result.filePaths[0];

  const fallback = path.join(app.getPath('documents'), 'WebObsidianVault');
  await fs.mkdir(fallback, { recursive: true });
  if (firstLaunch) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Using a local default vault',
      detail: `Notes will be stored at:\n${fallback}\n\nConfigure the same GitHub remote on another platform only when you want to sync them.`,
      buttons: ['OK'],
    });
  }
  return fallback;
}

async function ensureVault(value: DesktopConfig): Promise<DesktopConfig> {
  if (value.vaultPath) {
    try {
      if ((await fs.stat(value.vaultPath)).isDirectory()) return value;
    } catch {
      // The folder moved or was removed; choose a new local vault.
    }
  }
  value.vaultPath = await pickVault(true);
  await writeConfig(value);
  return value;
}

function isInternalUrl(value: string): boolean {
  return isLocalAppUrl(value, serverPort);
}

function secureWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: 'allow' };
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'WebObsidian',
    backgroundColor: '#1e1e1e',
    icon: app.isPackaged ? undefined : path.join(__dirname, '..', 'buildResources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadURL(baseUrl());
}

async function switchVault(): Promise<void> {
  const value = await readConfig();
  const selected = await pickVault(false);
  if (selected === value.vaultPath) return;
  value.vaultPath = selected;
  await writeConfig(value);
  app.relaunch();
  app.exit(0);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [
      { label: 'Switch Local Vault…', click: () => void switchVault() },
      { label: 'Open Local Vault Folder', click: async () => {
        const value = await readConfig();
        if (value.vaultPath) void shell.openPath(value.vaultPath);
      } },
      { type: 'separator' },
      { label: 'Open App Data Folder', click: async () => {
        const value = await readConfig();
        void shell.openPath(dataDir(value));
      } },
      { label: 'Open Logs', click: () => void shell.openPath(logFile()) },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('web-contents-created', (_event, contents) => secureWebContents(contents));
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    try {
      let value = await readConfig();
      value = await ensureVault(value);
      await writeConfig(value);
      await startServer(value);
      buildMenu();
      createWindow();
    } catch (error) {
      dialog.showErrorBox(
        'WebObsidian failed to start',
        String(error instanceof Error ? error.stack ?? error.message : error),
      );
      app.quit();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    serverProc?.kill();
    serverProc = null;
  });
}
