import { useMemo, useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, Pressable, FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { useContacts } from '../store/contacts';
import { useMessages } from '../store/messages';
import { useGroups } from '../store/groups';
import type { StoredContact, StoredMessage, StoredGroup } from '../db/local';
import { ss } from '../utils/secureStore';

interface Props {
  onBack: () => void;
  onOpenChat?: (contact: StoredContact) => void;
  onOpenContact?: (contact: StoredContact) => void;
  onOpenGroupChat?: (group: StoredGroup) => void;
}

type Filter = 'all' | 'messages' | 'files' | 'people' | 'groups';

type Result =
  | { type: 'message'; chatId: string; chatName: string; chatColor?: string; chatAvatar?: string | null; text: string; time: string; ts: number }
  | { type: 'file'; chatId: string; chatName: string; name: string; size: string; from: string; time: string; ts: number }
  | { type: 'person'; contact: StoredContact }
  | { type: 'group'; group: StoredGroup };

const RECENTS_KEY = '__aegis_search_recents__';

async function saveRecents(items: string[]): Promise<void> {
  // ss.set can reject (e.g. the 5s SecureStore write timeout) — this is a
  // best-effort persistence of search recents, never something that should
  // surface as an unhandled promise rejection to the caller.
  try {
    await ss.set(RECENTS_KEY, JSON.stringify(items));
  } catch {
    /* non-fatal — recents just won't persist this time */
  }
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
  if (!body) return false;
  return FILE_PREFIXES.some((p) => body.startsWith(p));
}

export function SearchScreen({ onBack, onOpenChat, onOpenContact, onOpenGroupChat }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [recents, setRecents] = useState<string[]>([]);
  const recentsSeededRef = useRef(false);

  useEffect(() => {
    ss.get(RECENTS_KEY)
      .then((v) => {
        // If commitRecent already wrote a fresher value while this bootstrap
        // read was in flight, don't clobber it with the stale seed.
        if (recentsSeededRef.current) return;
        if (v) {
          try {
            const parsed = JSON.parse(v);
            if (Array.isArray(parsed)) setRecents(parsed);
          } catch {}
        }
      })
      .catch(() => {
        /* non-fatal — start with empty recents */
      });
  }, []);

  const { contacts } = useContacts();
  const byChat = useMessages((s) => s.byChat);
  const { groups } = useGroups();

  // Build a contact lookup for chat name attribution
  const contactById = useMemo(() => {
    const m = new Map<string, StoredContact>();
    for (const c of contacts) m.set(c.aegisId, c);
    return m;
  }, [contacts]);

  const results: Result[] = useMemo(() => {
    const query = q.trim().toLowerCase();
    const out: Result[] = [];

    // Without a query: only show people + groups (browseable directories).
    // With a query: full-text across messages + files + people + groups.
    const queryActive = query.length > 0;

    // People
    for (const c of contacts) {
      if (!queryActive || c.name.toLowerCase().includes(query) || c.aegisId.toLowerCase().includes(query)) {
        out.push({ type: 'person', contact: c });
      }
    }

    // Groups
    for (const g of groups) {
      if (!queryActive || g.name.toLowerCase().includes(query)) {
        out.push({ type: 'group', group: g });
      }
    }

    // Messages + files (require query to avoid dumping everything)
    if (queryActive) {
      for (const [chatId, list] of Object.entries(byChat)) {
        const c = contactById.get(chatId);
        const g = groups.find((x) => x.id === chatId);
        const chatName = c?.name ?? g?.name ?? chatId;
        const chatColor = c?.color ?? g?.avatarColor;
        const chatAvatar = c?.avatarImage ?? g?.avatarImage ?? null;

        for (const m of list as StoredMessage[]) {
          if (!m.body.toLowerCase().includes(query)) continue;
          if (isFileMessage(m.body)) {
            // crude parse: "attachment · filename.ext"
            const fname = m.body.replace(/^attachment · /i, '').split(' ')[0];
            out.push({
              type: 'file',
              chatId,
              chatName,
              name: fname || i18nT('search.file'),
              size: '—',
              from: m.direction === 'out' ? i18nT('search.fromYou') : chatName,
              time: formatTime(m.createdAt),
              ts: m.createdAt,
            });
          } else {
            out.push({
              type: 'message',
              chatId,
              chatName,
              chatColor,
              chatAvatar,
              text: m.body,
              time: formatTime(m.createdAt),
              ts: m.createdAt,
            });
          }
        }
      }
    }

    // Apply filter
    return out.filter((r) => {
      if (filter === 'all') return true;
      if (filter === 'messages') return r.type === 'message';
      if (filter === 'files') return r.type === 'file';
      if (filter === 'people') return r.type === 'person';
      if (filter === 'groups') return r.type === 'group';
      return true;
    });
  }, [q, filter, contacts, groups, byChat, contactById]);

  function commitRecent(value: string) {
    const v = value.trim();
    if (!v) return;
    recentsSeededRef.current = true;
    const next = [v, ...recents.filter((x) => x !== v)].slice(0, 8);
    setRecents(next);
    void saveRecents(next);
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12 }}>
        <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </Pressable>
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            backgroundColor: t.surface2,
            borderRadius: 99,
          }}
        >
          <I.Search size={16} color={t.textDim} />
          <TextInput
            value={q}
            onChangeText={setQ}
            onSubmitEditing={() => commitRecent(q)}
            placeholder={i18nT('search.placeholder')}
            placeholderTextColor={t.textFaint}
            autoFocus
            returnKeyType="search"
            style={{ flex: 1, color: t.text, fontFamily: t.font, fontSize: 14, padding: 0 }}
          />
          {q.length > 0 ? (
            <Pressable onPress={() => setQ('')} hitSlop={6}>
              <I.X size={14} color={t.textDim} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 14 }}>
        {([i18nT('common.search'), i18nT('search.messages'), i18nT('attachSheet.file'), i18nT('contacts.title'), i18nT('groups.title')] as const).map((label, i) => {
          const key = (['all', 'messages', 'files', 'people', 'groups'] as Filter[])[i];
          const active = filter === key;
          return (
            <Pressable
              key={label}
              onPress={() => setFilter(key)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 99,
                backgroundColor: active ? t.accent : t.surface2,
              }}
            >
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 10,
                  letterSpacing: 0.5,
                  fontWeight: active ? '600' : '500',
                  color: active ? t.accentInk : t.textDim,
                }}
              >
                {label.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={results}
        keyExtractor={(r, i) =>
          r.type === 'person'
            ? `person-${r.contact.aegisId}`
            : r.type === 'group'
              ? `group-${r.group.id}`
              : r.type === 'message'
                ? `msg-${r.chatId}-${r.ts}-${i}`
                : `file-${r.chatId}-${r.ts}-${i}`
        }
        ListHeaderComponent={
          <>
            {q.length === 0 && recents.length > 0 ? (
              <View style={{ paddingHorizontal: 22, paddingBottom: 10 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 6 }}>
                  {i18nT('search.title').toUpperCase()}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {recents.map((r) => (
                    <Pressable
                      key={r}
                      onPress={() => setQ(r)}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        backgroundColor: t.surface,
                        borderWidth: 1,
                        borderColor: t.border,
                        borderRadius: t.radiusS,
                      }}
                    >
                      <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text }}>{r}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, paddingHorizontal: 22, paddingTop: 14, paddingBottom: 8 }}>
              {i18nT('search.result', { count: results.length }).toUpperCase()}
            </Text>
          </>
        }
        renderItem={({ item: r }) => (
          <ResultRow
            t={t}
            r={r}
            onPress={() => {
              if (r.type === 'person') onOpenContact?.(r.contact);
              else if (r.type === 'group') onOpenGroupChat?.(r.group);
              else if (r.type === 'message' || r.type === 'file') {
                const c = contactById.get(r.chatId);
                if (c) onOpenChat?.(c);
                else {
                  const g = groups.find((x) => x.id === r.chatId);
                  if (g) onOpenGroupChat?.(g);
                }
              }
            }}
            query={q.trim()}
          />
        )}
        ListEmptyComponent={
          q.length > 0 ? (
            <View style={{ paddingHorizontal: 22, paddingVertical: 32, alignItems: 'center' }}>
              <I.Search size={32} color={t.textFaint} style={{ marginBottom: 12 }} />
              <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text, marginBottom: 6 }}>
                {i18nT('search.noResultsTitle', 'No results')}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center' }}>
                {i18nT('search.noResults')}
              </Text>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 22, paddingVertical: 48, alignItems: 'center' }}>
              <I.Search size={40} color={t.textFaint} style={{ marginBottom: 16 }} />
              <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text, marginBottom: 6 }}>
                {i18nT('search.emptyTitle', 'Search AegisLink')}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center', maxWidth: 280 }}>
                {i18nT('search.emptyDesc', 'Find messages, contacts, files and groups')}
              </Text>
            </View>
          )
        }
      />
    </View>
  );
}

