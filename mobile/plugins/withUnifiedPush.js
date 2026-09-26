/**
 * Expo config plugin — UnifiedPush connector (Android; Slice 2b.3c,
 * docs/FASE4-SLICE2B-PUSH-DESIGN.md §9).
 *
 * Wakes a KILLED app without Google: the user's UnifiedPush distributor (the
 * ntfy app, Sunup, NextPush…) keeps ONE socket for every UnifiedPush app on
 * the phone; the relay POSTs an empty wake to the endpoint the distributor
 * handed us, bound to the current-epoch mailbox over the authenticated mailbox
 * socket (`mailbox:push:endpoint`, server/src/relay/handler.ts). No token of
 * Google or Apple is involved, so it works in the `foss` build and on
 * de-Googled phones — and also in the Play build, which has no FCM either.
 *
 * Pieces:
 *   1. Gradle: org.unifiedpush.android:connector (Apache-2.0; its only runtime
 *      dependency is Tink, Apache-2.0 — nothing from Play Services, so
 *      withFossPush's exclusions leave it alone).
 *   2. Manifest: AegisUnifiedPushService (the connector's PushService, NOT
 *      exported, action PUSH_EVENT) and AegisMailboxWakeService (a short
 *      HeadlessJsTaskService that runs the JS task "AegisMailboxWake").
 *   3. Kotlin sources into the app package + AegisUnifiedPushPackage
 *      registered in MainApplication.
 *
 * Privacy (R1): the JS side registers ONE UnifiedPush instance per mailbox
 * epoch (`e<epoch>`), so every epoch gets a fresh endpoint and the relay never
 * sees one endpoint across two epochs (src/notifications/unifiedPush.ts).
 * The message body is ignored: a wake only means "drain the mailbox" (R2).
 *
 * NOT YET VALIDATED ON A DEVICE: needs a prebuilt APK with a distributor
 * installed (e.g. the ntfy app pointed at our relay's clearnet ntfy, 2b.3a).
 */
const {
  withAppBuildGradle,
  withAndroidManifest,
  withMainApplication,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const CONNECTOR = 'org.unifiedpush.android:connector:3.3.5';
const PKG = 'com.aegislink.app';
const PUSH_SERVICE = `${PKG}.AegisUnifiedPushService`;
const WAKE_SERVICE = `${PKG}.AegisMailboxWakeService`;
const PUSH_EVENT = 'org.unifiedpush.android.connector.PUSH_EVENT';
const MARKER = 'AegisLink: UnifiedPush connector';

// ── 1. Gradle dependency ─────────────────────────────────────────────────────
function withConnectorDependency(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('[withUnifiedPush] expected a groovy build.gradle');
    }
    const src = config.modResults.contents;
    if (src.includes(MARKER)) return config;
    config.modResults.contents = src.replace(
      /dependencies\s*\{/,
      `dependencies {\n    // ${MARKER} (plugins/withUnifiedPush.js)\n    implementation("${CONNECTOR}")`,
    );
    if (config.modResults.contents === src) {
      throw new Error('[withUnifiedPush] no dependencies block in app/build.gradle');
    }
    return config;
  });
}

// ── 2. Manifest ──────────────────────────────────────────────────────────────
function withServicesManifest(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;
    app.service = app.service || [];
    if (!app.service.some((s) => s.$?.['android:name'] === PUSH_SERVICE)) {
      app.service.push({
        // Not exported: the connector's own (exported) receiver talks to the
        // distributor and hands events to this service inside our app.
        $: { 'android:name': PUSH_SERVICE, 'android:exported': 'false' },
        'intent-filter': [{ action: [{ $: { 'android:name': PUSH_EVENT } }] }],
      });
    }
    if (!app.service.some((s) => s.$?.['android:name'] === WAKE_SERVICE)) {
      app.service.push({ $: { 'android:name': WAKE_SERVICE, 'android:exported': 'false' } });
    }
    return config;
  });
}

