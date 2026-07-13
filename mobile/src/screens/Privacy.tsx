import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../i18n/useLocale';
import type { SupportedLocale } from '../i18n';
import { View, Text, ScrollView, Pressable, Linking, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import { DeleteAccountSection } from '../components/DeleteAccountSection';
import { TabBar, type Tab } from '../components/TabBar';
import { useIdentity } from '../store/identity';
import { usePreferences } from '../store/preferences';
import { useSecurityDiagnostics } from '../store/securityDiagnostics';
import type { Theme } from '../theme/vault';
import { themedAlert } from '../components/AlertHost';

// Public legal documents. GitHub-blob URLs are what the landing footer links to
// and are accepted by the stores as the required public policy URL.
const LEGAL_URLS = {
  privacy: 'https://github.com/gabinotech22-cmyk/AegisLink/blob/main/docs/privacy-policy.md',
  terms: 'https://github.com/gabinotech22-cmyk/AegisLink/blob/main/docs/terms-of-service.md',
} as const;

interface Props {
  onTab: (tab: Tab) => void;
  onNav: (name: 'profile' | 'notifs' | 'export' | 'lockConfig' | 'backup' | 'ephemeral' | 'panic' | 'devices') => void;
}

export function PrivacyScreen({ onTab, onNav }: Props) {
  const { t, setDark, autoMode, setAutoMode } = useTheme();
  const { t: i18nT } = useTranslation();
  const { locale, setLocale } = useLocale();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const displayName = useIdentity((s) => s.displayName);
  const avatarColor = useIdentity((s) => s.avatarColor);
  const avatarImage = useIdentity((s) => s.avatarImage);
  const hydrated = usePreferences((s) => s.hydrated);
  const hydrate = usePreferences((s) => s.hydrate);
  const readReceipts = usePreferences((s) => s.readReceipts);
  const typing = usePreferences((s) => s.typingIndicator);
  const screenshot = usePreferences((s) => s.blockScreenshots);
  const routeViaTor = usePreferences((s) => s.routeViaTor);
  const callWakeService = usePreferences((s) => s.callWakeService);
  const requireGroupApproval = usePreferences((s) => s.requireGroupApproval);
  const duressActive = usePreferences((s) => s.duressActive);
  const setPref = usePreferences((s) => s.set);
  const pqDowngradeFallbacks = useSecurityDiagnostics((s) => s.pqDowngradeFallbacks);
  const lastPqDowngradeAt = useSecurityDiagnostics((s) => s.lastPqDowngradeAt);
  const secDiagHydrate = useSecurityDiagnostics((s) => s.hydrate);
  const secDiagHydrated = useSecurityDiagnostics((s) => s.hydrated);

  // Shell already hydrates on mount; this is a belt-and-suspenders guard
  useEffect(() => {
    if (!hydrated) void hydrate();
    if (!secDiagHydrated) void secDiagHydrate();
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
            <Avatar t={t} name={avatarImage || displayName} color={avatarColor} size={52} photoUri={avatarImage} seed={identity?.publicKeyB64} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
                {displayName}
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

        <Section t={t} label={i18nT('privacy.groupsSection', 'GRUPOS')}>
          <Toggle
            t={t}
            label={i18nT('privacy.requireGroupApproval', 'Aprobar antes de añadirme a grupos')}
            sub={i18nT('privacy.requireGroupApprovalSub', 'Recibe una invitación que aceptas en vez de entrar directo')}
            value={requireGroupApproval}
            onChange={(v) => void setPref('requireGroupApproval', v)}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('privacy.networkSection')}>
          <Toggle
            t={t}
            label={i18nT('privacy.torLabel')}
            sub={i18nT('privacy.torSub')}
            value={routeViaTor}
            onChange={(v) => {
              void setPref('routeViaTor', v);
              // Reconnect socket with new URL preference
              if (identity) {
                const { disconnect: sockDisconnect, connect: sockConnect } = require('../socket/client') as typeof import('../socket/client');
                sockDisconnect();
                sockConnect(identity);
              }
            }}
          />
          {routeViaTor && (
            <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 10 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, lineHeight: 16 }}>
                {i18nT('privacy.torOrbot')}
              </Text>
              <Pressable
                accessibilityLabel={i18nT('privacy.openOrbot')}
                onPress={() => {
                  void Linking.openURL('orbot://request/vpn').catch(() =>
                    Linking.openURL('https://orbot.app')
                  );
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  backgroundColor: t.surface2,
                  borderRadius: t.radiusS,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  alignSelf: 'flex-start',
                }}
              >
                <I.Shield size={14} color={t.accent} />
                <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent, letterSpacing: 0.4 }}>
                  {i18nT('privacy.openOrbot')}
                </Text>
              </Pressable>
            </View>
          )}
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
            noBorder={Platform.OS !== 'ios'}
          />
          {/* TEMPORARY — F1 verification only (docs/FASE4-TOR-IOS-DESIGN.md).
              The preview build profile has no EXPO_PUBLIC_MAILBOX_MODE/
              EXPO_PUBLIC_ONION_URL, so the real mailbox gate never calls
              startTor(). Remove once F3 wires isTorAvailable() into the real
              gate and this becomes exercised by normal app use. */}
          {Platform.OS === 'ios' && (
            <Row
              t={t}
              icon={<I.Shield size={20} color={t.textDim} />}
              label="Tor F1 debug (dev)"
              sub="Start embedded Tor and show bootstrap status"
              onPress={() => {
                const { startTor, isTorAvailable } = require('../net/tor') as typeof import('../net/tor');
                if (!isTorAvailable()) {
                  themedAlert('Tor F1 debug', 'Native module unavailable (Expo Go or non-prebuilt build)');
                  return;
                }
                themedAlert('Tor F1 debug', 'Starting… (bootstrapping can take up to 45s)');
                startTor()
                  .then((status) => {
                    themedAlert('Tor F1 debug ✅', `state=${status.state} socksPort=${status.socksPort}`);
                  })
                  .catch((e: Error) => {
                    themedAlert('Tor F1 debug ❌', e.message);
                  });
              }}
              noBorder
            />
          )}
        </Section>

        {Platform.OS === 'android' && (
          <Section t={t} label={i18nT('privacy.callsSection')}>
            <Toggle
              t={t}
              label={i18nT('privacy.callWakeLabel')}
              sub={i18nT('privacy.callWakeSub')}
              value={callWakeService}
              onChange={(v) => {
                void setPref('callWakeService', v);
                // Apply immediately: the FGS start/stop is idempotent and also
                // re-synced on every connect() from the same preference.
                const { startCallWakeService, stopCallWakeService } =
                  require('../webrtc/callWakeService') as typeof import('../webrtc/callWakeService');
                if (v) startCallWakeService();
                else stopCallWakeService();
              }}
            />
          </Section>
        )}

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
            noBorder={duressActive}
          />
          {!duressActive && (
            <Row
              t={t}
              icon={<I.Shield size={20} color={t.accent} />}
              label={i18nT('privacy.panicMode')}
              sub={i18nT('privacy.panicModeSub')}
              onPress={() => onNav('panic')}
              noBorder
            />
          )}
        </Section>

        <Section t={t} label={i18nT('settings.language')}>
          <LanguagePicker t={t} locale={locale} onSelect={setLocale} />
        </Section>

        <Section t={t} label={i18nT('privacy.aboutSection')}>
          <Row
            t={t}
            icon={<I.Shield size={20} color={t.textDim} />}
            label={i18nT('privacy.securityAudit')}
            sub={i18nT('privacy.securityAuditSub')}
            onPress={() => { themedAlert(i18nT('privacy.auditAlert'), i18nT('privacy.auditAlertDesc')); }}
          />
          <Row
            t={t}
            icon={<I.Shield size={20} color={pqDowngradeFallbacks > 0 ? t.accent : t.textDim} />}
            label={i18nT('privacy.pqStatus')}
            sub={
              pqDowngradeFallbacks > 0
                ? i18nT('privacy.pqStatusSubFallback', { count: pqDowngradeFallbacks })
                : i18nT('privacy.pqStatusSubOk')
            }
            onPress={() => {
              themedAlert(
                i18nT('privacy.pqStatusAlert'),
                pqDowngradeFallbacks > 0
                  ? i18nT('privacy.pqStatusAlertFallback', {
                      count: pqDowngradeFallbacks,
                      when: lastPqDowngradeAt ? new Date(lastPqDowngradeAt).toLocaleString() : '—',
                    })
                  : i18nT('privacy.pqStatusAlertOk'),
              );
            }}
          />
          <Row
            t={t}
            icon={<I.Globe size={20} color={t.textDim} />}
            label={i18nT('privacy.jurisdiction')}
            sub={i18nT('privacy.jurisdictionSub')}
            onPress={() => { themedAlert(i18nT('privacy.jurisdictionAlert'), i18nT('privacy.jurisdictionAlertDesc')); }}
          />
          <Row
            t={t}
            icon={<I.Shield size={20} color={t.textDim} />}
            label={i18nT('privacy.privacyPolicy')}
            onPress={() => { void Linking.openURL(LEGAL_URLS.privacy).catch(() => {}); }}
          />
          <Row
            t={t}
            icon={<I.Link size={20} color={t.textDim} />}
            label={i18nT('privacy.termsOfService')}
            onPress={() => { void Linking.openURL(LEGAL_URLS.terms).catch(() => {}); }}
            noBorder
          />
        </Section>

        <DeleteAccountSection />
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