function highlight(text: string, query: string, t: Theme) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return (
    <>
      {before}
      <Text style={{ color: t.accent, fontWeight: '600' }}>{match}</Text>
      {after}
    </>
  );
}

function ResultRow({ t, r, onPress, query }: { t: Theme; r: Result; onPress: () => void; query: string }) {
  const { t: i18nT } = useTranslation();
  const row = {
    flexDirection: 'row' as const,
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: t.divider,
    alignItems: r.type === 'person' || r.type === 'group' ? ('center' as const) : ('flex-start' as const),
  };
  const tile = {
    width: 36,
    height: 36,
    borderRadius: r.type === 'group' ? t.radiusL : t.radius,
    backgroundColor: t.surface2,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: t.surface2 }}
      style={({ pressed }) => ({ ...row, backgroundColor: pressed ? t.surface : 'transparent' })}
    >
      {r.type === 'message' ? (
        <Avatar t={t} name={r.chatAvatar || r.chatName} color={r.chatColor ?? t.surface2} size={36} seed={r.chatId} />
      ) : r.type === 'file' ? (
        <View style={tile}>
          <I.Attach size={16} color={t.warn} />
        </View>
      ) : r.type === 'person' ? (
        <Avatar t={t} name={r.contact.avatarImage || r.contact.name} color={r.contact.color ?? t.surface2} size={36} seed={r.contact.publicKeyB64 || r.contact.aegisId} />
      ) : (
        <View style={tile}>
          <I.Users size={16} color={t.accent} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        {r.type === 'message' ? (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text, flex: 1 }}>
                {r.chatName}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{r.time}</Text>
            </View>
            <Text numberOfLines={2} style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17, marginTop: 2 }}>
              {highlight(r.text, query, t)}
            </Text>
          </>
        ) : r.type === 'file' ? (
          <>
            <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 13, fontWeight: '500', color: t.text }}>
              {r.name}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
              {i18nT('search.fileFromIn', { size: r.size, from: r.from, time: r.time, chat: r.chatName })}
            </Text>
          </>
        ) : r.type === 'person' ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.contact.name) ? t.fontMono : t.font,
                  fontSize: 13,
                  fontWeight: '600',
                  color: t.text,
                  flexShrink: 1,
                }}
              >
                {r.contact.name}
              </Text>
              {r.contact.verified ? <I.Check size={11} color={t.accent} /> : null}
            </View>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2, letterSpacing: 0.4 }}>
              {r.contact.aegisId}
            </Text>
          </>
        ) : (
          <>
            <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>
              {r.group.name}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
              {i18nT('search.member', { count: r.group.members.length })} · {i18nT('search.mlsEncrypted')}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}
