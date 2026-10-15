package com.screentinker.manager.share

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink

/**
 * The phone's screen as a libwebrtc video source, like libwebrtc's own ScreenCapturerAndroid with one
 * difference that matters on Android 14+: a turn of the phone RESIZES the virtual display instead of
 * creating a new one. ScreenCapturerAndroid.changeCaptureFormat() releases and recreates it, and
 * Android 14 allows one createVirtualDisplay per MediaProjection — the second ends the projection, so
 * turning the phone stopped the share (seen on the Android 16 emulator).
 */
class ProjectionCapturer(private val permission: Intent, private val onStopped: () -> Unit) : VideoCapturer, VideoSink {

    private var helper: SurfaceTextureHelper? = null
    private var observer: CapturerObserver? = null
    private var context: Context? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var surface: Surface? = null
    private var dpi = 320
    @Volatile private var stopped = false

    private val callback = object : MediaProjection.Callback() {
        override fun onStop() { if (!stopped) onStopped() }
    }

    override fun initialize(helper: SurfaceTextureHelper, context: Context, observer: CapturerObserver) {
        this.helper = helper
        this.observer = observer
        this.context = context
        dpi = context.resources.displayMetrics.densityDpi
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        val h = helper ?: throw IllegalStateException("not initialized")
        val mpm = context!!.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val p = mpm.getMediaProjection(Activity.RESULT_OK, permission) ?: throw IllegalStateException("no projection")
        projection = p
        // Android 14+: a callback must be registered before the virtual display is created.
        p.registerCallback(callback, h.handler)
        h.setTextureSize(width, height)
        val s = Surface(h.surfaceTexture).also { surface = it }
        display = p.createVirtualDisplay("st-screen-share", width, height, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, s, null, h.handler)
        observer?.onCapturerStarted(true)
        h.startListening(this)
    }

    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
        val h = helper ?: return
        h.handler.post {
            if (stopped) return@post
            h.setTextureSize(width, height)
            try { display?.resize(width, height, dpi) } catch (_: Throwable) {}
        }
    }

    override fun stopCapture() {
        stopped = true
        val h = helper ?: return
        val done = java.util.concurrent.CountDownLatch(1)
        h.handler.post {
            try { h.stopListening() } catch (_: Throwable) {}
            try { observer?.onCapturerStopped() } catch (_: Throwable) {}
            try { display?.release() } catch (_: Throwable) {}
            try { surface?.release() } catch (_: Throwable) {}
            try { projection?.unregisterCallback(callback) } catch (_: Throwable) {}
            try { projection?.stop() } catch (_: Throwable) {}
            display = null; surface = null; projection = null
            done.countDown()
        }
        try { done.await(2, java.util.concurrent.TimeUnit.SECONDS) } catch (_: Throwable) {}
    }

    override fun dispose() { stopped = true }

    override fun isScreencast(): Boolean = true

    override fun onFrame(frame: VideoFrame) { observer?.onFrameCaptured(frame) }
}
