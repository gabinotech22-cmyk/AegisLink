#!/usr/bin/env node
/**
 * audit-permissions.mjs — gate on the permissions the app REALLY ships with.
 *
 * `mobile/android` and `mobile/ios` are not tracked, so auditing a checked-in
 * manifest audited nothing (the CI job printed "skipped" on every run — external
 * audit 2026-09-16 AL-11). This script asks Expo for the RESOLVED config
 * (`expo config --type introspect`), i.e. the AndroidManifest and Info.plist
 * every config plugin and autolinked module would produce, and checks them
 * against an explicit allowlist. Anything not listed here — however it got in
 * (a new dependency, a plugin default) — fails the build until someone either
 * removes it or adds it here WITH a reason.
 *
 * Usage:  node scripts/audit-permissions.mjs            (runs expo config)
 *         node scripts/audit-permissions.mjs file.json  (pre-generated introspect JSON)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ── Android: every uses-permission must be here, with the feature it serves ──
const ANDROID_ALLOWED = {
  'android.permission.INTERNET': 'relay + Tor',
  'android.permission.ACCESS_NETWORK_STATE': 'offline outbox / reconnect',
  'android.permission.CAMERA': 'QR scan, photo/video attachments, video calls',
  'android.permission.RECORD_AUDIO': 'voice notes, voice/video calls',
  'android.permission.MODIFY_AUDIO_SETTINGS': 'speaker/earpiece routing during calls (react-native-webrtc)',
  'android.permission.BLUETOOTH': 'BT headset routing during calls (react-native-webrtc)',
  'android.permission.POST_NOTIFICATIONS': 'message / call notifications',
  'android.permission.VIBRATE': 'incoming call / message haptics',
  'android.permission.WAKE_LOCK': 'keep the call and the wake service alive',
  'android.permission.RECEIVE_BOOT_COMPLETED': 'restart the call-wake service after reboot',
  'android.permission.FOREGROUND_SERVICE': 'in-call + call-wake foreground services',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE': 'in-call foreground service type (Android 14+)',
  'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING': 'call-wake foreground service type (Android 14+)',
  'android.permission.SYSTEM_ALERT_WINDOW': 'full-screen incoming-call UI over the lock screen',
  'android.permission.USE_BIOMETRIC': 'app lock (expo-local-authentication)',
  'android.permission.USE_FINGERPRINT': 'app lock on API < 28 (expo-local-authentication)',
  'android.permission.ACCESS_FINE_LOCATION': 'one-shot "share my location" message (expo-location, foreground only)',
  'android.permission.ACCESS_COARSE_LOCATION': 'same as FINE — expo-location declares both',
  'android.permission.READ_EXTERNAL_STORAGE': 'legacy (maxSdk 32) media access declared by expo-image-picker/expo-file-system',
  'android.permission.WRITE_EXTERNAL_STORAGE': 'legacy (maxSdk 32) media save declared by expo-image-picker/expo-file-system',
};

// Permissions that must NEVER appear un-removed, whatever a dependency wants.
const ANDROID_FORBIDDEN = [
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_CALL_LOG',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.BODY_SENSORS',
  'android.permission.QUERY_ALL_PACKAGES',
  'com.google.android.gms.permission.AD_ID',
];

// ── iOS: privacy keys that may exist, and ones that never may ─────────────────
const IOS_ALLOWED_KEYS = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSFaceIDUsageDescription',
  'NSLocalNetworkUsageDescription',
  'NSLocationWhenInUseUsageDescription',
];
const IOS_FORBIDDEN_KEYS = [
  'NSLocationAlwaysUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSContactsUsageDescription',
  'NSMotionUsageDescription',
  'NSHealthShareUsageDescription',
  'NSHealthUpdateUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NFCReaderUsageDescription',
  'NSSpeechRecognitionUsageDescription',
  'NSUserTrackingUsageDescription',
  'NSCalendarsUsageDescription',
  'NSRemindersUsageDescription',
];
const IOS_ALLOWED_BACKGROUND_MODES = ['voip', 'audio', 'remote-notification', 'fetch'];

function loadIntrospect(arg) {
  if (arg) return JSON.parse(readFileSync(arg, 'utf8'));
  const out = execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out);
}

const cfg = loadIntrospect(process.argv[2]);
const mods = cfg._internal && cfg._internal.modResults;
if (!mods || !mods.android || !mods.ios) {
  console.error('::error::expo config --type introspect produced no modResults (android/ios) — cannot audit.');
  process.exit(2);
}

const errors = [];

// ── Android ──────────────────────────────────────────────────────────────────
const uses = (mods.android.manifest.manifest['uses-permission'] || []).map((p) => ({
  name: p.$['android:name'],
  removed: p.$['tools:node'] === 'remove',
}));
const active = uses.filter((p) => !p.removed).map((p) => p.name).sort();
for (const name of active) {
  if (ANDROID_FORBIDDEN.includes(name)) errors.push(`android: FORBIDDEN permission present: ${name}`);
  else if (!(name in ANDROID_ALLOWED)) errors.push(`android: unlisted permission: ${name} — remove it or allow it with a reason in scripts/audit-permissions.mjs`);
}
console.log(`Android uses-permission (${active.length} active):`);
for (const name of active) console.log(`  ${name}  — ${ANDROID_ALLOWED[name] ?? '?? NOT ALLOWED'}`);

// ── iOS ──────────────────────────────────────────────────────────────────────
const plist = mods.ios.infoPlist || {};
const privacyKeys = Object.keys(plist).filter((k) => /UsageDescription$/.test(k)).sort();
console.log(`iOS privacy keys (${privacyKeys.length}):`);
for (const k of privacyKeys) {
  const v = String(plist[k]);
  console.log(`  ${k} = ${JSON.stringify(v)}`);
  if (IOS_FORBIDDEN_KEYS.includes(k)) errors.push(`ios: FORBIDDEN privacy key present: ${k}`);
  else if (!IOS_ALLOWED_KEYS.includes(k)) errors.push(`ios: unlisted privacy key: ${k}`);
  // A plugin's default string means nobody configured it — App Review rejects
  // generic usage strings and it is a sign the permission was never intended.
  if (/\$\(PRODUCT_NAME\)/.test(v) || /^Allow .* to access your/.test(v)) errors.push(`ios: ${k} still carries the plugin's generic default text — set a real, specific string in app.json`);
}
const modes = Array.isArray(plist.UIBackgroundModes) ? plist.UIBackgroundModes : [];
console.log(`iOS UIBackgroundModes: ${JSON.stringify(modes)}`);
for (const m of modes) if (!IOS_ALLOWED_BACKGROUND_MODES.includes(m)) errors.push(`ios: unlisted UIBackgroundMode: ${m}`);

// ── Verdict ──────────────────────────────────────────────────────────────────
if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  console.error(`\nPermissions audit FAILED (${errors.length}).`);
  process.exit(1);
}
console.log('\nPermissions audit PASSED.');
