package com.screentinker.manager.share

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * 3.0 "Share my screen" from the phone: ONE screen capture (MediaProjection, ProjectionCapturer)
 * sent peer to peer to every leg the server hands back — the display and its
 * mirrors, and any mirror that connects during the share (add_leg) — exactly what the browser's
 * MultiShareSender does. The server only relays the signalling; the video never touches it.
 *
 * How it starts: [Start.Guest] spends a meeting-room code (POST /api/share/join on the server the
 * person confirmed — no account); [Start.SignedIn] starts a share to screens the person picked in
 * the Simple view (POST /api/screen-share/shares with their session). The code (or the slot) is only
 * spent AFTER the person granted the capture, like the web page.
 *
 * Threading follows the player's ScreenShareReceiver: every libwebrtc create/dispose on the single
 * [ctl] thread, never on a callback thread. Events go to [listener] on the main thread.
 */
class ScreenShareSession(
    private val appContext: Context,
    private val projection: Intent,
    private val start: Start,
    private val listener: Listener,
) {
    sealed class Start(val origin: String) {
        class Guest(origin: String, val code: String, val name: String) : Start(origin)
        class SignedIn(origin: String, val token: String, val deviceIds: List<String>) : Start(origin)
    }

    interface Listener {
        /** state: "joining" | "connecting" | "negotiating" | "live"; live/total: legs playing / open. */
        fun onState(state: String, screenName: String, live: Int, total: Int)
        fun onNotice(screenName: String, reason: String)
        fun onEnded(reason: String)
    }

    private val tag = "STShare"
    private val main = Handler(Looper.getMainLooper())
    private val ctl = Executors.newSingleThreadExecutor { r -> Thread(r, "st-share-ctl") }
    private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()

    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var adm: JavaAudioDeviceModule? = null
    private var capturer: ProjectionCapturer? = null
    private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    private val legs = ArrayList<Leg>()
    private var wsPath = "/api/screen-share/ws"
    private var screenName = ""
    @Volatile private var ended = false
    private var size = Pair(1280, 720)

    private fun submit(block: () -> Unit) {
        try { if (!ctl.isShutdown) ctl.execute(block) } catch (_: RejectedExecutionException) {}
    }

    /** width x height to capture, already scaled (long side at most 1280, even numbers). */
    fun begin(width: Int, height: Int) {
        size = scaled(width, height)
        post { listener.onState("joining", "", 0, 0) }
        submit {
            if (ended) return@submit
            // 1. Spend the code / take the slot. Only now: the person has already said yes to capture.
            val joined = try { join() } catch (e: Exception) {
                Log.w(tag, "join failed: ${e.message}")
                finish(if (e is Refused) e.reason else "signalling_failed"); return@submit
            }
            wsPath = joined.wsPath
            screenName = joined.screenName
            // 2. The capture and one track for every leg.
            try { startCapture() } catch (t: Throwable) {
                Log.e(tag, "capture failed: ${t.message}", t)
                finish("capture_failed"); return@submit
            }
            for (l in joined.legs) openLeg(l)
            summary()
        }
    }

    /** The screen turned: capture the new shape. */
    fun resize(width: Int, height: Int) {
        val s = scaled(width, height)
        submit {
            if (ended || s == size) return@submit
            size = s
            try { capturer?.changeCaptureFormat(s.first, s.second, FPS) } catch (_: Throwable) {}
        }
    }

    /** The person pressed Stop (or the capture was revoked). Ends every leg. */
    fun stop(reason: String = "stopped_by_sharer") {
        submit {
            for (l in legs) l.sendStop()
            finish(reason)
        }
    }

    private class Refused(val reason: String) : Exception(reason)

    private fun join(): ShareProtocol.Joined {
        val (url, body, auth) = when (start) {
            is Start.Guest -> Triple("${start.origin}/api/share/join", ShareProtocol.joinBody(start.code, start.name), null)
            is Start.SignedIn -> Triple("${start.origin}/api/screen-share/shares", ShareProtocol.sharesBody(start.deviceIds), start.token)
        }
        val req = Request.Builder().url(url)
            .post(body.toRequestBody("application/json".toMediaType()))
            .header("Accept", "application/json")
            .apply { if (auth != null) header("Authorization", "Bearer $auth") }
            .build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (res.code != 201 && res.code != 200) throw Refused(ShareProtocol.refusal(res.code, text))
            return ShareProtocol.joined(text) ?: throw Refused("generic")
        }
    }

    // On ctl.
    private fun startCapture() {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions())
        val e = EglBase.create().also { egl = it }
        // No audio track is ever created, so the module never opens the microphone.
        val module = JavaAudioDeviceModule.builder(appContext).createAudioDeviceModule().also { adm = it }
        val f = PeerConnectionFactory.builder()
            .setAudioDeviceModule(module)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(e.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(e.eglBaseContext))
            .createPeerConnectionFactory().also { factory = it }
        // The person stopped it from the system (the status-bar chip, "Stop sharing"): the share ends.
        val cap = ProjectionCapturer(projection) { stop("stopped_by_sharer") }
        capturer = cap
        val h = SurfaceTextureHelper.create("st-share-capture", e.eglBaseContext).also { helper = it }
        val src = f.createVideoSource(true).also { source = it }
        cap.initialize(h, appContext, src.capturerObserver)
        cap.startCapture(size.first, size.second, FPS)
        track = f.createVideoTrack("st-screen", src)
    }

    // On ctl.
    private fun openLeg(l: ShareProtocol.Leg) {
        if (ended || legs.any { it.leg.sessionId == l.sessionId }) return
        val leg = Leg(l)
        legs.add(leg)
        leg.open()
    }

    private fun summary() {
        val open = legs.filter { !it.done }
        val live = open.count { it.state == "live" }
        val state = if (live > 0) "live" else if (open.any { it.state == "negotiating" }) "negotiating" else "connecting"
        val name = screenName
        post { if (!ended) listener.onState(state, name, live, open.size) }
    }

    // On ctl. One leg ended; the share ends with the last one.
    private fun legEnded(leg: Leg, reason: String) {
        if (leg.done) return
        leg.done = true
        leg.reason = reason
        leg.close()
        if (ended) return
        if (legs.all { it.done }) {
            val reasons = legs.map { it.reason }.toSet()
            finish(if (reasons.size == 1) reason else "sharer_left")
            return
        }
        if (reason == "spotlight_changed") post { listener.onNotice(leg.leg.screenName, "single_presenter") }
        summary()
    }

    // On ctl. Idempotent.
    private fun finish(reason: String) {
        if (ended) return
        ended = true
        for (l in legs) l.close()
        try { capturer?.stopCapture() } catch (_: Throwable) {}
        try { capturer?.dispose() } catch (_: Throwable) {}
        try { track?.dispose() } catch (_: Throwable) {}
        try { source?.dispose() } catch (_: Throwable) {}
        try { helper?.dispose() } catch (_: Throwable) {}
        try { factory?.dispose() } catch (_: Throwable) {}
        try { adm?.release() } catch (_: Throwable) {}
        try { egl?.release() } catch (_: Throwable) {}
        capturer = null; track = null; source = null; helper = null; factory = null; adm = null; egl = null
        post { listener.onEnded(reason) }
        ctl.shutdown()
    }

    private fun post(block: () -> Unit) { main.post { try { block() } catch (_: Throwable) {} } }

    /** One screen: its signalling socket and its peer connection. All methods on ctl. */
    private inner class Leg(val leg: ShareProtocol.Leg) {
        var state = "connecting"
        var done = false
        var reason: String? = null
        private var ws: WebSocket? = null
        private var pc: PeerConnection? = null
        private val pendingRemote = ArrayList<IceCandidate>()
        private var remoteSet = false

        fun open() {
            val url = ShareProtocol.wsUrl(start.origin, wsPath)
            ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                // The ticket is the FIRST MESSAGE, never part of the URL (access logs).
                override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send(ShareProtocol.auth(leg.ticket)) }
                override fun onMessage(webSocket: WebSocket, text: String) { val m = ShareProtocol.parseIncoming(text); submit { on(m) } }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { submit { legEnded(this@Leg, "signalling_failed") } }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { submit { legEnded(this@Leg, this@Leg.reason ?: "signalling_closed") } }
            })
        }

        private fun on(m: ShareProtocol.Incoming) {
            if (done || ended) return
            when (m) {
                is ShareProtocol.Incoming.Ready -> { state = "connecting"; summary() }
                is ShareProtocol.Incoming.ScreenJoined -> { state = "negotiating"; summary() }
                is ShareProtocol.Incoming.Playing -> { state = "live"; summary() }
                is ShareProtocol.Incoming.Offer -> answer(m.sdp)
                is ShareProtocol.Incoming.Candidate -> {
                    val c = IceCandidate(m.mid ?: "", m.mline, m.candidate)
                    if (remoteSet) try { pc?.addIceCandidate(c) } catch (_: Throwable) {} else pendingRemote.add(c)
                }
                is ShareProtocol.Incoming.Ended -> { reason = m.reason; legEnded(this, m.reason) }
                is ShareProtocol.Incoming.AddLeg -> openLeg(m.leg)
                is ShareProtocol.Incoming.LegSkipped -> { val n = m.screenName; val r = m.reason; post { listener.onNotice(n, r) } }
                else -> {}
            }
        }

        private fun answer(sdp: String) {
            if (pc != null) return
            val f = factory ?: return
            val cfg = PeerConnection.RTCConfiguration(iceServers(leg.iceServers)).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
            val conn = f.createPeerConnection(cfg, Observer()) ?: run { fail(); return }
            pc = conn
            conn.setRemoteDescription(Sdp(onSet = { submit { afterRemote(conn) } }, onFail = { submit { fail() } }), SessionDescription(SessionDescription.Type.OFFER, sdp))
        }

        // The screen offered recvonly video + audio: our screen on the video one, the audio one off.
        private fun afterRemote(conn: PeerConnection) {
            if (done || ended) return
            remoteSet = true
            for (t in conn.transceivers) {
                if (t.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO && track != null) {
                    t.sender.setTrack(track, false)
                    t.direction = RtpTransceiver.RtpTransceiverDirection.SEND_ONLY
                } else t.direction = RtpTransceiver.RtpTransceiverDirection.INACTIVE
            }
            conn.createAnswer(Sdp(onCreated = { ans ->
                submit {
                    if (done || ended) return@submit
                    conn.setLocalDescription(Sdp(onSet = {
                        submit {
                            ws?.send(ShareProtocol.answer(ans.description))
                            for (c in pendingRemote) try { conn.addIceCandidate(c) } catch (_: Throwable) {}
                            pendingRemote.clear()
                        }
                    }, onFail = { submit { fail() } }), ans)
                }
            }, onFail = { submit { fail() } }), MediaConstraints())
        }

        fun fail() {
            try { ws?.send(ShareProtocol.state("failed")) } catch (_: Throwable) {}
            reason = "connection_failed"
            legEnded(this, "connection_failed")
        }

        fun sendStop() { try { ws?.send(ShareProtocol.stop()) } catch (_: Throwable) {} }

        fun close() {
            try { ws?.close(1000, "stop") } catch (_: Throwable) {}
            try { pc?.close(); pc?.dispose() } catch (_: Throwable) {}
            ws = null; pc = null
        }

        private inner class Observer : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate?) {
                val c = candidate ?: return
                submit { if (!done) ws?.send(ShareProtocol.candidate(c.sdp, c.sdpMid, c.sdpMLineIndex)) }
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                when (newState) {
                    PeerConnection.PeerConnectionState.CONNECTED -> submit { ws?.send(ShareProtocol.state("connected")) }
                    PeerConnection.PeerConnectionState.FAILED -> submit { if (!done) fail() }
                    else -> {}
                }
            }
            override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: MediaStream?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onDataChannel(p0: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(p0: RtpReceiver?, p1: Array<out MediaStream>?) {}
            override fun onTrack(transceiver: RtpTransceiver?) {}
        }
    }

    private inner class Sdp(
        private val onCreated: ((SessionDescription) -> Unit)? = null,
        private val onSet: (() -> Unit)? = null,
        private val onFail: () -> Unit,
    ) : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) { onCreated?.invoke(sdp) }
        override fun onSetSuccess() { onSet?.invoke() }
        override fun onCreateFailure(error: String?) { Log.w(tag, "sdp: $error"); onFail() }
        override fun onSetFailure(error: String?) { Log.w(tag, "sdp: $error"); onFail() }
    }

    companion object {
        const val FPS = 24
        const val MAX_EDGE = 1280

        /** Keep the shape, long side at most MAX_EDGE, both even (encoders want that). */
        fun scaled(w: Int, h: Int): Pair<Int, Int> {
            if (w <= 0 || h <= 0) return Pair(MAX_EDGE, 720)
            val k = minOf(1.0, MAX_EDGE.toDouble() / maxOf(w, h))
            val sw = (w * k).toInt() and 1.inv()
            val sh = (h * k).toInt() and 1.inv()
            return Pair(maxOf(2, sw), maxOf(2, sh))
        }

        /** The server's ice_servers ([{urls, username?, credential?}]) as libwebrtc wants them. */
        fun iceServers(arr: JSONArray): List<PeerConnection.IceServer> {
            val out = ArrayList<PeerConnection.IceServer>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val urls = ArrayList<String>()
                when (val u = o.opt("urls")) {
                    is String -> urls.add(u)
                    is JSONArray -> for (j in 0 until u.length()) u.optString(j).takeIf { it.isNotBlank() }?.let(urls::add)
                }
                val good = urls.filter { Regex("^(stun|stuns|turn|turns):", RegexOption.IGNORE_CASE).containsMatchIn(it) }
                if (good.isEmpty()) continue
                val b = PeerConnection.IceServer.builder(good)
                o.optString("username", "").takeIf { it.isNotEmpty() }?.let { b.setUsername(it) }
                o.optString("credential", "").takeIf { it.isNotEmpty() }?.let { b.setPassword(it) }
                out.add(b.createIceServer())
            }
            return out
        }
    }
}
