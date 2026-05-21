import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../i18n/useLocale';
import type { SupportedLocale } from '../i18n';
import { View, Text, ScrollView, Pressable, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import { TabBar, type Tab } from '../components/TabBar';
import { useIdentity } from '../store/identity';
import { usePreferences } from '../store/preferences';
import type { Theme } from '../theme/vault';

interface Props {
  onTab: (tab: Tab) => void;
  onNav: (name: 'profile' | 'notifs' | 'export' | 'lockConfig' | 'backup' | 'ephemeral' | 'panic' | 'devices' | 'workDashboard') => void;
}

export function PrivacyScreen({ onTab, onNav }: Props) {
  const { t, setDark, autoMode, setAutoMode } = useTheme();
  const { t: i18nT } = useTranslation();
  const { locale, setLocale } = useLocale();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const activeProfile = useIdentity((s) => s.activeProfile);
  const displayName = useIdentity((s) =>
    s.activeProfile === 'work' ? s.workDisplayName : s.displayName
  );
  const avatarColor = useIdentity((s) =>
    s.activeProfile === 'work' ? s.workAvatarColor : s.avatarColor
  );
  const avatarImage = useIdentity((s) =>
    s.activeProfile === 'work' ? s.workAvatarImage : s.avatarImage
  );
  const hydrated = usePreferences((s) => s.hydrated);
  const hydrate = usePreferences((s) => s.hydrate);
  const readReceipts = usePreferences((s) => s.readReceipts);
  const typing = usePreferences((s) => s.typingIndicator);
  const screenshot = usePreferences((s) => s.blockScreenshots);
  const setPref = usePreferences((s) => s.set);

  // Shell already hydrates on mount; this is a belt-and-suspenders guard
  useEffect(() => {
    if (!hydrated) void hydrate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setRR = (v: boolean) => void setPref('readReceipts', v);
  const setTyping = (v: boolean) => void setPref('typingIndicator', v);
  const setSS = (v: boolean) => void setPref('blockScreenshots', v);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar t={t} title={i18nT('privacy.title')} big />

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {/* Identity card */}
        <Pressable
          onPress={() => onNav('profile')}
          style={({ pressed }) => ({
            marginHorizontal: 18,
            marginTop: 4,
            marginBottom: 22,
            padding: 18,
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: t.radius,
            backgroundColor: pressed ? t.surface2 : t.surface,
          })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Avatar t={t} name={avatarImage || displayName} color={avatarColor} size={52} photoUri={avatarImage} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
                {displayName}{activeProfile === 'work' ? ' · work' : ''}
              </Text>
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 12,
                  color: t.accent,
                  letterSpacing: 0.5,
                  marginTop: 2,
                }}
              >
                {identity?.aegisId ?? '— — —'}
              </Text>
            </View>
            <I.Chevron size={16} color={t.textFaint} />
          </View>
        </Pressable>

        <Section t={t} label={i18nT('privacy.appearanceSection')}>
          <ModePicker
            t={t}
            value={t.dark ? 'dark' : 'light'}
            autoMode={autoMode}
            onChange={setDark}
            onSetAuto={() => setAutoMode(true)}
          />
        </Section>

        <Section t={t} label={i18nT('privacy.dataSharingSection')}>
          <Toggle
            t={t}
            label={i18nT('privacy.readReceipts')}
            sub={i18nT('privacy.readReceiptsSub')}
            value={readReceipts}
            onChange={setRR}
          />
          <Toggle
            t={t}
            label={i18nT('privacy.typingIndicator')}
            sub={i18nT('privacy.typingIndicatorSub')}
            value={typing}
            onChange={setTyping}
          />
          <Toggle
            t={t}
            label={i18nT('privacy.blockScreenshots')}
            sub={i18nT('privacy.blockScreenshotsSub')}
            value={screenshot}
            onChange={setSS}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('privacy.networkSection')}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 14,
              gap: 14,
              borderBottomWidth: 1,
              borderBottomColor: t.border,
            }}
          >
            <I.Shield size={20} color={t.textFaint} />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontFamily: t.font, fontSize: 15, color: t.textFaint }}>
                  {i18nT('privacy.routeViaTor')}
                </Text>
                <View
                  style={{
                    backgroundColor: t.surface2,
                    borderRadius: 4,
                    paddingHorizontal: 5,
                    paddingVertical: 2,
                  }}
                >
                  <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 0.5 }}>
                    PRONTO
                  </Text>
                </View>
              </View>
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textFaint, marginTop: 2 }}>
                {i18nT('privacy.routeViaTorSub')}
              </Text>
            </View>
          </View>
          <Row
            t={t}
            icon={<I.Cloud size={20} color={t.textDim} />}
            label={i18nT('privacy.encryptedBackup')}
            sub={i18nT('privacy.encryptedBackupSub')}
            onPress={() => onNav('backup')}
          />
          <Row
            t={t}
            icon={<I.Timer size={20} color={t.textDim} />}
            label={i18nT('privacy.disappearingMessages')}
            sub={i18nT('privacy.disappearingMessagesSub')}
            onPress={() => onNav('ephemeral')}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('privacy.alertsSection')}>
          <Row
            t={t}
            icon={<I.Bell size={20} color={t.textDim} />}
            label={i18nT('privacy.notifications')}
            sub={i18nT('privacy.notificationsSub')}
            onPress={() => onNav('notifs')}
          />
          <Row
            t={t}
            icon={<I.Trash size={20} color={t.textDim} />}
            label={i18nT('privacy.yourData')}
            sub={i18nT('privacy.yourDataSub')}
            onPress={() => onNav('export')}
          />
          <Row
            t={t}
            icon={<I.Lock size={20} color={t.textDim} />}
            label={i18nT('privacy.lockScreen')}
            sub={i18nT('privacy.lockScreenSub')}
            onPress={() => onNav('lockConfig')}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('privacy.devicesSection')}>
          <Row
            t={t}
            icon={<I.Phone size={20} color={t.textDim} />}
            label={i18nT('privacy.linkedDevices')}
            sub={i18nT('privacy.linkedDevicesSub')}
            onPress={() => onNav('devices')}
          />
          <Row
            t={t}
            icon={<I.Shield size={20} color={t.accent} />}
            label={i18nT('privacy.panicMode')}
            sub={i18nT('privacy.panicModeSub')}
            onPress={() => onNav('panic')}
            noBorder
          />
        </Section>

        {activeProfile === 'work' && (
          <Section t={t} label={i18nT('privacy.enterpriseSection')}>
            <Row
              t={t}
              icon={<I.Building size={20} color={t.accent} />}
              label="AegisLink Work"
              sub={i18nT('privacy.workDashboardSub')}
              onPress={() => onNav('workDashboard')}
              noBorder
            />
          </Section>
        )}

        <Section t={t} label={i18nT('settings.language')}>
          <LanguagePicker t={t} locale={locale} onSelect={setLocale} />
        </Section>

        <Section t={t} label={i18nT('privacy.aboutSection')}>
          <Row
            t={t}
            icon={<I.Shield size={20} color={t.textDim} />}
            label={i18nT('privacy.securityAudit')}
            sub={i18nT('privacy.securityAuditSub')}
            onPress={() => { Alert.alert(i18nT('privacy.auditAlert'), i18nT('privacy.auditAlertDesc')); }}
          />
          <Row
            t={t}
            icon={<I.Globe size={20} color={t.textDim} />}
            label={i18nT('privacy.jurisdiction')}
            sub={i18nT('privacy.jurisdictionSub')}
            noBorder
            onPress={() => { Alert.alert(i18nT('privacy.jurisdictionAlert'), i18nT('privacy.jurisdictionAlertDesc')); }}
          />
        </Section>
      </ScrollView>

      <TabBar t={t} current="settings" onChange={onTab} />
    </View>
  );
}

