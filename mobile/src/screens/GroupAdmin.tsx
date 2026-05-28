import { useState } from 'react';
import { View, Text, Pressable, ScrollView, Alert, TextInput, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { useGroups } from '../store/groups';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import type { StoredGroup } from '../db/local';

interface Props {
  group: StoredGroup;
  onBack: () => void;
}

export function GroupAdminScreen({ group: groupProp, onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { renameGroup, addMember, removeMember, updateGroupPermissions, leaveGroup } = useGroups();
  const contacts = useContacts((s) => s.contacts);
  const identity = useIdentity((s) => s.identity);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(groupProp.name);

  // Live group from store so edits reflect instantly
  const group = useGroups((s) => s.groups.find((g) => g.id === groupProp.id)) ?? groupProp;

  function getMemberName(aegisId: string) {
    if (aegisId === identity?.aegisId) return i18nT('groupAdmin.youLabel');
    return contacts.find((c) => c.aegisId === aegisId)?.name ?? aegisId.slice(0, 8) + '…';
  }

  function getMemberColor(aegisId: string) {
    if (aegisId === identity?.aegisId) return t.accent;
    return contacts.find((c) => c.aegisId === aegisId)?.color ?? t.surface3;
  }

  function getMemberAvatar(aegisId: string) {
    if (aegisId === identity?.aegisId) return undefined;
    return contacts.find((c) => c.aegisId === aegisId)?.avatarImage;
  }

  async function handleRename() {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === group.name) { setEditingName(false); return; }
    await renameGroup(group.id, trimmed);
    setEditingName(false);
  }

  function handleAddMember() {
    const eligible = contacts.filter((c) => !group.members.includes(c.aegisId));
    if (eligible.length === 0) {
      Alert.alert(i18nT('groupAdmin.noContactsTitle'), i18nT('groupAdmin.noContactsDesc'));
      return;
    }
    Alert.alert(
      i18nT('groupAdmin.addMemberTitle'),
      i18nT('groupAdmin.addMemberDesc'),
      [
        ...eligible.slice(0, 5).map((c) => ({
          text: c.name,
          onPress: () => void addMember(group.id, c.aegisId),
        })),
        { text: i18nT('common.cancel'), style: 'cancel' as const },
      ]
    );
  }

  function handleRemoveMember(aegisId: string) {
    if (aegisId === identity?.aegisId) {
      Alert.alert(i18nT('groupAdmin.leaveGroupTitle'), i18nT('groupAdmin.leaveGroupDesc'), [
        { text: i18nT('common.cancel'), style: 'cancel' },
        {
          text: i18nT('groupAdmin.leaveAndDelete'),
          style: 'destructive',
          onPress: () => {
            void leaveGroup(group.id);
            onBack();
          },
        },
      ]);
      return;
    }
    const name = getMemberName(aegisId);
    Alert.alert(i18nT('groupAdmin.removeMemberTitle', { name }), i18nT('groupAdmin.removeMemberDesc'), [
      { text: i18nT('common.cancel'), style: 'cancel' },
      { text: i18nT('common.delete'), style: 'destructive', onPress: () => void removeMember(group.id, aegisId) },
    ]);
  }

  const isMe = (aegisId: string) => aegisId === identity?.aegisId;
  // Only the group creator (adminId) has admin privileges — not every member
  // who views the screen. amIAdmin drives all permission gates below.
  const amIAdmin = !!identity && identity.aegisId === group.adminId;

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
          {group.avatarImage ? (
            <Image
              source={{ uri: group.avatarImage }}
              style={{ width: 76, height: 76, borderRadius: t.radiusL }}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                width: 76,
                height: 76,
                borderRadius: t.radiusL,
                backgroundColor: `${group.avatarColor ?? t.accent}22`,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.Users size={34} color={group.avatarColor ?? t.accent} />
            </View>
          )}

          {editingName && amIAdmin ? (
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
              onPress={amIAdmin ? () => { setNameInput(group.name); setEditingName(true); } : undefined}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}
            >
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text }}>
                {group.name}
              </Text>
              {amIAdmin && <I.Settings size={14} color={t.textDim} />}
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
                <Avatar t={t} name={avatarImg || name} color={color} size={38} photoUri={avatarImg} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontFamily: me ? t.font : (/^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(name) ? t.fontMono : t.font), fontWeight: '600', fontSize: 14, color: t.text }}>
                      {name}
                    </Text>
                    {(() => {
                      // isAdmin is true only for the actual admin — NOT for "me" viewing the screen
                      const isAdmin = group.adminId === aegisId;
                      const isMod = !isAdmin && group.moderators?.includes(aegisId);
                      if (isAdmin) return (
                        <View style={{ backgroundColor: t.surface2, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 }}>
                          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent }}>{i18nT('groupAdmin.roleAdmin')}</Text>
                        </View>
                      );
                      if (isMod) return (
                        <View style={{ backgroundColor: t.surface2, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 }}>
                          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.warn }}>{i18nT('groupAdmin.roleMod')}</Text>
                        </View>
                      );
                      return (
                        <View style={{ backgroundColor: t.surface2, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 }}>
                          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim }}>{i18nT('groupAdmin.roleMember')}</Text>
                        </View>
                      );
                    })()}
                  </View>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginTop: 2, letterSpacing: 0.4 }}>
                    {me ? i18nT('groupAdmin.youTag') : aegisId.slice(0, 16) + '…'}
                  </Text>
                </View>
                {!me && amIAdmin && (
                  <Pressable onPress={() => handleRemoveMember(aegisId)} hitSlop={8} style={{ padding: 6 }}>
                    <I.X size={16} color={t.textDim} />
                  </Pressable>
                )}
              </View>
            );
          })}

          {/* Add member — only admin can invite when adminOnlyInvite is on */}
          {(amIAdmin || !group.adminOnlyInvite) && (
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

        {/* Permissions — only admin can change these */}
        {amIAdmin && (
        <Section t={t} label={i18nT('groupAdmin.permissionsSection').toUpperCase()}>
          <Toggle
            t={t}
            label={i18nT('groupAdmin.adminOnlyInviteLabel')}
            sub={i18nT('groupAdmin.adminOnlyInviteSub')}
            value={group.adminOnlyInvite !== false}
            onChange={(v) => void updateGroupPermissions(group.id, { adminOnlyInvite: v })}
          />
          <Toggle
            t={t}
            label={i18nT('groupAdmin.moderateNewMembersLabel')}
            sub={i18nT('groupAdmin.moderateNewMembersSub')}
            value={group.moderateNewMembers === true}
            onChange={(v) => void updateGroupPermissions(group.id, { moderateNewMembers: v })}
            noBorder
          />
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
    </View>
  );
}

void ({} as Theme); // keep import
