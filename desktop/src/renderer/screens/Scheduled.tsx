import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useContacts } from '../store/contacts';
import { loadScheduled, saveScheduled, type ScheduledItem } from '../store/scheduled';

interface Props {
  onBack: () => void;
  contactId?: string;
}

const DELAYS = [
  { get label() { return i18n.t('scheduled.5SecTest'); }, sec: 5 },
  { get label() { return i18n.t('scheduled.15Sec'); }, sec: 15 },
  { get label() { return i18n.t('scheduled.delay1m'); }, sec: 60 },
  { get label() { return i18n.t('scheduled.delay5m'); }, sec: 300 },
  { get label() { return i18n.t('scheduled.delay1h'); }, sec: 3600 },
  { get label() { return i18n.t('scheduled.delay1d'); }, sec: 86400 },
];

export function ScheduledScreen({ onBack, contactId }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const { contacts } = useContacts();
  const [items, setItems] = useState<ScheduledItem[]>([]);
  const [isScheduling, setIsScheduling] = useState(false);
  const [targetId, setTargetId] = useState(contactId ?? contacts[0]?.aegisId ?? '');
  const [bodyText, setBodyText] = useState('');
  const [delay, setDelay] = useState(5);
  const [now, setNow] = useState(Date.now());

  const persist = useCallback((next: ScheduledItem[]) => {
    saveScheduled(next);
  }, []);

  // Re-read from storage on every tick: the app-wide runner (App.tsx) delivers
  // and removes due items, so the list must reflect those removals live, not
  // just on mount.
  useEffect(() => {
    setItems(loadScheduled());
    const timer = setInterval(() => {
      setNow(Date.now());
      setItems(loadScheduled());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  function handleAddScheduled() {
    if (!bodyText.trim()) { window.alert(i18n.t('scheduled.messageCannotBeEmpty')); return; }
    const dest = contacts.find((c) => c.aegisId === targetId);
    if (!dest) { window.alert(i18n.t('scheduled.selectARecipient')); return; }
    const newItem: ScheduledItem = {
      id: Math.random().toString(36).substr(2, 9),
      toContactId: dest.aegisId,
      toContactName: dest.name,
      text: bodyText.trim(),
      sendAt: Date.now() + delay * 1000,
    };
    const next = [...items, newItem];
    setItems(next);
    persist(next);
    setBodyText('');
    setIsScheduling(false);
    window.alert(i18n.t('scheduled.scheduledToV0In', { v0: dest.name, v1: delay }));
  }

  const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100, padding: 20, boxSizing: 'border-box',
  };

  const modalStyle: CSSProperties = {
    backgroundColor: t.surface, border: `1px solid ${t.border}`,
    borderRadius: 16, padding: 20, width: '100%', maxWidth: 420,
    boxSizing: 'border-box',
  };

  const inputStyle: CSSProperties = {
    width: '100%', padding: '12px', fontFamily: t.font, fontSize: 14,
    color: t.text, backgroundColor: t.bg, border: `1px solid ${t.borderStrong}`,
    borderRadius: t.radiusS, boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('scheduled.title')} left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } right={
        <button onClick={() => setIsScheduling(true)} aria-label={i18n.t('scheduled.schedule')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.Plus size={22} color={t.accent} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 22 }}>
        <div style={{ margin: '12px 18px 14px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>{i18n.t('scheduled.scheduledMessagesAreEncrypted')}</span>
        </div>

        {items.length === 0 ? (
          <div style={{ padding: 36, textAlign: 'center' }}>
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>{i18n.t('scheduled.empty')}</span>
          </div>
        ) : items.map((it) => {
          const secsLeft = Math.max(0, Math.ceil((it.sendAt - now) / 1000));
          return (
            <div key={it.id} style={{ display: 'flex', flexDirection: 'row', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${t.divider}` }}>
              <div style={{ width: 38, height: 38, borderRadius: t.radius, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <I.Timer size={18} color={t.accent} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 13, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.toContactName}
                  </span>
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.4, flexShrink: 0 }}>
                    in {secsLeft}s
                  </span>
                </div>
                <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '18px', display: 'block' }}>{it.text}</span>
                <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, marginTop: 4, letterSpacing: 0.5, display: 'block' }}>{i18n.t('scheduled.e2eeQueued')}</span>
              </div>
            </div>
          );
        })}

        <div style={{ padding: '14px 18px' }}>
          <button
            onClick={() => setIsScheduling(true)}
            style={{ width: '100%', padding: '13px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.text }}
          >{i18n.t('scheduled.scheduleMessage')}</button>
        </div>
      </div>

      {isScheduling && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '700', color: t.text, display: 'block', marginBottom: 16 }}>{i18n.t('scheduled.schedule')}</span>

            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginBottom: 6 }}>{i18n.t('scheduled.recipient')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {contacts.map((c) => {
                const sel = targetId === c.aegisId;
                return (
                  <button
                    key={c.aegisId}
                    onClick={() => setTargetId(c.aegisId)}
                    style={{ padding: '8px 12px', borderRadius: t.radiusS, backgroundColor: sel ? t.accent : t.bg, border: `1px solid ${sel ? t.accent : t.borderStrong}`, cursor: 'pointer', fontFamily: t.font, fontSize: 12, color: sel ? t.accentInk : t.text }}
                  >
                    {c.name}
                  </button>
                );
              })}
              {contacts.length === 0 && <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>{i18n.t('contacts.emptyTitle')}</span>}
            </div>

            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginBottom: 6 }}>{i18n.t('contactDetail.message')}</span>
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              placeholder={i18n.t('scheduled.typeYourMessage')}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', marginBottom: 16 }}
            />

            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginBottom: 6 }}>{i18n.t('scheduled.sendIn')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 22 }}>
              {DELAYS.map((d) => {
                const sel = delay === d.sec;
                return (
                  <button
                    key={d.sec}
                    onClick={() => setDelay(d.sec)}
                    style={{ padding: '6px 10px', borderRadius: t.radiusS, backgroundColor: sel ? t.accent : t.bg, border: `1px solid ${sel ? t.accent : t.borderStrong}`, cursor: 'pointer', fontFamily: t.font, fontSize: 11, color: sel ? t.accentInk : t.text }}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleAddScheduled}
                style={{ flex: 1, padding: '12px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.accentInk }}
              >{i18n.t('scheduled.schedule2')}</button>
              <button
                onClick={() => { setIsScheduling(false); setBodyText(''); }}
                style={{ flex: 1, padding: '12px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '500', color: t.text }}
              >{i18n.t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
