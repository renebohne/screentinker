package com.remotedisplay.player.data

import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * 3.0 site cache on the native player: ContentCache.fetchFromSiteCache against a local stand-in
 * for the LAN box. The rule under test is the same one the web player's worker obeys: keep the
 * bytes only if they hash to the ORIGIN's digest; anything else is Failed and the origin is used.
 */
class SiteCacheFetchTest {

    private lateinit var dir: java.io.File
    private lateinit var cache: ContentCache
    private var server: ServerSocket? = null
    private val auth = java.util.Collections.synchronizedList(ArrayList<String>())

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).callTimeout(5, TimeUnit.SECONDS).build()

    @Before fun setUp() {
        dir = Files.createTempDirectory("sitecachetest").toFile()
        cache = ContentCache(dir, client)
    }

    @After fun tearDown() {
        try { server?.close() } catch (_: Exception) {}
        dir.deleteRecursively()
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    /** One-connection box that answers [status] with [body], recording the Authorization header. */
    private fun box(status: Int, body: ByteArray): String {
        val s = ServerSocket(0)
        server = s
        Thread {
            try {
                s.accept().use { sock ->
                    val reader = sock.getInputStream().bufferedReader()
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Authorization:", ignoreCase = true)) auth.add(line.substringAfter(":").trim())
                    }
                    val out = sock.getOutputStream()
                    out.write("HTTP/1.1 $status X\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    out.write(body)
                    out.flush()
                }
            } catch (_: Exception) { }
        }.apply { isDaemon = true; start() }
        return "http://127.0.0.1:${s.localPort}"
    }

    private fun cfg(url: String, body: ByteArray) = SiteCacheConfig(url, "stc1.tok", 0L, mapOf("cid" to SiteCacheConfig.Entry(sha(body), body.size.toLong())))

    @Test fun verifiedBytesAreKeptWithTheScreenToken() {
        val body = ByteArray(5000) { (it % 251).toByte() }
        val c = cfg(box(200, body), body)
        val r = cache.fetchFromSiteCache(c, c.entryFor("cid")!!, "cid", "clip.mp4", 7L)
        assertTrue(r is ContentCache.Result.Done)
        assertArrayEquals(body, (r as ContentCache.Result.Done).file.readBytes())
        assertEquals("Bearer stc1.tok", auth.first())
        assertTrue(cache.isContentCached("cid", 7L))
    }

    @Test fun bytesThatDoNotMatchTheDigestAreDiscarded() {
        val body = ByteArray(5000) { 1 }
        val lie = ByteArray(5000) { 2 }
        val c = cfg(box(200, lie), body)
        val r = cache.fetchFromSiteCache(c, c.entryFor("cid")!!, "cid", "clip.mp4")
        assertTrue(r is ContentCache.Result.Failed)
        assertNull(cache.getCachedFile("cid"))
        assertEquals(0, dir.listFiles()!!.size)
    }

    @Test fun aRefusalOrADeadBoxIsFailedSoTheOriginIsUsed() {
        val body = ByteArray(10) { 3 }
        val c404 = cfg(box(404, "{}".toByteArray()), body)
        assertTrue(cache.fetchFromSiteCache(c404, c404.entryFor("cid")!!, "cid", "a.png") is ContentCache.Result.Failed)
        server?.close()
        val dead = cfg("http://127.0.0.1:1", body)
        assertTrue(cache.fetchFromSiteCache(dead, dead.entryFor("cid")!!, "cid", "a.png") is ContentCache.Result.Failed)
        assertNull(cache.getCachedFile("cid"))
    }

    /**
     * One server playing both parts: `/cache/<sha>` is the box (answering [boxBody]) and anything else
     * is the origin (answering [originBody]). Counts what each was asked.
     */
    private fun both(boxBody: ByteArray, originBody: ByteArray, hits: MutableList<String>): String {
        val s = ServerSocket(0)
        server = s
        Thread {
            try {
                while (!s.isClosed) {
                    val sock = s.accept()
                    Thread {
                        try {
                            val reader = sock.getInputStream().bufferedReader()
                            val first = reader.readLine() ?: ""
                            while (true) { val l = reader.readLine() ?: break; if (l.isEmpty()) break }
                            val isBox = first.contains(" /cache/")
                            hits.add(if (isBox) "box" else "origin")
                            val body = if (isBox) boxBody else originBody
                            val out = sock.getOutputStream()
                            out.write("HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            out.write(body); out.flush(); sock.close()
                        } catch (_: Exception) {}
                    }.apply { isDaemon = true; start() }
                }
            } catch (_: Exception) {}
        }.apply { isDaemon = true; start() }
        return "http://127.0.0.1:${s.localPort}"
    }

    private fun coordinate(base: String, site: SiteCacheConfig?): Pair<java.io.File?, List<String>> {
        val acks = java.util.Collections.synchronizedList(ArrayList<String>())
        val done = java.util.concurrent.CountDownLatch(1)
        val ex = java.util.concurrent.Executors.newFixedThreadPool(1)
        val coord = DownloadCoordinator(cache, { base }, { true }, { c, st -> acks.add("$c:$st"); if (st == "ready") done.countDown() }, ex, { 0L }, { site })
        coord.ensure("cid", "clip.mp4")
        done.await(10, TimeUnit.SECONDS)
        coord.shutdown()
        return cache.getCachedFile("cid") to acks
    }

    @Test fun coordinatorTakesTheBoxCopyAndNeverAsksTheOrigin() {
        val body = ByteArray(4000) { (it % 7).toByte() }
        val hits = java.util.Collections.synchronizedList(ArrayList<String>())
        val base = both(body, ByteArray(4000) { 9 }, hits)
        val (file, acks) = coordinate(base, cfg(base, body))
        assertArrayEquals(body, file!!.readBytes())
        assertEquals(listOf("box"), hits.toList())
        assertEquals(listOf("cid:ready"), acks.toList())
    }

    @Test fun coordinatorFallsBackToTheOriginWhenTheBoxLies() {
        val body = ByteArray(4000) { (it % 5).toByte() }
        val hits = java.util.Collections.synchronizedList(ArrayList<String>())
        val base = both(ByteArray(4000) { 1 }, body, hits)
        val (file, _) = coordinate(base, cfg(base, body))
        assertArrayEquals("the true asset, from the origin", body, file!!.readBytes())
        assertEquals(listOf("box", "origin"), hits.toList())
    }

    @Test fun parseRefusesWhatItCannotTrustAndHonoursExpiry() {
        assertNull(SiteCacheConfig.parse(null))
        assertNull(SiteCacheConfig.parse(JSONObject("""{"url":"javascript:x","token":"t","files":{}}""")))
        assertNull(SiteCacheConfig.parse(JSONObject("""{"url":"http://10.0.0.5:8088/path","token":"t","files":{}}""")))
        val good = SiteCacheConfig.parse(JSONObject("""{"url":"http://10.0.0.5:8088","token":"t","expires_at":100,
            "files":{"a":{"sha256":"${"a".repeat(64)}","size":3},"b":{"sha256":"nope","size":3}}}"""))
        assertNotNull(good)
        assertEquals(setOf("a"), good!!.files.keys)
        assertNull("expired", good.entryFor("a", nowSec = 200))
        assertNotNull(good.entryFor("a", nowSec = 50))
        assertFalse(good.files.containsKey("b"))
    }
}