function LanguagePicker({ t, locale, onSelect }: { t: Theme; locale: SupportedLocale; onSelect: (l: SupportedLocale) => void }) {
  const { t: i18nT } = useTranslation();
  const opts: { id: SupportedLocale; label: string }[] = [
    { id: 'en', label: i18nT('privacy.languageEnglish') },
    { id: 'it', label: i18nT('privacy.languageItalian') },
    { id: 'es', label: i18nT('privacy.languageSpanish') },
  ];
  return (
    <View style={{ padding: 14 }}>
      <View style={{ flexDirection: 'row', padding: 4, backgroundColor: t.surface2, borderRadius: t.radius, gap: 6 }}>
        {opts.map((o) => {
          const active = locale === o.id;
          return (
            <Pressable
              key={o.id}
              onPress={() => void onSelect(o.id)}
              accessibilityLabel={o.label}
              style={{
                flex: 1,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: Math.max(t.radius - 4, 4),
                backgroundColor: active ? t.surface : 'transparent',
                alignItems: 'center',
              }}
            >
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: active ? '600' : '500', color: active ? t.text : t.textDim }}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ModePicker({
  t,
  value,
  autoMode,
  onChange,
  onSetAuto,
}: {
  t: Theme;
  value: 'dark' | 'light';
  autoMode: boolean;
  onChange: (dark: boolean) => void;
  onSetAuto: () => void;
}) {
  const { t: i18nT } = useTranslation();
  const opts: { id: 'light' | 'auto' | 'dark'; label: string }[] = [
    { id: 'light', label: i18nT('privacy.modeLight') },
    { id: 'auto', label: i18nT('privacy.modeAuto') },
    { id: 'dark', label: i18nT('privacy.modeDark') },
  ];
  const activeId: 'light' | 'auto' | 'dark' = autoMode ? 'auto' : value;

  const handlePress = (id: 'light' | 'auto' | 'dark') => {
    if (id === 'auto') {
      onSetAuto();
    } else {
      onChange(id === 'dark');
    }
  };

  return (
    <View style={{ padding: 14 }}>
      <View
        style={{
          flexDirection: 'row',
          padding: 4,
          backgroundColor: t.surface2,
          borderRadius: t.radius,
          gap: 6,
        }}
      >
        {opts.map((o) => {
          const active = o.id === activeId;
          return (
            <Pressable
              key={o.id}
              onPress={() => handlePress(o.id)}
              accessibilityLabel={o.label}
              style={{
                flex: 1,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: Math.max(t.radius - 4, 4),
                backgroundColor: active ? t.surface : 'transparent',
                alignItems: 'center',
              }}
            >
              <Text
                style={{
                  fontFamily: t.font,
                  fontSize: 13,
                  fontWeight: active ? '600' : '500',
                  color: active ? t.text : t.textDim,
                }}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 8, lineHeight: 17 }}>
        {i18nT('privacy.modeDesc')}
      </Text>
    </View>
  );
}
