package com.remotedisplay.player.data

import org.json.JSONObject

/**
 * 3.0 site cache (docs/site-cache.md): a box on this screen's LAN that holds the site's media by
 * sha256. The server puts its address, a token for THIS screen, and each asset's digest in the
 * payload's top-level `site_cache` — only because PlayerCapabilities declares "net.site_cache".
 *
 * Absent, malformed or expired means "no cache": [ContentCache] then downloads from the origin
 * exactly as it always has. Nothing here can stop a screen getting its media.
 */
data class SiteCacheConfig(
    val baseUrl: String,
    val token: String,
    val expiresAtSec: Long,
    val files: Map<String, Entry>
) {
    data class Entry(val sha256: String, val size: Long)

    /** The digest for [contentId], or null when the cache cannot serve it (or the token expired). */
    fun entryFor(contentId: String, nowSec: Long = System.currentTimeMillis() / 1000): Entry? {
        if (expiresAtSec in 1 until nowSec) return null
        return files[contentId]
    }

    companion object {
        private val SHA = Regex("^[0-9a-f]{64}$")
        private val BASE = Regex("^https?://[^/?#\\s]+$")

        /** Parse the payload's `site_cache`; null for anything we would not trust to build a URL from. */
        fun parse(o: JSONObject?): SiteCacheConfig? {
            if (o == null) return null
            val url = o.optString("url", "")
            val token = o.optString("token", "")
            if (!BASE.matches(url) || token.isEmpty() || token.length > 400) return null
            val files = HashMap<String, Entry>()
            val f = o.optJSONObject("files") ?: return null
            for (key in f.keys()) {
                val e = f.optJSONObject(key) ?: continue
                val sha = e.optString("sha256", "")
                val size = e.optLong("size", -1L)
                if (SHA.matches(sha) && size >= 0) files[key] = Entry(sha, size)
            }
            return SiteCacheConfig(url, token, o.optLong("expires_at", 0L), files)
        }
    }
}
