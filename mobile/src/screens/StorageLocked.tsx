import { useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { PrimaryButton, GhostButton } from '../components/Button';
import { themedAlert } from '../components/AlertHost';

interface Props {
  /** Wipe the unreadable database + this slot's keys, then start over. */
  onReset: () => Promise<void>;
  /** Same wipe, then open the backup restore flow. */
  onRestore: () => Promise<void>;
}

/**
 * Shown when the SQLCipher database exists but the key SecureStore holds does
 * not open it (DbKeyMismatchError). Nothing in that file can be read without
 * the key, so the honest options are: restore from an AegisLink backup, or
 * start over. Both delete the unreadable file — after an explicit confirmation
 * that says so. Never offers a plaintext fallback (golden rule #1).
 */
export function StorageLockedScreen({ onReset, onRestore }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<null | 'reset' | 'restore'>(null);

  function confirm(kind: 'reset' | 'restore') {
    themedAlert(
      i18nT('storageLocked.confirmTitle'),
      i18nT('storageLocked.confirmBody'),
      [
        { text: i18nT('common.cancel'), style: 'cancel' },
        {
          text: i18nT(kind === 'reset' ? 'storageLocked.confirmReset' : 'storageLocked.confirmRestore'),
          style: 'destructive',
          onPress: () => {
            setBusy(kind);
            void (kind === 'reset' ? onReset() : onRestore()).finally(() => setBusy(null));
          },
        },
      ],
    );
  }

  return (
    <View
      accessibilityLabel="storage-locked"
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
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.danger }} />
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.danger, letterSpacing: 1.1 }}>
          {i18nT('storageLocked.status')}
        </Text>
      </View>

      <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center', marginBottom: 30 }}>
        <Svg viewBox="0 0 140 140" width={140} height={140}>
          <Circle cx={70} cy={70} r={60} fill="none" stroke={t.borderStrong} strokeWidth={1.5} strokeDasharray="4 6" opacity={0.5} />
          <Rect x={42} y={62} width={56} height={44} rx={8} fill="none" stroke={t.danger} strokeWidth={2.5} />
          <Path d="M52 62 V50 a18 18 0 0 1 36 0 V62" fill="none" stroke={t.danger} strokeWidth={2.5} strokeLinecap="round" />
          <Path d="M60 84 L80 84 M70 76 L70 92" stroke={t.danger} strokeWidth={2.5} strokeLinecap="round" opacity={0.6} />
        </Svg>
      </View>

      <Text style={{ fontFamily: t.fontDisplay, fontSize: 26, fontWeight: '600', letterSpacing: -0.5, color: t.text, textAlign: 'center', marginBottom: 12 }}>
        {i18nT('storageLocked.title')}
      </Text>
      <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: 21, textAlign: 'center', maxWidth: 320, marginBottom: 14 }}>
        {i18nT('storageLocked.desc')}
      </Text>
      <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textFaint, lineHeight: 19, textAlign: 'center', maxWidth: 320, marginBottom: 28 }}>
        {i18nT('storageLocked.why')}
      </Text>

      {busy ? (
        <ActivityIndicator color={t.accent} style={{ marginBottom: 24 }} />
      ) : (
        <>
          <PrimaryButton t={t} label={i18nT('storageLocked.restore')} onPress={() => confirm('restore')} />
          <View style={{ height: 10 }} />
          <GhostButton t={t} label={i18nT('storageLocked.reset')} onPress={() => confirm('reset')} />
        </>
      )}
    </View>
  );
}
