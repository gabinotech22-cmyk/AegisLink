import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';

// ---------------------------------------------------------------------------
// Stub types
// ---------------------------------------------------------------------------

interface StoredContact {
  aegisId: string;
  name: string;
  publicKeyB64: string;
  color?: string;
  avatarImage?: string | null;
  verified: boolean;
  addedAt: number;
}

interface StoredGroup {
  id: string;
  name: string;
  members: string[];
  avatarColor?: string;
  avatarImage?: string;
  createdAt: number;
}

interface StoredMessage {
  id: string;
  body: string;
  direction: 'in' | 'out';
  type: 'text' | 'image' | 'audio' | 'file';
  createdAt: number;
}

type Filter = 'all' | 'messages' | 'files' | 'people' | 'groups';

type Result =
  | { type: 'message'; chatId: string; chatName: string; chatColor?: string; chatAvatar?: string | null; text: string; time: string; ts: number }
  | { type: 'file'; chatId: string; chatName: string; name: string; size: string; from: string; time: string; ts: number }
  | { type: 'person'; contact: StoredContact }
  | { type: 'group'; group: StoredGroup };

interface Props {
  onBack: () => void;
  onOpenChat?: (contact: StoredContact) => void;
  onOpenContact?: (contact: StoredContact) => void;
  onOpenGroupChat?: (group: StoredGroup) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

const FILE_PREFIXES = ['attachment ·', '📎', '📁', '📄', '🗂'];
function isFileMessage(body: string): boolean {
  return FILE_PREFIXES.some((p) => body.startsWith(p));
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'files', label: 'Files' },
  { id: 'people', label: 'People' },
  { id: 'groups', label: 'Groups' },
];

export function SearchScreen({ onBack, onOpenChat, onOpenContact, onOpenGroupChat }: Props) {
  const { t } = useTheme();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  // Stub data
  const contacts: StoredContact[] = [];
  const groups: StoredGroup[] = [];
  const byChat: Record<string, StoredMessage[]> = {};

  const contactById = useMemo(() => {
    const m = new Map<string, StoredContact>();
    for (const c of contacts) m.set(c.aegisId, c);
    return m;
  }, [contacts]);

  const results: Result[] = useMemo(() => {
    const query = q.trim().toLowerCase();
    const out: Result[] = [];
    const queryActive = query.length > 0;

    for (const c of contacts) {
      if (!queryActive || c.name.toLowerCase().includes(query) || c.aegisId.toLowerCase().includes(query)) {
        out.push({ type: 'person', contact: c });
      }
    }
    for (const g of groups) {
      if (!queryActive || g.name.toLowerCase().includes(query)) {
        out.push({ type: 'group', group: g });
      }
    }
    if (queryActive) {
      for (const [chatId, list] of Object.entries(byChat)) {
        const c = contactById.get(chatId);
        const g = groups.find((x) => x.id === chatId);
        const chatName = c?.name ?? g?.name ?? chatId;
        const chatColor = c?.color ?? g?.avatarColor;
        const chatAvatar = c?.avatarImage ?? g?.avatarImage ?? null;
        for (const m of list) {
          if (!m.body.toLowerCase().includes(query)) continue;
          if (isFileMessage(m.body)) {
            const fname = m.body.replace(/^attachment · /i, '').split(' ')[0];
            out.push({ type: 'file', chatId, chatName, name: fname || 'file', size: '—', from: m.direction === 'out' ? 'You' : chatName, time: formatTime(m.createdAt), ts: m.createdAt });
          } else {
            out.push({ type: 'message', chatId, chatName, chatColor, chatAvatar, text: m.body, time: formatTime(m.createdAt), ts: m.createdAt });
          }
        }
      }
    }
    return out.filter((r) => {
      if (filter === 'all') return true;
      if (filter === 'messages') return r.type === 'message';
      if (filter === 'files') return r.type === 'file';
      if (filter === 'people') return r.type === 'person';
      if (filter === 'groups') return r.type === 'group';
      return true;
    });
  }, [q, filter, contacts, groups, byChat, contactById]);

  const hasResults = results.length > 0;
  const hasQuery = q.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      {/* Search bar */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 12 }}>
        <button onClick={onBack} aria-label="Back" style={iconBtn}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, backgroundColor: t.surface2, borderRadius: 99 }}>
          <I.Search size={16} color={t.textDim} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search messages, people, files…"
            autoFocus
            style={{ flex: 1, color: t.text, fontFamily: t.font, fontSize: 14, background: 'none', border: 'none', outline: 'none', padding: 0 }}
          />
          {q.length > 0 && (
            <button onClick={() => setQ('')} aria-label="Clear search" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}>
              <I.X size={14} color={t.textDim} />
            </button>
          )}
        </div>
      </div>

      {/* Filter chips */}
      <div style={{ display: 'flex', flexDirection: 'row', gap: 6, paddingLeft: 14, paddingRight: 14, paddingBottom: 14 }}>
        {FILTERS.map(({ id, label }) => {
          const active = filter === id;
          return (
            <button
              key={id}
              onClick={() => setFilter(id)}
              aria-label={`Filter by ${label}`}
              aria-pressed={active}
              style={{ paddingLeft: 14, paddingRight: 14, paddingTop: 6, paddingBottom: 6, borderRadius: 99, backgroundColor: active ? t.accent : t.surface2, border: 'none', cursor: 'pointer', flexShrink: 0 }}
            >
              <span style={{ fontFamily: t.font, fontSize: 13, fontWeight: active ? '600' : '400', color: active ? t.accentInk : t.textDim }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!hasQuery && !hasResults ? (
          <EmptySearch t={t} />
        ) : hasQuery && !hasResults ? (
          <NoResults t={t} query={q} />
        ) : (
          results.map((r, i) => {
            if (r.type === 'person') {
              return (
                <PersonRow
                  key={`p-${r.contact.aegisId}`}
                  t={t}
                  contact={r.contact}
                  onPress={() => onOpenContact?.(r.contact)}
                  onChat={() => onOpenChat?.(r.contact)}
                />
              );
            }
            if (r.type === 'group') {
              return (
                <GroupRow
                  key={`g-${r.group.id}`}
                  t={t}
                  group={r.group}
                  onPress={() => onOpenGroupChat?.(r.group)}
                />
              );
            }
            if (r.type === 'message') {
              return (
                <MessageRowFixed
                  key={`m-${r.chatId}-${r.ts}-${i}`}
                  t={t}
                  result={r}
                  query={q}
                />
              );
            }
            if (r.type === 'file') {
              return (
                <FileRow
                  key={`f-${r.chatId}-${r.ts}-${i}`}
                  t={t}
                  result={r}
                />
              );
            }
            return null;
          })
        )}
      </div>
    </div>
  );
}

function PersonRow({ t, contact, onPress, onChat }: { t: Theme; contact: StoredContact; onPress: () => void; onChat: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onPress()}
      aria-label={`View ${contact.name}`}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 11, paddingBottom: 11, backgroundColor: hovered ? t.surface : 'transparent', borderBottom: `1px solid ${t.divider}`, cursor: 'pointer' }}
    >
      <Avatar t={t} name={contact.avatarImage ?? contact.name} color={contact.color ?? t.surface2} size={40} photoUri={contact.avatarImage ?? undefined} seed={contact.publicKeyB64 ?? contact.aegisId} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.name}</span>
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, display: 'block', marginTop: 2, letterSpacing: 0.4 }}>{contact.aegisId}</span>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onChat(); }} aria-label={`Chat with ${contact.name}`} style={iconBtn}>
        <I.Chat size={18} color={t.accent} />
      </button>
    </div>
  );
}

