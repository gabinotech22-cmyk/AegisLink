/**
 * TorConnection — Privacy → Network → "Tor connection" (bridges).
 *
 * Tor is always on and there is no clearnet fallback; this screen only chooses
 * HOW tor reaches the Tor network: automatic (direct, then built-in bridges
 * when the network blocks Tor), a fixed transport, or the user's own bridge
 * lines (validated in net/torConnection.ts). Desktop twin:
 * desktop/src/renderer/screens/TorConnection.tsx.
 */
import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import { setTorConnection, useTorConnection, type SetTorConnectionResult } from '../net/torConnection';
import { CONNECTION_MODES, type TorConnectionMode } from '../net/torBridges';

interface Props {
  onBack: () => void;
}

export function TorConnectionScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const live = useTorConnection();
  const [mode, setMode] = useState<TorConnectionMode>(live.mode);
  const [customText, setCustomText] = useState(live.custom.join('\n'));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SetTorConnectionResult | null>(null);

  // A binary built before bridges can only connect direct.
  const modes = live.bridgesAvailable ? CONNECTION_MODES : (['auto', 'direct'] as const);

  const apply = async (): Promise<void> => {
    setSaving(true);
    setResult(null);
    try {
      setResult(await setTorConnection(mode, mode === 'custom' ? customText : null));
    } finally {
      setSaving(false);
    }
  };

  const label = { fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, letterSpacing: 1.2, marginTop: 18, marginBottom: 8 } as const;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('torConnection.title')}
        big
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }} accessibilityLabel={i18nT('common.back', 'Back')}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 28 + insets.bottom }} keyboardShouldPersistTaps="handled">
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>{i18nT('torConnection.intro')}</Text>

        <Text style={label}>{i18nT('torConnection.nowSection')}</Text>
        <View testID="tor-connection-status" style={{ backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, padding: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <I.Shield size={20} color={live.progress >= 100 ? t.accent : t.textDim} />
            <Text style={{ fontFamily: t.font, fontSize: 15, color: t.text, fontWeight: '600' }}>
              {i18nT(`torConnection.transport.${live.transport}`)}
            </Text>
          </View>
          <Text style={{ fontFamily: t.font, fontSize: 12, color: live.error ? t.danger : t.textDim, marginTop: 6 }}>
            {live.progress >= 100 ? i18nT('torConnection.connected') : `${live.progress}%`}
          </Text>
        </View>

        <Text style={label}>{i18nT('torConnection.modeSection')}</Text>
        <View accessibilityRole="radiogroup">
          {modes.map((m) => (
            <Pressable
              key={m}
              testID={`tor-mode-${m}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode === m }}
              onPress={() => { setMode(m); setResult(null); }}
              style={{ flexDirection: 'row', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.divider }}
            >
              <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: mode === m ? t.accent : t.textFaint, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                {mode === m ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent }} /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{i18nT(`torConnection.mode.${m}`)}</Text>
                <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2, lineHeight: 17 }}>{i18nT(`torConnection.modeSub.${m}`)}</Text>
              </View>
            </Pressable>
          ))}
        </View>

        {mode === 'custom' && (
          <>
            <Text style={label}>{i18nT('torConnection.customSection')}</Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17, marginBottom: 8 }}>{i18nT('torConnection.customHelp')}</Text>
            <TextInput
              testID="tor-custom-bridges"
              value={customText}
              onChangeText={(v) => { setCustomText(v); setResult(null); }}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              placeholder="obfs4 192.0.2.1:443 FINGERPRINT cert=… iat-mode=0"
              placeholderTextColor={t.textFaint}
              accessibilityLabel={i18nT('torConnection.customSection')}
              style={{ minHeight: 120, textAlignVertical: 'top', fontFamily: t.fontMono, fontSize: 12, color: t.text, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, padding: 12 }}
            />
          </>
        )}

        <View style={{ height: 16 }} />
        <PrimaryButton t={t} label={saving ? i18nT('torConnection.applying') : i18nT('torConnection.apply')} onPress={() => void apply()} disabled={saving} />

        {result?.ok && (
          <Text testID="tor-connection-applied" style={{ fontFamily: t.font, fontSize: 13, color: t.accent, marginTop: 12, lineHeight: 18 }}>
            {i18nT('torConnection.applied')}
            {mode === 'custom' && result.rejected > 0 ? ` ${i18nT('torConnection.someRejected', { n: result.rejected })}` : ''}
          </Text>
        )}
        {result && !result.ok && (
          <Text testID="tor-connection-error" style={{ fontFamily: t.font, fontSize: 13, color: t.danger, marginTop: 12, lineHeight: 18 }}>
            {result.error === 'no_valid_bridges' ? i18nT('torConnection.noValidBridges') : i18nT('torConnection.invalid')}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
