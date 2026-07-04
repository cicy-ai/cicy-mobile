package expo.modules.cicyshareintent

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

// Registers the ACTION_SEND lifecycle listener. Discovery is BY CONVENTION:
// expo-modules-autolinking scans the module for `*Package.kt` files importing
// expo.modules.core.interfaces.Package and adds them to the generated package
// list — there is NO expo-module.config.json key for this (a
// "reactActivityLifecycleListeners" entry there is silently ignored).
class CicyShareIntentPackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> {
    return listOf(CicyShareIntentActivityLifecycleListener())
  }
}
