import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { AegisMark, AegisWord } from './AegisMark';
import { Avatar } from './Avatar';
import { I } from './icons';
import { useContacts } from '../store/contacts';
import { useMessages } from '../store/messages';
import { useWork } from '../store/work';
import type { StoredContact, StoredMessage } from '../db/local';
import type { Tab } from './TabBar';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORK_ACCENT = '#6366f1';

const PERSONAL_NAV: { id: Tab; icon: keyof typeof I; label: string }[] = [
  { id: 'home',     icon: 'Chat',     label: 'Chats'    },
  { id: 'groups',   icon: 'Users',    label: 'Groups'   },
  { id: 'verify',   icon: 'Shield',   label: 'Verify'   },
  { id: 'settings', icon: 'Settings', label: 'Settings' },
];

const WORK_NAV: { id: Tab; icon: keyof typeof I; label: string }[] = [
  { id: 'dashboard', icon: 'Building', label: 'Workspace' },
  { id: 'verify',    icon: 'QR',       label: 'Verify'    },
  { id: 'settings',  icon: 'Settings', label: 'Settings'  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  activeSection: Tab;
  activeChatId: string | null;
  onNavigate: (tab: Tab) => void;
  onSelectChat: (contact: StoredContact) => void;
  onNewChat: () => void;
  isWork?: boolean;
  onOpenChannel?: (channelId: string) => void;
  onSwitchWorkspace?: (orgId: string) => void;
  onOpenDirectory?: () => void;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar({ activeSection, activeChatId, onNavigate, onSelectChat, onNewChat, isWork = false, onOpenChannel, onSwitchWorkspace, onOpenDirectory }: Props) {
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

  const accent = isWork ? WORK_ACCENT : t.accent;

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: t.surface,
        borderRight: `1px solid ${isWork ? `${WORK_ACCENT}44` : t.border}`,
        overflow: 'hidden',
      }}
    >
      {isWork ? (
        <WorkSidebarContent t={t} accent={accent} onNavigate={onNavigate} onOpenChannel={onOpenChannel} onSwitchWorkspace={onSwitchWorkspace} onOpenDirectory={onOpenDirectory} />
      ) : (
        <>
          <SidebarHeader t={t} onNewChat={onNewChat} />
          <SearchBar t={t} value={searchQuery} onChange={setSearchQuery} />
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
        </>
      )}

      <BottomNav t={t} active={activeSection} onNavigate={onNavigate} isWork={isWork} accent={accent} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Work sidebar content (channels list)
// ---------------------------------------------------------------------------

function WorkSidebarContent({ t, accent, onNavigate, onOpenChannel, onSwitchWorkspace, onOpenDirectory }: { t: Theme; accent: string; onNavigate: (tab: Tab) => void; onOpenChannel?: (channelId: string) => void; onSwitchWorkspace?: (orgId: string) => void; onOpenDirectory?: () => void }) {
  const org = useWork((s) => s.org);
  const channels = useWork((s) => s.channels);
  const knownOrgIds = useWork((s) => s.knownOrgIds);
  const activeOrgId = useWork((s) => s.activeOrgId);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const announcements = channels.filter((c) => c.isAnnouncements);
  const regular = channels.filter((c) => !c.isAnnouncements);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Org identity bar */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 16px 12px',
          borderBottom: `1px solid ${accent}33`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            backgroundColor: `${accent}22`,
            border: `1px solid ${accent}55`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <I.Shield size={17} color={accent} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: t.fontDisplay,
              fontSize: 13,
              fontWeight: 700,
              color: t.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {org?.name ?? 'Workspace'}
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 9, color: accent, letterSpacing: 1.2, marginTop: 1 }}>
            AEGISLINK WORK
          </div>
        </div>
        {/* Workspace picker trigger */}
        <button
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="Switch workspace"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: pickerOpen ? `${accent}22` : 'transparent',
            border: 'none',
            cursor: 'pointer',
            borderRadius: 6,
            padding: 4,
            flexShrink: 0,
            transition: 'background-color 0.1s',
          }}
        >
          <ChevronDownIcon size={14} color={accent} flipped={pickerOpen} />
        </button>
        {/* Workspace picker dropdown */}
        {pickerOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              backgroundColor: '#1a1f1e',
              border: `1px solid ${accent}44`,
              borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              zIndex: 100,
              overflow: 'hidden',
              marginTop: 2,
            }}
          >
            {knownOrgIds.map((id) => (
              <button
                key={id}
                onClick={() => {
                  setPickerOpen(false);
                  if (id !== activeOrgId) onSwitchWorkspace?.(id);
                }}
                aria-label={`Switch to workspace ${id.slice(0, 12)}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '9px 14px',
                  background: id === activeOrgId ? `${accent}18` : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: id === activeOrgId ? accent : '#a0a8a4',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {id.slice(0, 12)}
                </span>
                {id === activeOrgId && (
                  <CheckIcon size={13} color={accent} />
                )}
              </button>
            ))}
            <div style={{ height: 1, backgroundColor: `${accent}22`, margin: '2px 0' }} />
            <button
              onClick={() => { setPickerOpen(false); onNavigate('dashboard'); }}
              aria-label="Create new workspace"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '9px 14px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: accent }}>+ Crear nuevo workspace</span>
            </button>
            <button
              onClick={() => { setPickerOpen(false); onNavigate('dashboard'); }}
              aria-label="Join workspace with code"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '9px 14px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#a0a8a4' }}>Unirse con código</span>
            </button>
          </div>
        )}
      </div>

      {/* Channels list or empty state */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!org ? (
          <div style={{ padding: '32px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <I.Shield size={32} color={accent} style={{ opacity: 0.5 }} />
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: '19px' }}>
              Crea tu organización para tener canales de equipo.
            </span>
            <button
              onClick={() => onNavigate('dashboard')}
              style={{
                marginTop: 4,
                padding: '8px 18px',
                backgroundColor: accent,
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                fontFamily: t.font,
                fontSize: 13,
                fontWeight: 700,
                color: '#fff',
              }}
            >
              Crear organización
            </button>
          </div>
        ) : (
          <>
            {announcements.length > 0 && (
              <ChannelSection
                t={t}
                accent={accent}
                label="ANUNCIOS"
                channels={announcements}
                activeChannelId={activeChannelId}
                onSelect={(id) => { setActiveChannelId(id); onOpenChannel?.(id); }}
              />
            )}
            <ChannelSection
              t={t}
              accent={accent}
              label="CANALES"
              channels={regular}
              activeChannelId={activeChannelId}
              onSelect={(id) => { setActiveChannelId(id); onOpenChannel?.(id); }}
            />
            {channels.length === 0 && (
              <div style={{ padding: '16px', opacity: 0.5 }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.8 }}>
                  SIN CANALES
                </span>
              </div>
            )}
            {/* Directory link */}
            <DirectoryLink t={t} accent={accent} onOpenDirectory={onOpenDirectory} />
          </>
        )}
      </div>
    </div>
  );
}

function DirectoryLink({ t, accent, onOpenDirectory }: { t: Theme; accent: string; onOpenDirectory?: () => void }) {
  const [hovered, setHovered] = useState(false);
  if (!onOpenDirectory) return null;
  return (
    <div style={{ padding: '8px 12px 12px' }}>
      <button
        onClick={onOpenDirectory}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label="Ver directorio de miembros"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          padding: '8px 10px',
          backgroundColor: hovered ? `${accent}18` : `${accent}0c`,
          border: `1px solid ${accent}33`,
          borderRadius: 8,
          cursor: 'pointer',
          transition: 'background-color 0.1s',
        }}
      >
        <I.Users size={13} color={accent} />
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            letterSpacing: 0.5,
            color: accent,
            flex: 1,
            textAlign: 'left',
          }}
        >
          Ver directorio →
        </span>
      </button>
    </div>
  );
}

function ChannelSection({
  t, accent, label, channels, activeChannelId, onSelect,
}: {
  t: Theme;
  accent: string;
  label: string;
  channels: { channelId: string; name: string; isAnnouncements: boolean }[];
  activeChannelId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <div style={{ padding: '10px 16px 4px', fontFamily: t.fontMono, fontSize: 9, color: accent, letterSpacing: 1.2, opacity: 0.7 }}>
        {label}
      </div>
      {channels.map((ch) => (
        <ChannelItem key={ch.channelId} t={t} accent={accent} channel={ch} active={activeChannelId === ch.channelId} onPress={() => onSelect(ch.channelId)} />
      ))}
    </div>
  );
}

function ChannelItem({
  t, accent, channel, active, onPress,
}: {
  t: Theme;
  accent: string;
  channel: { channelId: string; name: string; isAnnouncements: boolean };
  active: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 16px',
        background: active ? `${accent}22` : hovered ? `${accent}11` : 'transparent',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background-color 0.1s',
      }}
    >
      <span style={{ fontFamily: t.fontMono, fontSize: 14, color: active ? accent : t.textFaint, fontWeight: 600, lineHeight: 1 }}>
        {channel.isAnnouncements ? '📢' : '#'}
      </span>
      <span
        style={{
          fontFamily: t.font,
          fontSize: 13,
          color: active ? t.text : t.textDim,
          fontWeight: active ? 600 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {channel.name}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Personal header
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
  accent: string;
  onNavigate: (tab: Tab) => void;
}

function NavItem({ t, id, icon, label, active, accent, onNavigate }: NavItemProps) {
  const [hovered, setHovered] = useState(false);
  const Icon = I[icon];
  const color = active ? accent : hovered ? t.textDim : t.textFaint;

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
          backgroundColor: active ? `${accent}18` : hovered ? t.surface2 : 'transparent',
          border: 'none',
          cursor: 'pointer',
          transition: 'background-color 0.1s',
        }}
      >
        <Icon size={20} stroke={active ? 2.2 : 1.8} color={color} />
      </button>
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

function BottomNav({ t, active, onNavigate, isWork = false, accent }: { t: Theme; active: Tab; onNavigate: (tab: Tab) => void; isWork?: boolean; accent: string }) {
  const items = isWork ? WORK_NAV : PERSONAL_NAV;
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
        borderTop: isWork ? `2px solid ${accent}44` : `1px solid ${t.border}`,
        flexShrink: 0,
        backgroundColor: isWork ? `${accent}08` : t.surface,
      }}
    >
      {items.map((item) => (
        <NavItem
          key={item.id}
          t={t}
          id={item.id}
          icon={item.icon}
          label={item.label}
          active={active === item.id}
          accent={accent}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline edit icon (pencil) — not in I.*
// ---------------------------------------------------------------------------

function ChevronDownIcon({ size = 14, color, flipped = false }: { size?: number; color: string; flipped?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: flipped ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon({ size = 13, color }: { size?: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

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
