package com.remotedisplay.player.trigger

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * The one place the trigger stack is assembled: transports -> resolver -> state machine -> overlay.
 *
 * ⚠️ Until this existed, every piece was written and NONE of it was reachable — nothing in the app
 * constructed TriggerListeners or TriggerController, and nothing consumed `triggers` from the device
 * payload. Four files of tested code that could not fire. Keeping the assembly in one class is what
 * stops that recurring: if this is not constructed, the feature is visibly absent rather than
 * quietly inert.
 *
 * Mirrors handleTrigger + the arbitration block in server/player/index.html. The transports do not
 * resolve and the resolver does not render — one handler, one decision, one renderer.
 */
class TriggerManager(
    private val overlay: TriggerRenderer,
    private val log: (level: String, message: String) -> Unit = { _, _ -> }
) {
    /** Read-only view of what this device currently holds — the state an installer asks about. */
    var triggers: List<TriggerResolve.Trigger> = emptyList()
        private set
    private var secret: String = ""
    private var clearAllToken: String? = null
    private val limiter = TriggerResolve.RateLimiter()
    private var listeners: TriggerListeners? = null

    private val controller = TriggerController(
        show = { t -> if (!overlay.show(t)) log("warn", "\"${t.name}\" rendered nothing") },
        hide = { overlay.hide() }
    )

    /** Counters an installer reads. Same closed set as the web player's. */
    var received = 0; private set
    var accepted = 0; private set
    val rejected = HashMap<String, Int>()
    var lastDatagramAt: Long = 0; private set

    /**
     * Adopt a device payload. Safe to call on every playlist-update: the listeners are only
     * (re)started when the transport configuration actually changes, so a routine refresh does not
     * churn a bound socket.
     */
    fun onPayload(payload: JSONObject) {
        val cfg = payload.optJSONObject("trigger_config")
        val newSecret = cfg?.optString("secret") ?: ""
        val acceptHttp = cfg?.optBoolean("accept_http") ?: false
        val acceptUdp = cfg?.optBoolean("accept_udp") ?: false
        val httpPort = cfg?.optInt("http_port")?.takeIf { it > 0 }
        val udpPort = cfg?.optInt("udp_port")?.takeIf { it > 0 }
        val group = cfg?.optString("multicast_group")?.takeIf { it.isNotEmpty() }

        secret = newSecret
        clearAllToken = cfg?.optString("clear_all_token")?.takeIf { it.isNotEmpty() }
        triggers = parseTriggers(payload.optJSONArray("triggers"))

        val want = "$acceptHttp/$acceptUdp/$httpPort/$udpPort/$group"
        if (want != startedWith) {
            listeners?.stop()
            listeners = null
            if (acceptHttp || acceptUdp) {
                val l = TriggerListeners(
                    onPayload = { text, source, ip -> handle(text, source, ip) },
                    onState = { }
                )
                l.start(acceptHttp, acceptUdp, httpPort, udpPort, group)
                listeners = l
            }
            startedWith = want
            log("info", "trigger listeners: http=$acceptHttp udp=$acceptUdp")
        }
    }
    private var startedWith: String? = null

    /**
     * ⚠️ THE ONE HANDLER. Both transports arrive here and neither has logic of its own; if either
     * grew its own resolution the two doors would drift and only one would get the next fix.
     */
    fun handle(text: String, source: String, sourceIp: String): TriggerResolve.Verdict {
        received++
        // ⚠️ Stamped even when rejected. A recent timestamp with zero accepts means packets are
        // arriving and the secret is wrong; null means nothing is arriving and it is the network.
        // Counting only successes destroys the single distinction an installer needs.
        lastDatagramAt = System.currentTimeMillis()

        if (!limiter.allow(sourceIp, lastDatagramAt)) {
            bump("rate_limited")
            return TriggerResolve.Verdict(false, reason = TriggerResolve.Reason.MALFORMED)
        }
        val v = TriggerResolve.evaluate(text, triggers, secret, clearAllToken, source)
        if (!v.ok) { bump(v.reason?.toString() ?: "unknown"); return v }
        accepted++
        try { controller.onVerdict(v, source) } catch (e: Throwable) {
            log("warn", "trigger handling failed: ${e.message}")
        }
        return v
    }

    fun sweep() = controller.sweep()
    fun stop() { listeners?.stop(); listeners = null; controller.stop("shutting down") }

    private fun bump(k: String) { rejected[k] = (rejected[k] ?: 0) + 1 }

    private fun parseTriggers(arr: JSONArray?): List<TriggerResolve.Trigger> {
        val out = ArrayList<TriggerResolve.Trigger>()
        for (i in 0 until (arr?.length() ?: 0)) {
            val o = arr?.optJSONObject(i) ?: continue
            val items = ArrayList<Any>()
            val ia = o.optJSONArray("items")
            for (k in 0 until (ia?.length() ?: 0)) ia?.optJSONObject(k)?.let { items.add(it) }
            out.add(TriggerResolve.Trigger(
                id = o.optString("id"),
                name = o.optString("name"),
                matchToken = o.optString("match_token"),
                clearToken = o.optString("clear_token").takeIf { it.isNotEmpty() },
                sourceHttp = o.optBoolean("source_http", true),
                sourceUdp = o.optBoolean("source_udp", false),
                mode = o.optString("mode", "until_cleared"),
                priority = o.optInt("priority", 0),
                maxDurationSec = o.optInt("max_duration_sec", 0),
                leaseSec = if (o.isNull("lease_sec")) null else o.optInt("lease_sec"),
                items = items
            ))
        }
        return out
    }

    companion object { private const val TAG = "TriggerManager" }
}