// ── 3. Kotlin sources ────────────────────────────────────────────────────────
const KT = {
  'AegisUnifiedPushService.kt': `package ${PKG}

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * UnifiedPush events from the user's distributor (plugins/withUnifiedPush.js).
 * Holds no keys and reads no content: a message only means "drain the
 * mailbox", which the audited JS layer does over Tor.
 */
class AegisUnifiedPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    AegisUnifiedPushStore.setEndpoint(this, instance, endpoint.url)
    // Let JS bind it on the relay: a live app gets an event; a killed one a
    // short wake run, whose mailbox authentication binds the new endpoint.
    if (!AegisUnifiedPushModule.emitEndpoint(instance)) AegisMailboxWakeService.start(this)
  }

  override fun onMessage(message: PushMessage, instance: String) {
    // Empty wake by design (R2): the body is never read.
    AegisMailboxWakeService.start(this)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    AegisUnifiedPushStore.clear(this, instance)
  }

  override fun onUnregistered(instance: String) {
    AegisUnifiedPushStore.clear(this, instance)
  }
}
`,
  'AegisUnifiedPushStore.kt': `package ${PKG}

import android.content.Context

/** Endpoint per UnifiedPush instance (one instance per mailbox epoch). Not secret: the relay holds it too. */
object AegisUnifiedPushStore {
  private const val PREFS = "aegis_unifiedpush"
  private const val PREFIX = "ep:"

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun setEndpoint(c: Context, instance: String, url: String) {
    prefs(c).edit().putString(PREFIX + instance, url).apply()
  }

  fun endpoint(c: Context, instance: String): String? = prefs(c).getString(PREFIX + instance, null)

  fun instances(c: Context): List<String> =
    prefs(c).all.keys.filter { it.startsWith(PREFIX) }.map { it.removePrefix(PREFIX) }

  fun clear(c: Context, instance: String) {
    prefs(c).edit().remove(PREFIX + instance).apply()
  }

  fun clearAll(c: Context) {
    prefs(c).edit().clear().apply()
  }
}
`,
  'AegisMailboxWakeService.kt': `package ${PKG}

import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * A short headless JS run ("AegisMailboxWake", src/notifications/unifiedPush.ts)
 * that reconnects the mailbox over Tor and drains it. Started by a UnifiedPush
 * wake; the distributor's broadcast puts the app on the temporary background
 * allowlist, which is what lets this service start with the app killed.
 */
class AegisMailboxWakeService : HeadlessJsTaskService() {
  companion object {
    const val TASK_NAME = "AegisMailboxWake"
    private const val TIMEOUT_MS = 60_000L

    fun start(context: Context) {
      try {
        context.startService(Intent(context, AegisMailboxWakeService::class.java))
        HeadlessJsTaskService.acquireWakeLockNow(context)
      } catch (e: Exception) {
        // Background start refused (no allowlist window): the message stays
        // queued at the relay and drains on the next open. Nothing is lost.
      }
    }
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), TIMEOUT_MS, true)
}
`,
  'AegisUnifiedPushModule.kt': `package ${PKG}

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.unifiedpush.android.connector.UnifiedPush

/** JS surface of the UnifiedPush connector (src/notifications/unifiedPush.ts). */
class AegisUnifiedPushModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  companion object {
    const val EVENT_ENDPOINT = "AegisUnifiedPushEndpoint"
    @Volatile private var live: ReactApplicationContext? = null

    /** Tell a running JS runtime that \`instance\` has a (new) endpoint. False if none is running. */
    fun emitEndpoint(instance: String): Boolean {
      val c = live ?: return false
      if (!c.hasActiveReactInstance()) return false
      c.emitDeviceEvent(EVENT_ENDPOINT, instance)
      return true
    }
  }

  init {
    live = ctx
  }

  override fun getName(): String = "AegisUnifiedPush"

  @ReactMethod
  fun getDistributors(p: Promise) {
    val out = Arguments.createArray()
    UnifiedPush.getDistributors(ctx).forEach { out.pushString(it) }
    p.resolve(out)
  }

  @ReactMethod
  fun getSavedDistributor(p: Promise) {
    p.resolve(UnifiedPush.getSavedDistributor(ctx))
  }

  @ReactMethod
  fun saveDistributor(distributor: String, p: Promise) {
    UnifiedPush.saveDistributor(ctx, distributor)
    p.resolve(true)
  }

  @ReactMethod
  fun register(instance: String, p: Promise) {
    try {
      UnifiedPush.register(ctx, instance, "AegisLink", null)
      p.resolve(true)
    } catch (e: Exception) {
      p.reject("E_UP_REGISTER", e)
    }
  }

  @ReactMethod
  fun unregister(instance: String, p: Promise) {
    UnifiedPush.unregister(ctx, instance)
    AegisUnifiedPushStore.clear(ctx, instance)
    p.resolve(true)
  }

  @ReactMethod
  fun getEndpoint(instance: String, p: Promise) {
    p.resolve(AegisUnifiedPushStore.endpoint(ctx, instance))
  }

  @ReactMethod
  fun getInstances(p: Promise) {
    val out = Arguments.createArray()
    AegisUnifiedPushStore.instances(ctx).forEach { out.pushString(it) }
    p.resolve(out)
  }

  /** Unregister everything and forget the distributor (opt-out, panic wipe). */
  @ReactMethod
  fun removeDistributor(p: Promise) {
    UnifiedPush.removeDistributor(ctx)
    AegisUnifiedPushStore.clearAll(ctx)
    p.resolve(true)
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
`,
  'AegisUnifiedPushPackage.kt': `package ${PKG}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AegisUnifiedPushPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(AegisUnifiedPushModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`,
};

function withKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const pkgDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', ...PKG.split('.'));
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
    if (!src.includes('AegisUnifiedPushPackage()')) {
      const next = src.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{)/,
        '$1\n              add(AegisUnifiedPushPackage())',
      );
      if (next === src) throw new Error('[withUnifiedPush] PackageList block not found in MainApplication');
      config.modResults.contents = next;
    }
    return config;
  });
}

module.exports = function withUnifiedPush(config) {
  config = withConnectorDependency(config);
  config = withServicesManifest(config);
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  return config;
};
module.exports.KT = KT;
module.exports.CONNECTOR = CONNECTOR;
