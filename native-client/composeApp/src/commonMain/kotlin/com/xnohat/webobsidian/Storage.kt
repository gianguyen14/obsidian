package com.xnohat.webobsidian

interface SettingsStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

internal object StorageKeys {
    const val SERVER_URL = "server_url"
    const val SESSION_COOKIE = "session_cookie"
}
