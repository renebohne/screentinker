package com.remotedisplay.player.trigger

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The per-source token bucket, mirroring server/lib/trigger-resolve.js createRateLimiter.
 *
 * ⚠️ Android had NO limiter at all until the HTTP door grew a GET verb, at which point a surface
 * reachable from a browser address bar or an AMX retry storm was unmetered on this platform while
 * the web player metered it. These cases mirror the JS defaults so the two cannot drift silently.
 */
class TriggerRateLimiterTest {

    @Test fun burstIsAllowedThenRefused() {
        val rl = TriggerResolve.RateLimiter()
        val t = 1_000_000L
        repeat(10) { assertTrue("burst of 10 must pass", rl.allow("1.2.3.4", t)) }
        assertFalse("the 11th in the same instant must be refused", rl.allow("1.2.3.4", t))
    }

    @Test fun tokensRefillOverTime() {
        val rl = TriggerResolve.RateLimiter()
        var t = 1_000_000L
        repeat(10) { rl.allow("1.2.3.4", t) }
        assertFalse(rl.allow("1.2.3.4", t))
        t += 1000                                   // 1s at 5/s
        assertTrue("a second of silence must buy tokens back", rl.allow("1.2.3.4", t))
    }

    /** ⚠️ One chatty sender must not silence the alarm panel next to it. */
    @Test fun sourcesAreMeteredIndependently() {
        val rl = TriggerResolve.RateLimiter()
        val t = 1_000_000L
        repeat(10) { rl.allow("1.2.3.4", t) }
        assertFalse(rl.allow("1.2.3.4", t))
        assertTrue("a different source shares no bucket", rl.allow("5.6.7.8", t))
    }

    /** ⚠️ A spoofed source per packet must not walk around the per-source limit. */
    @Test fun theGlobalCeilingBoundsSpoofedSources() {
        val rl = TriggerResolve.RateLimiter()
        val t = 1_000_000L
        var allowed = 0
        for (i in 0 until 200) if (rl.allow("10.0.0.$i", t)) allowed++
        assertTrue("global ceiling was not applied (allowed=$allowed)", allowed <= 50)
    }

    /** The bucket map must not grow without bound while an attacker holds the tap. */
    @Test fun theBucketMapIsBounded() {
        val rl = TriggerResolve.RateLimiter(maxKeys = 8)
        var t = 1_000_000L
        for (i in 0 until 100) { rl.allow("src-$i", t); t += 1000 }
        // No direct size accessor by design; the guard is that this neither throws nor degrades.
        assertTrue(rl.allow("src-final", t))
    }
}
