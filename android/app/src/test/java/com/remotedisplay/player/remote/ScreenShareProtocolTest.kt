package com.remotedisplay.player.remote

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 3.0 screen share: the Android receiver's wire handling, held to what the server relay
 * (server/lib/screen-share.js) sends and accepts and what the web receiver
 * (server/lib/screen-share-player.js) does with the same messages.
 */
class ScreenShareProtocolTest {

    private fun startJson() = JSONObject()
        .put("session_id", "abc_DEF-123")
        .put("shared_by", "Gail")
        .put("guest", true)
        .put("audio", true)
        .put("max_seconds", 1800)
        .put("ice_servers", JSONArray().put(JSONObject().put("urls", "stun:stun.example:3478")))

    @Test fun parsesAStart() {
        val s = ScreenShareProtocol.parseStart(startJson())!!
        assertEquals("abc_DEF-123", s.sessionId)
        assertEquals("Gail", s.sharedBy)
        assertTrue(s.guest)
        assertEquals(1800, s.maxSeconds)
        assertEquals(1, s.iceServers.length())
    }

    @Test fun refusesAStartWithoutAUsableSessionId() {
        assertNull(ScreenShareProtocol.parseStart(null))
        assertNull(ScreenShareProtocol.parseStart(JSONObject()))
        assertNull(ScreenShareProtocol.parseStart(startJson().put("session_id", 42)))
        assertNull(ScreenShareProtocol.parseStart(startJson().put("session_id", "../../x")))
        assertNull(ScreenShareProtocol.parseStart(startJson().put("session_id", "")))
    }

    @Test fun missingOptionalFieldsDefault() {
        val s = ScreenShareProtocol.parseStart(JSONObject().put("session_id", "s1"))!!
        assertEquals("", s.sharedBy)
        assertFalse(s.guest)
        assertEquals(3600, s.maxSeconds)
        assertEquals(0, s.iceServers.length())
    }

    @Test fun cleansTheNameItShowsOnTheTv() {
        // A guest typed it: bidi overrides, zero-width and control characters go, length is bounded.
        assertEquals("evil txt", ScreenShareProtocol.cleanName("evil‮​\ttxt"))
        assertEquals(40, ScreenShareProtocol.cleanName("x".repeat(100)).length)
        assertEquals("", ScreenShareProtocol.cleanName(null))
    }

    @Test fun localBackstopClampsLikeTheWebReceiver() {
        assertEquals(60_000L + 5000L, ScreenShareProtocol.maxDurationMs(5))
        assertEquals(1800_000L + 5000L, ScreenShareProtocol.maxDurationMs(1800))
        assertEquals(8 * 3600_000L + 5000L, ScreenShareProtocol.maxDurationMs(999_999))
    }

    @Test fun signallingUrlNeverCarriesTheToken() {
        assertEquals("wss://signage.example.com/api/devices/dev-1/screen-share/ws",
            ScreenShareProtocol.wsUrl("https://signage.example.com/", "dev-1"))
        assertEquals("ws://10.0.0.5:3001/st/api/devices/d%2F2/screen-share/ws",
            ScreenShareProtocol.wsUrl("http://10.0.0.5:3001/st", "d/2"))
    }

    @Test fun authIsTheFirstMessageShape() {
        val o = JSONObject(ScreenShareProtocol.authMessage("tok", "s1"))
        assertEquals("auth", o.getString("type"))
        assertEquals("tok", o.getString("device_token"))
        assertEquals("s1", o.getString("session_id"))
    }

    @Test fun offerAndCandidatesUseGo2rtcShape() {
        val offer = JSONObject(ScreenShareProtocol.offerMessage("v=0\r\n"))
        assertEquals("webrtc/offer", offer.getString("type"))
        assertEquals("v=0\r\n", offer.getString("value"))
        val c = JSONObject(ScreenShareProtocol.candidateMessage("candidate:1 1 udp 1 1.2.3.4 5 typ host", "0", 0))
        assertEquals("webrtc/candidate", c.getString("type"))
        assertEquals("0", c.getString("mid"))
        assertEquals(0, c.getInt("mline"))
        val bare = JSONObject(ScreenShareProtocol.candidateMessage("candidate:x", null, null))
        assertFalse(bare.has("mid")); assertFalse(bare.has("mline"))
    }

