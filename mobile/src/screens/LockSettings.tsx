import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ss } from '../utils/secureStore';
import { Switch } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section } from '../components/Section';

const LOCK_SETTINGS_KEY = 'aegis.lockSettings';

interface LockSettingsData {
  biometrics: boolean;
  autoLockMinutes: number; // 1, 5, 30
  lockOnBackground: boolean;
}

const AUTO_LOCK_OPTIONS = [
  { value: 1 },
  { value: 5 },
  { value: 30 },
];

interface Props {
  onBack: () => void;
}

export function LockSettingsScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  const [biometrics, setBiometrics] = useState(false);
  const [autoLockMinutes, setAutoLockMinutes] = useState(5);
  const [lockOnBackground, setLockOnBackground] = useState(true);

  useEffect(() => {
    ss.get(LOCK_SETTINGS_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const s = JSON.parse(raw) as LockSettingsData;
          setBiometrics(s.biometrics ?? false);
          setAutoLockMinutes(s.autoLockMinutes ?? 5);
          setLockOnBackground(s.lockOnBackground ?? true);
        } catch { /* corrupt */ }
      })
      .catch(() => {});
  }, []);

  async function save(patch: Partial<LockSettingsData>) {
    try {
      const raw = await ss.get(LOCK_SETTINGS_KEY);
      const current: LockSettingsData = raw
        ? (JSON.parse(raw) as LockSettingsData)
        : { biometrics, autoLockMinutes, lockOnBackground };
      await ss.set(LOCK_SETTINGS_KEY, JSON.stringify({ ...current, ...patch }));
    } catch { /* storage unavailable */ }
  }

  function handleBiometrics(v: boolean) {
    setBiometrics(v);
    void save({ biometrics: v });
    if (v) {
      Alert.alert(
        i18nT('lockSettings.biometricsAlertTitle', 'Biometrics'),
        i18nT('lockSettings.biometricsAlertMsg', 'Face ID / fingerprint will be used to unlock the app. Make sure you have biometrics configured in your device settings.')
      );
    }
  }

  function handleAutoLock(minutes: number) {
    setAutoLockMinutes(minutes);
    void save({ autoLockMinutes: minutes });
  }

  function handleLockOnBackground(v: boolean) {
    setLockOnBackground(v);
    void save({ lockOnBackground: v });
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('lockSettings.title', 'Lock Settings')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }} accessibilityLabel="Go back">
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: 32 }}>
        <Section t={t} label={i18nT('lockSettings.security', 'SECURITY')}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: t.divider,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>
                {i18nT('lockSettings.requireBiometrics', 'Require biometrics')}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                {i18nT('lockSettings.bioUnlockDesc', 'Face ID / fingerprint unlock')}
              </Text>
            </View>
            <Switch
              value={biometrics}
              onValueChange={handleBiometrics}
              trackColor={{ false: t.surface3, true: t.accent }}
              thumbColor={biometrics ? t.accentInk : t.textFaint}
            />
          </View>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>
                {i18nT('lockSettings.lockOnBackground', 'Lock on background')}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                {i18nT('lockSettings.lockOnBackgroundDesc', 'Lock when app goes to background')}
              </Text>
            </View>
            <Switch
              value={lockOnBackground}
              onValueChange={handleLockOnBackground}
              trackColor={{ false: t.surface3, true: t.accent }}
              thumbColor={lockOnBackground ? t.accentInk : t.textFaint}
            />
          </View>
        </Section>

        <Section t={t} label={i18nT('lockSettings.autoLockTimer', 'AUTO-LOCK TIMER')}>
          {AUTO_LOCK_OPTIONS.map((opt, i) => {
            const selected = autoLockMinutes === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => handleAutoLock(opt.value)}
                accessibilityLabel={i18nT('lockSettings.accessibilityAfterMinutes', 'Auto-lock after {{count}} minutes', { count: opt.value })}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderBottomWidth: i < AUTO_LOCK_OPTIONS.length - 1 ? 1 : 0,
                  borderBottomColor: t.divider,
                  backgroundColor: pressed ? t.surface2 : 'transparent',
                })}
              >
                <View
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 9,
                    borderWidth: 2,
                    borderColor: selected ? t.accent : t.borderStrong,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12,
                  }}
                >
                  {selected ? (
                    <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.accent }} />
                  ) : null}
                </View>
                <Text
                  style={{
                    fontFamily: t.font,
                    fontSize: 14,
                    color: t.text,
                    fontWeight: selected ? '600' : '400',
                  }}
                >
                  {i18nT('lockSettings.afterMinutes', 'After {{count}} min', { count: opt.value })}
                </Text>
                {selected ? (
                  <I.Check size={14} color={t.accent} style={{ marginLeft: 'auto' } as never} />
                ) : null}
              </Pressable>
            );
          })}
        </Section>
      </ScrollView>
    </View>
  );
}
