package com.xnohat.webobsidian

import kotlinx.serialization.Serializable

@Serializable
data class TreeNode(
    val name: String,
    val path: String,
    val type: String,
    val ext: String? = null,
    val children: List<TreeNode> = emptyList(),
)

@Serializable
data class NoteContent(val path: String, val content: String)

@Serializable
data class SearchHit(
    val path: String,
    val title: String,
    val score: Double = 0.0,
    val tags: List<String> = emptyList(),
    val snippet: String = "",
)

@Serializable
data class SearchResponse(val query: String = "", val hits: List<SearchHit> = emptyList())

@Serializable
data class MeResponse(
    val authenticated: Boolean = false,
    val mustChangePassword: Boolean = false,
)

@Serializable
data class LoginResponse(
    val ok: Boolean = false,
    val requiresTwoFactor: Boolean = false,
    val twoFactorToken: String? = null,
    val mustChangePassword: Boolean = false,
)

@Serializable
data class LoginRequest(val password: String)

@Serializable
data class TotpRequest(val twoFactorToken: String, val code: String)

@Serializable
data class WriteRequest(val path: String, val content: String)
