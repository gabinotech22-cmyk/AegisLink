import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useMessages } from '../store/messages';

interface Props {
  onBack: () => void;
}

const OPTS = [
  { id: 'off',  get label() { return i18n.t('ephemeral.offLabel'); },       get sub() { return i18n.t('ephemeral.messagesAreKeptIndefinitely'); },  sec: 0 },
  { id: '30s',  get label() { return i18n.t('ephemeral.30sLabel'); }, get sub() { return i18n.t('ephemeral.deletes30SecondsAfter'); }, sec: 30 },
  { id: '5m',   get label() { return i18n.t('ephemeral.5mLabel'); },  get sub() { return i18n.t('ephemeral.deletes5MinutesAfter'); },  sec: 300 },
  { id: '1h',   get label() { return i18n.t('ephemeral.1hLabel'); },     get sub() { return i18n.t('ephemeral.deletes1HourAfter'); },     sec: 3600 },
  { id: '1d',   get label() { return i18n.t('scheduled.delay1d'); },      get sub() { return i18n.t('ephemeral.deletes24HoursAfter'); },   sec: 86400 },
  { id: '7d',   get label() { return i18n.t('ephemeral.7dLabel'); },     get sub() { return i18n.t('ephemeral.deletes7DaysAfter'); },     sec: 604800 },
  { id: '30d',  get label() { return i18n.t('ephemeral.30dLabel'); },    get sub() { return i18n.t('ephemeral.deletes30DaysAfter'); },    sec: 2592000 },
] as const;

export function EphemeralScreen({ onBack }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const ephemeralTimer = useMessages((s) => s.ephemeralTimer);
  const setEphemeralTimer = useMessages((s) => s.setEphemeralTimer);
  const initialPick = OPTS.find((o) => o.sec === ephemeralTimer)?.id ?? 'off';
  const [pick, setPick] = useState<string>(initialPick);

  function handleSelect(id: string, sec: number, label: string) {
    setPick(id);
    setEphemeralTimer(sec);
    if (sec > 0) {
      window.alert(i18n.t('ephemeral.disappearingMessagesEnabledV0', { v0: label }));
    } else {
      window.alert(i18n.t('ephemeral.disappearingMessagesDisabled'));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('ephemeral.title')} left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 22px', boxSizing: 'border-box' }}>
        {/* Hero */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '22px 4px' }}>
          <div style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
            <I.Timer size={32} color={t.accent} />
          </div>
          <span style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text, textAlign: 'center', display: 'block' }}>{i18n.t('ephemeral.title')}</span>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px', textAlign: 'center', maxWidth: 280, marginTop: 8, display: 'block' }}>{i18n.t('ephemeral.messagesWillBeAutomatically')}</span>
        </div>

        <div style={{ backgroundColor: t.surface, borderRadius: t.radius, border: `1px solid ${t.border}`, overflow: 'hidden' }}>
          {OPTS.map((o, i) => {
            const sel = pick === o.id;
            return (
              <button
                key={o.id}
                onClick={() => handleSelect(o.id, o.sec, o.label)}
                aria-label={o.label}
                style={{
                  display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12,
                  padding: '12px 16px', width: '100%', boxSizing: 'border-box',
                  borderBottom: i < OPTS.length - 1 ? `1px solid ${t.divider}` : 'none',
                  backgroundColor: sel ? `${t.accent}0D` : 'transparent',
                  border: 'none', borderBottomWidth: i < OPTS.length - 1 ? 1 : 0,
                  borderBottomStyle: 'solid', borderBottomColor: t.divider,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: 10,
                  border: `2px solid ${sel ? t.accent : t.borderStrong}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, boxSizing: 'border-box',
                }}>
                  {sel && <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.accent }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: sel ? '600' : '400', color: t.text, display: 'block' }}>
                    {o.label}
                  </span>
                  <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginTop: 2 }}>{o.sub}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
