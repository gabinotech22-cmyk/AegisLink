/**
 * Expo config plugin — embedded Tor (sealed-sender Fase 4 Tier 2, Android).
 *
 * Embeds Guardian Project's C-Tor (the battle-tested binary Briar ships) so the
 * mailbox transport can route over Tor WITHOUT requiring the user to install
 * Orbot. See docs/FASE4-TOR-EMBEDDED-IMPL.md and docs/FASE4-TOR-TRANSPORT-DESIGN.md.
 *
 * Keeps `expo prebuild --clean` reproducible by regenerating, every time:
 *   1. Adds the Guardian Project maven repo to allprojects.repositories.
 *   2. Adds the tor-android + jtorctl + socket.io-client-java + localbroadcastmanager
 *      Gradle dependencies to app/build.gradle.
 *   3. Writes AegisTorModule.kt + AegisTorPackage.kt into the app package dir.
 *   4. Registers AegisTorPackage() in MainApplication.kt's getPackages().
 *
 * INTERNET permission is already declared (app.json). ACCESS_LOCAL_NETWORK is only
 * needed if we ever target API 37 AND expose the SOCKS port to the LAN — we don't.
 *
 * Phase scope: this file currently ships F1 (Tor lifecycle + bootstrap). The F2
 * generic socket.io-over-SOCKS bridge methods will be added to AegisTorModule.kt
 * here in the same plugin.
 */
const {
  withAppBuildGradle,
  withProjectBuildGradle,
  withMainApplication,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ── 1. Guardian Project maven repo ───────────────────────────────────────────
// tor-android / jtorctl are published to gpmaven (a git-backed maven repo), not
// Maven Central. This project's settings.gradle has no dependencyResolutionManagement,
// so repos declared in allprojects.repositories are honored.
const GPMAVEN_BLOCK = `
// ─── AegisLink: Guardian Project maven (embedded Tor — injected by withTorEmbedded.js) ───
allprojects {
    repositories {
        maven { url 'https://raw.githubusercontent.com/guardianproject/gpmaven/master' }
    }
}
`;

function withGpMavenRepo(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') return config;
    if (!config.modResults.contents.includes('AegisLink: Guardian Project maven')) {
      config.modResults.contents += GPMAVEN_BLOCK;
    }
    return config;
  });
}

// ── 2. Gradle dependencies ───────────────────────────────────────────────────
const TOR_DEPS_BLOCK = `
// ─── AegisLink: embedded Tor dependencies (injected by withTorEmbedded.js) ───
dependencies {
    // tor-android 0.4.8.16 is the newest published in gpmaven (Maven Central tops
    // out at 0.4.7.14). jtorctl rides along from the same repo.
    implementation("info.guardianproject:tor-android:0.4.8.16")
    implementation("info.guardianproject:jtorctl:0.4.5.7")
    // socket.io-client (artifactId has no -java suffix despite the GitHub repo name):
    // lets us run the mailbox socket over an OkHttp client configured with Tor's
    // local SOCKS proxy (RN's JS WebSocket can't do SOCKS).
    implementation("io.socket:socket.io-client:2.1.2")
    // Tor status broadcasts arrive via LocalBroadcastManager.
    implementation("androidx.localbroadcastmanager:localbroadcastmanager:1.1.0")
}
`;

function withTorDependencies(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') return config;
    if (!config.modResults.contents.includes('AegisLink: embedded Tor dependencies')) {
      config.modResults.contents += TOR_DEPS_BLOCK;
    }
    return config;
  });
}

// ── 3. Kotlin sources ────────────────────────────────────────────────────────
const KT = {
  'AegisTorModule.kt': `package com.aegislink.app

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.os.IBinder
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.torproject.jni.TorService

/**
 * AegisTor — embedded Tor lifecycle (Fase 4 Tier 2, F1).
 *
 * Binds Guardian Project's TorService, surfaces bootstrap status to JS, and
 * exposes the local SOCKS port the mailbox transport will route through. The
 * audited crypto stays in JS; this module only owns the Tor process + (later)
 * a dumb socket.io-over-SOCKS pipe.
 */
class AegisTorModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var torService: TorService? = null
  private var bound = false
  private var state: String = "off"
  private var startPromise: Promise? = null
  private var receiverRegistered = false

  override fun getName(): String = "AegisTor"

  private val statusReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      when (intent?.getStringExtra(TorService.EXTRA_STATUS)) {
        TorService.STATUS_STARTING -> updateState("starting")
        TorService.STATUS_ON -> {
          updateState("on")
          startPromise?.let {
            it.resolve(makeStatusMap("on", torService?.socksPort ?: 0))
            startPromise = null
          }
        }
        TorService.STATUS_STOPPING -> updateState("stopping")
        TorService.STATUS_OFF -> updateState("off")
      }
    }
  }

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      torService = (binder as? TorService.LocalBinder)?.service
      bound = true
    }
    override fun onServiceDisconnected(name: ComponentName?) {
      torService = null
      bound = false
    }
  }

  @ReactMethod
  fun start(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      if (!receiverRegistered) {
        LocalBroadcastManager.getInstance(ctx)
          .registerReceiver(statusReceiver, IntentFilter(TorService.ACTION_STATUS))
        receiverRegistered = true
      }
      if (state == "on") {
        promise.resolve(makeStatusMap("on", torService?.socksPort ?: 0))
        return
      }
      // Resolve once STATUS_ON arrives via the broadcast receiver.
      startPromise = promise
      ctx.bindService(Intent(ctx, TorService::class.java), connection, Context.BIND_AUTO_CREATE)
    } catch (e: Exception) {
      startPromise = null
      promise.reject("E_TOR_START", e)
    }
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    promise.resolve(makeStatusMap(state, torService?.socksPort ?: 0))
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      if (bound) {
        try { ctx.unbindService(connection) } catch (_: Exception) {}
        bound = false
      }
      if (receiverRegistered) {
        try { LocalBroadcastManager.getInstance(ctx).unregisterReceiver(statusReceiver) } catch (_: Exception) {}
        receiverRegistered = false
      }
      ctx.stopService(Intent(ctx, TorService::class.java))
      torService = null
      updateState("off")
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_TOR_STOP", e)
    }
  }

  private fun updateState(s: String) {
    state = s
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AegisTorStatus", makeStatusMap(s, torService?.socksPort ?: 0))
  }

  private fun makeStatusMap(s: String, port: Int): WritableMap {
    val map = Arguments.createMap()
    map.putString("state", s)
    map.putInt("socksPort", port)
    return map
  }

  // RN event-emitter contract (no-ops; required so NativeEventEmitter is happy).
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
`,
  'AegisTorPackage.kt': `package com.aegislink.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AegisTorPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(AegisTorModule(reactContext))

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

// ── 4. Register the package in MainApplication.kt ────────────────────────────
function withPackageRegistration(config) {
  return withMainApplication(config, (config) => {
    let src = config.modResults.contents;
    if (!src.includes('AegisTorPackage()')) {
      src = src.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{)/,
        '$1\n              add(AegisTorPackage())',
      );
      config.modResults.contents = src;
    }
    return config;
  });
}

module.exports = (config) => {
  config = withGpMavenRepo(config);
  config = withTorDependencies(config);
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  return config;
};
