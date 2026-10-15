package com.screentinker.manager.share

import java.net.IDN
import java.net.URI

/**
 * 3.0 guest screen share: what a meeting-room link or a typed address + code means, and whether it is
 * safe to act on. Pure Kotlin (java.net only) so the JVM unit tests hold it to the server's rules.
 *
 * A guest share needs no account and no saved server: the SERVER comes from the link itself. That is
 * exactly why this is strict — a link from anywhere could otherwise send the phone's screen anywhere.
 * So: only http/https, a real host, no user:password@ trick, the host shown to the person in ASCII
 * (punycode, so a look-alike domain shows as xn--…) BEFORE anything is captured, and only a code in
 * the server's own alphabet. The link never carries anything that is sent anywhere but that server.
 *
 * Links it understands (docs/screen-share.md, "Android app"):
 *   screentinker://share?server=<origin>&code=<code>     the /share page's "use the app" button
 *   https://<host>[:port]/share?code=<code>              the QR on the screen (http on a LAN too)
 *   https://<host>[:port]/share#<code>                   the QR of a server from before 3.0's ?code=
 */
object ShareLink {

    /** Crockford base32 without I, L, O, U — the server's lib/screen-share.js CODE_ALPHABET. */
    const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const val CODE_LEN = 8
    const val SCHEME = "screentinker"

    /** A validated target: the server's origin, the host to show the person, and the code (canonical). */
    data class Target(val origin: String, val host: String, val code: String?) {
        /** "ABCD-1234", as the screen shows it. */
        val displayCode: String? get() = code?.let { "${it.substring(0, 4)}-${it.substring(4)}" }
    }

    /**
     * What a person typed (or a link carried) -> the canonical code, or null. Case, spaces and dashes
     * forgiven; Crockford look-alikes mapped (O->0, I/L->1), exactly like the server's normaliseCode.
     */
    fun normaliseCode(raw: String?): String? {
        if (raw == null) return null
        val s = raw.uppercase().replace(Regex("[\\s-]"), "").replace('O', '0').replace('I', '1').replace('L', '1')
        if (s.length != CODE_LEN) return null
        return if (s.all { it in ALPHABET }) s else null
    }

    /**
     * An address -> its origin ("https://signage.example.com:8443"), or null when it is not a plain
     * http(s) address with a host. `typed`: what a person entered by hand may leave out the scheme
     * (https is assumed); a LINK must say http or https itself.
     */
    fun normaliseOrigin(raw: String?, typed: Boolean = false): String? {
        var s = raw?.trim() ?: return null
        if (s.isEmpty() || s.length > 2048 || s.any { it.isWhitespace() || it.code < 0x20 }) return null
        if (typed && !s.contains("://")) s = "https://$s"
        val u = try { URI(s) } catch (_: Exception) { return null }
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (u.rawUserInfo != null) return null            // https://screentinker.com@evil.example
        val host = asciiHost(u.host ?: hostFromAuthority(u.rawAuthority) ?: return null) ?: return null
        val port = u.port
        if (port == 0 || port > 65535) return null
        val defaultPort = if (scheme == "http") 80 else 443
        return "$scheme://$host" + (if (port > 0 && port != defaultPort) ":$port" else "")
    }

    /** The host as the person should see it: ASCII (punycode for international names), with any port. */
    fun displayHost(origin: String): String = origin.substringAfter("://")

    /**
     * A link (from the QR, the /share page's button, or a typed URL) -> a Target, or null when it is
     * not a share link this app should act on. A link with a valid server but no (or a bad) code gives
     * a Target with code = null: the app asks for the code, still showing the server.
     */
    fun parse(link: String?): Target? {
        val raw = link?.trim() ?: return null
        if (raw.isEmpty() || raw.length > 4096) return null
        val u = try { URI(raw) } catch (_: Exception) { return null }
        when (u.scheme?.lowercase()) {
            SCHEME -> {
                // screentinker://share?server=…&code=…
                if (!u.rawAuthority.equals("share", ignoreCase = true) && u.rawSchemeSpecificPart?.startsWith("//share") != true) return null
                val q = query(u.rawQuery)
                val origin = normaliseOrigin(q["server"]) ?: return null
                return Target(origin, displayHost(origin), normaliseCode(q["code"]))
            }
            "http", "https" -> {
                val path = (u.rawPath ?: "").trimEnd('/')
                if (!path.equals("/share", ignoreCase = true)) return null
                val origin = normaliseOrigin("${u.scheme}://${u.rawAuthority ?: return null}") ?: return null
                val code = normaliseCode(query(u.rawQuery)["code"]) ?: normaliseCode(u.rawFragment?.let(::decode))
                return Target(origin, displayHost(origin), code)
            }
            else -> return null
        }
    }

    /** By hand: an address (scheme optional) and a code. Null when either is not usable. */
    fun manual(address: String?, code: String?): Target? {
        val origin = normaliseOrigin(address, typed = true) ?: return null
        val c = normaliseCode(code) ?: return null
        return Target(origin, displayHost(origin), c)
    }

    // ------------------------------------------------------------------------------------------

    private fun asciiHost(host: String): String? {
        var h = host.trim().trimEnd('.')
        if (h.isEmpty()) return null
        if (h.startsWith("[") && h.endsWith("]")) return h.lowercase()   // IPv6 literal
        h = try { IDN.toASCII(h, IDN.USE_STD3_ASCII_RULES).lowercase() } catch (_: Exception) { return null }
        if (h.isEmpty() || h.length > 253) return null
        if (!h.all { it.isLetterOrDigit() || it == '-' || it == '.' }) return null
        return h
    }

    // java.net.URI leaves host null for names it does not like (underscores, non-ASCII); take it from
    // the authority instead and let asciiHost decide.
    private fun hostFromAuthority(auth: String?): String? {
        val a = auth ?: return null
        if (a.contains('@')) return null
        val h = if (a.startsWith("[")) a.substringBefore("]") + "]" else a.substringBefore(':')
        return decode(h)
    }

    private fun query(raw: String?): Map<String, String> {
        if (raw.isNullOrEmpty()) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (part in raw.split('&')) {
            val k = decode(part.substringBefore('='))
            val v = decode(part.substringAfter('=', ""))
            if (k.isNotEmpty() && k !in out) out[k] = v
        }
        return out
    }

    private fun decode(s: String): String = try { java.net.URLDecoder.decode(s, "UTF-8") } catch (_: Exception) { s }
}
