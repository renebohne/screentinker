package com.screentinker.manager

import android.content.Context
import android.net.Uri
import org.json.JSONArray

/**
 * The ScreenTinker servers this phone manages (origins like https://screentinker.com), and which one
 * is in use. Each server keeps its own sign-in: the WebView's storage is per origin, so switching
 * never signs anyone out of another server.
 */
object ServerStore {
    const val HOSTED = "https://screentinker.com"
    private const val PREFS = "server"
    private const val KEY_CURRENT = "origin"   // 1.0's single-server key, kept as "the one in use"
    private const val KEY_LIST = "servers"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The server in use, or null on first run. */
    fun get(context: Context): String? = prefs(context).getString(KEY_CURRENT, null)

    /** Every saved server, in the order added; includes the current one. */
    fun list(context: Context): List<String> {
        val raw = prefs(context).getString(KEY_LIST, null)
        val out = mutableListOf<String>()
        if (raw != null) {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) arr.optString(i).takeIf { it.isNotBlank() }?.let(out::add)
        }
        get(context)?.let { if (it !in out) out.add(0, it) }
        return out
    }

    /** Save (if new) and switch to it. */
    fun set(context: Context, origin: String) {
        val all = list(context).toMutableList()
        if (origin !in all) all.add(origin)
        prefs(context).edit()
            .putString(KEY_CURRENT, origin)
            .putString(KEY_LIST, JSONArray(all).toString())
            .apply()
    }

    /** Forget a server. If it was the one in use, the next saved one takes over (or none: first run). */
    fun remove(context: Context, origin: String) {
        val all = list(context).filter { it != origin }
        val editor = prefs(context).edit().putString(KEY_LIST, JSONArray(all).toString())
        if (get(context) == origin) {
            if (all.isEmpty()) editor.remove(KEY_CURRENT) else editor.putString(KEY_CURRENT, all.first())
        }
        editor.apply()
    }

    /** What to call a server in the list: its host (and port, when it is not the default). */
    fun label(origin: String): String {
        val u = Uri.parse(origin)
        return (u.host ?: origin) + (if (u.port > 0) ":${u.port}" else "")
    }

    /**
     * What the user typed, as an origin: scheme added (https unless they wrote http), path, query and
     * a trailing slash dropped ("signage.example.com/app/" -> "https://signage.example.com").
     * Null when it cannot be a web address.
     */
    fun normalize(input: String): String? {
        var s = input.trim()
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val uri = Uri.parse(s)
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host ?: return null
        if (host.isBlank() || host.contains(' ')) return null
        val port = if (uri.port > 0) ":${uri.port}" else ""
        return "$scheme://${host.lowercase()}$port"
    }

    /** Same server: scheme, host and port all match. */
    fun sameOrigin(origin: String, url: Uri): Boolean {
        val o = Uri.parse(origin)
        val defaultPort = { scheme: String? -> if (scheme == "http") 80 else 443 }
        val oPort = if (o.port > 0) o.port else defaultPort(o.scheme)
        val uPort = if (url.port > 0) url.port else defaultPort(url.scheme)
        return o.scheme == url.scheme && o.host.equals(url.host, ignoreCase = true) && oPort == uPort
    }
}
