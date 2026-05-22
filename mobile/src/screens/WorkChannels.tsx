import { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useWork } from '../store/work';
import type { WorkChannel } from '../store/work';
import { useWorkPresence } from '../store/workPresence';
import { useIdentity } from '../store/identity';
import { getPermissions, type WorkRole } from '../utils/workPermissions';

interface Props {
  onBack: () => void;
  onOpenAdmin: () => void;
  onCreateOrg?: () => void;
  onOpenChannel?: (channel: WorkChannel) => void;
  onOpenDirectory?: () => void;
  onSearch?: () => void;
  onOpenChannelPermissions?: (channel: WorkChannel) => void;
}

export function WorkChannels({ onBack, onOpenAdmin, onCreateOrg, onOpenChannel, onOpenDirectory, onSearch, onOpenChannelPermissions }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const aegisId = identity?.aegisId ?? '';
  const { org, members, channels, fetchChannels, createChannel } = useWork();
  const onlineIds = useWorkPresence((s) => s.onlineIds);

  const [newChannelModal, setNewChannelModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [channelActionTarget, setChannelActionTarget] = useState<WorkChannel | null>(null);

  const isAdmin = org?.adminId === aegisId;

  // Derive my role for permission checks
  const myRole: WorkRole = (() => {
    if (org && aegisId === org.adminId) return 'owner';
    const me = members.find((m) => m.aegis_id === aegisId);
    return (me?.role as WorkRole | undefined) ?? 'member';
  })();
  const myPerms = getPermissions(myRole);

  const s = makeStyles(t);

  useEffect(() => {
    if (org?.orgId) void fetchChannels(org.orgId);
  }, [org?.orgId]);

  async function handleCreateChannel() {
    const name = newChannelName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name || !org || !aegisId) return;
    await createChannel(org.orgId, name, aegisId, false);
    setNewChannelModal(false);
    setNewChannelName('');
  }

  const selectedChannel = channels.find((c) => c.channelId === selectedChannelId);

  // No org yet — guide the user to create one
  if (!org) {
    return (
      <View style={[s.root, { paddingTop: insets.top, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 32 }]}>
        <View style={[s.orgMark, { width: 56, height: 56, borderRadius: 16 }]}>
          <I.Shield size={28} color={t.accent} />
        </View>
        <Text style={[s.orgName, { fontSize: 20, textAlign: 'center' }]}>AegisLink Work</Text>
        <Text style={[s.orgSub, { fontSize: 12, letterSpacing: 0, color: t.textDim, textAlign: 'center', lineHeight: 18 }]}>
          Crea tu organización para tener canales de equipo, invitar miembros y comunicarte de forma segura.
        </Text>
        <Pressable onPress={onCreateOrg ?? onOpenAdmin} style={[s.modalBtnConfirm, { paddingHorizontal: 28, marginTop: 8 }]}>
          <Text style={{ fontFamily: t.font, fontWeight: '700', color: t.bg, fontSize: 15 }}>Crear organización</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <View style={s.orgMark}>
            <I.Shield size={16} color={t.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.orgName} numberOfLines={1}>{org.name}</Text>
            <Text style={s.orgSub}>WORK</Text>
          </View>
        </View>
        <View style={s.headerRight}>
          <Pressable
            onPress={onSearch}
            hitSlop={8}
            accessibilityLabel="Buscar en workspace"
            accessibilityRole="button"
          >
            <I.Search size={20} color={t.textDim} />
          </Pressable>
          <Pressable
            onPress={onOpenDirectory}
            hitSlop={8}
            accessibilityLabel="Ver directorio de miembros"
            accessibilityRole="button"
          >
            <I.Users size={20} color={t.textDim} />
          </Pressable>
          {isAdmin && (
            <Pressable onPress={onOpenAdmin} hitSlop={8} accessibilityLabel="Administrar workspace" accessibilityRole="button">
              <I.Shield size={20} color={t.textDim} />
            </Pressable>
          )}
          <Pressable onPress={onBack} hitSlop={8} accessibilityLabel="Cerrar workspace" accessibilityRole="button">
            <I.X size={20} color={t.textDim} />
          </Pressable>
        </View>
      </View>

      {/* Content: if a channel is selected, show empty chat placeholder; else show list */}
      {selectedChannelId && selectedChannel ? (
        <View style={s.channelPlaceholder}>
          <Text style={s.channelHash}>#</Text>
          <Text style={s.channelPlaceholderName}>{selectedChannel.name}</Text>
          <Text style={s.channelPlaceholderSub}>
            {selectedChannel.isAnnouncements ? 'Solo admins pueden escribir' : 'Canal del equipo'}
          </Text>
          <Text style={[s.channelPlaceholderSub, { marginTop: 8, fontSize: 11 }]}>
            El chat de canales llega en la próxima iteración
          </Text>
          <Pressable onPress={() => setSelectedChannelId(null)} style={s.backBtn}>
            <Text style={s.backBtnText}>← Volver a canales</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}>
          {/* Channels section */}
          <View style={s.sectionHeader}>
            <Text style={s.sectionLabel}>CANALES</Text>
            {isAdmin && (
              <Pressable onPress={() => setNewChannelModal(true)} hitSlop={8}>
                <I.Plus size={15} color={t.textDim} />
              </Pressable>
            )}
          </View>

          {channels.length === 0 ? (
            <Text style={s.emptyText}>Sin canales</Text>
          ) : (
            channels.map((ch) => (
              <Pressable
                key={ch.channelId}
                style={s.channelRow}
                onPress={() => {
                  if (onOpenChannel) {
                    onOpenChannel(ch);
                  } else {
                    setSelectedChannelId(ch.channelId);
                  }
                }}
                onLongPress={() => setChannelActionTarget(ch)}
                delayLongPress={400}
                accessibilityLabel={`Canal ${ch.name}. Mantén pulsado para opciones.`}
              >
                <Text style={s.hash}>#</Text>
                <Text style={s.channelName}>{ch.name}</Text>
                {ch.isAnnouncements && (
                  <Text style={s.announceBadge}>ANUNCIOS</Text>
                )}
              </Pressable>
            ))
          )}

          {/* DMs section */}
          <View style={[s.sectionHeader, { marginTop: 8 }]}>
            <Text style={s.sectionLabel}>MENSAJES DIRECTOS</Text>
            {onOpenDirectory && (
              <Pressable
                onPress={onOpenDirectory}
                hitSlop={8}
                accessibilityLabel="Ver directorio completo"
                accessibilityRole="button"
              >
                <Text style={s.directoryLink}>Ver directorio →</Text>
              </Pressable>
            )}
          </View>

          {members.filter((m) => m.aegis_id !== aegisId).length === 0 ? (
            <Text style={s.emptyText}>Sin miembros</Text>
          ) : (
            members
              .filter((m) => m.aegis_id !== aegisId)
              .map((m) => {
                const avatarBg = '#' + m.aegis_id.replace(/-/g, '').slice(0, 6);
                const isOnline = onlineIds.has(m.aegis_id);
                return (
                  <Pressable
                    key={m.aegis_id}
                    style={s.dmRow}
                    onPress={onOpenDirectory}
                    accessibilityLabel={`Abrir DM con ${m.aegis_id.slice(0, 12)}`}
                    accessibilityRole="button"
                  >
                    {/* Avatar with initials */}
                    <View style={[s.dmAvatar, { backgroundColor: avatarBg }]}>
                      <Text style={s.dmAvatarText}>{m.aegis_id.replace(/-/g, '').slice(0, 2).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.dmName} numberOfLines={1}>{m.aegis_id.slice(0, 12)}…</Text>
                      <Text style={[s.dmRole, m.role === 'admin' && { color: t.accent }]}>{m.role.toUpperCase()}</Text>
                    </View>
                    {/* Presence dot */}
                    <View
                      style={[
                        s.presenceDot,
                        { backgroundColor: isOnline ? '#22c55e' : t.textFaint },
                      ]}
                      accessibilityLabel={isOnline ? 'Online' : 'Offline'}
                    />
                  </Pressable>
                );
              })
          )}
        </ScrollView>
      )}

      {/* Channel long-press action sheet */}
      <Modal
        visible={channelActionTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setChannelActionTarget(null)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setChannelActionTarget(null)}
        >
          <Pressable
            style={{
              backgroundColor: t.surface,
              borderTopLeftRadius: t.radius,
              borderTopRightRadius: t.radius,
              paddingBottom: 28,
              paddingTop: 8,
            }}
            onPress={() => {/* absorb */}}
          >
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.border }} />
            </View>
            {channelActionTarget && (
              <>
                <View style={{ paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: t.divider }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, fontWeight: '600' }}>
                    #{channelActionTarget.name}
                  </Text>
                  {channelActionTarget.isAnnouncements && (
                    <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginTop: 2 }}>
                      CANAL DE ANUNCIOS
                    </Text>
                  )}
                </View>
                <Pressable
                  onPress={() => {
                    if (onOpenChannel) onOpenChannel(channelActionTarget);
                    setChannelActionTarget(null);
                  }}
                  accessibilityLabel="Abrir canal"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: t.divider }}
                >
                  <I.Archive size={18} color={t.text} />
                  <Text style={{ fontFamily: t.font, fontSize: 15, color: t.text }}>Abrir canal</Text>
                </Pressable>
                {myPerms.canDeleteChannels && onOpenChannelPermissions && (
                  <Pressable
                    onPress={() => {
                      if (channelActionTarget) onOpenChannelPermissions(channelActionTarget);
                      setChannelActionTarget(null);
                    }}
                    accessibilityLabel="Permisos del canal"
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: t.divider }}
                  >
                    <I.Shield size={18} color={t.accent} />
                    <Text style={{ fontFamily: t.font, fontSize: 15, color: t.accent }}>Permisos del canal</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => setChannelActionTarget(null)}
                  accessibilityLabel="Cerrar menú"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16 }}
                >
                  <I.X size={18} color={t.textDim} />
                  <Text style={{ fontFamily: t.font, fontSize: 15, color: t.textDim }}>Cerrar</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* New channel modal */}
      <Modal visible={newChannelModal} transparent animationType="fade" onRequestClose={() => setNewChannelModal(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <Text style={s.modalTitle}>Nuevo canal</Text>
            <TextInput
              value={newChannelName}
              onChangeText={setNewChannelName}
              placeholder="nombre-del-canal"
              placeholderTextColor={t.textDim}
              autoCapitalize="none"
              autoFocus
              style={s.modalInput}
            />
            <View style={s.modalBtns}>
              <Pressable onPress={() => { setNewChannelModal(false); setNewChannelName(''); }} style={s.modalBtnCancel}>
                <Text style={{ fontFamily: t.font, color: t.text }}>Cancelar</Text>
              </Pressable>
              <Pressable onPress={() => void handleCreateChannel()} style={s.modalBtnConfirm}>
                <Text style={{ fontFamily: t.font, fontWeight: '700', color: t.bg }}>Crear</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(t: import('../theme/vault').Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
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
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    orgMark: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: t.accentDeep,
      alignItems: 'center',
      justifyContent: 'center',
    },
    orgName: {
      fontFamily: t.fontDisplay,
      fontSize: 15,
      fontWeight: '700',
      color: t.text,
    },
    orgSub: {
      fontFamily: t.fontMono,
      fontSize: 9,
      color: t.textFaint,
      letterSpacing: 1.5,
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 18,
      paddingBottom: 6,
    },
    sectionLabel: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      letterSpacing: 1.2,
    },
    channelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    hash: {
      fontFamily: t.fontMono,
      fontSize: 16,
      color: t.textDim,
      width: 16,
    },
    channelName: {
      fontFamily: t.font,
      fontSize: 15,
      color: t.text,
      flex: 1,
    },
    announceBadge: {
      fontFamily: t.fontMono,
      fontSize: 9,
      color: t.textFaint,
      letterSpacing: 0.8,
    },
    dmRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    dmAvatar: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: t.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dmAvatarText: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.text,
    },
    dmName: {
      fontFamily: t.fontMono,
      fontSize: 13,
      color: t.text,
      flex: 1,
    },
    dmRole: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
    },
    emptyText: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textFaint,
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    directoryLink: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.accent,
      letterSpacing: 0.3,
    },
    presenceDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      flexShrink: 0,
    },
    channelPlaceholder: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 32,
    },
    channelHash: {
      fontFamily: t.fontMono,
      fontSize: 36,
      color: t.textFaint,
    },
    channelPlaceholderName: {
      fontFamily: t.fontDisplay,
      fontSize: 22,
      fontWeight: '700',
      color: t.text,
    },
    channelPlaceholderSub: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textDim,
      textAlign: 'center',
    },
    backBtn: {
      marginTop: 16,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    backBtnText: {
      fontFamily: t.fontMono,
      fontSize: 12,
      color: t.accent,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    modalBox: {
      backgroundColor: t.surface,
      borderRadius: t.radius,
      padding: 20,
      gap: 14,
    },
    modalTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 17,
      fontWeight: '600',
      color: t.text,
    },
    modalInput: {
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: t.radiusS,
      padding: 12,
    },
    modalBtns: { flexDirection: 'row', gap: 8 },
    modalBtnCancel: {
      flex: 1,
      borderWidth: 1,
      borderColor: t.borderStrong,
      borderRadius: t.radiusS,
      paddingVertical: 11,
      alignItems: 'center',
    },
    modalBtnConfirm: {
      flex: 1,
      backgroundColor: t.accent,
      borderRadius: t.radiusS,
      paddingVertical: 11,
      alignItems: 'center',
    },
  });
}
