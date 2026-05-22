import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import type { WorkChannel } from '../store/work';

const WORK_ACCENT = '#6366f1';

const ANIM_CSS = `
@keyframes wjs-fadein {
  from { opacity: 0; transform: scale(0.92) translateY(12px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.wjs-enter { animation: wjs-fadein 0.45s cubic-bezier(0.22, 1, 0.36, 1) both; }
.wjs-enter-1 { animation: wjs-fadein 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.08s both; }
.wjs-enter-2 { animation: wjs-fadein 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.16s both; }
.wjs-enter-3 { animation: wjs-fadein 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.24s both; }
.wjs-enter-4 { animation: wjs-fadein 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.34s both; }
@keyframes wjs-ring {
  0%   { transform: scale(1);   opacity: 0.4; }
  100% { transform: scale(2.2); opacity: 0; }
}
.wjs-ring { animation: wjs-ring 2s ease-out infinite; }
.wjs-ring-2 { animation: wjs-ring 2s ease-out 0.6s infinite; }
`;

interface Props {
  orgName: string;
  role: 'admin' | 'member';
  channels: WorkChannel[];
  onContinue: () => void;
}

export function WorkJoinSuccess({ orgName, role, channels, onContinue }: Props) {
  const { t } = useTheme();

  const containerStyle: CSSProperties = {
    display: 'flex',
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    backgroundColor: t.bg,
    padding: '0 32px',
    gap: 0,
    boxSizing: 'border-box',
  };

  const shieldWrapStyle: CSSProperties = {
    position: 'relative',
    width: 80,
    height: 80,
    marginBottom: 28,
  };

  const ringBaseStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    borderRadius: '50%',
    border: `2px solid ${WORK_ACCENT}`,
  };

  const shieldInnerStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${WORK_ACCENT}18`,
    borderRadius: '50%',
  };

  const headlineStyle: CSSProperties = {
    fontFamily: t.fontDisplay,
    fontSize: 26,
    fontWeight: 700,
    color: t.text,
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: -0.4,
  };

  const rolePillStyle: CSSProperties = {
    display: 'inline-block',
    padding: '4px 14px',
    borderRadius: 99,
    backgroundColor: role === 'admin' ? `${WORK_ACCENT}22` : `${t.accent}18`,
    border: `1px solid ${role === 'admin' ? WORK_ACCENT : t.accent}`,
    fontFamily: t.fontMono,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1.2,
    color: role === 'admin' ? WORK_ACCENT : t.accent,
    marginBottom: 24,
  };

  const channelListStyle: CSSProperties = {
    width: '100%',
    maxWidth: 320,
    backgroundColor: t.surface,
    borderRadius: t.radius,
    border: `1px solid ${t.border}`,
    overflow: 'hidden',
    marginBottom: 28,
  };

  const channelRowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
    borderBottom: `1px solid ${t.divider}`,
  };

  const channelRowLastStyle: CSSProperties = {
    ...channelRowStyle,
    borderBottom: 'none',
  };

  const btnStyle: CSSProperties = {
    width: '100%',
    maxWidth: 320,
    padding: '13px 0',
    backgroundColor: WORK_ACCENT,
    border: 'none',
    borderRadius: t.radiusS,
    cursor: 'pointer',
    fontFamily: t.font,
    fontWeight: 700,
    fontSize: 15,
    color: '#ffffff',
  };

  return (
    <div style={containerStyle}>
      <style>{ANIM_CSS}</style>

      {/* Shield icon with pulse rings */}
      <div className="wjs-enter" style={shieldWrapStyle}>
        <div className="wjs-ring" style={ringBaseStyle} />
        <div className="wjs-ring-2" style={ringBaseStyle} />
        <div style={shieldInnerStyle}>
          <I.Shield size={36} color={WORK_ACCENT} />
        </div>
      </div>

      {/* Headline */}
      <span className="wjs-enter-1" style={headlineStyle}>
        Bienvenido a {orgName}
      </span>

      {/* Role badge */}
      <span className="wjs-enter-2" style={rolePillStyle}>
        {role === 'admin' ? 'ADMIN' : 'MIEMBRO'}
      </span>

      {/* Channel list */}
      {channels.length > 0 && (
        <div className="wjs-enter-3" style={channelListStyle}>
          <div style={{ padding: '8px 16px 6px', borderBottom: `1px solid ${t.divider}` }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1.1 }}>
              CANALES
            </span>
          </div>
          {channels.map((ch, idx) => (
            <div
              key={ch.channelId}
              style={idx === channels.length - 1 ? channelRowLastStyle : channelRowStyle}
            >
              <span style={{ fontFamily: t.fontMono, fontSize: 13, color: WORK_ACCENT, fontWeight: 700 }}>#</span>
              <span style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>{ch.name}</span>
              {ch.isAnnouncements && (
                <span style={{ marginLeft: 'auto', fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 0.8 }}>
                  ANN
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* CTA */}
      <div className="wjs-enter-4" style={{ width: '100%', maxWidth: 320 }}>
        <button onClick={onContinue} style={btnStyle}>
          Entrar al workspace
        </button>
      </div>
    </div>
  );
}
