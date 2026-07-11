import { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { ss } from '../utils/secureStore';
import { useTheme } from '../theme/ThemeContext';
import { useTranslation } from 'react-i18next';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Stat } from '../components/Section';
import { PrimaryButton, GhostButton } from '../components/Button';
import { useIdentity } from '../store/identity';
import { usePreferences } from '../store/preferences';
import { useContacts } from '../store/contacts';
import { useGroups } from '../store/groups';
import { useMessages } from '../store/messages';
import { WORDLIST_256 } from '../crypto/wordlist';
import { identityFromStored } from '../crypto/identity';
import { saveIdentity, saveContact, type StoredContact } from '../db/local';
import { encodeBase64 } from 'tweetnacl-util';
import nacl from 'tweetnacl';
import {
  encryptBackup,
  decryptBackup,
  ratePassphrase,
  isBackupEnvelope,
  BACKUP_FILE_EXTENSION,
  BACKUP_MIN_PASSPHRASE_LEN,
  BACKUP_VERSION,
  type BackupPayload,
  type PassphraseStrength,
} from '../crypto/backup';
import { themedAlert } from '../components/AlertHost';
import { withPickingGuard } from '../utils/pickingGuard';

interface Props {
  onBack: () => void;
  onRestored?: () => void;
}

type PassphraseMode = 'backup' | 'restore';

