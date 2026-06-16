/**
 * LockSetup — Pantalla de configuración de bloqueo de pantalla.
 * Permite al usuario:
 *   1. Crear / cambiar / quitar PIN (4 dígitos)
 *   2. Activar Face ID / biometría
 *   3. Ajustar el tiempo de bloqueo automático
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated, Easing, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Section, Row, Toggle } from '../components/Section';
import { setPIN, clearPIN, hasStoredPIN, verifyPIN } from '../lock/pin';
import { usePreferences } from '../store/preferences';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
}

// ── PIN dots ────────────────────────────────────────────────────────────────
function PinDots({ count, error, t }: { count: number; error: boolean; t: Theme }) {
  return (
    <View style={{ flexDirection: 'row', gap: 18, justifyContent: 'center', marginVertical: 28 }}>
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: i < count ? (error ? t.danger : t.accent) : 'transparent',
            borderWidth: 2,
            borderColor: i < count ? (error ? t.danger : t.accent) : t.borderStrong,
          }}
        />
      ))}
    </View>
  );
}

// ── Numpad ───────────────────────────────────────────────────────────────────
function Numpad({ onDigit, onDelete, t }: { onDigit: (d: string) => void; onDelete: () => void; t: Theme }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 252, alignSelf: 'center' }}>
      {keys.map((k, i) => {
        if (!k) return <View key={i} style={{ width: 84, height: 68 }} />;
        const isDel = k === '⌫';
        return (
          <Pressable
            key={i}
            onPress={() => (isDel ? onDelete() : onDigit(k))}
            style={({ pressed }) => ({
              width: 84,
              height: 68,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.4 : 1,
            })}
          >
            <View
              style={{
                width: 60,
                height: 60,
                borderRadius: 30,
                backgroundColor: isDel ? 'transparent' : t.surface,
                borderWidth: isDel ? 0 : 1,
                borderColor: t.borderStrong,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  fontFamily: isDel ? t.font : t.fontDisplay,
                  fontSize: isDel ? 22 : 24,
                  fontWeight: '400',
                  color: t.text,
                }}
              >
                {k}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── PIN flow mode ────────────────────────────────────────────────────────────
type PinStep =
  | { kind: 'create-new' }          // entering new PIN
  | { kind: 'confirm-new'; prev: string } // confirming PIN
  | { kind: 'verify-current' };     // verifying old PIN before change/remove

// ── PinFlow modal overlay ────────────────────────────────────────────────────
function PinFlow({
  step,
  onSuccess,
  onCancel,
  t,
}: {
  step: PinStep;
  onSuccess: (pin?: string) => void;
  onCancel: () => void;
  t: Theme;
}) {
  const { t: i18nT } = useTranslation();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const shakeAnim = useRef(new Animated.Value(0)).current;

  function shake() {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 55, useNativeDriver: true }),
    ]).start();
  }

  function handleDigit(d: string) {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    setError('');
    if (next.length === 4) setTimeout(() => validate(next), 160);
  }

  function handleDelete() {
    setPin((p) => p.slice(0, -1));
    setError('');
  }

  async function validate(entered: string) {
    if (step.kind === 'verify-current') {
      const ok = await verifyPIN(entered);
      if (ok) {
        onSuccess(entered);
      } else {
        shake();
        setPin('');
        setError(i18nT('lockSetup.pinIncorrect', 'Incorrect PIN, try again'));
      }
      return;
    }

    if (step.kind === 'create-new') {
      onSuccess(entered); // pass to parent to enter confirm step
      return;
    }

    if (step.kind === 'confirm-new') {
      if (entered !== step.prev) {
        shake();
        setPin('');
        setError(i18nT('lockSetup.pinsDoNotMatch', 'PINs do not match, start over'));
      } else {
        await setPIN(entered);
        onSuccess(entered);
      }
    }
  }

  const title =
    step.kind === 'create-new'
      ? i18nT('lockSetup.createNewTitle', 'Create your 4-digit PIN')
      : step.kind === 'confirm-new'
      ? i18nT('lockSetup.confirmNewTitle', 'Confirm your PIN')
      : i18nT('lockSetup.verifyCurrentTitle', 'Enter your current PIN');

  const sub =
    step.kind === 'create-new'
      ? i18nT('lockSetup.createNewSub', 'Choose 4 digits you remember')
      : step.kind === 'confirm-new'
      ? i18nT('lockSetup.confirmNewSub', 'Retype the same PIN')
      : i18nT('lockSetup.verifyCurrentSub', 'We need to verify your identity');

  return (
    <View
      style={[
        StyleSheet.absoluteFillObject,
        { backgroundColor: t.bg, alignItems: 'center', justifyContent: 'space-between', padding: 28, paddingTop: 64, paddingBottom: 40 },
      ]}
    >
      <Pressable onPress={onCancel} style={{ alignSelf: 'flex-start' }}>
        <I.ChevronL size={22} color={t.text} />
      </Pressable>

      <View style={{ alignItems: 'center', width: '100%', gap: 0 }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: `${t.accent}22`,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14,
          }}
        >
          <I.Lock size={24} color={t.accent} />
        </View>
        <Text
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 22,
            fontWeight: '600',
            letterSpacing: -0.3,
            color: t.text,
            textAlign: 'center',
          }}
        >
          {title}
        </Text>
        <Text
          style={{
            fontFamily: t.font,
            fontSize: 13,
            color: t.textDim,
            marginTop: 6,
            textAlign: 'center',
          }}
        >
          {sub}
        </Text>

        <Animated.View style={{ transform: [{ translateX: shakeAnim }], width: '100%', alignItems: 'center' }}>
          <PinDots count={pin.length} error={error.length > 0} t={t} />
        </Animated.View>

        {error ? (
          <Text
            style={{
              fontFamily: t.font,
              fontSize: 13,
              color: t.danger,
              textAlign: 'center',
              marginBottom: 16,
              paddingHorizontal: 20,
            }}
          >
            {error}
          </Text>
        ) : (
          <View style={{ height: 36 }} />
        )}

        <Numpad onDigit={handleDigit} onDelete={handleDelete} t={t} />
      </View>

      <View style={{ height: 20 }} />
    </View>
  );
}

// ── Timeout options ───────────────────────────────────────────────────────────
const TIMEOUT_OPTIONS: { label: string; value: number }[] = [
  { label: 'Inmediatamente', value: 0 },
  { label: '1 minuto', value: 1 },
  { label: '5 minutos', value: 5 },
  { label: '15 minutos', value: 15 },
  { label: '1 hora', value: 60 },
];

// ── Main LockSetup ────────────────────────────────────────────────────────────
export function LockSetupScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const setPref = usePreferences((s) => s.set);
  const appLockEnabled = usePreferences((s) => s.appLockEnabled);
  const biometricsEnabled = usePreferences((s) => s.biometricsEnabled);
  const lockTimeoutMin = usePreferences((s) => s.lockTimeoutMin);

  const [hasPIN, setHasPIN] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);

  // PinFlow overlay state
  const [pinFlow, setPinFlow] = useState<PinStep | null>(null);
  const [pendingNewPin, setPendingNewPin] = useState<string | null>(null);

  // Init: check PIN and biometric availability
  useEffect(() => {
    void hasStoredPIN().then(setHasPIN);
    void checkBio();
  }, []);

  async function checkBio() {
    try {
      const LA = require('expo-local-authentication') as {
        hasHardwareAsync(): Promise<boolean>;
        isEnrolledAsync(): Promise<boolean>;
      };
      const hasHw = await LA.hasHardwareAsync();
      const enrolled = await LA.isEnrolledAsync();
      setBioAvailable(hasHw && enrolled);
    } catch {
      setBioAvailable(false);
    }
  }

  // ── PIN actions ─────────────────────────────────────────────────────────────
  const startCreatePIN = useCallback(() => {
    if (hasPIN) {
      // Must verify current PIN first
      setPinFlow({ kind: 'verify-current' });
    } else {
      setPinFlow({ kind: 'create-new' });
    }
  }, [hasPIN]);

  const handlePinFlowSuccess = useCallback(
    async (pin?: string) => {
      if (!pinFlow) return;

      if (pinFlow.kind === 'verify-current') {
        // Verified — now enter new PIN
        setPendingNewPin(pin ?? null);
        setPinFlow({ kind: 'create-new' });
        return;
      }

      if (pinFlow.kind === 'create-new') {
        // Have new PIN — go to confirm
        setPinFlow({ kind: 'confirm-new', prev: pin! });
        return;
      }

      if (pinFlow.kind === 'confirm-new') {
        // PIN saved inside PinFlow already via setPIN()
        setHasPIN(true);
        if (!appLockEnabled) {
          await setPref('appLockEnabled', true);
        }
        setPinFlow(null);
        setPendingNewPin(null);
        themedAlert(
          i18nT('lockSetup.pinCreatedAlertTitle', 'PIN created'),
          i18nT('lockSetup.pinCreatedAlertMsg', 'The lock screen is active.')
        );
      }
    },
    [pinFlow, appLockEnabled, setPref, i18nT]
  );

  const handleRemovePIN = useCallback(() => {
    themedAlert(
      i18nT('lockSetup.removePinAlertTitle', 'Remove PIN'),
      i18nT('lockSetup.removePinAlertMsg', 'Without a PIN, biometrics will also be disabled. Continue?'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: i18nT('lockSetup.removePin', 'Remove PIN'),
          style: 'destructive',
          onPress: async () => {
            await clearPIN();
            setHasPIN(false);
            await setPref('appLockEnabled', false);
            await setPref('biometricsEnabled', false);
          },
        },
      ]
    );
  }, [setPref, i18nT]);

  const handleToggleBiometrics = useCallback(
    async (val: boolean) => {
      if (val && !hasPIN) {
        themedAlert(
          i18nT('lockSetup.firstCreatePinAlertTitle', 'Create a PIN first'),
          i18nT('lockSetup.firstCreatePinAlertMsg', 'You need a backup PIN before enabling biometrics.')
        );
        return;
      }
      if (val) {
        try {
          const LA = require('expo-local-authentication') as {
            authenticateAsync(opts: object): Promise<{ success: boolean }>;
          };
          const res = await LA.authenticateAsync({
            promptMessage: i18nT('lockSetup.enableBioPrompt', 'Enable Face ID / Fingerprint for AegisLink'),
          });
          if (!res.success) return;
        } catch {
          themedAlert(
            i18nT('lockSetup.bioUnavailableAlertTitle', 'Biometrics unavailable'),
            i18nT('lockSetup.bioUnavailableAlertMsg', 'This device does not support biometric authentication.')
          );
          return;
        }
      }
      await setPref('biometricsEnabled', val);
    },
    [hasPIN, setPref, i18nT]
  );

  const handleToggleLock = useCallback(
    async (val: boolean) => {
      if (val && !hasPIN) {
        themedAlert(
          i18nT('lockSetup.firstCreatePinAlertTitle', 'Create a PIN first'),
          i18nT('lockSetup.enableLockAlertMsg', 'To enable lock, you need a PIN.')
        );
        return;
      }
      await setPref('appLockEnabled', val);
    },
    [hasPIN, setPref, i18nT]
  );

  const getTimeoutLabel = useCallback((val: number) => {
    if (val === 0) return i18nT('lockSetup.immediately', 'Immediately');
    if (val === 60) return i18nT('lockSetup.hours', '{{count}} hour', { count: 1 });
    return i18nT('lockSetup.minutes', '{{count}} minutes', { count: val });
  }, [i18nT]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 18,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: t.divider,
        }}
      >
        <Pressable onPress={onBack} hitSlop={12}>
          <I.ChevronL size={22} color={t.text} />
        </Pressable>
        <Text
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 20,
            fontWeight: '600',
            letterSpacing: -0.3,
            color: t.text,
          }}
        >
          {i18nT('lockSetup.title', 'Set up lock')}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        {/* Status banner */}
        <View
          style={{
            margin: 18,
            padding: 14,
            backgroundColor: appLockEnabled ? `${t.accent}14` : `${t.warn}14`,
            borderWidth: 1,
            borderColor: appLockEnabled ? `${t.accent}44` : `${t.warn}44`,
            borderRadius: t.radius,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: appLockEnabled ? `${t.accent}22` : `${t.warn}22`,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.Lock size={18} color={appLockEnabled ? t.accent : t.warn} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 13, color: t.text }}>
              {appLockEnabled ? i18nT('lockSetup.lockActive', 'Lock active') : i18nT('lockSetup.lockDisabled', 'Lock disabled')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
              {appLockEnabled
                ? i18nT('lockSetup.lockStatusSubActive', 'PIN {{pin}} · Biometrics {{bio}}', {
                    pin: hasPIN ? '✓' : '—',
                    bio: biometricsEnabled && bioAvailable ? '✓' : '—',
                  })
                : i18nT('lockSetup.lockStatusSubInactive', 'Create a PIN to enable lock')}
            </Text>
          </View>
        </View>

        {/* PIN section */}
        <Section t={t} label={i18nT('lockSetup.pinLabel', 'PIN')}>
          <Row
            t={t}
            icon={<I.Key size={20} color={t.textDim} />}
            label={hasPIN ? i18nT('lockSetup.changePin', 'Change PIN') : i18nT('lockSetup.pinSetup', 'Create PIN')}
            sub={hasPIN ? i18nT('lockSetup.changePinSub', 'Tap to set a new PIN') : i18nT('lockSetup.createPinSub', '4-digit PIN required for lock')}
            onPress={startCreatePIN}
          />
          {hasPIN && (
            <Row
              t={t}
              icon={<I.Trash size={20} color={t.danger} />}
              label={i18nT('lockSetup.removePin', 'Remove PIN')}
              sub={i18nT('lockSetup.removePinSub', 'Also disables lock and biometrics')}
              onPress={handleRemovePIN}
              noBorder
            />
          )}
        </Section>

        {/* Biometrics section */}
        <Section t={t} label={i18nT('lockSetup.bioLabel', 'BIOMETRICS')}>
          <Toggle
            t={t}
            icon={<I.Fingerprint size={20} color={t.textDim} />}
            label={i18nT('lockSetup.faceIdHuella', 'Face ID / Fingerprint')}
            sub={
              !bioAvailable
                ? i18nT('lockSetup.bioNotAvailable', 'Not available on this device')
                : hasPIN
                ? i18nT('lockSetup.bioUnlockSub', 'Unlock with biometrics in addition to PIN')
                : i18nT('lockSetup.bioCreatePinFirst', 'Create a PIN first')
            }
            value={biometricsEnabled && bioAvailable}
            onChange={handleToggleBiometrics}
            disabled={!bioAvailable || !hasPIN}
          />
        </Section>

        {/* App lock toggle + timeout */}
        <Section t={t} label={i18nT('lockSetup.configLabel', 'CONFIGURATION')}>
          <Toggle
            t={t}
            icon={<I.Lock size={20} color={t.textDim} />}
            label={i18nT('lockSetup.autoLock', 'Auto-lock')}
            sub={i18nT('lockSetup.autoLockSub', 'Locks the app when leaving foreground')}
            value={appLockEnabled}
            onChange={handleToggleLock}
          />
          {appLockEnabled && (
            <View
              style={{
                paddingHorizontal: 16,
                paddingBottom: 12,
                borderTopWidth: 1,
                borderTopColor: t.divider,
              }}
            >
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 11,
                  color: t.textDim,
                  letterSpacing: 0.8,
                  marginTop: 14,
                  marginBottom: 10,
                }}
              >
                {i18nT('lockSetup.lockAfter', 'LOCK AFTER')}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {TIMEOUT_OPTIONS.map((opt) => {
                  const selected = lockTimeoutMin === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => void setPref('lockTimeoutMin', opt.value)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        borderRadius: t.radiusS,
                        borderWidth: 1,
                        borderColor: selected ? t.accent : t.border,
                        backgroundColor: selected ? `${t.accent}1A` : t.surface2,
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      <Text
                        style={{
                          fontFamily: t.font,
                          fontSize: 13,
                          fontWeight: selected ? '600' : '400',
                          color: selected ? t.accent : t.text,
                        }}
                      >
                        {getTimeoutLabel(opt.value)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          <Row
            t={t}
            icon={<I.Shield size={20} color={t.textDim} />}
            label={i18nT('lockSetup.panicMode', 'Panic mode')}
            sub={i18nT('lockSetup.panicModeSub', 'Decoy PIN that wipes everything')}
            onPress={() => themedAlert(
              i18nT('lockSetup.panicMode', 'Panic mode'),
              i18nT('lockSetup.panicModeAlertMsg', 'Configurable from Privacy → Panic mode.')
            )}
            noBorder
          />
        </Section>

        {/* Security note */}
        <View
          style={{
            marginHorizontal: 18,
            marginTop: 8,
            padding: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <I.Shield size={14} color={t.accent} />
            <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 12, color: t.text }}>
              {i18nT('lockSetup.pinSecureTitle', 'Your PIN never leaves the device')}
            </Text>
          </View>
          <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
            {i18nT('lockSetup.pinSecureDesc', 'Saved as a salted SHA-256 hash in system Keychain (iOS) or Keystore (Android). Neither AegisLink nor anyone else has access.')}
          </Text>
        </View>
      </ScrollView>

      {/* PIN flow overlay */}
      {pinFlow && (
        <PinFlow
          step={pinFlow}
          t={t}
          onSuccess={handlePinFlowSuccess}
          onCancel={() => {
            setPinFlow(null);
            setPendingNewPin(null);
          }}
        />
      )}
    </View>
  );
}
