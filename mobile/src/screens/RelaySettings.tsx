/**
 * RelaySettings — Privacy → Network → "My relay" (federation F5b,
 * docs/FEDERATION-DESIGN.md D4).
 *
 * Shows which relay hosts our identity + mailbox, lets the user point the app
 * at a self-hosted relay (.onion only) after verifying it, and back to the
 * official one. Consequences are spelled out before the switch; the migration
 * itself is `net/relayMigration.ts` (register on the new relay → announce to
 * contacts → switch → reconnect, with a 7-day grace window on the old one).
 * Reachable only with the FEDERATION flag on (App.tsx / Privacy.tsx gate).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Modal, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import { useIdentity } from '../store/identity';
import { relayRefFromOnion, shortOnion, type RelayRef } from '../net/relayRef';
import { describeHome, migrateHomeRelay, verifyRelay, type RelayInfo, type MigrateError, type VerifyRelayResult } from '../net/relayMigration';

interface Props {
  onBack: () => void;
}

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; ref: RelayRef; info: RelayInfo }
  | { kind: 'error'; error: Exclude<VerifyRelayResult, { ok: true }>['error'] | 'invalid_onion' };

type MigrateState =
  | { kind: 'idle' }
  | { kind: 'confirm'; target: RelayRef | null }
  | { kind: 'running'; target: RelayRef | null }
  | { kind: 'done'; target: RelayRef | null }
  | { kind: 'error'; error: MigrateError; detail?: string };

function formatDate(ts: number, locale?: string): string {
  try {
    return new Date(ts).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return String(ts);
  }
}

export function RelaySettingsScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);

  const [home, setHome] = useState(() => describeHome());
  const [onionInput, setOnionInput] = useState('');
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [migrate, setMigrate] = useState<MigrateState>({ kind: 'idle' });

  const typedRef = useMemo(() => relayRefFromOnion(onionInput), [onionInput]);
  const verifiedRef = verify.kind === 'ok' && typedRef && typedRef.onion === verify.ref.onion ? verify.ref : null;

  const handleVerify = useCallback(async () => {
    const ref = relayRefFromOnion(onionInput);
    if (!ref) { setVerify({ kind: 'error', error: 'invalid_onion' }); return; }
    setVerify({ kind: 'verifying' });
    const r = await verifyRelay(ref);
    setVerify(r.ok ? { kind: 'ok', ref, info: r.info } : { kind: 'error', error: r.error });
  }, [onionInput]);

  const runMigration = useCallback(async (target: RelayRef | null) => {
    if (!identity) return;
    setMigrate({ kind: 'running', target });
    const r = await migrateHomeRelay(target, identity);
    if (r.ok) {
      setHome(describeHome());
      setOnionInput('');
      setVerify({ kind: 'idle' });
      setMigrate({ kind: 'done', target });
    } else {
      setMigrate({ kind: 'error', error: r.error, detail: r.detail });
    }
  }, [identity]);

  const errorText = (code: string): string => i18nT(`relaySettings.errors.${code}`, i18nT('relaySettings.errors.unknown'));

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('relaySettings.title')}
        big
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }} accessibilityLabel={i18nT('common.back', 'Back')}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 28 }} keyboardShouldPersistTaps="handled">
        {/* ── Current relay ─────────────────────────────────────────────── */}
        <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, letterSpacing: 1.2, marginBottom: 8 }}>
          {i18nT('relaySettings.currentSection')}
        </Text>
        <View style={{ backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, padding: 14, marginBottom: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <I.Globe size={20} color={t.accent} />
            <Text style={{ fontFamily: t.font, fontSize: 15, color: t.text, fontWeight: '600', flex: 1 }} testID="relay-current-label">
              {home.official ? i18nT('relaySettings.officialRelay') : i18nT('relaySettings.ownRelay')}
            </Text>
          </View>
          {home.onion && (
            <Text selectable style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, marginTop: 8 }} testID="relay-current-onion">
              {home.onion}
            </Text>
          )}
          {home.since > 0 && (
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textFaint, marginTop: 6 }}>
              {i18nT('relaySettings.since', { date: formatDate(home.since, i18n.language) })}
            </Text>
          )}
          {home.previous && (
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.warn, marginTop: 8, lineHeight: 17 }} testID="relay-previous">
              {i18nT('relaySettings.previousUntil', {
                relay: home.previous.onion ? shortOnion(home.previous.onion) : i18nT('relaySettings.officialRelay'),
                date: formatDate(home.previous.until, i18n.language),
              })}
            </Text>
          )}
        </View>

        {/* ── Use my own relay ───────────────────────────────────────────── */}
        <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, letterSpacing: 1.2, marginBottom: 8 }}>
          {i18nT('relaySettings.ownSection')}
        </Text>
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19, marginBottom: 12 }}>
          {i18nT('relaySettings.ownDesc')}
        </Text>
        <View style={{ backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, paddingHorizontal: 14 }}>
          <TextInput
            value={onionInput}
            onChangeText={(v) => { setOnionInput(v.trim().toLowerCase()); if (verify.kind !== 'idle') setVerify({ kind: 'idle' }); }}
            placeholder={i18nT('relaySettings.onionPlaceholder')}
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            keyboardType="url"
            testID="relay-onion-input"
            accessibilityLabel={i18nT('relaySettings.onionPlaceholder')}
            style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, paddingVertical: 14 }}
          />
        </View>
        <View style={{ height: 10 }} />
        <PrimaryButton
          t={t}
          label={verify.kind === 'verifying' ? i18nT('relaySettings.verifying') : i18nT('relaySettings.verify')}
          onPress={() => void handleVerify()}
          disabled={!onionInput || verify.kind === 'verifying' || migrate.kind === 'running'}
        />

        {verify.kind === 'error' && (
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger, marginTop: 10, lineHeight: 18 }} testID="relay-verify-error">
            {errorText(verify.error)}
          </Text>
        )}
        {verify.kind === 'ok' && (
          <View style={{ marginTop: 12, padding: 12, backgroundColor: t.surface2, borderRadius: t.radiusS }} testID="relay-verify-ok">
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.accent, fontWeight: '600' }}>
              {i18nT('relaySettings.verifiedTitle')}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, marginTop: 6 }}>
              {[verify.info.name, verify.info.version ? `v${verify.info.version}` : null, verify.info.features.join(' · ')].filter(Boolean).join('  ')}
            </Text>
            <View style={{ height: 10 }} />
            <PrimaryButton
              t={t}
              label={i18nT('relaySettings.switchCta', { relay: shortOnion(verify.ref.onion) })}
              onPress={() => setMigrate({ kind: 'confirm', target: verify.ref })}
              disabled={!verifiedRef || migrate.kind === 'running' || !identity}
            />
          </View>
        )}

        {/* ── Back to official ───────────────────────────────────────────── */}
        {!home.official && (
          <>
            <View style={{ height: 22 }} />
            <Pressable
              onPress={() => setMigrate({ kind: 'confirm', target: null })}
              disabled={migrate.kind === 'running'}
              testID="relay-back-official"
              style={{ paddingVertical: 12, alignItems: 'center' }}
            >
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.accent }}>{i18nT('relaySettings.backToOfficial')}</Text>
            </Pressable>
          </>
        )}

        {migrate.kind === 'error' && (
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger, marginTop: 12, lineHeight: 18 }} testID="relay-migrate-error">
            {errorText(migrate.error)}{migrate.detail ? ` (${migrate.detail})` : ''}
          </Text>
        )}
        {migrate.kind === 'done' && (
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.accent, marginTop: 12, lineHeight: 18 }} testID="relay-migrate-done">
            {i18nT('relaySettings.done')}
          </Text>
        )}
      </ScrollView>

      {/* ── Confirmation ─────────────────────────────────────────────────── */}
      <Modal visible={migrate.kind === 'confirm' || migrate.kind === 'running'} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, borderWidth: 1, borderColor: t.border }}>
            <Text style={{ fontFamily: t.font, fontSize: 17, fontWeight: '700', color: t.text }}>
              {i18nT('relaySettings.confirmTitle')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19, marginTop: 10 }} testID="relay-consequences">
              {i18nT('relaySettings.consequences')}
            </Text>
            {migrate.kind === 'running' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 }}>
                <ActivityIndicator color={t.accent} />
                <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>{i18nT('relaySettings.migrating')}</Text>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                <Pressable onPress={() => setMigrate({ kind: 'idle' })} style={{ flex: 1, paddingVertical: 13, alignItems: 'center', borderRadius: t.radius, borderWidth: 1, borderColor: t.border }} testID="relay-confirm-cancel">
                  <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{i18nT('common.cancel', 'Cancel')}</Text>
                </Pressable>
                <View style={{ flex: 1 }}>
                  <PrimaryButton
                    t={t}
                    label={i18nT('relaySettings.confirmCta')}
                    onPress={() => { if (migrate.kind === 'confirm') void runMigration(migrate.target); }}
                  />
                </View>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
