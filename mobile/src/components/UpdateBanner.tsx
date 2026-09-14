import { View, Text, Pressable, Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from './icons';
import { useAppVersion, isUpdateAvailable, STORE_URL } from '../store/appVersion';

/**
 * Dismissible "a newer version is available" strip for the Home screen.
 * Driven entirely by the local comparison in store/appVersion — renders
 * nothing unless the installed build is older than the relay's advertised
 * latestVersion. Dismissal is per version and per session: it comes back
 * for the next release, never nags about the same one.
 */
export function UpdateBanner() {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const latestVersion = useAppVersion((s) => s.latestVersion);
  const dismissedFor = useAppVersion((s) => s.dismissedFor);
  const dismiss = useAppVersion((s) => s.dismissBanner);

  if (!isUpdateAvailable({ latestVersion, dismissedFor })) return null;

  return (
    <View
      testID="update-banner"
      style={{
        marginHorizontal: 18,
        marginBottom: 10,
        paddingVertical: 10,
        paddingLeft: 14,
        paddingRight: 6,
        borderRadius: t.radiusS,
        borderWidth: 1,
        borderColor: t.borderStrong,
        backgroundColor: t.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <I.Download size={18} color={t.accent} />
      <Pressable
        onPress={() => { void Linking.openURL(STORE_URL).catch(() => {}); }}
        accessibilityRole="button"
        accessibilityLabel={i18nT('appVersion.bannerCta')}
        style={{ flex: 1 }}
      >
        <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>
          {i18nT('appVersion.bannerTitle', { version: latestVersion })}
        </Text>
        <Text style={{ fontFamily: t.font, fontSize: 12, color: t.accent, marginTop: 2 }}>
          {i18nT('appVersion.bannerCta')}
        </Text>
      </Pressable>
      <Pressable
        onPress={dismiss}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={i18nT('appVersion.dismiss')}
        style={{ padding: 8 }}
      >
        <I.X size={16} color={t.textDim} />
      </Pressable>
    </View>
  );
}
