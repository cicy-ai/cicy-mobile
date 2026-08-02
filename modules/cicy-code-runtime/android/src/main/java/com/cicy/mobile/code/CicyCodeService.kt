package com.cicy.mobile.code

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.io.File
import java.security.SecureRandom

class CicyCodeService : Service() {
  companion object {
    const val PORT = 8008
    private const val CHANNEL_ID = "cicy_code_runtime"
    private const val NOTIFICATION_ID = 8008

    @Volatile var process: Process? = null
      private set

    fun start(context: Context) {
      val intent = Intent(context, CicyCodeService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    fun stop(context: Context) = context.stopService(Intent(context, CicyCodeService::class.java))

    fun token(context: Context): String {
      val prefs = context.getSharedPreferences("cicy_code_runtime", Context.MODE_PRIVATE)
      prefs.getString("api_token", null)?.let { return it }
      val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
      val generated = bytes.joinToString("") { "%02x".format(it) }
      prefs.edit().putString("api_token", generated).apply()
      return generated
    }
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, notification("正在启动本地 CiCy"))
    MobileAccessibilityBridge.start(this)
    launchIfNeeded()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    launchIfNeeded()
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    process?.destroy()
    process = null
    MobileAccessibilityBridge.stop()
    super.onDestroy()
  }

  private fun launchIfNeeded() {
    if (process?.isAlive == true) return
    val binary = File(applicationInfo.nativeLibraryDir, "libcicycode.so")
    val runtimeHome = File(filesDir, "cicy-code-home").apply { mkdirs() }
    val logFile = File(filesDir, "cicy-code.log")
    try {
      val mobileBridge = MobileAccessibilityBridge.start(this)
      process = ProcessBuilder(binary.absolutePath, "--port", PORT.toString())
        .directory(runtimeHome)
        .redirectErrorStream(true)
        .redirectOutput(ProcessBuilder.Redirect.appendTo(logFile))
        .apply {
          environment()["HOME"] = runtimeHome.absolutePath
          environment()["CICY_RUNTIME_MODE"] = "api-only"
          environment()["CICY_RUNTIME_API_ONLY"] = "1"
          environment()["CICY_API_TOKEN"] = token(this@CicyCodeService)
          environment()["CICY_PPROF_PORT"] = "off"
          environment()["CICY_MOBILE_BRIDGE_URL"] = mobileBridge.url
          environment()["CICY_MOBILE_BRIDGE_TOKEN"] = mobileBridge.token
        }
        .start()
      updateNotification("本地 CiCy 正在运行")
      Thread {
        process?.waitFor()
        process = null
        updateNotification("本地 CiCy 已停止")
      }.start()
    } catch (error: Exception) {
      File(filesDir, "cicy-code-launch-error.log").writeText(error.stackTraceToString())
      updateNotification("本地 CiCy 启动失败")
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "CiCy 本地运行时", NotificationManager.IMPORTANCE_LOW)
      )
    }
  }

  private fun notification(text: String): Notification = NotificationCompat.Builder(this, CHANNEL_ID)
    .setSmallIcon(com.cicy.mobile.code.R.drawable.ic_stat_cicy_code)
    .setContentTitle("CiCy Code")
    .setContentText(text)
    .setOngoing(true)
    .setSilent(true)
    .build()

  private fun updateNotification(text: String) {
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
  }
}
