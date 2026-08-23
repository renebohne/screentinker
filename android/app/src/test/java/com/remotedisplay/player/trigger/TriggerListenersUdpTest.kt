package com.remotedisplay.player.trigger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The Android UDP listener, RUN FOR REAL: a real MulticastSocket on a real NIC, fired at with real
 * datagrams from a separate socket.
 *
 * ⚠️ This is possible only because `unitTests.isReturnDefaultValues = true` makes android.util.Log
 * a no-op instead of a throw — everything else in TriggerListeners is plain JVM networking. Without
 * a test like this the Kotlin transport could only ever be checked on a device, which in practice
 * meant never: the whole Android trigger stack sat unreachable for weeks and nobody noticed, and
 * the web player shipped a fire path whose renderer was stubbed.
 *
 * Mirrors the live check run against the web player's listener (unicast + multicast + rejects), so
 * the two platforms are held to the same observable behaviour rather than to each other's comments.
 */
class TriggerListenersUdpTest {

    private val secret = "s".repeat(16)
    private fun trigger() = TriggerResolve.Trigger(
        id = "t1", name = "Evac", matchToken = "EVAC", clearToken = "EVAC_CLR",
        sourceHttp = false, sourceUdp = true, mode = "until_cleared")

    private class Rig(port: Int, group: String) {
        val verdicts = ArrayList<TriggerResolve.Verdict>()
        val latch = CountDownLatch(1)
        lateinit var listeners: TriggerListeners
    }

    /** Bind on an ephemeral-ish high port; the OS picking it for us is not available here. */
    private fun freePort(): Int = DatagramSocket(0).use { it.localPort }

    private fun send(msg: String, addr: String, port: Int) {
        DatagramSocket().use { s ->
            s.broadcast = true
            val b = msg.toByteArray(Charsets.UTF_8)
            s.send(DatagramPacket(b, b.size, InetAddress.getByName(addr), port))
        }
    }

    @Test fun aRealDatagramReachesTheResolverAndFires() {
        val port = freePort()
        val group = "239.255.42.88"
        val seen = ArrayList<TriggerResolve.Verdict>()
        val latch = CountDownLatch(1)
        val l = TriggerListeners(onPayload = { text, source, _ ->
            val v = TriggerResolve.evaluate(text, listOf(trigger()), secret, "ALLSTOP", source)
            synchronized(seen) { seen.add(v) }
            if (v.ok) latch.countDown()
            v
        })
        try {
            l.start(acceptHttp = false, acceptUdp = true, httpPort = null, udpPort = port, group = group)
            Thread.sleep(1200)               // bind + join + self-test

            assertEquals("the listener did not report the port it bound", port, l.stats.udpPort)
            assertEquals(group, l.stats.group)
            assertNotNull("no interface was named for the join — the OS would pick, often wrongly", l.stats.iface)

            send("ST1 $secret EVAC", "127.0.0.1", port)
            assertTrue("a unicast datagram never reached the handler", latch.await(5, TimeUnit.SECONDS))
            val v = synchronized(seen) { seen.last() }
            assertTrue(v.ok)
            assertEquals(TriggerResolve.Action.FIRE, v.action)
        } finally { l.stop() }
    }

    @Test fun theSelfTestProvesTheGroupReachesThisDeviceWithNobodyElsesEquipment() {
        /*
         * ⚠️ The one diagnostic that needs no integrator. "Nothing arrived" has two causes — the
         * sender never sent, or the switch is not forwarding the group — and counters cannot
         * separate them until something HAS been sent. This separates them with nothing sent.
         */
        val port = freePort()
        val l = TriggerListeners(onPayload = { _, _, _ -> null })
        try {
            l.start(false, true, null, port, "239.255.42.89")
            Thread.sleep(2500)               // probe + its 2s verdict window
            assertEquals("the loopback self-test did not confirm — see stats.loopback", "ok", l.stats.loopback)
        } finally { l.stop() }
    }

    @Test fun theProbeIsAnsweredBeforeTheHandlerSoItNeverMovesTheCounters() {
        // Producing a diagnostic by polluting the numbers the diagnostic exists to explain would be
        // self-defeating: an installer would see traffic nobody on site caused.
        val port = freePort()
        var payloads = 0
        val l = TriggerListeners(onPayload = { _, _, _ -> synchronized(this) { payloads++ }; null })
        try {
            l.start(false, true, null, port, "239.255.42.90")
            Thread.sleep(2500)
            assertEquals("the self-test probe was passed to the trigger handler", 0, payloads)
        } finally { l.stop() }
    }

    @Test fun aWrongSecretAndLanNoiseAreRefusedWithDistinctReasons() {
        val port = freePort()
        val seen = ArrayList<TriggerResolve.Verdict>()
        val latch = CountDownLatch(2)
        val l = TriggerListeners(onPayload = { text, source, _ ->
            val v = TriggerResolve.evaluate(text, listOf(trigger()), secret, "ALLSTOP", source)
            synchronized(seen) { seen.add(v) }; latch.countDown(); v
        })
        try {
            l.start(false, true, null, port, "239.255.42.91")
            Thread.sleep(1200)
            send("ST1 " + "x".repeat(16) + " EVAC", "127.0.0.1", port)
            send("random mdns chatter", "127.0.0.1", port)
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            val reasons = synchronized(seen) { seen.mapNotNull { it.reason?.toString() }.toSet() }
            assertTrue("bad_secret not reported: $reasons", reasons.contains("bad_secret"))
            // ⚠️ bad_magic must stay distinct from bad_secret: one says the LAN is noisy, the other
            // says something is talking to us and getting the credential wrong. Very different visits.
            assertTrue("bad_magic not reported: $reasons", reasons.contains("bad_magic"))
        } finally { l.stop() }
    }

    @Test fun startingTwiceDoesNotMarkAWorkingListenerDown() {
        // The exact bug the web player's fire-path suite caught by firing at it: the second start
        // takes EADDRINUSE and its error handler reports the listener DOWN while the first is up
        // and serving — the one diagnostic an installer trusts, saying the opposite of the truth.
        val port = freePort()
        val l = TriggerListeners(onPayload = { _, _, _ -> null })
        try {
            l.start(false, true, null, port, "239.255.42.92")
            Thread.sleep(800)
            l.start(false, true, null, port, "239.255.42.92")
            Thread.sleep(800)
            assertEquals("a duplicate start took the port state down with it", port, l.stats.udpPort)
        } finally { l.stop() }
    }
}
