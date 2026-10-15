package com.screentinker.manager.share

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sharer's side of the signalling, held to what the server's lib/screen-share.js sends and accepts. */
class ShareProtocolTest {

    @Test fun `a guest join answer gives every leg, display first, with ws path and screen name`() {
        val j = ShareProtocol.joined("""{"session_id":"s1","ticket":"t1","ws_path":"/api/screen-share/ws","screen_name":"Boardroom","share_id":"s1",
            "legs":[{"session_id":"s1","ticket":"t1","screen_name":"Boardroom","ice_servers":[{"urls":"stun:stun.example:3478"}]},
                    {"session_id":"s2","ticket":"t2","screen_name":"","ice_servers":[]}]}""")!!
        assertEquals("/api/screen-share/ws", j.wsPath)
        assertEquals("Boardroom", j.screenName)
        assertEquals(listOf("s1", "s2"), j.legs.map { it.sessionId })
        assertEquals(1, j.legs[0].iceServers.length())
    }

    @Test fun `an older server one-ticket answer is one leg and junk is refused`() {
        assertEquals(1, ShareProtocol.joined("""{"session_id":"s1","ticket":"t1","ws_path":"/api/screen-share/ws"}""")!!.legs.size)
        assertNull(ShareProtocol.joined("""{"ws_path":"/api/screen-share/ws"}"""))
        assertNull(ShareProtocol.joined("""{"session_id":"s1","ticket":"t1","ws_path":"wss://evil.example/x"}"""))
        assertNull(ShareProtocol.joined("not json"))
    }

    @Test fun `refusals - the server reason, 429 is slow down, anything odd is generic`() {
        assertEquals("invalid_code", ShareProtocol.refusal(404, """{"reason":"invalid_code"}"""))
        assertEquals("busy", ShareProtocol.refusal(409, """{"reason":"busy"}"""))
        assertEquals("slow_down", ShareProtocol.refusal(429, ""))
        assertEquals("generic", ShareProtocol.refusal(500, "<html>"))
        assertEquals("generic", ShareProtocol.refusal(409, """{"reason":"<script>"}"""))
    }

    @Test fun `incoming messages`() {
        assertTrue(ShareProtocol.parseIncoming("""{"type":"ready"}""") is ShareProtocol.Incoming.Ready)
        assertTrue(ShareProtocol.parseIncoming("""{"type":"webrtc/offer","value":"v=0\r\n"}""") is ShareProtocol.Incoming.Offer)
        assertTrue(ShareProtocol.parseIncoming("""{"type":"webrtc/offer","value":"nope"}""") is ShareProtocol.Incoming.Other)
        val c = ShareProtocol.parseIncoming("""{"type":"webrtc/candidate","value":"candidate:1 1 udp 1 1.2.3.4 5 typ host","mid":"0","mline":0}""") as ShareProtocol.Incoming.Candidate
        assertEquals("0", c.mid)
        assertTrue(ShareProtocol.parseIncoming("""{"type":"webrtc/candidate","value":"bogus"}""") is ShareProtocol.Incoming.Other)
        assertEquals("removed", (ShareProtocol.parseIncoming("""{"type":"ended","reason":"removed"}""") as ShareProtocol.Incoming.Ended).reason)
        val add = ShareProtocol.parseIncoming("""{"type":"add_leg","share_id":"s1","leg":{"session_id":"s9","ticket":"t9","screen_name":"Mirror"}}""") as ShareProtocol.Incoming.AddLeg
        assertEquals("s9", add.leg.sessionId)
        assertTrue(ShareProtocol.parseIncoming("""{"type":"add_leg","leg":{"session_id":"bad id!","ticket":"t"}}""") is ShareProtocol.Incoming.Other)
        val skip = ShareProtocol.parseIncoming("""{"type":"leg_skipped","screen_name":"Lobby","reason":"single_presenter"}""") as ShareProtocol.Incoming.LegSkipped
        assertEquals("single_presenter", skip.reason)
    }

    @Test fun `outgoing messages are the browser's`() {
        assertEquals("auth", JSONObject(ShareProtocol.auth("tk")).getString("type"))
        assertEquals("tk", JSONObject(ShareProtocol.auth("tk")).getString("ticket"))
        val join = JSONObject(ShareProtocol.joinBody("K7QM3XHP", "Pia"))
        assertEquals("K7QM3XHP", join.getString("code")); assertEquals(false, join.getBoolean("audio")); assertEquals("app", join.getString("source"))
        assertEquals(1, JSONObject(ShareProtocol.sharesBody(listOf("dev-1", "bad id!"))).getJSONArray("device_ids").length())
        assertEquals("wss://a.example/api/screen-share/ws", ShareProtocol.wsUrl("https://a.example", "/api/screen-share/ws"))
        assertEquals("ws://10.0.0.5:3001/api/screen-share/ws", ShareProtocol.wsUrl("http://10.0.0.5:3001", "/api/screen-share/ws"))
    }

    @Test fun `capture size keeps the shape, long side at most 1280, even`() {
        assertEquals(Pair(576, 1280), ScreenShareSession.scaled(1080, 2400))
        assertEquals(Pair(1280, 576), ScreenShareSession.scaled(2400, 1080))
        assertEquals(Pair(800, 600), ScreenShareSession.scaled(800, 600))
    }
}
