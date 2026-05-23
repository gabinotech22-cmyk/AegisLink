import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Switch,
  Alert,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useWork, type ChannelPermission, type WorkChannel } from '../store/work';
import { useIdentity } from '../store/identity';
import { getPermissions, type WorkRole } from '../utils/workPermissions';
import { signAdminAction } from '../store/work';
import { SERVER_URL } from '../config';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  channel: WorkChannel;
  onBack: () => void;
}

// ─── Default channel permissions per role ────────────────────────────────────

function defaultPerms(channelId: string, role: WorkRole): ChannelPermission {
  if (role === 'owner') {
    return { channelId, role, canSend: true, canReact: true, canUpload: true };
  }
  if (role === 'admin') {
    return { channelId, role, canSend: true, canReact: true, canUpload: true };
  }
  return { channelId, role, canSend: !/* announcements default */ false, canReact: true, canUpload: false };
}

const ALL_ROLES: WorkRole[] = ['owner', 'admin', 'member'];

type RetentionOption = 7 | 30 | 90 | null;

const ROLE_LABELS: Record<WorkRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Miembro',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function WorkChannelPermissions({ channel, onBack }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const myAegisId = identity?.aegisId ?? '';

  const org = useWork((s) => s.org);
  const members = useWork((s) => s.members);
  const channelPermissions = useWork((s) => s.channelPermissions[channel.channelId]);
  const fetchChannelPermissions = useWork((s) => s.fetchChannelPermissions);

  // Derive current user role
  const myRole: WorkRole = (() => {
    if (org && myAegisId === org.adminId) return 'owner';
    const me = members.find((m) => m.aegis_id === myAegisId);
    return (me?.role as WorkRole | undefined) ?? 'member';
  })();

  const myPerms = getPermissions(myRole);

  // Guard: only owners (canDeleteChannels) can access this screen
  useEffect(() => {
    if (!myPerms.canDeleteChannels) {
      Alert.alert('Sin acceso', 'Solo el propietario puede gestionar permisos de canal.');
      onBack();
    }
  }, [myPerms.canDeleteChannels, onBack]);

  const [localPerms, setLocalPerms] = useState<Record<WorkRole, ChannelPermission>>(() => {
    const base: Record<WorkRole, ChannelPermission> = {
      owner: defaultPerms(channel.channelId, 'owner'),
      admin: defaultPerms(channel.channelId, 'admin'),
      member: defaultPerms(channel.channelId, 'member'),
    };
    return base;
  });

  const [saving, setSaving] = useState<WorkRole | null>(null);
  const [loading, setLoading] = useState(false);

  // ── Retention state ──────────────────────────────────────────────────────────
  const [retentionDays, setRetentionDays] = useState<RetentionOption>(null);
  const [savingRetention, setSavingRetention] = useState(false);

  // Load from store on mount
  useEffect(() => {
    setLoading(true);
    void fetchChannelPermissions(channel.orgId, channel.channelId).finally(() => setLoading(false));
  }, [channel.channelId, channel.orgId, fetchChannelPermissions]);

  // Sync store into local state when permissions arrive
  useEffect(() => {
    if (!channelPermissions) return;
    setLocalPerms((prev) => {
      const next = { ...prev };
      for (const p of channelPermissions) {
        if (p.role === 'owner' || p.role === 'admin' || p.role === 'member') {
          next[p.role] = p;
        }
      }
      return next;
    });
  }, [channelPermissions]);

  const handleToggle = useCallback(
    async (role: WorkRole, field: 'canSend' | 'canReact' | 'canUpload', value: boolean) => {
      if (role === 'owner') return; // owner permissions are immutable
      if (!org) return;

      const updated: ChannelPermission = { ...localPerms[role], [field]: value };

      // Optimistic update
      setLocalPerms((prev) => ({ ...prev, [role]: updated }));
      setSaving(role);

      try {
        const adminSig = signAdminAction(org.orgId, 'update_channel_permissions');
        if (!adminSig) throw new Error('Identity not loaded');

        const res = await fetch(
          `${SERVER_URL}/work/org/${org.orgId}/channels/${channel.channelId}/permissions`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              aegisId: myAegisId,
              sig: adminSig.sig,
              ts: adminSig.ts,
              role,
              canSend: updated.canSend,
              canReact: updated.canReact,
              canUpload: updated.canUpload,
            }),
          },
        );
        if (!res.ok) throw new Error('Error al guardar permisos');
      } catch (e) {
        // Roll back on failure
        setLocalPerms((prev) => ({ ...prev, [role]: localPerms[role] }));
        Alert.alert('Error', (e as Error).message);
      } finally {
        setSaving(null);
      }
    },
    [localPerms, org, myAegisId, channel.channelId],
  );

  const canManageRetention = myPerms.canManageMembers;

  const handleSaveRetention = useCallback(
    async (days: RetentionOption) => {
      if (!org || !canManageRetention) return;
      setSavingRetention(true);
      try {
        const adminSig = signAdminAction(org.orgId, 'set_channel_retention');
        if (!adminSig) throw new Error('Identidad no cargada');
        const res = await fetch(
          `${SERVER_URL}/work/org/${org.orgId}/channels/${channel.channelId}/retention`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              aegisId: myAegisId,
              sig: adminSig.sig,
              ts: adminSig.ts,
              retentionDays: days,
            }),
          },
        );
        if (!res.ok) throw new Error('Error al guardar retención');
        setRetentionDays(days);
      } catch (e) {
        Alert.alert('Error', (e as Error).message);
      } finally {
        setSavingRetention(false);
      }
    },
    [org, myAegisId, channel.channelId, canManageRetention],
  );

  const s = makeStyles(t);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityLabel="Volver" style={s.backBtn}>
          <I.Chevron size={20} color={t.textDim} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Permisos del canal</Text>
          <Text style={s.headerSub} numberOfLines={1}>#{channel.name}</Text>
        </View>
        {loading && <ActivityIndicator size="small" color={t.accent} style={{ marginRight: 16 }} />}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.sectionDesc}>
          Configura lo que cada rol puede hacer en este canal. Los permisos del propietario no se pueden modificar.
        </Text>

        {ALL_ROLES.map((role) => {
          const perm = localPerms[role];
          const isOwner = role === 'owner';
          const isSavingThis = saving === role;
          const roleColor = role === 'owner' ? '#f59e0b' : role === 'admin' ? t.accent : t.textDim;

          return (
            <View key={role} style={s.section}>
              {/* Role header */}
              <View style={s.roleHeader}>
                <View style={[s.roleBadge, { borderColor: roleColor + '44', backgroundColor: roleColor + '1a' }]}>
                  <Text style={[s.roleBadgeText, { color: roleColor }]}>
                    {ROLE_LABELS[role].toUpperCase()}
                  </Text>
                </View>
                {isOwner && (
                  <Text style={s.immutableNote}>Permisos fijos</Text>
                )}
                {isSavingThis && !isOwner && (
                  <ActivityIndicator size="small" color={t.accent} />
                )}
              </View>

              {/* Toggle rows */}
              <ToggleRow
                label="Puede escribir"
                value={perm.canSend}
                disabled={isOwner}
                onToggle={(v) => void handleToggle(role, 'canSend', v)}
                t={t}
              />
              <ToggleRow
                label="Puede reaccionar"
                value={perm.canReact}
                disabled={isOwner}
                onToggle={(v) => void handleToggle(role, 'canReact', v)}
                t={t}
              />
              <ToggleRow
                label="Puede subir archivos"
                value={perm.canUpload}
                disabled={isOwner}
                onToggle={(v) => void handleToggle(role, 'canUpload', v)}
                t={t}
                last
              />
            </View>
          );
        })}
        {/* Retention section — admin/owner only */}
        {canManageRetention && (
          <View style={s.section}>
            <View style={s.roleHeader}>
              <Text style={[s.roleBadgeText, { color: t.accent, fontSize: 11, letterSpacing: 0.8 }]}>
                RETENCIÓN DE MENSAJES
              </Text>
              {savingRetention && <ActivityIndicator size="small" color={t.accent} style={{ marginLeft: 'auto' }} />}
            </View>
            {([7, 30, 90, null] as RetentionOption[]).map((opt, idx, arr) => {
              const label =
                opt === 7 ? '7 días' :
                opt === 30 ? '30 días' :
                opt === 90 ? '90 días' :
                'Para siempre';
              const isSelected = retentionDays === opt;
              const isLast = idx === arr.length - 1;
              return (
                <TouchableOpacity
                  key={String(opt)}
                  onPress={() => void handleSaveRetention(opt)}
                  disabled={savingRetention}
                  accessibilityLabel={`Retención: ${label}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  style={[
                    {
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 16,
                      paddingVertical: 14,
                    },
                    !isLast && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: t.divider,
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      borderWidth: 2,
                      borderColor: isSelected ? t.accent : t.border,
                      backgroundColor: isSelected ? t.accent : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: 12,
                    }}
                  >
                    {isSelected && (
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.bg }} />
                    )}
                  </View>
                  <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text, flex: 1 }}>
                    {label}
                  </Text>
                  {opt === null && (
                    <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>
                      sin límite
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Toggle row ───────────────────────────────────────────────────────────────

function ToggleRow({
  label,
  value,
  disabled,
  onToggle,
  t,
  last,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
  t: import('../theme/vault').Theme;
  last?: boolean;
}) {
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 14,
        },
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: t.divider,
        },
      ]}
      accessibilityLabel={`${label}: ${value ? 'activado' : 'desactivado'}`}
    >
      <Text style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: disabled ? t.textFaint : t.text }}>
        {label}
      </Text>
      <Switch
        value={value}
        onValueChange={onToggle}
        disabled={disabled}
        trackColor={{ false: t.surface2, true: t.accent }}
        thumbColor={value ? t.bg : t.textFaint}
        accessibilityLabel={label}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: import('../theme/vault').Theme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: t.bg,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      gap: 10,
    },
    backBtn: {
      transform: [{ rotate: '90deg' }],
      padding: 4,
    },
    headerTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 16,
      fontWeight: '600',
      color: t.text,
    },
    headerSub: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textDim,
      marginTop: 1,
    },
    content: {
      padding: 16,
      gap: 16,
    },
    sectionDesc: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textDim,
      lineHeight: 20,
      marginBottom: 4,
    },
    section: {
      backgroundColor: t.surface,
      borderRadius: t.radius,
      borderWidth: 1,
      borderColor: t.border,
      overflow: 'hidden',
    },
    roleHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: t.surface2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    roleBadge: {
      borderRadius: 5,
      borderWidth: 1,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    roleBadgeText: {
      fontFamily: t.fontMono,
      fontSize: 10,
      letterSpacing: 0.8,
    },
    immutableNote: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      flex: 1,
    },
  });
}
