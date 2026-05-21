import React, { useState, useEffect } from 'react';
import { useStore } from '../store/index.js';

const NAV_ITEMS = [
  { label: 'Overview',   icon: BuildingIcon },
  { label: 'Contacts',   icon: UsersIcon },
  { label: 'Keys',       icon: KeyIcon },
  { label: 'Audit log',  icon: BellIcon },
  { label: 'Policy',     icon: ShieldIcon },
];

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function WorkDashboard({ t }) {
  const [activeNav, setActiveNav] = useState('Overview');
  const now = useClock();

  const identity      = useStore((s) => s.identity);
  const contacts      = useStore((s) => s.contacts);
  const conversations = useStore((s) => s.conversations);
  const connected     = useStore((s) => s.connected);
  const auditLog      = useStore((s) => s.auditLog);
  const workDisplayName = useStore((s) => s.workDisplayName);

  // ── Derived stats ──────────────────────────────────────────────────────────
  const totalContacts  = contacts.length;
  const verifiedCount  = contacts.filter((c) => c.verified).length;
  const totalMessages  = Object.values(conversations).reduce((acc, c) => acc + (c.unread ?? 0), 0);
  const orgName        = workDisplayName || identity?.aegisId || '—';
  const timeStr        = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tzStr          = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '220px 1fr',
        height: '100%',
        background: t.bg,
        color: t.text,
        fontFamily: t.font,
        overflow: 'hidden',
      }}
    >
      {/* ── Sidebar ── */}
      <aside
        style={{
          background: t.surface,
          borderRight: `1px solid ${t.border}`,
          padding: '20px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          overflow: 'hidden',
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '2px 4px 18px',
            borderBottom: `1px solid ${t.border}`,
            marginBottom: 12,
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L21 6V12C21 17 17.5 21 12 22C6.5 21 3 17 3 12V6L12 2Z"
              stroke={t.accent} strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M9 12l2 2 4-4" stroke={t.accent} strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <div style={{ fontFamily: t.fontDisplay, fontWeight: t.displayWeight, fontSize: 14, color: t.text }}>
              AegisLink
            </div>
            <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: '0.1em', marginTop: 2 }}>
              WORK · ADMIN
            </div>
          </div>
        </div>

        {/* Nav items */}
        {NAV_ITEMS.map(({ label, icon: Icon }) => {
          const isActive = activeNav === label;
          return (
            <div
              key={label}
              onClick={() => setActiveNav(label)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '7px 10px',
                borderRadius: t.radiusS,
                color: isActive ? t.text : t.textDim,
                background: isActive ? t.surface2 : 'transparent',
                fontFamily: t.font,
                fontSize: 13,
                fontWeight: isActive ? 600 : 400,
                cursor: 'pointer',
                transition: 'background 0.1s',
              }}
            >
              <Icon size={15} color={isActive ? t.accent : t.textDim} />
              <span>{label}</span>
            </div>
          );
        })}

        <div style={{ flex: 1 }} />

        {/* Relay status — real data */}
        <div
          style={{
            padding: 12,
            border: `1px solid ${connected ? t.accent + '44' : t.border}`,
            borderRadius: t.radiusS,
            background: t.surface2,
          }}
        >
          <div style={{
            fontFamily: t.fontMono, fontSize: 9,
            color: connected ? t.accent : t.textDim,
            letterSpacing: '0.1em', marginBottom: 5,
          }}>
            {connected ? '● CONNECTED' : '○ OFFLINE'}
          </div>
          <div style={{ fontFamily: t.font, fontSize: 12, color: t.text, lineHeight: 1.4 }}>
            {connected ? 'Relay active' : 'No relay connection'}
            <br />
            <span style={{ color: t.textDim }}>
              {identity?.aegisId
                ? identity.aegisId.slice(0, 11) + '…'
                : '—'}
            </span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={{ padding: '24px 32px', overflow: 'auto' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 24,
            paddingBottom: 18,
            borderBottom: `1px solid ${t.divider ?? t.border}`,
          }}
        >
          <div>
            <div style={{
              fontFamily: t.fontMono, fontSize: 10,
              color: t.textDim, letterSpacing: '0.1em', marginBottom: 5,
            }}>
              IDENTITY · {orgName}
            </div>
            <div style={{
              fontFamily: t.fontDisplay,
              fontSize: 32,
              fontWeight: t.displayWeight,
              letterSpacing: '-0.02em',
              lineHeight: 1,
            }}>
              {activeNav}
            </div>
          </div>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: '0.04em' }}>
            {timeStr} · {tzStr}
          </span>
        </div>

        {/* ── Overview tab ── */}
        {activeNav === 'Overview' && (
          <>
            {/* KPI cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
              {[
                { l: 'CONTACTS',        v: String(totalContacts), d: totalContacts === 0 ? 'No contacts yet' : `${verifiedCount} verified` },
                { l: 'UNREAD',          v: String(totalMessages), d: 'pending messages' },
                { l: 'RELAY',           v: connected ? 'UP' : 'DOWN', d: connected ? 'E2EE active' : 'Reconnecting…', accent: connected },
                { l: 'METADATA STORED', v: '0 B', d: 'by design', accent: true },
              ].map((k) => (
                <div
                  key={k.l}
                  style={{
                    padding: 18,
                    border: `1px solid ${t.border}`,
                    borderRadius: t.radius,
                    background: t.surface,
                  }}
                >
                  <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.1em', marginBottom: 12 }}>
                    {k.l}
                  </div>
                  <div style={{
                    fontFamily: t.fontDisplay,
                    fontSize: 38,
                    fontWeight: t.displayWeight,
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                    color: k.accent ? t.accent : t.text,
                  }}>
                    {k.v}
                  </div>
                  <div style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 6 }}>
                    {k.d}
                  </div>
                </div>
              ))}
            </div>

            {/* Two-column */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16 }}>
              <ContactsTable contacts={contacts} conversations={conversations} t={t} />
              <AuditPanel auditLog={auditLog} t={t} />
            </div>
          </>
        )}

        {/* ── Contacts tab ── */}
        {activeNav === 'Contacts' && (
          <ContactsTable contacts={contacts} conversations={conversations} t={t} full />
        )}

        {/* ── Audit log tab ── */}
        {activeNav === 'Audit log' && (
          <AuditPanel auditLog={auditLog} t={t} full />
        )}

        {/* ── Keys tab ── */}
        {activeNav === 'Keys' && (
          <KeysPanel identity={identity} t={t} />
        )}

        {/* ── Policy tab ── */}
        {activeNav === 'Policy' && (
          <PolicyPanel t={t} />
        )}
      </main>
    </div>
  );
}

