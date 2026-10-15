package com.remotedisplay.player.player

import org.json.JSONArray
import org.json.JSONObject

/**
 * 3.0 campaigns (server/lib/campaign.js, docs/layouts-and-campaigns.md): a playlist whose items can
 * be WHOLE LAYOUTS — layout A with its zones for 30 s, then a full-screen video, then layout B, loop.
 *
 * The server sends a top-level `campaign` only to a player that declares `layout.campaign`
 * (PlayerCapabilities); `assignments` stays the plain fallback, so everything else in this app (the
 * download sweep, the offline cache, a build without this file) keeps working on ordinary items.
 *
 * This file is the PURE part — parsing and step selection — so it is unit-tested on the JVM
 * (CampaignTest). CampaignPlayer drives the screen with it.
 */
sealed class CampaignStep {
    abstract val durationMs: Long
    /** The object carrying this step's own gates (schedules / play window / enabled). */
    abstract val gate: JSONObject

    /** A whole layout: its zones (already in this screen's orientation version) and each zone's items. */
    data class Layout(
        val layoutId: String,
        val layoutName: String,
        val zones: JSONArray,
        val zoneItems: Map<String, JSONArray>,
        override val durationMs: Long,
        override val gate: JSONObject,
    ) : CampaignStep() {
        /** Every zone item, each carrying its zone_id: what ZoneManager.renderAssignments takes. */
        fun assignments(): JSONArray {
            val out = JSONArray()
            for (i in 0 until zones.length()) {
                val zid = zones.getJSONObject(i).optString("id")
                val list = zoneItems[zid] ?: continue
                for (j in 0 until list.length()) {
                    val it = JSONObject(list.getJSONObject(j).toString())
                    it.put("zone_id", zid)
                    out.put(it)
                }
            }
            return out
        }
    }

    /** One item, full screen. */
    data class Item(val item: JSONObject, override val durationMs: Long) : CampaignStep() {
        override val gate: JSONObject get() = item
    }
}

class Campaign(val steps: List<CampaignStep>, val sig: String) {
    companion object {
        const val FULL_ZONE_ID = "__campaign_full__"
        private const val MIN_MS = 1000L
        private const val MAX_MS = 43_200_000L

        /** A full-screen zone list for an item step: ZoneManager draws it like any one-zone layout. */
        fun fullScreenZones(): JSONArray = JSONArray().put(JSONObject().apply {
            put("id", FULL_ZONE_ID); put("name", "Full screen")
            put("x_percent", 0); put("y_percent", 0); put("width_percent", 100); put("height_percent", 100)
            put("z_index", 0); put("zone_type", "content"); put("fit_mode", "contain")
        })

        private fun ms(sec: Double): Long = (sec * 1000).toLong().coerceIn(MIN_MS, MAX_MS)

        /**
         * The campaign in a playlist payload, or null when there is none (or nothing playable in it).
         * Tolerant by design: a malformed step is skipped, never fatal — the fallback in `assignments`
         * is always there to play instead.
         */
        fun parse(payload: JSONObject?): Campaign? {
            if (payload == null || payload.isNull("campaign")) return null
            val c = payload.optJSONObject("campaign") ?: return null
            val arr = c.optJSONArray("steps") ?: return null
            val steps = ArrayList<CampaignStep>()
            for (i in 0 until arr.length()) {
                val s = arr.optJSONObject(i) ?: continue
                when (s.optString("type")) {
                    "layout" -> {
                        val layout = s.optJSONObject("layout") ?: continue
                        val zones = layout.optJSONArray("zones") ?: continue
                        if (zones.length() == 0 || s.optBoolean("empty", false)) continue
                        val zi = s.optJSONObject("zones") ?: JSONObject()
                        val map = HashMap<String, JSONArray>()
                        val keys = zi.keys()
                        while (keys.hasNext()) { val k = keys.next(); zi.optJSONArray(k)?.let { if (it.length() > 0) map[k] = it } }
                        steps.add(CampaignStep.Layout(
                            layoutId = layout.optString("id", s.optString("layout_id")),
                            layoutName = layout.optString("name", ""),
                            zones = zones, zoneItems = map,
                            durationMs = ms(s.optDouble("duration_sec", 10.0)),
                            gate = s,
                        ))
                    }
                    "item" -> {
                        val item = s.optJSONObject("item") ?: continue
                        steps.add(CampaignStep.Item(item, ms(item.optDouble("duration_sec", 10.0))))
                    }
                }
            }
            if (steps.isEmpty()) return null
            return Campaign(steps, signature(arr))
        }

        /**
         * What decides "this is the same campaign" across refreshes. Volatile per-payload fields (signed
         * file URLs, data-source bags) are left out, or every refresh would restart it.
         */
        fun signature(steps: JSONArray): String {
            fun strip(v: Any?): Any? = when (v) {
                is JSONObject -> JSONObject().also { o -> val ks = v.keys(); val sorted = ArrayList<String>(); while (ks.hasNext()) sorted.add(ks.next()); sorted.sort(); for (k in sorted) if (k != "file_url" && k != "_ds") o.put(k, strip(v.opt(k))) }
                is JSONArray -> JSONArray().also { a -> for (i in 0 until v.length()) a.put(strip(v.opt(i))) }
                else -> v
            }
            return strip(steps).toString()
        }

        /** The first step from `from` (wrapping) that `allowed` lets play, or -1 when none does. */
        fun nextAllowed(steps: List<CampaignStep>, from: Int, allowed: (CampaignStep) -> Boolean): Int {
            if (steps.isEmpty()) return -1
            val start = ((from % steps.size) + steps.size) % steps.size
            for (i in steps.indices) {
                val idx = (start + i) % steps.size
                if (allowed(steps[idx])) return idx
            }
            return -1
        }

        /** Every item a campaign can show (for the download sweep). */
        fun items(c: Campaign?): List<JSONObject> {
            if (c == null) return emptyList()
            val out = ArrayList<JSONObject>()
            for (s in c.steps) when (s) {
                is CampaignStep.Item -> out.add(s.item)
                is CampaignStep.Layout -> for (list in s.zoneItems.values) for (i in 0 until list.length()) out.add(list.getJSONObject(i))
            }
            return out
        }
    }
}
