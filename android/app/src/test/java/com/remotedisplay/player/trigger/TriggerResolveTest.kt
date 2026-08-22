package com.remotedisplay.player.trigger

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Drift guard: the Kotlin resolver must agree with the SHARED contract at
 * shared/trigger-vectors.json — the same file the JS player's suite is held to. No snapshot is
 * taken: the test task points `triggerVectors` at the single source (see app/build.gradle.kts), so
 * any TriggerResolve.kt change that breaks a vector fails CI.
 *
 * ⚠️ Why this is worth a whole file: the fire path decides whether an unauthenticated packet from a
 * LAN changes what is on a screen. Two implementations of that in two languages drift silently, and
 * the drift is security-relevant — an Android panel accepting a payload the web player refuses is a
 * hole nobody would notice until it was used. Same reasoning, same mechanism, as ScheduleEvalTest.
 */
class TriggerResolveTest {

    private fun triggersFrom(arr: com.google.gson.JsonArray): List<TriggerResolve.Trigger> =
        arr.map { el ->
            val o = el.asJsonObject
            TriggerResolve.Trigger(
                id = o.get("id").asString,
                name = o.get("name").asString,
                matchToken = o.get("match_token").asString,
                clearToken = if (o.get("clear_token").isJsonNull) null else o.get("clear_token").asString,
                sourceHttp = o.get("source_http").asBoolean,
                sourceUdp = o.get("source_udp").asBoolean,
                mode = o.get("mode").asString,
                priority = if (o.has("priority")) o.get("priority").asInt else 0
            )
        }

    @Test
    fun conformsToSharedVectors() {
        val path = System.getProperty("triggerVectors")
            ?: error("triggerVectors system property not set (configured in app/build.gradle.kts)")
        val root = JsonParser.parseString(File(path).readText()).asJsonObject

        val defaultTriggers = triggersFrom(root.getAsJsonArray("triggers"))
        val defaultSecret = root.get("device_secret").asString
        val defaultClearAll =
            if (root.get("clear_all_token").isJsonNull) null else root.get("clear_all_token").asString

        val failures = StringBuilder()
        var count = 0

        for (el in root.getAsJsonArray("vectors")) {
            val v = el.asJsonObject
            val desc = v.get("description").asString

            // Per-vector overrides, so a vector can describe an unprovisioned device or one holding
            // no triggers without needing a second file.
            val triggers = if (v.has("triggers")) triggersFrom(v.getAsJsonArray("triggers")) else defaultTriggers
            val secret = if (v.has("device_secret")) v.get("device_secret").asString else defaultSecret
            val clearAll = when {
                !v.has("clear_all_token") -> defaultClearAll
                v.get("clear_all_token").isJsonNull -> null
                else -> v.get("clear_all_token").asString
            }

            val got = TriggerResolve.evaluate(
                text = v.get("text").asString,
                triggers = triggers,
                deviceSecret = secret,
                clearAllToken = clearAll,
                source = v.get("source").asString
            )

            val expect = v.getAsJsonObject("expect")
            val wantOk = expect.get("ok").asBoolean
            if (got.ok != wantOk) {
                failures.append("\n  [$desc] ok: expected $wantOk got ${got.ok} (reason=${got.reason})")
            } else if (wantOk) {
                val wantAction = expect.get("action").asString
                if (got.action.toString() != wantAction) {
                    failures.append("\n  [$desc] action: expected $wantAction got ${got.action}")
                }
                val wantId = if (expect.get("trigger_id").isJsonNull) null else expect.get("trigger_id").asString
                if (got.trigger?.id != wantId) {
                    failures.append("\n  [$desc] trigger: expected $wantId got ${got.trigger?.id}")
                }
            } else {
                val wantReason = expect.get("reason").asString
                if (got.reason.toString() != wantReason) {
                    failures.append("\n  [$desc] reason: expected $wantReason got ${got.reason}")
                }
            }
            count++
        }

        if (failures.isNotEmpty()) {
            error("Kotlin resolver disagrees with shared/trigger-vectors.json:$failures\n" +
                  "The vectors are the contract. If this fails, this implementation is wrong.")
        }
        // A vector file that silently emptied would pass every assertion above.
        assertTrue("only $count vectors ran — the contract file looks truncated", count >= 25)
    }

    @Test
    fun secretCompareIsLengthChecked() {
        assertEquals(true, TriggerResolve.secretMatches("abc", "abc"))
        assertEquals(false, TriggerResolve.secretMatches("abc", "abcd"))
        assertEquals(false, TriggerResolve.secretMatches(null, "abc"))
    }
}
