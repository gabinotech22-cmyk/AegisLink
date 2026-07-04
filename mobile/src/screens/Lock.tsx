import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../utils/logger';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, Animated, Easing, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { ss } from '../utils/secureStore';
import { verifyPIN, hasStoredPIN, verifyPinWithSalt, DURESS_PIN_SALT } from '../lock/pin';
import { usePreferences } from '../store/preferences';
import { useIdentity } from '../store/identity';
import { wipeDatabase } from '../db/local';
import { usePanicGesture } from '../hooks/usePanicGesture';
import { AegisMark } from '../components/AegisMark';

const MAX_ATTEMPTS = 5;

interface Props {
  onUnlock: () => void;
  onPanic: () => void;
}

// ── PIN dots indicator ────────────────────────────────────────────────────────
function PinDots({ count, error, t }: { count: number; error: boolean; t: Theme }) {
  return (
    <View style={{ flexDirection: 'row', gap: 18, justifyContent: 'center', marginVertical: 32 }}>
      {[0, 1, 2, 3].map((i) => (
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
  const [hasPIN, setHasPIN] = useState(false);

  const [pinCode, setPinCode] = useState('');
  const [pinError, setPinError] = useState('');
  const [attempts, setAttempts] = useState(0);

  const [bioStatus, setBioStatus] = useState('');
  const scanningRef = useRef(false);
  // Track genuine biometric failures (not user cancellations) for auto-wipe.
  const bioAttemptsRef = useRef(0);

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

      // Always detect hardware availability regardless of user preference.
      // `biometricsEnabled` controls auto-launch behaviour, not whether the
      // button is shown.
      let bio = false;
      try {
        // expo-local-authentication works perfectly in modern Expo Go builds
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const LA = require('expo-local-authentication') as { hasHardwareAsync(): Promise<boolean>; isEnrolledAsync(): Promise<boolean> };
        const hasHw = await LA.hasHardwareAsync();
        const enrolled = await LA.isEnrolledAsync();
        bio = hasHw && enrolled;
      } catch { /* module not available in this build */ }

      setBioAvailable(bio);
      setBioStatus(i18nT('lock.tapToUnlock'));

      // Auto-launch biometric UI only when the user has enabled it AND hardware
      // is present. If the preference is off but hardware exists, we show PIN
      // by default and surface a "Use Face ID / Fingerprint" button instead.
      if (bio && biometricsEnabled) {
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

  // ── Biometric auth ─────────────────────────────────────────────────────────
  const attemptBiometric = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setBioStatus(i18nT('lock.scanningBio'));

    try {
      const LA = require('expo-local-authentication') as { authenticateAsync(opts: object): Promise<{ success: boolean; error?: string }> };
      const result = await LA.authenticateAsync({
        promptMessage: i18nT('lock.promptMessage'),
        fallbackLabel: i18nT('lock.fallbackLabel'),
        disableDeviceFallback: false,
      });

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
        // Genuine biometric failure (wrong finger/face, lockout, etc.)
        const newBioAttempts = bioAttemptsRef.current + 1;
        bioAttemptsRef.current = newBioAttempts;
        setBioStatus(i18nT('lock.bioFailed'));

        if (newBioAttempts >= MAX_ATTEMPTS) {
          let autoWipe = false;
          try {
            const panicRaw = await ss.get('aegis.panic.v1');
            if (panicRaw) {
              const cfg = JSON.parse(panicRaw) as { autoWipe?: boolean };
              autoWipe = cfg.autoWipe === true;
            }
          } catch { /* storage unavailable */ }

          if (autoWipe) {
            setBioStatus(i18nT('lock.wipingData'));
            setTimeout(async () => {
              try {
                await wipeDatabase();
                await useIdentity.getState().reset();
              } catch { /* non-recoverable — app will reset on next launch */ }
            }, 800);
          }
        }
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
    if (pinCode.length >= 4) return;
    const next = pinCode + d;
    setPinCode(next);
    setPinError('');
    if (next.length === 4) setTimeout(() => validatePin(next), 180);
  }

  function handleDelete() {
    setPinCode((p) => p.slice(0, -1));
    setPinError('');
  }

  async function validatePin(pin: string) {
    try {
      const panicRaw = await ss.get('aegis.panic.v1');
      if (panicRaw) {
        const config = JSON.parse(panicRaw) as {
          duressPin?: boolean;
          pinHash?: string;
        };
        if (config.duressPin && typeof config.pinHash === 'string' && config.pinHash.length > 0) {
          if (await verifyPinWithSalt(pin, DURESS_PIN_SALT, config.pinHash)) {
            // Wipe first — if interrupted mid-wipe, real data is already gone.
            // Only after a successful wipe do we surface the decoy UI.
            try {
              await wipeDatabase();
              await useIdentity.getState().reset();
            } catch { /* wipe failure is non-recoverable; decoy still shown */ }
            usePreferences.setState({ duressActive: true });
            setPinCode('');
            onUnlock();
            return;
          }
        }
      }
    } catch (e) {
      if (__DEV__) logger.warn('[lock-panic] failed to load duress config:', e);
    }

    const ok = hasPIN ? await verifyPIN(pin) : false;
    if (ok) {
      const wasDecoy = usePreferences.getState().duressActive;
      usePreferences.setState({ duressActive: false });
      if (wasDecoy) {
        // Reload real identity and data now that decoy mode is off
        await useIdentity.getState().hydrate();
      }
      setPinCode('');
      onUnlock();
      return;
    }
    const newAttempts = attempts + 1;
    setAttempts(newAttempts);
    shake();
    setPinCode('');
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
      } else {
        // Stay on lock screen — do NOT navigate away or unlock the app
        setPinError(i18nT('lock.maxAttemptsReached', { max: MAX_ATTEMPTS }));
      }
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
              <I.Fingerprint size={40} color={t.accent} />
            </View>
          </Pressable>

          <View style={{ alignItems: 'center' }}>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: '600', letterSpacing: -0.3, color: t.text, textAlign: 'center' }}>
              {bioStatus}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.6, marginTop: 6 }}>
              {i18nT('lock.faceIdLabel')}
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

        {pinError ? (
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger, textAlign: 'center', marginBottom: 20, paddingHorizontal: 32 }}>
            {pinError}
          </Text>
        ) : (
          <View style={{ height: 38 }} />
        )}

        <Numpad onDigit={handleDigit} onDelete={handleDelete} t={t} />

        {bioAvailable && (
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
