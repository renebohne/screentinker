package com.remotedisplay.player.trigger

/**
 * Trigger wire parsing and token resolution — the decision half of the fire path.
 * See docs/triggers-design.md and shared/trigger-vectors.json.
 *
 * ⚠️ THIS IS A SECOND IMPLEMENTATION OF A SECURITY DECISION. The JS player has the other one
 * (server/lib/trigger-resolve.js), and two of these in two languages WILL drift — silently, and in
 * a direction that matters: one player accepting a payload the other refuses is a hole nobody sees
 * until it is used. The shared vector file is the contract and TriggerResolveTest holds this file
 * to it, exactly as ScheduleEval is held to shared/schedule-vectors.json. If this disagrees with a
 * vector, this is wrong.
 *
 * ⚠️ Nothing here touches the network or a View. Both transports parse with parseWire(), decide with
 * evaluate(), and only then render. One decision, two doors.
 */
object TriggerResolve {

    /** `ST1 <secret> <token>` — one line, ASCII, and nothing else. */
    const val MAGIC = "ST1"
    const val MAX_BYTES = 512

    /** Printable ASCII, no space, 1-64. Mirrors TOKEN_RE in the JS module and the server validator. */
    private val TOKEN_RE = Regex("^[\\x21-\\x7E]{1,64}$")

    data class Trigger(
        val id: String,
        val name: String,
        val matchToken: String,
        val clearToken: String?,
        val sourceHttp: Boolean,
        val sourceUdp: Boolean,
        val mode: String,
        val priority: Int = 0,
        val maxDurationSec: Int = 0,
        val leaseSec: Int? = null,
        /** Resolved playlist items, carried inline — a device cannot resolve a playlist id offline. */
        val items: List<Any> = emptyList()
    )

    /** A closed set: these are the counters an installer reads. */
    enum class Reason { BAD_MAGIC, MALFORMED, TOO_LARGE, BAD_SECRET, UNKNOWN_TOKEN;
        override fun toString() = name.lowercase()
    }

    enum class Action { FIRE, CLEAR, CLEAR_ALL;
        override fun toString() = name.lowercase()
    }

    data class Parsed(val ok: Boolean, val secret: String? = null, val token: String? = null,
                      val reason: Reason? = null)

    data class Verdict(val ok: Boolean, val action: Action? = null, val trigger: Trigger? = null,
                       val reason: Reason? = null)

    /**
     * ⚠️ THE MAGIC IS CHECKED FIRST AND CHEAPLY. On subnet broadcast this socket sees every stray
     * datagram on the LAN — mDNS, discovery chatter, a printer announcing itself. Rejecting on a
     * 3-byte compare before any splitting keeps that free, and keeps BAD_MAGIC meaningful: it says
     * "the network is noisy", not "something is talking to us and getting it wrong".
     */
    @JvmStatic
    fun parseWire(text: String?): Parsed {
        if (text == null) return Parsed(false, reason = Reason.MALFORMED)
        // Byte length, not character length: the cap exists to bound work per datagram.
        if (text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return Parsed(false, reason = Reason.TOO_LARGE)

        val line = text.trimEnd('\r', '\n')
        if (!line.startsWith(MAGIC)) return Parsed(false, reason = Reason.BAD_MAGIC)

        // Exactly three fields. Fewer is truncated or missing a secret; more means a token contained
        // a space, which the editor refuses at save time precisely so it cannot happen here.
        val parts = line.split(" ")
        if (parts.size != 3) return Parsed(false, reason = Reason.MALFORMED)
        val secret = parts[1]
        val token = parts[2]
        if (secret.isEmpty() || !TOKEN_RE.matches(token)) return Parsed(false, reason = Reason.MALFORMED)
        return Parsed(true, secret, token)
    }

    /**
     * ⚠️ Length-checked compare. Not because a timing attack is the threat — the secret crosses an
     * unauthenticated LAN in cleartext, so anyone positioned to time it can simply read it — but
     * because comparing a 4-byte string to a 64-byte one should cost the same either way.
     */
    @JvmStatic
    fun secretMatches(given: String?, expected: String?): Boolean {
        if (given == null || expected == null) return false
        if (given.length != expected.length) return false
        var diff = 0
        for (i in given.indices) diff = diff or (given[i].code xor expected[i].code)
        return diff == 0
    }

    /**
     * What should happen, given a payload and the triggers this device actually holds.
     *
     * @param triggers the SYNCED, DEVICE-SCOPED list. Scoping happened on the server at sync time,
     *   so a token that is real on another screen is simply unknown here.
     * @param source "http" or "udp".
     */
    @JvmStatic
    fun evaluate(
        text: String?,
        triggers: List<Trigger>,
        deviceSecret: String?,
        clearAllToken: String?,
        source: String
    ): Verdict {
        val parsed = parseWire(text)
        if (!parsed.ok) return Verdict(false, reason = parsed.reason)

        if (deviceSecret.isNullOrEmpty() || !secretMatches(parsed.secret, deviceSecret)) {
            return Verdict(false, reason = Reason.BAD_SECRET)
        }

        // Checked before per-trigger tokens, so a device-level stop cannot be shadowed by a trigger
        // that happens to use the same token.
        if (!clearAllToken.isNullOrEmpty() && parsed.token == clearAllToken) {
            return Verdict(true, Action.CLEAR_ALL)
        }

        for (t in triggers) {
            /*
             * ⚠️ THE TRANSPORT GATE IS PER TRIGGER, not just per device. An operator who enables
             * only UDP on an emergency trigger has said something specific: it is fired by the panel
             * wired to the alarm, not by anything that can reach the box over HTTP. Honouring the
             * device flag alone would quietly widen that.
             */
            val accepts = if (source == "udp") t.sourceUdp else t.sourceHttp
            if (!accepts) continue
            if (t.matchToken.isNotEmpty() && parsed.token == t.matchToken) return Verdict(true, Action.FIRE, t)
            if (!t.clearToken.isNullOrEmpty() && parsed.token == t.clearToken) return Verdict(true, Action.CLEAR, t)
        }
        return Verdict(false, reason = Reason.UNKNOWN_TOKEN)
    }
}
