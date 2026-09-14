import { useState, useEffect } from 'react';
import i18n from '../i18n';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useTor } from '../net/tor';
import { useLocale } from '../i18n/useLocale';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import { DeleteAccountSection } from '../components/DeleteAccountSection';
import type { Tab } from '../components/TabBar';
import { useIdentity } from '../store/identity';
import { usePreferences } from '../store/preferences';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NavTarget = 'profile' | 'notifs' | 'export' | 'lockConfig' | 'backup' | 'ephemeral' | 'panic' | 'devices';

interface Props {
  onTab: (tab: Tab) => void;
  onNav: (name: NavTarget) => void;
}

export function PrivacyScreen({ onTab, onNav }: Props) {
  useTranslation(); // re-render on language change
  const { t, toggle } = useTheme();

  // Real identity
  const identity = useIdentity((s) => s.identity);
  const storeDisplayName = useIdentity((s) => s.displayName);
  const storeAvatarColor = useIdentity((s) => s.avatarColor);
  const storeAvatarImage = useIdentity((s) => s.avatarImage);

  const aegisId = identity?.aegisId ?? '— — —';
  const displayName = storeDisplayName;
  const avatarColor = storeAvatarColor;
  const avatarImage = storeAvatarImage;

  // Real preferences
  const readReceipts = usePreferences((s) => s.readReceipts);
  const typing = usePreferences((s) => s.typingIndicator);
  const screenshot = usePreferences((s) => s.blockScreenshots);
  const setPref = usePreferences((s) => s.set);
  // Tor is always-on in the desktop client (main proxies the whole session
  // through the embedded Tor; no toggle, no clearnet fallback). Show the live
  // circuit state instead of a switch.
  const torStatus = useTor((s) => s.status);
  const initTor = useTor((s) => s.init);
  useEffect(() => { initTor(); }, [initTor]);

  function setReadReceipts(v: boolean) { void setPref('readReceipts', v); }
  function setTyping(v: boolean) { void setPref('typingIndicator', v); }
  function setScreenshot(v: boolean) { void setPref('blockScreenshots', v); }

  const { locale, setLocale } = useLocale();
  const { t: i18nT } = useTranslation();

  function showAlert(title: string, msg: string) {
    window.alert(`${title}\n\n${msg}`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('privacy.privacySecurity')} big />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 24 }}>
        {/* Identity card */}
        <button
          onClick={() => onNav('profile')}
          aria-label={i18n.t('home.viewProfile')}
          style={{ margin: '4px 18px 22px', padding: 18, border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, backgroundColor: t.surface, cursor: 'pointer', width: 'calc(100% - 36px)', boxSizing: 'border-box', textAlign: 'left', display: 'block' }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Avatar t={t} name={avatarImage ?? displayName} color={avatarColor} size={52} photoUri={avatarImage ?? undefined} seed={identity?.publicKeyB64} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text, display: 'block' }}>
                {displayName}
              </span>
              <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent, letterSpacing: 0.5, marginTop: 2, display: 'block' }}>
                {aegisId}
              </span>
            </div>
            <I.Chevron size={16} color={t.textFaint} />
          </div>
        </button>

        <Section t={t} label={i18n.t('privacy.appearanceSection')}>
          <ModePicker t={t} dark={t.dark} onToggle={toggle} />
        </Section>

        <Section t={t} label={i18n.t('privacy.dataSharingSection')}>
          <Toggle t={t} label={i18n.t('privacy.readReceipts')} sub={i18n.t('privacy.letOthersKnowYou')} value={readReceipts} onChange={setReadReceipts} />
          <Toggle t={t} label={i18n.t('privacy.typingIndicator')} sub={i18n.t('privacy.showWhenYouRe')} value={typing} onChange={setTyping} />
          <Toggle t={t} label={i18n.t('privacy.blockScreenshots')} sub={i18n.t('privacy.preventScreenCaptureOf')} value={screenshot} onChange={setScreenshot} noBorder />
        </Section>

        <Section t={t} label={i18n.t('privacy.networkSection')}>
          <Row
            t={t}
            icon={<I.Shield size={20} color={torStatus.state === 'on' ? t.accent : t.textDim} />}
            label={i18n.t('privacy.torAlwaysOn')}
            sub={torStatus.state === 'on'
              ? i18n.t('privacy.torAlwaysOnSub')
              : torStatus.state === 'error'
                ? i18n.t('tor.failed', { v0: torStatus.summary || i18n.t('tor.unknownError') })
                : i18n.t('tor.connecting', { v0: torStatus.progress })}
            trailing={<span style={{ fontFamily: t.fontMono, fontSize: 10, color: torStatus.state === 'on' ? t.accent : t.textDim, letterSpacing: 1 }}>{torStatus.state === 'on' ? i18n.t('privacy.torOn') : `${torStatus.progress}%`}</span>}
          />
          <Row t={t} icon={<I.Cloud size={20} color={t.textDim} />} label={i18n.t('privacy.encryptedBackup')} sub={i18n.t('privacy.backUpYourMessages')} onPress={() => onNav('backup')} />
          <Row t={t} icon={<I.Timer size={20} color={t.textDim} />} label={i18n.t('privacy.disappearingMessages')} sub={i18n.t('privacy.setAGlobalTimer')} onPress={() => onNav('ephemeral')} noBorder />
        </Section>

        <Section t={t} label={i18n.t('privacy.alerts')}>
          <Row t={t} icon={<I.Bell size={20} color={t.textDim} />} label={i18n.t('privacy.notifications')} sub={i18n.t('privacy.manageNotificationPreferences')} onPress={() => onNav('notifs')} />
          <Row t={t} icon={<I.Trash size={20} color={t.textDim} />} label={i18n.t('privacy.yourData')} sub={i18n.t('privacy.exportOrDeleteYour')} onPress={() => onNav('export')} />
          <Row t={t} icon={<I.Lock size={20} color={t.textDim} />} label={i18n.t('privacy.lockScreen')} sub={i18n.t('privacy.pinOrBiometricApp')} onPress={() => onNav('lockConfig')} noBorder />
        </Section>

        <Section t={t} label={i18n.t('privacy.devicesSection')}>
          <Row t={t} icon={<I.Phone size={20} color={t.textDim} />} label={i18n.t('privacy.linkedDevices')} sub={i18n.t('privacy.manageDevicesConnectedTo')} onPress={() => onNav('devices')} />
          <Row t={t} icon={<I.Shield size={20} color={t.accent} />} label={i18n.t('privacy.panicMode')} sub={i18n.t('privacy.instantlyWipeAllData')} onPress={() => onNav('panic')} noBorder />
        </Section>

        <Section t={t} label={i18nT('privacy.languageSection') || "LANGUAGE"}>
          <LanguagePicker t={t} locale={locale} onSelect={setLocale} />
        </Section>

        <Section t={t} label={i18n.t('privacy.aboutSection')}>
          <Row
            t={t}
            icon={<I.Shield size={20} color={t.textDim} />}
            label={i18n.t('privacy.securityAudit')}
            sub={i18n.t('privacy.openSourceCryptographyIndependently')}
            onPress={() => showAlert('Security Audit', 'AegisLink uses TweetNaCl + Double Ratchet. Source available on GitHub.')}
          />
          <Row
            t={t}
            icon={<I.Globe size={20} color={t.textDim} />}
            label={i18n.t('privacy.jurisdiction')}
            sub={i18n.t('privacy.noLogsKeptServers')}
            noBorder
            onPress={() => showAlert('Jurisdiction', 'AegisLink stores zero metadata. Requests for user data return nothing.')}
          />
        </Section>

        <DeleteAccountSection />
      </div>

    </div>
  );
}

