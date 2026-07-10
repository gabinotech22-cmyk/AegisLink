import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import Svg, { Circle, Path, Line } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { PrimaryButton } from '../components/Button';
import { SERVER_URL } from '../config';
import { themedAlert } from '../components/AlertHost';
import { useIdentity } from '../store/identity';

interface Props {
  onRetry: () => void;
}

type RelayState = 'up' | 'down' | 'probing';
interface RelayStatus { label: string; state: RelayState; detail: string }

// The app talks to ONE real relay (config SERVER_URL). We probe its live
// reachability but show a generic "AegisLink relay" label — no need to surface
// the real hostname in the UI — instead of the old hard-coded mock list
// (zurich/berlin/…) that falsely reported every node "UP · ok" even offline.

export function NetworkErrorScreen({ onRetry }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  // Registration failures are the #1 reason a device ends up stuck here: a
  // failed ensureRegistered() leaves publishStatus='failed' and this screen
  // then takes over the WHOLE tree (App.tsx, ~5s offline), burying Home's
  // error banner underneath it. themedAlert (in identity.ts) covers the
  // first moment, but an Alert can be dismissed and lost — this block is
  // PERSISTENT for as long as the device sits on this screen, so the
  // `[step] ErrorName: message` diagnostic is always readable, not just
  // glimpsed once.
  const publishStatus = useIdentity((s) => s.publishStatus);
  const publishError = useIdentity((s) => s.publishError);

  // Show a generic label instead of the real relay hostname — no need to expose
  // the actual endpoint in the UI. The status (reachable/unreachable) is still
  // probed live against the real SERVER_URL below.
  const host = i18nT('networkError.relayLabel', 'AegisLink relay');
  const [relays, setRelays] = useState<RelayStatus[]>([
    { label: host, state: 'probing', detail: i18nT('networkError.probing', 'probing…') },
  ]);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    fetch(`${SERVER_URL}/health`, { signal: ctrl.signal })
      .then((res) => {
        if (cancelled) return;
        setRelays([{
          label: host,
          state: res.ok ? 'up' : 'down',
          detail: res.ok ? i18nT('networkError.reachable', 'reachable') : `http ${res.status}`,
        }]);
      })
      .catch(() => {
        if (!cancelled) {
          setRelays([{ label: host, state: 'down', detail: i18nT('networkError.unreachable', 'unreachable') }]);
        }
      })
      .finally(() => clearTimeout(timer));
    return () => { cancelled = true; ctrl.abort(); };
  }, [host, i18nT]);
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

      {publishStatus === 'failed' && !!publishError && (
        <View
          accessibilityRole="alert"
          accessibilityLabel={`registration-error: ${publishError}`}
          style={{
            width: '100%',
            padding: 12,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.danger,
            borderRadius: t.radius,
            marginBottom: 14,
          }}
        >
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.danger, letterSpacing: 0.5, marginBottom: 6 }}>
            REGISTRATION FAILED
          </Text>
          <ScrollView style={{ maxHeight: 110 }} nestedScrollEnabled>
            <Text
              selectable
              style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text, lineHeight: 16 }}
            >
              {publishError}
            </Text>
          </ScrollView>
        </View>
      )}

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
          themedAlert(
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
