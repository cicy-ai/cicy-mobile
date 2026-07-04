package expo.modules.cicyshareintent

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import expo.modules.core.interfaces.ReactActivityLifecycleListener

// Catches ACTION_SEND (text/*) from the system share sheet — both the cold
// start (onCreate carries the launch intent) and the warm share into a running
// app (onNewIntent; MainActivity is singleTask in the Expo template).
class CicyShareIntentActivityLifecycleListener : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
    handle(activity.intent)
  }

  override fun onNewIntent(intent: Intent): Boolean {
    handle(intent)
    return false
  }

  private fun handle(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_SEND) return
    if (intent.type?.startsWith("text/") != true) return
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
    // Subject first when it adds information (e.g. a page title above its URL).
    val combined = when {
      subject.isNotEmpty() && text.isNotEmpty() && !text.contains(subject) -> "$subject\n$text"
      text.isNotEmpty() -> text
      else -> subject
    }
    if (combined.isNotEmpty()) ShareIntentStore.offer(combined)
    // Strip the extra so an Activity recreate (rotation/theme) can't re-offer it.
    intent.removeExtra(Intent.EXTRA_TEXT)
    intent.removeExtra(Intent.EXTRA_SUBJECT)
  }
}
