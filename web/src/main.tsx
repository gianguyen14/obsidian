import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/obsidian.css';

// NOTE: /share/<id> never reaches the SPA — the server renders it (SEO/OG SSR).

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

// Excalidraw otherwise falls back to a public CDN for drawing fonts. Keep every
// asset self-hosted so offline/private WebObsidian installations work under CSP.
window.EXCALIDRAW_ASSET_PATH = `${window.location.origin}/excalidraw-assets/`;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
