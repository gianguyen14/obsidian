// Build the Electron process, a self-contained local Express service, and the
// exact web SPA used by the hosted edition. Each installation owns its vault;
// Git is the only cross-platform vault synchronization mechanism.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..');
const serverEntry = path.join(repoDir, 'server', 'dist', 'index.js');
const serverPublic = path.join(repoDir, 'server', 'public');

if (!existsSync(serverEntry) || !existsSync(serverPublic)) {
  throw new Error('Missing server build. Run `npm run build` at the repository root first.');
}

await build({
  entryPoints: [path.join(desktopDir, 'src/main.ts'), path.join(desktopDir, 'src/preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outdir: path.join(desktopDir, 'dist'),
  logLevel: 'info',
});

const generatedServer = path.join(desktopDir, '.gen', 'server');
rmSync(generatedServer, { recursive: true, force: true });
mkdirSync(path.join(generatedServer, 'dist'), { recursive: true });
await build({
  entryPoints: [serverEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['fsevents'],
  outfile: path.join(generatedServer, 'dist', 'index.mjs'),
  banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" },
  logLevel: 'info',
});
cpSync(serverPublic, path.join(generatedServer, 'public'), { recursive: true });

console.log('[desktop] local-first bundle ready');
