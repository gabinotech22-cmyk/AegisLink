/**
 * ContactPickerSheet — Vault-themed bottom sheet to pick ONE contact.
 *
 * Replaces the native Alert.alert contact pickers (white dialog, no avatars,
 * hard 5-button cap). Same visual pattern as ForwardModal: drag handle, mono
 * title, search box, avatar + name + aegisId rows, empty state.
 */

import { useState } from 'react';
import { View, Text, TextInput, Pressable, Modal, FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../theme/vault';
import { I } from './icons';
import { Avatar } from './Avatar';
import type { StoredContact } from '../db/local';

interface Props {
  t: Theme;
  visible: boolean;
  /** Already-filtered list of pickable contacts (exclusions applied by caller). */
  contacts: StoredContact[];
  /** Mono uppercase title, e.g. "COMPARTIR CONTACTO". */
  title: string;
  /** Shown when `contacts` is empty (or the search has no matches). */
  emptyText: string;
  /** Trailing row icon; defaults to a plus. */
  trailingIcon?: 'plus' | 'send';
  onClose: () => void;
  onPick: (contact: StoredContact) => void;
}

export function ContactPickerSheet({ t, visible, contacts, title, emptyText, trailingIcon = 'plus', onClose, onPick }: Props) {
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? contacts.filter((c) =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.aegisId.toLowerCase().includes(query.toLowerCase()))
    : contacts;

  const close = () => { setQuery(''); onClose(); };

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={close}>
      <Pressable onPress={close} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <Pressable
          onPress={(e) => e.stopPropagation?.()}
          style={{
            backgroundColor: t.surface,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderTopWidth: 1,
            borderColor: t.borderStrong,
            maxHeight: '75%',
            paddingTop: 10,
            paddingBottom: insets.bottom + 8,
          }}
        >
          <View style={{ alignItems: 'center', paddingBottom: 12 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.surface3 }} />
          </View>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.8, paddingHorizontal: 22, paddingBottom: 10 }}>
            {title.toUpperCase()}
          </Text>

          <View
            style={{
              flexDirection: 'row', alignItems: 'center',
              marginHorizontal: 16, marginBottom: 8,
              backgroundColor: t.surface2, borderRadius: 12,
              borderWidth: 1, borderColor: t.border,
              paddingHorizontal: 12, gap: 8,
            }}
          >
            <I.Search size={15} color={t.textDim} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={i18nT('common.search') + '...'}
              placeholderTextColor={t.textDim}
              accessibilityLabel={i18nT('common.search')}
              style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: t.text, paddingVertical: 9 }}
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(item) => item.aegisId}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => { setQuery(''); onPick(item); }}
                accessibilityRole="button"
                accessibilityLabel={`${title}: ${item.name}`}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingHorizontal: 22, paddingVertical: 12,
                  backgroundColor: pressed ? t.surface2 : 'transparent',
                })}
              >
                <Avatar t={t} name={item.avatarImage || item.name} color={item.color ?? t.accent} size={40} photoUri={item.avatarImage} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 14, color: t.text, fontWeight: '500' }}>{item.name}</Text>
                  <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{item.aegisId}</Text>
                </View>
                {trailingIcon === 'send'
                  ? <I.Send size={16} color={t.accent} />
                  : <I.Plus size={16} color={t.accent} />}
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 22 }}>
                {emptyText}
              </Text>
            }
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
