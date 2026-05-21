import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { usePreferences } from '../store/preferences';
import { useContacts } from '../store/contacts';

interface Props {
  onBack: () => void;
}

export function NotificationsScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  const hydrated = usePreferences((s) => s.hydrated);
  const hydrate  = usePreferences((s) => s.hydrate);
  const master   = usePreferences((s) => s.notifMaster);
  const preview  = usePreferences((s) => s.notifPreview);
  const sound    = usePreferences((s) => s.notifSound);
  const badge    = usePreferences((s) => s.notifBadge);
  const summary  = usePreferences((s) => s.notifSummary);
  const keywords = usePreferences((s) => s.notifKeywords);
  const mutedIds = usePreferences((s) => s.mutedChats);
  const setPref  = usePreferences((s) => s.set);

  useEffect(() => { if (!hydrated) void hydrate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setMaster  = (v: boolean) => void setPref('notifMaster', v);
  const setPreview = (v: boolean) => void setPref('notifPreview', v);
  const setSound   = (v: boolean) => void setPref('notifSound', v);
  const setBadge   = (v: boolean) => void setPref('notifBadge', v);
  const setSummary = (v: boolean) => void setPref('notifSummary', v);

  const contacts = useContacts((s) => s.contacts);
  const getContactDisplayName = (id: string) => {
    const found = contacts.find((c) => c.aegisId === id);
    return found ? found.name : id;
  };

  const muted = mutedIds.map((id) => ({
    id,
    name: getContactDisplayName(id),
    until: i18nT('notifications.always', 'always')
  }));

  const removeKeyword = (k: string) => void setPref('notifKeywords', keywords.filter((x) => x !== k));
  const unmuteChat    = (id: string) => void setPref('mutedChats', mutedIds.filter((x) => x !== id));

  const [kwInput, setKwInput] = useState('');
  const [showKwInput, setShowKwInput] = useState(false);
  const kwRef = useRef<TextInput>(null);

  function commitKeyword() {
    const v = kwInput.trim().toLowerCase();
    if (v && !keywords.includes(v)) {
      void setPref('notifKeywords', [...keywords, v]);
    }
    setKwInput('');
    setShowKwInput(false);
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('notifications.title', 'Notifications')}
        big
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingTop: 4, paddingBottom: 22 }}>
        <Section t={t} label={i18nT('notifications.generalSection', 'GENERAL')}>
          <Toggle t={t} label={i18nT('notifications.notifLabel', 'Notifications')} sub={i18nT('notifications.masterSub', 'Master switch · turns off all notifications')} value={master} onChange={setMaster} />
          <View style={{ opacity: master ? 1 : 0.4 }} pointerEvents={master ? 'auto' : 'none'}>
            <Toggle
              t={t}
              label={i18nT('notifications.showContent', 'Show content')}
              sub={i18nT('notifications.showContentSub', 'If off, only displays "new encrypted message"')}
              value={preview}
              onChange={setPreview}
            />
            <Toggle t={t} label={i18nT('notifications.soundLabel', 'Sound')} value={sound} onChange={setSound} />
            <Toggle
              t={t}
              label={i18nT('notifications.badgeLabel', 'Badge counter')}
              sub={i18nT('notifications.badgeSub', 'Red dot counter on app icon')}
              value={badge}
              onChange={setBadge}
              noBorder
            />
          </View>
        </Section>

        <View style={{ opacity: master ? 1 : 0.4 }} pointerEvents={master ? 'auto' : 'none'}>
        <Section t={t} label={i18nT('notifications.keywordsLabel', 'PRIORITY KEYWORDS')}>
          <View style={{ padding: 14 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {keywords.map((k) => (
                <View
                  key={k}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingLeft: 10,
                    paddingRight: 4,
                    paddingVertical: 4,
                    backgroundColor: t.surface2,
                    borderRadius: 99,
                  }}
                >
                  <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text }}>{k}</Text>
                  <Pressable
                    onPress={() => removeKeyword(k)}
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 8,
                      backgroundColor: t.surface3,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    hitSlop={6}
                  >
                    <Text style={{ color: t.textDim, fontSize: 11 }}>×</Text>
                  </Pressable>
                </View>
              ))}
              {showKwInput ? (
                <TextInput
                  ref={kwRef}
                  autoFocus
                  value={kwInput}
                  onChangeText={setKwInput}
                  onSubmitEditing={commitKeyword}
                  onBlur={commitKeyword}
                  placeholder={i18nT('notifications.keywordPlaceholder', 'keyword...')}
                  placeholderTextColor={t.textFaint}
                  returnKeyType="done"
                  style={{
                    fontFamily: t.fontMono,
                    fontSize: 11,
                    color: t.text,
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                    borderWidth: 1,
                    borderColor: t.accent,
                    borderRadius: 99,
                    minWidth: 110,
                  }}
                />
              ) : (
                <Pressable
                  onPress={() => setShowKwInput(true)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                    borderWidth: 1,
                    borderColor: t.borderStrong,
                    borderStyle: 'dashed',
                    borderRadius: 99,
                  }}
                >
                  <Text style={{ color: t.accent, fontFamily: t.fontMono, fontSize: 11 }}>
                    {i18nT('notifications.addBtn', '+ add')}
                  </Text>
                </Pressable>
              )}
            </View>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17 }}>
              {i18nT('notifications.keywordsDesc', 'Messages containing these keywords will always notify you, even if the chat is muted.')}
            </Text>
          </View>
        </Section>

        <Section t={t} label={i18nT('notifications.dailySummary', 'DAILY SUMMARY')}>
          <Toggle
            t={t}
            label={i18nT('notifications.localSummary', 'Generate local summary')}
            sub={i18nT('notifications.localSummarySub', 'Processed on-device · 19:30')}
            value={summary}
            onChange={setSummary}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('notifications.mutedSectionTitle', 'MUTED · {{count}}', { count: muted.length })}>
          {muted.map((m, i) => (
            <View
              key={m.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: i < muted.length - 1 ? 1 : 0,
                borderBottomColor: t.divider,
              }}
            >
              <I.Mute size={18} color={t.textDim} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{m.name}</Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.4, marginTop: 2 }}>
                  {i18nT('notifications.mutedUntil', 'UNTIL {{until}}', { until: m.until.toUpperCase() })}
                </Text>
              </View>
              <Pressable
                onPress={() => unmuteChat(m.id)}
                style={({ pressed }) => ({
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderWidth: 1,
                  borderColor: t.borderStrong,
                  borderRadius: t.radiusS,
                  backgroundColor: pressed ? t.surface2 : 'transparent',
                })}
              >
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.text, letterSpacing: 0.4 }}>
                  {i18nT('notifications.unmuteBtn', 'UNMUTE')}
                </Text>
              </Pressable>
            </View>
          ))}
        </Section>
        </View>
      </ScrollView>
    </View>
  );
}
