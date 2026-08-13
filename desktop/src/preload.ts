import { contextBridge } from 'electron';

// The web app uses this seam to expose the correct Obsidian Platform flags to plugins.
contextBridge.exposeInMainWorld('__webobsidianShell', 'desktop');
contextBridge.exposeInMainWorld('webobsidianDesktop', {
  isDesktop: true,
  platform: process.platform,
});
