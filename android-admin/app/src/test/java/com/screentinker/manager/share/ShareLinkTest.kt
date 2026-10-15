package com.screentinker.manager.share

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The no-account share starts from a link anyone could send. These hold the rules that keep it from
 * streaming a phone's screen somewhere the person did not see: only http/https, a real host shown in
 * ASCII, no user:password@ trick, and only a code in the server's own alphabet.
 */
class ShareLinkTest {

    @Test fun `the screen's QR (https, query code) gives the server and the code`() {
        val t = ShareLink.parse("https://signage.example.com/share?code=K7QM3XHP")!!
        assertEquals("https://signage.example.com", t.origin)
        assertEquals("signage.example.com", t.host)
        assertEquals("K7QM3XHP", t.code)
        assertEquals("K7QM-3XHP", t.displayCode)
    }

    @Test fun `a LAN server over http with a port, and the older fragment form`() {
        val t = ShareLink.parse("http://192.168.1.10:3001/share#k7qm-3xhp")!!
        assertEquals("http://192.168.1.10:3001", t.origin)
        assertEquals("192.168.1.10:3001", t.host)
        assertEquals("K7QM3XHP", t.code)
        assertEquals("https://x.example", ShareLink.parse("https://x.example:443/share/?code=K7QM3XHP")!!.origin)
    }

    @Test fun `the share page's app link (screentinker scheme)`() {
        val t = ShareLink.parse("screentinker://share?server=https%3A%2F%2Fsignage.example.com&code=K7QM3XHP")!!
        assertEquals("https://signage.example.com", t.origin)
        assertEquals("K7QM3XHP", t.code)
        // A server with a path keeps only its origin.
        assertEquals("https://a.example", ShareLink.parse("screentinker://share?server=https://a.example/evil/path&code=K7QM3XHP")!!.origin)
    }

    @Test fun `a link without a usable code still names the server (the app asks for the code)`() {
        val t = ShareLink.parse("https://signage.example.com/share")!!
        assertNull(t.code)
        assertNull(ShareLink.parse("https://signage.example.com/share?code=TOOSHORT1")!!.code)
    }

    @Test fun `no other scheme, path or trick is accepted`() {
        for (bad in listOf(
            "javascript:alert(1)", "file:///sdcard/share?code=K7QM3XHP", "content://x/share?code=K7QM3XHP",
            "ftp://a.example/share?code=K7QM3XHP", "https://a.example/other?code=K7QM3XHP", "https://a.example/share/more?code=K7QM3XHP",
            "https://user:pw@a.example/share?code=K7QM3XHP", "https://screentinker.com@evil.example/share?code=K7QM3XHP",
            "screentinker://other?server=https://a.example&code=K7QM3XHP",
            "screentinker://share?server=javascript:alert(1)&code=K7QM3XHP",
            "screentinker://share?server=file:///etc&code=K7QM3XHP",
            "screentinker://share?server=https://user@a.example&code=K7QM3XHP",
            "screentinker://share?code=K7QM3XHP", "", "   ", "https:///share?code=K7QM3XHP",
        )) assertNull("must refuse: $bad", ShareLink.parse(bad))
    }

    @Test fun `an international host is shown in ASCII (punycode), so a look-alike cannot pass as the real one`() {
        val t = ShareLink.parse("screentinker://share?server=https%3A%2F%2Fscr%D0%B5entinker.com&code=K7QM3XHP")!!   // Cyrillic e
        assertTrue(t.host, t.host.startsWith("xn--"))
    }

    @Test fun `codes are read like the server reads them`() {
        assertEquals("K7QM3XHP", ShareLink.normaliseCode(" k7qm-3xhp "))
        assertEquals("01100000", ShareLink.normaliseCode("OIL0O000"))    // O->0, I/L->1
        assertNull(ShareLink.normaliseCode("K7QM3XH"))
        assertNull(ShareLink.normaliseCode("K7QM3XHU"))                 // U is not in the alphabet
        assertNull(ShareLink.normaliseCode("K7QM3XH!"))
        assertNull(ShareLink.normaliseCode(null))
    }

    @Test fun `typed addresses - https assumed, path dropped, junk refused`() {
        assertEquals("https://signage.example.com", ShareLink.normaliseOrigin("signage.example.com/app/", typed = true))
        assertEquals("http://10.0.0.5:3001", ShareLink.normaliseOrigin("http://10.0.0.5:3001", typed = true))
        assertNull(ShareLink.normaliseOrigin("signage.example.com", typed = false))   // a link must say http(s)
        assertNull(ShareLink.normaliseOrigin("not a host", typed = true))
        assertNull(ShareLink.normaliseOrigin("https://a.example:99999", typed = true))
        assertNotNull(ShareLink.manual("signage.example.com", "k7qm-3xhp"))
        assertNull(ShareLink.manual("signage.example.com", "nope"))
    }
}
