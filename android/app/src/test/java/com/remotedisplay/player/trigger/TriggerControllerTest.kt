package com.remotedisplay.player.trigger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * The Android collision/lease state machine.
 *
 * ⚠️ These assertions deliberately mirror server/test/triggers-priority-lease.test.js case for case.
 * The resolver is held to shared vectors; this is not, because the vector format covers one decision
 * and this is a sequence of them — so the only thing keeping the two state machines honest is that
 * the same cases are asserted on both sides. Naming that here so it is a known gap rather than an
 * assumed equivalence. If an alarm ever behaves differently on an Android panel than on the screen
 * beside it, this is where to look first.
 */
class TriggerControllerTest {

    private fun t(id: String, token: String, priority: Int = 0, mode: String = "until_cleared",
                  lease: Int? = null, clear: String? = null) =
        TriggerResolve.Trigger(id, id, token, clear, true, true, mode, priority, 0, lease)

    private class Rig {
        var clock = 1_000_000L
        val shown = mutableListOf<String>()
        var visible: String? = null
        val ctl: TriggerController = TriggerController(
            show = { shown.add(it.id); visible = it.id },
            hide = { visible = null },
            now = { clock }
        )
        fun fire(tr: TriggerResolve.Trigger) =
            ctl.onVerdict(TriggerResolve.Verdict(true, TriggerResolve.Action.FIRE, tr), "udp")
        fun clear(tr: TriggerResolve.Trigger) =
            ctl.onVerdict(TriggerResolve.Verdict(true, TriggerResolve.Action.CLEAR, tr), "udp")
        fun clearAll() =
            ctl.onVerdict(TriggerResolve.Verdict(true, TriggerResolve.Action.CLEAR_ALL, null), "udp")
        fun advance(ms: Long) { clock += ms; ctl.sweep() }
    }

    @Test fun higherPriorityTakesTheScreen() {
        val r = Rig(); val lo = t("lo", "LO", 10); val hi = t("hi", "HI", 100)
        r.fire(lo); assertEquals("lo", r.ctl.active?.trigger?.id)
        r.fire(hi); assertEquals("hi", r.ctl.active?.trigger?.id)
    }

    @Test fun lowerPriorityIsDroppedAndNotHeld() {
        val r = Rig(); val lo = t("lo", "LO", 10); val hi = t("hi", "HI", 100)
        r.fire(hi); r.fire(lo)
        assertEquals("hi", r.ctl.active?.trigger?.id)
        assertEquals(0, r.ctl.held.size)
    }

    @Test fun preemptedUntilClearedIsHeldAndComesBack() {
        val r = Rig()
        val lo = t("lo", "LO", 10); val hi = t("hi", "HI", 100, clear = "HI_C")
        r.fire(lo); r.fire(hi)
        assertEquals(1, r.ctl.held.size)
        r.clear(hi)
        assertEquals("lo", r.ctl.active?.trigger?.id)
    }

    /** ⚠️ The distinction that stops the held set being an interrupt stack. */
    @Test fun preemptedOnceIsNotHeld() {
        val r = Rig()
        val promo = t("promo", "P", 10, mode = "once")
        val hi = t("hi", "HI", 100, clear = "HI_C")
        r.fire(promo); r.fire(hi)
        assertEquals(0, r.ctl.held.size)
        r.clear(hi)
        assertNull("a spent one-shot came back", r.ctl.active)
    }

    @Test fun restoredTriggerRestartsAtItemOne() {
        val r = Rig()
        val lo = t("lo", "LO", 10); val hi = t("hi", "HI", 100, clear = "HI_C")
        r.fire(lo); r.fire(hi); r.clear(hi)
        // show() is called again on restore — the renderer always starts a playlist at its first item.
        assertEquals(listOf("lo", "hi", "lo"), r.shown)
    }

    @Test fun highestPriorityHeldIsRestoredFirst() {
        val r = Rig()
        r.fire(t("a", "A", 10)); r.fire(t("b", "B", 50))
        val c = t("c", "C", 100, clear = "C_C"); r.fire(c)
        assertEquals(2, r.ctl.held.size)
        r.clear(c)
        assertEquals("b", r.ctl.active?.trigger?.id)
    }

    @Test fun clearingAHeldTriggerRemovesIt() {
        val r = Rig()
        val lo = t("lo", "LO", 10, clear = "LO_C"); val hi = t("hi", "HI", 100, clear = "HI_C")
        r.fire(lo); r.fire(hi); r.clear(lo)
        assertEquals(0, r.ctl.held.size)
        r.clear(hi)
        assertNull("a trigger came back after being told to stop", r.ctl.active)
    }

    @Test fun clearAllEmptiesTheHeldSet() {
        val r = Rig()
        r.fire(t("lo", "LO", 10)); r.fire(t("hi", "HI", 100))
        r.clearAll()
        assertNull(r.ctl.active)
        assertEquals(0, r.ctl.held.size)
    }

    @Test fun leaseExpiresWhenNobodyReasserts() {
        val r = Rig(); val x = t("x", "X", 10, lease = 60)
        r.fire(x)
        r.advance(30_000); assertNotNull("cleared early", r.ctl.active)
        r.advance(40_000); assertNull("a lost clear would strand this screen", r.ctl.active)
    }

    @Test fun reFireRenewsWithoutRestarting() {
        val r = Rig(); val x = t("x", "X", 10, lease = 60)
        r.fire(x)
        val shows = r.shown.size
        r.advance(50_000)
        r.fire(x)
        assertEquals("the overlay restarted on a repeat", shows, r.shown.size)
        r.advance(40_000)
        assertNotNull("the renewal did not take", r.ctl.active)
    }

    @Test fun noLeaseHoldsIndefinitely() {
        val r = Rig(); r.fire(t("x", "X", 10))
        r.advance(86_400_000)
        assertNotNull("an unset lease must not auto-clear", r.ctl.active)
    }

    /** ⚠️ The lease is about the world, not the screen. */
    @Test fun heldLeaseKeepsTickingAndLapsedHoldsDoNotReturn() {
        val r = Rig()
        val lo = t("lo", "LO", 10, lease = 60); val hi = t("hi", "HI", 100, clear = "HI_C")
        r.fire(lo); r.fire(hi)
        assertEquals(1, r.ctl.held.size)
        r.advance(90_000)
        assertEquals("a lapsed assertion stayed held", 0, r.ctl.held.size)
        r.clear(hi)
        assertNull("it came back after it stopped being true", r.ctl.active)
    }

    @Test fun reassertingAHeldTriggerRenewsItWithoutDisturbingTheScreen() {
        val r = Rig()
        val lo = t("lo", "LO", 10, lease = 60); val hi = t("hi", "HI", 100, clear = "HI_C")
        r.fire(lo); r.fire(hi)
        r.advance(50_000)
        r.fire(lo)
        assertEquals("the re-assertion stole the screen", "hi", r.ctl.active?.trigger?.id)
        r.advance(40_000)
        assertEquals("the held lease was not renewed", 1, r.ctl.held.size)
        r.clear(hi)
        assertEquals("lo", r.ctl.active?.trigger?.id)
    }

    @Test fun restoredTriggerKeepsItsRemainingLease() {
        val r = Rig()
        val lo = t("lo", "LO", 10, lease = 60); val hi = t("hi", "HI", 100, clear = "HI_C")
        r.fire(lo); r.fire(hi)
        r.advance(30_000)
        r.clear(hi)
        assertEquals("lo", r.ctl.active?.trigger?.id)
        r.advance(31_000)
        assertNull("the restore reset the lease clock", r.ctl.active)
    }
}
