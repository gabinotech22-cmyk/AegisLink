import { useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import type { StoredGroup } from '../db/local';

interface Props {
  group?: StoredGroup;
  groupName?: string;
  onBack: () => void;
  onSend?: (question: string, options: string[]) => void;
}

export function PollScreen({ group, groupName, onBack, onSend }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [sending, setSending] = useState(false);

  const name = group?.name ?? groupName ?? '';
  const memberCount = group?.members.length ?? 0;

  function updateOption(idx: number, val: string) {
    setOptions((prev) => prev.map((o, i) => (i === idx ? val : o)));
  }

  function addOption() {
    if (options.length >= 6) return;
    setOptions((prev) => [...prev, '']);
  }

  function removeOption(idx: number) {
    if (options.length <= 2) return;
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSend() {
    const q = question.trim();
    const filled = options.map((o) => o.trim()).filter(Boolean);
    if (!q) {
      Alert.alert(i18nT('poll.missingQuestion'), i18nT('poll.missingQuestionDesc'));
      return;
    }
    if (filled.length < 2) {
      Alert.alert(i18nT('poll.fewOptions'), i18nT('poll.fewOptionsDesc'));
      return;
    }
    if (!onSend) return;
    setSending(true);
    try {
      onSend(q, filled);
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingTop: insets.top + 10,
          paddingBottom: 12,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: t.divider,
        }}
      >
        <Pressable onPress={onBack} hitSlop={12}>
          <I.ChevronL size={22} color={t.text} />
        </Pressable>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: t.radiusL,
            backgroundColor: `${t.accent}22`,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <I.Poll size={18} color={t.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 15, color: t.text }}>
            {i18nT('poll.title')}
          </Text>
          {name ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 }}>
              <I.Lock size={9} color={t.accent} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.6 }}>
                {name.toUpperCase()}{memberCount > 0 ? ` · ${i18nT('poll.memberCount', { count: memberCount })}` : ''}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Anonymous badge */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 18 }}>
          <View
            style={{
              borderWidth: 1,
              borderColor: t.accent,
              borderRadius: 99,
              paddingHorizontal: 7,
              paddingVertical: 2,
            }}
          >
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8 }}>
              {i18nT('poll.anonymousBadge')}
            </Text>
          </View>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4 }}>
            {i18nT('poll.mixedVotes')}
          </Text>
        </View>

        {/* Question */}
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 6 }}>
          {i18nT('poll.question').toUpperCase()}
        </Text>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          placeholder={i18nT('poll.question')}
          placeholderTextColor={t.textFaint}
          multiline
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 17,
            fontWeight: '600',
            color: t.text,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: t.radius,
            padding: 14,
            marginBottom: 22,
            lineHeight: 24,
          }}
        />

        {/* Options */}
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
          {i18nT('poll.options').toUpperCase()} ({options.length}/6)
        </Text>
        <View style={{ gap: 8, marginBottom: 10 }}>
          {options.map((opt, idx) => (
            <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 2,
                  borderColor: t.borderStrong,
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim }}>
                  {String.fromCharCode(65 + idx)}
                </Text>
              </View>
              <TextInput
                value={opt}
                onChangeText={(v) => updateOption(idx, v)}
                placeholder={i18nT('poll.optionPlaceholder', { letter: String.fromCharCode(65 + idx) })}
                placeholderTextColor={t.textFaint}
                style={{
                  flex: 1,
                  fontFamily: t.font,
                  fontSize: 14,
                  color: t.text,
                  backgroundColor: t.surface,
                  borderWidth: 1,
                  borderColor: t.border,
                  borderRadius: t.radiusS,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              />
              {options.length > 2 && (
                <Pressable onPress={() => removeOption(idx)} hitSlop={8}>
                  <I.X size={16} color={t.textDim} />
                </Pressable>
              )}
            </View>
          ))}
        </View>

        {options.length < 6 && (
          <Pressable
            onPress={addOption}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingVertical: 10,
              opacity: pressed ? 0.6 : 1,
              marginBottom: 22,
            })}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                borderWidth: 1.5,
                borderColor: `${t.accent}66`,
                borderStyle: 'dashed',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.Plus size={12} color={t.accent} />
            </View>
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.accent }}>
              {i18nT('poll.addOption')}
            </Text>
          </Pressable>
        )}

        {/* Anonymity notice */}
        <View
          style={{
            padding: 12,
            backgroundColor: t.surface,
            borderRadius: t.radiusS,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginBottom: 24,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <I.EyeOff size={13} color={t.textDim} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.4, flex: 1 }}>
            {i18nT('poll.anonymityNotice')}
          </Text>
        </View>

        {/* Send button */}
        <Pressable
          onPress={() => void handleSend()}
          disabled={sending || !onSend}
          style={({ pressed }) => ({
            backgroundColor: t.accent,
            paddingVertical: 14,
            borderRadius: t.radius,
            alignItems: 'center',
            opacity: pressed || sending || !onSend ? 0.7 : 1,
          })}
        >
          <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 15, color: t.accentInk }}>
            {sending ? i18nT('common.loading') : i18nT('poll.create')}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
