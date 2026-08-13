# WebObsidian Desktop (Electron, local-first)

The desktop app packages the complete WebObsidian React UI plus its Express service for
macOS, Windows, and Linux. The service binds to a random `127.0.0.1` port and owns a local
vault selected on first launch. It never connects to the hosted web vault implicitly.

Web and desktop therefore have independent tabs, active notes, settings, credentials,
and files. To synchronize notes, configure the same repository in **Settings → GitHub
Sync** on each installation, then use Pull/Sync (or enable auto-sync).

## Local data

- `desktop-config.json`: local vault path and per-installation bootstrap secret
- `server-data/`: local settings, indexes, workspace state, plugin data, and shares
- `logs/server.log`: embedded-service diagnostics

These live under Electron's OS-specific user-data directory. The vault itself stays in
the folder chosen by the user and is not deleted when uninstalling the app.

## Security model

- the embedded service binds only to `127.0.0.1`
- `contextIsolation` and renderer sandbox enabled; Node integration disabled
- navigation locked to the embedded loopback origin
- external HTTP(S) links open in the system browser
- local session secret and settings files are private to the OS user

## Run and package

From the repository root:

```bash
npm install
npm run desktop
npm run desktop:dist
```

Installers are written to `desktop/release/` for macOS, Windows, and Linux. Release
packages are currently unsigned.
