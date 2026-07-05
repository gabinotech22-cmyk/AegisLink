import { useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { withPickingGuard } from '../utils/pickingGuard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { BrandedQR } from '../components/BrandedQR';
import { AvatarCropModal } from '../components/AvatarCropModal';
import { ContactPickerSheet } from '../components/ContactPickerSheet';
import { FloatingMenu, type FloatingMenuItem } from '../components/FloatingMenu';
import { ShareLinkSheet } from '../components/ShareLinkSheet';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { useGroups } from '../store/groups';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { encodeGroupInviteLinkUniversal } from '../crypto/qr';
import { resolveRole, can, effectivePermissions, type GroupRole } from '../crypto/groupRoles';
import type { StoredGroup } from '../db/local';
import { themedAlert } from '../components/AlertHost';

interface Props {
  group: StoredGroup;
  onBack: () => void;
  /** Owner/moderators: open the scheduled posts (compose + queue) screen. */
  onOpenPosts?: () => void;
}

export function GroupAdminScreen({ group: groupProp, onBack, onOpenPosts }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { renameGroup, updateGroupAvatar, addMember, removeMember, setGroupPermission, setMemberRole, leaveGroup, dissolveGroup } = useGroups();
  const contacts = useContacts((s) => s.contacts);
  const identity = useIdentity((s) => s.identity);
  const myAvatarImage = useIdentity((s) => s.avatarImage);
  const myAvatarColor = useIdentity((s) => s.avatarColor);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(groupProp.name);
  const [cropSource, setCropSource] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);
  // aegisId of the member whose role/actions floating menu is open (owner only).
  const [roleMenuFor, setRoleMenuFor] = useState<string | null>(null);
  // Invite-link floating window (replaces the native OS share sheet).
  const [showShareLink, setShowShareLink] = useState(false);

  // Live group from store so edits reflect instantly
  const group = useGroups((s) => s.groups.find((g) => g.id === groupProp.id)) ?? groupProp;

  function getMemberName(aegisId: string) {
    if (aegisId === identity?.aegisId) return i18nT('groupAdmin.youLabel');
    return contacts.find((c) => c.aegisId === aegisId)?.name ?? aegisId.slice(0, 8) + '…';
  }

  function getMemberColor(aegisId: string) {
    if (aegisId === identity?.aegisId) return myAvatarColor || t.accent;
    return contacts.find((c) => c.aegisId === aegisId)?.color ?? t.surface3;
  }

  function getMemberAvatar(aegisId: string) {
    // Own row uses the profile avatar — contacts never contains self.
    if (aegisId === identity?.aegisId) return myAvatarImage ?? undefined;
    return contacts.find((c) => c.aegisId === aegisId)?.avatarImage;
  }

  function getMemberSeed(aegisId: string) {
    if (aegisId === identity?.aegisId) return identity?.publicKeyB64 ?? aegisId;
    return contacts.find((c) => c.aegisId === aegisId)?.publicKeyB64 ?? aegisId;
  }

  async function handleRename() {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === group.name) { setEditingName(false); return; }
    await renameGroup(group.id, trimmed);
    setEditingName(false);
  }

  async function handlePickGroupAvatar() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      themedAlert(i18nT('groups.permissionDeniedTitle', 'Permiso denegado'), i18nT('groups.permissionDeniedGallery', 'Se necesita acceso a la galería.'));
      return;
    }
    // Pick WITHOUT the native crop editor (allowsEditing) — its confirm
    // checkmark is unlabeled/missing on some devices. Hand off to the in-app
    // AvatarCropModal which has an explicit Confirm button (same as the
    // personal avatar flow).
    const result = await withPickingGuard(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as ImagePicker.MediaType[],
        quality: 0.8,
      })
    );
    if (!result.canceled && result.assets && result.assets.length > 0) {
      const asset = result.assets[0];
      setCropSource({ uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 });
    }
  }

  // Called when the user confirms the crop in AvatarCropModal — produces the
  // final compressed group avatar and persists it.
  async function handleConfirmGroupAvatar(uri: string) {
    setCropSource(null);
    try {
      const compressed = await manipulateAsync(
        uri,
        [{ resize: { width: 256 } }],
        { compress: 0.7, format: SaveFormat.JPEG }
      );
      await updateGroupAvatar(group.id, compressed.uri);
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }

  function handleAddMember() {
    setShowAddMember(true);
  }

  function handleRemoveMember(aegisId: string) {
    if (aegisId === identity?.aegisId) {
      const isAdmin = !!identity && identity.aegisId === group.adminId;
      // The group admin "leaving" actually DISSOLVES the group for everyone —
      // a plain leaveGroup would only wipe it locally and silently strand every
      // other member in a group whose creator vanished. Non-admins keep the
      // original leave-only flow (they lack the signing key to dissolve).
      themedAlert(
        isAdmin ? i18nT('groupAdmin.dissolveGroupTitle') : i18nT('groupAdmin.leaveGroupTitle'),
        isAdmin ? i18nT('groupAdmin.dissolveGroupDesc') : i18nT('groupAdmin.leaveGroupDesc'),
        [
          { text: i18nT('common.cancel'), style: 'cancel' },
          {
            text: isAdmin ? i18nT('groupAdmin.dissolveAndDelete') : i18nT('groupAdmin.leaveAndDelete'),
            style: 'destructive',
            onPress: () => {
              if (isAdmin) void dissolveGroup(group.id);
              else void leaveGroup(group.id);
              onBack();
            },
          },
        ],
      );
      return;
    }
    const name = getMemberName(aegisId);
    themedAlert(i18nT('groupAdmin.removeMemberTitle', { name }), i18nT('groupAdmin.removeMemberDesc'), [
      { text: i18nT('common.cancel'), style: 'cancel' },
      { text: i18nT('common.delete'), style: 'destructive', onPress: () => void removeMember(group.id, aegisId) },
    ]);
  }

  const isMe = (aegisId: string) => aegisId === identity?.aegisId;
  const me = identity?.aegisId;
  // Only the group creator (adminId) signs governance, so role/permission
  // changes are owner-only. amIAdmin == "am I the owner" (kept name to minimize
  // churn). Action gates below derive from can() so they honor the configured
  // permission scopes, not just ownership.
  const amIAdmin = !!identity && identity.aegisId === group.adminId;
  const canEdit = !!me && can(group, me, 'editInfo');
  const canInvite = !!me && can(group, me, 'invite');

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('groupAdmin.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {/* Header */}
        <View style={{ alignItems: 'center', paddingHorizontal: 22, paddingTop: 14, paddingBottom: 18 }}>
          <Pressable
            onPress={canEdit ? () => void handlePickGroupAvatar() : undefined}
            disabled={!canEdit}
            accessibilityLabel={i18nT('groupAdmin.changeAvatar', 'Cambiar imagen del grupo')}
          >
            {group.avatarImage ? (
              <Image
                source={{ uri: group.avatarImage }}
                style={{ width: 76, height: 76, borderRadius: t.radiusL }}
                resizeMode="cover"
              />
            ) : (
              // Match the generated avatar shown in the Groups list / chat header
              // (identicon seeded by the group id), instead of a generic icon that
              // looked "empty" compared to everywhere else the group appears.
              <Avatar
                t={t}
                name={group.name}
                color={group.avatarColor || t.accent}
                size={76}
                seed={group.id}
              />
            )}
            {canEdit && (
              <View
                style={{
                  position: 'absolute',
                  right: -2,
                  bottom: -2,
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: t.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 2,
                  borderColor: t.bg,
                }}
              >
                <I.Image size={13} color={t.accentInk} />
              </View>
            )}
          </Pressable>

          {editingName && canEdit ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <TextInput
                value={nameInput}
                onChangeText={setNameInput}
                autoFocus
                style={{
                  fontFamily: t.fontDisplay,
                  fontSize: 20,
                  fontWeight: '600',
                  color: t.text,
                  borderBottomWidth: 2,
                  borderBottomColor: t.accent,
                  minWidth: 120,
                  paddingVertical: 2,
                }}
                onSubmitEditing={handleRename}
              />
              <Pressable onPress={handleRename} hitSlop={8}>
                <I.Check size={22} color={t.accent} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={canEdit ? () => { setNameInput(group.name); setEditingName(true); } : undefined}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}
            >
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text }}>
                {group.name}
              </Text>
              {canEdit && <I.Settings size={14} color={t.textDim} />}
            </Pressable>
          )}

          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5, marginTop: 4 }}>
            {i18nT('groupAdmin.e2eeGroupBadge', { count: group.members.length })}
          </Text>
        </View>

        {/* Members */}
        <Section t={t} label={i18nT('groupAdmin.membersSection', { count: group.members.length }).toUpperCase()}>
          {group.members.map((aegisId, i) => {
            const name = getMemberName(aegisId);
            const color = getMemberColor(aegisId);
            const avatarImg = getMemberAvatar(aegisId);
            const me = isMe(aegisId);
            return (
              <View
                key={aegisId}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderBottomWidth: i < group.members.length - 1 ? 1 : 0,
                  borderBottomColor: t.divider,
                }}
              >
                <Avatar t={t} name={avatarImg || name} color={color} size={38} photoUri={avatarImg} seed={getMemberSeed(aegisId)} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontFamily: me ? t.font : (/^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(name) ? t.fontMono : t.font), fontWeight: '600', fontSize: 14, color: t.text }}>
                      {name}
                    </Text>
                    {(() => {
                      // Role resolved from the (signed) governance state — owner,
                      // admin, mod or member. Pill style mirrors the prototype
                      // RoleBadge (bordered, by-role palette).
                      const role: GroupRole = resolveRole(group, aegisId);
                      const palette =
                        role === 'owner' ? t.accent
                        : role === 'admin' ? t.accent
                        : role === 'mod' ? t.warn
                        : t.textDim;
                      const label =
                        role === 'owner' ? i18nT('groupAdmin.roleOwner', 'OWNER')
                        : role === 'admin' ? i18nT('groupAdmin.roleAdmin')
                        : role === 'mod' ? i18nT('groupAdmin.roleMod')
                        : i18nT('groupAdmin.roleMember');
                      return (
                        <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 99, borderWidth: 1, borderColor: `${palette}66` }}>
                          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: palette, letterSpacing: 0.8 }}>{label}</Text>
                        </View>
                      );
                    })()}
                  </View>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginTop: 2, letterSpacing: 0.4 }}>
                    {me ? i18nT('groupAdmin.youTag') : aegisId.slice(0, 16) + '…'}
                  </Text>
                </View>
                {!me && amIAdmin && (
                  <Pressable
                    onPress={() => setRoleMenuFor(aegisId)}
                    hitSlop={8}
                    style={{ padding: 6 }}
                    accessibilityLabel={i18nT('groupAdmin.manageMember', 'Gestionar miembro')}
                  >
                    <I.More size={18} color={t.textDim} />
                  </Pressable>
                )}
              </View>
            );
          })}

          {/* Add member — gated by the whoCanInvite permission scope (can()). */}
          {canInvite && (
          <Pressable
            onPress={handleAddMember}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 12,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                backgroundColor: t.surface2,
                borderWidth: 1,
                borderColor: `${t.accent}66`,
                borderStyle: 'dashed',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.Plus size={20} color={t.accent} />
            </View>
            <Text style={{ flex: 1, fontFamily: t.font, fontSize: 14, fontWeight: '500', color: t.accent }}>
              {i18nT('groupAdmin.addMember')}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>
              {i18nT('groupAdmin.fromContacts').toUpperCase()}
            </Text>
          </Pressable>
          )}
        </Section>

        {/* Scheduled posts — owner & moderators only (design: entry from Group info) */}
        {(amIAdmin || (!!identity && (group.moderators?.includes(identity.aegisId) ?? false))) && onOpenPosts && (
          <Section t={t} label={i18nT('groupPosts.adminSection', 'Publicaciones').toUpperCase()}>
            <Pressable
              onPress={onOpenPosts}
              accessibilityRole="button"
              accessibilityLabel={i18nT('groupPosts.entryLabel', 'Publicaciones programadas')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 12,
                paddingHorizontal: 14, paddingVertical: 12,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View style={{
                width: 34, height: 34, borderRadius: t.radiusS,
                backgroundColor: `${t.accent}18`,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <I.Timer size={17} color={t.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>
                  {i18nT('groupPosts.entryLabel', 'Publicaciones programadas')}
                </Text>
                <Text style={{ fontFamily: t.font, fontSize: 11.5, color: t.textDim, marginTop: 1 }}>
                  {i18nT('groupPosts.entrySub', 'Anuncios con fecha y hora · solo admins')}
                </Text>
              </View>
              <I.Chevron size={16} color={t.textFaint} />
            </Pressable>
          </Section>
        )}

        {/* Permissions — owner-only (only the owner signs governance). Each
            toggle maps a permission gate: ON = 'admins', OFF = 'everyone'. */}
        {amIAdmin && (() => {
          const perms = effectivePermissions(group);
          return (
            <Section t={t} label={i18nT('groupAdmin.permissionsSection').toUpperCase()}>
              <Toggle
                t={t}
                label={i18nT('groupAdmin.adminOnlyInviteLabel')}
                sub={i18nT('groupAdmin.adminOnlyInviteSub')}
                value={perms.whoCanInvite === 'admins'}
                onChange={(v) => void setGroupPermission(group.id, { whoCanInvite: v ? 'admins' : 'everyone' })}
              />
              <Toggle
                t={t}
                label={i18nT('groupAdmin.permCallLabel')}
                sub={i18nT('groupAdmin.permCallSub')}
                value={perms.whoCanCall === 'admins'}
                onChange={(v) => void setGroupPermission(group.id, { whoCanCall: v ? 'admins' : 'everyone' })}
              />
              <Toggle
                t={t}
                label={i18nT('groupAdmin.permSendLabel')}
                sub={i18nT('groupAdmin.permSendSub')}
                value={perms.whoCanSend === 'admins'}
                onChange={(v) => void setGroupPermission(group.id, { whoCanSend: v ? 'admins' : 'everyone' })}
              />
              <Toggle
                t={t}
                label={i18nT('groupAdmin.permEditLabel')}
                sub={i18nT('groupAdmin.permEditSub')}
                value={perms.whoCanEditInfo === 'admins'}
                onChange={(v) => void setGroupPermission(group.id, { whoCanEditInfo: v ? 'admins' : 'everyone' })}
                noBorder
              />
            </Section>
          );
        })()}

        {/* Invite link — follows the whoCanInvite permission scope. */}
        {canInvite && (
          <Section t={t} label={i18nT('groupAdmin.inviteLinkSection').toUpperCase()}>
            <Pressable
              onPress={() => {
                if (!group.adminId) return;
                // Open our in-app floating window instead of the native OS
                // share sheet; the native picker is reachable from inside it.
                setShowShareLink(true);
              }}
              accessibilityLabel={i18nT('groupAdmin.shareInviteLink')}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                paddingHorizontal: 16,
                paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <I.Link size={18} color={t.accent} />
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontFamily: t.font,
                    fontSize: 15,
                    color: t.accent,
                    fontWeight: '500',
                  }}
                >
                  {i18nT('groupAdmin.shareInviteLink')}
                </Text>
                <Text
                  style={{
                    fontFamily: t.font,
                    fontSize: 12,
                    color: t.textDim,
                    marginTop: 2,
                  }}
                >
                  {i18nT('groupAdmin.shareInviteLinkSub')}
                </Text>
              </View>
            </Pressable>

            {/* QR code — scan to join. Payload travels in the URL fragment,
                same zero-metadata https form used by Share above. */}
            {group.adminId && (
              <View
                style={{ alignItems: 'center', paddingHorizontal: 16, paddingBottom: 18, paddingTop: 2 }}
                accessibilityLabel={i18nT('groupAdmin.inviteQrLabel')}
              >
                <View
                  style={{
                    padding: 16,
                    backgroundColor: '#fff',
                    borderRadius: t.radius,
                  }}
                >
                  <BrandedQR
                    value={encodeGroupInviteLinkUniversal(group.id, group.name, group.adminId)}
                    size={180}
                  />
                </View>
                <Text
                  style={{
                    fontFamily: t.font,
                    fontSize: 12,
                    color: t.textDim,
                    textAlign: 'center',
                    marginTop: 10,
                    lineHeight: 18,
                  }}
                >
                  {i18nT('groupAdmin.inviteQrSub')}
                </Text>
              </View>
            )}
          </Section>
        )}

        {/* Danger */}
        <Section t={t} label={i18nT('groupAdmin.dangerZone').toUpperCase()}>
          <Pressable
            onPress={() => handleRemoveMember(identity?.aegisId ?? '')}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              paddingHorizontal: 16,
              paddingVertical: 14,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <I.X size={18} color={t.danger} />
            <Text style={{ flex: 1, fontFamily: t.font, fontSize: 15, color: t.danger, fontWeight: '500' }}>
              {i18nT('groupAdmin.deleteGroup')}
            </Text>
          </Pressable>
        </Section>
      </ScrollView>

      <AvatarCropModal
        t={t}
        visible={cropSource !== null}
        imageUri={cropSource?.uri ?? null}
        imageWidth={cropSource?.width ?? 0}
        imageHeight={cropSource?.height ?? 0}
        title={i18nT('groupAdmin.changeAvatar', 'Cambiar imagen del grupo')}
        confirmLabel={i18nT('common.confirm', 'Confirmar')}
        cancelLabel={i18nT('common.cancel', 'Cancelar')}
        onCancel={() => setCropSource(null)}
        onConfirm={(uri) => { void handleConfirmGroupAvatar(uri); }}
      />

      {/* Invite link — in-app floating window (matches the long-press menu). */}
      <ShareLinkSheet
        visible={showShareLink}
        onClose={() => setShowShareLink(false)}
        title={i18nT('groupAdmin.shareInviteLink')}
        link={group.adminId ? encodeGroupInviteLinkUniversal(group.id, group.name, group.adminId) : ''}
      />

      {/* Member role/actions — floating Vault menu (owner only). */}
      <FloatingMenu
        t={t}
        visible={roleMenuFor !== null}
        onClose={() => setRoleMenuFor(null)}
        title={roleMenuFor ? getMemberName(roleMenuFor) : undefined}
        subtitle={roleMenuFor ? i18nT(`groupAdmin.role${resolveRole(group, roleMenuFor).charAt(0).toUpperCase()}${resolveRole(group, roleMenuFor).slice(1)}`) : undefined}
        items={((): FloatingMenuItem[] => {
          if (!roleMenuFor) return [];
          const target = roleMenuFor;
          const current = resolveRole(group, target);
          const items: FloatingMenuItem[] = [];
          if (current !== 'admin') {
            items.push({ key: 'admin', icon: <I.Shield size={18} color={t.accent} />, label: i18nT('groupAdmin.makeAdmin'), onPress: () => void setMemberRole(group.id, target, 'admin') });
          }
          if (current !== 'mod') {
            items.push({ key: 'mod', icon: <I.Star size={18} color={t.warn} />, label: i18nT('groupAdmin.makeModerator'), onPress: () => void setMemberRole(group.id, target, 'mod') });
          }
          if (current !== 'member') {
            items.push({ key: 'member', icon: <I.User size={18} color={t.textDim} />, label: i18nT('groupAdmin.makeMember'), onPress: () => void setMemberRole(group.id, target, 'member') });
          }
          items.push({ key: 'remove', icon: <I.X size={18} color={t.danger} />, label: i18nT('groupAdmin.removeFromGroup'), danger: true, onPress: () => handleRemoveMember(target) });
          return items;
        })()}
      />

      {/* Add member — Vault bottom sheet, NOT a native Alert. */}
      <ContactPickerSheet
        t={t}
        visible={showAddMember}
        contacts={contacts.filter((c) => !group.members.includes(c.aegisId))}
        title={`${i18nT('groupAdmin.addMemberTitle')} · ${i18nT('groupAdmin.fromContacts')}`}
        emptyText={i18nT('groupAdmin.noContactsDesc')}
        onClose={() => setShowAddMember(false)}
        onPick={(c) => {
          setShowAddMember(false);
          // addMember throws 'group_member_limit' past MAX_GROUP_MEMBERS (1024);
          // surface it instead of leaking an unhandled rejection.
          void (async () => {
            try {
              await addMember(group.id, c.aegisId);
            } catch (e) {
              const msg = (e as Error).message === 'group_member_limit'
                ? i18nT('groupAdmin.memberLimitReached', 'Este grupo alcanzó el máximo de 1024 miembros.')
                : (e as Error).message;
              themedAlert(i18nT('common.error', 'Error'), msg);
            }
          })();
        }}
      />
    </View>
  );
}

void ({} as Theme); // keep import
