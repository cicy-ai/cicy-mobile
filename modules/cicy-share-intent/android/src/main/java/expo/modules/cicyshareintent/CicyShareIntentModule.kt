package expo.modules.cicyshareintent

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CicyShareIntentModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CicyShareIntent")
    Events("onShareIntent")

    // Cold-start hand-off: whatever ACTION_SEND arrived before JS was ready.
    Function("getInitialShare") {
      ShareIntentStore.consume()
    }

    OnStartObserving {
      ShareIntentStore.listener = { text ->
        sendEvent("onShareIntent", mapOf("text" to text))
      }
    }
    OnStopObserving {
      ShareIntentStore.listener = null
    }
  }
}
