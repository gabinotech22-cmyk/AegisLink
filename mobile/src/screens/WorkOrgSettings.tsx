import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Switch,
  Alert,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useWork } from '../store/work';
import { useIdentity } from '../store/identity';
import { getPermissions, type WorkRole } from '../utils/workPermissions';
import { signAdminAction } from '../store/work';
import { SERVER_URL } from '../config';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WorkOrgSettings({ onBack }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const myAegisId = identity?.aegisId ?? '';

  const org = useWork((s) => s.org);
  const members = useWork((s) => s.members);

  // Derive role
  const myRole: WorkRole = (() => {
    if (org && myAegisId === org.adminId) return 'owner';
    const me = members.find((m) => m.aegis_id === myAegisId);
    return (me?.role as WorkRole | undefined) ?? 'member';
  })();

  const myPerms = getPermissions(myRole);
  const isOwner = myRole === 'owner';

  // Settings state
  const [displayName, setDisplayName] = useState('');
  const [invitePolicy, setInvitePolicy] = useState<'invite_only' | 'open'>('invite_only');
  const [memberCount, setMemberCount] = useState(members.length);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingOrg, setDeletingOrg] = useState(false);

  const s = makeStyles(t);

  // Load settings from server
  useEffect(() => {
    if (!org) return;
    void (async () => {
      const adminSig = signAdminAction(org.orgId, 'read_org_settings');
      if (!adminSig) { setLoading(false); return; }
      const query = `aegisId=${encodeURIComponent(myAegisId)}&sig=${encodeURIComponent(adminSig.sig)}&ts=${adminSig.ts}`;
      try {
        const res = await fetch(`${SERVER_URL}/work/orgs/${org.orgId}/settings?${query}`);
        if (res.ok) {
          const data = (await res.json()) as {
            displayName: string | null;
            invitePolicy: 'invite_only' | 'open';
            memberCount: number;
          };
          setDisplayName(data.displayName ?? '');
          setInvitePolicy(data.invitePolicy);
          setMemberCount(data.memberCount);
        }
      } catch {
        // Offline — use local state
      } finally {
        setLoading(false);
      }
    })();
  }, [org?.orgId, myAegisId]);

  const handleSave = useCallback(async () => {
    if (!org || !myPerms.canManageMembers) return;
    setSaving(true);
    try {
      const adminSig = signAdminAction(org.orgId, 'patch_org_settings');
      if (!adminSig) throw new Error('Identidad no cargada');
      const res = await fetch(`${SERVER_URL}/work/orgs/${org.orgId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aegisId: myAegisId,
          sig: adminSig.sig,
          ts: adminSig.ts,
          displayName: displayName.trim() || null,
          invitePolicy,
        }),
      });
      if (!res.ok) throw new Error('Error al guardar');
      Alert.alert('Guardado', 'La configuración de la organización ha sido actualizada.');
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [org, myAegisId, displayName, invitePolicy, myPerms.canManageMembers]);

  const handleDeleteOrg = useCallback(() => {
    if (!isOwner || !org) return;
    Alert.alert(
      'Eliminar organización',
      `¿Seguro que quieres eliminar "${org.name}"? Esta acción no se puede deshacer. Todos los miembros y mensajes se perderán.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => {
            // Owner confirms a second time
            Alert.alert(
              'Confirmación final',
              'Escribe "ELIMINAR" para confirmar.',
              [
                { text: 'Cancelar', style: 'cancel' },
                {
                  text: 'Confirmar eliminación',
                  style: 'destructive',
                  onPress: async () => {
                    setDeletingOrg(true);
                    try {
                      // Server-side org deletion is not implemented yet — inform user
                      Alert.alert(
                        'No disponible',
                        'La eliminación de organizaciones debe realizarse desde el panel de administración del servidor.',
                      );
                    } finally {
                      setDeletingOrg(false);
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, [isOwner, org]);

  if (!org) {
    return (
      <View style={[s.root, { paddingTop: insets.top, alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ color: t.textDim, fontFamily: t.font }}>Sin organización activa.</Text>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityLabel="Volver" style={s.backBtn}>
          <I.ChevronL size={20} color={t.textDim} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Configuración de la org</Text>
          <Text style={s.headerSub} numberOfLines={1}>{org.name}</Text>
        </View>
        {loading && <ActivityIndicator size="small" color={t.accent} style={{ marginRight: 16 }} />}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Info row */}
        <View style={s.infoCard}>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>ID de organización</Text>
            <Text style={s.infoValue} numberOfLines={1} selectable>{org.orgId}</Text>
          </View>
          <View style={[s.infoRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }]}>
            <Text style={s.infoLabel}>Miembros</Text>
            <Text style={s.infoValue}>{memberCount}</Text>
          </View>
        </View>

        {/* Display name */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>NOMBRE VISIBLE</Text>
          <TextInput
            style={s.textInput}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Nombre de la organización (máx 48 caracteres)"
            placeholderTextColor={t.textFaint}
            maxLength={48}
            editable={myPerms.canManageMembers}
            accessibilityLabel="Nombre visible de la organización"
          />
          <Text style={s.inputHint}>{displayName.length}/48</Text>
        </View>

        {/* Invite policy */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>POLÍTICA DE INVITACIONES</Text>
          <View style={s.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.toggleLabel}>
                {invitePolicy === 'invite_only' ? 'Solo con invitación' : 'Abierto'}
              </Text>
              <Text style={s.toggleSub}>
                {invitePolicy === 'invite_only'
                  ? 'Solo miembros invitados pueden unirse.'
                  : 'Cualquiera con el enlace puede unirse.'}
              </Text>
            </View>
            <Switch
              value={invitePolicy === 'open'}
              onValueChange={(v) => setInvitePolicy(v ? 'open' : 'invite_only')}
              disabled={!myPerms.canManageMembers}
              trackColor={{ false: t.surface2, true: t.accent }}
              thumbColor={invitePolicy === 'open' ? t.bg : t.textFaint}
              accessibilityLabel="Política de invitaciones"
            />
          </View>
        </View>

        {/* Save button */}
        {myPerms.canManageMembers && (
          <Pressable
            style={[s.saveBtn, saving && s.saveBtnDisabled]}
            onPress={() => void handleSave()}
            disabled={saving}
            accessibilityLabel="Guardar configuración"
            accessibilityRole="button"
          >
            {saving ? (
              <ActivityIndicator size="small" color={t.bg} />
            ) : (
              <Text style={s.saveBtnText}>Guardar cambios</Text>
            )}
          </Pressable>
        )}

        {/* Danger zone — owner only */}
        {isOwner && (
          <View style={s.dangerSection}>
            <Text style={s.dangerTitle}>ZONA DE PELIGRO</Text>
            <Pressable
              style={[s.deleteBtn, deletingOrg && s.saveBtnDisabled]}
              onPress={handleDeleteOrg}
              disabled={deletingOrg}
              accessibilityLabel="Eliminar organización"
              accessibilityRole="button"
            >
              {deletingOrg ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <I.Trash size={16} color="#fff" />
                  <Text style={s.deleteBtnText}>Eliminar organización</Text>
                </>
              )}
            </Pressable>
          </View>
        )}
      </ScrollView>
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
      paddingBottom: 48,
    },
    infoCard: {
      backgroundColor: t.surface,
      borderRadius: t.radius,
      borderWidth: 1,
      borderColor: t.border,
      overflow: 'hidden',
    },
    infoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
    },
    infoLabel: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textDim,
      letterSpacing: 0.3,
    },
    infoValue: {
      fontFamily: t.fontMono,
      fontSize: 12,
      color: t.text,
      flex: 1,
      textAlign: 'right',
    },
    section: {
      gap: 8,
    },
    sectionLabel: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      letterSpacing: 1,
    },
    textInput: {
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: t.radiusS,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
    },
    inputHint: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      textAlign: 'right',
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: t.radiusS,
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 12,
    },
    toggleLabel: {
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
      fontWeight: '500',
    },
    toggleSub: {
      fontFamily: t.font,
      fontSize: 12,
      color: t.textDim,
      marginTop: 2,
    },
    saveBtn: {
      backgroundColor: t.accent,
      borderRadius: t.radius,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveBtnDisabled: {
      opacity: 0.5,
    },
    saveBtnText: {
      fontFamily: t.fontDisplay,
      fontSize: 15,
      fontWeight: '700',
      color: t.bg,
    },
    dangerSection: {
      gap: 8,
      marginTop: 8,
    },
    dangerTitle: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.danger ?? '#e53e3e',
      letterSpacing: 1,
    },
    deleteBtn: {
      backgroundColor: t.danger ?? '#e53e3e',
      borderRadius: t.radius,
      paddingVertical: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    deleteBtnText: {
      fontFamily: t.fontDisplay,
      fontSize: 15,
      fontWeight: '700',
      color: '#fff',
    },
  });
}
