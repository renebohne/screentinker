package com.remotedisplay.player.trigger

import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The two doors, on Android. See docs/triggers-design.md §3, §10, §13.
 *
 * ⚠️ BOTH CONVERGE ON ONE HANDLER. Neither transport parses, resolves, or decides — they read bytes
 * and hand them to [onPayload], which calls [TriggerResolve]. If a transport ever grows its own
 * resolution the two doors drift and only one of them gets the next security fix.
 *
 * ⚠️ OFF BY DEFAULT, AND SEPARATELY. This opens listening ports on a LAN that change what appears on
 * a screen. UDP is the larger risk of the two and has its own flag: one datagram to a multicast
 * group or a broadcast address reaches EVERY player on the segment at once, which is categorically
 * more than a unicast POST at one host.
 */
class TriggerListeners(
    /**
     * ⚠️ RETURNS THE VERDICT. This used to return Unit, so the HTTP door could only answer "did it
     * parse", not "was it accepted" — and every well-formed request got 200 {"ok":true}, wrong
     * secret included, while the web player answered 400 bad_secret for the same bytes. Returning
     * null is allowed (the UDP path has nobody to answer) and is treated as "no opinion".
     */
    private val onPayload: (text: String, source: String, sourceIp: String) -> TriggerResolve.Verdict?,
    private val onState: (Stats) -> Unit = {}
) {

    data class Stats(
        var httpPort: Int? = null,
        var udpPort: Int? = null,
        var group: String? = null,
        var iface: String? = null,
        var joinedAt: Long? = null,
        var rejoinCount: Int = 0,
        var lastJoinError: String? = null,
        var loopback: String? = null
    )

    val stats = Stats()

    private val running = AtomicBoolean(false)
    private var udp: MulticastSocket? = null
    private var http: ServerSocket? = null
    private var rejoinThread: Thread? = null
    private var joinedIface: NetworkInterface? = null
    private var probeNonce: String? = null

    companion object {
        private const val TAG = "TriggerListeners"
        const val DEFAULT_UDP_PORT = 7847
        const val DEFAULT_HTTP_PORT = 8079
        const val DEFAULT_GROUP = "239.255.42.1"
        private const val PROBE = "ST1-PROBE "

        // The web player's two anchored form-detection regexes, ported verbatim so the two doors
        // classify the same body the same way. See startTriggerHttp in server/player/index.html.
        private val FORM_SHAPE = Regex("^[^=&\\s]+=[^&]*(&|$)")
        private val FORM_TOKEN = Regex("(^|&)token=")

        /**
         * ⚠️ NAMING AN INTERFACE IS NOT OPTIONAL. joinGroup with no interface lets the OS choose, and
         * an Android box with Wi-Fi and Ethernet both up routinely picks the wrong one: the join
         * succeeds, nothing logs, and the group is simply never received — which looks identical to
         * "the integrator never sent anything", the exact confusion the diagnostics exist to remove.
         */
        @JvmStatic
        fun pickInterface(): NetworkInterface? {
            try {
                for (ni in NetworkInterface.getNetworkInterfaces()) {
                    if (!ni.isUp || ni.isLoopback || !ni.supportsMulticast()) continue
                    for (addr in ni.inetAddresses) {
                        if (addr is java.net.Inet4Address && !addr.isLoopbackAddress) return ni
                    }
                }
            } catch (e: Throwable) { Log.w(TAG, "interface scan failed: ${e.message}") }
            return null
        }
    }

    fun start(acceptHttp: Boolean, acceptUdp: Boolean, httpPort: Int?, udpPort: Int?, group: String?) {
        if (!running.compareAndSet(false, true)) return   // idempotent, like the web player's guard
        if (acceptUdp) startUdp(udpPort ?: DEFAULT_UDP_PORT, group ?: DEFAULT_GROUP)
        if (acceptHttp) startHttp(httpPort ?: DEFAULT_HTTP_PORT)
    }

    fun stop() {
        running.set(false)
        try { udp?.close() } catch (e: Throwable) { }
        try { http?.close() } catch (e: Throwable) { }
        udp = null; http = null
        stats.httpPort = null; stats.udpPort = null
    }

    // ───────────────────────────── UDP ─────────────────────────────

    /**
     * ⚠️ ONE SOCKET, THREE ADDRESSING MODES. A MulticastSocket bound to the port receives unicast and
     * subnet broadcast inherently; multicast is that same socket plus joinGroup. Three sockets would
     * be three places to fix the next parsing bug and three chances to disagree about a valid payload.
     */
    private fun startUdp(port: Int, group: String) {
        Thread({
            try {
                val sock = MulticastSocket(null)
                sock.reuseAddress = true                       // survive a restart that has not released it
                sock.bind(InetSocketAddress(port))
                sock.timeToLive = 1                            // a trigger is a LOCAL-site event
                /*
                 * ⚠️ TWO SETTINGS THE JOIN DOES NOT COVER, and the self-test caught both.
                 *
                 * 1. joinGroup() names the interface for MEMBERSHIP only. Outgoing datagrams still
                 *    leave by the default route, so on a box with more than one NIC the probe went
                 *    out one interface while the membership sat on another — and the loopback
                 *    self-test reported FAIL on a working setup. That is worse than no diagnostic:
                 *    it sends an installer to check a switch that is fine.
                 *
                 * 2. ⚠️ setLoopbackMode IS INVERTED — its argument means DISABLE, so `false` turns
                 *    loopback ON. This is DEFENSIVE ONLY and is not what fixed the self-test:
                 *    mutating it out leaves the tests green on this JVM, while mutating out (1)
                 *    fails them. It is kept because the default is platform-dependent and an
                 *    Android device is not this JVM, but it is unproven there — said plainly rather
                 *    than left looking like half of a fix.
                 *
                 * Both are best-effort: a stack that refuses either still receives real traffic, so
                 * failing here must not stop the listener binding.
                 */
                try { pickInterface()?.let { sock.networkInterface = it } } catch (e: Throwable) {
                    Log.w(TAG, "could not set the outgoing multicast interface: ${e.message}")
                }
                try { sock.loopbackMode = false } catch (e: Throwable) {
                    Log.w(TAG, "could not enable multicast loopback: ${e.message}")
                }
                udp = sock
                stats.udpPort = port
                stats.group = group
                joinGroup(sock, group, "bind")
                startRejoinLoop(sock, group)
                selfTest(sock, group, port)
                onState(stats)

                val buf = ByteArray(2048)
                while (running.get() && !sock.isClosed) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try { sock.receive(pkt) } catch (e: Throwable) { if (running.get()) Log.w(TAG, "recv: ${e.message}"); continue }
                    val text = String(pkt.data, 0, pkt.length, Charsets.UTF_8)
                    val from = pkt.address?.hostAddress ?: "unknown"

                    // The self-test's own datagram: answered here and NOT passed on, so it never
                    // fires a trigger and never moves the counters it exists to explain.
                    if (text.startsWith(PROBE)) {
                        if (probeNonce != null && text.removePrefix(PROBE).trim() == probeNonce) {
                            probeNonce = null
                            stats.loopback = "ok"
                            Log.i(TAG, "[trigger] self-test OK — this player receives its own group")
                            onState(stats)
                        }
                        continue
                    }
                    // Same liberal framing as the HTTP door — see wireClean.
                    onPayload(wireClean(text), "udp", from)
                }
            } catch (e: Throwable) {
                Log.w(TAG, "[trigger] UDP listener failed: ${e.message}")
                stats.udpPort = null
                onState(stats)
            }
        }, "trigger-udp").apply { isDaemon = true }.start()
    }

    /**
     * ⚠️ LEAVE THEN JOIN, NOT JOIN AGAIN — this is the whole reason the periodic rejoin works.
     *
     * The failure it defends against is a switch doing IGMP snooping that stops forwarding the group
     * because it missed a membership report. Nothing on the host looks wrong: the socket is bound,
     * the membership is still held locally, datagrams simply stop. Re-joining a group you are already
     * in emits NO fresh report, so a join-only rejoin would be a no-op against exactly the failure it
     * was written for. Leaving first forces a real report onto the wire.
     */
    private fun joinGroup(sock: MulticastSocket, group: String, why: String) {
        val ni = pickInterface()
        val addr = InetSocketAddress(InetAddress.getByName(group), 0)
        try { if (joinedIface != null) sock.leaveGroup(addr, joinedIface) } catch (e: Throwable) { /* not a member */ }
        try {
            sock.joinGroup(addr, ni)
            joinedIface = ni
            stats.iface = ni?.name
            stats.joinedAt = System.currentTimeMillis()
            stats.lastJoinError = null
            if (why == "rejoin") stats.rejoinCount++
            Log.i(TAG, "[trigger] joined $group on ${ni?.name ?: "(default)"} ($why)")
        } catch (e: Throwable) {
            stats.lastJoinError = e.message
            Log.w(TAG, "[trigger] could not join $group: ${e.message}")
        }
        onState(stats)
    }

    /*
     * Two mechanisms because they cover different failures: the timer is the backstop for silent
     * snooping loss, which no host-side signal reports at all; the interface comparison is the fast
     * path for a Wi-Fi/Ethernet switch or a DHCP renewal, where the address genuinely moved.
     */
    private fun startRejoinLoop(sock: MulticastSocket, group: String) {
        rejoinThread = Thread({
            while (running.get() && !sock.isClosed) {
                try { Thread.sleep(90_000) } catch (e: InterruptedException) { return@Thread }
                if (!running.get() || sock.isClosed) return@Thread
                val now = pickInterface()
                joinGroup(sock, group, if (now?.name != joinedIface?.name) "iface-changed" else "rejoin")
            }
        }, "trigger-rejoin").apply { isDaemon = true }
        rejoinThread?.start()
    }

    /**
     * ⚠️ The one diagnostic that needs nobody else's equipment: address our own group and report
     * whether we hear ourselves. "No trigger arrived" has two causes and one symptom, and counters
     * only separate them once something HAS been sent. This separates them with nothing sent.
     */
    private fun selfTest(sock: DatagramSocket, group: String, port: Int) {
        try {
            val nonce = System.currentTimeMillis().toString() + "-" + (0..9999).random()
            probeNonce = nonce
            stats.loopback = "testing"
            val payload = (PROBE + nonce).toByteArray(Charsets.UTF_8)
            sock.send(DatagramPacket(payload, payload.size, InetAddress.getByName(group), port))
            Thread({
                try { Thread.sleep(2000) } catch (e: InterruptedException) { return@Thread }
                if (probeNonce == nonce) {
                    probeNonce = null
                    stats.loopback = "fail"
                    // Specific and actionable: the local configuration is fine and the network is not.
                    Log.w(TAG, "[trigger] self-test FAILED — $group does not reach this player " +
                               "(socket bound, membership held; suspect IGMP snooping or the switch)")
                    onState(stats)
                }
            }, "trigger-selftest").apply { isDaemon = true }.start()
        } catch (e: Throwable) {
            stats.loopback = "error"
        }
    }

    // ─────────────────────────── framing ───────────────────────────

    /*
     * ⚠️ BE LIBERAL ABOUT FRAMING — the control-system world is not consistent about it and does
     * not consider that a bug. Crestron's own worked example emits HTTP/1.0 with BARE LF, not
     * CRLF. Q-SYS ships an EOL constant literally called `Any` ("any sequence of carriage return
     * and/or linefeed characters") plus a `Null` (single 0 byte) mode — the existence of `Any` is
     * the AV industry telling you line endings arrive however they arrive. AMX appends $0D,$0A by
     * hand, per site, and sometimes forgets.
     *
     * We also TRIM, and this comment documents that: BrightSign does not, its docs say
     * "leading/trailing spaces do matter", and it is a recurring support burden. A trailing space
     * must never be the reason an evacuation notice does not appear.
     *
     * The 1024 cap is Extron's, not ours: ControlScript truncates UDP payloads at 1024 bytes and
     * delivers at most 1024 per receive event, so a longer message is not one we could have been
     * sent intact. Must stay identical to wireClean() in server/player/index.html.
     */
    private fun wireClean(s: String): String {
        val capped = if (s.length > 1024) s.substring(0, 1024) else s
        /*
         * ⚠️ ONE COMBINED CLASS, not strip-then-trim, and identical to wireClean() in
         * server/player/index.html. Stripping terminators and THEN trimming meant any whitespace
         * AFTER a NUL/CR/LF defeated the cleanup entirely — "TOKEN\r\n\u0000  " survived intact and
         * was rejected as malformed. That is exactly the documented target (Q-SYS's Null EOL plus
         * AMX's hand-appended padding), and it was broken identically on both platforms.
         *
         * \uFEFF is named explicitly: a UTF-8 BOM is whitespace to neither language's trim(), and
         * .NET senders emit one. Without it the web player fired and the Android panel beside it
         * answered bad_magic for the same bytes.
         */
        return capped.trim { it.isWhitespace() || it == '\u0000' || it == '\uFEFF' }
    }

    /** Minimal query parser — mirrors parseQuery() in the web player. */
    private fun parseQuery(url: String): Map<String, String> {
        val out = HashMap<String, String>()
        val i = url.indexOf('?')
        if (i < 0) return out
        for (pair in url.substring(i + 1).split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val k = if (eq < 0) pair else pair.substring(0, eq)
            val v = if (eq < 0) "" else pair.substring(eq + 1)
            try {
                out[java.net.URLDecoder.decode(k, "UTF-8")] = java.net.URLDecoder.decode(v, "UTF-8")
            } catch (e: Throwable) {
                out[k] = v   // a bad %-escape must not lose the whole request
            }
        }
        return out
    }

    // ───────────────────────────── HTTP ─────────────────────────────

    /**
     * A deliberately tiny server: one POST, one line in, one JSON verdict out. Adding a dependency
     * to parse a request this simple would put a whole HTTP stack inside the fire path.
     */
    private fun startHttp(port: Int) {
        Thread({
            try {
                val srv = ServerSocket(port)
                http = srv
                stats.httpPort = port
                onState(stats)
                Log.i(TAG, "[trigger] HTTP trigger listener on :$port")
                while (running.get() && !srv.isClosed) {
                    val client = try { srv.accept() } catch (e: Throwable) { if (running.get()) Log.w(TAG, "accept: ${e.message}"); continue }
                    Thread({
                        try {
                            client.soTimeout = 5000
                            val reader = client.getInputStream().bufferedReader()
                            val requestLine = reader.readLine() ?: return@Thread
                            var contentLength = 0
                            while (true) {
                                val h = reader.readLine() ?: break
                                if (h.isEmpty()) break
                                if (h.startsWith("Content-Length:", true)) {
                                    contentLength = h.substringAfter(':').trim().toIntOrNull() ?: 0
                                }
                            }
                            // Bound the read: an endless body must not become memory pressure on a
                            // player. The wire format is one short line either way.
                            val cap = minOf(contentLength, 4096)
                            val body = if (cap > 0) {
                                val chars = CharArray(cap); val n = reader.read(chars, 0, cap)
                                if (n > 0) String(chars, 0, n) else ""
                            } else ""

                            val method = requestLine.substringBefore(' ').uppercase()
                            val target = requestLine.split(' ').getOrNull(1) ?: "/"
                            var text: String? = null
                            var err: String? = null

                            /*
                             * ⚠️ GET IS NOT A CONVENIENCE — it is the only HTTP an AMX or Extron
                             * installer can emit. AMX NetLinx has no HTTP client and no TLS
                             * anywhere in the language: every request is hand-concatenated strings
                             * with a manually computed Content-Length. Extron's Global Scripter
                             * forbids the http, socket and ssl modules outright, so urllib is gone
                             * too, while still allowing json/hmac/hashlib. A POST-only door is
                             * unreachable from both platforms. The secret rides in the query string
                             * for the same reason Carousel's CAP endpoint takes its token there:
                             * plenty of this gear cannot set a request header at all.
                             *
                             * Kept in step with the web player's startTriggerHttp deliberately —
                             * two doors that disagree about what a valid request looks like means
                             * an integrator who tests on one platform and deploys on the other.
                             */
                            when (method) {
                                "GET" -> {
                                    // takeIf { isNotEmpty() }: the web player tests TRUTHINESS, so
                                    // `?m=` falls through to ?token= there and `?token=` is a named
                                    // reject. Null-testing here made the two doors disagree on
                                    // exactly the requests a misconfigured sender produces.
                                    val q = parseQuery(target)
                                    val m = q["m"]?.takeIf { it.isNotEmpty() }
                                    val tok = q["token"]?.takeIf { it.isNotEmpty() }
                                    when {
                                        m != null -> text = m
                                        tok != null -> text = "ST1 " + (q["secret"] ?: "") + " " + tok
                                        // 'ST1' alone parses as ours but incomplete -> `malformed`,
                                        // a member of the closed reject set, and it goes through the
                                        // resolver so it moves the counters an installer reads.
                                        else -> text = "ST1"
                                    }
                                }
                                "POST" -> {
                                    // Accept the raw line, a JSON envelope, OR a form post: three
                                    // shapes because different gear can only produce one of them.
                                    text = try {
                                        val j = org.json.JSONObject(body)
                                        // Truthiness, like the web player: has("token") is also true
                                        // for {"token":""} and {"token":null}, which the web player
                                        // passes through as a raw line instead.
                                        val jt = j.optString("token", "")
                                        if (jt.isNotEmpty()) "ST1 " + j.optString("secret", "") + " " + jt
                                        else body
                                    } catch (e: Throwable) {
                                        // ⚠️ The web player's two ANCHORED regexes, ported verbatim.
                                        // A bare `contains("token=")` also matched a raw wire line
                                        // like `ST1 <secret> mytoken=X`, which then parsed as a form
                                        // with an empty secret — a different token and a different
                                        // verdict from the same bytes on the other platform.
                                        if (FORM_SHAPE.containsMatchIn(body) && FORM_TOKEN.containsMatchIn(body)) {
                                            val q = parseQuery("?" + body)
                                            val tok = q["token"]?.takeIf { it.isNotEmpty() }
                                            if (tok != null) "ST1 " + (q["secret"] ?: "") + " " + tok else body
                                        } else body
                                    }
                                }
                                else -> err = "GET or POST only"
                            }

                            /*
                             * ⚠️ THE REPLY COMES FROM THE RESOLVER, not from "did it parse".
                             *
                             * This used to discard onPayload's result and answer `ok = err == null`,
                             * where err was set only for a missing token or a bad method — so EVERY
                             * syntactically valid request got 200 {"ok":true}, including a wrong
                             * secret, an unknown token and bad magic. The web player returns 400
                             * bad_secret for the same request. An integrator who validates their
                             * secret handling against a web player and deploys to an Android panel
                             * would get a green light on a botched rotation and find out during an
                             * alarm. `action` is echoed for the same reason: a control system tells
                             * a fire from a clear by reading it.
                             */
                            var action: String? = null
                            if (text != null) {
                                val v = onPayload(wireClean(text!!), "http", client.inetAddress?.hostAddress ?: "unknown")
                                if (v != null) {
                                    if (v.ok) action = v.action?.toString() else err = v.reason?.toString() ?: "refused"
                                }
                            }
                            val ok = err == null
                            // ⚠️ Newline-terminated on purpose: Extron integrators confirm delivery
                            // with SendAndWait(deliTag=...), i.e. they read until a known suffix. An
                            // unterminated body blocks them until timeout on a request that worked.
                            val resBody = if (ok) {
                                if (action != null) "{\"ok\":true,\"action\":\"$action\"}" else "{\"ok\":true}"
                            } else "{\"ok\":false,\"error\":\"$err\"}"
                            val res = resBody + "\n"
                            val status = when {
                                ok -> "200 OK"
                                err == "GET or POST only" -> "405 Method Not Allowed"
                                else -> "400 Bad Request"
                            }
                            val allow = if (status.startsWith("405")) "Allow: GET, POST\r\n" else ""
                            val bytes = res.toByteArray(Charsets.UTF_8)
                            client.getOutputStream().write(
                                ("HTTP/1.1 $status\r\nContent-Type: application/json\r\n" + allow +
                                 "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
                                    .toByteArray(Charsets.UTF_8))
                            client.getOutputStream().write(bytes)
                            client.getOutputStream().flush()
                        } catch (e: Throwable) {
                            Log.w(TAG, "[trigger] http client: ${e.message}")
                        } finally {
                            try { client.close() } catch (e: Throwable) { }
                        }
                    }, "trigger-http-client").apply { isDaemon = true }.start()
                }
            } catch (e: Throwable) {
                Log.w(TAG, "[trigger] HTTP listener failed: ${e.message}")
                stats.httpPort = null
                onState(stats)
            }
        }, "trigger-http").apply { isDaemon = true }.start()
    }
}
