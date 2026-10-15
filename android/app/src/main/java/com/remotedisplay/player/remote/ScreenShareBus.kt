package com.remotedisplay.player.remote

import org.webrtc.EglBase
import org.webrtc.VideoTrack

/**
 * 3.0 screen share — decouples the receiver (ScreenShareReceiver, owned by WebSocketService, which
 * is where the socket events arrive) from where it is drawn (ScreenShareOverlay in MainActivity,
 * the only place with a window). Same split as [TalkVideoBus].
 *
 * Every call reaches the listener on the main thread. The bus also remembers the current session
 * and the current meeting-room code, so an Activity that is recreated mid-share (rotation, a crash
 * restart) can paint the right thing when it attaches.
 */
object ScreenShareBus {
    interface Listener {
        /** A share started: cover the content, "Connecting to …" until the first frame, and the badge. */
        fun onShareStart(start: ScreenShareProtocol.Start)
        /** The sharer's video arrived. [egl] is the context its decoder renders in. */
        fun onShareTrack(sessionId: String, track: VideoTrack, egl: EglBase.Context)
        /**
         * Share [sessionId] is over, however it ended: put the content back. Ignore it when a newer
         * share has already started (a replaced share's end can arrive after the new one's start).
         */
        fun onShareEnd(sessionId: String)
        /** The meeting-room code to show in the corner, or null to hide it. */
        fun onCode(code: ScreenShareProtocol.Code?)
    }

    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    @Volatile var listener: Listener? = null
        set(value) {
            field = value
            // Late attach: bring the new window up to date.
            if (value != null) main.post {
                try {
                    active?.let { value.onShareStart(it) }
                    val t = track; val e = egl
                    val a = active
                    if (a != null && t != null && e != null) value.onShareTrack(a.sessionId, t, e)
                    value.onCode(code)
                } catch (_: Throwable) {}
            }
        }

    @Volatile var active: ScreenShareProtocol.Start? = null; private set
    @Volatile private var track: VideoTrack? = null
    @Volatile private var egl: EglBase.Context? = null
    @Volatile var code: ScreenShareProtocol.Code? = null; private set

    fun start(s: ScreenShareProtocol.Start) {
        active = s; track = null; egl = null
        main.post { try { listener?.onShareStart(s) } catch (_: Throwable) {} }
    }

    fun track(sessionId: String, t: VideoTrack, e: EglBase.Context) {
        if (active?.sessionId != sessionId) return
        track = t; egl = e
        main.post { try { listener?.onShareTrack(sessionId, t, e) } catch (_: Throwable) {} }
    }

    /**
     * The share is over. [done] runs after the window has detached its renderer from the track —
     * the receiver waits for it before disposing the PeerConnection, because disposing a track that
     * a sink is still attached to is a native crash in libwebrtc.
     */
    fun end(sessionId: String, done: (() -> Unit)? = null) {
        if (active?.sessionId == sessionId) { active = null; track = null; egl = null }
        main.post {
            try { listener?.onShareEnd(sessionId) } catch (_: Throwable) {}
            try { done?.invoke() } catch (_: Throwable) {}
        }
    }

    fun code(c: ScreenShareProtocol.Code?) {
        code = c
        main.post { try { listener?.onCode(c) } catch (_: Throwable) {} }
    }
}
