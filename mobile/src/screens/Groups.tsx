import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, FlatList, Modal, useWindowDimensions } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { withPickingGuard } from '../utils/pickingGuard';
import { previewLabel } from '../utils/messagePreview';
import { ConstellationVisual } from '../components/ConstellationVisual';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { TabBar, type Tab } from '../components/TabBar';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { AvatarCropModal } from '../components/AvatarCropModal';
import { ChannelsPanel } from './ChannelsPanel';
import { FloatingMenu } from '../components/FloatingMenu';
import type { Theme } from '../theme/vault';
import { useGroups, LARGE_GROUP_THRESHOLD } from '../store/groups';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { useMessages } from '../store/messages';
import { sendGroupMessage } from '../socket/client';
import { parseGroupInviteLink } from '../crypto/qr';
import type { StoredGroup } from '../db/local';
import { themedAlert } from '../components/AlertHost';


interface Props {
  onTab: (tab: Tab) => void;
  onOpenGroupChat: (group: StoredGroup) => void;
  onJoinByLink?: (groupId: string, groupName: string, adminId: string) => void;
  /** Channels segment navigation (sealed public channels live inside this tab). */
  onOpenChannel?: (channelId: string) => void;
  onDiscoverChannels?: () => void;
  onCreateChannel?: () => void;
  /**
   * Which segment to show on mount. The host (App) remembers the last segment
   * so that coming back from a pushed channel screen (which unmounts this
   * screen) lands on Channels again instead of resetting to Groups.
   */
  initialSeg?: 'groups' | 'channels';
  onSegChange?: (seg: 'groups' | 'channels') => void;
}

const GROUP_COLORS = [
  '#05b875', // Emerald
  '#8b5cf6', // Purple
  '#3b82f6', // Blue
  '#ec4899', // Pink
  '#f97316', // Orange
  '#eab308', // Gold
  '#06b6d4', // Cyan
];

const GROUP_EMOJIS = [
  { label: 'Inicial', val: undefined },
  { label: 'Grupo', val: '👥' },
  { label: 'Chat', val: '💬' },
  { label: 'Rayo', val: '⚡' },
  { label: 'Escudo', val: '🛡️' },
  { label: 'Candado', val: '🔒' },
  { label: 'Robot', val: '🤖' },
  { label: 'Fuego', val: '🔥' },
  { label: 'Corona', val: '👑' },
  { label: 'Cubo', val: '🧊' },
];