// ── Sub-panels ─────────────────────────────────────────────────────────────────

function ContactsTable({ contacts, conversations, t, full }) {
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: t.radius, background: t.surface, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${t.border}` }}>
        <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14 }}>Contacts</div>
        <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.06em' }}>
          {contacts.length} TOTAL
        </span>
      </div>
      {contacts.length === 0 ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', fontFamily: t.font, fontSize: 13, color: t.textDim }}>
          No contacts yet. Add someone by their AegisID.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr', padding: '8px 16px', borderBottom: `1px solid ${t.border}`, fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.08em' }}>
            <span>NAME</span><span>AEGIS ID</span><span>VERIFIED</span>
          </div>
          {(full ? contacts : contacts.slice(0, 6)).map((c, i) => (
            <div
              key={c.aegisId}
              style={{
                display: 'grid',
                gridTemplateColumns: '2fr 2fr 1fr',
                padding: '11px 16px',
                alignItems: 'center',
                borderBottom: i < contacts.length - 1 ? `1px solid ${t.border}` : 'none',
                fontFamily: t.font,
                fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.name}
              </span>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.aegisId}
              </span>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: c.verified ? t.accent : t.textDim }}>
                {c.verified ? '✓' : '—'}
              </span>
            </div>
          ))}
          {!full && contacts.length > 6 && (
            <div style={{ padding: '10px 16px', fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: '0.04em' }}>
              +{contacts.length - 6} more · open Contacts tab
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AuditPanel({ auditLog, t, full }) {
  const entries = full ? auditLog : auditLog.slice(0, 6);
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: t.radius, background: t.surface, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${t.border}` }}>
        <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14 }}>Audit log</div>
        <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.06em' }}>LIVE</span>
      </div>
      {entries.length === 0 ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', fontFamily: t.font, fontSize: 13, color: t.textDim }}>
          No events yet.
        </div>
      ) : (
        entries.map((it, i) => {
          const dotColor = it.sev === 'warn' ? t.warn : it.sev === 'ok' ? t.accent : t.textDim;
          const timeStr = new Date(it.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 10,
                padding: '10px 16px',
                borderBottom: i < entries.length - 1 ? `1px solid ${t.border}` : 'none',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, marginTop: 6, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.06em', marginBottom: 2 }}>
                  {timeStr}
                </div>
                <div style={{ fontFamily: t.font, fontSize: 12, color: t.text, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.msg}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function KeysPanel({ identity, t }) {
  const hex = identity?.publicKeyB64 ? b64ToHex(identity.publicKeyB64) : '';
  const blocks = hex ? Array.from({ length: 8 }, (_, i) => hex.slice(i * 4, i * 4 + 4).toUpperCase() || '????') : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ border: `1px solid ${t.border}`, borderRadius: t.radius, background: t.surface, padding: '18px 20px' }}>
        <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.1em', marginBottom: 14 }}>IDENTITY KEY FINGERPRINT</div>
        {blocks.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
            {blocks.map((b, i) => (
              <div key={i} style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: t.radiusS, padding: '6px 0', textAlign: 'center', fontFamily: t.fontMono, fontSize: 12, color: t.accent, letterSpacing: '0.08em' }}>
                {b}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>No identity loaded.</div>
        )}
      </div>
      <div style={{ border: `1px solid ${t.border}`, borderRadius: t.radius, background: t.surface, padding: '18px 20px' }}>
        <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.1em', marginBottom: 10 }}>AegisID</div>
        <div style={{ fontFamily: t.fontMono, fontSize: 16, color: t.accent, letterSpacing: '0.06em' }}>
          {identity?.aegisId ?? '—'}
        </div>
      </div>
    </div>
  );
}

function PolicyPanel({ t }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {[
        { label: 'Zero metadata', desc: 'No IP addresses, timestamps, or message sizes are logged anywhere on the relay.' },
        { label: 'Keys on device', desc: 'Private keys never leave this device. The relay only sees encrypted envelopes.' },
        { label: 'Anonymous by default', desc: 'No email, phone number, or real name required at any point.' },
        { label: 'Open cryptography', desc: 'TweetNaCl + Double Ratchet. All crypto is auditable and open source.' },
      ].map((p) => (
        <div key={p.label} style={{ border: `1px solid ${t.border}`, borderRadius: t.radiusS, background: t.surface, padding: '14px 18px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <ShieldIcon size={16} color={t.accent} style={{ marginTop: 2, flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 13, color: t.text, marginBottom: 4 }}>{p.label}</div>
            <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 1.5 }}>{p.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function b64ToHex(b64) {
  try {
    const bin = atob(b64);
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return hex;
  } catch { return ''; }
}

// ── Icons ──────────────────────────────────────────────────────────────────────

function BuildingIcon({ size = 15, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18M3 7l9-4 9 4M4 7v14M20 7v14M9 21v-4a3 3 0 016 0v4" />
    </svg>
  );
}
function UsersIcon({ size = 15, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8" />
    </svg>
  );
}
function ShieldIcon({ size = 15, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6l9-4z" />
    </svg>
  );
}
function KeyIcon({ size = 15, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="14" r="4" />
      <path d="M11 13l9-9M17 7l3 3M14 10l3 3" />
    </svg>
  );
}
function BellIcon({ size = 15, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}
