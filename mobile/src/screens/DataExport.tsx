import { useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { PrimaryButton } from '../components/Button';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { usePreferences } from '../store/preferences';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
}

export function DataExportScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [pick, setPick] = useState({ messages: true, media: true, contacts: true, settings: false });
  const set = (k: keyof typeof pick, v: boolean) => setPick((p) => ({ ...p, [k]: v }));
  
  const [exporting, setExporting] = useState(false);
  const { identity, reset } = useIdentity();
  const { contacts } = useContacts();
  const readReceipts = usePreferences((s) => s.readReceipts);
  const typingIndicator = usePreferences((s) => s.typingIndicator);
  const blockScreenshots = usePreferences((s) => s.blockScreenshots);

  async function handleExport() {
    setExporting(true);
    try {
      const { loadMessagesByChat } = require('../db/local') as typeof import('../db/local');

      let conversations: Record<string, object[]> = {};
      let totalMessages = 0;
      if (pick.messages) {
        for (const c of contacts) {
          try {
            const msgs = await loadMessagesByChat(c.aegisId);
            if (msgs.length > 0) {
              conversations[c.name] = msgs.map((m) => ({
                id: m.id,
                direction: m.direction,
                body: m.mediaUri ? '[media omitted]' : m.body,
                createdAt: new Date(m.createdAt).toISOString(),
                type: m.type ?? 'text',
                deleted: m.deleted ?? false,
              }));
              totalMessages += msgs.length;
            }
          } catch { /* skip inaccessible chat */ }
        }
      }

      const dbData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        aegisId: identity?.aegisId ?? null,
        contacts: pick.contacts
          ? contacts.map((c) => ({ name: c.name, aegisId: c.aegisId, verified: c.verified, color: c.color }))
          : [],
        conversations: pick.messages ? conversations : {},
        totalMessages,
        settings: pick.settings ? { readReceipts, typingIndicator, blockScreenshots } : null,
      };

      const fileUri = (FileSystem.documentDirectory ?? '') + 'aegis_export.json';
      await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(dbData, null, 2));

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/json',
          dialogTitle: i18nT('dataExport.dialogTitle', 'Export AegisLink data'),
        });
      } else {
        themedAlert(
          i18nT('dataExport.fileSaved', 'File saved'),
          i18nT('dataExport.savedTo', 'Saved to: {{uri}}', { uri: fileUri })
        );
      }
    } catch (e) {
      themedAlert(i18nT('dataExport.exportError', 'Export error'), (e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  function handleDeleteAccount() {
    themedAlert(
      i18nT('dataExport.deleteAccountCaps', 'DELETE ACCOUNT'),
      i18nT('dataExport.deleteConfirmMsg', 'This will delete all your local keys and messages from this device permanently. It cannot be undone. Continue?'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        { 
          text: i18nT('dataExport.deleteConfirmBtn', 'Yes, Delete'), 
          style: 'destructive', 
          onPress: async () => {
            await reset(); // Clears DB, SecureStore, and throws user back to Onboarding
          } 
        }
      ]
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('dataExport.title', 'Your data')}
        big
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 }}>
        <View
          style={{
            marginHorizontal: 18,
            marginBottom: 16,
            padding: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
          }}
        >
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
            {i18nT('dataExport.infoDesc', 'AegisLink does not save anything on the server beyond opaque encrypted blobs. Here you control what leaves the device — and how to wipe everything if you leave.')}
          </Text>
        </View>

        <Section t={t} label={i18nT('dataExport.exportSection', 'EXPORT · LOCAL FILE')}>
          <Toggle t={t} label={i18nT('common.messages', 'Messages')} sub={i18nT('dataExport.messagesSub', 'Export chat history')} value={pick.messages} onChange={(v) => set('messages', v)} />
          <Toggle t={t} label={i18nT('dataExport.media', 'Media')} sub={i18nT('dataExport.mediaSub', 'Not yet available')} value={false} onChange={() => {}} disabled />
          <Toggle t={t} label={i18nT('common.contacts', 'Contacts')} sub={i18nT('dataExport.contactsSub', 'Export address book')} value={pick.contacts} onChange={(v) => set('contacts', v)} />
          <Toggle t={t} label={i18nT('common.settings', 'Settings')} sub={i18nT('dataExport.settingsSub', 'Preferences')} value={pick.settings} onChange={(v) => set('settings', v)} noBorder />
        </Section>

        <View
          style={{
            marginHorizontal: 18,
            marginBottom: 18,
            padding: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>
              {i18nT('dataExport.format', 'FORMAT')}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5 }}>
              {i18nT('dataExport.formatValue', 'JSON')}
            </Text>
          </View>
        </View>

        <View style={{ paddingHorizontal: 18, paddingBottom: 24 }}>
          {exporting ? (
             <ActivityIndicator color={t.accent} />
          ) : (
            <PrimaryButton t={t} label={i18nT('dataExport.generateBtn', 'Generate file')} onPress={handleExport} />
          )}
        </View>

        <View style={{ marginHorizontal: 18, marginBottom: 14, height: 1, backgroundColor: t.divider }} />

        <Section t={t} label={i18nT('dataExport.deleteAccount', 'Delete account')} hint={i18nT('dataExport.irreversible', 'IRREVERSIBLE')}>
          <View style={{ padding: 14 }}>
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
              {i18nT('dataExport.deleteDesc', 'Deleting your account permanently wipes all local keys, messages, and contacts from this device. Messages already received by your contacts remain on their devices.')}
            </Text>
          </View>
        </Section>

        <View style={{ paddingHorizontal: 18 }}>
          <Pressable
            onPress={handleDeleteAccount}
            style={({ pressed }) => ({
              backgroundColor: 'transparent',
              borderWidth: 1,
              borderColor: `${t.danger}66`,
              paddingVertical: 14,
              borderRadius: t.radius,
              alignItems: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ color: t.danger, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>
              {i18nT('dataExport.deleteBtn', 'Delete my account forever')}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
