/**
 * PassphraseModal — reusable passphrase entry/confirmation modal.
 *
 * mode='create'  → shows two inputs (passphrase + confirm) + strength indicator.
 * mode='enter'   → shows one input for decryption.
 *
 * The passphrase is passed back via onConfirm and NEVER stored internally
 * beyond the duration of the modal being open.
 */

import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { ratePassphrase, BACKUP_MIN_PASSPHRASE_LEN, type PassphraseStrength } from '../crypto/backup';

export interface PassphraseModalProps {
  visible: boolean;
  mode: 'create' | 'enter';
  busy?: boolean;
  onConfirm: (passphrase: string) => void;
  onCancel: () => void;
}

const STRENGTH_LABEL: Record<PassphraseStrength, string> = {
  too_short: `Min. ${BACKUP_MIN_PASSPHRASE_LEN} chars`,
  weak: 'Weak',
  fair: 'Fair',
  strong: 'Strong',
};

export function PassphraseModal({
  visible,
  mode,
  busy = false,
  onConfirm,
  onCancel,
}: PassphraseModalProps) {
  const { t } = useTheme();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');

  const strength = ratePassphrase(passphrase);

  const strengthColor: Record<PassphraseStrength, string> = {
    too_short: '#ef4444',
    weak: '#f59e0b',
    fair: '#eab308',
    strong: t.accent,
  };

  function reset() {
    setPassphrase('');
    setConfirm('');
  }

  function handleCancel() {
    reset();
    onCancel();
  }

  function handleConfirm() {
    if (busy) return;
    if (passphrase.length < BACKUP_MIN_PASSPHRASE_LEN) return;
    if (mode === 'create' && passphrase !== confirm) return;
    const captured = passphrase;
    reset();
    onConfirm(captured);
  }

  const confirmDisabled =
    busy ||
    passphrase.length < BACKUP_MIN_PASSPHRASE_LEN ||
    (mode === 'create' && passphrase !== confirm);

  const confirmLabel =
    busy
      ? 'Working…'
      : mode === 'create'
      ? 'Encrypt & export'
      : 'Decrypt & restore';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => { if (!busy) handleCancel(); }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.65)',
            justifyContent: 'center',
            paddingHorizontal: 22,
          }}
        >
          <View
            style={{
              backgroundColor: t.surface,
              borderRadius: t.radius,
              borderWidth: 1,
              borderColor: t.borderStrong,
              padding: 20,
              gap: 14,
            }}
          >
            {/* Title */}
            <Text
              style={{
                fontFamily: t.fontDisplay,
                fontSize: 18,
                fontWeight: '600',
                color: t.text,
              }}
            >
              {mode === 'create' ? 'Set backup passphrase' : 'Enter backup passphrase'}
            </Text>

            {/* Hint */}
            <Text
              style={{
                fontFamily: t.font,
                fontSize: 12,
                color: t.textDim,
                lineHeight: 18,
              }}
            >
              {mode === 'create'
                ? 'Tu passphrase NO se puede recuperar. Anótala en papel antes de continuar.'
                : 'Enter the passphrase you set when you created this backup.'}
            </Text>

            {/* Primary input */}
            <TextInput
              accessibilityLabel="Backup passphrase"
              placeholder="Passphrase"
              placeholderTextColor={t.textDim}
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              style={{
                fontFamily: t.fontMono,
                fontSize: 14,
                color: t.text,
                backgroundColor: t.bg,
                borderColor: t.border,
                borderWidth: 1,
                borderRadius: t.radiusS,
                padding: 12,
              }}
            />

            {/* Confirm input + strength — create mode only */}
            {mode === 'create' && (
              <>
                <TextInput
                  accessibilityLabel="Confirm backup passphrase"
                  placeholder="Confirm passphrase"
                  placeholderTextColor={t.textDim}
                  value={confirm}
                  onChangeText={setConfirm}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  style={{
                    fontFamily: t.fontMono,
                    fontSize: 14,
                    color: t.text,
                    backgroundColor: t.bg,
                    borderColor: t.border,
                    borderWidth: 1,
                    borderRadius: t.radiusS,
                    padding: 12,
                  }}
                />

                {/* Strength bar */}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 10,
                      color: t.textDim,
                      letterSpacing: 1.1,
                    }}
                  >
                    STRENGTH
                  </Text>
                  <Text
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 11,
                      color: strengthColor[strength],
                    }}
                  >
                    {STRENGTH_LABEL[strength].toUpperCase()}
                  </Text>
                </View>

                {/* Mismatch warning */}
                {confirm.length > 0 && passphrase !== confirm && (
                  <Text
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 10,
                      color: '#ef4444',
                      letterSpacing: 0.4,
                    }}
                  >
                    Passphrases do not match
                  </Text>
                )}
              </>
            )}

            {/* Buttons */}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <Pressable
                accessibilityLabel="Cancel"
                disabled={busy}
                onPress={handleCancel}
                style={{
                  flex: 1,
                  borderWidth: 1,
                  borderColor: t.borderStrong,
                  paddingVertical: 12,
                  borderRadius: t.radiusS,
                  alignItems: 'center',
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <Text
                  style={{
                    color: t.text,
                    fontFamily: t.font,
                    fontWeight: '500',
                    fontSize: 13,
                  }}
                >
                  Cancel
                </Text>
              </Pressable>

              <Pressable
                accessibilityLabel={confirmLabel}
                disabled={confirmDisabled}
                onPress={handleConfirm}
                style={{
                  flex: 1,
                  backgroundColor: t.accent,
                  paddingVertical: 12,
                  borderRadius: t.radiusS,
                  alignItems: 'center',
                  opacity: confirmDisabled ? 0.5 : 1,
                }}
              >
                {busy ? (
                  <ActivityIndicator color={t.accentInk} size="small" />
                ) : (
                  <Text
                    style={{
                      color: t.accentInk,
                      fontFamily: t.font,
                      fontWeight: '600',
                      fontSize: 13,
                    }}
                  >
                    {confirmLabel}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
