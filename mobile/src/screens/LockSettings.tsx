import { useState } from 'react';
import { View, Text, Pressable, ScrollView, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section } from '../components/Section';
import { themedAlert } from '../components/AlertHost';
import { usePreferences } from '../store/preferences';

const AUTO_LOCK_OPTIONS = [
  { value: 0 },
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

  // Read directly from the single source of truth (preferences store).
  const biometrics = usePreferences((s) => s.biometricsEnabled);
  const autoLockMinutes = usePreferences((s) => s.lockTimeoutMin);
  const hideRecents = usePreferences((s) => s.hideRecents);
  const setPref = usePreferences((s) => s.set);

  // Local loading guard to prevent double-taps.
  const [busy, setBusy] = useState(false);

  async function handleBiometrics(v: boolean) {
    if (busy) return;
    if (v) {
      // Verify biometric enrollment before enabling.
      try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const LA = require('expo-local-authentication') as { isEnrolledAsync: () => Promise<boolean> };
        const enrolled = await LA.isEnrolledAsync();
        if (!enrolled) {
          themedAlert(
            i18nT('lockSettings.biometricsAlertTitle', 'Biometrics'),
            i18nT('lockSettings.notEnrolled', 'No biometrics enrolled on this device. Please configure Face ID / fingerprint in your device settings first.')
          );
          return;
        }
      } catch {
        // Module unavailable (Expo Go) — allow toggle but warn.
      }
      themedAlert(
        i18nT('lockSettings.biometricsAlertTitle', 'Biometrics'),
        i18nT('lockSettings.biometricsAlertMsg', 'Face ID / fingerprint will be used to unlock the app.')
      );
    }
    setBusy(true);
    await setPref('biometricsEnabled', v);
    setBusy(false);
  }

  async function handleAutoLock(minutes: number) {
    await setPref('lockTimeoutMin', minutes);
  }

  async function handleHideRecents(v: boolean) {
    await setPref('hideRecents', v);
  }

  function getAutoLockLabel(value: number): string {
    if (value === 0) return i18nT('lockSettings.immediately', 'Immediately');
    return i18nT('lockSettings.afterMinutes', 'After {{count}} min', { count: value });
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
              onValueChange={(v) => void handleBiometrics(v)}
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
                {i18nT('lockSettings.hideRecents', 'Hide in recents')}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                {i18nT('lockSettings.hideRecentsDesc', 'Blur app content in the task switcher')}
              </Text>
            </View>
            <Switch
              value={hideRecents}
              onValueChange={(v) => void handleHideRecents(v)}
              trackColor={{ false: t.surface3, true: t.accent }}
              thumbColor={hideRecents ? t.accentInk : t.textFaint}
            />
          </View>
        </Section>

        <Section t={t} label={i18nT('lockSettings.autoLockTimer', 'AUTO-LOCK TIMER')}>
          {AUTO_LOCK_OPTIONS.map((opt, i) => {
            const selected = autoLockMinutes === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => void handleAutoLock(opt.value)}
                accessibilityLabel={getAutoLockLabel(opt.value)}
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
                  {getAutoLockLabel(opt.value)}
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
