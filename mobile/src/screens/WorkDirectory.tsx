import { useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  Alert,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { useWork } from '../store/work';
import type { WorkMember } from '../store/work';
import { useWorkPresence } from '../store/workPresence';
import { useIdentity } from '../store/identity';
import { SERVER_URL } from '../config';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
  onStartDM: (aegisId: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic avatar background color derived from aegisId. */
function avatarColor(aegisId: string): string {
  return '#' + aegisId.replace(/-/g, '').slice(0, 6);
}

/** Two uppercase initials from aegisId. */
function initials(aegisId: string): string {
  return aegisId.replace(/-/g, '').slice(0, 2).toUpperCase();
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface RowProps {
  member: WorkMember;
  isOnline: boolean;
  onDM: () => void;
  t: Theme;
}

function MemberRow({ member, isOnline, onDM, t }: RowProps) {
  const s = rowStyles(t);
  const bg = avatarColor(member.aegis_id);

  return (
    <View style={s.row}>
      {/* Avatar */}
      <View style={[s.avatar, { backgroundColor: bg }]}>
        <Text style={s.avatarText}>{initials(member.aegis_id)}</Text>
      </View>

      {/* Info */}
      <View style={s.info}>
        <View style={s.nameRow}>
          <Text style={s.name} numberOfLines={1}>
            {member.aegis_id.slice(0, 12)}…
          </Text>
          {/* Presence dot */}
          <View
            style={[s.presenceDot, { backgroundColor: isOnline ? '#22c55e' : t.textFaint }]}
            accessibilityLabel={isOnline ? 'Online' : 'Offline'}
          />
        </View>
        {/* Role badge */}
        <View
          style={[
            s.roleBadge,
            member.role === 'admin' ? s.roleBadgeAdmin : s.roleBadgeMember,
          ]}
        >
          <Text
            style={[
              s.roleText,
              member.role === 'admin' ? s.roleTextAdmin : s.roleTextMember,
            ]}
          >
            {member.role === 'admin' ? 'ADMIN' : 'MEMBER'}
          </Text>
        </View>
      </View>

      {/* DM button */}
      <Pressable
        onPress={onDM}
        style={s.dmBtn}
        accessibilityLabel={`Enviar DM a ${member.aegis_id.slice(0, 12)}`}
        accessibilityRole="button"
      >
        <I.Chat size={14} color={t.bg} />
        <Text style={s.dmBtnText}>DM</Text>
      </Pressable>
    </View>
  );
}

function rowStyles(t: Theme) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.divider,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    avatarText: {
      fontFamily: 'monospace',
      fontSize: 14,
      fontWeight: '700',
      color: '#ffffff',
    },
    info: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    name: {
      fontFamily: 'monospace',
      fontSize: 13,
      color: t.text,
      flex: 1,
    },
    presenceDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      flexShrink: 0,
    },
    roleBadge: {
      alignSelf: 'flex-start',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    roleBadgeAdmin: {
      backgroundColor: 'rgba(99,102,241,0.18)',
      borderWidth: 1,
      borderColor: 'rgba(99,102,241,0.45)',
    },
    roleBadgeMember: {
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
    },
    roleText: {
      fontFamily: 'monospace',
      fontSize: 9,
      letterSpacing: 0.8,
    },
    roleTextAdmin: { color: '#818cf8' },
    roleTextMember: { color: t.textFaint },
    dmBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: t.accent,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
      flexShrink: 0,
    },
    dmBtnText: {
      fontFamily: 'monospace',
      fontSize: 11,
      fontWeight: '700',
      color: t.accentInk,
    },
  });
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function WorkDirectory({ onBack, onStartDM }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const members = useWork((s) => s.members);
  const onlineIds = useWorkPresence((s) => s.onlineIds);
  const [query, setQuery] = useState('');
  const [loadingDM, setLoadingDM] = useState<string | null>(null);

  const ownId = identity?.aegisId ?? '';

  /** Members excluding self, filtered by search query. */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((m) => m.aegis_id !== ownId)
      .filter((m) => !q || m.aegis_id.toLowerCase().includes(q));
  }, [members, ownId, query]);

  async function handleDM(aegisId: string) {
    if (loadingDM) return;
    setLoadingDM(aegisId);
    try {
      onStartDM(aegisId);
    } finally {
      setLoadingDM(null);
    }
  }

  const s = makeStyles(t);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityLabel="Volver"
          accessibilityRole="button"
        >
          <I.X size={20} color={t.textDim} />
        </Pressable>
        <Text style={s.title}>Directorio</Text>
        <View style={{ width: 20 }} />
      </View>

      {/* Search bar */}
      <View style={s.searchWrap}>
        <I.Search size={14} color={t.textFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar por AegisID…"
          placeholderTextColor={t.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={s.searchInput}
          accessibilityLabel="Buscar miembros"
        />
        {query.length > 0 && (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityLabel="Limpiar búsqueda"
            accessibilityRole="button"
            hitSlop={8}
          >
            <I.X size={13} color={t.textFaint} />
          </Pressable>
        )}
      </View>

      {/* Members list */}
      {filtered.length === 0 ? (
        <View style={s.emptyState} testID="empty-directory">
          <I.Users size={36} color={t.textFaint} />
          <Text style={s.emptyTitle}>
            {query.trim() ? 'Sin resultados' : 'Sin miembros'}
          </Text>
          <Text style={s.emptySub}>
            {query.trim()
              ? 'Intenta con otro término de búsqueda.'
              : 'Los miembros del workspace aparecerán aquí.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(m) => m.aegis_id}
          renderItem={({ item }) => (
            <MemberRow
              member={item}
              isOnline={onlineIds.has(item.aegis_id)}
              onDM={() => void handleDM(item.aegis_id)}
              t={t}
            />
          )}
          contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
          removeClippedSubviews
          maxToRenderPerBatch={20}
          windowSize={10}
          testID="members-list"
        />
      )}

      {/* Loading overlay for DM initiation */}
      {loadingDM !== null && (
        <View style={s.loadingOverlay} testID="dm-loading">
          <ActivityIndicator color={t.accent} size="large" />
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: t.bg,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
      backgroundColor: t.surface,
    },
    title: {
      fontFamily: t.fontDisplay,
      fontSize: 18,
      fontWeight: '600',
      color: t.text,
    },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 12,
      marginVertical: 10,
      backgroundColor: t.surface2,
      borderRadius: 20,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    searchInput: {
      flex: 1,
      fontFamily: t.font,
      fontSize: 13,
      color: t.text,
      padding: 0,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: 40,
    },
    emptyTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 17,
      fontWeight: '600',
      color: t.text,
      textAlign: 'center',
    },
    emptySub: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textDim,
      textAlign: 'center',
      lineHeight: 19,
    },
    loadingOverlay: {
      position: 'absolute',
      inset: 0,
      backgroundColor: 'rgba(0,0,0,0.35)',
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
