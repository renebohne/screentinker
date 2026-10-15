package com.screentinker.manager

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * Photos and videos shared from the Gallery go straight to the server's library (POST /api/content,
 * the same endpoint and field the dashboard's uploader uses), then the Simple view's "Upload photos"
 * task opens at "Which screens?" with them (#/simple/upload?ids=...). Streamed, so a large video is
 * not held in memory.
 */
object ShareUploader {

    class UploadError(message: String) : Exception(message)

    fun upload(resolver: ContentResolver, origin: String, token: String, uris: List<Uri>): List<String> {
        val boundary = "----stm" + UUID.randomUUID().toString().replace("-", "")
        val conn = URL("$origin/api/content").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15000
        conn.readTimeout = 300000
        conn.setChunkedStreamingMode(64 * 1024)
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")

        DataOutputStream(conn.outputStream).use { out ->
            for (uri in uris) {
                val name = displayName(resolver, uri)
                val type = resolver.getType(uri) ?: "application/octet-stream"
                out.writeBytes("--$boundary\r\n")
                out.writeBytes("Content-Disposition: form-data; name=\"files\"; filename=\"${name.replace("\"", "")}\"\r\n")
                out.writeBytes("Content-Type: $type\r\n\r\n")
                resolver.openInputStream(uri)?.use { it.copyTo(out, 64 * 1024) }
                    ?: throw UploadError("could not read $name")
                out.writeBytes("\r\n")
            }
            out.writeBytes("--$boundary--\r\n")
        }

        val code = conn.responseCode
        val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) {
            val msg = try { JSONObject(body).optString("error") } catch (e: Exception) { "" }
            throw UploadError(msg.ifBlank { "HTTP $code" })
        }
        val ids = mutableListOf<String>()
        val trimmed = body.trim()
        if (trimmed.startsWith("[")) {
            val arr = JSONArray(trimmed)
            for (i in 0 until arr.length()) arr.optJSONObject(i)?.optString("id")?.takeIf { it.isNotBlank() }?.let(ids::add)
        } else {
            JSONObject(trimmed).optString("id").takeIf { it.isNotBlank() }?.let(ids::add)
        }
        return ids
    }

    private fun displayName(resolver: ContentResolver, uri: Uri): String {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0)?.let { if (it.isNotBlank()) return it }
        }
        return uri.lastPathSegment ?: "shared"
    }
}
