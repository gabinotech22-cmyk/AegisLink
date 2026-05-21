import React, { useState } from 'react';
import { useStore } from '../store/index.js';
import { fetchPrekeyBundle } from '../socket/client.js';
import { saveContact } from '../db/local.js';

export default function Sidebar({ t, onOpenSettings, onOpenDevices, onOpenWork, onOpenProfile, onOpenSearch, onSelectContact }) {
  const [query, setQuery] = useState('');
  const [addingContact, setAddingContact] = useState(false);
  const [newAegisId, setNewAegisId] = useState('');
  const [addError, setAddError] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  const identity = useStore((s) => s.identity);
  const activeProfile = useStore((s) => s.activeProfile);
  const contacts = useStore((s) => s.contacts);
  const conversations = useStore((s) => s.conversations);
  const connected = useStore((s) => s.connected);
  const activeChat = useStore((s) => s.activeChat);
  const setActiveChat = useStore((s) => s.setActiveChat);
  const addContact = useStore((s) => s.addContact);

  // Build conversation list from contacts + conversation data
  const convList = contacts
    .map((c) => {
      const conv = conversations[c.aegisId] ?? {};
      return {
        aegisId: c.aegisId,
        name: c.name,
        lastMsg: conv.lastMsg ?? '',
        lastTime: conv.lastTime ?? '',
        unread: conv.unread ?? 0,
        blocked: c.blocked === true,
      };
    })
    .filter((c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      c.aegisId.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => (b.lastTime > a.lastTime ? 1 : -1));

  async function handleAddContact() {
    const id = newAegisId.trim().toUpperCase();
    if (!id) return;
    // Validate format: XXX-XXXX-XXXX (Crockford base32)
    const AEGIS_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
    if (!AEGIS_RE.test(id)) {
      setAddError('Formato de AegisID inválido (ej: ABC-DEF1-GH23)');
      return;
    }
    setAddError('');
    setAddLoading(true);
    try {
      const bundle = await fetchPrekeyBundle(id);
      const contact = {
        aegisId: id,
        publicKeyB64: bundle.identityKeyB64 ?? bundle.signedPreKey?.publicKeyB64 ?? '',
        signingPublicKeyB64: bundle.signingPublicKeyB64 ?? '',
        name: id,
        verified: false,
        addedAt: Date.now(),
      };
      addContact(contact);
      await saveContact(contact);
      setAddingContact(false);
      setNewAegisId('');
      setActiveChat(id);
    } catch (err) {
      setAddError(err?.message ?? 'No se pudo encontrar el contacto.');
    } finally {
      setAddLoading(false);
    }
  }

  const shortId = identity?.aegisId ?? '---';

  return (
    <aside
      style={{
        width: 280,
        flexShrink: 0,
        background: t.surface,
        borderRight: `1px solid ${t.border}`,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 14px 10px',
          borderBottom: `1px solid ${t.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div style={{ cursor: 'pointer' }} onClick={onOpenProfile} title="Mi perfil">
          <Avatar name={shortId} color={t.accent} t={t} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: t.fontMono,
            fontWeight: 600,
            fontSize: 11,
            color: t.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '0.04em',
          }}>
            {shortId}
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 9, color: connected ? t.accent : t.textMuted, letterSpacing: '0.08em', marginTop: 1 }}>
            {connected ? 'ONLINE' : 'OFFLINE'}
          </div>
        </div>
        {/* Search button */}
        <button
          title="Buscar (Ctrl+K)"
          onClick={onOpenSearch}
          style={{
            background: 'none',
            border: 'none',
            borderRadius: t.radiusS,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: t.textMuted,
            flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
        </button>
        {/* Add contact button */}
        <button
          title="Añadir contacto"
          onClick={() => { setAddingContact((v) => !v); setAddError(''); setNewAegisId(''); }}
          style={{
            background: addingContact ? t.surface2 : 'none',
            border: 'none',
            borderRadius: t.radiusS,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: t.accent,
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {/* Add contact panel */}
      {addingContact && (
        <div style={{ padding: '10px 12px', borderBottom: `1px solid ${t.border}`, background: t.surface2 }}>
          <div style={{ fontFamily: t.font, fontSize: 12, color: t.textMuted, marginBottom: 6 }}>
            AegisID del contacto
          </div>
          <input
            value={newAegisId}
            onChange={(e) => setNewAegisId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddContact(); }}
            placeholder="ABC-DEF1-GH23"
            style={{
              width: '100%',
              background: t.surface,
              border: `1px solid ${addError ? t.danger : t.border}`,
              borderRadius: t.radiusS,
              color: t.text,
              fontFamily: t.fontMono,
              fontSize: 12,
              padding: '7px 10px',
              outline: 'none',
              boxSizing: 'border-box',
              letterSpacing: '0.04em',
            }}
          />
          {addError && (
            <div style={{ fontFamily: t.font, fontSize: 11, color: t.danger, marginTop: 4 }}>{addError}</div>
          )}
          <button
            onClick={addLoading ? undefined : handleAddContact}
            style={{
              marginTop: 8,
              width: '100%',
              padding: '8px 0',
              background: t.accent,
              border: 'none',
              borderRadius: t.radiusS,
              color: t.accentInk,
              fontFamily: t.font,
              fontWeight: 600,
              fontSize: 12,
              cursor: addLoading ? 'default' : 'pointer',
              opacity: addLoading ? 0.6 : 1,
            }}
          >
            {addLoading ? 'Buscando…' : 'Añadir'}
          </button>
        </div>
      )}

      {/* Search */}
      <div style={{ padding: '10px 12px 6px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: t.surface2,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusS,
            padding: '6px 10px',
          }}
        >
          <SearchIcon color={t.textMuted} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar…"
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              fontFamily: t.font,
              fontSize: 13,
              color: t.text,
            }}
          />
        </div>
      </div>

      {/* Conversation list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {convList.length === 0 && (
          <div style={{ padding: '32px 16px', fontFamily: t.font, fontSize: 13, color: t.textMuted, textAlign: 'center', lineHeight: 1.6 }}>
            {contacts.length === 0
              ? 'Sin contactos. Pulsa + para añadir uno por su AegisID.'
              : 'Sin resultados'}
          </div>
        )}
        {convList.map((conv) => (
          <ConvRow
            key={conv.aegisId}
            conv={conv}
            active={activeChat === conv.aegisId}
            t={t}
            onClick={() => { setActiveChat(conv.aegisId); onSelectContact?.(); }}
          />
        ))}
      </div>

      {/* Footer icons */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          padding: '10px 0',
          borderTop: `1px solid ${t.border}`,
        }}
      >
        {activeProfile === 'work' && (
          <FooterIcon t={t} title="Work Dashboard" icon={<BuildingIcon color={t.textMuted} />} onClick={onOpenWork} />
        )}
        <FooterIcon t={t} title="Dispositivos" icon={<MonitorIcon color={t.textMuted} />} onClick={onOpenDevices} />
        <FooterIcon t={t} title="Configuración" icon={<SettingsIcon color={t.textMuted} />} onClick={onOpenSettings} />
      </div>
    </aside>
  );
}

function ConvRow({ conv, active, t, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: active || hovered ? t.surface2 : 'transparent',
        cursor: 'pointer',
        transition: 'background 0.1s',
        borderLeft: active ? `3px solid ${t.accent}` : '3px solid transparent',
      }}
    >
      <Avatar name={conv.name} color={t.accentDim} t={t} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: t.font, fontWeight: 600, fontSize: 13, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
            {conv.name}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {conv.blocked && (
              <span title="Bloqueado" style={{ fontSize: 11, lineHeight: 1 }}>🚫</span>
            )}
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted }}>
              {conv.lastTime}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
          <span style={{ fontFamily: t.font, fontSize: 12, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
            {conv.lastMsg || 'Sin mensajes'}
          </span>
          {conv.unread > 0 && (
            <span
              style={{
                background: t.accent,
                color: t.accentInk,
                fontFamily: t.fontMono,
                fontSize: 10,
                fontWeight: 700,
                borderRadius: 99,
                padding: '1px 6px',
                flexShrink: 0,
              }}
            >
              {conv.unread}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Avatar({ name, color, t, size = 32 }) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: color + '33',
        border: `1px solid ${color}55`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <span style={{ fontFamily: t.fontMono, fontSize: size * 0.35, fontWeight: 600, color }}>
        {initials}
      </span>
    </div>
  );
}

function FooterIcon({ t, title, icon, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? t.surface2 : 'none',
        border: 'none',
        borderRadius: t.radiusS,
        width: 36,
        height: 36,
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

function SearchIcon({ color }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
function SettingsIcon({ color }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8L3.2 7a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H8a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1A2 2 0 1119.7 7l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}
function MonitorIcon({ color }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
function BuildingIcon({ color }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" />
    </svg>
  );
}
