import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Alert, TextInput, FlatList, Modal } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { withPickingGuard } from '../utils/pickingGuard';
import Svg, { Circle, Line, G, Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { TabBar, type Tab } from '../components/TabBar';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import type { Theme } from '../theme/vault';
import { useGroups } from '../store/groups';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { useMessages } from '../store/messages';
import { sendGroupMessage } from '../socket/client';
import { parseGroupInviteLink } from '../crypto/qr';
import type { StoredGroup } from '../db/local';


interface Props {
  onTab: (tab: Tab) => void;
  onOpenGroupChat: (group: StoredGroup) => void;
  onJoinByLink?: (groupId: string, groupName: string, adminId: string) => void;
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

export function GroupsScreen({ onTab, onOpenGroupChat, onJoinByLink }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const { contacts } = useContacts();
  const { groups, hydrate, createGroup, leaveGroup } = useGroups();
  const previews = useMessages((s) => s.previews);

  const [isCreating, setIsCreating] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [groupColor, setGroupColor] = useState('#05b875');
  const [groupImage, setGroupImage] = useState<string | undefined>(undefined);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinLinkInput, setJoinLinkInput] = useState('');

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
      Alert.alert(i18nT('groups.permissionDeniedTitle'), i18nT('groups.permissionDeniedGallery'));
      return;
    }
    const result = await withPickingGuard(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as ImagePicker.MediaType[],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      })
    );
    if (!result.canceled && result.assets && result.assets.length > 0) {
      const compressed = await manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 256 } }],
        { compress: 0.7, format: SaveFormat.JPEG }
      );
      setGroupImage(compressed.uri);
    }
  }

  async function handleTakePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(i18nT('groups.permissionDeniedTitle'), i18nT('groups.permissionDeniedCamera'));
      return;
    }
    const result = await withPickingGuard(() =>
      ImagePicker.launchCameraAsync({
        mediaTypes: ['images'] as ImagePicker.MediaType[],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      })
    );
    if (!result.canceled && result.assets && result.assets.length > 0) {
      const compressed = await manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 256 } }],
        { compress: 0.7, format: SaveFormat.JPEG }
      );
      setGroupImage(compressed.uri);
    }
  }

  // Handle creating group
  async function handleConfirmCreate() {
    if (!groupName.trim()) {
      Alert.alert(i18nT('common.error'), i18nT('groups.errorCreateName'));
      return;
    }
    if (selectedContacts.length === 0) {
      Alert.alert(i18nT('common.error'), i18nT('groups.errorCreateMembers'));
      return;
    }
    if (!identity) return;

    try {
      const allMembers = [identity.aegisId, ...selectedContacts];
      const newGroup = await createGroup(groupName.trim(), allMembers, groupColor, groupImage);
      
      // Send group initiation / welcome message to all members
      try {
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
      Alert.alert(i18nT('groups.createdSuccess'), i18nT('groups.createdSuccessDesc', { name: groupName }));
    } catch (err) {
      Alert.alert(i18nT('common.error'), i18nT('groups.errorCreate'));
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
            <Avatar t={t} name={groupImage || (groupName.trim() || 'G')} color={groupColor} size={64} />
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
                    <Avatar t={t} name={c.avatarImage || c.name} color={c.color ?? t.surface2} size={32} photoUri={c.avatarImage} />
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
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('groups.title')}
        big
        right={
          <Pressable onPress={() => setIsCreating(true)} hitSlop={8} style={{ padding: 4 }}>
            <I.Plus size={22} color={t.accent} />
          </Pressable>
        }
      />


      {groups.length === 0 ? (
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
          data={groups}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 22 }}
          renderItem={({ item }) => {
            const previewMsg = previews[item.id];
            
            // Format preview message
            let lastText = i18nT('groups.noMessagesPreview');
            if (previewMsg) {
              if (previewMsg.body.includes(': ')) {
                const colonIdx = previewMsg.body.indexOf(': ');
                const sender = previewMsg.body.substring(0, colonIdx);
                const actual = previewMsg.body.substring(colonIdx + 2);
                lastText = `${sender.substring(0, 8)}: ${actual}`;
              } else {
                lastText = previewMsg.body;
              }
            }

            return (
              <Pressable
                onPress={() => onOpenGroupChat(item)}
                onLongPress={() => {
                  Alert.alert(
                    item.name,
                    i18nT('groups.deleteGroupConfirm'),
                    [
                      { text: i18nT('common.cancel'), style: 'cancel' },
                      {
                        text: i18nT('groups.leaveGroup'),
                        style: 'destructive',
                        onPress: () => void leaveGroup(item.id),
                      },
                    ]
                  );
                }}
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
                <Avatar t={t} name={item.avatarImage || item.name} color={item.avatarColor || t.accent} size={44} />
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
              </Pressable>
            );
          }}
        />
      )}

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
                  Alert.alert(
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

      <TabBar t={t} current="groups" onChange={onTab} />
    </View>
  );
}

function ConstellationVisual({ t }: { t: Theme }) {
  return (
    <Svg viewBox="0 0 180 140" width={180} height={140}>
      <Line x1={50} y1={40} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <Line x1={130} y1={40} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <Line x1={40} y1={100} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <Line x1={140} y1={100} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <Circle cx={50} cy={40} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <Circle cx={130} cy={40} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <Circle cx={40} cy={100} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <Circle cx={140} cy={100} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <Circle cx={90} cy={70} r={22} fill={`${t.accent}22`} stroke={t.accent} strokeWidth={1.5} />
      <G x={78} y={58}>
        <Path
          d="M12 0 L21 6 L21 18 L12 24 L3 18 L3 6 Z"
          fill="none"
          stroke={t.accent}
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </G>
    </Svg>
  );
}

