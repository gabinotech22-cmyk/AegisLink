import React, { useState } from 'react';
import { useStore } from '../store/index.js';
import { setContactBlocked } from '../db/local.js';

function b64ToHex(b64) {
  try {
    const bin = atob(b64);
    let hex = '';
    for (let i = 0; i < bin.length; i++) {
      hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return '';
  }
}

function FingerprintGrid({ hex, t }) {
  const blocks = [];
  for (let i = 0; i < 8; i++) {
    blocks.push(hex.slice(i * 4, i * 4 + 4).toUpperCase() || '????');
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
      {blocks.map((b, i) => (
        <div
          key={i}
          style={{
            background: t.surface2,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusS,
            padding: '6px 0',
            textAlign: 'center',
            fontFamily: t.fontMono,
            fontSize: 13,
            color: t.accent,
            letterSpacing: '0.08em',
          }}
        >
          {b}
        </div>
      ))}
    </div>
  );
}

function Toggle({ label, detail, on, onChange, t, dangerOn }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div>
        <div style={{ fontFamily: t.font, fontSize: 13, color: on && dangerOn ? t.danger : t.text }}>{label}</div>
        {detail && <div style={{ fontFamily: t.font, fontSize: 11, color: t.textMuted, marginTop: 2 }}>{detail}</div>}
      </div>
      <button
        onClick={() => onChange(!on)}
        style={{
          width: 38,
          height: 22,
          borderRadius: 11,
          background: on ? (dangerOn ? t.danger : t.accent) : t.surface2,
          border: `1px solid ${on ? (dangerOn ? t.danger : t.accent) : t.border}`,
          cursor: 'pointer',
          position: 'relative',
          flexShrink: 0,
          transition: 'background 0.2s',
          padding: 0,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: 8,
            background: '#fff',
            transition: 'left 0.2s',
          }}
        />
      </button>
    </div>
  );
}

export default function ContactDetail({ t, onClose }) {
  const activeChat = useStore((s) => s.activeChat);
  const contacts = useStore((s) => s.contacts);
  const setActiveChat = useStore((s) => s.setActiveChat);
  const removeContact = useStore((s) => s.removeContact);
  const updateContact = useStore((s) => s.updateContact);

  const contact = contacts.find((c) => c.aegisId === activeChat) ?? null;

  const [muted, setMuted] = useState(false);
  const [zeroTrust, setZeroTrust] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!contact) {
    return (
      <div
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{ padding: 40, fontFamily: t.font, color: t.textMuted, fontSize: 14 }}>
          Contacto no encontrado.
        </div>
      </div>
    );
  }

  const hex = b64ToHex(contact.publicKeyB64 ?? '');
  const initials = (contact.name || contact.aegisId).slice(0, 2).toUpperCase();
  const color = contact.color ?? t.accent;
  const blocked = contact.blocked === true;

  async function handleToggleBlocked(value) {
    updateContact(contact.aegisId, { blocked: value });
    await setContactBlocked(contact.aegisId, value);
  }

  async function handleDelete() {
    removeContact(contact.aegisId);
    try {
      await window.db?.run('DELETE FROM contacts WHERE aegis_id = ?', [contact.aegisId]);
    } catch {
      // best-effort
    }
    setActiveChat(null);
    onClose();
  }

  return (
    <div
      style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 480,
          maxHeight: '82vh',
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 16, color: t.text }}>Detalle del contacto</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', padding: 4 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Contact header */}
          <div style={{ padding: '24px 22px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: 30,
                background: color + '33',
                border: `2px solid ${color}55`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span style={{ fontFamily: t.fontMono, fontWeight: 700, fontSize: 20, color }}>{initials}</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 17, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {contact.name}
                </div>
                {blocked && (
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.danger, background: t.danger + '22', borderRadius: 4, padding: '2px 6px' }}>
                    BLOQUEADO
                  </span>
                )}
              </div>
              <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textMuted, letterSpacing: '0.04em', marginTop: 2 }}>
                {contact.aegisId}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => { setActiveChat(contact.aegisId); onClose(); }}
                title="Abrir chat"
                style={{ width: 36, height: 36, borderRadius: t.radiusS, background: t.accent + '22', border: `1px solid ${t.accent}55`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.accent }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
              </button>
              <button
                title="Llamada (próximamente)"
                style={{ width: 36, height: 36, borderRadius: t.radiusS, background: t.surface2, border: `1px solid ${t.border}`, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.textMuted, opacity: 0.5 }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.72A2 2 0 012 1.05h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 8.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Fingerprint */}
          <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.border}` }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 12 }}>HUELLA DIGITAL</div>
            <div style={{ fontFamily: t.font, fontSize: 12, color: t.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
              Verifica esta huella con tu contacto fuera de banda para asegurar la comunicación.
            </div>
            <FingerprintGrid hex={hex} t={t} />
          </div>

          {/* Toggles */}
          <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 4 }}>OPCIONES</div>
            <Toggle label="Silenciado" t={t} on={muted} onChange={setMuted} />
            <Toggle label="Zero-trust" detail="Bloquea mensajes si cambia la clave" t={t} on={zeroTrust} onChange={setZeroTrust} />
            <Toggle
              label="Bloqueado"
              detail="Los mensajes de este contacto no se enviarán ni recibirán"
              t={t}
              on={blocked}
              onChange={handleToggleBlocked}
              dangerOn
            />
          </div>

          {/* Danger */}
          <div style={{ padding: '18px 22px' }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.danger, letterSpacing: '0.1em', marginBottom: 12 }}>ZONA DE PELIGRO</div>
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                style={{
                  width: '100%',
                  padding: '11px 0',
                  background: 'transparent',
                  border: `1px solid ${t.danger}`,
                  borderRadius: t.radiusS,
                  color: t.danger,
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                Vaciar y eliminar contacto
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontFamily: t.font, fontSize: 13, color: t.danger, lineHeight: 1.5 }}>
                  Se eliminarán todos los mensajes y datos de este contacto de forma irreversible.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    style={{ flex: 1, padding: '9px 0', background: 'transparent', border: `1px solid ${t.border}`, borderRadius: t.radiusS, color: t.textMuted, fontFamily: t.font, fontSize: 13, cursor: 'pointer' }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleDelete}
                    style={{ flex: 1, padding: '9px 0', background: t.danger, border: 'none', borderRadius: t.radiusS, color: '#fff', fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
