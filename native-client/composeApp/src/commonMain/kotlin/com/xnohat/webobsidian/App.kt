package com.xnohat.webobsidian

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val ObsidianColors = darkColorScheme(
    primary = Color(0xFF9B87F5),
    onPrimary = Color.White,
    background = Color(0xFF1E1E1E),
    onBackground = Color(0xFFDCDEDF),
    surface = Color(0xFF252525),
    onSurface = Color(0xFFDCDEDF),
    surfaceVariant = Color(0xFF303030),
    outline = Color(0xFF484848),
    error = Color(0xFFFF6B6B),
)

@Composable
fun WebObsidianApp(store: SettingsStore) {
    val scope = rememberCoroutineScope()
    val state = remember(store) { AppState(store, scope) }

    LaunchedEffect(state) { state.initialize() }
    DisposableEffect(state) {
        onDispose { state.saveNow() }
    }

    MaterialTheme(colorScheme = ObsidianColors) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            when (state.screen) {
                AppScreen.CONNECT -> ConnectScreen(state)
                AppScreen.LOGIN -> LoginScreen(state)
                AppScreen.VAULT -> VaultScreen(state)
            }
        }
    }
}

@Composable
private fun ConnectScreen(state: AppState) {
    CenteredCard {
        Text("WebObsidian", fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "Native client · no WebView",
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
        )
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = state.serverInput,
            onValueChange = state::updateServer,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Server URL") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { state.submitServer() }),
        )
        ErrorText(state.error)
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = state::submitServer,
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.loading,
        ) {
            Text("Connect")
        }
        if (state.loading) LoadingLine()
    }
}

@Composable
private fun LoginScreen(state: AppState) {
    CenteredCard {
        Text("Sign in", fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Text(
            state.serverInput,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
            maxLines = 1,
        )
        Spacer(Modifier.height(24.dp))

        if (!state.requiresTotp) {
            OutlinedTextField(
                value = state.password,
                onValueChange = { state.password = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Password") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { state.login() }),
            )
        } else {
            OutlinedTextField(
                value = state.totpCode,
                onValueChange = { state.totpCode = it.filter(Char::isDigit).take(8) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Authenticator or recovery code") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.NumberPassword,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { state.verifyTotp() }),
            )
        }
        ErrorText(state.error)
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = if (state.requiresTotp) state::verifyTotp else state::login,
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.loading,
        ) {
            Text(if (state.requiresTotp) "Verify" else "Sign in")
        }
        TextButton(onClick = state::changeServer, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text("Change server")
        }
        if (state.loading) LoadingLine()
    }
}

@Composable
private fun VaultScreen(state: AppState) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val compact = maxWidth < 760.dp
        Column(Modifier.fillMaxSize()) {
            AppToolbar(state, compact)
            ErrorBanner(state)
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            if (compact) {
                if (state.selectedPath == null) VaultSidebar(state, Modifier.fillMaxSize())
                else NoteEditor(state, Modifier.fillMaxSize(), showBack = true)
            } else {
                Row(Modifier.fillMaxSize()) {
                    VaultSidebar(state, Modifier.width(310.dp).fillMaxHeight())
                    HorizontalDivider(
                        modifier = Modifier.fillMaxHeight().width(1.dp),
                        color = MaterialTheme.colorScheme.outline,
                    )
                    NoteEditor(state, Modifier.weight(1f).fillMaxHeight(), showBack = false)
                }
            }
        }
        if (state.loading) {
            CircularProgressIndicator(
                modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp).size(24.dp),
                strokeWidth = 2.dp,
            )
        }
    }
}

@Composable
private fun AppToolbar(state: AppState, compact: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (compact && state.selectedPath != null) {
            TextButton(onClick = state::closeNote) { Text("‹ Notes") }
        } else {
            Text("WebObsidian", fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.weight(1f))
        if (state.selectedPath != null) {
            Text(state.saveStatus, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f))
            TextButton(onClick = state::saveNow, enabled = state.noteDirty) { Text("Save") }
        }
        TextButton(onClick = state::logout) { Text("Sign out") }
    }
}

