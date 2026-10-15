package com.remotedisplay.player.remote

import android.content.Context
import android.graphics.SurfaceTexture
import android.view.TextureView
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 3.0 screen share — a WebRTC video sink drawn into a TEXTURE view, not the SurfaceViewRenderer
 * Talk uses. Two reasons, both about this being the whole screen for up to an hour:
 *
 *  - A TextureView is part of the view hierarchy, so it turns with the player's orientation /
 *    video-wall transform (pipLayout mirrors rootView's). A SurfaceView ignores view transforms, so on
 *    a portrait-mounted panel the share would come out sideways.
 *  - The remote viewer can SEE it. ScreenshotCapture composites every TextureView's bitmap
 *    (TextureView.getBitmap), so the in-app capture tier shows the shared picture rather than a
 *    black hole where a SurfaceView's separate layer would be.
 *
 * EglRenderer is org.webrtc's own renderer core (SurfaceViewRenderer wraps the same class); it
 * draws into whatever EGL surface it is given, here the TextureView's SurfaceTexture.
 */
class ShareVideoView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener, VideoSink {
    private val renderer = EglRenderer("st-screen-share")
    @Volatile private var frameW = 0
    @Volatile private var frameH = 0
    @Volatile private var released = false

    /** Main thread: the video's (rotated) size changed — letterbox to it. */
    var onFrameSize: ((Int, Int) -> Unit)? = null

    init { surfaceTextureListener = this; isOpaque = false }

    fun init(egl: EglBase.Context) {
        renderer.init(egl, EglBase.CONFIG_PLAIN, GlRectDrawer())
        if (isAvailable) surfaceTexture?.let { renderer.createEglSurface(it) }
    }

    override fun onFrame(frame: VideoFrame) {
        if (released) return
        val w = frame.rotatedWidth; val h = frame.rotatedHeight
        if (w != frameW || h != frameH) {
            frameW = w; frameH = h
            post { if (!released) onFrameSize?.invoke(w, h) }
        }
        renderer.onFrame(frame)
    }

    override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
        if (!released) renderer.createEglSurface(st)
    }

    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {}

    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
        // The EGL surface must be gone before the SurfaceTexture is, or the render thread draws into
        // a released buffer.
        val done = CountDownLatch(1)
        try { renderer.releaseEglSurface { done.countDown() } } catch (_: Throwable) { done.countDown() }
        try { done.await(1, TimeUnit.SECONDS) } catch (_: Throwable) {}
        return true
    }

    override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}

    fun release() {
        if (released) return
        released = true
        try { renderer.release() } catch (_: Throwable) {}
    }

}
