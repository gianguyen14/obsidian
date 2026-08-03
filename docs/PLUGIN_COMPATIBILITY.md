# Community plugin compatibility

WebObsidian can load browser-compatible Obsidian community plugins directly from
`<vault>/.obsidian/plugins/<id>`. It uses the same `manifest.json`, bundled `main.js`,
optional `styles.css`, and `data.json` layout as Obsidian.

## Supported runtime surface

- CSP-safe CommonJS loading through `require('obsidian')`; production does not enable
  `unsafe-eval`.
- Plugin lifecycle: enable, disable, reload, cleanup, and readable load diagnostics.
- Vault files/folders: text and binary read/write, create, rename, copy, delete, events,
  resource URLs, and the adapter subset.
- Workspace: active file, file-open events, leaves, custom `ItemView` registration, and
  extension-to-view registration.
- UI: commands/default hotkeys, ribbon buttons, status-bar items, modal/notice/menu,
  settings tabs, `Setting` and common input components.
- Markdown Reading view: post-processors and fenced code-block processors.
- Plugin state in `.obsidian/plugins/<id>/data.json`.
- Common helpers: `moment`, YAML, path/link/frontmatter/tag utilities, icons, and the
  Obsidian DOM helper methods used by plugin UIs.

## Partial support

- Metadata cache covers frontmatter, headings, tags, links, and embeds. It is not yet a
  byte-for-byte implementation of Obsidian's internal cache.
- Editor command callbacks receive a CodeMirror-backed editor adapter. Direct CM6
  extension registration and `EditorSuggest` are reported as partial compatibility.
- Markdown post-processors run in Reading view. Live Preview remains WebObsidian's own
  CodeMirror renderer.
- `requestUrl()` uses browser `fetch`; the destination must allow CORS.

## Not supported

- `isDesktopOnly` plugins.
- Node.js/Electron modules such as `fs`, `path`, `child_process`, or `electron`.
- Plugins that patch private Obsidian internals instead of using the public Plugin API.
- Native pop-out windows and mobile Capacitor APIs.

WebObsidian includes native Excalidraw and Git sync features, so the desktop Excalidraw
and Obsidian Git plugins are unnecessary here.

## Install and diagnose

1. Open **Settings → Community Plugins**.
2. Enter a GitHub repository as `owner/repo` and select **Install**.
3. Enable the plugin. It loads immediately; a page reload is not required.
4. Read the status displayed under the plugin:
   - **Loaded**: `main.js` finished `onload()` successfully.
   - **Load failed**: expand the browser console for the stack trace; the UI also shows
     the first missing module/API error.
   - **Not compatible**: the manifest declares a desktop-only plugin.
5. Use **Reload** after replacing plugin files manually.

Community plugins are trusted code. As in desktop Obsidian, only install plugins whose
publisher and source you trust: a loaded plugin can read and modify the vault.
