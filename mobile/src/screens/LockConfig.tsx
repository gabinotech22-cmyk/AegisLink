import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Modal, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { usePreferences } from '../store/preferences';
import { setPIN, hasStoredPIN, clearPIN } from '../lock/pin';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
  onLockTest: () => void;
  onLockSettings?: () => void;
}

const TIMEOUT_OPTIONS = [
  { value: 0 },
  { value: 1 },
  { value: 5 },
  { value: 15 },
  { value: 60 },
];

// ── PIN numpad shared component ───────────────────────────────────────────────
function PinDots({ count, t }: { count: number; t: Theme }) {
  return (
    <View style={{ flexDirection: 'row', gap: 16, justifyContent: 'center', marginVertical: 28 }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View
          key={i}
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: i < count ? t.accent : 'transparent',
            borderWidth: 2,
            borderColor: i < count ? t.accent : t.borderStrong,
          }}
        />
      ))}
    </View>
  );
}

// numpad keys stay numeric and symbolic - no localization needed
function Numpad({ onDigit, onDelete, t }: { onDigit: (d: string) => void; onDelete: () => void; t: Theme }) {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 240, alignSelf: 'center' }}>
      {keys.map((k, i) => {
        if (!k) return <View key={i} style={{ width: 80, height: 64 }} />;
        const isDelete = k === '⌫';
        return (
          <Pressable
            key={i}
            onPress={() => isDelete ? onDelete() : onDigit(k)}
            style={({ pressed }) => ({
              width: 80,
              height: 64,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                backgroundColor: isDelete ? 'transparent' : t.surface2,
                borderWidth: isDelete ? 0 : 1,
                borderColor: t.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  fontFamily: isDelete ? t.font : t.fontDisplay,
                  fontSize: isDelete ? 20 : 22,
                  fontWeight: '500',
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

// ── LockConfigScreen ──────────────────────────────────────────────────────────
export function LockConfigScreen({ onBack, onLockTest, onLockSettings }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const appLockEnabled = usePreferences((s) => s.appLockEnabled);
  const biometricsEnabled = usePreferences((s) => s.biometricsEnabled);
  const lockTimeoutMin = usePreferences((s) => s.lockTimeoutMin);
  const hideRecents = usePreferences((s) => s.hideRecents);
  const setPref = usePreferences((s) => s.set);

  const [bioAvailable, setBioAvailable] = useState(false);
  const [pinStored, setPinStored] = useState(false);
  const [pinModal, setPinModal] = useState(false);
  const [pinStep, setPinStep] = useState<'enter' | 'confirm'>('enter');
  const [firstPin, setFirstPin] = useState('');
  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState('');
  const [showTimeout, setShowTimeout] = useState(false);
  const shakeAnim = useRef(new Animated.Value(0)).current;
  // Pending enable: if user triggers enable but has no PIN, we wait for PIN setup
  const pendingEnable = useRef(false);

  const [bioAvailable, setBioAvailable] = useState(false);

  useEffect(() => {
    hasStoredPIN().then(setPinStored);
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const LA = require('expo-local-authentication') as { hasHardwareAsync(): Promise<boolean>; isEnrolledAsync(): Promise<boolean> };
        const hasHw = await LA.hasHardwareAsync();
        const enrolled = await LA.isEnrolledAsync();
        setBioAvailable(hasHw && enrolled);
      } catch {
        setBioAvailable(false);
      }
    })();
  }, []);

  function shake() {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  }

  function openPinModal(isPendingEnable = false) {
    pendingEnable.current = isPendingEnable;
    setPinStep('enter');
    setFirstPin('');
    setPinEntry('');
    setPinError('');
    setPinModal(true);
  }

  function handleDigit(d: string) {
    if (pinEntry.length >= 6) return;
    const next = pinEntry + d;
    setPinEntry(next);
    setPinError('');
    if (next.length === 6) {
      setTimeout(() => processPin(next), 180);
    }
  }

  function handleDelete() {
    setPinEntry((p) => p.slice(0, -1));
    setPinError('');
  }

  async function processPin(pin: string) {
    if (pinStep === 'enter') {
      setFirstPin(pin);
      setPinStep('confirm');
      setPinEntry('');
    } else {
      if (pin !== firstPin) {
        setPinError(i18nT('lockConfig.pinMismatch', 'PINs do not match. Try again.'));
        shake();
        setPinEntry('');
        setPinStep('enter');
        setFirstPin('');
      } else {
        await setPIN(pin);
        setPinStored(true);
        if (pendingEnable.current) {
          void setPref('appLockEnabled', true);
          pendingEnable.current = false;
        }
        setPinModal(false);
        setPinStep('enter');
        setFirstPin('');
        setPinEntry('');
      }
    }
  }

  async function handleToggleAppLock(val: boolean) {
    if (val && !pinStored) {
      openPinModal(true);
      return;
    }
    void setPref('appLockEnabled', val);
  }

  function handleClearPin() {
    themedAlert(
      i18nT('lockConfig.deletePinAlertTitle', 'Delete PIN'),
      i18nT('lockConfig.deletePinAlertMsg', 'App lock will be disabled and the PIN deleted. You will need to set a new one to enable it again.'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: i18nT('lockConfig.deletePin', 'Delete PIN'),
          style: 'destructive',
          onPress: async () => {
            await clearPIN();
            setPinStored(false);
            void setPref('appLockEnabled', false);
          },
        },
      ]
    );
  }

  const getTimeoutLabel = useCallback((val: number) => {
    if (val === 0) return i18nT('lockSetup.immediately', 'Immediately');
    if (val === 60) return i18nT('lockSetup.hours_one', '1 hour');
    return i18nT('lockSetup.minutes', '{{count}} minutes', { count: val });
  }, [i18nT]);

  const timeoutLabel = getTimeoutLabel(lockTimeoutMin);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('lockConfig.titleBar', 'App Lock')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {/* ── App lock master toggle ── */}
        <Section t={t} label={i18nT('lockConfig.accessProtection', 'ACCESS PROTECTION')}>
          <Toggle
            t={t}
            label={i18nT('lockConfig.appLock', 'App lock')}
            sub={appLockEnabled ? i18nT('lockConfig.appLockActive', 'Active · Authentication required to open') : i18nT('lockConfig.appLockDisabled', 'Disabled')}
            value={appLockEnabled}
            onChange={handleToggleAppLock}
          />

          {appLockEnabled && (
            <>
              {bioAvailable && (
                <Toggle
                  t={t}
                  label={i18nT('lockConfig.biometrics', 'Face ID / Fingerprint')}
                  sub={i18nT('lockConfig.biometricsSub', 'Use biometrics as primary method')}
                  value={biometricsEnabled}
                  onChange={(v) => void setPref('biometricsEnabled', v)}
                />
              )}

              {/* Timeout picker row */}
              <Pressable
                onPress={() => setShowTimeout((v) => !v)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: 16,
                  paddingVertical: 13,
                  backgroundColor: pressed ? t.surface2 : 'transparent',
                  borderBottomWidth: 1,
                  borderBottomColor: t.divider,
                })}
              >
                <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>
                  {i18nT('lockConfig.inactivityTime', 'Inactivity timeout')}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent }}>
                    {timeoutLabel}
                  </Text>
                  <I.ChevronD size={14} color={t.textFaint} />
                </View>
              </Pressable>

              {showTimeout && (
                <View style={{ backgroundColor: t.surface2 }}>
                  {TIMEOUT_OPTIONS.map((opt, i) => (
                    <Pressable
                      key={opt.value}
                      onPress={() => {
                        void setPref('lockTimeoutMin', opt.value);
                        setShowTimeout(false);
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 24,
                        paddingVertical: 12,
                        backgroundColor: pressed ? t.surface3 : 'transparent',
                        borderBottomWidth: i < TIMEOUT_OPTIONS.length - 1 ? 1 : 0,
                        borderBottomColor: t.divider,
                      })}
                    >
                      <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>
                        {getTimeoutLabel(opt.value)}
                      </Text>
                      {lockTimeoutMin === opt.value && (
                        <I.Check size={16} color={t.accent} />
                      )}
                    </Pressable>
                  ))}
                </View>
              )}

              {/* PIN management */}
              <Pressable
                onPress={() => openPinModal(false)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: 16,
                  paddingVertical: 13,
                  backgroundColor: pressed ? t.surface2 : 'transparent',
                  borderBottomWidth: 1,
                  borderBottomColor: t.divider,
                })}
              >
                <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>
                  {pinStored ? i18nT('lockConfig.changePin', 'Change PIN') : i18nT('lockConfig.setPin', 'Set PIN')}
                </Text>
                <I.Chevron size={16} color={t.textFaint} />
              </Pressable>

              {pinStored && (
                <Pressable
                  onPress={handleClearPin}
                  style={({ pressed }) => ({
                    paddingHorizontal: 16,
                    paddingVertical: 13,
                    backgroundColor: pressed ? t.surface2 : 'transparent',
                    borderBottomWidth: 1,
                    borderBottomColor: t.divider,
                  })}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 14, color: t.danger }}>
                    {i18nT('lockConfig.deletePin', 'Delete PIN')}
                  </Text>
                </Pressable>
              )}

              {/* Test lock */}
              <Pressable
                onPress={onLockTest}
                style={({ pressed }) => ({
                  paddingHorizontal: 16,
                  paddingVertical: 13,
                  backgroundColor: pressed ? t.surface2 : 'transparent',
                })}
              >
                <Text style={{ fontFamily: t.font, fontSize: 14, color: t.accent }}>
                  {i18nT('lockConfig.lockNowTest', 'Lock now (Test) ▸')}
                </Text>
              </Pressable>
            </>
          )}
        </Section>

        {/* ── Advanced lock settings ── */}
        {onLockSettings ? (
          <Section t={t} label={i18nT('lockConfig.advanced', 'ADVANCED')}>
            <Pressable
              onPress={onLockSettings}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                paddingVertical: 13,
                backgroundColor: pressed ? t.surface2 : 'transparent',
              })}
            >
              <I.Settings size={16} color={t.textDim} />
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text, marginLeft: 10, flex: 1 }}>
                {i18nT('lockConfig.lockSettings', 'Lock Settings')}
              </Text>
              <I.Chevron size={14} color={t.textFaint} />
            </Pressable>
          </Section>
        ) : null}

        {/* ── Pantalla en multitarea ── */}
        <Section t={t} label={i18nT('lockConfig.screenPrivacy', 'SCREEN PRIVACY')}>
          <Toggle
            t={t}
            label={i18nT('lockConfig.hideRecents', 'Hide in recents')}
            sub={i18nT('lockConfig.hideRecentsSub', 'Screen goes black when switching apps')}
            value={hideRecents}
            onChange={(v) => void setPref('hideRecents', v)}
            noBorder
          />
        </Section>

        <View style={{ paddingHorizontal: 18, marginTop: 10 }}>
          <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
            {i18nT('lockConfig.bioDisclaimer', 'AegisLink has no access to your biometric data. They are processed locally by your device\'s Secure Enclave. The PIN never leaves the device.')}
          </Text>
        </View>
      </ScrollView>

      {/* ── PIN Setup Modal ── */}
      <Modal visible={pinModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPinModal(false)}>
        <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: 20 }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: t.divider }}>
            <Pressable onPress={() => { setPinModal(false); pendingEnable.current = false; }} hitSlop={10}>
              <Text style={{ fontFamily: t.font, fontSize: 15, color: t.accent }}>{i18nT('common.cancel', 'Cancel')}</Text>
            </Pressable>
            <Text style={{ flex: 1, textAlign: 'center', fontFamily: t.font, fontSize: 16, fontWeight: '600', color: t.text }}>
              {pinStored ? i18nT('lockConfig.changePin', 'Change PIN') : i18nT('lockConfig.setPin', 'Set PIN')}
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 40 }}>
            <Text style={{ fontFamily: t.font, fontSize: 15, color: t.textDim, marginBottom: 4 }}>
              {pinStep === 'enter' ? i18nT('lockConfig.enterPinPrompt', 'Enter a 6-digit PIN') : i18nT('lockConfig.confirmPinPrompt', 'Confirm your PIN')}
            </Text>

            <Animated.View style={{ transform: [{ translateX: shakeAnim }] }}>
              <PinDots count={pinEntry.length} t={t} />
            </Animated.View>

            {pinError ? (
              <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger, marginBottom: 16, textAlign: 'center', paddingHorizontal: 40 }}>
                {pinError}
              </Text>
            ) : (
              <View style={{ height: 36 }} />
            )}

            <Numpad onDigit={handleDigit} onDelete={handleDelete} t={t} />
          </View>
        </View>
      </Modal>
    </View>
  );
}
