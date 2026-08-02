package com.cicy.mobile.code

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

class CicyAccessibilityService : AccessibilityService() {
  companion object {
    @Volatile private var activeService: CicyAccessibilityService? = null

    fun current(): CicyAccessibilityService? = activeService

    fun isEnabled(context: Context): Boolean {
      val expected = ComponentName(context, CicyAccessibilityService::class.java)
      val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
      ) ?: return false
      return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
    }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    activeService = this
    serviceInfo = serviceInfo.apply {
      flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
        AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
    }
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

  override fun onInterrupt() = Unit

  override fun onUnbind(intent: Intent?): Boolean {
    if (activeService === this) activeService = null
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    if (activeService === this) activeService = null
    super.onDestroy()
  }

  fun tree(): JSONObject {
    val root = rootInActiveWindow
      ?: return JSONObject().put("ok", false).put("code", "no_active_window").put("error", "No active accessibility window")
    val state = TreeState()
    val node = encodeNode(root, "0", 0, state)
    return JSONObject()
      .put("ok", true)
      .put("result", JSONObject()
        .put("package", root.packageName?.toString() ?: "")
        .put("nodeCount", state.count)
        .put("truncated", state.truncated)
        .put("root", node))
  }

  fun action(input: JSONObject): JSONObject {
    return when (val action = input.optString("action").lowercase()) {
      "click" -> nodeAction(input.optJSONObject("selector"), AccessibilityNodeInfo.ACTION_CLICK, climb = true)
      "input" -> inputText(input.optJSONObject("selector"), input.optString("text"))
      "scroll" -> scroll(input.optJSONObject("selector"), input.optString("direction", "forward"))
      "back" -> globalAction(GLOBAL_ACTION_BACK)
      "home" -> globalAction(GLOBAL_ACTION_HOME)
      "launch" -> launch(input.optString("package"))
      else -> failure("invalid_action", "Unsupported mobile action: $action")
    }
  }

  private data class TreeState(var count: Int = 0, var truncated: Boolean = false)

  private fun encodeNode(node: AccessibilityNodeInfo, nodeId: String, depth: Int, state: TreeState): JSONObject {
    state.count += 1
    val bounds = android.graphics.Rect().also(node::getBoundsInScreen)
    val out = JSONObject()
      .put("nodeId", nodeId)
      .put("className", limited(node.className))
      .put("viewId", limited(node.viewIdResourceName))
      .put("text", limited(node.text))
      .put("description", limited(node.contentDescription))
      .put("package", limited(node.packageName))
      .put("clickable", node.isClickable)
      .put("editable", node.isEditable)
      .put("scrollable", node.isScrollable)
      .put("enabled", node.isEnabled)
      .put("focused", node.isFocused)
      .put("bounds", JSONObject()
        .put("left", bounds.left).put("top", bounds.top)
        .put("right", bounds.right).put("bottom", bounds.bottom))
    val children = JSONArray()
    if (depth >= 30 || state.count >= 500) {
      if (node.childCount > 0) state.truncated = true
    } else {
      for (index in 0 until node.childCount) {
        if (state.count >= 500) {
          state.truncated = true
          break
        }
        node.getChild(index)?.let { child -> children.put(encodeNode(child, "$nodeId.$index", depth + 1, state)) }
      }
    }
    return out.put("children", children)
  }

  private fun limited(value: CharSequence?): String {
    val text = value?.toString() ?: ""
    return if (text.length <= 500) text else text.take(500)
  }

  private fun nodeAction(selector: JSONObject?, action: Int, climb: Boolean): JSONObject {
    var node = findNode(selector) ?: return failure("node_not_found", "Accessibility node not found")
    if (climb) {
      while (!node.isClickable) node = node.parent ?: break
    }
    return if (node.performAction(action)) success() else failure("action_failed", "Accessibility action was rejected")
  }

  private fun inputText(selector: JSONObject?, text: String): JSONObject {
    val node = findNode(selector) ?: return failure("node_not_found", "Accessibility node not found")
    node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val args = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }
    return if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) success()
    else failure("action_failed", "Input action was rejected")
  }

  private fun scroll(selector: JSONObject?, direction: String): JSONObject {
    var node = findNode(selector) ?: rootInActiveWindow
      ?: return failure("no_active_window", "No active accessibility window")
    while (!node.isScrollable) node = node.parent ?: break
    val action = when (direction.lowercase()) {
      "backward", "up", "left" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
      else -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
    }
    return if (node.performAction(action)) success() else failure("action_failed", "Scroll action was rejected")
  }

  private fun globalAction(action: Int): JSONObject =
    if (performGlobalAction(action)) success() else failure("action_failed", "Global action was rejected")

  private fun launch(packageName: String): JSONObject {
    if (packageName.isBlank()) return failure("invalid_package", "package is required")
    val intent = packageManager.getLaunchIntentForPackage(packageName)
      ?: return failure("package_not_found", "No launchable app for $packageName")
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    startActivity(intent)
    return success()
  }

  private fun findNode(selector: JSONObject?): AccessibilityNodeInfo? {
    val root = rootInActiveWindow ?: return null
    if (selector == null || selector.length() == 0) return root
    val nodeId = selector.optString("nodeId")
    if (nodeId.isNotBlank()) return nodeAtPath(root, nodeId)
    val viewId = selector.optString("viewId")
    if (viewId.isNotBlank()) root.findAccessibilityNodeInfosByViewId(viewId).firstOrNull()?.let { return it }
    val text = selector.optString("text")
    if (text.isNotBlank()) root.findAccessibilityNodeInfosByText(text).firstOrNull()?.let { return it }
    return breadthFirst(root) { node ->
      val description = selector.optString("description")
      if (description.isNotBlank() && node.contentDescription?.toString() == description) return@breadthFirst true
      selector.optJSONObject("bounds")?.let { wanted ->
        val actual = android.graphics.Rect().also(node::getBoundsInScreen)
        return@breadthFirst actual.left == wanted.optInt("left") && actual.top == wanted.optInt("top") &&
          actual.right == wanted.optInt("right") && actual.bottom == wanted.optInt("bottom")
      }
      false
    }
  }

  private fun nodeAtPath(root: AccessibilityNodeInfo, nodeId: String): AccessibilityNodeInfo? {
    val parts = nodeId.split('.')
    if (parts.firstOrNull() != "0") return null
    var node = root
    for (part in parts.drop(1)) node = node.getChild(part.toIntOrNull() ?: return null) ?: return null
    return node
  }

  private fun breadthFirst(root: AccessibilityNodeInfo, matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
    val queue = ArrayDeque<AccessibilityNodeInfo>()
    queue.add(root)
    var seen = 0
    while (queue.isNotEmpty() && seen++ < 500) {
      val node = queue.removeFirst()
      if (matches(node)) return node
      for (index in 0 until node.childCount) node.getChild(index)?.let(queue::addLast)
    }
    return null
  }

  private fun success(): JSONObject = JSONObject().put("ok", true)
  private fun failure(code: String, error: String): JSONObject =
    JSONObject().put("ok", false).put("code", code).put("error", error)
}
