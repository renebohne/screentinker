package com.remotedisplay.player.remote

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * 3.0 screen share — the three socket events, in one place, so WebSocketService only forwards them:
 *
 *   device:screenshare-start {session_id, shared_by, guest, max_seconds, ice_servers}
 *   device:screenshare-stop  {session_id, reason}
 *   device:screenshare-code  {code, url, qr} | {code: null}
 *
 * One share at a time (the server enforces it too); a newer start replaces an older one. While a
 * share is up the playlist is ducked (muted, video frozen) exactly as for Talk, and restored when it
 * ends — however it ends. All state is touched on the main thread only.
 */
class ScreenShareController(
    private val appContext: Context,
    /** serverUrl, deviceId, deviceToken — or null when the device is not provisioned. */
    private val credentials: () -> Triple<String, String, String>?,
    private val onDuck: (Boolean) -> Unit,
) {
    private val tag = "ScreenShare"
    private val main = Handler(Looper.getMainLooper())
    private var receiver: ScreenShareReceiver? = null

    val isActive: Boolean get() = receiver != null

    fun onStart(data: JSONObject?) = main.post {
        val start = ScreenShareProtocol.parseStart(data) ?: run { Log.w(tag, "start: bad payload"); return@post }
        val (url, id, token) = credentials() ?: run { Log.w(tag, "start: device not provisioned"); return@post }
        receiver?.stop("replaced")
        lateinit var r: ScreenShareReceiver
        r = ScreenShareReceiver(appContext, url, id, token, start) { reason ->
            Log.i(tag, "ended: $reason")
            if (receiver === r) { receiver = null; try { onDuck(false) } catch (_: Throwable) {} }
            ScreenShareBus.code(ScreenShareBus.code)   // repaint the corner code, hidden during the share
        }
        receiver = r
        try { onDuck(true) } catch (_: Throwable) {}
        r.begin()
    }

    fun onStop(data: JSONObject?) = main.post {
        val r = receiver ?: return@post
        val stopId = data?.opt("session_id") as? String
        if (!ScreenShareProtocol.stopApplies(r.sessionId, stopId)) return@post   // a late stop for an older share
        r.stop((data?.opt("reason") as? String)?.takeIf { it.isNotEmpty() } ?: "stopped")
    }

    fun onCode(data: JSONObject?) = main.post { ScreenShareBus.code(ScreenShareProtocol.parseCode(data)) }

    /** Socket gone / service destroyed: the relay ends the session anyway; do not leave it on screen. */
    fun shutdown(reason: String) = main.post { receiver?.stop(reason) }
}
