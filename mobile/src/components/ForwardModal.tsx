import { useState } from 'react';
import { Modal, View, Text, Pressable, FlatList, TextInput, Alert } from 'react-native';
import { decodeBase64 } from 'tweetnacl-util';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { sendMessage } from '../socket/client';
import { Avatar } from './Avatar';
import { I } from './icons';

interface Props {
  visible: boolean;
  body: string;
  onClose: () => void;
}

export function ForwardModal({ visible, body, onClose }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const contacts = useContacts((s) => s.contacts);
  const [query, setQuery] = useState('');
  const [sending, setSending] = useState<string | null>(null);

  const filtered = query.trim()
    ? contacts.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()) || c.aegisId.toLowerCase().includes(query.toLowerCase()))
    : contacts;

  async function forward(aegisId: string, publicKeyB64: string) {
    if (!identity || sending) return;
    setSending(aegisId);
    try {
      await sendMessage({
        identity,
        recipientAegisId: aegisId,
        recipientPublicKey: decodeBase64(publicKeyB64),
        plaintext: body,
      });
      onClose();
      setQuery('');
    } catch (e) {
      Alert.alert(i18nT('common.error'), (e as Error).message);
    } finally {
      setSending(null);
    }
  }

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
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
            {i18nT('forwardModal.title').toUpperCase()}
          </Text>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginHorizontal: 16,
              marginBottom: 8,
              backgroundColor: t.surface2,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: t.border,
              paddingHorizontal: 12,
              gap: 8,
            }}
          >
            <I.Search size={15} color={t.textDim} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={i18nT('common.search') + '...'}
              placeholderTextColor={t.textDim}
              style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: t.text, paddingVertical: 9 }}
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(item) => item.aegisId}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => void forward(item.aegisId, item.publicKeyB64)}
                disabled={sending === item.aegisId}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 22,
                  paddingVertical: 12,
                  backgroundColor: pressed ? t.surface2 : 'transparent',
                  opacity: sending && sending !== item.aegisId ? 0.5 : 1,
                })}
              >
                <Avatar t={t} name={item.avatarImage || item.name} color={item.color ?? t.accent} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text, fontWeight: '500' }}>{item.name}</Text>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{item.aegisId}</Text>
                </View>
                {sending === item.aegisId ? (
                  <I.Check size={16} color={t.accent} />
                ) : (
                  <I.Forward size={16} color={t.textDim} />
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', paddingVertical: 24 }}>
                {i18nT('forwardModal.noContacts')}
              </Text>
            }
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
