import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { AegisMark, AegisWord } from './AegisMark';
import { Avatar } from './Avatar';
import { I } from './icons';
import { useContacts } from '../store/contacts';
import { useMessages } from '../store/messages';
import type { StoredContact, StoredMessage } from '../db/local';
import type { Tab } from './TabBar';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  activeSection: Tab;
  activeChatId: string | null;
  onNavigate: (tab: Tab) => void;
  onSelectChat: (contact: StoredContact) => void;
  onNewChat: () => void;
}

const NAV_ITEMS: { id: Tab; icon: keyof typeof I; label: string }[] = [
  { id: 'home',     icon: 'Chat',    label: 'Chats'   },
  { id: 'groups',   icon: 'Users',   label: 'Groups'  },
  { id: 'verify',   icon: 'Shield',  label: 'Verify'  },
  { id: 'settings', icon: 'Settings', label: 'Settings' },
];

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar({ activeSection, activeChatId, onNavigate, onSelectChat, onNewChat }: Props) {
  const { t } = useTheme();
  const [searchQuery, setSearchQuery] = useState('');

  const contacts = useContacts((s) => s.contacts);
  const previews = useMessages((s) => s.previews);
  const unreadCounts = useMessages((s) => s.unreadCounts);

  const sorted = useMemo(() => {
    return [...contacts]
      .filter((c) => !c.archived)
      .sort((a, b) => {
        const aTs = previews[a.aegisId]?.createdAt ?? a.addedAt;
        const bTs = previews[b.aegisId]?.createdAt ?? b.addedAt;
        return bTs - aTs;
      });
  }, [contacts, previews]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => c.name.toLowerCase().includes(q) || c.aegisId.toLowerCase().includes(q));
  }, [sorted, searchQuery]);

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: t.surface,
        borderRight: `1px solid ${t.border}`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <SidebarHeader t={t} onNewChat={onNewChat} />

      {/* Search */}
      <SearchBar t={t} value={searchQuery} onChange={setSearchQuery} />

      {/* Chat list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <EmptyList t={t} hasQuery={searchQuery.trim().length > 0} />
        ) : (
          filtered.map((contact) => (
            <ChatItem
              key={contact.aegisId}
              t={t}
              contact={contact}
              preview={previews[contact.aegisId]}
              unread={unreadCounts[contact.aegisId] ?? 0}
              active={activeChatId === contact.aegisId}
              onPress={() => onSelectChat(contact)}
            />
          ))
        )}
      </div>

      {/* Bottom nav */}
      <BottomNav t={t} active={activeSection} onNavigate={onNavigate} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function SidebarHeader({ t, onNewChat }: { t: Theme; onNewChat: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 16,
        paddingRight: 12,
        paddingTop: 14,
        paddingBottom: 12,
        flexShrink: 0,
        gap: 8,
      }}
    >
      <AegisMark t={t} size={24} />
      <AegisWord t={t} size={17} />
      <div style={{ flex: 1 }} />
      <button
        onClick={onNewChat}
        aria-label="New chat"
        style={iconBtnStyle}
      >
        <EditIcon size={18} color={t.textDim} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function SearchBar({ t, value, onChange }: { t: Theme; value: string; onChange: (v: string) => void }) {
  return (
    <div
      style={{
        paddingLeft: 12,
        paddingRight: 12,
        paddingBottom: 10,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: t.surface2,
          borderRadius: 20,
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <I.Search size={14} color={t.textFaint} />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search"
          aria-label="Search chats"
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
        {value.length > 0 && (
          <button
            onClick={() => onChange('')}
            aria-label="Clear search"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
          >
            <I.X size={13} color={t.textFaint} />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat item
// ---------------------------------------------------------------------------

function ChatItem({
  t,
  contact,
  preview,
  unread,
  active,
  onPress,
}: {
  t: Theme;
  contact: StoredContact;
  preview: StoredMessage | undefined;
  unread: number;
  active: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  let previewText: string;
  if (preview) {
    if (preview.direction === 'out') {
      previewText = `You: ${preview.body || (preview.type === 'image' ? 'Image' : preview.type === 'audio' ? 'Audio' : '...')}`;
    } else {
      previewText = preview.body || (preview.type === 'image' ? 'Image' : preview.type === 'audio' ? 'Audio' : '...');
    }
  } else {
    previewText = 'No messages yet';
  }

  const time = preview
    ? new Date(preview.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const bold = unread > 0;
  const isAegisId = /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name);

  const bg = active ? t.surface2 : hovered ? t.surface2 : 'transparent';

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
        width: '100%',
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 10,
        paddingBottom: 10,
        gap: 10,
        backgroundColor: bg,
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        boxSizing: 'border-box',
        transition: 'background-color 0.1s',
      }}
    >
      <Avatar
        t={t}
        name={contact.name}
        color={contact.color ?? t.surface3}
        size={40}
        photoUri={contact.avatarImage ?? undefined}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              flex: 1,
              fontFamily: isAegisId ? t.fontMono : t.font,
              fontSize: 13,
              fontWeight: bold ? '700' : '600',
              color: t.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {contact.name}
          </span>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: bold ? t.accent : t.textFaint, flexShrink: 0 }}>
            {time}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 4 }}>
          <span
            style={{
              flex: 1,
              fontFamily: t.font,
              fontSize: 12,
              color: bold ? t.text : t.textDim,
              fontWeight: bold ? '500' : 'normal',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {previewText}
          </span>
          {unread > 0 && (
            <div
              style={{
                minWidth: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: t.accent,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                paddingLeft: 4,
                paddingRight: 4,
                flexShrink: 0,
              }}
            >
              <span style={{ fontFamily: t.fontMono, fontSize: 10, fontWeight: '700', color: t.accentInk }}>
                {unread > 99 ? '99+' : String(unread)}
              </span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Empty list state
// ---------------------------------------------------------------------------

function EmptyList({ t, hasQuery }: { t: Theme; hasQuery: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
        gap: 8,
      }}
    >
      <I.Chat size={28} color={t.textFaint} />
      <span
        style={{
          fontFamily: t.font,
          fontSize: 13,
          color: t.textFaint,
          textAlign: 'center',
          lineHeight: '18px',
        }}
      >
        {hasQuery ? 'No chats match your search' : 'No conversations yet'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom nav
// ---------------------------------------------------------------------------

interface NavItemProps {
  t: Theme;
  id: Tab;
  icon: keyof typeof I;
  label: string;
  active: boolean;
  onNavigate: (tab: Tab) => void;
}

function NavItem({ t, id, icon, label, active, onNavigate }: NavItemProps) {
  const [hovered, setHovered] = useState(false);
  const Icon = I[icon];
  const color = active ? t.accent : hovered ? t.textDim : t.textFaint;

  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={() => onNavigate(id)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          borderRadius: 10,
          backgroundColor: active ? `${t.accent}18` : hovered ? t.surface2 : 'transparent',
          border: 'none',
          cursor: 'pointer',
          transition: 'background-color 0.1s',
        }}
      >
        <Icon size={20} stroke={active ? 2.2 : 1.8} color={color} />
      </button>
      {/* Tooltip */}
      {hovered && (
        <div
          style={{
            position: 'absolute',
            bottom: 46,
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: t.surface3,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusS,
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 4,
            paddingBottom: 4,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.text, letterSpacing: 0.5 }}>
            {label}
          </span>
        </div>
      )}
    </div>
  );
}

function BottomNav({ t, active, onNavigate }: { t: Theme; active: Tab; onNavigate: (tab: Tab) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 10,
        paddingBottom: 14,
        borderTop: `1px solid ${t.border}`,
        flexShrink: 0,
      }}
    >
      {NAV_ITEMS.map((item) => (
        <NavItem
          key={item.id}
          t={t}
          id={item.id}
          icon={item.icon}
          label={item.label}
          active={active === item.id}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline edit icon (pencil) — not in I.*
// ---------------------------------------------------------------------------

function EditIcon({ size = 18, color }: { size?: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const iconBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 6,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 8,
};
