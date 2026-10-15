package com.remotedisplay.player.remote

import org.json.JSONArray
import org.json.JSONObject

/**
 * 3.0 screen share (docs/screen-share.md) — the WIRE half of the Android receiver, with no Android
 * or WebRTC types in it so the JVM unit tests (ScreenShareProtocolTest) can hold it to the same
 * contract the web player's receiver (server/lib/screen-share-player.js) and the server relay
 * (server/lib/screen-share.js) speak.
 *
 * The screen's leg is a plain WebSocket, /api/devices/:id/screen-share/ws. The device_token goes in
 * the FIRST message, never in the URL (so it is not in any access log), the screen OFFERS recvonly
 * video+audio, and SDP/candidates use go2rtc's {type:'webrtc/…', value} shape.
 */
object ScreenShareProtocol {
    /** Nothing playing this long after start: give up rather than hold a black screen (web: 45 s). */
    const val CONNECT_TIMEOUT_MS = 45_000L
    private const val MAX_NAME = 40
    private val SESSION_ID = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val QR_DATA_URL = Regex("^data:image/png;base64,([A-Za-z0-9+/=]+)$")
    // C0/C1 controls, zero-width and bidi overrides — the same set the server strips (cleanName).
    private val UNSAFE = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]")

    /** device:screenshare-start, validated. */
    data class Start(
        val sessionId: String,
        val sharedBy: String,
        val guest: Boolean,
        val maxSeconds: Int,
        val iceServers: JSONArray,
    )

    fun parseStart(o: JSONObject?): Start? {
        if (o == null) return null
        val id = o.opt("session_id") as? String ?: return null
        if (!SESSION_ID.matches(id)) return null
        val by = o.opt("shared_by") as? String ?: ""
        return Start(
            sessionId = id,
            sharedBy = cleanName(by),
            guest = o.optBoolean("guest", false),
            maxSeconds = o.optInt("max_seconds", 3600),
            iceServers = o.optJSONArray("ice_servers") ?: JSONArray(),
        )
    }

    /** The server already cleans the name; this is the belt to its braces (it goes on a TV). */
    fun cleanName(raw: String?): String =
        (raw ?: "").replace(UNSAFE, " ").replace(Regex("\\s+"), " ").trim().take(MAX_NAME)

    /** The local backstop for the server's time limit: clamp(60 s, 8 h) plus 5 s of grace. */
    fun maxDurationMs(maxSeconds: Int): Long =
        maxSeconds.coerceIn(60, 8 * 3600).toLong() * 1000L + 5000L

    /** http(s)://host/base -> ws(s)://host/base/api/devices/<id>/screen-share/ws */
    fun wsUrl(serverUrl: String, deviceId: String): String {
        val base = serverUrl.trim().trimEnd('/')
        val ws = when {
            base.startsWith("https://", ignoreCase = true) -> "wss://" + base.substring(8)
            base.startsWith("http://", ignoreCase = true) -> "ws://" + base.substring(7)
            else -> base
        }
        return ws + "/api/devices/" + java.net.URLEncoder.encode(deviceId, "UTF-8") + "/screen-share/ws"
    }

    fun authMessage(deviceToken: String, sessionId: String): String =
        JSONObject().put("type", "auth").put("device_token", deviceToken).put("session_id", sessionId).toString()

    fun offerMessage(sdp: String): String = JSONObject().put("type", "webrtc/offer").put("value", sdp).toString()

    fun candidateMessage(candidate: String, mid: String?, mline: Int?): String {
        val o = JSONObject().put("type", "webrtc/candidate").put("value", candidate)
        if (!mid.isNullOrEmpty()) o.put("mid", mid)
        if (mline != null && mline >= 0) o.put("mline", mline)
        return o.toString()
    }

    /** States the relay accepts from a screen (server DEVICE_STATES). */
    val STATES = setOf("connecting", "connected", "playing", "failed", "disconnected", "unsupported")

    fun stateMessage(value: String): String {
        require(value in STATES) { "unknown state $value" }
        return JSONObject().put("type", "state").put("value", value).toString()
    }

    sealed class Incoming {
        object Ready : Incoming()
        data class Answer(val sdp: String) : Incoming()
        /** [mid] wins when present; otherwise [mline] (default 0), exactly as the web receiver does. */
        data class Candidate(val candidate: String, val mid: String?, val mline: Int) : Incoming()
        data class Ended(val reason: String) : Incoming()
        object Ignored : Incoming()
    }

    fun parseIncoming(text: String?): Incoming {
        val o = try { JSONObject(text ?: return Incoming.Ignored) } catch (_: Throwable) { return Incoming.Ignored }
        return when (o.optString("type")) {
            "ready" -> Incoming.Ready
            "webrtc/answer" -> (o.opt("value") as? String)?.takeIf { it.startsWith("v=0") }?.let { Incoming.Answer(it) } ?: Incoming.Ignored
            "webrtc/candidate" -> {
                val c = o.opt("value") as? String
                if (c.isNullOrEmpty()) Incoming.Ignored
                else Incoming.Candidate(c, o.opt("mid") as? String, (o.opt("mline") as? Number)?.toInt()?.takeIf { it >= 0 } ?: 0)
            }
            "ended" -> Incoming.Ended(o.optString("reason").ifEmpty { "ended" })
            else -> Incoming.Ignored
        }
    }

    /** A stop for session [stopId] ends [currentId]; no id means "whatever is on screen". */
    fun stopApplies(currentId: String?, stopId: String?): Boolean =
        currentId != null && (stopId.isNullOrEmpty() || stopId == currentId)

    /** "{name}" substitution, the same as the web receiver's fmt(). */
    fun fmt(template: String, name: String): String = template.replace("{name}", name)

    fun badgeText(sharedByTemplate: String, guestWord: String, sharedBy: String, guest: Boolean): String =
        fmt(sharedByTemplate, sharedBy) + if (guest) " · $guestWord" else ""

    /** device:screenshare-code. Null = hide the corner badge. */
    data class Code(val code: String, val shownUrl: String, val qrPngBase64: String?)

    fun parseCode(o: JSONObject?): Code? {
        val code = o?.opt("code") as? String ?: return null
        if (code.isBlank() || code.length > 32) return null
        // Only a data: PNG from our own server is used as the QR; anything else is ignored.
        val qr = (o.opt("qr") as? String)?.let { QR_DATA_URL.matchEntire(it)?.groupValues?.get(1) }
        val url = (o.opt("url") as? String)?.takeIf { it.isNotBlank() } ?: "/share"
        return Code(code, url.replace(Regex("^https?://", RegexOption.IGNORE_CASE), ""), qr)
    }

    /** The largest [vw]x[vh] box that fits [pw]x[ph] (object-fit: contain), for the share's letterbox. */
    fun fit(pw: Int, ph: Int, vw: Int, vh: Int): Pair<Int, Int> {
        if (pw <= 0 || ph <= 0 || vw <= 0 || vh <= 0) return Pair(pw, ph)
        return if (vw.toLong() * ph >= vh.toLong() * pw) Pair(pw, (pw.toLong() * vh / vw).toInt())
        else Pair((ph.toLong() * vw / vh).toInt(), ph)
    }
}
