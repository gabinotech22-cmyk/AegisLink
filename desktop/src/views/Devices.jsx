import React, { useEffect, useState } from 'react';
import { getSocket } from '../socket/client.js';

export default function Devices({ t, onClose, onLinkNew }) {
  const [devices, setDevices] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const socket = getSocket();
    if (!socket?.connected) {
      setDevices([{ platform: 'desktop', current: true }]);
      setLoading(false);
      return;
    }
    socket.emit('device:list', {}, (res) => {
      if (res?.platforms) {
        const list = res.platforms.map((p, i) => ({
          platform: p,
          current: p === 'desktop' && i === 0,
        }));
        setDevices(list);
      } else {
        setDevices([{ platform: 'desktop', current: true }]);
      }
      setLoading(false);
    });
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 440,
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 16, color: t.text }}>Dispositivos vinculados</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', padding: 4 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 22px' }}>
          <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, marginBottom: 16, lineHeight: 1.5 }}>
            Todos los dispositivos comparten tu identidad E2EE. Las claves privadas nunca salen de cada dispositivo.
          </div>

          {loading ? (
            <div style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textMuted, textAlign: 'center', padding: 24 }}>
              Cargando…
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
              {(devices ?? []).map((d, i) => (
                <DeviceRow key={i} device={d} t={t} />
              ))}
            </div>
          )}

          <button
            onClick={onLinkNew}
            style={{
              width: '100%',
              padding: '11px 0',
              background: t.accent,
              border: 'none',
              borderRadius: t.radiusS,
              color: t.accentInk,
              fontFamily: t.font,
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <path d="M14 14h3v3h-3zM21 14v3M14 21h7M17 17v4" />
            </svg>
            Vincular nuevo dispositivo
          </button>
        </div>
      </div>
    </div>
  );
}

function DeviceRow({ device, t }) {
  const isMobile = device.platform === 'mobile';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        background: t.surface2,
        border: `1px solid ${t.border}`,
        borderRadius: t.radiusS,
      }}
    >
      <div style={{ color: t.accent, flexShrink: 0 }}>
        {isMobile ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="2" />
            <path d="M12 18h.01" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        )}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: t.font, fontSize: 13, fontWeight: 600, color: t.text }}>
          {isMobile ? 'Móvil' : 'Escritorio'} {device.current ? '(este dispositivo)' : ''}
        </div>
        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, marginTop: 2, letterSpacing: '0.06em' }}>
          {device.platform.toUpperCase()} · E2EE ACTIVO
        </div>
      </div>
      {device.current && (
        <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: '0.08em', border: `1px solid ${t.accent}44`, borderRadius: 4, padding: '2px 6px' }}>
          ACTUAL
        </span>
      )}
    </div>
  );
}
