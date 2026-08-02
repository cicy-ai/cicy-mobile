package com.cicy.mobile.code

import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CicyCodeModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("CicyCode")

    OnCreate { CicyCodeService.start(context) }

    AsyncFunction("start") {
      CicyCodeService.start(context)
      true
    }

    AsyncFunction("stop") {
      CicyCodeService.stop(context)
      true
    }

    AsyncFunction("getConnection") {
      val bridge = MobileAccessibilityBridge.current()
      mapOf(
        "baseUrl" to "http://127.0.0.1:${CicyCodeService.PORT}",
        "token" to CicyCodeService.token(context),
        "running" to (CicyCodeService.process?.isAlive == true),
        "home" to context.filesDir.resolve("cicy-code-home").absolutePath,
        "accessibilityEnabled" to CicyAccessibilityService.isEnabled(context),
        "mobileBridgeRunning" to (bridge != null)
      )
    }

    AsyncFunction("isAccessibilityEnabled") {
      CicyAccessibilityService.isEnabled(context)
    }

    AsyncFunction("openAccessibilitySettings") {
      context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      })
      true
    }
  }
}
