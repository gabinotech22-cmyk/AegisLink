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
    // Exclude its bundled org.json: Android ships org.json in the bootclasspath
    // (wins at runtime), so packaging the Maven copy makes R8 bind callers (incl.
    // expo-updates) to methods the platform class lacks → NoSuchMethodError crash
    // at startup. socket.io-client only uses the basic JSONObject/JSONArray API
    // that Android already provides.
    implementation("io.socket:socket.io-client:2.1.2") {
        exclude group: "org.json", module: "json"
    }
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
import android.util.Log
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.Polling
import io.socket.engineio.client.transports.WebSocket
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.torproject.jni.TorService
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.ConcurrentHashMap

/**
 * AegisTor — embedded Tor (Fase 4 Tier 2).
 *
 * Two responsibilities, one module (see docs/FASE4-TOR-EMBEDDED-IMPL.md):
 *   F1: bind Guardian Project's TorService, surface bootstrap status to JS, and
 *       expose the local SOCKS port the mailbox transport routes through.
 *   F2: a DUMB, reusable socket.io-over-SOCKS pipe — \`sioConnect/sioEmit/
 *       sioDisconnect\` run a socket.io-client-java connection over an OkHttp
 *       client bound to Tor's SOCKS proxy (RN's JS WebSocket can't do SOCKS),
 *       forwarding every event verbatim to JS as "AegisTorSio". The native side
 *       never interprets payloads — all protocol logic (possession proofs,
 *       multi-epoch catch-up, sealed v2) stays in the audited JS layer.
 */
class AegisTorModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var torService: TorService? = null
  private var bound = false
  private var state: String = "off"
  private var startPromise: Promise? = null
  private var receiverRegistered = false
  // Last known SOCKS port (survives transient unbind so sioConnect can route).
  private var cachedSocksPort: Int = 0
  // Live socket.io-over-Tor connections, keyed by the JS-supplied id.
  private val sockets = ConcurrentHashMap<String, Socket>()

  override fun getName(): String = "AegisTor"

  // Diagnostic logging — gated behind BuildConfig.DEBUG so RELEASE builds emit
  // NOTHING to logcat. Golden rule #6: no diagnostic metadata (event names,
  // connection lifecycle, mailbox timing) leaks in production. The LOG_TAG
  // constant lets the helpers call Log directly without recursing into dlog.
  private val LOG_TAG = "AegisTor"
  private fun dlog(msg: String) { if (BuildConfig.DEBUG) Log.i(LOG_TAG, msg) }
  private fun dwarn(msg: String) { if (BuildConfig.DEBUG) Log.w(LOG_TAG, msg) }

  private fun socksPort(): Int {
    val live = torService?.socksPort ?: 0
    if (live > 0) cachedSocksPort = live
    return if (live > 0) live else cachedSocksPort
  }

  private val statusReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      when (intent?.getStringExtra(TorService.EXTRA_STATUS)) {
        TorService.STATUS_STARTING -> updateState("starting")
        TorService.STATUS_ON -> {
          updateState("on")
          startPromise?.let {
            it.resolve(makeStatusMap("on", socksPort()))
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
        promise.resolve(makeStatusMap("on", socksPort()))
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
    promise.resolve(makeStatusMap(state, socksPort()))
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
    dlog("state=" + s + " socksPort=" + socksPort())
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AegisTorStatus", makeStatusMap(s, socksPort()))
  }

  private fun makeStatusMap(s: String, port: Int): WritableMap {
    val map = Arguments.createMap()
    map.putString("state", s)
    map.putInt("socksPort", port)
    return map
  }

  // ── F2: socket.io-over-SOCKS bridge ─────────────────────────────────────────
  // A dumb pipe. JS owns the protocol; the native side only carries socket.io
  // frames over Tor's SOCKS proxy and forwards every event verbatim.

  /** OkHttp client whose every connection is dialed through Tor's local SOCKS5. */
  private fun torOkHttp(port: Int): OkHttpClient =
    OkHttpClient.Builder()
      // OkHttp passes the (unresolved) host to the SOCKS proxy for remote DNS,
      // which is exactly what .onion resolution needs — no custom Dns required.
      .proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port)))
      .build()

  /**
   * Open a socket.io connection over Tor. authJson is an object whose values
   * are ALL strings (the catch-up binds array is pre-serialized to a JSON
   * string by JS — the relay tolerates it), matching socket.io-client-java's
   * Map<String,String> handshake auth. eventsJson is a JSON array of the
   * custom event names to forward (lifecycle events are always forwarded).
   */
  @ReactMethod
  fun sioConnect(id: String, url: String, authJson: String, eventsJson: String, promise: Promise) {
    try {
      val port = socksPort()
      if (port <= 0) { promise.reject("E_TOR_NOT_READY", "Tor SOCKS port unavailable"); return }
      val client = torOkHttp(port)
      val opts = IO.Options()
      opts.callFactory = client
      opts.webSocketFactory = client
      // Polling first (works over OkHttp's SOCKS proxy → Tor → .onion), with an
      // opportunistic upgrade to WebSocket. Forcing websocket-only fails over
      // SOCKS (OkHttp's WS path doesn't reach the .onion; the HS sees 0 conns),
      // while polling on the same client connects fine.
      opts.transports = arrayOf(Polling.NAME, WebSocket.NAME)
      val authObj = JSONObject(authJson)
      val authMap = HashMap<String, String>()
      val keys = authObj.keys()
      while (keys.hasNext()) { val k = keys.next(); authMap[k] = authObj.getString(k) }
      opts.auth = authMap
      opts.reconnection = true

      dlog("sioConnect id=" + id + " url=" + url + " viaSocksPort=" + port)
      val socket = IO.socket(url, opts)
      sockets[id] = socket

      socket.on(Socket.EVENT_CONNECT) { _ -> dlog("sio connect id=" + id); forward(id, "connect", JSONArray()) }
      socket.on(Socket.EVENT_DISCONNECT) { args -> dlog("sio disconnect id=" + id); forward(id, "disconnect", argsToJson(args)) }
      socket.on(Socket.EVENT_CONNECT_ERROR) { args ->
        val detail = args.joinToString { a ->
          if (a is Throwable) a.javaClass.simpleName + ":" + a.message + " <-cause " + (a.cause?.javaClass?.name ?: "none") + ":" + (a.cause?.message ?: "")
          else a.toString()
        }
        dwarn("sio connect_error id=" + id + " " + detail)
        forward(id, "connect_error", argsToJson(args))
      }

      val events = JSONArray(eventsJson)
      for (i in 0 until events.length()) {
        val ev = events.getString(i)
        socket.on(ev) { args -> dlog("sio event id=" + id + " ev=" + ev); forward(id, ev, argsToJson(args)) }
      }

      socket.connect()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_SIO_CONNECT", e)
    }
  }

  /**
   * Emit one event with a single JSON payload. If ackId is non-null the relay's
   * ack is forwarded to JS as the synthetic event __ack:ackId.
   */
  @ReactMethod
  fun sioEmit(id: String, event: String, payloadJson: String, ackId: String?, promise: Promise) {
    try {
      val socket = sockets[id] ?: run { promise.reject("E_SIO_NO_SOCKET", "no socket: \$id"); return }
      dlog("sio emit id=" + id + " ev=" + event)
      val payload = parseJsonValue(payloadJson)
      if (ackId != null) {
        socket.emit(event, arrayOf<Any?>(payload), Ack { args -> forward(id, "__ack:\$ackId", argsToJson(args)) })
      } else {
        socket.emit(event, payload)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_SIO_EMIT", e)
    }
  }

  @ReactMethod
  fun sioDisconnect(id: String, promise: Promise) {
    try {
      sockets.remove(id)?.let { it.off(); it.disconnect() }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_SIO_DISCONNECT", e)
    }
  }

  private fun forward(id: String, event: String, args: JSONArray) {
    val map = Arguments.createMap()
    map.putString("id", id)
    map.putString("event", event)
    map.putString("args", args.toString())
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AegisTorSio", map)
  }

  private fun argsToJson(args: Array<out Any?>?): JSONArray {
    val arr = JSONArray()
    if (args != null) for (a in args) arr.put(a ?: JSONObject.NULL)
    return arr
  }

  private fun parseJsonValue(s: String): Any {
    val t = s.trim()
    return when {
      t.startsWith("{") -> JSONObject(t)
      t.startsWith("[") -> JSONArray(t)
      else -> t
    }
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

// ── 3b. Keep Tor's JNI surface from R8 minification ──────────────────────────
// libtor.so reaches into these classes via JNI by their ORIGINAL names; if R8
// renames/strips them, JNI lookups crash at runtime (NoSuchFieldError on the
// native `torConfiguration` long pointer, NoSuchMethodError on native methods).
const TOR_PROGUARD_RULES = `
# ─── AegisLink: embedded Tor JNI keep rules (injected by withTorEmbedded.js) ───
-keep class org.torproject.jni.** { *; }
-keep class IPtProxy.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}
`;

function withTorProguardRules(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const proguardPath = path.join(
        config.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro',
      );
      let contents = fs.existsSync(proguardPath) ? fs.readFileSync(proguardPath, 'utf8') : '';
      if (!contents.includes('org.torproject.jni')) {
        fs.writeFileSync(proguardPath, contents + TOR_PROGUARD_RULES);
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
  config = withTorProguardRules(config);
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  return config;
};
