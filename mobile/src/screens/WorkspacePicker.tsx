import { View, Text, Pressable, FlatList, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import type { Theme } from '../theme/vault';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  orgIds: string[];
  activeOrgId: string | null;
  onSelect: (orgId: string) => void;
  onCreateNew: () => void;
  onJoinExisting: () => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WorkspacePicker({
  orgIds,
  activeOrgId,
  onSelect,
  onCreateNew,
  onJoinExisting,
  onClose,
}: Props) {
  const { t } = useTheme();
  const s = makeStyles(t);

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>Mis Workspaces</Text>
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityLabel="Cerrar selector de workspaces"
        >
          <I.X size={20} color={t.textDim} />
        </Pressable>
      </View>

      {/* Workspace list */}
      {orgIds.length === 0 ? (
        <View style={s.emptyState}>
          <I.Shield size={28} color={t.textFaint} />
          <Text style={s.emptyText}>No perteneces a ningún workspace aún</Text>
        </View>
      ) : (
        <FlatList
          data={orgIds}
          keyExtractor={(item) => item}
          style={s.list}
          scrollEnabled={orgIds.length > 5}
          renderItem={({ item }) => {
            const isActive = item === activeOrgId;
            return (
              <Pressable
                onPress={() => onSelect(item)}
                style={[s.orgItem, isActive && s.orgItemActive]}
                accessibilityLabel={`Workspace ${item.slice(0, 12)} ${isActive ? 'activo' : ''}`}
              >
                <View style={[s.orgIconWrap, isActive && s.orgIconWrapActive]}>
                  <I.Shield size={16} color={isActive ? t.accent : t.textDim} />
                </View>
                <Text style={[s.orgIdText, isActive && s.orgIdTextActive]} numberOfLines={1}>
                  {item.slice(0, 12)}…
                </Text>
                {isActive && (
                  <I.Check size={16} color={t.accent} />
                )}
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={s.separator} />}
        />
      )}

      {/* Divider */}
      <View style={s.divider} />

      {/* Action buttons */}
      <Pressable
        onPress={onCreateNew}
        style={s.actionBtn}
        accessibilityLabel="Crear nuevo workspace"
      >
        <View style={s.actionIconWrap}>
          <I.Plus size={16} color={t.accent} />
        </View>
        <Text style={s.actionText}>Crear nuevo workspace</Text>
      </Pressable>

      <Pressable
        onPress={onJoinExisting}
        style={[s.actionBtn, s.actionBtnLast]}
        accessibilityLabel="Unirse a workspace con código de invitación"
      >
        <View style={s.actionIconWrap}>
          <I.Key size={16} color={t.textDim} />
        </View>
        <Text style={[s.actionText, { color: t.textDim }]}>Unirse con código</Text>
      </Pressable>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: {
      backgroundColor: t.surface,
      borderRadius: t.radius,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: t.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    title: {
      fontFamily: t.fontDisplay,
      fontSize: 16,
      fontWeight: '700',
      color: t.text,
    },
    list: {
      maxHeight: 280,
    },
    emptyState: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 32,
      gap: 10,
    },
    emptyText: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textFaint,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
    orgItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    orgItemActive: {
      backgroundColor: t.accentInk,
    },
    orgIconWrap: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: t.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    orgIconWrapActive: {
      backgroundColor: t.accentDeep,
    },
    orgIdText: {
      flex: 1,
      fontFamily: t.fontMono,
      fontSize: 13,
      color: t.textDim,
      letterSpacing: 0.5,
    },
    orgIdTextActive: {
      color: t.accent,
      fontWeight: '600',
    },
    separator: {
      height: 1,
      backgroundColor: t.divider,
      marginHorizontal: 16,
    },
    divider: {
      height: 1,
      backgroundColor: t.border,
      marginTop: 4,
    },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 13,
      borderTopWidth: 1,
      borderTopColor: t.divider,
    },
    actionBtnLast: {
      // no extra style needed — kept for extension
    },
    actionIconWrap: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: t.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionText: {
      fontFamily: t.font,
      fontSize: 14,
      fontWeight: '500',
      color: t.accent,
    },
  });
}
