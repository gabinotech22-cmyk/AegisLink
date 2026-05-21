import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useMessages } from '../store/messages';

interface Props {
  onBack: () => void;
}

const OPTS = [
  { id: 'off',  label: 'Off',       sub: 'Messages are kept indefinitely',  sec: 0 },
  { id: '30s',  label: '30 seconds', sub: 'Deletes 30 seconds after reading', sec: 30 },
  { id: '5m',   label: '5 minutes',  sub: 'Deletes 5 minutes after reading',  sec: 300 },
  { id: '1h',   label: '1 hour',     sub: 'Deletes 1 hour after reading',     sec: 3600 },
  { id: '1d',   label: '1 day',      sub: 'Deletes 24 hours after reading',   sec: 86400 },
  { id: '7d',   label: '7 days',     sub: 'Deletes 7 days after reading',     sec: 604800 },
  { id: '30d',  label: '30 days',    sub: 'Deletes 30 days after reading',    sec: 2592000 },
] as const;

export function EphemeralScreen({ onBack }: Props) {
  const { t } = useTheme();
  const ephemeralTimer = useMessages((s) => s.ephemeralTimer);
  const setEphemeralTimer = useMessages((s) => s.setEphemeralTimer);
  const initialPick = OPTS.find((o) => o.sec === ephemeralTimer)?.id ?? 'off';
  const [pick, setPick] = useState<string>(initialPick);

  function handleSelect(id: string, sec: number, label: string) {
    setPick(id);
    setEphemeralTimer(sec);
    if (sec > 0) {
      window.alert(`Disappearing messages enabled: ${label}`);
    } else {
      window.alert('Disappearing messages disabled.');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Disappearing messages" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 22px', boxSizing: 'border-box' }}>
        {/* Hero */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '22px 4px' }}>
          <div style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
            <I.Timer size={32} color={t.accent} />
          </div>
          <span style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text, textAlign: 'center', display: 'block' }}>
            Disappearing messages
          </span>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px', textAlign: 'center', maxWidth: 280, marginTop: 8, display: 'block' }}>
            Messages will be automatically deleted after the selected time, from both devices.
          </span>
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
