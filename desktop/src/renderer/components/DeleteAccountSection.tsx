import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from './icons';
import { Section, Row } from './Section';
import { useIdentity } from '../store/identity';
import { wipeDatabase } from '../db/local';
import { deleteAccountOnRelay } from '../crypto/accountDeletion';

/**
 * "Delete account" settings entry (B-2) — desktop twin of
 * mobile/src/components/DeleteAccountSection.tsx (golden rule #5).
 *
 * Flow: confirm → DELETE /identity/:id → on success wipeDatabase()
 * (window.aegis.db.wipeDatabase + secureStorage wipe) + identity reset →
 * App.tsx auto-routes to onboarding once identity becomes null.
 *
 * On a non-200/404 relay response we DO NOT wipe — we surface the reason and
 * offer an explicit "wipe locally anyway" escape hatch.
 */
type Step = 'idle' | 'confirm' | 'deleting' | 'error' | 'wipeAnyway';

export function DeleteAccountSection() {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const identity = useIdentity((s) => s.identity);
  const resetIdentity = useIdentity((s) => s.reset);

  const [step, setStep] = useState<Step>('idle');
  const [errorReason, setErrorReason] = useState('');

  const closeModal = () => setStep('idle');

  const wipeLocal = async () => {
    setStep('deleting');
    try {
      await wipeDatabase();
      await resetIdentity();
      // identity → null: App.tsx routes back to Entry/onboarding.
    } catch {
      setErrorReason(i18nT('common.error'));
      setStep('error');
    }
  };

  const confirmDelete = async () => {
    if (!identity) return;
    setStep('deleting');
    const result = await deleteAccountOnRelay(identity);
    if (result.ok) {
      await wipeLocal();
      return;
    }
    setErrorReason(result.error ?? `HTTP ${result.status ?? '?'}`);
    setStep('error');
  };

  const title =
    step === 'error'
      ? i18nT('deleteAccount.errorTitle')
      : step === 'wipeAnyway'
        ? i18nT('deleteAccount.wipeAnywayTitle')
        : i18nT('deleteAccount.confirmTitle');

  const body =
    step === 'error'
      ? i18nT('deleteAccount.errorBody', { reason: errorReason })
      : step === 'wipeAnyway'
        ? i18nT('deleteAccount.wipeAnywayBody')
        : i18nT('deleteAccount.confirmBody');

  return (
    <>
      <Section t={t} label={i18nT('privacy.deleteAccount')}>
        <Row
          t={t}
          icon={<I.Trash size={20} color={t.danger} />}
          label={i18nT('privacy.deleteAccount')}
          sub={i18nT('privacy.deleteAccountSub')}
          danger
          onPress={() => setStep('confirm')}
          noBorder
        />
      </Section>

      {step !== 'idle' && (
        <div style={overlayStyle} role="dialog" aria-modal="true">
          <div style={{ ...modalStyle, backgroundColor: t.surface, borderColor: t.danger }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 16 }}>
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: `${t.danger}22`,
                  border: `1px solid ${t.danger}66`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 12,
                }}
              >
                <I.Trash size={26} color={t.danger} />
              </div>
              <span style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: 700, color: t.danger, textAlign: 'center' }}>
                {title}
              </span>
            </div>

            <p style={{ color: t.textDim, fontFamily: t.font, fontSize: 13, margin: '0 0 20px', lineHeight: 1.4, textAlign: 'center' }}>
              {body}
            </p>

            {step === 'confirm' && (
              <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
                <ModalBtn t={t} label={i18nT('common.cancel')} onClick={closeModal} />
                <ModalBtn t={t} danger label={i18nT('deleteAccount.confirmCta')} onClick={() => void confirmDelete()} />
              </div>
            )}

            {step === 'deleting' && (
              <span style={{ color: t.textDim, fontFamily: t.fontMono, fontSize: 13, letterSpacing: 0.6, textAlign: 'center', display: 'block' }}>
                {i18nT('deleteAccount.deleting')}
              </span>
            )}

            {step === 'error' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
                  <ModalBtn t={t} label={i18nT('common.cancel')} onClick={closeModal} />
                  <ModalBtn t={t} danger label={i18nT('common.retry')} onClick={() => void confirmDelete()} />
                </div>
                <ModalBtn t={t} outlineDanger label={i18nT('deleteAccount.wipeAnyway')} onClick={() => setStep('wipeAnyway')} />
              </div>
            )}

            {step === 'wipeAnyway' && (
              <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
                <ModalBtn t={t} label={i18nT('common.cancel')} onClick={closeModal} />
                <ModalBtn t={t} danger label={i18nT('deleteAccount.wipeAnyway')} onClick={() => void wipeLocal()} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ModalBtn({
  t,
  label,
  onClick,
  danger,
  outlineDanger,
}: {
  t: Theme;
  label: string;
  onClick: () => void;
  danger?: boolean;
  outlineDanger?: boolean;
}) {
  const style: CSSProperties = {
    flex: 1,
    backgroundColor: danger ? t.danger : 'transparent',
    border: danger ? 'none' : `1px solid ${outlineDanger ? t.danger : t.borderStrong}`,
    color: danger ? '#fff' : outlineDanger ? t.danger : t.text,
    fontFamily: t.font,
    fontWeight: danger ? 600 : 500,
    fontSize: 14,
    paddingTop: 12,
    paddingBottom: 12,
    borderRadius: t.radiusS,
    cursor: 'pointer',
  };
  return (
    <button type="button" aria-label={label} onClick={onClick} style={style}>
      {label}
    </button>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  zIndex: 1000,
};

const modalStyle: CSSProperties = {
  border: '1px solid',
  borderRadius: 16,
  padding: 20,
  width: '100%',
  maxWidth: 380,
  boxSizing: 'border-box',
};
