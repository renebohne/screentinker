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
    private val onPayload: (text: String, source: String, sourceIp: String) -> Unit,
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
                    onPayload(text, "udp", from)
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

                            val ok = requestLine.startsWith("POST")
                            if (ok) {
                                // Accept the raw line OR a JSON envelope: some gear can only POST a
                                // string, some can only POST JSON. Same wire format underneath.
                                val text = try {
                                    val j = org.json.JSONObject(body)
                                    if (j.has("token")) "ST1 " + j.optString("secret", "") + " " + j.optString("token")
                                    else body.trim()
                                } catch (e: Throwable) { body.trim() }
                                onPayload(text, "http", client.inetAddress?.hostAddress ?: "unknown")
                            }
                            val res = if (ok) "{\"ok\":true}" else "{\"ok\":false,\"error\":\"POST only\"}"
                            val status = if (ok) "200 OK" else "405 Method Not Allowed"
                            client.getOutputStream().write(
                                ("HTTP/1.1 $status\r\nContent-Type: application/json\r\n" +
                                 "Content-Length: ${res.length}\r\nConnection: close\r\n\r\n$res")
                                    .toByteArray(Charsets.UTF_8))
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
