package com.remotedisplay.player.player

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 3.0 campaigns: the payload parser and the step selection CampaignPlayer runs on
 * (server/lib/campaign.js builds what is parsed here; docs/layouts-and-campaigns.md).
 */
class CampaignTest {
    private fun zone(id: String, x: Int, w: Int) = JSONObject().put("id", id).put("name", id)
        .put("x_percent", x).put("y_percent", 0).put("width_percent", w).put("height_percent", 100)

    private fun item(cid: String, dur: Int = 10, fileUrl: String? = null) = JSONObject()
        .put("content_id", cid).put("filename", "$cid.jpg").put("mime_type", "image/jpeg").put("duration_sec", dur)
        .also { if (fileUrl != null) it.put("file_url", fileUrl) }

    private fun payload(fileUrl: String? = null): JSONObject {
        val layoutA = JSONObject().put("id", "LA").put("name", "Layout A")
            .put("zones", JSONArray().put(zone("main", 0, 70)).put(zone("side", 70, 30)))
        val layoutB = JSONObject().put("id", "LB").put("name", "Layout B")
            .put("zones", JSONArray().put(zone("top", 0, 100)))
        val steps = JSONArray()
            .put(JSONObject().put("type", "layout").put("layout_id", "LA").put("duration_sec", 30).put("layout", layoutA)
                .put("zones", JSONObject()
                    .put("main", JSONArray().put(item("m1", 8, fileUrl)).put(item("m2", 8)))
                    .put("side", JSONArray().put(item("s1")))))
            .put(JSONObject().put("type", "item").put("item", item("video", 15)))
            .put(JSONObject().put("type", "layout").put("layout_id", "LB").put("duration_sec", 20).put("layout", layoutB)
                .put("schedules", JSONArray().put(JSONObject().put("days", JSONArray().put(1)).put("start", "09:00").put("end", "17:00")))
                .put("zones", JSONObject().put("top", JSONArray().put(item("t1")))))
        return JSONObject().put("assignments", JSONArray()).put("campaign", JSONObject().put("v", 1).put("steps", steps))
    }

    @Test fun `parses layouts and full-screen items in order, with durations`() {
        val c = Campaign.parse(payload())!!
        assertEquals(3, c.steps.size)
        val a = c.steps[0] as CampaignStep.Layout
        assertEquals("LA", a.layoutId)
        assertEquals("Layout A", a.layoutName)
        assertEquals(30_000L, a.durationMs)
        assertEquals(2, a.zoneItems["main"]!!.length())
        val v = c.steps[1] as CampaignStep.Item
        assertEquals("video", v.item.getString("content_id"))
        assertEquals(15_000L, v.durationMs)
        val b = c.steps[2] as CampaignStep.Layout
        assertTrue("a layout step keeps its own gates", b.gate.has("schedules"))
    }

    @Test fun `no campaign, a null one, or nothing playable is null - the fallback plays`() {
        assertNull(Campaign.parse(JSONObject().put("assignments", JSONArray())))
        assertNull(Campaign.parse(JSONObject().put("campaign", JSONObject.NULL)))
        assertNull(Campaign.parse(null))
        val junk = JSONObject().put("campaign", JSONObject().put("steps", JSONArray()
            .put(JSONObject().put("type", "layout"))                                      // no layout
            .put(JSONObject().put("type", "layout").put("layout", JSONObject().put("zones", JSONArray()))) // no zones
            .put(JSONObject().put("type", "layout").put("empty", true).put("layout", JSONObject().put("zones", JSONArray().put(zone("z", 0, 100)))))
            .put(JSONObject().put("type", "item"))                                        // no item
            .put(JSONObject().put("type", "teleport").put("item", item("x")))             // unknown type
            .put("not an object")))
        assertNull(Campaign.parse(junk))
    }

    @Test fun `durations are clamped so a zero or absurd value never spins or stalls the loop`() {
        val p = JSONObject().put("campaign", JSONObject().put("steps", JSONArray()
            .put(JSONObject().put("type", "item").put("item", item("a", 0)))
            .put(JSONObject().put("type", "item").put("item", item("b", 999_999)))))
        val c = Campaign.parse(p)!!
        assertEquals(1000L, c.steps[0].durationMs)
        assertEquals(43_200_000L, c.steps[1].durationMs)
    }

    @Test fun `a layout step hands the zone manager every zone item with its zone id`() {
        val a = Campaign.parse(payload())!!.steps[0] as CampaignStep.Layout
        val arr = a.assignments()
        assertEquals(3, arr.length())
        assertEquals("main", arr.getJSONObject(0).getString("zone_id"))
        assertEquals("m2", arr.getJSONObject(1).getString("content_id"))
        assertEquals("side", arr.getJSONObject(2).getString("zone_id"))
        // A copy: the parsed step is not mutated by rendering it.
        assertFalse((a.zoneItems["main"]!!.getJSONObject(0)).has("zone_id"))
    }

    @Test fun `the signature ignores signed file urls, so a refresh does not restart the campaign`() {
        val one = Campaign.parse(payload("https://bucket/x?sig=1"))!!.sig
        val two = Campaign.parse(payload("https://bucket/x?sig=2"))!!.sig
        assertEquals(one, two)
        val changed = payload().also { it.getJSONObject("campaign").getJSONArray("steps").getJSONObject(0).put("duration_sec", 31) }
        assertNotEquals(one, Campaign.parse(changed)!!.sig)
    }

    @Test fun `the next step skips what may not play now and wraps, and says when nothing may`() {
        val steps = Campaign.parse(payload())!!.steps
        assertEquals(0, Campaign.nextAllowed(steps, 0) { true })
        assertEquals(0, Campaign.nextAllowed(steps, 3) { true })            // wraps: loop
        assertEquals(1, Campaign.nextAllowed(steps, 2) { it !is CampaignStep.Layout || it.layoutId != "LB" && it.layoutId != "LA" })
        assertEquals(2, Campaign.nextAllowed(steps, 1) { it is CampaignStep.Layout && it.layoutId == "LB" })
        assertEquals(-1, Campaign.nextAllowed(steps, 0) { false })
        assertEquals(-1, Campaign.nextAllowed(emptyList(), 0) { true })
    }

    @Test fun `the download sweep sees every campaign item`() {
        val ids = Campaign.items(Campaign.parse(payload())).map { it.getString("content_id") }.toSet()
        assertEquals(setOf("m1", "m2", "s1", "video", "t1"), ids)
        assertTrue(Campaign.items(null).isEmpty())
    }

    @Test fun `a full-screen step is drawn as one zone covering the screen`() {
        val z = Campaign.fullScreenZones()
        assertEquals(1, z.length())
        assertEquals(Campaign.FULL_ZONE_ID, z.getJSONObject(0).getString("id"))
        assertEquals(100, z.getJSONObject(0).getInt("width_percent"))
    }
}
