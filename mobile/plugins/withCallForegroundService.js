/**
 * Expo config plugin — Android call foreground service.
 *
 * Keeps `expo prebuild --clean` reproducible: regenerates the native pieces that
 * keep a live voice call alive when the app is backgrounded.
 *   1. Registers <service AegisCallService type=microphone> in AndroidManifest.
 *   2. Writes AegisCallService/Module/Package .kt into the app package dir.
 *   3. Registers AegisCallPackage() in MainApplication.kt's getPackages().
 *
 * The FOREGROUND_SERVICE / FOREGROUND_SERVICE_MICROPHONE permissions are declared
 * in app.json (android.permissions), so they are not re-added here.
 */
const {
  withAndroidManifest,
  withMainApplication,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = 'com.aegislink.app.AegisCallService';

// ── 1. Manifest service ──────────────────────────────────────────────────────
function withServiceManifest(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;
    app.service = app.service || [];
    const exists = app.service.some((s) => s.$?.['android:name'] === SERVICE_NAME);
    if (!exists) {
      app.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:exported': 'false',
          'android:foregroundServiceType': 'microphone',
        },
      });
    }
    return config;
  });
}

// ── 2. Kotlin sources ────────────────────────────────────────────────────────
const KT = {
  'AegisCallService.kt': `package com.aegislink.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class AegisCallService : Service() {
  companion object {
    const val CHANNEL_ID = "aegis_call"
    const val NOTIF_ID = 4711
    const val ACTION_START = "com.aegislink.app.CALL_START"
    const val ACTION_STOP = "com.aegislink.app.CALL_STOP"
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }
    startForegroundInternal(intent?.getStringExtra("title"), intent?.getStringExtra("text"))
    return START_STICKY
  }

  private fun startForegroundInternal(title: String?, text: String?) {
    createChannel()
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pi = PendingIntent.getActivity(
      this,
      0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notif = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title ?: "AegisLink")
      .setContentText(text ?: "Llamada en curso")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(pi)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
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
        val ch = NotificationChannel(CHANNEL_ID, "Llamadas activas", NotificationManager.IMPORTANCE_LOW)
        ch.setShowBadge(false)
        ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        mgr.createNotificationChannel(ch)
      }
    }
  }
}
`,
  'AegisCallModule.kt': `package com.aegislink.app

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AegisCallModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "AegisCallService"

  @ReactMethod
  fun start(title: String?, text: String?, promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent = Intent(ctx, AegisCallService::class.java).apply {
        action = AegisCallService.ACTION_START
        putExtra("title", title)
        putExtra("text", text)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_FGS_START", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent = Intent(ctx, AegisCallService::class.java).apply {
        action = AegisCallService.ACTION_STOP
      }
      ctx.startService(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_FGS_STOP", e)
    }
  }

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}
}
`,
  'AegisCallPackage.kt': `package com.aegislink.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AegisCallPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(AegisCallModule(reactContext))

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
    if (!src.includes('AegisCallPackage()')) {
      src = src.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{)/,
        '$1\n              add(AegisCallPackage())',
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
