package com.screentinker.manager.share

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.screentinker.manager.R
import com.screentinker.manager.ServerStore

/**
 * "Share my screen" — the phone's screen on a ScreenTinker screen, WITHOUT an account (docs/
 * screen-share.md, "Android app"). Reached from:
 *   - the QR on a meeting-room screen (https://<server>/share?code=…, if the person picks this app),
 *   - the /share page's "Share my screen with the ScreenTinker app" (screentinker://share?…),
 *   - "Share my screen to a meeting-room screen" on the app's first screen, the launcher shortcut, and
 *     the in-app Simple view (signed in: the person picked screens; [EXTRA_TOKEN]).
 *
 * The server comes from the link or what the person typed, never from a saved account, so it is
 * validated (ShareLink: http/https, a real host, shown in ASCII) and SHOWN — "Share your screen to
 * <host>?" — before anything is captured. Nothing starts without that tap, then Android's own
 * capture prompt. The code is spent only after both.
 */
class GuestShareActivity : ComponentActivity() {

    private lateinit var body: LinearLayout
    private var target: ShareLink.Target? = null
    private var signedIn: SignedIn? = null
    private var message: String? = null
    private var unlisten: (() -> Unit)? = null
    private var pendingName = ""
    private var pendingCode: String? = null
    private var prefillOrigin: String? = null

    private data class SignedIn(val origin: String, val token: String, val deviceIds: ArrayList<String>, val label: String)

