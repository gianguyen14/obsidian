# WebObsidian Mobile — native Android client

The Android app is built from [`../native-client`](../native-client). Its UI is Compose,
networking is Ktor/OkHttp, and there is no Capacitor or WebView in the APK runtime.

Install JDK 21 and Android SDK 36, then run from the repository root (the Gradle wrapper is included):

```bash
npm run mobile:apk
```

The debug APK is written to
`native-client/composeApp/build/outputs/apk/debug/composeApp-debug.apk`.

Any previously generated `mobile/android` Capacitor project is ignored legacy output and
is not part of the current source, build, or release workflow.
