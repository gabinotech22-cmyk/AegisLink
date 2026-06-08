/**
 * Runtime integrity check — LOCAL ONLY, ZERO TELEMETRY.
 *
 * Uses jail-monkey to detect a hostile runtime (root/jailbreak, active hooking
 * such as Frida/Xposed, or an attached debugger). Deliberately chosen over a
 * RASP SDK that "phones home": AegisLink's ethos is user control + zero
 * metadata, so nothing here ever leaves the device.
 *
 * Response policy (NON-BLOCKING by design):
 *   - Never hard-block or crash — customized/rooted devices are the user's
 *     choice on a privacy app, and false positives must not lock anyone out.
 *   - Emulators are NOT treated as compromised (the team + store reviewers use
 *     them; jail-monkey's root check is false on a clean emulator anyway).
 *   - The only enforced consequence is refusing to upload an encrypted backup
 *     OFF a compromised device (root/hook) — keys must not leave a device where
 *     the Keystore can be dumped or the crypto can be hooked.
 *   - The UI surfaces a one-time local advisory; usage is never prevented.
 */

export interface IntegrityReport {
  rooted: boolean;
  hooked: boolean;
  debugged: boolean;
  /** Any hostile-runtime signal that should gate off-device key export. */
  compromised: boolean;
}

interface JailMonkeyModule {
  isJailBroken?: () => boolean;
  hookDetected?: () => boolean;
  isDebuggedMode?: () => Promise<boolean>;
  trustFall?: () => boolean;
}

let _cached: IntegrityReport | null = null;

export async function checkIntegrity(): Promise<IntegrityReport> {
  if (_cached) return _cached;

  let rooted = false;
  let hooked = false;
  let debugged = false;
  try {
    // Dynamic require: absent in Expo Go / an unlinked dev runtime — in that
    // case we degrade to "clean" and never block on missing detection.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const JM = require('jail-monkey') as JailMonkeyModule;
    rooted = typeof JM.isJailBroken === 'function' ? !!JM.isJailBroken() : false;
    hooked = typeof JM.hookDetected === 'function' ? !!JM.hookDetected() : false;
    debugged = typeof JM.isDebuggedMode === 'function' ? await JM.isDebuggedMode() : false;
  } catch (e) {
    if (__DEV__) console.warn('[integrity] jail-monkey unavailable:', e);
  }

  // Only root + active hooking count as "compromised" for the backup gate.
  // A debugger alone (common in dev / power-user setups) is reported but not
  // treated as hostile, to avoid false positives.
  const report: IntegrityReport = {
    rooted,
    hooked,
    debugged,
    compromised: rooted || hooked,
  };
  _cached = report;
  return report;
}

/**
 * Whether it is safe to upload an encrypted backup off THIS device. Refuses on
 * a rooted/hooked runtime so the user's keys never leave a compromised device.
 */
export async function backupUploadAllowed(): Promise<boolean> {
  const r = await checkIntegrity();
  return !r.compromised;
}