    @Test fun statesAreOnlyTheOnesTheRelayAccepts() {
        for (s in listOf("connecting", "connected", "playing", "failed", "disconnected", "unsupported")) {
            assertEquals(s, JSONObject(ScreenShareProtocol.stateMessage(s)).getString("value"))
        }
        try { ScreenShareProtocol.stateMessage("hacked"); throw AssertionError("accepted an unknown state") }
        catch (_: IllegalArgumentException) {}
    }

    @Test fun parsesWhatTheRelaySends() {
        assertTrue(ScreenShareProtocol.parseIncoming("""{"type":"ready","session_id":"s1"}""") is ScreenShareProtocol.Incoming.Ready)
        val a = ScreenShareProtocol.parseIncoming("""{"type":"webrtc/answer","value":"v=0\r\nx"}""")
        assertEquals("v=0\r\nx", (a as ScreenShareProtocol.Incoming.Answer).sdp)
        val c = ScreenShareProtocol.parseIncoming("""{"type":"webrtc/candidate","value":"candidate:1","mid":"1"}""")
        assertEquals(ScreenShareProtocol.Incoming.Candidate("candidate:1", "1", 0), c)
        val c2 = ScreenShareProtocol.parseIncoming("""{"type":"webrtc/candidate","value":"candidate:1","mline":1}""")
        assertEquals(ScreenShareProtocol.Incoming.Candidate("candidate:1", null, 1), c2)
        assertEquals(ScreenShareProtocol.Incoming.Ended("max_duration"),
            ScreenShareProtocol.parseIncoming("""{"type":"ended","reason":"max_duration"}"""))
        assertEquals(ScreenShareProtocol.Incoming.Ended("ended"), ScreenShareProtocol.parseIncoming("""{"type":"ended"}"""))
    }

    @Test fun ignoresJunk() {
        for (t in listOf(null, "", "nope", "[]", """{"type":"webrtc/answer","value":"not sdp"}""",
                """{"type":"webrtc/answer","value":5}""", """{"type":"webrtc/candidate","value":""}""", """{"type":"screen_joined"}""")) {
            assertTrue("should ignore $t", ScreenShareProtocol.parseIncoming(t) is ScreenShareProtocol.Incoming.Ignored)
        }
    }

    @Test fun aLateStopForAnOlderShareDoesNotEndTheCurrentOne() {
        assertTrue(ScreenShareProtocol.stopApplies("s2", "s2"))
        assertTrue(ScreenShareProtocol.stopApplies("s2", null))
        assertTrue(ScreenShareProtocol.stopApplies("s2", ""))
        assertFalse(ScreenShareProtocol.stopApplies("s2", "s1"))
        assertFalse(ScreenShareProtocol.stopApplies(null, "s1"))
    }

    @Test fun badgeMatchesTheWebPlayer() {
        assertEquals("Shared by Gail · guest", ScreenShareProtocol.badgeText("Shared by {name}", "guest", "Gail", true))
        assertEquals("Shared by Ann", ScreenShareProtocol.badgeText("Shared by {name}", "guest", "Ann", false))
    }

    @Test fun codeOnlyTakesAPngDataUrlAsTheQr() {
        val ok = ScreenShareProtocol.parseCode(JSONObject().put("code", "K7QM-3XHP").put("url", "https://signage.example.com/share")
            .put("qr", "data:image/png;base64,iVBORw0KGgo="))!!
        assertEquals("K7QM-3XHP", ok.code)
        assertEquals("signage.example.com/share", ok.shownUrl)
        assertEquals("iVBORw0KGgo=", ok.qrPngBase64)
        val evil = ScreenShareProtocol.parseCode(JSONObject().put("code", "K7QM-3XHP").put("qr", "https://evil.example/x.png"))!!
        assertNull(evil.qrPngBase64)
        assertEquals("/share", evil.shownUrl)
        assertNull(ScreenShareProtocol.parseCode(JSONObject().put("code", JSONObject.NULL)))
        assertNull(ScreenShareProtocol.parseCode(null))
    }

    @Test fun letterboxFitsLikeObjectFitContain() {
        assertEquals(Pair(1920, 1080), ScreenShareProtocol.fit(1920, 1080, 1280, 720))
        assertEquals(Pair(1440, 1080), ScreenShareProtocol.fit(1920, 1080, 1024, 768))   // pillarbox
        assertEquals(Pair(1080, 607), ScreenShareProtocol.fit(1080, 1920, 1920, 1080))   // portrait panel
        assertEquals(Pair(100, 50), ScreenShareProtocol.fit(100, 50, 0, 0))
    }
}
