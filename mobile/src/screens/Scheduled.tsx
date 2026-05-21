import { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, Modal, TextInput, Alert, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { GhostButton, PrimaryButton } from '../components/Button';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { sendMessage } from '../socket/client';
import { decodeBase64 } from 'tweetnacl-util';
import type { StoredContact } from '../db/local';

const SCHEDULED_KEY = 'aegis.scheduled.v1';

interface Props {
  contact?: StoredContact;
  onBack: () => void;
}

interface ScheduledItem {
  id: string;
  toContact: StoredContact;
  text: string;
  sendAt: number; // timestamp when it should be sent
}

const DELAY_KEYS = [
  { lKey: 'scheduled.delay5sTest', sec: 5 },
  { lKey: 'scheduled.delay15s', sec: 15 },
  { lKey: 'scheduled.delay1m', sec: 60 },
  { lKey: 'scheduled.delay5m', sec: 300 },
  { lKey: 'scheduled.delay1h', sec: 3600 },
  { lKey: 'scheduled.delay1d', sec: 86400 },
];

export function ScheduledScreen({ contact, onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { contacts } = useContacts();
  const { identity } = useIdentity();

  const [items, setItems] = useState<ScheduledItem[]>([]);
  const [isScheduling, setIsScheduling] = useState(false);
  const [targetContactId, setTargetContactId] = useState(contact?.aegisId ?? contacts[0]?.aegisId ?? '');
  const [bodyText, setBodyText] = useState('');
  const [delay, setDelay] = useState(5);
  const [now, setNow] = useState(Date.now());

  // Persist helpers
  const persist = useCallback(async (next: ScheduledItem[]) => {
    try {
      await SecureStore.setItemAsync(SCHEDULED_KEY, JSON.stringify(next));
    } catch { /* storage full or unavailable — degrade gracefully */ }
  }, []);

  // Load and sync items on periodic interval to match background runner (Gap 4)
  useEffect(() => {
    const sync = async () => {
      try {
        const raw = await SecureStore.getItemAsync(SCHEDULED_KEY);
        if (raw) {
          const loaded = JSON.parse(raw) as ScheduledItem[];
          setItems(loaded);
        } else {
          setItems([]);
        }
      } catch {}
    };
    sync();
    const timer = setInterval(() => {
      setNow(Date.now());
      sync();
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  function handleAddScheduled() {
    if (!bodyText.trim()) {
      Alert.alert(i18nT('common.error'), i18nT('scheduled.errorEmptyMessage'));
      return;
    }
    const dest = contacts.find((c) => c.aegisId === targetContactId);
    if (!dest) {
      Alert.alert(i18nT('common.error'), i18nT('scheduled.errorNoRecipient'));
      return;
    }

    const newItem: ScheduledItem = {
      id: Math.random().toString(36).substr(2, 9),
      toContact: dest,
      text: bodyText.trim(),
      sendAt: Date.now() + delay * 1000,
    };

    const next = [...items, newItem];
    setItems(next);
    void persist(next);
    setBodyText('');
    setIsScheduling(false);
    Alert.alert(i18nT('scheduled.scheduledAlert'), i18nT('scheduled.scheduledAlertDesc', { name: dest.name, delay }));
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('scheduled.title')}
        big
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
        right={
          <Pressable onPress={() => setIsScheduling(true)} hitSlop={8} style={{ padding: 4 }}>
            <I.Plus size={22} color={t.accent} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 22 + insets.bottom }}>
        <View
          style={{
            marginHorizontal: 18,
            marginBottom: 14,
            padding: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
          }}
        >
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
            {i18nT('scheduled.infoDesc')}
          </Text>
        </View>

        {items.length === 0 ? (
          <View style={{ padding: 36, alignItems: 'center' }}>
            <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint, textAlign: 'center' }}>
              {i18nT('scheduled.empty')}
            </Text>
          </View>
        ) : (
          items.map((it) => {
            const secsLeft = Math.max(0, Math.ceil((it.sendAt - now) / 1000));
            return (
              <View
                key={it.id}
                style={{
                  flexDirection: 'row',
                  gap: 12,
                  paddingHorizontal: 18,
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: t.divider,
                }}
              >
                <View
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: t.radius,
                    backgroundColor: t.surface2,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <I.Timer size={18} color={t.accent} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        fontFamily: t.font,
                        fontWeight: '600',
                        fontSize: 13,
                        color: t.text,
                      }}
                    >
                      {it.toContact.name}
                    </Text>
                    <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.4 }}>
                      {i18nT('scheduled.inSeconds', { secs: secsLeft })}
                    </Text>
                  </View>
                  <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 18 }}>{it.text}</Text>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, marginTop: 4, letterSpacing: 0.5 }}>
                    {i18nT('scheduled.e2eeQueue')}
                  </Text>
                </View>
              </View>
            );
          })
        )}

        <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
          <GhostButton t={t} label={`+ ${i18nT('scheduled.schedule')}`} onPress={() => setIsScheduling(true)} />
        </View>
      </ScrollView>

      {/* Scheduler Modal */}
      <Modal visible={isScheduling} transparent animationType="slide">
        <View style={styles.modalBg}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
            <View style={[styles.modalContent, { backgroundColor: t.surface, borderColor: t.border }]}>
              <Text style={[styles.modalTitle, { color: t.text, fontFamily: t.fontDisplay }]}>
                {i18nT('scheduled.schedule')}
              </Text>
              
              <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 12, marginBottom: 6 }}>
                {i18nT('scheduled.recipientLabel')}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
                {contacts.map((c) => {
                  const isSel = targetContactId === c.aegisId;
                  return (
                    <Pressable
                      key={c.aegisId}
                      onPress={() => setTargetContactId(c.aegisId)}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: t.radiusS,
                        backgroundColor: isSel ? t.accent : t.bg,
                        borderWidth: 1,
                        borderColor: isSel ? t.accent : t.borderStrong,
                      }}
                    >
                      <Text style={{ color: isSel ? t.accentInk : t.text, fontSize: 12, fontFamily: t.font }}>
                        {c.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 12, marginBottom: 6 }}>
                {i18nT('scheduled.messageLabel')}
              </Text>
              <TextInput
                placeholder={i18nT('scheduled.messagePlaceholder')}
                placeholderTextColor={t.textDim}
                value={bodyText}
                onChangeText={setBodyText}
                multiline
                style={{
                  color: t.text,
                  backgroundColor: t.bg,
                  borderColor: t.borderStrong,
                  borderWidth: 1,
                  borderRadius: t.radiusS,
                  padding: 12,
                  fontSize: 14,
                  minHeight: 80,
                  marginBottom: 16,
                  fontFamily: t.font,
                }}
              />

              <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 12, marginBottom: 6 }}>
                {i18nT('scheduled.delayLabel')}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 22 }}>
                {DELAY_KEYS.map((d) => {
                  const isSel = delay === d.sec;
                  return (
                    <Pressable
                      key={d.sec}
                      onPress={() => setDelay(d.sec)}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: t.radiusS,
                        backgroundColor: isSel ? t.accent : t.bg,
                        borderWidth: 1,
                        borderColor: isSel ? t.accent : t.borderStrong,
                      }}
                    >
                      <Text style={{ color: isSel ? t.accentInk : t.text, fontSize: 11, fontFamily: t.font }}>
                        {i18nT(d.lKey)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable
                  onPress={handleAddScheduled}
                  style={{
                    flex: 1,
                    backgroundColor: t.accent,
                    paddingVertical: 12,
                    borderRadius: t.radiusS,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600' }}>
                    {i18nT('scheduled.schedule')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setIsScheduling(false);
                    setBodyText('');
                  }}
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderColor: t.borderStrong,
                    paddingVertical: 12,
                    borderRadius: t.radiusS,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500' }}>
                    {i18nT('common.cancel')}
                  </Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContent: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
});

