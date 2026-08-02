package com.cicy.mobile.code

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

object MobileAccessibilityBridge {
  data class Config(val port: Int, val token: String) {
    val url: String get() = "http://127.0.0.1:$port"
  }

  private const val MAX_HEADER_BYTES = 16 * 1024
  private const val MAX_BODY_BYTES = 256 * 1024
  private val lock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  @Volatile private var server: ServerSocket? = null
  @Volatile private var config: Config? = null

  fun start(context: Context): Config = synchronized(lock) {
    config?.let { existing ->
      if (server?.isClosed == false) return@synchronized existing
    }
    val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    val bytes = ByteArray(32).also(SecureRandom()::nextBytes)
    val next = Config(socket.localPort, bytes.joinToString("") { "%02x".format(it) })
    server = socket
    config = next
    Thread({ acceptLoop(context.applicationContext, socket) }, "cicy-mobile-bridge").apply {
      isDaemon = true
      start()
    }
    next
  }

  fun current(): Config? = config

  fun stop() = synchronized(lock) {
    server?.close()
    server = null
    config = null
  }

  private fun acceptLoop(context: Context, socket: ServerSocket) {
    while (!socket.isClosed) {
      try {
        val client = socket.accept()
        Thread({ handleClient(context, client) }, "cicy-mobile-bridge-request").apply {
          isDaemon = true
          start()
        }
      } catch (_: Exception) {
        if (!socket.isClosed) continue
      }
    }
  }

  private data class Request(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: ByteArray
  )

  private fun handleClient(context: Context, socket: Socket) {
    socket.use { client ->
      client.soTimeout = 12_000
      val output = BufferedOutputStream(client.getOutputStream())
      try {
        val request = readRequest(BufferedInputStream(client.getInputStream()))
        val expected = config?.token ?: ""
        val supplied = request.headers["authorization"]?.removePrefix("Bearer ") ?: ""
        if (expected.isBlank() || !MessageDigest.isEqual(expected.toByteArray(), supplied.toByteArray())) {
          writeJson(output, 401, failure("unauthorized", "Invalid mobile bridge token"))
          return
        }
        when {
          request.method == "GET" && request.path == "/v1/accessibility/tree" -> {
            writeJson(output, 200, onAccessibilityThread { service -> service.tree() })
          }
          request.method == "POST" && request.path == "/v1/accessibility/action" -> {
            val body = try {
              JSONObject(String(request.body, StandardCharsets.UTF_8))
            } catch (_: Exception) {
              writeJson(output, 400, failure("invalid_json", "Request body must be JSON"))
              return
            }
            writeJson(output, 200, onAccessibilityThread { service -> service.action(body) })
          }
          request.path == "/v1/accessibility/tree" || request.path == "/v1/accessibility/action" ->
            writeJson(output, 405, failure("method_not_allowed", "Unsupported HTTP method"))
          else -> writeJson(output, 404, failure("not_found", "Unknown mobile bridge endpoint"))
        }
      } catch (error: RequestError) {
        writeJson(output, error.status, failure(error.code, error.message ?: error.code))
      } catch (error: Exception) {
        writeJson(output, 500, failure("bridge_error", error.message ?: "Mobile bridge failed"))
      }
    }
  }

  private class RequestError(val status: Int, val code: String, message: String) : Exception(message)

  private fun readRequest(input: BufferedInputStream): Request {
    val header = ArrayList<Byte>()
    var matched = 0
    val terminator = byteArrayOf(13, 10, 13, 10)
    while (matched < terminator.size) {
      val value = input.read()
      if (value < 0) throw RequestError(400, "invalid_request", "Unexpected end of headers")
      header.add(value.toByte())
      if (header.size > MAX_HEADER_BYTES) throw RequestError(431, "headers_too_large", "Headers exceed 16 KiB")
      matched = if (value.toByte() == terminator[matched]) matched + 1 else if (value == 13) 1 else 0
    }
    val lines = String(header.toByteArray(), StandardCharsets.ISO_8859_1).split("\r\n")
    val requestLine = lines.firstOrNull()?.split(' ') ?: emptyList()
    if (requestLine.size < 2) throw RequestError(400, "invalid_request", "Invalid request line")
    val headers = mutableMapOf<String, String>()
    for (line in lines.drop(1)) {
      val split = line.indexOf(':')
      if (split > 0) headers[line.substring(0, split).trim().lowercase()] = line.substring(split + 1).trim()
    }
    val length = headers["content-length"]?.toIntOrNull() ?: 0
    if (length < 0 || length > MAX_BODY_BYTES) throw RequestError(413, "body_too_large", "Body exceeds 256 KiB")
    val body = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val count = input.read(body, offset, length - offset)
      if (count < 0) throw RequestError(400, "invalid_request", "Unexpected end of body")
      offset += count
    }
    return Request(requestLine[0].uppercase(), requestLine[1].substringBefore('?'), headers, body)
  }

  private fun onAccessibilityThread(block: (CicyAccessibilityService) -> JSONObject): JSONObject {
    val service = CicyAccessibilityService.current()
      ?: return failure("accessibility_disabled", "Enable CiCy Mobile Agent in Android accessibility settings")
    if (Looper.myLooper() == Looper.getMainLooper()) return block(service)
    val result = AtomicReference<JSONObject>()
    val latch = CountDownLatch(1)
    mainHandler.post {
      result.set(try { block(service) } catch (error: Exception) {
        failure("action_failed", error.message ?: "Accessibility action failed")
      })
      latch.countDown()
    }
    if (!latch.await(8, TimeUnit.SECONDS)) return failure("action_timeout", "Accessibility action timed out")
    return result.get() ?: failure("action_failed", "Accessibility action returned no result")
  }

  private fun writeJson(output: BufferedOutputStream, status: Int, value: JSONObject) {
    val body = value.toString().toByteArray(StandardCharsets.UTF_8)
    val reason = when (status) {
      200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 404 -> "Not Found"
      405 -> "Method Not Allowed"; 413 -> "Payload Too Large"; 431 -> "Request Header Fields Too Large"
      else -> "Internal Server Error"
    }
    output.write("HTTP/1.1 $status $reason\r\n".toByteArray())
    output.write("Content-Type: application/json; charset=utf-8\r\n".toByteArray())
    output.write("Content-Length: ${body.size}\r\n".toByteArray())
    output.write("Cache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray())
    output.write(body)
    output.flush()
  }

  private fun failure(code: String, error: String): JSONObject =
    JSONObject().put("ok", false).put("code", code).put("error", error)
}
