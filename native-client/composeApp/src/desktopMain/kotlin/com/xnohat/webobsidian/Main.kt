package com.xnohat.webobsidian

import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import java.util.prefs.Preferences

fun main() = application {
    Window(
        onCloseRequest = ::exitApplication,
        title = "WebObsidian",
    ) {
        window.minimumSize = java.awt.Dimension(760, 520)
        WebObsidianApp(DesktopSettingsStore)
    }
}

private object DesktopSettingsStore : SettingsStore {
    private val preferences = Preferences.userRoot().node("com/xnohat/webobsidian")

    override fun get(key: String): String? = preferences.get(key, null)

    override fun put(key: String, value: String) {
        preferences.put(key, value)
        preferences.flush()
    }

    override fun remove(key: String) {
        preferences.remove(key)
        preferences.flush()
    }
}
