package com.xnohat.webobsidian

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ServerUrlTest {
    @Test
    fun acceptsHttpsAndDropsPaths() {
        assertEquals("https://example.com", normalizeServerUrl(" https://example.com/note/Test?q=1 "))
        assertEquals("https://example.com:8443", normalizeServerUrl("https://example.com:8443/path"))
    }

    @Test
    fun permitsHttpOnlyOnLoopback() {
        assertEquals("http://localhost:8787", normalizeServerUrl("http://localhost:8787"))
        assertEquals("http://[::1]:8787", normalizeServerUrl("http://[::1]:8787/path"))
        assertNull(normalizeServerUrl("http://example.com"))
    }

    @Test
    fun rejectsCredentialsAndUnsafeSchemes() {
        assertNull(normalizeServerUrl("https://user:secret@example.com"))
        assertNull(normalizeServerUrl("file:///tmp/vault"))
        assertNull(normalizeServerUrl("javascript:alert(1)"))
        assertNull(normalizeServerUrl("not a url"))
    }
}