export function GroupsScreen({ onTab, onOpenGroupChat, onJoinByLink, onOpenChannel, onDiscoverChannels, onCreateChannel, initialSeg, onSegChange }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const { contacts } = useContacts();
  const { groups, hydrate, createGroup, leaveGroup, acceptGroupInvite } = useGroups();
  // Pending invitations are surfaced separately from joined groups (consent flow).
  const pendingInvites = groups.filter((g) => g.pending);
  const activeGroups = groups.filter((g) => !g.pending);
  const previews = useMessages((s) => s.previews);
  const unreadCounts = useMessages((s) => s.unreadCounts);

  const { width: screenWidth } = useWindowDimensions();
  const swipeRef = useRef<ScrollView>(null);
  const [seg, setSegState] = useState<'groups' | 'channels'>(initialSeg ?? 'groups');
  const setSeg = useCallback((s: 'groups' | 'channels') => {
    setSegState(s);
    onSegChange?.(s);
  }, [onSegChange]);

  // Restore the pager position when mounting straight onto Channels (e.g.
  // returning from a pushed channel screen). No animation: it's the initial state.
  useEffect(() => {
    if ((initialSeg ?? 'groups') === 'channels') {
      swipeRef.current?.scrollTo({ x: screenWidth, animated: false });
    }
    // Mount-only: later seg changes are driven by taps/swipes below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tap on segment control -> scroll the horizontal pager. */
  const handleSegTap = useCallback((s: 'groups' | 'channels') => {
    setSeg(s);
    swipeRef.current?.scrollTo({ x: s === 'channels' ? screenWidth : 0, animated: true });
  }, [screenWidth, setSeg]);
  const [isCreating, setIsCreating] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [groupColor, setGroupColor] = useState('#05b875');
  const [groupImage, setGroupImage] = useState<string | undefined>(undefined);
  const [cropSource, setCropSource] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinLinkInput, setJoinLinkInput] = useState('');
  const [menuGroup, setMenuGroup] = useState<StoredGroup | null>(null);
  // Pending invite whose Accept/Decline floating menu is open.
  const [inviteMenuFor, setInviteMenuFor] = useState<StoredGroup | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Handle contact toggle for group creation
  function toggleContact(contactId: string) {
    if (selectedContacts.includes(contactId)) {
      setSelectedContacts(selectedContacts.filter((id) => id !== contactId));
    } else {
      setSelectedContacts([...selectedContacts, contactId]);
    }
  }

  async function handlePickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      themedAlert(i18nT('groups.permissionDeniedTitle'), i18nT('groups.permissionDeniedGallery'));
      return;
    }
    // Pick WITHOUT the native crop editor — hand off to AvatarCropModal which
    // has an explicit Confirm button (the native editor's checkmark is missing
    // on some devices).
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

  async function handleTakePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      themedAlert(i18nT('groups.permissionDeniedTitle'), i18nT('groups.permissionDeniedCamera'));
      return;
    }
    const result = await withPickingGuard(() =>
      ImagePicker.launchCameraAsync({
        mediaTypes: ['images'] as ImagePicker.MediaType[],
        quality: 0.8,
      })
    );
    if (!result.canceled && result.assets && result.assets.length > 0) {
      const asset = result.assets[0];
      setCropSource({ uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 });
    }
  }

  // Confirm from AvatarCropModal → compress to 256px and stage as group image.
  async function handleConfirmGroupImage(uri: string) {
    setCropSource(null);
    try {
      const compressed = await manipulateAsync(
        uri,
        [{ resize: { width: 256 } }],
        { compress: 0.7, format: SaveFormat.JPEG }
      );
      setGroupImage(compressed.uri);
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }

  // Handle creating group
  async function handleConfirmCreate() {
    if (!groupName.trim()) {
      themedAlert(i18nT('common.error'), i18nT('groups.errorCreateName'));
      return;
    }
    if (selectedContacts.length === 0) {
      themedAlert(i18nT('common.error'), i18nT('groups.errorCreateMembers'));
      return;
    }
    if (!identity) return;

    try {
      const allMembers = [identity.aegisId, ...selectedContacts];
      const newGroup = await createGroup(groupName.trim(), allMembers, groupColor, groupImage);
      
      // Send group initiation / welcome message to all members
      try {
        // Large groups use the v2 roster-by-reference wire format: content
        // messages omit the member list, so a welcome message alone can't
        // materialize the group on recipients (they'd drop it as an unknown
        // group). Push a metadata carrier first — it ships the full roster and
        // creates the group on every member; the welcome bubble then renders.
        if (allMembers.length > LARGE_GROUP_THRESHOLD) {
          const client = require('../socket/client') as typeof import('../socket/client');
          await client.broadcastGroupMetadata(identity, newGroup.id);
        }
        await sendGroupMessage({
          identity,
          groupId: newGroup.id,
          plaintext: `Group created: ${groupName}`,
        });
      } catch (e) {
        // Suppress initial multicast failures if offline, they'll sync later
      }

      setIsCreating(false);
      setGroupName('');
      setSelectedContacts([]);
      setGroupColor('#05b875');
      setGroupImage(undefined);
      themedAlert(i18nT('groups.createdSuccess'), i18nT('groups.createdSuccessDesc', { name: groupName }));
    } catch (err) {
      themedAlert(i18nT('common.error'), i18nT('groups.errorCreate'));
    }
  }

  // RENDER: Group Creation Flow
  if (isCreating) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
        <TopBar
          t={t}
          title={i18nT('groups.newGroup')}
          left={
            <Pressable
              onPress={() => {
                setIsCreating(false);
                setGroupName('');
                setSelectedContacts([]);
              }}
              hitSlop={8}
              style={{ padding: 4 }}
            >
              <I.ChevronL size={22} color={t.textDim} />
            </Pressable>
          }
        />

        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32 }}>
          {/* Group Details */}
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
            {i18nT('groups.nameLabel')}
          </Text>
          <TextInput
            placeholder={i18nT('groups.namePlaceholder')}
            placeholderTextColor={t.textDim}
            value={groupName}
            onChangeText={setGroupName}
            style={{
              fontFamily: t.font,
              fontSize: 16,
              color: t.text,
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.border,
              borderRadius: t.radius,
              paddingHorizontal: 16,
              paddingVertical: 12,
              marginBottom: 16,
            }}
          />

          {/* Group Avatar Preview */}
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
            {i18nT('groups.avatarPreviewLabel')}
          </Text>
          <View style={{ alignItems: 'center', padding: 14, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, marginBottom: 10 }}>
            <Avatar t={t} name={groupImage || (groupName.trim() || 'G')} color={groupColor} size={64} seed={groupName.trim() || 'new-group'} />
          </View>

          {/* Photo picking buttons */}
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'center', marginBottom: 20 }}>
            <Pressable
              onPress={handlePickImage}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: t.radiusS,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.borderStrong,
              }}
            >
              <I.Plus size={14} color={t.text} />
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>{i18nT('common.gallery')}</Text>
            </Pressable>
            <Pressable
              onPress={handleTakePhoto}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: t.radiusS,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.borderStrong,
              }}
            >
              <I.Video size={14} color={t.text} />
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>{i18nT('common.camera')}</Text>
            </Pressable>
            {groupImage && (
              <Pressable
                onPress={() => setGroupImage(undefined)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: t.radiusS,
                  backgroundColor: `${t.danger}15`,
                  borderWidth: 1,
                  borderColor: t.danger,
                }}
              >
                <I.Trash size={14} color={t.danger} />
                <Text style={{ fontFamily: t.font, fontSize: 12, color: t.danger }}>{i18nT('common.remove')}</Text>
              </Pressable>
            )}
          </View>

          {/* Group Color Selector */}
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
            {i18nT('groups.colorLabel')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
            {GROUP_COLORS.map((c) => {
              const isSel = groupColor === c;
              return (
                <Pressable
                  key={c}
                  onPress={() => setGroupColor(c)}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: c,
                    borderWidth: 2,
                    borderColor: isSel ? t.text : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {isSel && (
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />
                  )}
                </Pressable>
              );
            })}
          </View>

          {/* Group Avatar Emojis */}
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
            {i18nT('groups.iconLabel')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 6, marginBottom: 20 }}>
            {GROUP_EMOJIS.map((e) => {
              const isSel = groupImage === e.val;
              return (
                <Pressable
                  key={e.label}
                  onPress={() => setGroupImage(e.val)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: t.radiusS,
                    backgroundColor: isSel ? t.accent : t.surface,
                    borderWidth: 1,
                    borderColor: isSel ? t.accent : t.borderStrong,
                    minWidth: 50,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 13, color: isSel ? t.accentInk : t.text, fontFamily: t.font }}>
                    {e.val || 'G'}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* Member Selection */}
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
            {i18nT('groups.membersLabel', { count: selectedContacts.length })}
          </Text>

          {contacts.length === 0 ? (
            <View
              style={{
                padding: 24,
                backgroundColor: t.surface,
                borderRadius: t.radius,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: t.border,
                marginBottom: 24,
              }}
            >
              <I.Users size={24} color={t.textDim} style={{ marginBottom: 8 }} />
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center' }}>
                {i18nT('groups.emptyContactsDesc')}
              </Text>
            </View>
          ) : (
            <View style={{ gap: 4, marginBottom: 24 }}>
              {contacts.map((c) => {
                const isSelected = selectedContacts.includes(c.aegisId);
                return (
                  <Pressable
                    key={c.aegisId}
                    onPress={() => toggleContact(c.aegisId)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      padding: 12,
                      backgroundColor: isSelected ? `${t.accent}11` : t.surface,
                      borderWidth: 1,
                      borderColor: isSelected ? t.accent : t.border,
                      borderRadius: t.radius,
                    }}
                  >
                    <Avatar t={t} name={c.avatarImage || c.name} color={c.color ?? t.surface2} size={32} photoUri={c.avatarImage} seed={c.publicKeyB64 || c.aegisId} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>
                        {c.name}
                      </Text>
                      <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 1 }}>
                        {c.aegisId}
                      </Text>
                    </View>
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        borderWidth: 1.5,
                        borderColor: isSelected ? t.accent : t.borderStrong,
                        backgroundColor: isSelected ? t.accent : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isSelected && <I.Check size={12} color={t.accentInk} />}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Confirm Button */}
          <Pressable
            onPress={handleConfirmCreate}
            style={({ pressed }) => ({
              backgroundColor: t.accent,
              paddingVertical: 14,
              borderRadius: t.radius,
              alignItems: 'center',
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 15 }}>
              {i18nT('groups.createGroup')}
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // RENDER: Normal Group List Tab
  const channelsEnabled = !!onOpenChannel;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={seg === 'channels' ? i18nT('channels.title') : i18nT('groups.title')}
        big
        right={seg === 'groups' ? (
          <Pressable onPress={() => setIsCreating(true)} hitSlop={8} style={{ padding: 4 }}>
            <I.Plus size={22} color={t.accent} />
          </Pressable>
        ) : undefined}
      />

      {/* Groups | Channels segment (sealed public channels live in this tab). */}
      {channelsEnabled && (
        <View style={{ flexDirection: 'row', gap: 4, marginHorizontal: 14, marginTop: 2, marginBottom: 8, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, padding: 3 }}>
          {(['groups', 'channels'] as const).map((s) => {
            const on = seg === s;
            return (
              <Pressable
                key={s}
                onPress={() => handleSegTap(s)}
                style={{ flex: 1, paddingVertical: 7, borderRadius: t.radiusS, backgroundColor: on ? t.accent : 'transparent', alignItems: 'center' }}
              >
                <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: on ? t.accentInk : t.textDim }}>
                  {s === 'groups' ? i18nT('channels.segGroups') : i18nT('channels.segChannels')}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}


      {channelsEnabled ? (
        <ScrollView
          ref={swipeRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          contentOffset={{ x: (initialSeg ?? 'groups') === 'channels' ? screenWidth : 0, y: 0 }}
          onMomentumScrollEnd={(e) => {
            const page = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
            setSeg(page === 1 ? 'channels' : 'groups');
          }}
          style={{ flex: 1 }}
        >
          {/* Page 0: Groups */}
          <View style={{ width: screenWidth, flex: 1 }}>
            {activeGroups.length === 0 && pendingInvites.length === 0 ? (
        <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 32,
              paddingTop: 40,
            }}
          >
            <ConstellationVisual t={t} />
            <Text
              style={{
                fontFamily: t.fontDisplay,
                fontSize: 24,
                fontWeight: '600',
                letterSpacing: -0.4,
                color: t.text,
                marginTop: 28,
                marginBottom: 10,
              }}
            >
              {i18nT('groups.emptyTitle')}
            </Text>
            <Text
              style={{
                fontFamily: t.font,
                fontSize: 14,
                color: t.textDim,
                lineHeight: 21,
                textAlign: 'center',
                maxWidth: 280,
                marginBottom: 26,
              }}
            >
              {i18nT('groups.emptyPersonalDesc')}
            </Text>
            <Pressable
              onPress={() => setIsCreating(true)}
              style={({ pressed }) => ({
                backgroundColor: t.accent,
                paddingHorizontal: 24,
                paddingVertical: 13,
                borderRadius: t.radius,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                marginBottom: 10,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <I.Plus size={18} color={t.accentInk} />
              <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>
                {i18nT('groups.createGroup')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => { setJoinLinkInput(''); setShowJoinModal(true); }}
              style={({ pressed }) => ({
                backgroundColor: 'transparent',
                borderWidth: 1,
                borderColor: t.borderStrong,
                paddingHorizontal: 24,
                paddingVertical: 12,
                borderRadius: t.radius,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500', fontSize: 14 }}>
                {i18nT('groups.joinByLink')}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={activeGroups}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 22 }}
          ListHeaderComponent={
            pendingInvites.length > 0 ? (
              <View>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.1, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 }}>
                  {i18nT('groups.invitesSection', 'INVITACIONES').toUpperCase()}
                </Text>
                {pendingInvites.map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={() => setInviteMenuFor(item)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      paddingHorizontal: 18,
                      paddingVertical: 14,
                      backgroundColor: pressed ? t.surface : `${t.accent}0a`,
                      borderBottomWidth: 1,
                      borderBottomColor: t.divider,
                    })}
                  >
                    <Avatar t={t} name={item.avatarImage || item.name} color={item.avatarColor || t.accent} size={44} seed={item.id} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>
                        {item.name}
                      </Text>
                      <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 4 }}>
                        {i18nT('groups.inviteSubtitle', 'Te invitaron a este grupo · toca para responder')}
                      </Text>
                    </View>
                    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, borderWidth: 1, borderColor: `${t.accent}66` }}>
                      <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.8 }}>
                        {i18nT('groups.inviteBadge', 'INVITACIÓN')}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const previewMsg = previews[item.id];
            const unread = unreadCounts[item.id] ?? 0;
            
            // Format preview message
            let lastText = i18nT('groups.noMessagesPreview');
            if (previewMsg) {
              if (previewMsg.body.includes(': ')) {
                const colonIdx = previewMsg.body.indexOf(': ');
                const sender = previewMsg.body.substring(0, colonIdx);
                const actual = previewMsg.body.substring(colonIdx + 2);
                lastText = `${sender.substring(0, 8)}: ${previewLabel(actual, i18nT)}`;
              } else {
                lastText = previewLabel(previewMsg.body, i18nT);
              }
            }

            return (
              <Pressable
                onPress={() => onOpenGroupChat(item)}
                onLongPress={() => setMenuGroup(item)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 18,
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: t.divider,
                  backgroundColor: pressed ? t.surface : 'transparent',
                })}
              >
                <Avatar t={t} name={item.avatarImage || item.name} color={item.avatarColor || t.accent} size={44} seed={item.id} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>
                      {item.name}
                    </Text>
                    {previewMsg ? (
                      <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>
                        {new Date(previewMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    ) : null}
                  </View>
                  <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 4 }}>
                    {lastText}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                    <I.Lock size={10} color={t.accent} />
                    <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.5 }}>
                      {`E2EE · ${i18nT('search.member', { count: item.members.length }).toUpperCase()}`}
                    </Text>
                  </View>
                </View>
                {unread > 0 ? (
                  <View style={{
                    minWidth: 20, height: 20, borderRadius: 10,
                    backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center',
                    paddingHorizontal: 4, alignSelf: 'center',
                  }}>
                    <Text style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '700', color: t.accentInk }}>
                      {unread > 99 ? '99+' : String(unread)}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
          </View>

          {/* Page 1: Channels */}
          <View style={{ width: screenWidth, flex: 1 }}>
            <ChannelsPanel
              bottomInset={insets.bottom}
              onOpenChannel={(channelId) => onOpenChannel?.(channelId)}
              onDiscover={() => onDiscoverChannels?.()}
              onCreate={() => onCreateChannel?.()}
            />
          </View>
        </ScrollView>
      ) : (
        /* Channels not enabled -- show groups only (no pager) */
        activeGroups.length === 0 && pendingInvites.length === 0 ? (
          <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingTop: 40 }}>
              <ConstellationVisual t={t} />
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 24, fontWeight: '600', letterSpacing: -0.4, color: t.text, marginTop: 28, marginBottom: 10 }}>
                {i18nT('groups.emptyTitle')}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: 21, textAlign: 'center', maxWidth: 280, marginBottom: 26 }}>
                {i18nT('groups.emptyPersonalDesc')}
              </Text>
              <Pressable
                onPress={() => setIsCreating(true)}
                style={({ pressed }) => ({ backgroundColor: t.accent, paddingHorizontal: 24, paddingVertical: 13, borderRadius: t.radius, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, opacity: pressed ? 0.85 : 1 })}
              >
                <I.Plus size={18} color={t.accentInk} />
                <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>{i18nT('groups.createGroup')}</Text>
              </Pressable>
              <Pressable
                onPress={() => { setJoinLinkInput(''); setShowJoinModal(true); }}
                style={({ pressed }) => ({ backgroundColor: 'transparent', borderWidth: 1, borderColor: t.borderStrong, paddingHorizontal: 24, paddingVertical: 12, borderRadius: t.radius, opacity: pressed ? 0.7 : 1 })}
              >
                <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500', fontSize: 14 }}>{i18nT('groups.joinByLink')}</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : (
          <FlatList
            data={activeGroups}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingBottom: 22 }}
            ListHeaderComponent={pendingInvites.length > 0 ? (
              <View>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.1, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 }}>
                  {i18nT('groups.invitesSection', 'INVITACIONES').toUpperCase()}
                </Text>
                {pendingInvites.map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={() => setInviteMenuFor(item)}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: pressed ? t.surface : `${t.accent}0a`, borderBottomWidth: 1, borderBottomColor: t.divider })}
                  >
                    <Avatar t={t} name={item.avatarImage || item.name} color={item.avatarColor || t.accent} size={44} seed={item.id} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>{item.name}</Text>
                      <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 4 }}>{i18nT('groups.inviteSubtitle', 'Te invitaron a este grupo')}</Text>
                    </View>
                    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, borderWidth: 1, borderColor: `${t.accent}66` }}>
                      <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.8 }}>{i18nT('groups.inviteBadge', 'INVITACION')}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
            renderItem={({ item }) => {
              const previewMsg = previews[item.id];
              const unread = unreadCounts[item.id] ?? 0;
              let lastText = i18nT('groups.noMessagesPreview');
              if (previewMsg) {
                if (previewMsg.body.includes(': ')) {
                  const colonIdx = previewMsg.body.indexOf(': ');
                  const sender = previewMsg.body.substring(0, colonIdx);
                  const actual = previewMsg.body.substring(colonIdx + 2);
                  lastText = `${sender.substring(0, 8)}: ${previewLabel(actual, i18nT)}`;
                } else {
                  lastText = previewLabel(previewMsg.body, i18nT);
                }
              }
              return (
                <Pressable
                  onPress={() => onOpenGroupChat(item)}
                  onLongPress={() => setMenuGroup(item)}
                  style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: t.divider, backgroundColor: pressed ? t.surface : 'transparent' })}
                >
                  <Avatar t={t} name={item.avatarImage || item.name} color={item.avatarColor || t.accent} size={44} seed={item.id} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>{item.name}</Text>
                      {previewMsg ? <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{new Date(previewMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text> : null}
                    </View>
                    <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 4 }}>{lastText}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                      <I.Lock size={10} color={t.accent} />
                      <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.5 }}>
                        {`E2EE · ${i18nT('search.member', { count: item.members.length }).toUpperCase()}`}
                      </Text>
                    </View>
                  </View>
                  {unread > 0 ? (
                    <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, alignSelf: 'center' }}>
                      <Text style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '700', color: t.accentInk }}>{unread > 99 ? '99+' : String(unread)}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            }}
          />
        )
      )}

      {/* Group actions floating menu */}
      <FloatingMenu
        t={t}
        visible={menuGroup !== null}
        onClose={() => setMenuGroup(null)}
        title={menuGroup?.name}
        items={
          menuGroup
            ? [
                {
                  key: 'leave',
                  icon: <I.Trash size={20} color={t.danger} />,
                  label: i18nT('groups.leaveGroup'),
                  onPress: () => {
                    const group = menuGroup;
                    themedAlert(group.name, i18nT('groups.deleteGroupConfirm'), [
                      { text: i18nT('common.cancel'), style: 'cancel' },
                      {
                        text: i18nT('groups.leaveGroup'),
                        style: 'destructive',
                        onPress: () => void leaveGroup(group.id),
                      },
                    ]);
                  },
                  danger: true,
                },
              ]
            : []
        }
      />

      {/* Pending invite — Accept / Decline floating menu (consent flow) */}
      <FloatingMenu
        t={t}
        visible={inviteMenuFor !== null}
        onClose={() => setInviteMenuFor(null)}
        title={inviteMenuFor?.name}
        subtitle={i18nT('groups.inviteBadge', 'INVITACIÓN')}
        items={
          inviteMenuFor
            ? [
                {
                  key: 'accept',
                  icon: <I.Check size={20} color={t.accent} />,
                  label: i18nT('groups.acceptInvite', 'Aceptar invitación'),
                  onPress: () => { const g = inviteMenuFor; void acceptGroupInvite(g.id); },
                },
                {
                  key: 'decline',
                  icon: <I.X size={20} color={t.danger} />,
                  label: i18nT('groups.declineInvite', 'Rechazar'),
                  danger: true,
                  onPress: () => { const g = inviteMenuFor; void leaveGroup(g.id); },
                },
              ]
            : []
        }
      />

      {/* Join by link modal */}
      <Modal
        visible={showJoinModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowJoinModal(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setShowJoinModal(false)}
        >
          <Pressable
            style={{
              backgroundColor: t.surface,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 24,
              paddingBottom: insets.bottom + 24,
              gap: 16,
            }}
            onPress={() => {/* prevent dismiss */}}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '600', color: t.text }}>
                {i18nT('groups.joinByLinkTitle')}
              </Text>
              <Pressable onPress={() => setShowJoinModal(false)} hitSlop={8}>
                <I.X size={20} color={t.textDim} />
              </Pressable>
            </View>
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
              {i18nT('groups.joinByLinkModalDesc')}
            </Text>
            <TextInput
              value={joinLinkInput}
              onChangeText={setJoinLinkInput}
              placeholder={i18nT('groups.joinByLinkPlaceholder')}
              placeholderTextColor={t.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                backgroundColor: t.surface2,
                borderRadius: t.radius,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontFamily: t.fontMono,
                fontSize: 12,
                color: t.text,
                borderWidth: 1,
                borderColor: t.divider,
                letterSpacing: 0.2,
              }}
            />
            <Pressable
              onPress={() => {
                const parsed = parseGroupInviteLink(joinLinkInput.trim());
                if (!parsed) {
                  themedAlert(
                    i18nT('groups.joinByLinkInvalidTitle'),
                    i18nT('groups.joinByLinkInvalidDesc'),
                  );
                  return;
                }
                setShowJoinModal(false);
                onJoinByLink?.(parsed.groupId, parsed.groupName, parsed.adminId);
              }}
              style={({ pressed }) => ({
                backgroundColor: t.accent,
                borderRadius: t.radius,
                paddingVertical: 14,
                alignItems: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.accentInk }}>
                {i18nT('groups.joinByLinkBtn')}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <AvatarCropModal
        t={t}
        visible={cropSource !== null}
        imageUri={cropSource?.uri ?? null}
        imageWidth={cropSource?.width ?? 0}
        imageHeight={cropSource?.height ?? 0}
        title={i18nT('groups.groupPhoto', 'Imagen del grupo')}
        confirmLabel={i18nT('common.confirm', 'Confirmar')}
        cancelLabel={i18nT('common.cancel', 'Cancelar')}
        onCancel={() => setCropSource(null)}
        onConfirm={(uri) => { void handleConfirmGroupImage(uri); }}
      />

      <TabBar t={t} current="groups" onChange={onTab} />
    </View>
  );
}


