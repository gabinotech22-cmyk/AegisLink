import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, ScrollView, Modal, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ss } from '../utils/secureStore';
import { copySensitiveText } from '../utils/secureClipboard';
import nacl from 'tweetnacl';
import { encodeBase64, decodeUTF8 } from 'tweetnacl-util';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { useIdentity } from '../store/identity';
import { wipeDatabase } from '../db/local';
import { hashPinWithSalt, DURESS_PIN_SALT, verifyPIN } from '../lock/pin';

const PANIC_KEY = 'aegis.panic.v1';

interface Props {
  onBack: () => void;
}

const GESTURES = [
  { id: 'shake', l: 'SHAKE', s: 'Shake device vigorously', icon: 'Zap' as const },
  { id: 'tap', l: 'TRIPLE TAP', s: 'Tap 3 times rapidly on logo', icon: 'Shield' as const },
  { id: 'hold', l: 'HOLD 3s', s: 'Hold logo for 3 seconds', icon: 'Timer' as const },
] as const;

export function PanicScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [gesture, setGesture] = useState<string>('off');
  const [duressPin, setDuressPin] = useState(true);
  const [hidePin, setHidePin] = useState(false);
  const [autoWipe, setAutoWipe] = useState(false);
  const [pinLength, setPinLength] = useState(0);
  const [isEditingPin, setIsEditingPin] = useState(false);
  const [tempPin, setTempPin] = useState('');
  const [remoteToken, setRemoteToken] = useState('');
  const [remoteTokenSig, setRemoteTokenSig] = useState('');
  const [copied, setCopied] = useState(false);

  // Panic confirm modal state
  // step 0 = closed, step 1 = first confirm, step 2 = final confirm, step 3 = error
  const [panicStep, setPanicStep] = useState<0 | 1 | 2 | 3>(0);
  const [wiping, setWiping] = useState(false);

  // PIN modal inline feedback: null = no msg, 'invalid' | 'saved' | 'error'
  const [pinFeedback, setPinFeedback] = useState<null | 'invalid' | 'sameAsNormal' | 'saved' | 'error'>(null);

  // Regenerate-token confirm: null = idle, 'confirm' = showing confirm
  const [regenConfirm, setRegenConfirm] = useState(false);

  const resetIdentity = useIdentity((s) => s.reset);
  const identity = useIdentity((s) => s.identity);

  const getGestureLabel = (id: string) => {
    switch (id) {
      case 'shake': return i18nT('panic.shakeLabel');
      case 'tap': return i18nT('panic.tripleTapLabel');
      case 'hold': return i18nT('panic.holdLabel');
      default: return '';
    }
  };

  const getGestureDesc = (id: string) => {
    switch (id) {
      case 'shake': return i18nT('panic.shakeDesc');
      case 'tap': return i18nT('panic.tripleTapDesc');
      case 'hold': return i18nT('panic.holdDesc');
      default: return '';
    }
  };

  const persist = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const raw = await ss.get(PANIC_KEY);
      const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      await ss.set(PANIC_KEY, JSON.stringify({ ...current, ...patch }));
    } catch { /* storage unavailable */ }
  }, []);

  const generateAndSaveToken = useCallback(async () => {
    // H-5: bind the remote panic token to this device's identity by Ed25519-signing
    // it. Deep-link handlers MUST verify (token, sig) against the local signing
    // public key before wiping, so a leaked token alone is useless to an attacker.
    if (!identity?.signingSecretKey) return; // identity not yet hydrated — defer
    const { randomUUID } = require('expo-crypto') as typeof import('expo-crypto');
    const token = randomUUID();
    const sigBytes = nacl.sign.detached(decodeUTF8(token), identity.signingSecretKey);
    const sig = encodeBase64(sigBytes);
    setRemoteToken(token);
    setRemoteTokenSig(sig);
    await persist({ remoteToken: token, remoteTokenSig: sig });
  }, [persist, identity?.signingSecretKey]);

  const copyLink = useCallback(async () => {
    if (!remoteToken || !remoteTokenSig) return;
    // Both halves are required — the deep-link handler rejects unsigned tokens.
    await copySensitiveText(
      `aegislink://panic?token=${remoteToken}&sig=${encodeURIComponent(remoteTokenSig)}`,
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [remoteToken, remoteTokenSig]);

  useEffect(() => {
    ss.get(PANIC_KEY).then((raw) => {
      if (!raw) {
        void generateAndSaveToken();
        return;
      }
      try {
        const s = JSON.parse(raw) as { gesture?: string; duressPin?: boolean; hidePin?: boolean; autoWipe?: boolean; pinLength?: number; remoteToken?: string; remoteTokenSig?: string };
        if (s.gesture !== undefined) setGesture(s.gesture);
        if (s.duressPin !== undefined) setDuressPin(s.duressPin);
        if (s.hidePin !== undefined) setHidePin(s.hidePin);
        if (s.autoWipe !== undefined) setAutoWipe(s.autoWipe);
        if (typeof s.pinLength === 'number') setPinLength(s.pinLength);
        // Migrate legacy unsigned tokens (pre-H-5): regenerate to attach signature.
        if (typeof s.remoteToken === 'string' && s.remoteToken && typeof s.remoteTokenSig === 'string' && s.remoteTokenSig) {
          setRemoteToken(s.remoteToken);
          setRemoteTokenSig(s.remoteTokenSig);
        } else {
          void generateAndSaveToken();
        }
      } catch { /* corrupt */ }
    }).catch(() => {});
  // generateAndSaveToken is stable (useCallback with stable dep)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('panic.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: 22 }}>
        <View style={{ paddingHorizontal: 28, paddingTop: 6, paddingBottom: 22, alignItems: 'center' }}>
          <View
            style={{
              width: 76,
              height: 76,
              borderRadius: 38,
              backgroundColor: t.dark ? 'rgba(255,107,107,0.12)' : 'rgba(184,68,42,0.08)',
              borderWidth: 1,
              borderColor: `${t.danger}55`,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            <I.Shield size={32} stroke={1.8} color={t.danger} />
          </View>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 24, fontWeight: '600', letterSpacing: -0.4, color: t.text, textAlign: 'center' }}>
            {i18nT('panic.heroTitle')}
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19, textAlign: 'center', maxWidth: 290, marginTop: 10 }}>
            {i18nT('panic.heroDesc')}
          </Text>
        </View>

        <View style={{ paddingHorizontal: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>
              {i18nT('panic.gestureSection')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 11, color: t.danger }}>
              {i18nT('panic.gestureAction')}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {GESTURES.map((o) => {
              const selected = gesture === o.id;
              const GestureIcon = I[o.icon];
              return (
                <Pressable
                  key={o.id}
                  onPress={() => { setGesture(o.id); void persist({ gesture: o.id }); }}
                  accessibilityLabel={`Select ${getGestureLabel(o.id)} panic gesture`}
                  style={({ pressed }) => ({
                    flex: 1,
                    padding: 12,
                    borderRadius: t.radius,
                    borderWidth: 2,
                    borderColor: selected ? t.accent : t.border,
                    backgroundColor: selected ? `${t.accent}11` : t.surface,
                    alignItems: 'center',
                    gap: 8,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <GestureIcon size={22} color={selected ? t.accent : t.textDim} />
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: selected ? t.accent : t.text, letterSpacing: 0.5, textAlign: 'center' }}>
                    {getGestureLabel(o.id)}
                  </Text>
                  <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, textAlign: 'center', lineHeight: 15 }}>
                    {getGestureDesc(o.id)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Section t={t} label={i18nT('panic.remoteTriggerSection')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17, marginBottom: 12 }}>
              {i18nT('panic.remoteTriggerDesc')}
            </Text>
            <View
              style={{
                backgroundColor: t.surface2,
                borderRadius: t.radiusS,
                padding: 10,
                marginBottom: 10,
              }}
            >
              <Text
                style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text, letterSpacing: 0.2 }}
                selectable
              >
                {remoteToken ? `aegislink://panic?token=${remoteToken}` : '...'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                onPress={() => void copyLink()}
                style={({ pressed }) => ({
                  flex: 1,
                  backgroundColor: copied ? t.accent : t.surface2,
                  borderRadius: t.radiusS,
                  paddingVertical: 10,
                  alignItems: 'center',
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text
                  style={{
                    fontFamily: t.font,
                    fontSize: 13,
                    fontWeight: '500',
                    color: copied ? t.accentInk : t.text,
                  }}
                >
                  {copied ? i18nT('panic.copied') : i18nT('panic.copyLink')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setRegenConfirm(true)}
                style={({ pressed }) => ({
                  borderWidth: 1,
                  borderColor: t.borderStrong,
                  borderRadius: t.radiusS,
                  paddingVertical: 10,
                  paddingHorizontal: 14,
                  alignItems: 'center',
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger }}>
                  {i18nT('panic.regenerate')}
                </Text>
              </Pressable>
            </View>
          </View>
        </Section>

        <Section t={t} label={i18nT('panic.duressPinSection')}>
          <Toggle
            t={t}
            label={i18nT('panic.activateDecoyPin')}
            sub={i18nT('panic.duressPinAction')}
            value={duressPin}
            onChange={(v) => { setDuressPin(v); void persist({ duressPin: v }); }}
          />
          {duressPin && !hidePin && (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5, marginBottom: 8 }}>
                {i18nT('panic.currentPin')}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {Array.from({ length: pinLength }).map((_, i) => (
                  <View
                    key={i}
                    style={{
                      flex: 1,
                      height: 38,
                      backgroundColor: t.surface2,
                      borderRadius: t.radiusS,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: t.text, fontSize: 18 }}>●</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
          {duressPin && (
            <Toggle
              t={t}
              label={i18nT('panic.hidePinLength')}
              sub={i18nT('panic.hidePinLengthSub')}
              value={hidePin}
              onChange={(v) => { setHidePin(v); void persist({ hidePin: v }); }}
            />
          )}
          <Pressable
            onPress={() => {
              // Never pre-fill from storage: only the hash is persisted.
              setTempPin('');
              setIsEditingPin(true);
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 16,
              paddingVertical: 12,
              backgroundColor: pressed ? t.surface2 : 'transparent',
            })}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{i18nT('panic.changeDecoyPin')}</Text>
            </View>
            <I.Chevron size={14} color={t.textFaint} />
          </Pressable>
        </Section>

        <Section t={t} label={i18nT('panic.autoWipeSection')}>
          <Toggle
            t={t}
            label={i18nT('panic.autoWipe')}
            sub={i18nT('panic.autoWipeSub')}
            value={autoWipe}
            onChange={(v) => { setAutoWipe(v); void persist({ autoWipe: v }); }}
            noBorder
          />
        </Section>

        <View style={{ paddingHorizontal: 18 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={i18nT('panic.activatePanic')}
            onPress={() => setPanicStep(1)}
            style={({ pressed }) => ({
              backgroundColor: t.danger,
              paddingVertical: 14,
              borderRadius: t.radius,
              alignItems: 'center',
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ color: '#fff', fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>
              {i18nT('panic.activatePanic')}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* Panic Confirm Modal — two-step destructive confirmation, fully themed */}
      <Modal visible={panicStep !== 0} transparent animationType="fade">
        <View style={styles.modalBg}>
          <View style={[styles.modalContent, { backgroundColor: t.surface, borderColor: t.danger }]}>
            {/* Step 1: First confirmation */}
            {panicStep === 1 && (
              <>
                <View style={{ alignItems: 'center', marginBottom: 16 }}>
                  <View style={{
                    width: 52, height: 52, borderRadius: 26,
                    backgroundColor: `${t.danger}22`,
                    borderWidth: 1, borderColor: `${t.danger}66`,
                    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
                  }}>
                    <I.Shield size={26} stroke={1.8} color={t.danger} />
                  </View>
                  <Text style={[styles.modalTitle, { color: t.danger, fontFamily: t.fontDisplay }]}>
                    {i18nT('panic.activatePanicTitle')}
                  </Text>
                </View>
                <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 13, marginBottom: 20, lineHeight: 18, textAlign: 'center' }}>
                  {i18nT('panic.activatePanicDesc')}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={i18nT('common.cancel')}
                    onPress={() => setPanicStep(0)}
                    style={{
                      flex: 1, borderWidth: 1, borderColor: t.borderStrong,
                      paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500' }}>
                      {i18nT('common.cancel')}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={i18nT('panic.wipeAll')}
                    onPress={() => setPanicStep(2)}
                    style={{
                      flex: 1, backgroundColor: t.danger,
                      paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: '#fff', fontFamily: t.font, fontWeight: '600' }}>
                      {i18nT('panic.wipeAll')}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}

            {/* Step 2: Final confirmation */}
            {panicStep === 2 && (
              <>
                <View style={{ alignItems: 'center', marginBottom: 16 }}>
                  <View style={{
                    width: 52, height: 52, borderRadius: 26,
                    backgroundColor: t.danger,
                    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
                  }}>
                    <I.Shield size={26} stroke={2} color="#fff" />
                  </View>
                  <Text style={[styles.modalTitle, { color: t.danger, fontFamily: t.fontDisplay }]}>
                    {i18nT('panic.areYouSure')}
                  </Text>
                </View>
                <Text style={{ color: t.text, fontFamily: t.fontMono, fontSize: 12, letterSpacing: 0.3, marginBottom: 6, textAlign: 'center' }}>
                  {i18nT('panic.cannotUndo')}
                </Text>
                <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 12, marginBottom: 20, lineHeight: 17, textAlign: 'center' }}>
                  {i18nT('panic.activatePanicDesc')}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={i18nT('common.cancel')}
                    onPress={() => setPanicStep(0)}
                    disabled={wiping}
                    style={{
                      flex: 1, borderWidth: 1, borderColor: t.borderStrong,
                      paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center',
                      opacity: wiping ? 0.4 : 1,
                    }}
                  >
                    <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500' }}>
                      {i18nT('common.cancel')}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={i18nT('panic.wipeAllCaps')}
                    disabled={wiping}
                    onPress={async () => {
                      setWiping(true);
                      try {
                        await wipeDatabase();
                        await resetIdentity();
                        // resetIdentity sets identity → null → App.tsx navigates to onboarding.
                        // Modal will unmount with the screen; no need to reset panicStep.
                      } catch {
                        setWiping(false);
                        setPanicStep(3);
                      }
                    }}
                    style={({ pressed }) => ({
                      flex: 1, backgroundColor: t.danger,
                      paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center',
                      opacity: wiping || pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ color: '#fff', fontFamily: t.fontMono, fontWeight: '700', fontSize: 13, letterSpacing: 0.8 }}>
                      {wiping ? '...' : i18nT('panic.wipeAllCaps')}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}

            {/* Step 3: Error state — wipe failed */}
            {panicStep === 3 && (
              <>
                <View style={{ alignItems: 'center', marginBottom: 16 }}>
                  <Text style={[styles.modalTitle, { color: t.danger, fontFamily: t.fontDisplay }]}>
                    {i18nT('panic.wipeFailed')}
                  </Text>
                </View>
                <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 13, marginBottom: 20, lineHeight: 18, textAlign: 'center' }}>
                  {i18nT('panic.wipeFailedDesc')}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={i18nT('common.cancel')}
                    onPress={() => setPanicStep(0)}
                    style={{
                      flex: 1, borderWidth: 1, borderColor: t.borderStrong,
                      paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500' }}>
                      {i18nT('common.cancel')}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={i18nT('common.retry')}
                    onPress={() => setPanicStep(2)}
                    style={{
                      flex: 1, backgroundColor: t.danger,
                      paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: '#fff', fontFamily: t.font, fontWeight: '600' }}>
                      {i18nT('common.retry')}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Change Duress PIN Modal */}
      <Modal visible={isEditingPin} transparent animationType="fade">
        <View style={styles.modalBg}>
          <View style={[styles.modalContent, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Text style={[styles.modalTitle, { color: t.text, fontFamily: t.fontDisplay }]}>
              {i18nT('panic.duressPinModalTitle')}
            </Text>
            <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 13, marginBottom: 16, lineHeight: 18 }}>
              {i18nT('panic.duressPinModalDesc')}
            </Text>
            <TextInput
              placeholder={i18nT('panic.duressPinPlaceholder')}
              placeholderTextColor={t.textDim}
              value={tempPin}
              onChangeText={(val) => setTempPin(val.replace(/[^0-9]/g, ''))}
              keyboardType="numeric"
              maxLength={4}
              secureTextEntry
              autoFocus
              style={{
                color: t.text,
                backgroundColor: t.bg,
                borderColor: t.borderStrong,
                borderWidth: 1,
                borderRadius: t.radiusS,
                padding: 12,
                fontSize: 18,
                marginBottom: 20,
                fontFamily: t.fontMono,
                textAlign: 'center',
                letterSpacing: 8,
              }}
            />
            {/* Inline feedback row — replaces Alert.alert for invalid/saved/error */}
            {pinFeedback !== null && (
              <View style={{
                backgroundColor: pinFeedback === 'saved' ? `${t.accent}22` : `${t.danger}22`,
                borderWidth: 1,
                borderColor: pinFeedback === 'saved' ? t.accent : t.danger,
                borderRadius: t.radiusS,
                padding: 10,
                marginBottom: 12,
              }}>
                <Text style={{
                  fontFamily: t.font, fontSize: 12, lineHeight: 16,
                  color: pinFeedback === 'saved' ? t.accent : t.danger,
                  textAlign: 'center',
                }}>
                  {pinFeedback === 'invalid'
                    ? i18nT('panic.invalidPinDesc')
                    : pinFeedback === 'sameAsNormal'
                      ? i18nT('panic.decoyPinSameAsNormal', 'The decoy PIN cannot be the same as the lock PIN.')
                      : pinFeedback === 'saved'
                        ? i18nT('panic.pinSavedDesc')
                        : i18nT('panic.pinSaveErrorDesc')}
                </Text>
              </View>
            )}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={i18nT('panic.savePinBtn')}
                onPress={() => {
                  if (tempPin.length !== 4) {
                    setPinFeedback('invalid');
                    return;
                  }
                  setPinFeedback(null);
                  const len = tempPin.length;
                  void (async () => {
                    try {
                      const isNormalPin = await verifyPIN(tempPin);
                      if (isNormalPin) {
                        setPinFeedback('sameAsNormal');
                        return;
                      }
                      const pinHash = await hashPinWithSalt(tempPin, DURESS_PIN_SALT);
                      setPinLength(len);
                      await persist({ pinHash, pinLength: len, pinValue: undefined });
                      setTempPin('');
                      setPinFeedback('saved');
                      // Close after a brief moment so the user sees the confirmation.
                      setTimeout(() => {
                        setIsEditingPin(false);
                        setPinFeedback(null);
                      }, 1200);
                    } catch {
                      setPinFeedback('error');
                    }
                  })();
                }}
                style={{
                  flex: 1,
                  backgroundColor: t.danger,
                  paddingVertical: 12,
                  borderRadius: t.radiusS,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontFamily: t.font, fontWeight: '600' }}>
                  {i18nT('panic.savePinBtn')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={i18nT('common.cancel')}
                onPress={() => { setIsEditingPin(false); setPinFeedback(null); }}
                style={{
                  flex: 1,
                  borderWidth: 1,
                  borderColor: t.borderStrong,
                  paddingVertical: 12,
                  borderRadius: t.radiusS,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500' }}>
                  {i18nT('common.cancel')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      {/* Regenerate token confirm modal */}
      <Modal visible={regenConfirm} transparent animationType="fade">
        <View style={styles.modalBg}>
          <View style={[styles.modalContent, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Text style={[styles.modalTitle, { color: t.text, fontFamily: t.fontDisplay }]}>
              {i18nT('panic.regenerateConfirmTitle')}
            </Text>
            <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 13, marginBottom: 20, lineHeight: 18 }}>
              {i18nT('panic.regenerateConfirmDesc')}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={i18nT('common.cancel')}
                onPress={() => setRegenConfirm(false)}
                style={{
                  flex: 1, borderWidth: 1, borderColor: t.borderStrong,
                  paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center',
                }}
              >
                <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500' }}>
                  {i18nT('common.cancel')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={i18nT('panic.regenerate')}
                onPress={() => { setRegenConfirm(false); void generateAndSaveToken(); }}
                style={{
                  flex: 1, backgroundColor: t.danger,
                  paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontFamily: t.font, fontWeight: '600' }}>
                  {i18nT('panic.regenerate')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 24,
  },
  modalContent: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
});
