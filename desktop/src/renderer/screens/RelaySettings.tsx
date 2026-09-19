/**
 * RelaySettings — Privacy → Network → "My relay" (federation F5b,
 * docs/FEDERATION-DESIGN.md D4). Desktop twin of mobile/src/screens/RelaySettings.tsx:
 * shows the current home, verifies a self-hosted (.onion) relay before offering
 * the switch, spells out the consequences, and runs net/relayMigration.
 * Reachable only with the FEDERATION flag on.
 */
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import { useIdentity } from '../store/identity';
import { useLockConfirm } from '../components/LockConfirm';
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

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return String(ts);
  }
}

export function RelaySettingsScreen({ onBack }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);

  // D4: with the app lock on, changing relay needs the PIN first.
  const { confirm: confirmLock, element: lockConfirmElement } = useLockConfirm();
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
    if (!(await confirmLock())) { setMigrate({ kind: 'idle' }); return; }
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
  }, [identity, confirmLock]);

  const errorText = (code: string): string => i18n.t(`relaySettings.errors.${code}`, { defaultValue: i18n.t('relaySettings.errors.unknown') });

  const card: CSSProperties = { backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 14, marginBottom: 18 };
  const sectionLabel: CSSProperties = { fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, letterSpacing: 1.2, marginBottom: 8, display: 'block' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('relaySettings.title')} big left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 32px' }}>
        <span style={sectionLabel}>{i18n.t('relaySettings.currentSection')}</span>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <I.Globe size={20} color={t.accent} />
            <span data-testid="relay-current-label" style={{ fontFamily: t.font, fontSize: 15, color: t.text, fontWeight: 600 }}>
              {home.official ? i18n.t('relaySettings.officialRelay') : i18n.t('relaySettings.ownRelay')}
            </span>
          </div>
          {home.onion && (
            <div data-testid="relay-current-onion" style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, marginTop: 8, wordBreak: 'break-all', userSelect: 'text' }}>{home.onion}</div>
          )}
          {home.since > 0 && (
            <div style={{ fontFamily: t.font, fontSize: 12, color: t.textFaint, marginTop: 6 }}>{i18n.t('relaySettings.since', { date: formatDate(home.since) })}</div>
          )}
          {home.previous && (
            <div data-testid="relay-previous" style={{ fontFamily: t.font, fontSize: 12, color: t.warn, marginTop: 8, lineHeight: '17px' }}>
              {i18n.t('relaySettings.previousUntil', {
                relay: home.previous.onion ? shortOnion(home.previous.onion) : i18n.t('relaySettings.officialRelay'),
                date: formatDate(home.previous.until),
              })}
            </div>
          )}
        </div>

        <span style={sectionLabel}>{i18n.t('relaySettings.ownSection')}</span>
        <p style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px', margin: '0 0 12px' }}>{i18n.t('relaySettings.ownDesc')}</p>
        <input
          value={onionInput}
          onChange={(e) => { setOnionInput(e.target.value.trim().toLowerCase()); if (verify.kind !== 'idle') setVerify({ kind: 'idle' }); }}
          placeholder={i18n.t('relaySettings.onionPlaceholder')}
          aria-label={i18n.t('relaySettings.onionPlaceholder')}
          data-testid="relay-onion-input"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          style={{ width: '100%', boxSizing: 'border-box', fontFamily: t.fontMono, fontSize: 13, color: t.text, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: '13px 14px', outline: 'none' }}
        />
        <div style={{ height: 10 }} />
        <PrimaryButton
          t={t}
          label={verify.kind === 'verifying' ? i18n.t('relaySettings.verifying') : i18n.t('relaySettings.verify')}
          onPress={() => void handleVerify()}
          disabled={!onionInput || verify.kind === 'verifying' || migrate.kind === 'running'}
        />

        {verify.kind === 'error' && (
          <p data-testid="relay-verify-error" style={{ fontFamily: t.font, fontSize: 13, color: t.danger, marginTop: 10, lineHeight: '18px' }}>{errorText(verify.error)}</p>
        )}
        {verify.kind === 'ok' && (
          <div data-testid="relay-verify-ok" style={{ marginTop: 12, padding: 12, backgroundColor: t.surface2, borderRadius: t.radiusS }}>
            <div style={{ fontFamily: t.font, fontSize: 13, color: t.accent, fontWeight: 600 }}>{i18n.t('relaySettings.verifiedTitle')}</div>
            <div style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, marginTop: 6 }}>
              {[verify.info.name, verify.info.version ? `v${verify.info.version}` : null, verify.info.features.join(' · ')].filter(Boolean).join('  ')}
            </div>
            <div style={{ height: 10 }} />
            <PrimaryButton
              t={t}
              label={i18n.t('relaySettings.switchCta', { relay: shortOnion(verify.ref.onion) })}
              onPress={() => setMigrate({ kind: 'confirm', target: verify.ref })}
              disabled={!verifiedRef || migrate.kind === 'running' || !identity}
            />
          </div>
        )}

        {!home.official && (
          <button
            data-testid="relay-back-official"
            onClick={() => setMigrate({ kind: 'confirm', target: null })}
            disabled={migrate.kind === 'running'}
            style={{ display: 'block', width: '100%', marginTop: 22, padding: 12, background: 'none', border: 'none', cursor: 'pointer', fontFamily: t.font, fontSize: 14, color: t.accent }}
          >
            {i18n.t('relaySettings.backToOfficial')}
          </button>
        )}

        {migrate.kind === 'error' && (
          <p data-testid="relay-migrate-error" style={{ fontFamily: t.font, fontSize: 13, color: t.danger, marginTop: 12, lineHeight: '18px' }}>
            {errorText(migrate.error)}{migrate.detail ? ` (${migrate.detail})` : ''}
          </p>
        )}
        {migrate.kind === 'done' && (
          <p data-testid="relay-migrate-done" style={{ fontFamily: t.font, fontSize: 13, color: t.accent, marginTop: 12, lineHeight: '18px' }}>{i18n.t('relaySettings.done')}</p>
        )}
      </div>

      {(migrate.kind === 'confirm' || migrate.kind === 'running') && (
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, border: `1px solid ${t.border}`, maxWidth: 440, width: '100%' }}>
            <div style={{ fontFamily: t.font, fontSize: 17, fontWeight: 700, color: t.text }}>{i18n.t('relaySettings.confirmTitle')}</div>
            <p data-testid="relay-consequences" style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px', marginTop: 10 }}>{i18n.t('relaySettings.consequences')}</p>
            {migrate.kind === 'running' ? (
              <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 18 }}>{i18n.t('relaySettings.migrating')}</div>
            ) : (
              <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                <button data-testid="relay-confirm-cancel" onClick={() => setMigrate({ kind: 'idle' })} style={{ flex: 1, padding: 13, borderRadius: t.radius, border: `1px solid ${t.border}`, background: 'none', cursor: 'pointer', fontFamily: t.font, fontSize: 14, color: t.text }}>
                  {i18n.t('common.cancel')}
                </button>
                <div style={{ flex: 1 }}>
                  <PrimaryButton t={t} label={i18n.t('relaySettings.confirmCta')} onPress={() => { if (migrate.kind === 'confirm') void runMigration(migrate.target); }} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {lockConfirmElement}
    </div>
  );
}
