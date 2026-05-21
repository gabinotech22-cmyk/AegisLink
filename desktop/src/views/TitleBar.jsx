import React from 'react';
import { Shield, Minimize, Maximize, X } from '../components/Icons';

export default function TitleBar({ t }) {
  return (
    <div
      style={{
        height: 38,
        background: t.surface,
        borderBottom: `1px solid ${t.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 14,
        paddingRight: 0,
        flexShrink: 0,
        WebkitAppRegion: 'drag',
      }}
    >
      {/* Left: logo + name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Shield size={18} color={t.accent} />
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: 12,
            fontWeight: 600,
            color: t.text,
            letterSpacing: '0.05em',
          }}
        >
          AegisLink
        </span>
      </div>

      {/* Right: window controls — must NOT be draggable */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          WebkitAppRegion: 'no-drag',
        }}
      >
        {[
          { icon: <Minimize size={12} />, title: 'Minimize', action: () => window.electronWindow?.minimize(), hoverBg: t.surface2 },
          { icon: <Maximize size={12} />, title: 'Maximize', action: () => window.electronWindow?.maximize(), hoverBg: t.surface2 },
          { icon: <X size={12} />,        title: 'Close',    action: () => window.electronWindow?.close(),    hoverBg: '#c0392b', hoverText: '#fff' },
        ].map(({ icon, title, action, hoverBg, hoverText }) => (
          <WinButton key={title} icon={icon} title={title} onClick={action} hoverBg={hoverBg} hoverText={hoverText} t={t} />
        ))}
      </div>
    </div>
  );
}

function WinButton({ icon, title, onClick, hoverBg, hoverText, t }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 46,
        height: 38,
        border: 'none',
        background: hovered ? hoverBg : 'transparent',
        color: hovered && hoverText ? hoverText : t.textMuted,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'background 0.12s',
      }}
    >
      {icon}
    </button>
  );
}
