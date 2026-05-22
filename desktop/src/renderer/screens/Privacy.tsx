import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../i18n/useLocale';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import type { Tab } from '../components/TabBar';
import { useIdentity } from '../store/identity';
import { usePreferences } from '../store/preferences';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NavTarget = 'profile' | 'notifs' | 'export' | 'lockConfig' | 'backup' | 'ephemeral' | 'panic' | 'devices' | 'workDashboard';

interface Props {
  onTab: (tab: Tab) => void;
  onNav: (name: NavTarget) => void;
}

export function PrivacyScreen({ onTab, onNav }: Props) {
  const { t, toggle } = useTheme();

  // Real identity
  const identity = useIdentity((s) => s.identity);
  const activeProfile = useIdentity((s) => s.activeProfile);
  const storeDisplayName = useIdentity((s) => s.activeProfile === 'work' ? s.workDisplayName : s.displayName);
  const storeAvatarColor = useIdentity((s) => s.activeProfile === 'work' ? s.workAvatarColor : s.avatarColor);
  const storeAvatarImage = useIdentity((s) => s.activeProfile === 'work' ? s.workAvatarImage : s.avatarImage);

  const aegisId = identity?.aegisId ?? '— — —';
  const displayName = storeDisplayName;
  const avatarColor = storeAvatarColor;
  const avatarImage = storeAvatarImage;

  // Real preferences
  const readReceipts = usePreferences((s) => s.readReceipts);
  const typing = usePreferences((s) => s.typingIndicator);
  const screenshot = usePreferences((s) => s.blockScreenshots);
  const tor = usePreferences((s) => s.routeViaTor);
  const setPref = usePreferences((s) => s.set);

  function setReadReceipts(v: boolean) { void setPref('readReceipts', v); }
  function setTyping(v: boolean) { void setPref('typingIndicator', v); }
  function setScreenshot(v: boolean) { void setPref('blockScreenshots', v); }
  function setTor(v: boolean) { void setPref('routeViaTor', v); }

  const { locale, setLocale } = useLocale();
  const { t: i18nT } = useTranslation();

  const isWork = activeProfile === 'work';
  const WORK_ACCENT = '#6366f1';

  function showAlert(title: string, msg: string) {
    window.alert(`${title}\n\n${msg}`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Privacy & Security" big />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 24 }}>
        {/* Identity card */}
        <button
          onClick={() => onNav('profile')}
          aria-label="View profile"
          style={{ margin: '4px 18px 22px', padding: 18, border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, backgroundColor: t.surface, cursor: 'pointer', width: 'calc(100% - 36px)', boxSizing: 'border-box', textAlign: 'left', display: 'block' }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Avatar t={t} name={avatarImage ?? displayName} color={avatarColor} size={52} photoUri={avatarImage ?? undefined} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text, display: 'block' }}>
                {displayName}{isWork ? ' · work' : ''}
              </span>
              <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent, letterSpacing: 0.5, marginTop: 2, display: 'block' }}>
                {aegisId}
              </span>
            </div>
            <I.Chevron size={16} color={t.textFaint} />
          </div>
        </button>

        <Section t={t} label="APPEARANCE">
          <ModePicker t={t} dark={t.dark} onToggle={toggle} />
        </Section>

        <Section t={t} label="DATA SHARING">
          <Toggle t={t} label="Read receipts" sub="Let others know you've read their messages" value={readReceipts} onChange={setReadReceipts} />
          <Toggle t={t} label="Typing indicator" sub="Show when you're composing a message" value={typing} onChange={setTyping} />
          <Toggle t={t} label="Block screenshots" sub="Prevent screen capture of message content" value={screenshot} onChange={setScreenshot} noBorder />
        </Section>

        <Section t={t} label="NETWORK">
          <Toggle t={t} label="Route via Tor" sub="Anonymize traffic through the Tor network (slower)" value={tor} onChange={setTor} />
          <Row t={t} icon={<I.Cloud size={20} color={t.textDim} />} label="Encrypted backup" sub="Back up your messages with a key only you hold" onPress={() => onNav('backup')} />
          <Row t={t} icon={<I.Timer size={20} color={t.textDim} />} label="Disappearing messages" sub="Set a global timer for all messages" onPress={() => onNav('ephemeral')} noBorder />
        </Section>

        <Section t={t} label="ALERTS">
          <Row t={t} icon={<I.Bell size={20} color={t.textDim} />} label="Notifications" sub="Manage notification preferences" onPress={() => onNav('notifs')} />
          <Row t={t} icon={<I.Trash size={20} color={t.textDim} />} label="Your data" sub="Export or delete your data" onPress={() => onNav('export')} />
          <Row t={t} icon={<I.Lock size={20} color={t.textDim} />} label="Lock screen" sub="PIN or biometric app lock" onPress={() => onNav('lockConfig')} noBorder />
        </Section>

        <Section t={t} label="DEVICES">
          <Row t={t} icon={<I.Phone size={20} color={t.textDim} />} label="Linked devices" sub="Manage devices connected to your account" onPress={() => onNav('devices')} />
          <Row t={t} icon={<I.Shield size={20} color={t.accent} />} label="Panic mode" sub="Instantly wipe all data in an emergency" onPress={() => onNav('panic')} noBorder />
        </Section>

        {isWork && (
          <Section t={t} label="ENTERPRISE">
            <Row t={t} icon={<I.Building size={20} color={t.accent} />} label="AegisLink Work" sub="Enterprise dashboard and team settings" onPress={() => onNav('workDashboard')} noBorder />
          </Section>
        )}

        <Section t={t} label={i18nT('privacy.languageSection') || "LANGUAGE"}>
          <LanguagePicker t={t} locale={locale} onSelect={setLocale} />
        </Section>

        <Section t={t} label="ABOUT">
          <Row
            t={t}
            icon={<I.Shield size={20} color={t.textDim} />}
            label="Security audit"
            sub="Open-source cryptography, independently verified"
            onPress={() => showAlert('Security Audit', 'AegisLink uses TweetNaCl + Double Ratchet. Source available on GitHub.')}
          />
          <Row
            t={t}
            icon={<I.Globe size={20} color={t.textDim} />}
            label="Jurisdiction"
            sub="No logs kept — servers operated under privacy law"
            noBorder
            onPress={() => showAlert('Jurisdiction', 'AegisLink stores zero metadata. Requests for user data return nothing.')}
          />
        </Section>
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
              aria-label={`Switch to ${mode} mode`}
              style={{ flex: 1, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, borderRadius: Math.max(t.radius - 4, 4), backgroundColor: active ? t.surface : 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.1s' }}
            >
              <span style={{ fontFamily: t.font, fontSize: 13, fontWeight: active ? '600' : '500', color: active ? t.text : t.textDim }}>
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
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
