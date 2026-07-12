/**
 * Expo config plugin — Android persistent call-wake foreground service.
 *
 * Distinct from withCallForegroundService.js (type=microphone, alive only during
 * an ACTIVE call). This one keeps the app PROCESS + JS runtime resident 24/7 so
 * an incoming call rings even when the app was swiped away — WITHOUT Google/FCM.
 * It is the Android half of docs/FASE4-CALL-WAKE-DESIGN.md (iOS is forced onto
 * VoIP/APNs by the platform and unaffected here).
 *
 * How it wakes a killed app: Android kills the whole process on swipe-away. A
 * foreground service keeps the process alive; AegisWakeService is a
 * HeadlessJsTaskService, so when Android (re)starts it (START_STICKY, or the
 * boot receiver after a reboot) it spins up the JS task "AegisCallWake", which
 * connects the relay socket over Tor and attaches the call handlers — all the
 * sealed-sender crypto stays in the audited JS layer (native never sees keys).
 *
 * Pieces:
 *   1. <service AegisWakeService type=dataSync> + <receiver AegisWakeBootReceiver>
 *      (BOOT_COMPLETED) in AndroidManifest.
 *   2. AegisWakeService/Module/BootReceiver/Package .kt into the app package dir.
 *   3. Register AegisWakePackage() in MainApplication.kt.
 *
 * Permissions (FOREGROUND_SERVICE, FOREGROUND_SERVICE_DATA_SYNC,
 * RECEIVE_BOOT_COMPLETED, POST_NOTIFICATIONS) are declared in app.json.
 */
const {
  withAndroidManifest,
  withMainApplication,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = 'com.aegislink.app.AegisWakeService';
const RECEIVER_NAME = 'com.aegislink.app.AegisWakeBootReceiver';

// ── 1. Manifest service + boot receiver ──────────────────────────────────────
function withServiceManifest(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;

    app.service = app.service || [];
    if (!app.service.some((s) => s.$?.['android:name'] === SERVICE_NAME)) {
      app.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:exported': 'false',
          'android:foregroundServiceType': 'dataSync',
        },
      });
    }

    app.receiver = app.receiver || [];
    if (!app.receiver.some((r) => r.$?.['android:name'] === RECEIVER_NAME)) {
      app.receiver.push({
        // exported=true so the system BOOT_COMPLETED broadcast can reach it.
        $: { 'android:name': RECEIVER_NAME, 'android:exported': 'true' },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
              { $: { 'android:name': 'android.intent.action.LOCKED_BOOT_COMPLETED' } },
            ],
          },
        ],
      });
    }
    return config;
  });
}

// ── 2. Kotlin sources ────────────────────────────────────────────────────────
const KT = {
  'AegisWakeService.kt': `package com.aegislink.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Persistent foreground service that keeps the app process (and thus the JS
 * relay socket over Tor) resident so an incoming call can ring with the app
 * killed. Extends HeadlessJsTaskService: on (re)start it runs the JS task
 * "AegisCallWake" with no timeout; the JS side connects and returns a promise
 * that stays pending, and the foreground notification keeps the process alive.
 */
class AegisWakeService : HeadlessJsTaskService() {
  companion object {
    const val CHANNEL_ID = "aegis_wake"
    const val NOTIF_ID = 4712
    const val ACTION_START = "com.aegislink.app.WAKE_START"
    const val ACTION_STOP = "com.aegislink.app.WAKE_STOP"
    const val TASK_NAME = "AegisCallWake"
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }
    startForegroundInternal()
    // Launch the JS task (HeadlessJsTaskService reads getTaskConfig below).
    super.onStartCommand(intent, flags, startId)
    // STICKY: if Android reclaims us, restart to re-establish the wake socket.
    return START_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    // timeout 0 = run until we stop; allowedInForeground = true so it runs even
    // when the app UI is also foregrounded (idempotent with the app's socket).
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true)

  // Do NOT stop the service when the JS task settles — startForeground keeps the
  // process resident so the socket survives. The default impl would stopSelf().
  override fun onHeadlessJsTaskFinish(taskId: Int) { /* keep the service alive */ }

  private fun startForegroundInternal() {
    createChannel()
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pi = PendingIntent.getActivity(
      this, 0, launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notif = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("AegisLink")
      .setContentText("Protegiendo tus llamadas E2EE")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(pi)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
        val ch = NotificationChannel(CHANNEL_ID, "Wake de llamadas", NotificationManager.IMPORTANCE_MIN)
        ch.setShowBadge(false)
        ch.lockscreenVisibility = Notification.VISIBILITY_SECRET
        mgr.createNotificationChannel(ch)
      }
    }
  }
}
`,
  'AegisWakeModule.kt': `package com.aegislink.app

import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AegisWakeModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "AegisWakeService"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      // Persist the opt-in so the boot receiver restarts us after a reboot.
      ctx.getSharedPreferences("aegis_wake", Context.MODE_PRIVATE)
        .edit().putBoolean("enabled", true).apply()
      val intent = Intent(ctx, AegisWakeService::class.java).apply {
        action = AegisWakeService.ACTION_START
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_WAKE_START", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      ctx.getSharedPreferences("aegis_wake", Context.MODE_PRIVATE)
        .edit().putBoolean("enabled", false).apply()
      val intent = Intent(ctx, AegisWakeService::class.java).apply {
        action = AegisWakeService.ACTION_STOP
      }
      ctx.startService(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_WAKE_STOP", e)
    }
  }

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}
}
`,
  'AegisWakeBootReceiver.kt': `package com.aegislink.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Restart the wake service after a reboot so call-wake survives without the user
 * reopening the app. Only starts if the user previously enabled it (a marker
 * file written by the JS layer via AegisWakeModule.start's first run); absent
 * the marker we do nothing, so users who never opted in aren't forced into a
 * persistent notification on every boot.
 */
class AegisWakeBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    val act = intent?.action ?: return
    if (act != Intent.ACTION_BOOT_COMPLETED &&
        act != "android.intent.action.LOCKED_BOOT_COMPLETED") return
    val ctx = context ?: return
    // Opt-in marker written by the JS layer (see callWakeService.ts).
    val enabled = ctx.getSharedPreferences("aegis_wake", Context.MODE_PRIVATE)
      .getBoolean("enabled", false)
    if (!enabled) return
    val svc = Intent(ctx, AegisWakeService::class.java).apply {
      action = AegisWakeService.ACTION_START
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ctx.startForegroundService(svc)
    } else {
      ctx.startService(svc)
    }
  }
}
`,
  'AegisWakePackage.kt': `package com.aegislink.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AegisWakePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(AegisWakeModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`,
};

function withKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const pkgDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', 'com', 'aegislink', 'app',
      );
      fs.mkdirSync(pkgDir, { recursive: true });
      for (const [file, contents] of Object.entries(KT)) {
        fs.writeFileSync(path.join(pkgDir, file), contents);
      }
      return config;
    },
  ]);
}

// ── 3. Register the package in MainApplication.kt ────────────────────────────
function withPackageRegistration(config) {
  return withMainApplication(config, (config) => {
    let src = config.modResults.contents;
    if (!src.includes('AegisWakePackage()')) {
      src = src.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{)/,
        '$1\n              add(AegisWakePackage())',
      );
      config.modResults.contents = src;
    }
    return config;
  });
}

module.exports = (config) => {
  config = withServiceManifest(config);
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  return config;
};
