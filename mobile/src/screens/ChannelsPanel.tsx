/**
 * ChannelsPanel — the Channels content rendered inside the Groups tab's
 * "Groups | Channels" segment (Phase 2d-2). Self-contained body (no TopBar /
 * TabBar — the host Groups screen provides those): subscribed list + Discover +
 * New + Join-by-link. All crypto lives in useChannels; this is pure UI.
 */

import { useState } from 'react';
import { View, Text, Pressable, FlatList, Modal, TextInput, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { themedAlert } from '../components/AlertHost';
import { useChannels, type ChannelSummary } from '../store/channels';
import { useIdentity } from '../store/identity';

interface Props {
  bottomInset: number;
  onOpenChannel: (channelId: string) => void;
  onDiscover: () => void;
  onCreate: () => void;
}

export function ChannelsPanel({ bottomInset, onOpenChannel, onDiscover, onCreate }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const identity = useIdentity((s) => s.identity);
  const subscribed = useChannels((s) => s.subscribed);
  const joinViaInvite = useChannels((s) => s.joinViaInvite);

  const [joinOpen, setJoinOpen] = useState(false);
  const [inviteText, setInviteText] = useState('');
  const [joining, setJoining] = useState(false);

  const handleJoin = async () => {
    if (!identity || !inviteText.trim() || joining) return;
    setJoining(true);
    try {
      const res = await joinViaInvite(inviteText.trim(), identity);
      if (res.ok && res.channelId) {
        setJoinOpen(false);
        setInviteText('');
        onOpenChannel(res.channelId);
      } else {
        themedAlert(i18nT('channels.joinFailed'), res.error ?? i18nT('channels.invalidInvite'));
      }
    } finally {
      setJoining(false);
    }
  };

  const renderRow = ({ item }: { item: ChannelSummary }) => (
    <Pressable
      onPress={() => onOpenChannel(item.channelId)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: t.divider }}
    >
      <View style={{ width: 42, height: 42, borderRadius: t.radiusL, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
        <I.Globe size={20} color={t.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.text }}>{item.name}</Text>
          {item.owned && <I.Key size={12} color={t.accent} />}
        </View>
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginTop: 2 }}>{item.channelType}</Text>
      </View>
      <I.ChevronL size={16} color={t.textFaint} style={{ transform: [{ rotate: '180deg' }] }} />
    </Pressable>
  );

  const dashedBtn = (icon: React.ReactNode, label: string, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginHorizontal: 15, marginTop: 12, paddingVertical: 12, borderWidth: 1, borderColor: t.borderStrong, borderStyle: 'dashed', borderRadius: t.radius }}
    >
      {icon}
      <Text style={{ color: t.accent, fontFamily: t.font, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={subscribed}
        keyExtractor={(c) => c.channelId}
        renderItem={renderRow}
        contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
        ListEmptyComponent={
          <Text style={{ textAlign: 'center', marginTop: 32, fontFamily: t.font, fontSize: 13, color: t.textDim }}>
            {i18nT('channels.emptySubscribed')}
          </Text>
        }
        ListFooterComponent={
          <View>
            {dashedBtn(<I.Search size={16} color={t.accent} />, i18nT('channels.discover'), onDiscover)}
            {dashedBtn(<I.Plus size={16} color={t.accent} />, i18nT('channels.joinByLink'), () => setJoinOpen(true))}
            {dashedBtn(<I.Plus size={16} color={t.accent} />, i18nT('channels.newChannel'), onCreate)}
          </View>
        }
      />

      <Modal visible={joinOpen} transparent animationType="fade" onRequestClose={() => setJoinOpen(false)}>
        <Pressable onPress={() => setJoinOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 18, borderWidth: 1, borderColor: t.border }}>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 18, color: t.text, marginBottom: 12 }}>{i18nT('channels.joinTitle')}</Text>
            <TextInput
              value={inviteText}
              onChangeText={setInviteText}
              placeholder={i18nT('channels.joinPlaceholder')}
              placeholderTextColor={t.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ backgroundColor: t.surface2, color: t.text, borderRadius: t.radiusS, paddingVertical: 12, paddingHorizontal: 14, fontFamily: t.fontMono, fontSize: 13 }}
            />
            <Pressable
              onPress={handleJoin}
              disabled={!inviteText.trim() || joining}
              style={{ marginTop: 14, backgroundColor: inviteText.trim() ? t.accent : t.surface2, borderRadius: t.radius, paddingVertical: 13, alignItems: 'center' }}
            >
              {joining ? <ActivityIndicator color={t.accentInk} /> : (
                <Text style={{ fontFamily: t.font, fontWeight: '700', color: inviteText.trim() ? t.accentInk : t.textFaint }}>{i18nT('channels.join')}</Text>
              )}
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
