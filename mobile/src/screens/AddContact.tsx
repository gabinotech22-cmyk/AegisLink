import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { PrimaryButton } from '../components/Button';
import { useContacts } from '../store/contacts';
import type { StoredContact } from '../db/local';

interface Props {
  onCancel: () => void;
  onAdded: (contact: StoredContact) => void;
}

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function AddContactScreen({ onCancel, onAdded }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [aegisId, setAegisId] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const addByAegisId = useContacts((s) => s.addByAegisId);

  const trimmedId = aegisId.trim().toUpperCase();
  const idValid = AEGIS_ID_RE.test(trimmedId);

  async function handlePaste() {
    const text = await Clipboard.getStringAsync();
    if (text) setAegisId(text.trim());
  }

  async function handleAdd() {
    if (!idValid) return;
    setSubmitting(true);
    try {
      const contact = await addByAegisId(trimmedId, name);
      onAdded(contact);
    } catch (e) {
      const raw = (e as Error).message ?? '';
      // Translate low-level network errors into something actionable.
      const message =
        raw.toLowerCase().includes('network') ||
        raw.toLowerCase().includes('failed to fetch') ||
        raw.toLowerCase().includes('network request failed')
          ? i18nT(
              'addContact.networkError',
              'Could not connect to the server. Check your internet connection and try again.',
            )
          : raw;
      Alert.alert(i18nT('addContact.errorTitle', 'Could not add contact'), message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.top}>
        <Pressable onPress={onCancel} hitSlop={8} style={{ padding: 6 }}>
          <I.ChevronL size={24} color={t.text} />
        </Pressable>
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
          {i18nT('addContact.title')}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={{ paddingHorizontal: 22, paddingTop: 18 }}>
        <Text
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.textDim,
            letterSpacing: 1.1,
            marginBottom: 8,
          }}
        >
          {i18nT('addContact.aegisIdLabel')}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: idValid || aegisId.length === 0 ? t.border : t.danger,
            borderRadius: t.radius,
            paddingHorizontal: 14,
          }}
        >
          <TextInput
            value={aegisId}
            onChangeText={(s) => setAegisId(s.toUpperCase())}
            placeholder={i18nT('addContact.idPlaceholder')}
            placeholderTextColor={t.textFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            spellCheck={false}
            style={{
              flex: 1,
              fontFamily: t.fontMono,
              fontSize: 18,
              color: t.text,
              paddingVertical: 14,
              letterSpacing: 1,
            }}
          />
          <Pressable onPress={handlePaste} hitSlop={8} style={{ padding: 6 }}>
            <I.Copy size={18} color={t.textDim} />
          </Pressable>
        </View>
        {aegisId.length > 0 && !idValid && (
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger, marginTop: 6 }}>
            {i18nT('addContact.invalidIdDesc')}
          </Text>
        )}

        <Text
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.textDim,
            letterSpacing: 1.1,
            marginBottom: 8,
            marginTop: 24,
          }}
        >
          {i18nT('addContact.nicknameLabel')}
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={i18nT('addContact.nicknamePlaceholder')}
          placeholderTextColor={t.textFaint}
          style={{
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
            paddingHorizontal: 14,
            paddingVertical: 14,
            fontFamily: t.font,
            fontSize: 15,
            color: t.text,
          }}
        />

        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 22, lineHeight: 19 }}>
          {i18nT('addContact.description')}
        </Text>

        <View style={{ marginTop: 28 }}>
          <PrimaryButton
            t={t}
            label={submitting ? i18nT('addContact.adding') : i18nT('addContact.addBtn')}
            disabled={!idValid || submitting}
            onPress={handleAdd}
          />
        </View>

        {submitting && (
          <View style={{ marginTop: 14, alignItems: 'center' }}>
            <ActivityIndicator color={t.accent} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
});