function ModePicker({ t, dark, onToggle }: { t: Theme; dark: boolean; onToggle: () => void }) {
  return (
    <div style={{ padding: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'row', padding: 4, backgroundColor: t.surface2, borderRadius: t.radius, gap: 6 }}>
        {(['light', 'dark'] as const).map((mode) => {
          const active = dark ? mode === 'dark' : mode === 'light';
          return (
            <button
              key={mode}
              onClick={onToggle}
              aria-label={i18n.t('privacy.switchToV0Mode', { v0: mode })}
              style={{ flex: 1, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, borderRadius: Math.max(t.radius - 4, 4), backgroundColor: active ? t.surface : 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.1s' }}
            >
              <span style={{ fontFamily: t.font, fontSize: 13, fontWeight: active ? '600' : '500', color: active ? t.text : t.textDim }}>
                {i18n.t(mode === 'dark' ? 'privacy.modeDark' : 'privacy.modeLight')}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LanguagePicker({ t, locale, onSelect }: { t: Theme; locale: string; onSelect: (l: 'en' | 'it' | 'es') => void }) {
  const { t: i18nT } = useTranslation();
  const opts: { id: 'en' | 'it' | 'es'; label: string }[] = [
    { id: 'en', label: i18nT('privacy.languageEnglish') || 'English' },
    { id: 'it', label: i18nT('privacy.languageItalian') || 'Italiano' },
    { id: 'es', label: i18nT('privacy.languageSpanish') || 'Español' },
  ];
  return (
    <div style={{ padding: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'row', padding: 4, backgroundColor: t.surface2, borderRadius: t.radius, gap: 6 }}>
        {opts.map((o) => {
          const active = locale === o.id;
          return (
            <button
              key={o.id}
              onClick={() => onSelect(o.id)}
              aria-label={o.label}
              style={{ flex: 1, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, borderRadius: Math.max(t.radius - 4, 4), backgroundColor: active ? t.surface : 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <span style={{ fontFamily: t.font, fontSize: 13, fontWeight: active ? '600' : '500', color: active ? t.text : t.textDim }}>
                {o.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
