package com.xnohat.webobsidian

import io.ktor.http.Url

const val DEFAULT_SERVER_URL = BuildConfig.DEFAULT_SERVER_URL

/** HTTPS everywhere; plain HTTP is accepted only for a loopback development server. */
fun normalizeServerUrl(raw: String): String? {
    val value = raw.trim().trimEnd('/')
    if (value.isBlank()) return null

    val authority = value.substringAfter("://", missingDelimiterValue = "")
        .substringBefore('/')
    if (authority.isBlank() || '@' in authority) return null

    val url = runCatching { Url(value) }.getOrNull() ?: return null
    val scheme = url.protocol.name.lowercase()
    val loopback = url.host.lowercase() in setOf("localhost", "127.0.0.1", "::1", "[::1]")
    if (scheme != "https" && !(scheme == "http" && loopback)) return null

    val host = if (':' in url.host && !url.host.startsWith('[')) "[${url.host}]" else url.host
    val defaultPort = (scheme == "https" && url.port == 443) || (scheme == "http" && url.port == 80)
    return "$scheme://$host${if (defaultPort) "" else ":${url.port}"}"
}
