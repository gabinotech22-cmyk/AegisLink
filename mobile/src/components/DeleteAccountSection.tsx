import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { I } from './icons';
import { Section, Row } from './Section';
import { useIdentity } from '../store/identity';
import { wipeDatabase } from '../db/local';
import { deleteAccountOnRelay } from '../crypto/accountDeletion';

/**
 * "Delete account" settings entry (B-2).
 *
 * Self-contained so mobile↔desktop parity (golden rule #5) is a single drop-in
 * per platform. Flow:
 *   confirm → (DELETE /identity/:id) → on success wipe locally + reset identity
 *   → App.tsx auto-routes to onboarding once identity becomes null.
 *
 * On a non-200/404 relay response we DO NOT wipe — we surface the reason and
 * offer an explicit "wipe locally anyway" escape hatch (the account may still
 * exist on the relay, which the copy makes clear).
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

  /** Wipe local data and reset identity → App navigates to onboarding. */
  const wipeLocal = async () => {
    setStep('deleting');
    try {
      await wipeDatabase();
      await resetIdentity();
      // identity → null unmounts this screen; no need to reset `step`.
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

      <Modal visible={step !== 'idle'} transparent animationType="fade" onRequestClose={closeModal}>
        <View style={styles.modalBg}>
          <View style={[styles.modalContent, { backgroundColor: t.surface, borderColor: t.danger }]}>
            <View style={{ alignItems: 'center', marginBottom: 16 }}>
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: `${t.danger}22`,
                  borderWidth: 1,
                  borderColor: `${t.danger}66`,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 12,
                }}
              >
                <I.Trash size={26} color={t.danger} />
              </View>
              <Text style={[styles.modalTitle, { color: t.danger, fontFamily: t.fontDisplay }]}>
                {step === 'error'
                  ? i18nT('deleteAccount.errorTitle')
                  : step === 'wipeAnyway'
                    ? i18nT('deleteAccount.wipeAnywayTitle')
                    : i18nT('deleteAccount.confirmTitle')}
              </Text>
            </View>

            <Text
              style={{
                color: t.textDim,
                fontFamily: t.font,
                fontSize: 13,
                marginBottom: 20,
                lineHeight: 18,
                textAlign: 'center',
              }}
            >
              {step === 'error'
                ? i18nT('deleteAccount.errorBody', { reason: errorReason })
                : step === 'wipeAnyway'
                  ? i18nT('deleteAccount.wipeAnywayBody')
                  : i18nT('deleteAccount.confirmBody')}
            </Text>

            {/* confirm: Cancel + Delete */}
            {step === 'confirm' && (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <ModalBtn t={t} label={i18nT('common.cancel')} onPress={closeModal} />
                <ModalBtn
                  t={t}
                  danger
                  label={i18nT('deleteAccount.confirmCta')}
                  accessibilityLabel={i18nT('deleteAccount.confirmCta')}
                  onPress={() => void confirmDelete()}
                />
              </View>
            )}

            {/* deleting: spinner-less busy state */}
            {step === 'deleting' && (
              <Text
                style={{
                  color: t.textDim,
                  fontFamily: t.fontMono,
                  fontSize: 13,
                  letterSpacing: 0.6,
                  textAlign: 'center',
                }}
              >
                {i18nT('deleteAccount.deleting')}
              </Text>
            )}

            {/* error: Cancel + Retry + Wipe anyway */}
            {step === 'error' && (
              <View style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <ModalBtn t={t} label={i18nT('common.cancel')} onPress={closeModal} />
                  <ModalBtn
                    t={t}
                    danger
                    label={i18nT('common.retry')}
                    onPress={() => void confirmDelete()}
                  />
                </View>
                <ModalBtn
                  t={t}
                  outlineDanger
                  label={i18nT('deleteAccount.wipeAnyway')}
                  onPress={() => setStep('wipeAnyway')}
                />
              </View>
            )}

            {/* wipeAnyway: Cancel + Wipe */}
            {step === 'wipeAnyway' && (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <ModalBtn t={t} label={i18nT('common.cancel')} onPress={closeModal} />
                <ModalBtn
                  t={t}
                  danger
                  label={i18nT('deleteAccount.wipeAnyway')}
                  onPress={() => void wipeLocal()}
                />
              </View>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

function ModalBtn({
  t,
  label,
  onPress,
  danger,
  outlineDanger,
  accessibilityLabel,
}: {
  t: ReturnType<typeof useTheme>['t'];
  label: string;
  onPress: () => void;
  danger?: boolean;
  outlineDanger?: boolean;
  accessibilityLabel?: string;
}) {
  const bg = danger ? t.danger : 'transparent';
  const borderColor = outlineDanger ? t.danger : t.borderStrong;
  const textColor = danger ? '#fff' : outlineDanger ? t.danger : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={{
        flex: 1,
        backgroundColor: bg,
        borderWidth: danger ? 0 : 1,
        borderColor,
        paddingVertical: 12,
        borderRadius: t.radiusS,
        alignItems: 'center',
      }}
    >
      <Text style={{ color: textColor, fontFamily: t.font, fontWeight: danger ? '600' : '500' }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 24,
  },
  modalContent: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
});
