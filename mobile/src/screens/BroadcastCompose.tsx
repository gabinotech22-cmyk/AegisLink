import { useState } from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { decodeBase64 } from 'tweetnacl-util';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { sendMessage } from '../socket/client';
import type { DistributionList } from '../store/distribution';
import { themedAlert } from '../components/AlertHost';

interface Props {
  list: DistributionList;
  onBack: () => void;
}

type SendState = 'idle' | 'sending' | 'done';

export function BroadcastComposeScreen({ list, onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const { contacts } = useContacts();

  const [text, setText] = useState('');
  const [sendState, setSendState] = useState<SendState>('idle');
  const [sentCount, setSentCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [progressIndex, setProgressIndex] = useState(0);

  const total = list.members.length;

  async function handleSend() {
    const body = text.trim();
    if (!body) {
      themedAlert(i18nT('broadcast.emptyTitle'), i18nT('broadcast.emptyDesc'));
      return;
    }
    if (!identity) {
      themedAlert(i18nT('broadcast.notReadyTitle'), i18nT('broadcast.notReadyDesc'));
      return;
    }

    setSendState('sending');
    setSentCount(0);
    setFailCount(0);
    setProgressIndex(0);

    let localSent = 0;
    let localFailed = 0;

    // Send individually so recipients don't know about each other
    await Promise.allSettled(
      list.members.map(async (aegisId, idx) => {
        const contact = contacts.find((c) => c.aegisId === aegisId);
        if (!contact) {
          localFailed += 1;
          setFailCount(localFailed);
          return;
        }
        try {
          await sendMessage({
            identity,
            recipientAegisId: aegisId,
            recipientPublicKey: decodeBase64(contact.publicKeyB64),
            plaintext: body,
          });
          localSent += 1;
          setSentCount(localSent);
        } catch {
          localFailed += 1;
          setFailCount(localFailed);
        } finally {
          setProgressIndex((prev) => prev + 1);
        }
        void idx; // satisfy exhaustive
      })
    );

    setSendState('done');
    setSentCount(localSent);
    setFailCount(localFailed);
  }

  function handleDone() {
    onBack();
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: t.bg }}
    >
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <TopBar
          t={t}
          title={list.name}
          left={
            <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }} accessibilityLabel={i18nT('broadcast.backA11y')}>
              <I.ChevronL size={22} color={t.textDim} />
            </Pressable>
          }
        />

        <ScrollView
          contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 18, gap: 14 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Info row */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.border,
              borderRadius: t.radius,
              padding: 14,
            }}
          >
            <I.Broadcast size={18} color={t.accent} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>
                {list.name}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, marginTop: 2 }}>
                {total} {i18nT(total === 1 ? 'broadcast.recipient' : 'broadcast.recipients')} · {i18nT('broadcast.individualMessages')}
              </Text>
            </View>
          </View>

          {/* Privacy note */}
          <View
            style={{
              padding: 12,
              backgroundColor: `${t.accent}0d`,
              borderWidth: 1,
              borderColor: `${t.accent}22`,
              borderRadius: t.radiusS,
            }}
          >
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
              Each recipient receives a separate encrypted message. Recipients cannot see each other.
            </Text>
          </View>

          {/* Message input */}
          <View
            style={{
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.border,
              borderRadius: t.radius,
              padding: 14,
              minHeight: 140,
            }}
          >
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={i18nT('broadcast.placeholder')}
              placeholderTextColor={t.textFaint}
              multiline
              editable={sendState === 'idle'}
              style={{
                fontFamily: t.font,
                fontSize: 15,
                color: t.text,
                flex: 1,
                minHeight: 112,
                textAlignVertical: 'top',
              }}
              accessibilityLabel={i18nT('broadcast.messageA11y')}
            />
          </View>

          {/* Progress / result */}
          {sendState === 'sending' && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                padding: 14,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: t.radius,
              }}
            >
              <ActivityIndicator color={t.accent} size="small" />
              <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, letterSpacing: 0.5 }}>
                SENDING TO {progressIndex}/{total} MEMBERS…
              </Text>
            </View>
          )}

          {sendState === 'done' && (
            <View
              style={{
                padding: 14,
                backgroundColor: failCount === 0 ? `${t.accent}12` : `${t.warn}10`,
                borderWidth: 1,
                borderColor: failCount === 0 ? `${t.accent}33` : `${t.warn}44`,
                borderRadius: t.radius,
                gap: 6,
              }}
            >
              <Text
                style={{
                  fontFamily: t.font,
                  fontSize: 15,
                  fontWeight: '600',
                  color: failCount === 0 ? t.accent : t.warn,
                }}
              >
                {failCount === 0
                  ? `Sent to ${sentCount} ${sentCount === 1 ? 'member' : 'members'}`
                  : `Sent to ${sentCount}/${total} (${failCount} failed)`}
              </Text>
              {failCount > 0 && (
                <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
                  Failed recipients may be offline. Try again later.
                </Text>
              )}
            </View>
          )}

          {/* Send button */}
          {sendState !== 'done' ? (
            <Pressable
              onPress={() => void handleSend()}
              disabled={sendState === 'sending' || !text.trim()}
              accessibilityLabel={`Send to ${total} members`}
              style={({ pressed }) => ({
                paddingVertical: 14,
                backgroundColor:
                  sendState === 'sending' || !text.trim() ? t.surface2 : t.accent,
                borderRadius: t.radiusL,
                alignItems: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              {sendState === 'sending' ? (
                <ActivityIndicator color={t.textDim} size="small" />
              ) : (
                <Text
                  style={{
                    fontFamily: t.font,
                    fontSize: 15,
                    fontWeight: '600',
                    color: text.trim() ? t.accentInk : t.textFaint,
                  }}
                >
                  Send to {total} {total === 1 ? 'member' : 'members'}
                </Text>
              )}
            </Pressable>
          ) : (
            <Pressable
              onPress={handleDone}
              accessibilityLabel={i18nT('broadcast.doneA11y')}
              style={({ pressed }) => ({
                paddingVertical: 14,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: t.radiusL,
                alignItems: 'center',
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>{i18nT('broadcast.done')}</Text>
            </Pressable>
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}
