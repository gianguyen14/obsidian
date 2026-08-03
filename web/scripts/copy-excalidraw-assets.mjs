import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url));
const destination = fileURLToPath(new URL('../public/excalidraw-assets/fonts/', import.meta.url));

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
