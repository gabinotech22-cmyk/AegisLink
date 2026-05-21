import React, { useState } from 'react';
import { useStore } from '../store/index.js';

const PALETTE = ['#05b875', '#8b5cf6', '#3b82f6', '#ec4899', '#f97316', '#eab308', '#6366f1'];
const EMOJIS = [null, '🛡️', '🔒', '🔑', '⚡', '🦉', '🦊'];

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

export default function Profile({ t, onClose, onDevices, onPanic }) {
  const identity = useStore((s) => s.identity);
  const displayName = useStore((s) => s.displayName);
  const avatarColor = useStore((s) => s.avatarColor);
  const profileEmoji = useStore((s) => s.profileEmoji);
  const setDisplayName = useStore((s) => s.setDisplayName);
  const setAvatarColor = useStore((s) => s.setAvatarColor);
  const setProfileEmoji = useStore((s) => s.setProfileEmoji);
  const activeProfile = useStore((s) => s.activeProfile);
  const setActiveProfile = useStore((s) => s.setActiveProfile);
  const workDisplayName = useStore((s) => s.workDisplayName);
  const workAvatarColor = useStore((s) => s.workAvatarColor);
  const setWorkDisplayName = useStore((s) => s.setWorkDisplayName);
  const setWorkAvatarColor = useStore((s) => s.setWorkAvatarColor);

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(displayName);
  const [draftColor, setDraftColor] = useState(avatarColor);
  const [draftEmoji, setDraftEmoji] = useState(profileEmoji);
  const [workOrg, setWorkOrg] = useState('');

  const aegisId = identity?.aegisId ?? '—';
  const pubKeyB64 = identity?.publicKeyB64 ?? '';
  const hex = b64ToHex(pubKeyB64);

  const initials = (displayName || aegisId).slice(0, 2).toUpperCase();

  function startEdit() {
    if (activeProfile === 'work') {
      setDraftName(workDisplayName);
      setDraftColor(workAvatarColor);
      setDraftEmoji(null);
    } else {
      setDraftName(displayName);
      setDraftColor(avatarColor);
      setDraftEmoji(profileEmoji);
    }
    setEditing(true);
  }

  function save() {
    if (activeProfile === 'work') {
      setWorkDisplayName(draftName);
      setWorkAvatarColor(draftColor);
    } else {
      setDisplayName(draftName);
      setAvatarColor(draftColor);
      setProfileEmoji(draftEmoji);
    }
    setEditing(false);
  }

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
          width: 520,
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
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 16, color: t.text }}>Mi perfil</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', padding: 4 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Profile switcher */}
          <div style={{ padding: '16px 22px 0', display: 'flex', gap: 8 }}>
            {['personal', 'work'].map((p) => {
              const active = activeProfile === p;
              return (
                <button
                  key={p}
                  onClick={() => setActiveProfile(p)}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    background: active ? t.accent : t.surface2,
                    color: active ? t.accentInk : t.textMuted,
                    border: 'none',
                    borderRadius: 99,
                    fontFamily: t.font,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    transition: 'background 0.12s, color 0.12s',
                    textTransform: 'capitalize',
                  }}
                >
                  {p}
                </button>
              );
            })}
          </div>

          {/* Avatar section */}
          <div style={{ padding: '24px 22px', borderBottom: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 40,
                  background: (editing ? draftColor : (activeProfile === 'work' ? workAvatarColor : avatarColor)) + '33',
                  border: `2px solid ${editing ? draftColor : (activeProfile === 'work' ? workAvatarColor : avatarColor)}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 28,
                }}
              >
                {activeProfile === 'personal' && (editing ? draftEmoji : profileEmoji) ? (
                  <span style={{ fontSize: 32 }}>{editing ? draftEmoji : profileEmoji}</span>
                ) : (
                  <span style={{ fontFamily: t.fontMono, fontWeight: 700, fontSize: 26, color: editing ? draftColor : (activeProfile === 'work' ? workAvatarColor : avatarColor) }}>
                    {(editing
                      ? (draftName || aegisId)
                      : (activeProfile === 'work' ? (workDisplayName || aegisId) : (displayName || aegisId))
                    ).slice(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
            </div>

            {!editing ? (
              <>
                <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 18, color: t.text }}>
                  {activeProfile === 'work' ? (workDisplayName || aegisId) : (displayName || aegisId)}
                </div>
                <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textMuted, letterSpacing: '0.04em' }}>
                  {aegisId}
                </div>
                <button
                  onClick={startEdit}
                  style={{
                    padding: '7px 20px',
                    background: 'transparent',
                    border: `1px solid ${t.border}`,
                    borderRadius: t.radiusS,
                    color: t.text,
                    fontFamily: t.font,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Editar
                </button>
              </>
            ) : (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 6 }}>NOMBRE</div>
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder="Tu nombre"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      background: t.surface2,
                      border: `1px solid ${t.border}`,
                      borderRadius: t.radiusS,
                      color: t.text,
                      fontFamily: t.font,
                      fontSize: 14,
                      padding: '8px 12px',
                      outline: 'none',
                    }}
                  />
                </div>

                <div>
                  <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 8 }}>COLOR</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {PALETTE.map((c) => (
                      <button
                        key={c}
                        onClick={() => setDraftColor(c)}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 14,
                          background: c + '44',
                          border: draftColor === c ? `2px solid ${c}` : `2px solid transparent`,
                          cursor: 'pointer',
                          outline: 'none',
                          position: 'relative',
                        }}
                      >
                        <div style={{ position: 'absolute', inset: 4, borderRadius: 99, background: c }} />
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 8 }}>EMOJI</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {EMOJIS.map((e, i) => (
                      <button
                        key={i}
                        onClick={() => setDraftEmoji(e)}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: t.radiusS,
                          background: draftEmoji === e ? t.accent + '22' : t.surface2,
                          border: draftEmoji === e ? `1px solid ${t.accent}` : `1px solid ${t.border}`,
                          cursor: 'pointer',
                          fontSize: 18,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {e === null ? (
                          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted }}>—</span>
                        ) : e}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    onClick={() => setEditing(false)}
                    style={{ flex: 1, padding: '9px 0', background: 'transparent', border: `1px solid ${t.border}`, borderRadius: t.radiusS, color: t.textMuted, fontFamily: t.font, fontSize: 13, cursor: 'pointer' }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={save}
                    style={{ flex: 1, padding: '9px 0', background: t.accent, border: 'none', borderRadius: t.radiusS, color: t.accentInk, fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                  >
                    Guardar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Fingerprint */}
          <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.border}` }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 12 }}>HUELLA DIGITAL</div>
            <div style={{ fontFamily: t.font, fontSize: 12, color: t.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
              Comparte esta huella con tus contactos para verificar tu identidad.
            </div>
            <FingerprintGrid hex={hex} t={t} />
          </div>

          {/* Links */}
          <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 4 }}>ACCESOS RÁPIDOS</div>
            <button
              onClick={onDevices}
              style={{ width: '100%', padding: '11px 14px', background: 'transparent', border: `1px solid ${t.border}`, borderRadius: t.radiusS, color: t.text, fontFamily: t.font, fontSize: 13, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
              </svg>
              Dispositivos vinculados
            </button>
            <button
              onClick={onPanic}
              style={{ width: '100%', padding: '11px 14px', background: 'transparent', border: `1px solid ${t.danger}`, borderRadius: t.radiusS, color: t.danger, fontFamily: t.font, fontSize: 13, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              Modo pánico
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
