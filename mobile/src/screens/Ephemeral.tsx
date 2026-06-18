import { useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useMessages } from '../store/messages';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
  /** The chatId (aegisId) this timer applies to. Required for per-chat persistence. */
  chatId: string;
}

const OPT_IDS = ['off', '30s', '5m', '1h', '1d', '7d', '30d'] as const;
type OptId = typeof OPT_IDS[number];

interface Opt {
  id: OptId;
  labelKey: string;
  subKey: string;
  sec: number;
}

const OPTS: Opt[] = [
  { id: 'off',  labelKey: 'ephemeral.offLabel',  subKey: 'ephemeral.offDesc',  sec: 0 },
  { id: '30s',  labelKey: 'ephemeral.30sLabel',  subKey: 'ephemeral.30sDesc',  sec: 30 },
  { id: '5m',   labelKey: 'ephemeral.5mLabel',   subKey: 'ephemeral.5mDesc',   sec: 300 },
  { id: '1h',   labelKey: 'ephemeral.1hLabel',   subKey: 'ephemeral.1hDesc',   sec: 3600 },
  { id: '1d',   labelKey: 'ephemeral.1dLabel',   subKey: 'ephemeral.1dDesc',   sec: 86400 },
  { id: '7d',   labelKey: 'ephemeral.7dLabel',   subKey: 'ephemeral.7dDesc',   sec: 604800 },
  { id: '30d',  labelKey: 'ephemeral.30dLabel',  subKey: 'ephemeral.30dDesc',  sec: 2592000 },
];

export function EphemeralScreen({ onBack, chatId }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const getEphemeralTimer = useMessages((s) => s.getEphemeralTimer);
  const setChatEphemeralTimerAction = useMessages((s) => s.setChatEphemeralTimer);

  const currentSec = getEphemeralTimer(chatId);
  // Determine active picked ID from current store seconds
  const initialPick = OPTS.find((o) => o.sec === currentSec)?.id ?? 'off';
  const [pick, setPick] = useState<string>(initialPick);

  function handleSelect(id: OptId, sec: number, labelKey: string) {
    setPick(id);
    void setChatEphemeralTimerAction(chatId, sec);
    if (sec > 0) {
      themedAlert(
        i18nT('ephemeral.alertTitle'),
        i18nT('ephemeral.alertEnabled', { label: i18nT(labelKey) })
      );
    } else {
      themedAlert(i18nT('ephemeral.alertTitle'), i18nT('ephemeral.alertDisabled'));
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('ephemeral.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 22 }}>
        <View style={{ paddingHorizontal: 4, paddingVertical: 22, alignItems: 'center' }}>
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.borderStrong,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            <I.Timer size={32} stroke={1.6} color={t.accent} />
          </View>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text, textAlign: 'center' }}>
            {i18nT('ephemeral.title')}
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19, textAlign: 'center', maxWidth: 280, marginTop: 8 }}>
            {i18nT('ephemeral.desc')}
          </Text>
        </View>

        <View
          style={{
            backgroundColor: t.surface,
            borderRadius: t.radius,
            borderWidth: 1,
            borderColor: t.border,
            overflow: 'hidden',
          }}
        >
          {OPTS.map((o, i) => {
            const sel = pick === o.id;
            return (
              <Pressable
                key={o.id}
                onPress={() => handleSelect(o.id, o.sec, o.labelKey)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderBottomWidth: i < OPTS.length - 1 ? 1 : 0,
                  borderBottomColor: t.divider,
                  backgroundColor: sel
                    ? t.dark
                      ? 'rgba(91,242,185,0.06)'
                      : 'rgba(13,143,95,0.06)'
                    : 'transparent',
                }}
              >
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    borderWidth: 2,
                    borderColor: sel ? t.accent : t.borderStrong,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {sel ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.accent }} /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: sel ? '600' : '400', color: t.text }}>
                    {i18nT(o.labelKey)}
                  </Text>
                  <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{i18nT(o.subKey)}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
