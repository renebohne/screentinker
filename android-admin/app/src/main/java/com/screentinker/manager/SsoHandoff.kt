package com.screentinker.manager

import android.content.Context
import android.net.Uri
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Single sign-on for the app. Google and most identity providers refuse to sign in inside a
 * WebView, so the round trip runs in the phone's browser (a Custom Tab) and the session comes back
 * over a PKCE-style hand-off (server: routes/auth.js /sso/app-exchange):
 *
 *  1. start(): a random verifier stays in this app; only SHA-256(verifier) goes out, as
 *     ?app_challenge= on the server's own SSO start URL.
 *  2. The server ends the login at screentinker-manager://sso?code=<single use, 2 minutes>.
 *  3. exchange(): code + verifier -> session token. An app that intercepted the redirect has the code
 *     but not the verifier, so the code is useless to it.
 */
object SsoHandoff {
    const val SCHEME = "screentinker-manager"
    const val HOST = "sso"
    private const val PREFS = "sso"
    private const val MAX_AGE_MS = 10 * 60 * 1000L

    class SsoError(message: String) : Exception(message)

    /** The URL to open in the browser for `startPath` (a path on `origin`), recording the verifier. */
    fun start(context: Context, origin: String, startPath: String): Uri? {
        if (!startPath.startsWith("/api/auth/")) return null
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val verifier = b64(bytes)
        val challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("verifier", verifier).putString("origin", origin).putLong("at", System.currentTimeMillis())
            .apply()
        val sep = if (startPath.contains('?')) "&" else "?"
        return Uri.parse("$origin$startPath${sep}app_challenge=$challenge")
    }

    /** True for screentinker-manager://sso?... */
    fun isReturn(uri: Uri?): Boolean = uri != null && uri.scheme == SCHEME && uri.host == HOST

    /** The server the pending sign-in was started on, if it is still fresh. */
    fun pendingOrigin(context: Context): String? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (System.currentTimeMillis() - p.getLong("at", 0) > MAX_AGE_MS) return null
        return p.getString("origin", null)
    }

    /** Swap the code for a session token (network: call off the main thread). Single use. */
    fun exchange(context: Context, code: String): String {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val verifier = p.getString("verifier", null)
        val origin = p.getString("origin", null)
        val at = p.getLong("at", 0)
        p.edit().clear().apply() // a verifier is used once, whatever happens
        if (verifier == null || origin == null || System.currentTimeMillis() - at > MAX_AGE_MS) {
            throw SsoError("this sign-in has expired; try again")
        }
        val conn = URL("$origin/api/auth/sso/app-exchange").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 10000
        conn.readTimeout = 15000
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(JSONObject().put("code", code).put("verifier", verifier).toString().toByteArray()) }
        val status = conn.responseCode
        val body = (if (status in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        val json = try { JSONObject(body) } catch (e: Exception) { JSONObject() }
        if (status !in 200..299) throw SsoError(json.optString("error").ifBlank { "HTTP $status" })
        return json.optString("token").ifBlank { throw SsoError("no session in the answer") }
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
