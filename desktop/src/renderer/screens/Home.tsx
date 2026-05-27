import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { AegisMark, AegisWord } from '../components/AegisMark';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import type { Tab } from '../components/TabBar';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { useMessages } from '../store/messages';
import type { StoredContact, StoredMessage } from '../db/local';

interface Props {
  onOpenChat: (contact: StoredContact) => void;
  onAddContact: () => void;
  onSearch: () => void;
  onProfile: () => void;
  onContacts: () => void;
  onTab: (tab: Tab) => void;
}

export function HomeScreen({ onOpenChat, onAddContact, onSearch, onProfile, onContacts, onTab }: Props) {
  const { t } = useTheme();

  const identity = useIdentity((s) => s.identity);
  const storeDisplayName = useIdentity((s) => s.displayName);
  const contacts = useContacts((s) => s.contacts);
  const previews = useMessages((s) => s.previews);
  const unreadCounts = useMessages((s) => s.unreadCounts);

  const displayName = identity?.aegisId ?? storeDisplayName ?? '— — —';
  const identityDisplay = { aegisId: identity?.aegisId ?? '— — —' };

  const [showArchived, setShowArchived] = useState(false);

  const allSorted = useMemo(() => {
    return [...contacts].sort((a, b) => {
      const aTs = previews[a.aegisId]?.createdAt ?? a.addedAt;
      const bTs = previews[b.aegisId]?.createdAt ?? b.addedAt;
      return bTs - aTs;
    });
  }, [contacts, previews]);

  const sorted = allSorted.filter((c) => !c.archived);
  const archived = allSorted.filter((c) => c.archived);
  const displayed = showArchived ? archived : sorted;
  const empty = sorted.length === 0 && !showArchived;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 18,
          paddingRight: 18,
          paddingTop: 14,
          paddingBottom: 12,
          minHeight: 52,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onProfile}
          aria-label="Open profile"
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <AegisMark t={t} size={26} />
          <AegisWord t={t} size={24} />
        </button>

        <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
          <button onClick={onSearch} aria-label="Search" style={iconBtnStyle}>
            <I.Search size={20} color={t.textDim} />
          </button>
          <button onClick={onContacts} aria-label="Contacts" style={iconBtnStyle}>
            <I.Person size={20} color={t.textDim} />
          </button>
          <button onClick={onAddContact} aria-label="Add contact" style={iconBtnStyle}>
            <I.Plus size={22} color={t.accent} />
          </button>
        </div>
      </div>

      {/* Identity / status banner */}
      {empty ? (
        <IdentityBanner t={t} identity={identityDisplay} displayName={displayName} onPress={onProfile} />
      ) : (
        <StatusBar t={t} identity={identityDisplay} displayName={displayName} />
      )}

      {/* Archived back button */}
      {showArchived && (
        <button
          onClick={() => setShowArchived(false)}
          style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 18, paddingRight: 18, paddingTop: 10, paddingBottom: 10, background: 'none', border: 'none', cursor: 'pointer' }}
          aria-label="Back to chats"
        >
          <I.ChevronL size={16} color={t.accent} />
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5 }}>
            ARCHIVED ({archived.length})
          </span>
        </button>
      )}

      {/* Main content */}
      {empty && !showArchived ? (
        <EmptyHero t={t} onAdd={onAddContact} />
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {displayed.map((contact, idx) => (
            <div key={contact.aegisId}>
              <ContactRow
                t={t}
                contact={contact}
                preview={previews[contact.aegisId]}
                unread={unreadCounts[contact.aegisId] ?? 0}
                onPress={() => onOpenChat(contact)}
              />
              {idx < displayed.length - 1 && (
                <div style={{ height: 1, backgroundColor: t.divider, marginLeft: 72 }} />
              )}
            </div>
          ))}

          {/* Archived footer */}
          {!showArchived && archived.length > 0 && (
            <button
              onClick={() => setShowArchived(true)}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                paddingLeft: 18,
                paddingRight: 18,
                paddingTop: 14,
                paddingBottom: 14,
                borderTop: `1px solid ${t.divider}`,
                width: '100%',
                background: 'none',
                border: 'none',
                borderTopWidth: 1,
                borderTopStyle: 'solid',
                borderTopColor: t.divider,
                cursor: 'pointer',
                boxSizing: 'border-box',
              }}
              aria-label="Show archived"
            >
              <div style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <I.Archive size={20} color={t.textDim} />
              </div>
              <div style={{ flex: 1, textAlign: 'left' }}>
                <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '500', color: t.text, display: 'block' }}>Archived</span>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, marginTop: 2, display: 'block' }}>
                  {archived.length} {archived.length === 1 ? 'conversation' : 'conversations'}
                </span>
              </div>
              <I.Chevron size={14} color={t.textFaint} />
            </button>
          )}
        </div>
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const iconBtnStyle: CSSProperties = {
  padding: 8,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

function IdentityBanner({ t, identity, displayName: _displayName, onPress }: { t: Theme; identity: { aegisId: string }; displayName: string; onPress: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="View profile"
      style={{
        margin: '4px 18px 14px',
        padding: 14,
        border: `1px solid ${t.accent}33`,
        backgroundColor: hovered
          ? t.dark ? 'rgba(91,242,185,0.10)' : 'rgba(13,143,95,0.10)'
          : t.dark ? 'rgba(91,242,185,0.06)' : 'rgba(13,143,95,0.06)',
        borderRadius: t.radius,
        display: 'flex',
        flexDirection: 'row',
        gap: 12,
        alignItems: 'flex-start',
        cursor: 'pointer',
        transition: 'background-color 0.1s',
        boxSizing: 'border-box',
        width: 'calc(100% - 36px)',
        opacity: hovered ? 0.85 : 1,
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: t.radiusS,
          backgroundColor: `${t.accent}22`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <I.Check size={16} color={t.accent} />
      </div>
      <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
        <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 13, color: t.text, display: 'block' }}>
          Identity created
        </span>
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: 11,
            color: t.accent,
            letterSpacing: 0.5,
            marginTop: 2,
            display: 'block',
          }}
        >
          {identity.aegisId}
        </span>
      </div>
      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5, flexShrink: 0 }}>
        VIEW
      </span>
    </button>
  );
}

