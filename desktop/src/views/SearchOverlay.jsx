import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store/index.js';

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function SearchOverlay({ t, onClose }) {
  const [query, setQuery] = useState('');
  const contacts = useStore((s) => s.contacts);
  const messages = useStore((s) => s.messages);
  const setActiveChat = useStore((s) => s.setActiveChat);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();

  const matchedContacts = q
    ? contacts.filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.aegisId?.toLowerCase().includes(q),
      )
    : [];

  // Flatten messages into array with context
  const matchedMessages = [];
  if (q) {
    for (const [aegisId, msgs] of Object.entries(messages)) {
      if (!Array.isArray(msgs)) continue;
      const contact = contacts.find((c) => c.aegisId === aegisId);
      for (const msg of msgs) {
        if (msg.text?.toLowerCase().includes(q)) {
          matchedMessages.push({ ...msg, aegisId, contactName: contact?.name ?? aegisId });
        }
      }
    }
  }

  const hasResults = matchedContacts.length > 0 || matchedMessages.length > 0;

  function goToContact(aegisId) {
    setActiveChat(aegisId);
    onClose();
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 80,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 560,
          background: t.surface,
          border: `1px solid ${t.borderStrong ?? t.border}`,
          borderRadius: t.radius,
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: query ? `1px solid ${t.border}` : 'none' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar contactos y mensajes…"
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              fontFamily: t.font,
              fontSize: 16,
              color: t.text,
            }}
          />
          <kbd style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textMuted, background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 4, padding: '2px 6px' }}>
            ESC
          </kbd>
        </div>

        {/* Results */}
        {query && (
          <div style={{ maxHeight: 480, overflowY: 'auto' }}>
            {!hasResults && (
              <div style={{ padding: '32px 20px', textAlign: 'center', fontFamily: t.font, fontSize: 14, color: t.textMuted }}>
                Sin resultados para «{query}»
              </div>
            )}

            {matchedContacts.length > 0 && (
              <div>
                <div style={{ padding: '10px 18px 6px', fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em' }}>
                  CONTACTOS
                </div>
                {matchedContacts.map((c) => {
                  const color = c.color ?? t.accent;
                  const initials = (c.name || c.aegisId).slice(0, 2).toUpperCase();
                  return (
                    <button
                      key={c.aegisId}
                      onClick={() => goToContact(c.aegisId)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 18px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = t.surface2}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                    >
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 18,
                          background: color + '33',
                          border: `1px solid ${color}55`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <span style={{ fontFamily: t.fontMono, fontWeight: 600, fontSize: 12, color }}>{initials}</span>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.name}
                        </div>
                        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.04em' }}>
                          {c.aegisId}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {matchedMessages.length > 0 && (
              <div>
                <div style={{ padding: '10px 18px 6px', fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', borderTop: matchedContacts.length > 0 ? `1px solid ${t.border}` : 'none' }}>
                  MENSAJES
                </div>
                {matchedMessages.map((msg, i) => (
                  <button
                    key={i}
                    onClick={() => goToContact(msg.aegisId)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      padding: '10px 18px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = t.surface2}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    </svg>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                        <span style={{ fontFamily: t.font, fontWeight: 600, fontSize: 13, color: t.text }}>{msg.contactName}</span>
                        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{formatTime(msg.ts)}</span>
                      </div>
                      <div style={{ fontFamily: t.font, fontSize: 12, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {msg.text}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!query && (
          <div style={{ padding: '20px 18px', fontFamily: t.font, fontSize: 13, color: t.textMuted, textAlign: 'center' }}>
            Escribe para buscar entre contactos y mensajes
          </div>
        )}
      </div>
    </div>
  );
}
