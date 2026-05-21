import { useEffect, useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import Svg, { Circle, Path, Line } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { PrimaryButton } from '../components/Button';
import { SERVER_URL } from '../config';

interface Props {
  onRetry: () => void;
}

type RelayState = 'up' | 'down' | 'probing';
interface RelayStatus { label: string; state: RelayState; detail: string }

const RELAY_LABELS = ['zurich-1', 'berlin-1', 'ny-1', 'sg-1'];

export function NetworkErrorScreen({ onRetry }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  const [relays, setRelays] = useState<RelayStatus[]>(
    RELAY_LABELS.map((label, i) => ({
      label,
      state: i === 2 ? 'probing' : 'down',
      detail: i === 2 ? 're-handshake…' : `timeout · ${10 + i * 2}s`,
    }))
  );

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    fetch(`${SERVER_URL}/health`, { signal: ctrl.signal })
      .then(() => {
        if (!cancelled) {
          setRelays(RELAY_LABELS.map((label) => ({ label, state: 'up' as RelayState, detail: 'ok' })));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRelays(RELAY_LABELS.map((label, i) => ({
            label,
            state: i === 2 ? 'probing' : 'down' as RelayState,
            detail: i === 2 ? 're-handshake…' : `timeout · ${10 + i * 2}s`,
          })));
        }
      })
      .finally(() => clearTimeout(timer));
    return () => { cancelled = true; };
  }, []);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.bg,
        paddingTop: insets.top + 40,
        paddingHorizontal: 28,
        paddingBottom: insets.bottom + 32,
        alignItems: 'center',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 'auto' }}>
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.warn }} />
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.warn, letterSpacing: 1.1 }}>
          {i18nT('networkError.status')}
        </Text>
      </View>

      <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center', marginBottom: 30 }}>
        <Svg viewBox="0 0 140 140" width={140} height={140}>
          <Circle cx={70} cy={70} r={60} fill="none" stroke={t.borderStrong} strokeWidth={1.5} strokeDasharray="4 6" opacity={0.5} />
          <Path d="M70 18 L114 42 L114 92 L70 116 L26 92 L26 42 Z" fill="none" stroke={t.warn} strokeWidth={2.5} strokeLinejoin="round" />
          <Line x1={36} y1={36} x2={104} y2={104} stroke={t.danger} strokeWidth={3} strokeLinecap="round" />
        </Svg>
      </View>

      <Text style={{ fontFamily: t.fontDisplay, fontSize: 26, fontWeight: '600', letterSpacing: -0.5, color: t.text, textAlign: 'center', marginBottom: 12 }}>
        {i18nT('networkError.title')}
      </Text>
      <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: 21, textAlign: 'center', maxWidth: 320, marginBottom: 20 }}>
        {i18nT('networkError.desc')}
      </Text>

      <View
        style={{
          width: '100%',
          padding: 14,
          backgroundColor: t.surface,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: t.radius,
          marginBottom: 22,
        }}
      >
        {relays.map((r, i) => (
          <RelayRow key={r.label} t={t} {...r} last={i === relays.length - 1} />
        ))}
      </View>

      <PrimaryButton t={t} label={i18nT('networkError.retryBtn')} onPress={onRetry} />
      <Pressable
        onPress={() =>
          Alert.alert(
            i18nT('networkError.emergencyRelayTitle'),
            i18nT('networkError.emergencyRelayDesc'),
            [{ text: i18nT('networkError.understood') }]
          )
        }
        style={{ paddingVertical: 12, paddingHorizontal: 12 }}
      >
        <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5 }}>
          {i18nT('networkError.emergencyRelay')}
        </Text>
      </Pressable>
    </View>
  );
}

function RelayRow({ t, label, state, detail, last }: { t: Theme; label: string; state: RelayState; detail: string; last: boolean }) {
  const c = state === 'down' ? t.danger : state === 'up' ? t.accent : t.warn;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: t.divider,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: c }} />
      <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 12, color: t.text }}>{label}</Text>
      <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: c, letterSpacing: 0.5 }}>
        {state.toUpperCase()} · {detail}
      </Text>
    </View>
  );
}
