package com.xnohat.webobsidian

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class AppScreen { CONNECT, LOGIN, VAULT }

class AppState(
    private val store: SettingsStore,
    private val scope: CoroutineScope,
) {
    var screen by mutableStateOf(AppScreen.CONNECT)
        private set
    var serverInput by mutableStateOf(store.get(StorageKeys.SERVER_URL) ?: DEFAULT_SERVER_URL)
    var password by mutableStateOf("")
    var totpCode by mutableStateOf("")
    var requiresTotp by mutableStateOf(false)
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var tree by mutableStateOf<TreeNode?>(null)
        private set
    var searchQuery by mutableStateOf("")
    var searchHits by mutableStateOf<List<SearchHit>>(emptyList())
        private set
    var selectedPath by mutableStateOf<String?>(null)
        private set
    var noteContent by mutableStateOf("")
    var noteDirty by mutableStateOf(false)
        private set
    var saveStatus by mutableStateOf("")
        private set

    private var api: ApiClient? = null
    private var twoFactorToken: String? = null
    private var saveJob: Job? = null

    fun initialize() {
        val saved = store.get(StorageKeys.SERVER_URL) ?: return
        val normalized = normalizeServerUrl(saved) ?: return
        connect(normalized, probeSession = true)
    }

    fun updateServer(value: String) {
        serverInput = value
        error = null
    }

    fun submitServer() {
        val normalized = normalizeServerUrl(serverInput)
        if (normalized == null) {
            error = "Use an HTTPS server URL (HTTP is allowed only for localhost)."
            return
        }
        store.put(StorageKeys.SERVER_URL, normalized)
        serverInput = normalized
        connect(normalized, probeSession = true)
    }

    private fun connect(server: String, probeSession: Boolean) {
        api?.close()
        api = ApiClient(server, store)
        loading = true
        error = null
        scope.launch {
            try {
                val me = if (probeSession) api!!.me() else MeResponse(false)
                if (me.authenticated) {
                    screen = AppScreen.VAULT
                    refreshTree()
                } else {
                    store.remove(StorageKeys.SESSION_COOKIE)
                    screen = AppScreen.LOGIN
                }
            } catch (cause: Throwable) {
                if (cause is ApiException && cause.status == 401) {
                    store.remove(StorageKeys.SESSION_COOKIE)
                    screen = AppScreen.LOGIN
                } else {
                    error = cause.readableMessage()
                    screen = AppScreen.CONNECT
                }
            } finally {
                loading = false
            }
        }
    }

    fun login() {
        if (password.isBlank()) return
        loading = true
        error = null
        scope.launch {
            try {
                val result = api!!.login(password)
                if (result.requiresTwoFactor) {
                    twoFactorToken = result.twoFactorToken
                    requiresTotp = true
                } else {
                    password = ""
                    screen = AppScreen.VAULT
                    refreshTree()
                }
            } catch (cause: Throwable) {
                error = cause.readableMessage()
            } finally {
                loading = false
            }
        }
    }

    fun verifyTotp() {
        val token = twoFactorToken ?: return
        if (totpCode.isBlank()) return
        loading = true
        error = null
        scope.launch {
            try {
                api!!.loginTotp(token, totpCode)
                password = ""
                totpCode = ""
                requiresTotp = false
                twoFactorToken = null
                screen = AppScreen.VAULT
                refreshTree()
            } catch (cause: Throwable) {
                error = cause.readableMessage()
            } finally {
                loading = false
            }
        }
    }

    fun refreshTree() {
        loading = true
        scope.launch {
            try {
                tree = api!!.tree()
            } catch (cause: Throwable) {
                handleApiFailure(cause)
            } finally {
                loading = false
            }
        }
    }

    fun openNote(path: String) {
        if (path == selectedPath) return
        saveNow()
        loading = true
        error = null
        scope.launch {
            try {
                val note = api!!.read(path)
                selectedPath = note.path
                noteContent = note.content
                noteDirty = false
                saveStatus = ""
            } catch (cause: Throwable) {
                handleApiFailure(cause)
            } finally {
                loading = false
            }
        }
    }

    fun closeNote() {
        saveNow()
        selectedPath = null
        noteContent = ""
        noteDirty = false
    }

    fun editNote(value: String) {
        noteContent = value
        noteDirty = true
        saveStatus = "Unsaved"
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(900)
            saveNote()
        }
    }

    fun saveNow() {
        saveJob?.cancel()
        if (noteDirty) saveJob = scope.launch { saveNote() }
    }

    private suspend fun saveNote() {
        val path = selectedPath ?: return
        val snapshot = noteContent
        saveStatus = "Saving…"
        try {
            api!!.write(path, snapshot)
            if (selectedPath == path && noteContent == snapshot) noteDirty = false
            saveStatus = "Saved"
        } catch (cause: Throwable) {
            saveStatus = "Save failed"
            error = cause.readableMessage()
        }
    }

    fun runSearch() {
        val query = searchQuery.trim()
        if (query.isBlank()) {
            searchHits = emptyList()
            return
        }
        loading = true
        scope.launch {
            try {
                searchHits = api!!.search(query)
            } catch (cause: Throwable) {
                handleApiFailure(cause)
            } finally {
                loading = false
            }
        }
    }

    fun clearSearch() {
        searchQuery = ""
        searchHits = emptyList()
    }

    fun changeServer() {
        saveNow()
        api?.close()
        api = null
        store.remove(StorageKeys.SESSION_COOKIE)
        screen = AppScreen.CONNECT
        tree = null
        selectedPath = null
        error = null
    }

    fun logout() {
        saveNow()
        scope.launch {
            api?.logout()
            tree = null
            selectedPath = null
            requiresTotp = false
            screen = AppScreen.LOGIN
        }
    }

    fun dismissError() { error = null }

    private fun handleApiFailure(cause: Throwable) {
        if (cause is ApiException && cause.status == 401) {
            store.remove(StorageKeys.SESSION_COOKIE)
            screen = AppScreen.LOGIN
        }
        error = cause.readableMessage()
    }
}

private fun Throwable.readableMessage(): String =
    message?.takeIf { it.isNotBlank() } ?: "Unable to reach the WebObsidian server."
