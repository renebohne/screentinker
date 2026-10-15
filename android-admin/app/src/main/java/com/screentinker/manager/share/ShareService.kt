package com.screentinker.manager.share

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.IntentCompat
import com.screentinker.manager.R

/**
 * The foreground service that holds a phone screen share (Android requires one, of type
 * mediaProjection, for as long as the screen is captured). Its notification says where the screen is
 * going and has Stop; the status-bar capture chip of Android 15+ stops it too (ScreenShareSession's
 * MediaProjection callback). Nothing else in the app keeps the capture alive: when this service goes,
 * the share goes.
 */
class ShareService : Service() {

    private var session: ScreenShareSession? = null
    private var host = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { session?.stop() ?: stopSelf(); return START_NOT_STICKY }
            ACTION_START -> start(intent)
        }
        return START_NOT_STICKY
    }

    private fun start(intent: Intent) {
        if (session != null) return
        val data = IntentCompat.getParcelableExtra(intent, EXTRA_PROJECTION, Intent::class.java)
        val origin = intent.getStringExtra(EXTRA_ORIGIN)
        if (data == null || origin == null) { stopSelf(); return }
        host = ShareLink.displayHost(origin)
        // Foreground FIRST (Android 14 refuses a projection without a running mediaProjection service).
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(getString(R.string.gs_notif_connecting)), type)
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed", e)
            ShareStatus.ended("capture_failed")
            stopSelf()
            return
        }
        val start: ScreenShareSession.Start = intent.getStringExtra(EXTRA_TOKEN)?.let { token ->
            ScreenShareSession.Start.SignedIn(origin, token, intent.getStringArrayListExtra(EXTRA_DEVICES) ?: arrayListOf())
        } ?: ScreenShareSession.Start.Guest(origin, intent.getStringExtra(EXTRA_CODE) ?: "", intent.getStringExtra(EXTRA_NAME) ?: "")
        ShareStatus.started(host)
        val s = ScreenShareSession(applicationContext, data, start, object : ScreenShareSession.Listener {
            override fun onState(state: String, screenName: String, live: Int, total: Int) {
                ShareStatus.state(state, screenName, live, total)
                val text = when (state) {
                    "live" -> getString(R.string.gs_notif_live, screenName.ifEmpty { host })
                    "joining" -> getString(R.string.gs_notif_connecting)
                    else -> getString(R.string.gs_notif_connecting_to, screenName.ifEmpty { host })
                }
                notify(text)
            }
            override fun onNotice(screenName: String, reason: String) { ShareStatus.notice(screenName, reason) }
            override fun onEnded(reason: String) {
                session = null
                ShareStatus.ended(reason)
                ServiceCompat.stopForeground(this@ShareService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        })
        session = s
        val (w, h) = screenSize()
        s.begin(w, h)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val (w, h) = screenSize()
        session?.resize(w, h)
    }

    override fun onDestroy() {
        session?.stop()
        session = null
        super.onDestroy()
    }

    private fun screenSize(): Pair<Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.currentWindowMetrics.bounds
            Pair(b.width(), b.height())
        } else {
            val dm = android.util.DisplayMetrics()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(dm)
            Pair(dm.widthPixels, dm.heightPixels)
        }
    }

    private fun notification(text: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.gs_channel), NotificationManager.IMPORTANCE_LOW))
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val stop = PendingIntent.getService(this, 1, Intent(this, ShareService::class.java).setAction(ACTION_STOP), flags)
        val open = PendingIntent.getActivity(this, 2, Intent(this, GuestShareActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentTitle(getString(R.string.gs_notif_title, host))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.gs_stop), stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun notify(text: String) {
        try { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(text)) } catch (_: Exception) {}
    }

    companion object {
        private const val TAG = "STShare"
        const val ACTION_START = "com.screentinker.manager.share.START"
        const val ACTION_STOP = "com.screentinker.manager.share.STOP"
        const val EXTRA_PROJECTION = "projection"
        const val EXTRA_ORIGIN = "origin"
        const val EXTRA_CODE = "code"
        const val EXTRA_NAME = "name"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_DEVICES = "devices"
        private const val CHANNEL = "screen_share"
        private const val NOTIFICATION_ID = 4471

        fun stop(context: Context) {
            context.startService(Intent(context, ShareService::class.java).setAction(ACTION_STOP))
        }
    }
}

/**
 * What the share is doing, for whichever screen of the app is showing (in process; the service is
 * the only writer). Listeners are called on the main thread.
 */
object ShareStatus {
    data class Snapshot(val active: Boolean, val host: String, val state: String, val screenName: String, val live: Int, val total: Int,
                        val ended: String?, val notice: Pair<String, String>?)

    @Volatile var current = Snapshot(false, "", "", "", 0, 0, null, null); private set
    private val listeners = LinkedHashSet<(Snapshot) -> Unit>()

    fun listen(fn: (Snapshot) -> Unit): () -> Unit { listeners.add(fn); fn(current); return { listeners.remove(fn) } }
    private fun emit(s: Snapshot) { current = s; for (l in listeners.toList()) try { l(s) } catch (_: Throwable) {} }

    fun started(host: String) = emit(Snapshot(true, host, "joining", "", 0, 0, null, null))
    fun state(state: String, screenName: String, live: Int, total: Int) = emit(current.copy(active = true, state = state, screenName = screenName, live = live, total = total, notice = null))
    fun notice(screenName: String, reason: String) = emit(current.copy(notice = Pair(screenName, reason)))
    fun ended(reason: String) = emit(current.copy(active = false, ended = reason, notice = null))
    fun consumeEnded() { if (current.ended != null) current = current.copy(ended = null) }
}