export function BackupScreen({ onBack, onRestored }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const {
    identity,
    displayName,
    avatarColor,
    avatarImage,
    profileStatus,
    hydrate: hydrateIdentity,
  } = useIdentity();
  const { contacts, hydrate: hydrateContacts } = useContacts();
  const { groups } = useGroups();
  const byChat = useMessages((s) => s.byChat);

  const [revealed, setRevealed] = useState<boolean>(false);
  const [restoring, setRestoring] = useState<boolean>(false);
  const [mnemonicInput, setMnemonicInput] = useState<string>('');

  // Passphrase modal state
  const [passphraseMode, setPassphraseMode] = useState<PassphraseMode | null>(null);
  const [passphrase, setPassphrase] = useState<string>('');
  const [passphraseConfirm, setPassphraseConfirm] = useState<string>('');
  const [pendingEnvelope, setPendingEnvelope] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const totalMessages = Object.values(byChat).reduce((sum, list) => sum + list.length, 0);
  const totalConversations = contacts.length;
  const totalGroups = groups.length;
  const totalMedia = Object.values(byChat).reduce((sum, list) =>
    sum + list.filter(m => m.type === 'image' || m.type === 'audio' || m.type === 'file').length, 0);

  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  useEffect(() => {
    ss.get('aegis.backup.lastAt')
      .then((raw) => raw ? setLastBackupAt(parseInt(raw, 10)) : null)
      .catch(() => {});
  }, []);
  const lastBackupLabel = lastBackupAt
    ? i18nT('backup.activeMinAgo', { count: Math.max(1, Math.floor((Date.now() - lastBackupAt) / 60000)) })
    : i18nT('backup.noBackupYet');

  const secretKey = identity?.secretKey;
  const mnemonic = useMemo<string>(() => {
    if (!secretKey) return '';
    return Array.from(secretKey).map((b) => WORDLIST_256[b]).join(' ');
  }, [secretKey]);

  const strength: PassphraseStrength = ratePassphrase(passphrase);

  function resetPassphrase(): void {
    setPassphrase('');
    setPassphraseConfirm('');
    setPassphraseMode(null);
    setPendingEnvelope(null);
    setBusy(false);
  }

  // ─── Build the in-memory backup payload ────────────────────────────────────
  function buildPayload(): BackupPayload {
    if (!identity) throw new Error('No identity loaded');
    const backupContacts = contacts.map((c) => ({
      aegisId: c.aegisId,
      publicKeyB64: c.publicKeyB64,
      signingPublicKeyB64: c.signingPublicKeyB64,
      name: c.name,
      verified: c.verified,
      addedAt: c.addedAt,
      color: c.color,
      avatarImage: c.avatarImage ?? null,
      status: c.status,
      muted: c.muted,
      mutedUntil: c.mutedUntil ?? null,
      zeroTrust: c.zeroTrust,
      blocked: c.blocked,
      archived: c.archived,
    }));
    return {
      v: BACKUP_VERSION,
      createdAt: Date.now(),
      identity: {
        aegisId: identity.aegisId,
        publicKeyB64: identity.publicKeyB64,
        secretKeyB64: identity.secretKeyB64,
        signingPublicKeyB64: identity.signingPublicKeyB64,
        signingSecretKeyB64: identity.signingSecretKeyB64,
        createdAt: identity.createdAt,
      },
      profile: {
        displayName,
        avatarColor,
        avatarImage,
        profileStatus,
      },
      contacts: backupContacts,
    };
  }

  // ─── Encrypted backup flow ────────────────────────────────────────────────
  function openBackupModal(): void {
    if (!identity) {
      themedAlert(i18nT('backup.noIdentity'), i18nT('backup.generateFirst'));
      return;
    }
    setPassphraseMode('backup');
  }

  async function confirmBackup(): Promise<void> {
    if (passphrase.length < BACKUP_MIN_PASSPHRASE_LEN) {
      themedAlert(i18nT('backup.passphraseTooShort'), i18nT('backup.useAtLeast', { count: BACKUP_MIN_PASSPHRASE_LEN }));
      return;
    }
    if (passphrase !== passphraseConfirm) {
      themedAlert(i18nT('backup.passphraseMismatch'), i18nT('backup.reEnterMismatch'));
      return;
    }
    setBusy(true);
    try {
      const payload = buildPayload();
      const envelope = await encryptBackup(payload, passphrase);
      const filename = `aegislink-backup-${Date.now()}.${BACKUP_FILE_EXTENSION}`;
      const file = new File(Paths.cache, filename);
      file.create({ overwrite: true });
      file.write(JSON.stringify(envelope));
      // Wipe local passphrase memory before opening the share sheet.
      resetPassphrase();
      const now = Date.now();
      await ss.set('aegis.backup.lastAt', String(now));
      setLastBackupAt(now);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/octet-stream',
          dialogTitle: 'Save your encrypted AegisLink backup',
        });
      } else {
        themedAlert(i18nT('backup.backupReady'), i18nT('backup.savedTo', { uri: file.uri }));
      }
    } catch (e) {
      setBusy(false);
      themedAlert(i18nT('backup.error'), (e as Error).message);
    }
  }

  // ─── Encrypted restore flow ───────────────────────────────────────────────
  async function pickBackupFile(): Promise<void> {
    try {
      const result = await withPickingGuard(() =>
        DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: false,
          type: '*/*',
        })
      );
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      const file = new File(asset.uri);
      const raw = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        themedAlert(i18nT('backup.invalidFile'), i18nT('backup.notValidBackup'));
        return;
      }
      if (!isBackupEnvelope(parsed)) {
        themedAlert(i18nT('backup.invalidFile'), i18nT('backup.notValidEnvelope'));
        return;
      }
      setPendingEnvelope(raw);
      setPassphraseMode('restore');
    } catch (e) {
      themedAlert(i18nT('backup.restoreFailed'), (e as Error).message);
    }
  }

  async function confirmRestore(): Promise<void> {
    if (!pendingEnvelope) return;
    if (passphrase.length < BACKUP_MIN_PASSPHRASE_LEN) {
      themedAlert(i18nT('backup.passphraseTooShort'), i18nT('backup.useAtLeast', { count: BACKUP_MIN_PASSPHRASE_LEN }));
      return;
    }
    // Duress containment: restoring writes the payload identity over the REAL
    // SecureStore/SQLite (destroying the real secret keys). Refuse with the
    // same generic error an invalid file shows — reveals nothing to a coercer.
    if (usePreferences.getState().duressActive) {
      themedAlert(i18nT('backup.restoreFailed', 'Restore failed'), i18nT('backup.invalidEnvelope', 'File is not a valid AegisLink backup'));
      return;
    }
    setBusy(true);
    try {
      const envelope = JSON.parse(pendingEnvelope) as unknown;
      if (!isBackupEnvelope(envelope)) throw new Error('Invalid backup envelope');
      const payload = await decryptBackup(envelope, passphrase);
      // Wipe passphrase BEFORE touching storage.
      resetPassphrase();

      // 1) Restore identity (SecureStore + SQLite).
      await saveIdentity({
        aegisId: payload.identity.aegisId,
        publicKeyB64: payload.identity.publicKeyB64,
        secretKeyB64: payload.identity.secretKeyB64,
        signingPublicKeyB64: payload.identity.signingPublicKeyB64,
        signingSecretKeyB64: payload.identity.signingSecretKeyB64,
        createdAt: payload.identity.createdAt,
      });

      // 2) Restore profile preferences.
      const p = payload.profile;
      await ss.set('aegis.displayName', p.displayName);
      await ss.set('aegis.avatarColor', p.avatarColor);
      if (p.avatarImage) await ss.set('aegis.avatarImage', p.avatarImage);
      else await ss.delete('aegis.avatarImage');
      await ss.set('aegis.profileStatus', p.profileStatus);

      // 3) Restore contacts.
      for (const c of payload.contacts) {
        const contact: StoredContact = {
          aegisId: c.aegisId,
          publicKeyB64: c.publicKeyB64,
          signingPublicKeyB64: c.signingPublicKeyB64,
          name: c.name,
          verified: c.verified,
          addedAt: c.addedAt,
          color: c.color,
          avatarImage: c.avatarImage ?? null,
          status: c.status,
          muted: c.muted,
          mutedUntil: c.mutedUntil ?? null,
          zeroTrust: c.zeroTrust,
          blocked: c.blocked,
          archived: c.archived,
        };
        await saveContact(contact);
      }

      await hydrateIdentity();
      await hydrateContacts();

      if (onRestored) {
        themedAlert(
          i18nT('backup.accountRestored'),
          i18nT('backup.recoveredMsg', { aegisId: payload.identity.aegisId, count: payload.contacts.length }),
          [{ text: i18nT('backup.enter'), onPress: onRestored }],
        );
      } else {
        themedAlert(i18nT('backup.restoreComplete'), i18nT('backup.recoveredCompleteMsg', { aegisId: payload.identity.aegisId, count: payload.contacts.length }));
      }
    } catch (e) {
      setBusy(false);
      themedAlert(i18nT('backup.restoreFailed'), (e as Error).message);
    }
  }

  // ─── Mnemonic restore (legacy 32-word) ─────────────────────────────────────
  async function handleMnemonicRestore(): Promise<void> {
    const words = mnemonicInput.trim().toLowerCase().split(/\s+/);
    if (words.length !== 32) {
      themedAlert(i18nT('backup.invalidMnemonic'), i18nT('backup.mnemonicExactly32'));
      return;
    }
    // Duress containment — same reason as confirmRestore: saveIdentity would
    // overwrite the REAL keys. Generic error, indistinguishable from a typo.
    if (usePreferences.getState().duressActive) {
      themedAlert(i18nT('backup.invalidMnemonic'), i18nT('backup.mnemonicExactly32'));
      return;
    }
    try {
      const bytes = words.map((w) => {
        const idx = WORDLIST_256.indexOf(w);
        if (idx === -1) throw new Error(i18nT('backup.wordNotInDict', { word: w }));
        return idx;
      });
      const secretKeyBytes = new Uint8Array(bytes);
      const keypair = nacl.box.keyPair.fromSecretKey(secretKeyBytes);
      const signKeys = nacl.sign.keyPair.fromSeed(secretKeyBytes);

      const restored = identityFromStored({
        publicKeyB64: encodeBase64(keypair.publicKey),
        secretKeyB64: encodeBase64(keypair.secretKey),
        signingPublicKeyB64: encodeBase64(signKeys.publicKey),
        signingSecretKeyB64: encodeBase64(signKeys.secretKey),
        createdAt: Date.now(),
      });

      await saveIdentity({
        aegisId: restored.aegisId,
        publicKeyB64: restored.publicKeyB64,
        secretKeyB64: restored.secretKeyB64,
        signingPublicKeyB64: restored.signingPublicKeyB64,
        signingSecretKeyB64: restored.signingSecretKeyB64,
        createdAt: restored.createdAt,
      });

      await hydrateIdentity();
      setRestoring(false);
      setMnemonicInput('');
      if (onRestored) {
        themedAlert(i18nT('backup.accountRecovered'), i18nT('backup.identityRestoredSuccess', { aegisId: restored.aegisId }), [
          { text: i18nT('backup.enter'), onPress: onRestored },
        ]);
      } else {
        themedAlert(i18nT('backup.successLabel'), i18nT('backup.successfullyRecovered', { aegisId: restored.aegisId }));
      }
    } catch (e) {
      themedAlert(i18nT('backup.restoreFailed'), (e as Error).message);
    }
  }

  const strengthLabel: Record<PassphraseStrength, string> = {
    too_short: i18nT('backup.tooShort', { count: BACKUP_MIN_PASSPHRASE_LEN }),
    weak: i18nT('backup.weak'),
    fair: i18nT('backup.fair'),
    strong: i18nT('backup.strong'),
  };
  const strengthColor: Record<PassphraseStrength, string> = {
    too_short: t.danger,
    weak: t.warn,
    fair: t.accentDeep,
    strong: t.accent,
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('backup.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 32 }}>
        {/* Live Database Stats Card */}
        <View
          style={{
            padding: 16,
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: t.radius,
            backgroundColor: t.surface,
            marginBottom: 16,
          }}
        >
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginBottom: 16 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: lastBackupAt ? t.accent : t.warn, letterSpacing: 1.1 }}>{lastBackupLabel}</Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim }}>{i18nT('backup.realtimeStats')}</Text>
          </View>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 28, fontWeight: '600', letterSpacing: -0.6, color: t.text, flexShrink: 1 }}>
            {totalMessages.toLocaleString()} messages
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, marginTop: 2 }}>
            {i18nT('backup.dbEncrypted')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 18, columnGap: 8, rowGap: 10 }}>
            <View style={{ width: '47%' }}><Stat t={t} label={i18nT('backup.conversations')} val={totalConversations.toString()} /></View>
            <View style={{ width: '47%' }}><Stat t={t} label={i18nT('backup.groups')} val={totalGroups.toString()} /></View>
            <View style={{ width: '47%' }}><Stat t={t} label={i18nT('backup.media')} val={totalMedia.toString()} /></View>
            <View style={{ width: '47%' }}><Stat t={t} label={i18nT('backup.devices')} val="1" /></View>
          </View>
        </View>

        {/* Recovery Phrase Card */}
        <View style={{ padding: 16, backgroundColor: t.surface, borderRadius: t.radius, borderWidth: 1, borderColor: t.border, marginBottom: 16 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
            {i18nT('backup.recoveryPhrase')}
          </Text>
          <View style={{ flexDirection: 'column', gap: 12 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, lineHeight: 20, letterSpacing: 0.2 }}>
              {revealed ? mnemonic : Array.from({ length: 32 }, () => '●●●●').join(' ')}
            </Text>
            <Pressable
              onPress={() => setRevealed(!revealed)}
              style={{ alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.text, letterSpacing: 0.6 }}>
                {revealed ? i18nT('backup.hide') : i18nT('backup.reveal')}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Mnemonic Restore Dialog */}
        {restoring ? (
          <View style={{ padding: 16, backgroundColor: t.surface, borderRadius: t.radius, borderWidth: 1, borderColor: t.border, marginBottom: 16, gap: 12 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>
              {i18nT('backup.pasteRecovery')}
            </Text>
            <TextInput
              placeholder={i18nT('backup.mnemonicPlaceholder')}
              placeholderTextColor={t.textDim}
              value={mnemonicInput}
              onChangeText={setMnemonicInput}
              multiline
              numberOfLines={3}
              style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, backgroundColor: t.bg, borderColor: t.border, borderWidth: 1, borderRadius: t.radiusS, padding: 10, textAlignVertical: 'top' }}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                onPress={() => void handleMnemonicRestore()}
                style={{ flex: 1, backgroundColor: t.accent, paddingVertical: 10, borderRadius: t.radiusS, alignItems: 'center' }}
              >
                <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 13 }}>{i18nT('backup.importPhrase')}</Text>
              </Pressable>
              <Pressable
                onPress={() => setRestoring(false)}
                style={{ flex: 1, borderWidth: 1, borderColor: t.borderStrong, paddingVertical: 10, borderRadius: t.radiusS, alignItems: 'center' }}
              >
                <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500', fontSize: 13 }}>{i18nT('common.cancel')}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <PrimaryButton t={t} label={i18nT('backup.createBtn')} onPress={openBackupModal} />
        <View style={{ height: 10 }} />
        <GhostButton t={t} label={i18nT('backup.restoreFileBtn')} onPress={() => void pickBackupFile()} />
        <View style={{ height: 10 }} />
        {!restoring && (
          <GhostButton t={t} label={i18nT('backup.restorePhraseBtn')} onPress={() => setRestoring(true)} />
        )}
      </ScrollView>

      {/* Passphrase Modal */}
      <Modal
        visible={passphraseMode !== null}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!busy) resetPassphrase(); }}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 22 }}>
          <View style={{ backgroundColor: t.surface, borderRadius: t.radius, borderWidth: 1, borderColor: t.borderStrong, padding: 20, gap: 14 }}>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '600', color: t.text }}>
              {passphraseMode === 'backup' ? i18nT('backup.setPassTitle') : i18nT('backup.enterPassTitle')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
              {passphraseMode === 'backup'
                ? 'This passphrase is the only key to your backup. We cannot recover it — store it somewhere safe.'
                : 'Enter the passphrase you set when you created this backup.'}
            </Text>

            <TextInput
              placeholder={i18nT('backup.passphraseLabel')}
              placeholderTextColor={t.textDim}
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text, backgroundColor: t.bg, borderColor: t.border, borderWidth: 1, borderRadius: t.radiusS, padding: 12 }}
            />

            {passphraseMode === 'backup' && (
              <>
                <TextInput
                  placeholder={i18nT('backup.confirmPass')}
                  placeholderTextColor={t.textDim}
                  value={passphraseConfirm}
                  onChangeText={setPassphraseConfirm}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text, backgroundColor: t.bg, borderColor: t.border, borderWidth: 1, borderRadius: t.radiusS, padding: 12 }}
                />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>
                    {i18nT('backup.strength')}
                  </Text>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: strengthColor[strength] }}>
                    {strengthLabel[strength]}
                  </Text>
                </View>
              </>
            )}

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <Pressable
                disabled={busy}
                onPress={() => { if (!busy) resetPassphrase(); }}
                style={{ flex: 1, borderWidth: 1, borderColor: t.borderStrong, paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center', opacity: busy ? 0.5 : 1 }}
              >
                <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500', fontSize: 13 }}>{i18nT('common.cancel')}</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() => {
                  if (passphraseMode === 'backup') void confirmBackup();
                  else void confirmRestore();
                }}
                style={{ flex: 1, backgroundColor: t.accent, paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center', opacity: busy ? 0.6 : 1 }}
              >
                <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 13 }}>
                  {busy ? 'Working…' : passphraseMode === 'backup' ? 'Encrypt & export' : 'Decrypt & restore'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
