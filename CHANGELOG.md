# Changelog

- Community Plugins Browse now merges Obsidian's complete official catalog with
  official download statistics, ranks plugins by popularity, and provides
  sorting, download/update metadata, incremental rendering and detail views.
- Fixed Community Plugins Browse returning a proxy-level `404 Not Found` by loading the catalog through the established plugins collection endpoint, with retry UI and route regression coverage.

All notable changes to WebObsidian are documented here. This project tracks its product
design and version history in [PRD.md](PRD.md); the entries below summarize user-facing
changes. The format is loosely based on [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- Obsidian-style Community plugins manager with grouped settings, installed-plugin
  actions, official catalog browsing/search, one-click install and safe uninstall.
- Browser-compatible Obsidian community-plugin runtime: commands/hotkeys, ribbon and
  status items, custom views/extensions, plugin settings, Markdown processors, vault
  APIs/events, plugin `data.json`, nested assets and load diagnostics.
- Open-source repository scaffolding: `README.md` (with logo), `LICENSE` (MIT),
  `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates and a
  CI workflow (typecheck, build, Docker image).
- File tree **Copy / Cut / Paste** for files and folders (session-local clipboard;
  `POST /api/files/copy` for recursive copy). *(PRD 0.9)*

### Changed
- Replaced the production-incompatible `new Function` plugin loader with a same-origin
  CommonJS-to-ESM wrapper. Workspace CSP permits dynamic JavaScript/WebAssembly only
  while trusted community plugins are enabled; public shares remain strict.
- Plugin settings now isolate render failures and support the DOM/component contracts
  used by published Tasks and Calendar settings tabs instead of showing a blank page.
- ⋯ **More options** menu rebuilt for parity with Obsidian Desktop: backlinks-in-document,
  open linked view, open in new window, add file property, in-note Find, export to PDF,
  reveal file in navigation, and per-file version history. *(PRD 0.8)*

## Highlights by PRD revision

- **0.9** — File tree Copy/Cut/Paste; recursive copy endpoint.
- **0.8** — ⋯ menu parity with Obsidian Desktop; per-file Git version history (FR-4).
- **0.7** — Per-note **Share dialog** (create/copy/toggle/password/delete) + globe badge.
- **0.6** — Deploy hardening for self-hosting: all deploy params via `.env`, watcher polling
  fallback on inotify limits, longer healthcheck `start_period` (FR-9).
- **0.5** — Graph node search with smooth fly-to and highlighting (FR-2).
- **0.4** — Mobile / responsive UI: drawer sidebars, edge-swipe, on-keyboard formatting
  toolbar, touch targets, safe-area insets (FR-11).
- **0.3** — Per-pane ⋯ menu (split, bookmark, rename/move, etc.) and a redesigned right
  sidebar tab strip (Backlinks incl. unlinked mentions · Outgoing links · Tags · Outline).
- **0.2** — Deep-link URLs (`/note/...`), public read-only share links with central
  management, server-side rendering for SEO (FR-10).

## Core (v1 baseline)

- Obsidian-compatible vault (works on existing `.obsidian/` vaults).
- CodeMirror 6 editor with live/source/reading views; wikilinks, embeds, tags, callouts,
  tasks, KaTeX, Mermaid; backlinks, outline, graph view.
- QMD full-text + fielded search (MiniSearch), incremental indexing, disk persistence.
- GitHub sync (pull/commit/push) with Git LFS.
- Single master password login (scrypt + JWT cookie).
- Scoped Agent API at `/api/v1` with hashed API keys and rate limiting.
- Community-plugin loader against an Obsidian-API shim (subset).
- Pure-JSON config (`data/settings.json`); one-command Docker stack.

---

> Note: WebObsidian is pre-1.0 and has not cut tagged releases yet. Once releases begin,
> each version will get its own dated section here.
