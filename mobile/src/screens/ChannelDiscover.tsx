/**
 * ChannelDiscover — public channel directory (Phase 2d-2, docs §11.1)
 *
 * Lists the relay-hosted directory. Every row shown is a manifest whose signature
 * verified ON-DEVICE (useChannels.loadDirectory drops unverified entries) — the UI
 * does no crypto itself. Design ref: prototype/screens-channels.jsx (ScreenChannelDiscover).
 */

import { useEffect } from 'react';
import { View, Text, Pressable, FlatList, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { useChannelAvatar } from '../channels/useChannelAvatar';
import { useChannels, type DirectoryEntry } from '../store/channels';
import type { Theme } from '../theme/vault';

/** Per-row component so useChannelAvatar runs per-item. */
function DiscoverRow({ item, t, onPress, i18nT }: { item: DirectoryEntry; t: Theme; onPress: () => void; i18nT: (k: string) => string }) {
  const photoUri = useChannelAvatar(item.channelId, item.avatarHash);
  const isApproval = item.channelType === 'approval';
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={item.name}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: t.divider }}
    >
      <Avatar t={t} name={item.name} seed={item.channelId} size={42} photoUri={photoUri} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.text }}>{item.name}</Text>
        <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 2 }}>
          {item.description || item.channelType}
        </Text>
      </View>
      <View style={{ backgroundColor: t.accent, borderRadius: t.radiusS, paddingVertical: 5, paddingHorizontal: 12 }}>
        <Text style={{ fontFamily: t.font, fontSize: 11, fontWeight: '600', color: t.accentInk }}>{isApproval ? i18nT('channels.apply') : i18nT('channels.open')}</Text>
      </View>
    </Pressable>
  );
}

interface Props {
  onBack: () => void;
  onOpenChannel: (channelId: string) => void;
}

export function ChannelDiscoverScreen({ onBack, onOpenChannel }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const directory = useChannels((s) => s.directory);
  const loading = useChannels((s) => s.loadingDirectory);
  const loadDirectory = useChannels((s) => s.loadDirectory);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const renderRow = ({ item }: { item: DirectoryEntry }) => (
    <DiscoverRow item={item} t={t} onPress={() => onOpenChannel(item.channelId)} i18nT={i18nT} />
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('channels.discoverTitle')}
        left={<Pressable onPress={onBack} hitSlop={8}><I.ChevronL size={22} color={t.text} /></Pressable>}
      />
      <Text style={{ paddingHorizontal: 15, paddingTop: 12, paddingBottom: 8, fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 1, textTransform: 'uppercase' }}>
        {i18nT('channels.directorySubtitle')}
      </Text>
      {loading && directory.length === 0 ? (
        <ActivityIndicator color={t.accent} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={directory}
          keyExtractor={(c) => c.channelId}
          renderItem={renderRow}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          ListEmptyComponent={
            <Text style={{ textAlign: 'center', marginTop: 40, fontFamily: t.font, fontSize: 13, color: t.textDim }}>
              {i18nT('channels.directoryEmpty')}
            </Text>
          }
        />
      )}
    </View>
  );
}