    private val capture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val data = res.data
        if (res.resultCode != Activity.RESULT_OK || data == null) { message = getString(R.string.gs_denied); render(); return@registerForActivityResult }
        startShare(data)
    }
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { askCapture() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val scroll = ScrollView(this).apply { setBackgroundColor(ContextCompat.getColor(context, R.color.bg)); isFillViewport = true }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(32), dp(24), dp(24)) }
        scroll.addView(body)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(scroll)
        readIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        unlisten = ShareStatus.listen { s ->
            if (s.ended != null) {
                message = endText(s.ended)
                ShareStatus.consumeEnded()
                // The code was spent (or refused): the next try needs the one on screen now.
                target = target?.copy(code = null)
            }
            render()
        }
    }

    override fun onStop() {
        unlisten?.invoke(); unlisten = null
        super.onStop()
    }

    private fun readIntent(i: Intent?) {
        message = null
        signedIn = null
        val token = i?.getStringExtra(EXTRA_TOKEN)
        val origin = i?.getStringExtra(EXTRA_ORIGIN)?.let { ShareLink.normaliseOrigin(it) }
        val devices = i?.getStringArrayListExtra(EXTRA_DEVICES)
        if (token != null && origin != null && !devices.isNullOrEmpty()) {
            signedIn = SignedIn(origin, token, devices, i.getStringExtra(EXTRA_LABEL) ?: "")
            target = ShareLink.Target(origin, ShareLink.displayHost(origin), null)
        } else if (i?.data != null) {
            target = ShareLink.parse(i.data.toString())
            if (target == null) message = getString(R.string.gs_bad_link)
            i.data = null   // consumed: a rotation must not replay it
        } else if (origin != null) {
            // Opened for a server (the Simple view, Change server): its address is filled in.
            target = null
            prefillOrigin = origin
        }
        render()
    }

    // ---------------------------------------------------------------- the screens

    private fun render() {
        body.removeAllViews()
        val st = ShareStatus.current
        when {
            st.active -> renderLive(st)
            target != null -> renderConfirm(target!!)
            else -> renderEntry()
        }
    }

    private fun renderEntry() {
        title(getString(R.string.gs_title))
        lead(getString(R.string.gs_entry_lead))
        messageView()
        button(getString(R.string.gs_scan), primary = true) { scan() }
        section(getString(R.string.gs_or_type))
        val address = input(getString(R.string.gs_address_hint), InputType.TYPE_TEXT_VARIATION_URI)
        address.setText(prefillOrigin ?: ServerStore.get(this) ?: "")
        val code = input(getString(R.string.gs_code_hint), InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        code.filters = arrayOf(InputFilter.LengthFilter(12), InputFilter.AllCaps())
        button(getString(R.string.gs_continue)) {
            val origin = ShareLink.normaliseOrigin(address.text.toString(), typed = true)
            val c = ShareLink.normaliseCode(code.text.toString())
            message = when { origin == null -> getString(R.string.gs_bad_address); c == null -> getString(R.string.gs_bad_code); else -> null }
            if (origin != null && c != null) target = ShareLink.Target(origin, ShareLink.displayHost(origin), c)
            render()
        }
    }

    private fun renderConfirm(t: ShareLink.Target) {
        val si = signedIn
        title(getString(R.string.gs_confirm_title))
        // The host, big and plain: this is where the screen will go.
        body.addView(TextView(this).apply {
            text = t.host
            textSize = 26f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(ContextCompat.getColor(context, R.color.accent))
            setPadding(0, dp(4), 0, dp(12))
            contentDescription = t.host
        })
        if (si != null) lead(getString(R.string.gs_confirm_screens, si.label))
        messageView()
        var codeField: EditText? = null
        if (si == null) {
            if (t.code != null) lead(getString(R.string.gs_confirm_code, t.displayCode))
            else codeField = input(getString(R.string.gs_code_hint), InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS).apply {
                filters = arrayOf(InputFilter.LengthFilter(12), InputFilter.AllCaps())
            }
        }
        val name = if (si == null) input(getString(R.string.gs_name_hint), InputType.TYPE_TEXT_VARIATION_PERSON_NAME).apply {
            filters = arrayOf(InputFilter.LengthFilter(40))
            setText(prefs().getString("name", "") ?: "")
        } else null
        lead(getString(R.string.gs_confirm_explain))
        button(getString(R.string.gs_share), primary = true) {
            val code = t.code ?: ShareLink.normaliseCode(codeField?.text?.toString())
            if (si == null && code == null) { message = getString(R.string.gs_bad_code); render(); return@button }
            pendingCode = code
            pendingName = name?.text?.toString()?.trim() ?: ""
            prefs().edit().putString("name", pendingName).apply()
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else askCapture()
        }
        button(getString(R.string.cancel)) { target = null; signedIn = null; message = null; if (si != null) finish() else render() }
    }

    private fun renderLive(s: ShareStatus.Snapshot) {
        title(getString(R.string.gs_live_title, s.screenName.ifEmpty { s.host }))
        lead(when {
            s.state == "live" && s.total > 1 -> getString(R.string.gs_state_live_n, s.live, s.total)
            s.state == "live" -> getString(R.string.gs_state_live)
            s.state == "negotiating" -> getString(R.string.gs_state_negotiating)
            s.state == "joining" -> getString(R.string.gs_state_joining)
            else -> getString(R.string.gs_state_connecting)
        })
        s.notice?.let { (screen, reason) ->
            lead(if (reason == "single_presenter") getString(R.string.gs_notice_single, screen.ifEmpty { s.host }) else getString(R.string.gs_notice_skipped, screen.ifEmpty { s.host }))
        }
        button(getString(R.string.gs_stop), primary = true) { ShareService.stop(this) }
    }

    // ---------------------------------------------------------------- actions

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        val scanner = GmsBarcodeScanning.getClient(this, options)
        // Play services fetches the scanner module on first use; ask for it so the first scan works.
        try { ModuleInstall.getClient(this).installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build()) } catch (_: Exception) {}
        scanner.startScan()
            .addOnSuccessListener { code ->
                val t = ShareLink.parse(code.rawValue)
                if (t == null) { message = getString(R.string.gs_bad_link); target = null } else { message = null; target = t }
                render()
            }
            .addOnCanceledListener { }
            .addOnFailureListener { message = getString(R.string.gs_scan_unavailable); render() }
    }

    private fun askCapture() {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        try { capture.launch(mpm.createScreenCaptureIntent()) }
        catch (e: Exception) { message = getString(R.string.gs_end_capture); render() }
    }

    private fun startShare(projection: Intent) {
        val t = target ?: return
        val si = signedIn
        val i = Intent(this, ShareService::class.java).setAction(ShareService.ACTION_START)
            .putExtra(ShareService.EXTRA_PROJECTION, projection)
            .putExtra(ShareService.EXTRA_ORIGIN, t.origin)
        if (si != null) i.putExtra(ShareService.EXTRA_TOKEN, si.token).putStringArrayListExtra(ShareService.EXTRA_DEVICES, si.deviceIds)
        else i.putExtra(ShareService.EXTRA_CODE, pendingCode).putExtra(ShareService.EXTRA_NAME, pendingName)
        message = null
        ContextCompat.startForegroundService(this, i)
    }

    private fun endText(reason: String): String = when (reason) {
        "stopped_by_sharer" -> getString(R.string.gs_end_stopped)
        "invalid_code" -> getString(R.string.gs_end_invalid_code)
        "busy" -> getString(R.string.gs_end_busy)
        "slow_down" -> getString(R.string.gs_end_slow_down)
        "offline", "screen_offline", "screen_left" -> getString(R.string.gs_end_offline)
        "unsupported", "screen_unsupported" -> getString(R.string.gs_end_unsupported)
        "disabled", "workspace_disabled", "disabled_by_admin" -> getString(R.string.gs_end_disabled)
        "removed" -> getString(R.string.gs_end_removed)
        "stopped_by_owner" -> getString(R.string.gs_end_owner)
        "max_duration" -> getString(R.string.gs_end_max)
        "connection_failed" -> getString(R.string.gs_end_failed)
        "screen_unreachable", "not_connected" -> getString(R.string.gs_end_unreachable)
        "signalling_failed", "signalling_closed" -> getString(R.string.gs_end_network, target?.host ?: "")
        "capture_failed" -> getString(R.string.gs_end_capture)
        else -> getString(R.string.gs_end_generic)
    }

    // ---------------------------------------------------------------- small view helpers

    private fun prefs() = getSharedPreferences("guest_share", Context.MODE_PRIVATE)
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun title(text: String) = body.addView(TextView(this).apply {
        this.text = text; textSize = 22f; setTypeface(typeface, Typeface.BOLD)
        setTextColor(ContextCompat.getColor(context, R.color.text)); setPadding(0, 0, 0, dp(8))
    })

    private fun lead(text: String) = body.addView(TextView(this).apply {
        this.text = text; textSize = 15f
        setTextColor(ContextCompat.getColor(context, R.color.text_secondary)); setPadding(0, dp(4), 0, dp(12))
    })

    private fun section(text: String) = body.addView(TextView(this).apply {
        this.text = text; textSize = 15f; setTypeface(typeface, Typeface.BOLD)
        setTextColor(ContextCompat.getColor(context, R.color.text)); setPadding(0, dp(24), 0, dp(8))
    })

    private fun messageView() {
        val m = message ?: return
        body.addView(TextView(this).apply {
            text = m; textSize = 15f; setTextColor(0xFFF87171.toInt()); setPadding(0, dp(4), 0, dp(12))
        })
    }

    private fun input(hint: String, type: Int): EditText {
        val e = EditText(this).apply {
            this.hint = hint
            inputType = InputType.TYPE_CLASS_TEXT or type
            background = ContextCompat.getDrawable(context, R.drawable.input_bg)
            setTextColor(ContextCompat.getColor(context, R.color.text))
            setHintTextColor(ContextCompat.getColor(context, R.color.text_secondary))
            setPadding(dp(14), 0, dp(14), 0)
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        body.addView(e, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { bottomMargin = dp(10) })
        return e
    }

    private fun button(text: String, primary: Boolean = false, onClick: () -> Unit): Button {
        val b = Button(this).apply {
            this.text = text; isAllCaps = false; textSize = 16f; gravity = Gravity.CENTER
            if (primary) { background = ContextCompat.getDrawable(context, R.drawable.button_bg); setTextColor(0xFFFFFFFF.toInt()) }
            else setTextColor(ContextCompat.getColor(context, R.color.text))
            setOnClickListener { onClick() }
        }
        body.addView(b, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(8) })
        return b
    }

    companion object {
        const val EXTRA_ORIGIN = "origin"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_DEVICES = "devices"
        const val EXTRA_LABEL = "label"
    }
}
