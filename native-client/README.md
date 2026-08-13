# WebObsidian native prototype (Android)

This Compose Multiplatform codebase is retained for the Android native prototype.
Compose renders the interface directly through Skia/Android Canvas; Ktor talks to the
server REST API through CIO on desktop and OkHttp on Android. No HTML, JavaScript runtime,
embedded browser, Electron, Capacitor, or WebView is included.

Compose Desktop is no longer a shipping target because its reduced feature set did not
match the web application. The supported desktop app is now in [`../desktop`](../desktop)
and uses Electron to provide full web feature parity across macOS, Windows, and Linux.

## Current native surface

- HTTPS server setup (plain HTTP is accepted only for loopback development)
- Persistent password session, password login, TOTP and recovery-code verification
- Vault tree, full-text search, text-file editor, explicit save, and 900 ms autosave
- Adaptive two-column desktop and list/editor mobile layouts

The app is currently an online remote client. Passkeys, native Markdown reading/live
preview, file mutations/uploads, media, WebSocket updates, Graph, Canvas, Excalidraw, and
DOM-dependent community plugins remain future native ports. They do not fall back to a
WebView.

## Requirements

- JDK 21 (`JAVA_HOME` must point to it; Gradle 8 does not run on this project's JDK 25)
- Android SDK 36 for APK builds

## Commands

From the repository root on Linux/macOS:

```bash
./native-client/gradlew -p native-client :composeApp:assembleDebug
./native-client/gradlew -p native-client :composeApp:allTests
```

On Windows, use `native-client\gradlew.bat` with the same Gradle arguments.

Outputs:

- Android: `native-client/composeApp/build/outputs/apk/debug/composeApp-debug.apk`

Android release signing is not configured yet.