@Composable
private fun VaultSidebar(state: AppState, modifier: Modifier = Modifier) {
    Column(modifier.background(MaterialTheme.colorScheme.surface)) {
        Row(
            Modifier.fillMaxWidth().padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            OutlinedTextField(
                value = state.searchQuery,
                onValueChange = { state.searchQuery = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Search vault") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { state.runSearch() }),
            )
            Button(onClick = state::runSearch) { Text("Go") }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (state.searchHits.isEmpty()) "FILES" else "SEARCH RESULTS",
                modifier = Modifier.weight(1f),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.58f),
            )
            if (state.searchQuery.isNotBlank()) TextButton(onClick = state::clearSearch) { Text("Clear") }
            TextButton(onClick = state::refreshTree) { Text("Refresh") }
        }

        if (state.searchHits.isNotEmpty()) {
            LazyColumn(Modifier.fillMaxSize()) {
                items(state.searchHits, key = { it.path }) { hit ->
                    FileRow(
                        title = hit.title.ifBlank { hit.path.substringAfterLast('/') },
                        subtitle = hit.path,
                        selected = hit.path == state.selectedPath,
                        onClick = { state.openNote(hit.path) },
                    )
                }
            }
        } else {
            val entries = remember(state.tree) { flattenTree(state.tree) }
            LazyColumn(Modifier.fillMaxSize()) {
                items(entries, key = { it.node.path.ifBlank { "__root__" } }) { entry ->
                    if (entry.node.path.isNotBlank()) {
                        TreeRow(entry, entry.node.path == state.selectedPath) {
                            if (entry.node.type == "file" && entry.node.isEditableText()) {
                                state.openNote(entry.node.path)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TreeRow(entry: FlatTreeEntry, selected: Boolean, onClick: () -> Unit) {
    val node = entry.node
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.17f) else Color.Transparent)
            .clickable(enabled = node.type == "file" && node.isEditableText(), onClick = onClick)
            .padding(start = (12 + entry.depth * 14).dp, end = 10.dp, top = 9.dp, bottom = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(if (node.type == "folder") "▾" else "", modifier = Modifier.width(18.dp), fontSize = 11.sp)
        Text(node.name, maxLines = 1, color = if (node.type == "folder") MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.88f))
    }
}

@Composable
private fun FileRow(title: String, subtitle: String, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.17f) else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Text(title, maxLines = 1)
        Text(subtitle, maxLines = 1, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
    }
}

@Composable
private fun NoteEditor(state: AppState, modifier: Modifier, showBack: Boolean) {
    val path = state.selectedPath
    if (path == null) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text("Select a note", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f))
        }
        return
    }

    Column(modifier) {
        Row(
            Modifier.fillMaxWidth().height(46.dp).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (showBack) TextButton(onClick = state::closeNote) { Text("‹") }
            Text(path.substringAfterLast('/'), fontWeight = FontWeight.SemiBold, maxLines = 1)
            Spacer(Modifier.weight(1f))
            Text(path, fontSize = 11.sp, maxLines = 1, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f))
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        OutlinedTextField(
            value = state.noteContent,
            onValueChange = state::editNote,
            modifier = Modifier.fillMaxSize().padding(12.dp),
            textStyle = MaterialTheme.typography.bodyMedium.copy(
                fontFamily = FontFamily.Monospace,
                lineHeight = 21.sp,
            ),
            shape = RoundedCornerShape(5.dp),
        )
    }
}

@Composable
private fun CenteredCard(content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.fillMaxWidth().widthIn(max = 420.dp).background(
                MaterialTheme.colorScheme.surface,
                RoundedCornerShape(12.dp),
            ).padding(28.dp),
            content = content,
        )
    }
}

@Composable
private fun ErrorText(error: String?) {
    if (error != null) {
        Spacer(Modifier.height(8.dp))
        Text(error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
    }
}

@Composable
private fun ErrorBanner(state: AppState) {
    val error = state.error ?: return
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.error.copy(alpha = 0.14f)).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(error, Modifier.weight(1f), color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        TextButton(onClick = state::dismissError) { Text("Dismiss") }
    }
}

@Composable
private fun LoadingLine() {
    Spacer(Modifier.height(14.dp))
    CircularProgressIndicator(Modifier.size(20.dp).padding(1.dp), strokeWidth = 2.dp)
}

private data class FlatTreeEntry(val node: TreeNode, val depth: Int)

private fun flattenTree(root: TreeNode?): List<FlatTreeEntry> {
    if (root == null) return emptyList()
    val result = mutableListOf<FlatTreeEntry>()
    fun visit(node: TreeNode, depth: Int) {
        result += FlatTreeEntry(node, depth)
        node.children.forEach { visit(it, depth + 1) }
    }
    visit(root, -1)
    return result
}

private val textExtensions = setOf(
    "md", "markdown", "txt", "json", "csv", "canvas", "excalidraw", "base", "css", "js", "yml", "yaml",
)

private fun TreeNode.isEditableText(): Boolean = ext?.removePrefix(".")?.lowercase() in textExtensions
