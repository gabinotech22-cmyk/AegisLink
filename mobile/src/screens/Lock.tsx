import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../utils/logger';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, Animated, Easing, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { ss } from '../utils/secureStore';
import {
  verifyPIN,
  hasStoredPIN,
  verifyPinWithSalt,
  DURESS_PIN_SALT,
  getStoredPinLength,
  setStoredPinLength,
} from '../lock/pin';
import { usePreferences } from '../store/preferences';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { useMessages } from '../store/messages';
import { wipeDatabase } from '../db/local';
import { usePanicGesture } from '../hooks/usePanicGesture';
import { withPickingGuard } from '../utils/pickingGuard';
import { AegisMark } from '../components/AegisMark';

const MAX_ATTEMPTS = 5;

// ── Persisted attempt counter + progressive cooldown (SecureStore, local only) ──
const ATTEMPTS_KEY = 'aegis.lock.attempts.v1';

interface AttemptsState {
  count: number;
  lockedUntilMs: number | null;
}

async function loadAttemptsState(): Promise<AttemptsState> {
  try {
    const raw = await ss.get(ATTEMPTS_KEY);
    if (!raw) return { count: 0, lockedUntilMs: null };
    const parsed = JSON.parse(raw) as Partial<AttemptsState>;
    return {
      count: typeof parsed.count === 'number' ? parsed.count : 0,
      lockedUntilMs: typeof parsed.lockedUntilMs === 'number' ? parsed.lockedUntilMs : null,
    };
  } catch {
    return { count: 0, lockedUntilMs: null };
  }
}

async function saveAttemptsState(s: AttemptsState): Promise<void> {
  try {
    await ss.set(ATTEMPTS_KEY, JSON.stringify(s));
  } catch { /* storage unavailable — cooldown just won't survive a restart */ }
}

// Escalating cooldown: 1-4 fails → none, 5th → 30s, 6th → 60s, 7th → 5min,
// 8th+ → 15min each.
function cooldownMsForCount(count: number): number {
  if (count <= 4) return 0;
  if (count === 5) return 30_000;
  if (count === 6) return 60_000;
  if (count === 7) return 5 * 60_000;
  return 15 * 60_000;
}

function formatCooldown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
  onUnlock: () => void;
  onPanic: () => void;
}

// ── PIN dots indicator ────────────────────────────────────────────────────────
function PinDots({ count, error, t }: { count: number; error: boolean; t: Theme }) {
  return (
    <View style={{ flexDirection: 'row', gap: 18, justifyContent: 'center', marginVertical: 32 }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View
          key={i}
          style={{
            width: 16, height: 16, borderRadius: 8,
            backgroundColor: i < count ? (error ? t.danger : t.accent) : 'transparent',
            borderWidth: 2,
            borderColor: i < count ? (error ? t.danger : t.accent) : t.borderStrong,
          }}
        />
      ))}
    </View>
  );
}

