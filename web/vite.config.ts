import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web build outputs to ../server/public so the server can serve the SPA.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replaceAll('\\', '/');
          if (moduleId.includes('/node_modules/@codemirror/')) return 'codemirror';
          if (
            /\/node_modules\/(unified|remark-[^/]+|rehype-[^/]+)\//.test(moduleId)
          ) return 'markdown';
          if (/\/node_modules\/(react|react-dom)\//.test(moduleId)) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/public': 'http://localhost:8787',
      '/share': 'http://localhost:8787', // SSR share page is server-rendered even in dev
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
