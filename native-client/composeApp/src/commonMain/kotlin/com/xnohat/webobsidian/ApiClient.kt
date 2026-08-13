package com.xnohat.webobsidian

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ApiException(message: String, val status: Int) : Exception(message)

class ApiClient(
    val serverUrl: String,
    private val store: SettingsStore,
    private val http: HttpClient = HttpClient {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
    },
) {
    private val json = Json { ignoreUnknownKeys = true }

    private fun cookie(): String? = store.get(StorageKeys.SESSION_COOKIE)

    private fun io.ktor.client.request.HttpRequestBuilder.withSession() {
        cookie()?.let { header(HttpHeaders.Cookie, "webobsidian_token=$it") }
    }

    private suspend fun checked(response: HttpResponse): HttpResponse {
        if (response.status.value in 200..299) return response
        val text = response.bodyAsText()
        val message = runCatching {
            json.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.content
        }.getOrNull().orEmpty().ifBlank { response.status.description }
        throw ApiException(message, response.status.value)
    }

    private fun rememberSession(response: HttpResponse) {
        val token = response.headers.getAll(HttpHeaders.SetCookie).orEmpty()
            .firstNotNullOfOrNull { header ->
                Regex("(?:^|;\\s*)webobsidian_token=([^;]+)")
                    .find(header)?.groupValues?.getOrNull(1)
            }
        if (!token.isNullOrBlank()) store.put(StorageKeys.SESSION_COOKIE, token)
    }

    suspend fun me(): MeResponse = checked(http.get("$serverUrl/auth/me") { withSession() }).body()

    suspend fun login(password: String): LoginResponse {
        val response = checked(http.post("$serverUrl/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(password))
        })
        rememberSession(response)
        return response.body()
    }

    suspend fun loginTotp(token: String, code: String) {
        val response = checked(http.post("$serverUrl/auth/login/totp") {
            contentType(ContentType.Application.Json)
            setBody(TotpRequest(token, code))
        })
        rememberSession(response)
    }

    suspend fun logout() {
        runCatching { checked(http.post("$serverUrl/auth/logout") { withSession() }) }
        store.remove(StorageKeys.SESSION_COOKIE)
    }

    suspend fun tree(): TreeNode = checked(http.get("$serverUrl/api/files/") { withSession() }).body()

    suspend fun read(path: String): NoteContent = checked(
        http.get("$serverUrl/api/files/content?path=${path.encodeURLParameter()}") { withSession() },
    ).body()

    suspend fun write(path: String, content: String) {
        checked(http.put("$serverUrl/api/files/content") {
            withSession()
            contentType(ContentType.Application.Json)
            setBody(WriteRequest(path, content))
        })
    }

    suspend fun search(query: String): List<SearchHit> = checked(
        http.get("$serverUrl/api/search?q=${query.encodeURLParameter()}&limit=100") { withSession() },
    ).body<SearchResponse>().hits

    fun close() = http.close()
}
