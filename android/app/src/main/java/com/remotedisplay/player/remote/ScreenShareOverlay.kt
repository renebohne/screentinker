package com.remotedisplay.player.remote

import android.app.Activity
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.remotedisplay.player.R
import org.webrtc.EglBase
import org.webrtc.VideoTrack

/**
 * 3.0 screen share — what the Android player SHOWS (the receiver is ScreenShareReceiver). The same
 * picture the web player draws (server/lib/screen-share-player.js):
 *
 *  - the share fullscreen over the (ducked) content, letterboxed on black, "Connecting to …" until
 *    the first frame, and a small "Shared by <name>" badge bottom-left (" · guest" for a guest);
 *  - the meeting-room code bottom-right — QR, "Share your screen here", the address, the code —
 *    hidden while a share is on screen.
 *
 * Lives in [parent] (MainActivity's pipLayout), so it turns with the panel's orientation and is in
 * the remote-view capture (ShareVideoView is a TextureView; ScreenshotCapture composites those).
 * The name is only ever set with TextView.setText — it is whatever a guest typed.
 */
class ScreenShareOverlay(private val activity: Activity, private val parent: FrameLayout) : ScreenShareBus.Listener {
    companion object { const val TAG = "st-share-overlay" }

    private var sessionId: String? = null
    private var container: FrameLayout? = null
    private var video: ShareVideoView? = null
    private var wait: TextView? = null
    private var track: VideoTrack? = null
    private var codeView: LinearLayout? = null
    private var code: ScreenShareProtocol.Code? = null

    private fun vw(pct: Float): Float = parent.width.takeIf { it > 0 }?.let { it * pct / 100f }
        ?: (activity.resources.displayMetrics.widthPixels * pct / 100f)
    private fun sp(min: Float, pct: Float): Float = maxOf(min * activity.resources.displayMetrics.scaledDensity, vw(pct))

    fun attach() { ScreenShareBus.listener = this }

    fun detach() {
        if (ScreenShareBus.listener === this) ScreenShareBus.listener = null
        sessionId?.let { onShareEnd(it) }
        codeView?.let { try { parent.removeView(it) } catch (_: Throwable) {} }
        codeView = null
    }

    // ------------------------------------------------------------------------------ the share
    override fun onShareStart(start: ScreenShareProtocol.Start) {
        sessionId?.let { onShareEnd(it) }   // replaced
        sessionId = start.sessionId
        val c = FrameLayout(activity).apply {
            setBackgroundColor(Color.BLACK)
            translationZ = 10_000f            // above the PiP and trigger layers sharing pipLayout
            tag = TAG                         // ScreenshotCapture.drawScreenShare finds it by this
            isClickable = false
        }
        val v = ShareVideoView(activity).apply { visibility = View.INVISIBLE }
        c.addView(v, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER))
        val w = TextView(activity).apply {
            setTextColor(Color.rgb(0xcb, 0xd5, 0xe1))
            setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(16f, 2.2f))
            gravity = Gravity.CENTER
            text = ScreenShareProtocol.fmt(activity.getString(R.string.screen_share_connecting), start.sharedBy)
        }
        c.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        val pad = vw(0.9f).toInt()
        val badge = TextView(activity).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(12f, 1.05f))
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
            setSingleLine(true); ellipsize = TextUtils.TruncateAt.END
            maxWidth = vw(60f).toInt()
            setPadding(pad, pad / 2, pad, pad / 2)
            background = GradientDrawable().apply { setColor(Color.argb(184, 15, 23, 42)); cornerRadius = vw(0.5f) }
            text = ScreenShareProtocol.badgeText(activity.getString(R.string.screen_share_shared_by),
                activity.getString(R.string.screen_share_guest), start.sharedBy, start.guest)
        }
        val margin = vw(1.2f).toInt()
        c.addView(badge, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM or Gravity.START).apply { setMargins(margin, margin, margin, margin) })
        parent.addView(c, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        c.bringToFront()
        v.onFrameSize = { fw, fh ->
            val (bw, bh) = ScreenShareProtocol.fit(c.width, c.height, fw, fh)
            v.layoutParams = FrameLayout.LayoutParams(bw, bh, Gravity.CENTER)
            v.visibility = View.VISIBLE
            w.visibility = View.GONE
        }
        container = c; video = v; wait = w
        paintCode()
    }

    override fun onShareTrack(sessionId: String, track: VideoTrack, egl: EglBase.Context) {
        if (sessionId != this.sessionId) return
        val v = video ?: return
        try {
            v.init(egl)
            track.addSink(v)
            this.track = track
        } catch (_: Throwable) {}
    }

    override fun onShareEnd(sessionId: String) {
        if (sessionId != this.sessionId) return
        this.sessionId = null
        // Order matters: stop frames, drop the surface (releases the EGL surface), then the renderer.
        try { video?.let { track?.removeSink(it) } } catch (_: Throwable) {}
        track = null
        container?.let { try { parent.removeView(it) } catch (_: Throwable) {} }
        video?.release()
        container = null; video = null; wait = null
        paintCode()
    }

    // ------------------------------------------------------------------------------ the code
    override fun onCode(code: ScreenShareProtocol.Code?) {
        this.code = code
        paintCode()
    }

    private fun paintCode() {
        val c = code
        if (c == null || sessionId != null) { codeView?.visibility = View.GONE; return }
        val view = codeView ?: buildCodeView().also { codeView = it }
        val img = view.getChildAt(0) as ImageView
        val bmp = c.qrPngBase64?.let {
            try { Base64.decode(it, Base64.DEFAULT).let { b -> BitmapFactory.decodeByteArray(b, 0, b.size) } } catch (_: Throwable) { null }
        }
        if (bmp != null) { img.setImageBitmap(bmp); img.visibility = View.VISIBLE } else { img.setImageDrawable(null); img.visibility = View.GONE }
        val texts = view.getChildAt(1) as LinearLayout
        (texts.getChildAt(0) as TextView).text = activity.getString(R.string.screen_share_code_title)
        (texts.getChildAt(1) as TextView).text = activity.getString(R.string.screen_share_code_hint).replace("{url}", c.shownUrl)
        (texts.getChildAt(2) as TextView).text = c.code
        view.visibility = View.VISIBLE
        view.bringToFront()
    }

    private fun buildCodeView(): LinearLayout {
        val pad = vw(1f).toInt()
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply { setColor(Color.argb(209, 15, 23, 42)); cornerRadius = vw(0.8f) }
            translationZ = 9_000f
        }
        val qrSize = maxOf((84 * activity.resources.displayMetrics.density).toInt(), vw(7f).toInt())
        box.addView(ImageView(activity).apply {
            setBackgroundColor(Color.WHITE)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }, LinearLayout.LayoutParams(qrSize, qrSize).apply { marginEnd = vw(0.9f).toInt() })
        val base = sp(12f, 1f)
        val texts = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(TextView(activity).apply { setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_PX, base * 1.1f); setTypeface(typeface, Typeface.BOLD) })
        texts.addView(TextView(activity).apply { setTextColor(Color.argb(217, 255, 255, 255)); setTextSize(TypedValue.COMPLEX_UNIT_PX, base) })
        texts.addView(TextView(activity).apply {
            setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_PX, base * 1.9f)
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD); letterSpacing = 0.08f
        })
        box.addView(texts)
        val margin = vw(1.2f).toInt()
        parent.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM or Gravity.END).apply { setMargins(margin, margin, margin, margin) })
        return box
    }
}
