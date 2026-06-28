/**
 * ChannelFeed — sealed channel broadcast view (Phase 2d-2)
 *
 * Renders the chain-verified post feed for one channel and (for open/owned
 * channels) a compose bar. All posts shown were authenticated + chain-verified by
 * useChannels before reaching state; the relay never saw who posted. This screen
 * does no crypto. Design ref: prototype/screens-channels.jsx (ScreenChannelFeed).
 */

import { useEffect } from 'react';
import { View, Text, Pressable, FlatList, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { themedAlert } from '../components/AlertHost';
import { useChannels, type FeedPost } from '../store/channels';
import { useIdentity } from '../store/identity';

interface Props {
  channelId: string;
  onBack: () => void;
}

export function ChannelFeedScreen({ channelId, onBack }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);

  const summary = useChannels((s) => s.subscribed.find((c) => c.channelId === channelId));
  const posts = useChannels((s) => s.feeds[channelId]);
  const loadFeed = useChannels((s) => s.loadFeed);
  const sendPost = useChannels((s) => s.sendPost);
  const attachLive = useChannels((s) => s.attachLive);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!identity) return;
    void loadFeed(channelId, identity);
    const off = attachLive(identity);
    return off;
  }, [channelId, identity, loadFeed, attachLive]);

  const canPost = !!identity && (summary?.channelType === 'open' || summary?.owned === true);

  const handleSend = async () => {
    if (!identity || !draft.trim() || sending) return;
    setSending(true);
    try {
      const res = await sendPost(channelId, draft.trim(), identity);
      if (res.ok) setDraft('');
      else themedAlert('No se pudo publicar', res.error ?? 'Error');
    } finally {
      setSending(false);
    }
  };

  const renderPost = ({ item }: { item: FeedPost }) => {
    const mine = item.from === identity?.aegisId;
    return (
      <View style={{ paddingVertical: 12, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: t.divider }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 }}>
          <View style={{ width: 24, height: 24, borderRadius: t.radiusS, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
            <I.Shield size={12} color={t.accent} />
          </View>
          <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.text }}>{mine ? 'tú' : item.from}</Text>
          <Text style={{ marginLeft: 'auto', fontFamily: t.fontMono, fontSize: 9, color: t.textFaint }}>#{item.seqNum}</Text>
        </View>
        <Text style={{ fontFamily: t.font, fontSize: 13, lineHeight: 20, color: t.text }}>{item.body}</Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <TopBar
        t={t}
        title={summary?.name ?? 'Canal'}
        left={<Pressable onPress={onBack} hitSlop={8}><I.ChevronL size={22} color={t.text} /></Pressable>}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <I.Lock size={11} color={t.accent} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, textTransform: 'uppercase' }}>sealed</Text>
          </View>
        }
      />
      <FlatList
        data={posts ?? []}
        keyExtractor={(p) => p.id}
        renderItem={renderPost}
        contentContainerStyle={{ paddingBottom: 12 }}
        ListEmptyComponent={
          <Text style={{ textAlign: 'center', marginTop: 40, fontFamily: t.font, fontSize: 13, color: t.textDim }}>
            Aún no hay posts en este canal.
          </Text>
        }
      />

      {canPost && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, paddingBottom: insets.bottom + 10, borderTopWidth: 1, borderTopColor: t.divider, backgroundColor: t.surface }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Publicar en el canal…"
            placeholderTextColor={t.textFaint}
            multiline
            style={{ flex: 1, maxHeight: 120, backgroundColor: t.surface2, borderRadius: t.radius, paddingHorizontal: 14, paddingVertical: 10, color: t.text, fontFamily: t.font, fontSize: 15 }}
          />
          <Pressable
            onPress={handleSend}
            disabled={!draft.trim() || sending}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: draft.trim() ? t.accent : t.surface2, alignItems: 'center', justifyContent: 'center' }}
          >
            <I.Send size={18} color={draft.trim() ? t.accentInk : t.textFaint} />
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