function GroupRow({ t, group, onPress }: { t: Theme; group: StoredGroup; onPress: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onPress()}
      aria-label={`Open group ${group.name}`}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 11, paddingBottom: 11, backgroundColor: hovered ? t.surface : 'transparent', borderBottom: `1px solid ${t.divider}`, cursor: 'pointer' }}
    >
      <Avatar t={t} name={group.avatarImage ?? group.name} color={group.avatarColor ?? t.accent} size={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</span>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <I.Users size={10} color={t.accent} />
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.4 }}>{group.members.length} members</span>
        </div>
      </div>
      <I.Chevron size={14} color={t.textFaint} />
    </div>
  );
}


function FileRow({ t, result }: { t: Theme; result: { type: 'file'; chatId: string; chatName: string; name: string; size: string; from: string; time: string; ts: number } }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      aria-label={`File ${result.name} from ${result.chatName}`}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 12, backgroundColor: hovered ? t.surface : 'transparent', borderBottom: `1px solid ${t.divider}`, cursor: 'pointer' }}
    >
      <div style={{ width: 40, height: 40, borderRadius: t.radiusS, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <I.Attach size={20} color={t.textDim} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.name}</span>
        <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginTop: 2 }}>
          {result.chatName} · {result.from} · {result.time}
        </span>
      </div>
    </div>
  );
}

function EmptySearch({ t }: { t: Theme }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 60 }}>
      <I.Search size={48} color={t.surface3} />
      <span style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: '600', color: t.text, marginTop: 18, display: 'block', textAlign: 'center' }}>Search AegisLink</span>
      <span style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, marginTop: 8, display: 'block', textAlign: 'center', maxWidth: 260 }}>
        Search messages, contacts, groups, and files.
      </span>
    </div>
  );
}

function NoResults({ t, query }: { t: Theme; query: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 60 }}>
      <I.Search size={40} color={t.surface3} />
      <span style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '600', color: t.text, marginTop: 18, display: 'block', textAlign: 'center' }}>No results</span>
      <span style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, marginTop: 6, display: 'block', textAlign: 'center', maxWidth: 260 }}>
        Nothing matches "{query}"
      </span>
    </div>
  );
}

function highlightQuery(text: string, query: string): { text: string; match: boolean }[] {
  if (!query.trim()) return [{ text, match: false }];
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((p) => ({ text: p, match: p.toLowerCase() === query.toLowerCase() }));
}

type MessageResult = { type: 'message'; chatId: string; chatName: string; chatColor?: string; chatAvatar?: string | null; text: string; time: string; ts: number };

function MessageRowFixed({ t, result, query }: { t: Theme; result: MessageResult; query: string }) {
  const [hovered, setHovered] = useState(false);
  const highlighted = highlightQuery(result.text, query);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      aria-label={`Message from ${result.chatName}`}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 12, backgroundColor: hovered ? t.surface : 'transparent', borderBottom: `1px solid ${t.divider}`, cursor: 'pointer' }}
    >
      <div style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: result.chatColor ?? t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <I.Chat size={18} color={t.textDim} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>{result.chatName}</span>
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, flexShrink: 0 }}>{result.time}</span>
        </div>
        <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {highlighted.map((p, i) =>
            p.match
              ? <mark key={i} style={{ backgroundColor: `${t.accent}44`, color: t.text, borderRadius: 2 }}>{p.text}</mark>
              : <span key={i}>{p.text}</span>
          )}
        </span>
      </div>
    </div>
  );
}

const iconBtn: CSSProperties = {
  padding: 6, background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
};
