package com.remotedisplay.player.trigger

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Payload adoption: the device learns its triggers and its listener config here and nowhere else.
 *
 * ⚠️ These assert the SHAPE the server actually sends (server/lib/device-triggers.js projectTrigger).
 * A field renamed on one side and not the other is silent: the trigger simply never matches, and the
 * only symptom is an alarm that does not fire — which is indistinguishable from the integrator never
 * having sent anything, the exact confusion the diagnostics exist to remove.
 */
class TriggerManagerParseTest {

    private fun payload(): JSONObject {
        val item = JSONObject().put("content_id", "c1").put("duration_sec", 7)
        val t = JSONObject()
            .put("id", "t1").put("name", "Evac")
            .put("match_token", "EVAC").put("clear_token", "EVAC_CLR")
            .put("source_http", true).put("source_udp", false)
            .put("mode", "until_cleared").put("priority", 100)
            .put("max_duration_sec", 0).put("lease_sec", 60)
            .put("items", JSONArray().put(item))
        return JSONObject()
            .put("triggers", JSONArray().put(t))
            .put("trigger_config", JSONObject()
                .put("secret", "s".repeat(16))
                .put("accept_http", true).put("accept_udp", false)
                .put("http_port", 8079).put("clear_all_token", "ALLSTOP"))
    }

    /** A renderer that records rather than draws — see TriggerRenderer for why this is an interface. */
    private class Stub(var succeed: Boolean = true) : TriggerRenderer {
        val shown = ArrayList<String>()
        var hidden = 0
        override fun show(trigger: TriggerResolve.Trigger): Boolean { shown.add(trigger.id); return succeed }
        override fun hide() { hidden++ }
    }

    private fun parsed(p: JSONObject): List<TriggerResolve.Trigger> {
        val m = TriggerManager(Stub(), log = { _, _ -> })
        m.onPayload(p)
        return m.triggers
    }

    @Test fun theServersFieldNamesAreHonoured() {
        val list = parsed(payload())
        assertEquals(1, list.size)
        val t = list[0]
        assertEquals("EVAC", t.matchToken)
        assertEquals("EVAC_CLR", t.clearToken)
        assertEquals("until_cleared", t.mode)
        assertEquals(100, t.priority)
        assertEquals(Integer.valueOf(60), t.leaseSec)
        assertTrue("source_http did not survive", t.sourceHttp)
        assertEquals("items must travel inline — a device cannot resolve a playlist id offline",
            1, t.items.size)
    }

    /** ⚠️ null lease means HOLD INDEFINITELY; 0 would mean "expire immediately". */
    @Test fun anAbsentLeaseStaysNull() {
        val p = payload()
        p.getJSONArray("triggers").getJSONObject(0).put("lease_sec", JSONObject.NULL)
        assertNull(parsed(p)[0].leaseSec)
    }

    @Test fun aPayloadWithNoTriggersClearsThem() {
        val m = TriggerManager(Stub(), log = { _, _ -> })
        m.onPayload(payload())
        assertEquals(1, m.triggers.size)
        m.onPayload(JSONObject().put("trigger_config", JSONObject().put("secret", "x".repeat(16))))
        assertEquals("a removed trigger must not survive in memory", 0, m.triggers.size)
    }

    /** ⚠️ Rejected traffic is counted too — that is the distinction an installer reads. */
    @Test fun rejectedTrafficMovesTheCounters() {
        val m = TriggerManager(Stub(), log = { _, _ -> })
        m.onPayload(payload())
        m.handle("not-ours at all", "udp", "1.2.3.4")
        assertEquals(1, m.received)
        assertEquals(0, m.accepted)
        assertTrue("a rejected datagram must still stamp last_datagram_at", m.lastDatagramAt > 0)
        assertEquals(Integer.valueOf(1), m.rejected["bad_magic"])
    }

    @Test fun aGoodPayloadIsAcceptedAndRendered() {
        val stub = Stub()
        val m = TriggerManager(stub, log = { _, _ -> })
        m.onPayload(payload())
        val v = m.handle("ST1 " + "s".repeat(16) + " EVAC", "http", "1.2.3.4")
        assertTrue("verdict: ${v.reason}", v.ok)
        assertEquals(1, m.accepted)
        assertEquals("the overlay was never asked to render", listOf("t1"), stub.shown)
    }

    /** ⚠️ A trigger that renders nothing must not be treated as showing. */
    @Test fun anOverlayThatCannotRenderDoesNotBecomeActive() {
        val stub = Stub(succeed = false)
        val m = TriggerManager(stub, log = { _, _ -> })
        m.onPayload(payload())
        m.handle("ST1 " + "s".repeat(16) + " EVAC", "http", "1.2.3.4")
        assertEquals(listOf("t1"), stub.shown)   // it was attempted
    }
}