// ── Numpad ────────────────────────────────────────────────────────────────────
function Numpad({ onDigit, onDelete, t }: { onDigit: (d: string) => void; onDelete: () => void; t: Theme }) {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 252, alignSelf: 'center' }}>
      {keys.map((k, i) => {
        if (!k) return <View key={i} style={{ width: 84, height: 68 }} />;
        const isDel = k === '⌫';
        return (
          <Pressable
            key={i}
            onPress={() => (isDel ? onDelete() : onDigit(k))}
            style={({ pressed }) => ({ width: 84, height: 68, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.4 : 1 })}
          >
            <View style={{
              width: 60, height: 60, borderRadius: 30,
              backgroundColor: isDel ? 'transparent' : t.surface,
              borderWidth: isDel ? 0 : 1, borderColor: t.borderStrong,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Text style={{ fontFamily: isDel ? t.font : t.fontDisplay, fontSize: isDel ? 22 : 24, fontWeight: '400', color: t.text }}>
                {k}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── LockScreen ────────────────────────────────────────────────────────────────
export function LockScreen({ onUnlock, onPanic }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const biometricsEnabled = usePreferences((s) => s.biometricsEnabled);

  // mode: null while initialising, then 'biometric' or 'pin'
  const [mode, setMode] = useState<'biometric' | 'pin' | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  // Which biometric the device offers — drives the biometric view's icon + copy
  // (face vs fingerprint). Detected in init; does NOT affect WHETHER biometric
  // mode shows — that stays gated on `bio && biometricsEnabled` (PIN is default).
  const [bioKind, setBioKind] = useState<'face' | 'fingerprint'>('fingerprint');
  const [hasPIN, setHasPIN] = useState(false);

  const [pinCode, setPinCode] = useState('');
  const [pinError, setPinError] = useState('');
  const [attempts, setAttempts] = useState(0);
  // Length of the REAL PIN, persisted separately from the hash so the numpad
  // knows whether to treat the 4th digit as a real (counted) attempt, wait
  // for a 6th digit, or — for pre-existing installs with no flag yet — fall
  // back to the legacy silent check until the next successful unlock.
  const [pinLenFlag, setPinLenFlag] = useState<4 | 6 | null>(null);

  // Progressive cooldown after repeated failures — persisted so it survives
  // an app restart (closes the "reinstall/relaunch to reset attempts" gap).
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownSecondsLeft, setCooldownSecondsLeft] = useState(0);

  const [bioStatus, setBioStatus] = useState('');
  const scanningRef = useRef(false);

  const shakeAnim = useRef(new Animated.Value(0)).current;
  const [pulse1] = useState(new Animated.Value(0));
  const [pulse2] = useState(new Animated.Value(0));

  // Panic gestures — only active while lock screen is visible
  const { registerTap, registerLongPress } = usePanicGesture(onPanic);

  // ── Initialise: detect what's available, pick starting mode ────────────────
  useEffect(() => {
    async function init() {
      const stored = await hasStoredPIN();
      setHasPIN(stored);

      const [attemptsState, storedLen] = await Promise.all([
        loadAttemptsState(),
        getStoredPinLength(),
      ]);
      setAttempts(attemptsState.count);
      setPinLenFlag(storedLen);
      if (attemptsState.lockedUntilMs && attemptsState.lockedUntilMs > Date.now()) {
        setCooldownUntil(attemptsState.lockedUntilMs);
      }

      // Always detect hardware availability — it also picks the right
      // icon/copy. Whether the biometric option is OFFERED at all is gated
      // below on `bio && biometricsEnabled`.
      let bio = false;
      let kind: 'face' | 'fingerprint' = 'fingerprint';
      try {
        // expo-local-authentication works perfectly in modern Expo Go builds
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const LA = require('expo-local-authentication') as {
          hasHardwareAsync(): Promise<boolean>;
          isEnrolledAsync(): Promise<boolean>;
          supportedAuthenticationTypesAsync(): Promise<number[]>;
        };
        const hasHw = await LA.hasHardwareAsync();
        const enrolled = await LA.isEnrolledAsync();
        bio = hasHw && enrolled;
        if (bio) {
          // AuthenticationType: 1 = FINGERPRINT, 2 = FACIAL_RECOGNITION.
          // Prefer face when the device reports it; otherwise fingerprint.
          const types = await LA.supportedAuthenticationTypesAsync();
          if (types.includes(2)) kind = 'face';
          else if (types.includes(1)) kind = 'fingerprint';
        }
      } catch { /* module not available in this build */ }

      setBioAvailable(bio);
      setBioKind(kind);
      setBioStatus(kind === 'face'
        ? i18nT('lock.lookAtDevice', 'Mira el dispositivo')
        : i18nT('lock.touchSensor', 'Toca el sensor'));

      // PIN-first (product + security decision): whenever a PIN exists, the
      // PIN pad is the default view. The duress/panic PIN lives on this
      // screen — it must ALWAYS be typeable, and the biometric prompt is a
      // modal system alert that covers the screen (and the "use PIN" button
      // under it) when auto-launched; a failing sensor then traps the user
      // (seen on iPhone 8 / Touch ID, TestFlight build 14). Biometrics are
      // offered as an explicit button on the PIN view instead. Only a
      // bio-only setup (no PIN stored) starts on the biometric view.
      if (!stored && bio && biometricsEnabled) {
        setMode('biometric');
        // auto-trigger after mode is set via the effect below
      } else {
        setMode('pin');
      }
    }
    void init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-trigger biometric once when mode becomes 'biometric' ─────────────
  const didAutoTrigger = useRef(false);
  useEffect(() => {
    if (mode === 'biometric' && !didAutoTrigger.current) {
      didAutoTrigger.current = true;
      void attemptBiometric();
    }
    if (mode === 'pin') {
      didAutoTrigger.current = false; // reset so switching back re-triggers
    }
  // attemptBiometric is stable via useCallback; mode is the only reactive dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Pulse animation (biometric ring) ───────────────────────────────────────
  useEffect(() => {
    if (mode !== 'biometric') return;
    const loop = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    const l1 = loop(pulse1, 0);
    const l2 = loop(pulse2, 300);
    l1.start();
    l2.start();
    return () => { l1.stop(); l2.stop(); };
  }, [mode, pulse1, pulse2]);

  // ── Cooldown countdown (progressive lockout after repeated PIN fails) ──────
  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownSecondsLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownSecondsLeft(left);
      if (left <= 0) setCooldownUntil(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  // ── Biometric auth ─────────────────────────────────────────────────────────
  // A misread sensor is not an attacker and iOS/Android already rate-limit
  // biometric prompts natively after a handful of failures — the auto-wipe
  // stays exclusively on the PIN path (see validatePin below).
  const attemptBiometric = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setBioStatus(i18nT('lock.scanningBio'));

    try {
      const LA = require('expo-local-authentication') as { authenticateAsync(opts: object): Promise<{ success: boolean; error?: string }> };
      // withPickingGuard: the system biometric prompt can toggle AppState to
      // 'inactive' while it's shown; with an "Immediately" lock timeout,
      // App.tsx's re-lock handler would otherwise fire right as the prompt
      // dismisses. isPicking() is the same mechanism the picker flows use to
      // tell App.tsx to ignore that transition.
      const result = await withPickingGuard(() =>
        LA.authenticateAsync({
          promptMessage: i18nT('lock.promptMessage'),
          fallbackLabel: i18nT('lock.fallbackLabel'),
          // NEVER fall back to the device passcode: it would unlock the app
          // while bypassing validatePin() entirely — i.e. skipping the duress
          // (decoy) PIN path, so a coerced user couldn't present the decoy.
          // The fallback button returns 'user_fallback', which routes to the
          // app's own PIN view below.
          disableDeviceFallback: true,
        })
      );

      if (result.success) {
        setBioStatus(i18nT('lock.unlocked'));
        setTimeout(onUnlock, 350);
        return;
      }

      // User cancelled or chose fallback label — go to PIN if we have one
      if (result.error === 'user_fallback' || result.error === 'user_cancel') {
        if (hasPIN) {
          setMode('pin');
        } else {
          setBioStatus(i18nT('lock.bioCancelled'));
        }
      } else {
        // Genuine biometric failure (wrong finger/face, lockout, etc.) — does
        // NOT count towards the PIN attempt counter or auto-wipe.
        setBioStatus(i18nT('lock.bioFailed'));
      }
    } catch (e) {
      // Library threw — show friendly message, stay on biometric screen
      setBioStatus(i18nT('lock.bioUnavailable'));
    } finally {
      scanningRef.current = false;
    }
  }, [hasPIN, onUnlock]);

  // ── Shake animation ────────────────────────────────────────────────────────
  function shake() {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 12, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -12, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  }

  // ── PIN entry ──────────────────────────────────────────────────────────────
  function handleDigit(d: string) {
    if (cooldownUntil && cooldownUntil > Date.now()) return; // numpad disabled during cooldown
    if (pinCode.length >= 6) return;
    const next = pinCode + d;
    setPinCode(next);
    setPinError('');
    if (next.length === 4) {
      setTimeout(() => void handleFourDigitCheckpoint(next), 10);
    } else if (next.length === 6) {
      setTimeout(() => void validatePin(next, false), 180);
    }
  }

  function handleDelete() {
    if (cooldownUntil && cooldownUntil > Date.now()) return;
    setPinCode((p) => p.slice(0, -1));
    setPinError('');
  }

  /**
   * FIX 1 — closing the silent-4th-digit brute-force gap.
   *
   * With a 6-digit real PIN, the 4th digit must NEVER be validated (an
   * attacker could probe all 10,000 4-digit combos while the counter stays
   * at 0 by typing 4, deleting 1, retyping). With a 4-digit real PIN, the
   * 4th digit IS the real, counted attempt. Pre-flag installs (pinLenFlag
   * === null) keep the legacy silent behaviour until the next successful
   * unlock persists the real length.
   *
   * The duress (decoy) PIN can have a different length than the real PIN, so
   * it is checked independently here, gated on the duress config's own
   * `pinLength` (falls back to "always check" for older configs saved
   * without that field) — and NEVER counts as an attempt.
   */
  async function handleFourDigitCheckpoint(pin: string) {
    const duressLen = await getDuressPinLength();
    if (duressLen === 4 || duressLen === null) {
      const unlockedViaDuress = await checkDuress(pin);
      if (unlockedViaDuress) return;
    }

    if (pinLenFlag === 6) return; // real PIN is 6 digits — still typing, no check yet
    if (pinLenFlag === 4) {
      await validatePin(pin, false); // real, counted attempt
      return;
    }
    // pinLenFlag === null: pre-existing install, no length flag persisted
    // yet — preserve the legacy silent check (validatePin() persists the
    // correct length on the first successful unlock, closing the gap).
    await validatePin(pin, true);
  }

  async function getDuressPinLength(): Promise<number | null> {
    try {
      const panicRaw = await ss.get('aegis.panic.v1');
      if (!panicRaw) return null;
      const config = JSON.parse(panicRaw) as { pinLength?: number };
      return typeof config.pinLength === 'number' ? config.pinLength : null;
    } catch {
      return null;
    }
  }

  /** Returns true if `pin` matched the duress/decoy PIN and unlocked into it. */
  async function checkDuress(pin: string): Promise<boolean> {
    try {
      const panicRaw = await ss.get('aegis.panic.v1');
      if (!panicRaw) return false;
      const config = JSON.parse(panicRaw) as {
        duressPin?: boolean;
        pinHash?: string;
      };
      // A stored decoy hash means duress is configured. Treat it as enabled
      // unless the user explicitly turned the toggle off (duressPin === false),
      // so configs written without the flag (older save path) still work.
      if (config.duressPin === false || typeof config.pinHash !== 'string' || config.pinHash.length === 0) {
        return false;
      }
      if (!(await verifyPinWithSalt(pin, DURESS_PIN_SALT, config.pinHash))) return false;

      // Duress PIN = HIDE + REVERSIBLE, never destructive. Flip the flag
      // then hydrate the (stable, seeded) decoy identity/contacts/messages —
      // the real data is left completely untouched in the real DB and is
      // restored the instant the real PIN is entered.
      usePreferences.setState({ duressActive: true });
      try {
        await useIdentity.getState().hydrate();
        await useContacts.getState().hydrate();
        useMessages.setState({ byChat: {}, previews: {}, pinnedMsg: {}, unreadCounts: {}, drafts: {} });
      } catch (err) {
        if (__DEV__) logger.warn('[lock-panic] failed to load decoy state:', err);
      }
      // Reset the attempt counter on ANY successful unlock, including
      // duress — a different reset pattern would let an observer tell the
      // decoy PIN apart from the real one.
      await resetAttempts();
      setPinCode('');
      onUnlock();
      return true;
    } catch (e) {
      if (__DEV__) logger.warn('[lock-panic] failed to load duress config:', e);
      return false;
    }
  }

  async function resetAttempts() {
    setAttempts(0);
    setCooldownUntil(null);
    await saveAttemptsState({ count: 0, lockedUntilMs: null });
  }

  async function validatePin(pin: string, silent = false) {
    if (await checkDuress(pin)) return;

    const ok = hasPIN ? await verifyPIN(pin) : false;
    if (ok) {
      // Migration: an install with no persisted PIN length yet learns its
      // real length on the first successful unlock, closing the silent-4th-
      // digit gap for good from here on.
      if (pinLenFlag === null) {
        const len: 4 | 6 = pin.length === 4 ? 4 : 6;
        try {
          await setStoredPinLength(len);
          setPinLenFlag(len);
        } catch { /* storage unavailable — will retry on next unlock */ }
      }

      const wasDecoy = usePreferences.getState().duressActive;
      usePreferences.setState({ duressActive: false });
      if (wasDecoy) {
        // Reload real identity and data now that decoy mode is off
        try {
          await useIdentity.getState().hydrate();
          await useContacts.getState().hydrate();
          useMessages.setState({
            byChat: {},
            previews: {},
            pinnedMsg: {},
            drafts: {},
          });
          await useMessages.getState().loadAllUnreads();
          await useMessages.getState().loadAllEphemeralTimers();
        } catch {
          setPinError('');
          setPinCode('');
          return;
        }
      }
      await resetAttempts();
      setPinCode('');
      onUnlock();
      return;
    }

    if (silent) return;

    const newAttempts = attempts + 1;
    setAttempts(newAttempts);
    shake();
    setPinCode('');

    const cooldownMs = cooldownMsForCount(newAttempts);
    const lockedUntilMs = cooldownMs > 0 ? Date.now() + cooldownMs : null;
    await saveAttemptsState({ count: newAttempts, lockedUntilMs });
    if (lockedUntilMs) setCooldownUntil(lockedUntilMs);

    if (newAttempts >= MAX_ATTEMPTS) {
      // Read autoWipe setting from SecureStore
      let autoWipe = false;
      try {
        const panicRaw = await ss.get('aegis.panic.v1');
        if (panicRaw) {
          const config = JSON.parse(panicRaw) as { autoWipe?: boolean };
          autoWipe = config.autoWipe === true;
        }
      } catch { /* storage unavailable — treat as false */ }

      if (autoWipe) {
        setPinError(i18nT('lock.wipingData'));
        setTimeout(async () => {
          try {
            await wipeDatabase();
            await useIdentity.getState().reset();
          } catch { /* wipe failure is non-recoverable; app will reset on restart */ }
        }, 800);
        return;
      }
    }

    if (lockedUntilMs) {
      setPinError(i18nT('lock.cooldownWait', { time: formatCooldown(Math.ceil(cooldownMs / 1000)) }));
    } else {
      const left = MAX_ATTEMPTS - newAttempts;
      setPinError(i18nT(left === 1 ? 'lock.pinError' : 'lock.pinError_plural', { count: left }));
    }
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (mode === null) {
    return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  }

  // ── Biometric view ─────────────────────────────────────────────────────────
  if (mode === 'biometric') {
    return (
      <View style={[styles.root, { backgroundColor: t.bg, paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 }]}>
        {/* Logo — triple tap triggers panic gesture */}
        <Pressable onPress={registerTap} onLongPress={registerLongPress} delayLongPress={3000} accessibilityElementsHidden importantForAccessibility="no">
          <View style={{ alignItems: 'center', gap: 6 }}>
            <View style={{
              width: 52, height: 52, borderRadius: 26,
              backgroundColor: t.dark ? 'rgba(91,242,185,0.08)' : 'rgba(13,143,95,0.08)',
              borderWidth: 1, borderColor: `${t.accent}33`,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <AegisMark t={t} size={28} />
            </View>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.4 }}>
              AEGISLINK
            </Text>
          </View>
        </Pressable>

        <View style={{ alignItems: 'center', gap: 28 }}>
          {/* Fingerprint / FaceID ring — tap to retry */}
          <Pressable
            onPress={() => void attemptBiometric()}
            style={{ width: 130, height: 130, alignItems: 'center', justifyContent: 'center' }}
          >
            {[pulse1, pulse2].map((p, i) => (
              <Animated.View
                key={i}
                style={[StyleSheet.absoluteFillObject, {
                  borderRadius: 65,
                  borderWidth: 2,
                  borderColor: t.accent,
                  opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
                  transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.2] }) }],
                }]}
              />
            ))}
            <View style={{ width: 74, height: 74, borderRadius: 37, backgroundColor: t.surface, borderWidth: 1, borderColor: t.borderStrong, alignItems: 'center', justifyContent: 'center' }}>
              {bioKind === 'face'
                ? <I.FaceId size={40} color={t.accent} />
                : <I.Fingerprint size={40} color={t.accent} />}
            </View>
          </Pressable>

          <View style={{ alignItems: 'center' }}>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: '600', letterSpacing: -0.3, color: t.text, textAlign: 'center' }}>
              {bioStatus}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.6, marginTop: 6 }}>
              {i18nT(bioKind === 'face' ? 'lock.faceIdLabel' : 'lock.fingerprintUnlockLabel')}
            </Text>
          </View>

          {hasPIN && (
            <Pressable
              onPress={() => { didAutoTrigger.current = true; setMode('pin'); }}
              style={({ pressed }) => ({
                borderWidth: 1, borderColor: t.borderStrong,
                paddingHorizontal: 22, paddingVertical: 10,
                borderRadius: t.radius, opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>{i18nT('lock.usePinInstead')}</Text>
            </Pressable>
          )}
        </View>

        <View style={{ height: 32 }} />
      </View>
    );
  }

  // ── PIN view ───────────────────────────────────────────────────────────────
  return (
    <View style={[styles.root, { backgroundColor: t.bg, paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 }]}>
      {/* Logo — triple tap triggers panic gesture */}
      <Pressable onPress={registerTap} onLongPress={registerLongPress} delayLongPress={3000} accessibilityElementsHidden importantForAccessibility="no">
        <View style={{ alignItems: 'center', gap: 6 }}>
          <View style={{
            width: 52, height: 52, borderRadius: 26,
            backgroundColor: t.dark ? 'rgba(91,242,185,0.08)' : 'rgba(13,143,95,0.08)',
            borderWidth: 1, borderColor: `${t.accent}33`,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <AegisMark t={t} size={28} />
          </View>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.4 }}>
            AEGISLINK
          </Text>
        </View>
      </Pressable>

      <View style={{ alignItems: 'center', width: '100%' }}>
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.3, color: t.text }}>
          {i18nT('lock.enterPin')}
        </Text>

        <Animated.View style={{ transform: [{ translateX: shakeAnim }], width: '100%', alignItems: 'center' }}>
          <PinDots count={pinCode.length} error={pinError.length > 0} t={t} />
        </Animated.View>

        {cooldownUntil && cooldownSecondsLeft > 0 ? (
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger, textAlign: 'center', marginBottom: 20, paddingHorizontal: 32 }}>
            {i18nT('lock.cooldownWait', { time: formatCooldown(cooldownSecondsLeft) })}
          </Text>
        ) : pinError ? (
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger, textAlign: 'center', marginBottom: 20, paddingHorizontal: 32 }}>
            {pinError}
          </Text>
        ) : (
          <View style={{ height: 38 }} />
        )}

        <Numpad onDigit={handleDigit} onDelete={handleDelete} t={t} />

        {bioAvailable && biometricsEnabled && (
          <Pressable
            onPress={() => {
              setPinCode('');
              setPinError('');
              didAutoTrigger.current = false;
              setMode('biometric');
            }}
            style={({ pressed }) => ({ marginTop: 24, opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.accent }}>
              {i18nT('lock.useBiometrics')}
            </Text>
          </Pressable>
        )}
      </View>

      <View style={{ height: 32 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'space-between' },
});
