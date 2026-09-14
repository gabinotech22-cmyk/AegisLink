import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';

interface Props {
  onBack: () => void;
}

export function NotificationsScreen({ onBack }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();

  // Stub preferences
  const [master, setMaster] = useState(true);
  const [preview, setPreview] = useState(true);
  const [sound, setSound] = useState(true);
  const [badge, setBadge] = useState(true);
  const [summary, setSummary] = useState(false);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [mutedIds] = useState<string[]>([]);
  const [kwInput, setKwInput] = useState('');
  const [showKwInput, setShowKwInput] = useState(false);

  const muted = mutedIds.map((id) => ({ id, name: id, until: 'always' }));

  function removeKeyword(k: string) {
    setKeywords((prev) => prev.filter((x) => x !== k));
  }

  function commitKeyword() {
    const v = kwInput.trim().toLowerCase();
    if (v && !keywords.includes(v)) setKeywords((prev) => [...prev, v]);
    setKwInput('');
    setShowKwInput(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title={i18n.t('notifications.title')}
        big
        left={
          <button onClick={onBack} aria-label={i18n.t('common.back')} style={iconBtn}>
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 4, paddingBottom: 22 }}>
        <Section t={t} label={i18n.t('notifications.generalSection')}>
          <Toggle t={t} label={i18n.t('notifications.title')} sub={i18n.t('notifications.masterSwitchTurnsOff')} value={master} onChange={setMaster} />
          <div style={{ opacity: master ? 1 : 0.4, pointerEvents: master ? 'auto' : 'none' }}>
            <Toggle t={t} label={i18n.t('notifications.showContent')} sub='If off, only displays "new encrypted message"' value={preview} onChange={setPreview} />
            <Toggle t={t} label={i18n.t('notifications.sound')} value={sound} onChange={setSound} />
            <Toggle t={t} label={i18n.t('notifications.badge')} sub={i18n.t('notifications.badgeSub')} value={badge} onChange={setBadge} noBorder />
          </div>
        </Section>

        <div style={{ opacity: master ? 1 : 0.4, pointerEvents: master ? 'auto' : 'none' }}>
          <Section t={t} label={i18n.t('notifications.keywordsLabel')}>
            <div style={{ padding: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {keywords.map((k) => (
                  <div key={k} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10, paddingRight: 4, paddingTop: 4, paddingBottom: 4, backgroundColor: t.surface2, borderRadius: 99 }}>
                    <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text }}>{k}</span>
                    <button
                      onClick={() => removeKeyword(k)}
                      aria-label={i18n.t('notifications.removeKeywordV0', { v0: k })}
                      style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: t.surface3, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <span style={{ color: t.textDim, fontSize: 11 }}>×</span>
                    </button>
                  </div>
                ))}
                {showKwInput ? (
                  <input
                    autoFocus
                    value={kwInput}
                    onChange={(e) => setKwInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitKeyword(); if (e.key === 'Escape') { setShowKwInput(false); setKwInput(''); } }}
                    onBlur={commitKeyword}
                    placeholder="keyword…"
                    style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text, paddingLeft: 12, paddingRight: 12, paddingTop: 5, paddingBottom: 5, border: `1px solid ${t.accent}`, borderRadius: 99, outline: 'none', backgroundColor: 'transparent', minWidth: 110 }}
                  />
                ) : (
                  <button
                    onClick={() => setShowKwInput(true)}
                    aria-label={i18n.t('notifications.addKeyword')}
                    style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 5, paddingBottom: 5, border: `1px dashed ${t.borderStrong}`, borderRadius: 99, background: 'none', cursor: 'pointer' }}
                  >
                    <span style={{ color: t.accent, fontFamily: t.fontMono, fontSize: 11 }}>{i18n.t('notifications.addBtn')}</span>
                  </button>
                )}
              </div>
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '17px', display: 'block' }}>{i18n.t('notifications.keywordsDesc')}</span>
            </div>
          </Section>

          <Section t={t} label={i18n.t('notifications.dailySummary')}>
            <Toggle t={t} label={i18n.t('notifications.localSummary')} sub={i18n.t('notifications.localSummarySub')} value={summary} onChange={setSummary} noBorder />
          </Section>

          <Section t={t} label={i18n.t('notifications.mutedV0', { v0: muted.length })}>
            {muted.length === 0 ? (
              <div style={{ padding: 14 }}>
                <span style={{ fontFamily: t.font, fontSize: 13, color: t.textFaint }}>{i18n.t('notifications.noMutedConversations')}</span>
              </div>
            ) : (
              muted.map((m, i) => (
                <div
                  key={m.id}
                  style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, borderBottom: i < muted.length - 1 ? `1px solid ${t.divider}` : 'none' }}
                >
                  <I.Mute size={18} color={t.textDim} />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontFamily: t.font, fontSize: 14, color: t.text, display: 'block' }}>{m.name}</span>
                    <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.4, marginTop: 2, display: 'block' }}>
                      UNTIL {m.until.toUpperCase()}
                    </span>
                  </div>
                  <button
                    onClick={() => {}}
                    aria-label={i18n.t('notifications.unmuteV0', { v0: m.name })}
                    style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, background: 'none', cursor: 'pointer' }}
                  >
                    <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.text, letterSpacing: 0.4 }}>{i18n.t('notifications.unmuteBtn')}</span>
                  </button>
                </div>
              ))
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

const iconBtn: CSSProperties = {
  padding: 8, background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
