package com.screentinker.manager

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import androidx.browser.customtabs.CustomTabsIntent

/**
 * window.STManager, for the dashboard's Simple view (frontend/js/utils.js inManagerApp/openOutsideApp).
 * Deliberately tiny: it can open a page OF THIS SERVER in the browser, start "Change server", and say
 * its version. Nothing reads data, so a page that somehow got into the WebView gains nothing here.
 */
class ManagerBridge(private val activity: Activity, private val origin: String) {

    @JavascriptInterface
    fun openInBrowser(url: String) {
        val uri = Uri.parse(url)
        if (!ServerStore.sameOrigin(origin, uri)) return
        activity.runOnUiThread { openInCustomTab(activity, uri) }
    }

    /** Single sign-on in the phone's browser; the session comes back through SsoHandoff. */
    @JavascriptInterface
    fun startSso(path: String) {
        val url = SsoHandoff.start(activity, origin, path) ?: return
        activity.runOnUiThread { openInCustomTab(activity, url) }
    }

    @JavascriptInterface
    fun changeServer() {
        activity.runOnUiThread {
            activity.startActivity(Intent(activity, ServerActivity::class.java))
        }
    }

    /** Android's share sheet (WhatsApp, Messages, email...) for a short text such as an invite link. */
    @JavascriptInterface
    fun shareText(text: String) {
        if (text.length > 2000) return
        activity.runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            activity.startActivity(Intent.createChooser(send, null))
        }
    }

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    /*
     * 3.0 "Share my screen" from the Simple view (a WebView cannot capture the screen: no
     * getDisplayMedia on Android). The page passes the screens the person picked and its own session
     * token; the app shows "Share your screen to <this server>?", asks Android for the capture, and
     * starts the share itself (POST /api/screen-share/shares, the same request the browser makes).
     * The token goes only to THIS server (the bridge's origin), never to an address the page names.
     */
    @JavascriptInterface
    fun shareScreenTo(deviceIdsJson: String, label: String, token: String) {
        if (token.isBlank() || token.length > 4096 || deviceIdsJson.length > 8192) return
        val ids = try {
            val arr = org.json.JSONArray(deviceIdsJson)
            ArrayList((0 until arr.length()).map { arr.optString(it) }.filter { Regex("^[A-Za-z0-9_-]{1,128}$").matches(it) }.take(50))
        } catch (e: Exception) { return }
        if (ids.isEmpty()) return
        activity.runOnUiThread {
            activity.startActivity(Intent(activity, com.screentinker.manager.share.GuestShareActivity::class.java)
                .putExtra(com.screentinker.manager.share.GuestShareActivity.EXTRA_ORIGIN, origin)
                .putExtra(com.screentinker.manager.share.GuestShareActivity.EXTRA_TOKEN, token)
                .putExtra(com.screentinker.manager.share.GuestShareActivity.EXTRA_LABEL, label.take(200))
                .putStringArrayListExtra(com.screentinker.manager.share.GuestShareActivity.EXTRA_DEVICES, ids))
        }
    }

    /** The no-account share (a meeting-room code), with this server's address filled in. */
    @JavascriptInterface
    fun shareWithCode() {
        activity.runOnUiThread {
            activity.startActivity(Intent(activity, com.screentinker.manager.share.GuestShareActivity::class.java)
                .putExtra(com.screentinker.manager.share.GuestShareActivity.EXTRA_ORIGIN, origin))
        }
    }

    /** What this app can do with a screen share, so the page offers only that ("screen"). */
    @JavascriptInterface
    fun shareCapabilities(): String = "screen"

    companion object {
        fun openInCustomTab(activity: Activity, uri: Uri) {
            try {
                CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, uri)
            } catch (e: Exception) {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
        }
    }
}