function StatusBar({ t, identity, displayName: _displayName }: { t: Theme; identity: { aegisId: string }; displayName: string }) {
  return (
    <div
      style={{
        margin: '4px 18px 8px',
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 14,
        paddingRight: 14,
        backgroundColor: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: t.radius,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <I.Lock size={12} color={t.accent} />
      <span
        style={{
          flex: 1,
          fontFamily: t.fontMono,
          fontSize: 11,
          color: t.textDim,
          letterSpacing: 0.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {`${identity.aegisId} · End-to-end encrypted`}
      </span>
    </div>
  );
}

function EmptyHero({ t, onAdd }: { t: Theme; onAdd: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingLeft: 32, paddingRight: 32 }}>
      {/* Pulse rings */}
      <div style={{ width: 140, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        <style>{`
          @keyframes aegis-ring-pulse {
            0%   { transform: scale(0.5); opacity: 0.6; }
            100% { transform: scale(1.3); opacity: 0; }
          }
        `}</style>
        {[0, 400, 800].map((delay) => (
          <div
            key={delay}
            style={{
              position: 'absolute',
              width: 140,
              height: 140,
              borderRadius: '50%',
              border: `1px solid ${t.accent}`,
              animation: `aegis-ring-pulse 2.4s ease-out ${delay}ms infinite`,
            }}
          />
        ))}
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            backgroundColor: t.surface,
            border: `1px solid ${t.borderStrong}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <AegisMark t={t} size={36} mono />
        </div>
      </div>

      <h2
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 24,
          fontWeight: '600',
          letterSpacing: -0.4,
          color: t.text,
          textAlign: 'center',
          marginTop: 26,
          marginBottom: 12,
          maxWidth: 280,
        }}
      >
        No conversations yet
      </h2>

      <p style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: '21px', textAlign: 'center', maxWidth: 300, marginBottom: 24, marginTop: 0 }}>
        Add your first contact via QR code, link, or AegisLink ID to start chatting privately.
      </p>

      <button
        onClick={onAdd}
        aria-label="Add first contact"
        style={{
          backgroundColor: t.accent,
          paddingLeft: 24,
          paddingRight: 24,
          paddingTop: 13,
          paddingBottom: 13,
          borderRadius: t.radius,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          border: 'none',
        }}
      >
        <I.Plus size={18} color={t.accentInk} />
        <span style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>
          Add first contact
        </span>
      </button>

      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.8, marginTop: 22 }}>
        QR · LINK · ID
      </span>
    </div>
  );
}

function ContactRow({
  t,
  contact,
  preview,
  unread,
  onPress,
}: {
  t: Theme;
  contact: StoredContact;
  preview: StoredMessage | undefined;
  unread: number;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  let previewText: string;
  if (preview) {
    if (preview.direction === 'out') {
      previewText = `You: ${preview.body || (preview.type === 'image' ? '📷 Image' : preview.type === 'audio' ? '🎙 Audio' : preview.type === 'file' ? '📎 File' : '...')}`;
    } else {
      previewText = preview.body || (preview.type === 'image' ? '📷 Image' : preview.type === 'audio' ? '🎙 Audio' : preview.type === 'file' ? '📎 File' : '...');
    }
  } else {
    previewText = 'No messages yet';
  }

  const time = preview ? new Date(preview.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const bold = unread > 0;
  const isMuted = contact.muted ?? false;
  const hasEphemeral = preview?.expiresAt != null && preview.expiresAt > Date.now();

  const isAegisId = /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name);

  return (
    <button
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`Open chat with ${contact.name}`}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 18,
        paddingRight: 18,
        paddingTop: 12,
        paddingBottom: 12,
        gap: 12,
        backgroundColor: hovered ? t.surface2 : t.bg,
        transition: 'background-color 0.1s',
        cursor: 'pointer',
        width: '100%',
        border: 'none',
        boxSizing: 'border-box',
        textAlign: 'left',
      }}
    >
      <Avatar t={t} name={contact.avatarImage ?? contact.name} color={contact.color ?? t.surface2} size={44} photoUri={contact.avatarImage} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontFamily: isAegisId ? t.fontMono : t.font,
              fontSize: 15,
              fontWeight: bold ? '700' : '600',
              color: t.text,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {contact.name}
          </span>
          {contact.verified && <I.Check size={12} color={t.accent} />}
          {isMuted && <I.BellOff size={13} color={t.textFaint} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span
            style={{
              fontFamily: t.font,
              fontSize: 13,
              color: bold ? t.text : t.textDim,
              fontWeight: bold ? '500' : 'normal',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {previewText}
          </span>
          {hasEphemeral && (
            <div style={{ backgroundColor: `${t.accent}22`, borderRadius: 4, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent }}>⏱ ephemeral</span>
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: bold ? t.accent : t.textFaint }}>{time}</span>
        {unread > 0 && (
          <div
            style={{
              minWidth: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: t.accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingLeft: 4,
              paddingRight: 4,
            }}
          >
            <span style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '700', color: t.accentInk }}>
              {unread > 99 ? '99+' : String(unread)}
            </span>
          </div>
        )}
      </div>
    </button>
  );
}
