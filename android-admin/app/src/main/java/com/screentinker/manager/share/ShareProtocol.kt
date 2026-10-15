package com.screentinker.manager.share

import org.json.JSONArray
import org.json.JSONObject

/**
 * 3.0 screen share — the SHARER's side of the signalling, as the server's lib/screen-share.js speaks
 * it (docs/screen-share.md, "Protocol"). The same messages the browser's screen-share-client.js sends:
 *
 *   POST /api/share/join {code, name, audio:false, source:'app'}   (a guest; no account)
 *   POST /api/screen-share/shares {device_ids}                      (signed in, from the Simple view)
 *     -> { ws_path, screen_name?, legs: [{ session_id, ticket, ice_servers, screen_name, device_id? }] }
 *   WS <ws_path>: -> {type:auth, ticket}  <- ready / screen_joined / webrtc/offer / webrtc/candidate /
 *                 screen_playing / ended / add_leg / leg_skipped / room
 *                 -> webrtc/answer, webrtc/candidate, state, stop
 *
 * The SCREEN offers (recvonly video + audio); this side answers with its screen on the video
 * transceiver and the audio one inactive. Kept free of Android so the JVM tests can check it.
 */
object ShareProtocol {

    data class Leg(val sessionId: String, val ticket: String, val screenName: String, val iceServers: JSONArray)

    data class Joined(val wsPath: String, val screenName: String, val legs: List<Leg>)

    sealed class Incoming {
        object Ready : Incoming()
        object ScreenJoined : Incoming()
        object Playing : Incoming()
        data class Offer(val sdp: String) : Incoming()
        data class Candidate(val candidate: String, val mid: String?, val mline: Int) : Incoming()
        data class Ended(val reason: String) : Incoming()
        data class AddLeg(val leg: Leg) : Incoming()
        data class LegSkipped(val screenName: String, val reason: String) : Incoming()
        data class Room(val count: Int, val slots: Int, val first: Boolean) : Incoming()
        object Other : Incoming()
    }

    private val WS_PATH = Regex("^/api/[A-Za-z0-9/_-]{1,100}$")
    private val ID = Regex("^[A-Za-z0-9_-]{1,128}$")

    /** A leg from the server, or null when it is not one (never trust a field we did not check). */
    fun leg(o: JSONObject?): Leg? {
        o ?: return null
        val sid = o.optString("session_id", "")
        val ticket = o.optString("ticket", "")
        if (!ID.matches(sid) || ticket.isEmpty() || ticket.length > 128) return null
        return Leg(sid, ticket, o.optString("screen_name", "").take(200), o.optJSONArray("ice_servers") ?: JSONArray())
    }

    /** The answer to a join / start: the legs to open. Null when it is not a usable answer. */
    fun joined(body: String): Joined? {
        val o = try { JSONObject(body) } catch (_: Exception) { return null }
        val path = o.optString("ws_path", "/api/screen-share/ws").ifEmpty { "/api/screen-share/ws" }
        if (!WS_PATH.matches(path)) return null
        val legs = ArrayList<Leg>()
        o.optJSONArray("legs")?.let { arr -> for (i in 0 until arr.length()) leg(arr.optJSONObject(i))?.let(legs::add) }
        // A server from before multi share answers with one ticket and no legs.
        if (legs.isEmpty()) leg(o)?.let(legs::add)
        if (legs.isEmpty()) return null
        val name = o.optString("screen_name", "").ifEmpty { legs.first().screenName }
        return Joined(path, name.take(200), legs)
    }

    /** Why a join was refused, from the server's body ("invalid_code", "busy", …) or the HTTP status. */
    fun refusal(status: Int, body: String?): String {
        if (status == 429) return "slow_down"
        val r = try { JSONObject(body ?: "").optString("reason", "") } catch (_: Exception) { "" }
        return if (Regex("^[a-z_]{1,40}$").matches(r)) r else "generic"
    }

    fun parseIncoming(text: String): Incoming {
        val m = try { JSONObject(text) } catch (_: Exception) { return Incoming.Other }
        return when (m.optString("type")) {
            "ready" -> Incoming.Ready
            "screen_joined" -> Incoming.ScreenJoined
            "screen_playing" -> Incoming.Playing
            "webrtc/offer" -> m.optString("value", "").let { if (it.startsWith("v=0")) Incoming.Offer(it) else Incoming.Other }
            "webrtc/candidate" -> {
                val v = m.optString("value", "")
                if (!Regex("^(a=)?candidate:").containsMatchIn(v)) Incoming.Other
                else Incoming.Candidate(v.removePrefix("a="), if (m.has("mid") && !m.isNull("mid")) m.optString("mid") else null, m.optInt("mline", 0))
            }
            "ended" -> Incoming.Ended(m.optString("reason", "ended").take(40))
            "add_leg" -> leg(m.optJSONObject("leg"))?.let { Incoming.AddLeg(it) } ?: Incoming.Other
            "leg_skipped" -> Incoming.LegSkipped(m.optString("screen_name", "").take(200), m.optString("reason", "").take(40))
            "room" -> Incoming.Room(m.optJSONArray("presenters")?.length() ?: 0, m.optInt("slots", 1), m.optBoolean("first", false))
            else -> Incoming.Other
        }
    }

    fun auth(ticket: String): String = JSONObject().put("type", "auth").put("ticket", ticket).toString()
    fun answer(sdp: String): String = JSONObject().put("type", "webrtc/answer").put("value", sdp).toString()
    fun candidate(sdp: String, mid: String?, mline: Int): String =
        JSONObject().put("type", "webrtc/candidate").put("value", sdp).put("mid", mid ?: JSONObject.NULL).put("mline", mline).toString()
    fun state(value: String): String = JSONObject().put("type", "state").put("value", value).toString()
    fun stop(): String = JSONObject().put("type", "stop").toString()

    /** The guest join body. audio:false — the app shares the picture only (docs/screen-share.md). */
    fun joinBody(code: String, name: String): String =
        JSONObject().put("code", code).put("name", name.take(40)).put("audio", false).put("source", "app").toString()

    /** The signed-in start body (POST /api/screen-share/shares). */
    fun sharesBody(deviceIds: List<String>): String =
        JSONObject().put("device_ids", JSONArray(deviceIds.filter { ID.matches(it) }.take(50))).put("audio", false).toString()

    /** http(s)://host[:port] + ws_path -> ws(s)://host[:port]/ws_path. */
    fun wsUrl(origin: String, wsPath: String): String =
        origin.replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws") + wsPath
}
