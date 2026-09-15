import { View, Text, Pressable, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { APP_VERSION } from '../runtime';
import { STORE_URL } from '../store/appVersion';

/**
 * Blocking "this version is no longer supported" screen. Mounted from the
 * App.tsx shell when the installed build is older than the relay's
 * `minVersion` (see store/appVersion). Shows no user data and offers exactly
 * one way forward — the store — so a retired build cannot keep talking to the
 * relay, but the user is never left staring at a silent failure either.
 */
export function UpdateRequiredScreen({ minVersion }: { minVersion: string }) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <View
      testID="update-required"
      style={{
        flex: 1,
        backgroundColor: t.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 28,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
      }}
    >
      <I.Shield size={44} color={t.accent} />
      <Text style={{ fontFamily: t.fontDisplay, fontSize: 24, fontWeight: '700', color: t.text, textAlign: 'center' }}>
        {i18nT('appVersion.requiredTitle')}
      </Text>
      <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center', lineHeight: 21 }}>
        {i18nT('appVersion.requiredBody', { installed: APP_VERSION, min: minVersion })}
      </Text>
      <Pressable
        onPress={() => { void Linking.openURL(STORE_URL).catch(() => {}); }}
        accessibilityRole="button"
        accessibilityLabel={i18nT('appVersion.requiredCta')}
        style={({ pressed }) => ({
          marginTop: 12,
          paddingVertical: 14,
          paddingHorizontal: 28,
          borderRadius: t.radius,
          backgroundColor: pressed ? t.accentDeep : t.accent,
          alignSelf: 'stretch',
          alignItems: 'center',
        })}
      >
        <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '700', color: t.accentInk }}>
          {i18nT('appVersion.requiredCta')}
        </Text>
      </Pressable>
      <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 1.5, marginTop: 8 }}>
        {APP_VERSION}
      </Text>
    </View>
  );
}
