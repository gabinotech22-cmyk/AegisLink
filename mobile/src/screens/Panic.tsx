import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, ScrollView, Alert, Modal, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { useIdentity } from '../store/identity';
import { wipeDatabase } from '../db/local';
import { hashPinWithSalt, DURESS_PIN_SALT } from '../lock/pin';

const PANIC_KEY = 'aegis.panic.v1';

interface Props {
  onBack: () => void;
}

const GESTURES = [
  { id: 'shake', l: 'SHAKE', s: 'Shake device vigorously', icon: 'Zap' as const },
  { id: 'tap', l: 'TRIPLE TAP', s: 'Tap 3 times rapidly on logo', icon: 'Shield' as const },
  { id: 'volume', l: 'VOLUME +', s: 'Press volume up 3 times', icon: 'Volume' as const },
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
  const [copied, setCopied] = useState(false);

  const resetIdentity = useIdentity((s) => s.reset);

  const getGestureLabel = (id: string) => {
    switch (id) {
      case 'shake': return i18nT('panic.shakeLabel');
      case 'tap': return i18nT('panic.tripleTapLabel');
      case 'volume': return i18nT('panic.volumeLabel');
      default: return '';
    }
  };

  const getGestureDesc = (id: string) => {
    switch (id) {
      case 'shake': return i18nT('panic.shakeDesc');
      case 'tap': return i18nT('panic.tripleTapDesc');
      case 'volume': return i18nT('panic.volumeDesc');
      default: return '';
    }
  };

  const persist = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const raw = await SecureStore.getItemAsync(PANIC_KEY);
      const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      await SecureStore.setItemAsync(PANIC_KEY, JSON.stringify({ ...current, ...patch }));
    } catch { /* storage unavailable */ }
  }, []);

  const generateAndSaveToken = useCallback(async () => {
    const { randomUUID } = require('expo-crypto') as typeof import('expo-crypto');
    const token = randomUUID();
    setRemoteToken(token);
    await persist({ remoteToken: token });
  }, [persist]);

  const copyLink = useCallback(async () => {
    if (!remoteToken) return;
    await Clipboard.setStringAsync(`aegislink://panic?token=${remoteToken}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [remoteToken]);

  useEffect(() => {
    SecureStore.getItemAsync(PANIC_KEY).then((raw) => {
      if (!raw) {
        void generateAndSaveToken();
        return;
      }
      try {
        const s = JSON.parse(raw) as { gesture?: string; duressPin?: boolean; hidePin?: boolean; autoWipe?: boolean; pinLength?: number; remoteToken?: string };
        if (s.gesture !== undefined) setGesture(s.gesture);
        if (s.duressPin !== undefined) setDuressPin(s.duressPin);
        if (s.hidePin !== undefined) setHidePin(s.hidePin);
        if (s.autoWipe !== undefined) setAutoWipe(s.autoWipe);
        if (typeof s.pinLength === 'number') setPinLength(s.pinLength);
        if (typeof s.remoteToken === 'string' && s.remoteToken) {
          setRemoteToken(s.remoteToken);
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
                onPress={() =>
                  Alert.alert(
                    i18nT('panic.regenerateConfirmTitle'),
                    i18nT('panic.regenerateConfirmDesc'),
                    [
                      { text: i18nT('common.cancel'), style: 'cancel' },
                      { text: i18nT('panic.regenerate'), style: 'destructive', onPress: () => void generateAndSaveToken() },
                    ]
                  )
                }
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
            onPress={() => {
              Alert.alert(
                i18nT('panic.activatePanicTitle'),
                i18nT('panic.activatePanicDesc'),
                [
                  { text: i18nT('common.cancel'), style: 'cancel' },
                  {
                    text: i18nT('panic.wipeAll'),
                    style: 'destructive',
                    onPress: () =>
                      Alert.alert(
                        i18nT('panic.areYouSure'),
                        i18nT('panic.cannotUndo'),
                        [
                          { text: i18nT('common.cancel'), style: 'cancel' },
                          {
                            text: i18nT('panic.wipeAllCaps'),
                            style: 'destructive',
                            onPress: async () => {
                              try {
                                await wipeDatabase();
                                await resetIdentity();
                              } catch (e) {
                                if (__DEV__) console.error('[panic] wipe failed', e);
                              }
                            },
                          },
                        ]
                      ),
                  },
                ]
              );
            }}
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
              maxLength={6}
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
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={() => {
                  if (tempPin.length < 4 || tempPin.length > 6) {
                    Alert.alert(i18nT('panic.invalidPin'), i18nT('panic.invalidPinDesc'));
                    return;
                  }
                  const len = tempPin.length;
                  void (async () => {
                    try {
                      const pinHash = await hashPinWithSalt(tempPin, DURESS_PIN_SALT);
                      setPinLength(len);
                      await persist({ pinHash, pinLength: len, pinValue: undefined });
                      setTempPin('');
                      setIsEditingPin(false);
                      Alert.alert(i18nT('panic.pinSaved'), i18nT('panic.pinSavedDesc'));
                    } catch {
                      Alert.alert(i18nT('panic.pinSaveError'), i18nT('panic.pinSaveErrorDesc'));
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
                onPress={() => setIsEditingPin(false)}
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
