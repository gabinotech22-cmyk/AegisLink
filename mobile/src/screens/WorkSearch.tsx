import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useWorkMessages } from '../store/workMessages';
import { useWork } from '../store/work';
import type { WorkChannel } from '../store/work';
import type { WorkMessage } from '../store/workMessages';
import { useConnection } from '../store/connection';
import { SERVER_URL } from '../config';
import { useIdentity } from '../store/identity';
import { signAdminAction } from '../store/work';

// ─── Result type ──────────────────────────────────────────────────────────────

interface SearchResult extends WorkMessage {
  channelId: string;
}

// ─── Relative time helper ─────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'hace un momento';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `hace ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `hace ${diffD}d`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── Highlight component ──────────────────────────────────────────────────────

function HighlightedText({
  text,
  query,
  baseStyle,
  highlightStyle,
}: {
  text: string;
  query: string;
  baseStyle: object;
  highlightStyle: object;
}) {
  if (!query) return <Text style={baseStyle}>{text}</Text>;
  const lower = text.toLowerCase();
  const lowerQ = query.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  let idx = lower.indexOf(lowerQ, cursor);
  while (idx !== -1) {
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false });
    parts.push({ text: text.slice(idx, idx + query.length), match: true });
    cursor = idx + query.length;
    idx = lower.indexOf(lowerQ, cursor);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return (
    <Text style={baseStyle} numberOfLines={2}>
      {parts.map((p, i) =>
        p.match ? (
          <Text key={i} style={highlightStyle}>{p.text}</Text>
        ) : (
          <Text key={i}>{p.text}</Text>
        ),
      )}
    </Text>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
  onOpenChannel: (channel: WorkChannel) => void;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WorkSearch({ onBack, onOpenChannel }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const s = makeStyles(t);

  const [query, setQuery] = useState('');
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [serverResults, setServerResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // The query that was last submitted to the server
  const [committedQuery, setCommittedQuery] = useState('');
  const [committedChannelId, setCommittedChannelId] = useState<string | null>(null);

  const online = useConnection((st) => st.online);
  const aegisId = useIdentity((st) => st.identity?.aegisId);
  const orgId = useWork((st) => st.org?.orgId);
  const byChannel = useWorkMessages((st) => st.byChannel);
  const channels = useWork((st) => st.channels);

  // Debounce timer ref
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Local search (offline fallback) ────────────────────────────────────────

  const allMessages: SearchResult[] = useMemo(() => {
    return Object.entries(byChannel).flatMap(([channelId, msgs]) =>
      msgs.map((m) => ({ ...m, channelId })),
    );
  }, [byChannel]);

  const localResults: SearchResult[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return allMessages
      .filter(
        (m) =>
          m.body.toLowerCase().includes(q) &&
          (selectedChannelId === null || m.channelId === selectedChannelId),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);
  }, [query, allMessages, selectedChannelId]);

  // ── Remote search ───────────────────────────────────────────────────────────

  const performSearch = useCallback(
    async (q: string, channelId: string | null) => {
      if (!online || !q || !orgId || !aegisId) return;
      setIsSearching(true);
      setCommittedQuery(q);
      setCommittedChannelId(channelId);
      try {
        const sig = signAdminAction(orgId, 'search_messages');
        const sigParams = sig
          ? `&sig=${encodeURIComponent(sig.sig)}&ts=${sig.ts}`
          : '';
        const channelParam = channelId
          ? `&channelId=${encodeURIComponent(channelId)}`
          : '';
        const res = await fetch(
          `${SERVER_URL}/work/org/${orgId}/search?q=${encodeURIComponent(q)}&aegisId=${encodeURIComponent(aegisId)}${channelParam}${sigParams}&limit=50`,
        );
        if (res.ok) {
          const data = (await res.json()) as { messages?: SearchResult[] };
          setServerResults(data.messages ?? []);
        } else {
          setServerResults([]);
        }
      } catch {
        setServerResults([]);
      } finally {
        setIsSearching(false);
      }
    },
    [online, orgId, aegisId],
  );

  // Debounce — 400ms after last keystroke
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setServerResults([]);
      setCommittedQuery('');
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void performSearch(trimmed, selectedChannelId);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selectedChannelId]);

  // ── Decide which result set to show ────────────────────────────────────────

  const trimmedQuery = query.trim();

  // Results shown to user:
  // - offline → local
  // - online + query matches last committed → server results
  // - online + query changed since commit (debounce pending) → show nothing yet
  const results: SearchResult[] = useMemo(() => {
    if (trimmedQuery.length < 2) return [];
    if (!online) return localResults;
    if (trimmedQuery === committedQuery && selectedChannelId === committedChannelId) {
      return serverResults;
    }
    // debounce pending — show nothing to avoid stale results
    return [];
  }, [
    trimmedQuery,
    online,
    localResults,
    serverResults,
    committedQuery,
    committedChannelId,
    selectedChannelId,
  ]);

  // ── Channel filter chips ────────────────────────────────────────────────────

  function handleChannelFilter(channelId: string | null) {
    setSelectedChannelId(channelId);
    // Re-trigger debounce when filter changes
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (trimmedQuery.length >= 2) {
      debounceRef.current = setTimeout(() => {
        void performSearch(trimmedQuery, channelId);
      }, 400);
    }
  }

  // ── Result handlers ─────────────────────────────────────────────────────────

  function handleOpenResult(result: SearchResult) {
    const ch = channels.find((c) => c.channelId === result.channelId);
    if (ch) onOpenChannel(ch);
  }

  // ── Flat list renderer ──────────────────────────────────────────────────────

  function renderResult({ item }: { item: SearchResult }) {
    const ch = channels.find((c) => c.channelId === item.channelId);
    const channelName = ch?.name ?? item.channelId.slice(0, 12);
    return (
      <Pressable
        style={s.resultRow}
        onPress={() => handleOpenResult(item)}
        accessibilityLabel={`Ir al canal #${channelName}: ${item.body.slice(0, 60)}`}
        accessibilityRole="button"
      >
        {/* Channel label */}
        <Text style={s.channelLabel}>#{channelName}</Text>
        {/* Sender */}
        <Text style={s.senderLabel}>{item.senderId.slice(0, 10)}</Text>
        {/* Body with highlighted query */}
        <HighlightedText
          text={item.body}
          query={trimmedQuery}
          baseStyle={s.bodyText}
          highlightStyle={s.bodyHighlight}
        />
        {/* Relative timestamp */}
        <Text style={s.timeLabel}>{relativeTime(item.createdAt)}</Text>
      </Pressable>
    );
  }

  // ── Determine body state ────────────────────────────────────────────────────

  type BodyState =
    | 'too-short'
    | 'loading'
    | 'empty'
    | 'results';

  const bodyState: BodyState = (() => {
    if (trimmedQuery.length < 2) return 'too-short';
    if (isSearching || (online && trimmedQuery !== committedQuery)) return 'loading';
    if (results.length === 0) return 'empty';
    return 'results';
  })();

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityLabel="Volver"
          style={s.backBtn}
        >
          <I.ChevronL size={20} color={t.textDim} />
        </Pressable>
        <View style={s.searchBarWrap}>
          <I.Search size={16} color={t.textDim} />
          <TextInput
            style={s.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar en canales..."
            placeholderTextColor={t.textDim}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Campo de búsqueda"
            testID="search-input"
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => {
                setQuery('');
                setServerResults([]);
                setCommittedQuery('');
                setCommittedChannelId(null);
              }}
              hitSlop={8}
              accessibilityLabel="Borrar búsqueda"
            >
              <I.X size={16} color={t.textDim} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Channel filter chips */}
      {channels.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.chipRow}
          contentContainerStyle={s.chipRowContent}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Filtrar por canal"
        >
          <Pressable
            style={[s.chip, selectedChannelId === null && s.chipActive]}
            onPress={() => handleChannelFilter(null)}
            accessibilityLabel="Mostrar todos los canales"
            accessibilityRole="button"
          >
            <Text style={[s.chipText, selectedChannelId === null && s.chipTextActive]}>
              Todos los canales
            </Text>
          </Pressable>
          {channels.map((ch) => (
            <Pressable
              key={ch.channelId}
              style={[s.chip, selectedChannelId === ch.channelId && s.chipActive]}
              onPress={() => handleChannelFilter(ch.channelId)}
              accessibilityLabel={`Filtrar por canal #${ch.name}`}
              accessibilityRole="button"
            >
              <Text
                style={[
                  s.chipText,
                  selectedChannelId === ch.channelId && s.chipTextActive,
                ]}
              >
                #{ch.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Offline banner */}
      {!online && (
        <View testID="offline-banner" style={s.offlineBanner}>
          <Text style={s.offlineText}>SIN CONEXIÓN — búsqueda en mensajes cargados</Text>
        </View>
      )}

      {/* Body */}
      {bodyState === 'too-short' && (
        <View style={s.emptyState} testID="hint-too-short">
          <I.Search size={36} color={t.textFaint} />
          <Text style={s.emptyTitle}>Buscar en workspace</Text>
          <Text style={s.emptySubtitle}>Escribe al menos 2 caracteres</Text>
        </View>
      )}

      {bodyState === 'loading' && (
        <View style={s.emptyState}>
          <ActivityIndicator size="large" color={t.accent} />
          <Text style={s.emptySubtitle}>Buscando...</Text>
        </View>
      )}

      {bodyState === 'empty' && (
        <View style={s.emptyState} testID="no-results">
          <I.Search size={36} color={t.textFaint} />
          <Text style={s.emptyTitle}>Sin resultados</Text>
          <Text style={s.emptySubtitle}>
            Sin resultados para {'«'}{trimmedQuery}{'»'}
          </Text>
        </View>
      )}

      {bodyState === 'results' && (
        <FlatList
          data={results}
          keyExtractor={(item, idx) => `${item.id}-${idx}`}
          renderItem={renderResult}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          removeClippedSubviews
          maxToRenderPerBatch={20}
          windowSize={10}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: import('../theme/vault').Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
      backgroundColor: t.surface,
    },
    backBtn: { padding: 4 },
    searchBarWrap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 20,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    searchInput: {
      flex: 1,
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
      padding: 0,
    },
    // ── Channel filter chips ─────────────────────────────────────────────────
    chipRow: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      backgroundColor: t.surface,
      maxHeight: 48,
    },
    chipRowContent: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 8,
    },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 99,
      borderWidth: 1,
      borderColor: t.border,
    },
    chipActive: {
      backgroundColor: t.accent,
      borderColor: t.accent,
    },
    chipText: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textDim,
      letterSpacing: 0.3,
    },
    chipTextActive: {
      color: t.bg,
      fontWeight: '700',
    },
    // ── Offline ──────────────────────────────────────────────────────────────
    offlineBanner: {
      backgroundColor: '#3a2600',
      paddingVertical: 6,
      paddingHorizontal: 16,
      alignItems: 'center',
    },
    offlineText: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: '#f5a623',
      letterSpacing: 0.5,
    },
    // ── Empty / info states ──────────────────────────────────────────────────
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      paddingHorizontal: 40,
    },
    emptyTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 18,
      fontWeight: '700',
      color: t.text,
    },
    emptySubtitle: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textDim,
      textAlign: 'center',
      lineHeight: 20,
    },
    // ── Result rows ──────────────────────────────────────────────────────────
    resultRow: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 3,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    channelLabel: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.accent,
      letterSpacing: 0.5,
      marginBottom: 1,
    },
    senderLabel: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textDim,
      letterSpacing: 0.3,
    },
    bodyText: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.text,
      lineHeight: 19,
    },
    bodyHighlight: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.accent,
      backgroundColor: t.accentDeep,
      fontWeight: '700',
      lineHeight: 19,
    },
    timeLabel: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      marginTop: 2,
    },
  });
}
