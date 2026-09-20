/**
 * NicknameModal — edit or clear the local nickname of a contact.
 *
 * The nickname is a device-only label (store/contacts.ts setNickname): it wins
 * over the name the contact announces and is never sent anywhere.
 */
import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, Modal, Platform, KeyboardAvoidingView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';

export const NICKNAME_MAX_LEN = 40;

export interface NicknameModalProps {
  visible: boolean;
  /** Current nickname (null/empty = none). */
  value: string | null | undefined;
  /** Name the contact announces — shown as the hint for what "clear" restores. */
  profileName: string;
  onSave: (nickname: string | null) => void;
  onCancel: () => void;
}

export function NicknameModal({ visible, value, profileName, onSave, onCancel }: NicknameModalProps) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const [text, setText] = useState(value ?? '');

  useEffect(() => {
    if (visible) setText(value ?? '');
  }, [visible, value]);

  const trimmed = text.trim();
  const unchanged = trimmed === (value?.trim() ?? '');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', paddingHorizontal: 22 }}>
          <View
            style={{
              backgroundColor: t.surface,
              borderRadius: t.radius,
              borderWidth: 1,
              borderColor: t.borderStrong,
              padding: 20,
              gap: 14,
            }}
          >
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '600', color: t.text }}>
              {i18nT('contactDetail.nicknameTitle')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
              {i18nT('contactDetail.nicknameDesc', { name: profileName })}
            </Text>
            <TextInput
              testID="nickname-input"
              accessibilityLabel={i18nT('contactDetail.nicknameTitle')}
              placeholder={i18nT('addContact.nicknamePlaceholder')}
              placeholderTextColor={t.textFaint}
              value={text}
              onChangeText={setText}
              maxLength={NICKNAME_MAX_LEN}
              autoFocus
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => { if (!unchanged) onSave(trimmed || null); }}
              style={{
                fontFamily: t.font,
                fontSize: 15,
                color: t.text,
                backgroundColor: t.bg,
                borderColor: t.border,
                borderWidth: 1,
                borderRadius: t.radiusS,
                padding: 12,
              }}
            />
            <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
              {value?.trim() ? (
                <Pressable
                  testID="nickname-clear"
                  onPress={() => onSave(null)}
                  hitSlop={8}
                  style={{ paddingVertical: 10, paddingHorizontal: 12, marginRight: 'auto' }}
                >
                  <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.danger }}>
                    {i18nT('contactDetail.nicknameClear')}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable onPress={onCancel} hitSlop={8} style={{ paddingVertical: 10, paddingHorizontal: 12 }}>
                <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.textDim }}>
                  {i18nT('common.cancel')}
                </Text>
              </Pressable>
              <Pressable
                testID="nickname-save"
                disabled={unchanged}
                onPress={() => onSave(trimmed || null)}
                style={{
                  paddingVertical: 10,
                  paddingHorizontal: 16,
                  borderRadius: t.radiusS,
                  backgroundColor: unchanged ? t.surface2 : t.accent,
                }}
              >
                <Text style={{ fontFamily: t.font, fontWeight: '700', fontSize: 14, color: unchanged ? t.textFaint : t.accentInk }}>
                  {i18nT('common.save')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
