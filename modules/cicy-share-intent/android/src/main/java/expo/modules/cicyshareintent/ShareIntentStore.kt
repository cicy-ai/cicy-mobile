package expo.modules.cicyshareintent

// Hand-off buffer between the Activity lifecycle listener (which sees the
// ACTION_SEND intent) and the JS module. Cold start: the intent arrives before
// JS subscribes → parked in `pending`, drained by getInitialShare(). Warm share
// (app already running, onNewIntent): the JS listener is live → pushed as an
// event immediately.
object ShareIntentStore {
  private var pending: String? = null
  var listener: ((String) -> Unit)? = null

  @Synchronized
  fun offer(text: String) {
    val l = listener
    if (l != null) l(text) else pending = text
  }

  @Synchronized
  fun consume(): String? {
    val p = pending
    pending = null
    return p
  }
}
