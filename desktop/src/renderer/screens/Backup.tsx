import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Stat } from '../components/Section';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { useGroups } from '../store/groups';
import { useMessages } from '../store/messages';
import {
  encryptBackup,
  decryptBackup,
  ratePassphrase,
  isBackupEnvelope,
  BACKUP_MIN_PASSPHRASE_LEN,
  type PassphraseStrength,
} from '../crypto/backup';
import { WORDLIST_256 } from '../crypto/wordlist';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { identityFromStored } from '../crypto/identity';

interface Props {
  onBack: () => void;
  onRestored?: () => void;
}

type PassphraseMode = 'backup' | 'restore';

export function BackupScreen({ onBack, onRestored }: Props) {
  const { t } = useTheme();
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

  const [revealed, setRevealed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [mnemonicInput, setMnemonicInput] = useState('');
  const [passphraseMode, setPassphraseMode] = useState<PassphraseMode | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [pendingEnvelope, setPendingEnvelope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  const [error, setError] = useState('');

  const totalMessages = Object.values(byChat).reduce((s, l) => s + l.length, 0);
  const totalConversations = contacts.length;
  const totalGroups = groups.length;
  const totalMedia = Object.values(byChat).reduce((s, l) =>
    s + l.filter((m) => m.type === 'image' || m.type === 'audio' || m.type === 'file').length, 0);

  const lastBackupLabel = lastBackupAt
    ? `${Math.max(1, Math.floor((Date.now() - lastBackupAt) / 60000))} min ago`
    : 'No backup yet';

  const mnemonic = useMemo<string>(() => {
    if (!identity?.secretKey) return '';
    return Array.from(identity.secretKey).map((b: number) => WORDLIST_256[b]).join(' ');
  }, [identity?.secretKey]);

  const strength: PassphraseStrength = ratePassphrase(passphrase);

  const strengthColor: Record<PassphraseStrength, string> = {
    too_short: '#ef4444', weak: '#f59e0b', fair: '#eab308', strong: t.accent,
  };
  const strengthLabel: Record<PassphraseStrength, string> = {
    too_short: `Min ${BACKUP_MIN_PASSPHRASE_LEN} chars`,
    weak: 'Weak',
    fair: 'Fair',
    strong: 'Strong',
  };

  function resetPassphrase() {
    setPassphrase('');
    setPassphraseConfirm('');
    setPassphraseMode(null);
    setPendingEnvelope(null);
    setBusy(false);
    setError('');
  }

  function buildPayload() {
    if (!identity) throw new Error('No identity loaded');
    return {
      v: 1 as const,
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
      contacts: contacts.map((c) => ({
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
      })),
    };
  }

  async function confirmBackup() {
    if (passphrase.length < BACKUP_MIN_PASSPHRASE_LEN) {
      setError(`Passphrase must be at least ${BACKUP_MIN_PASSPHRASE_LEN} characters.`);
      return;
    }
    if (passphrase !== passphraseConfirm) {
      setError('Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      const payload = buildPayload();
      const envelope = encryptBackup(payload, passphrase);
      const json = JSON.stringify(envelope, null, 2);
      const blob = new Blob([json], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aegislink-backup-${Date.now()}.aegisbak`;
      a.click();
      URL.revokeObjectURL(url);
      const now = Date.now();
      setLastBackupAt(now);
      resetPassphrase();
      window.alert('Backup exported. Store the file and passphrase somewhere safe — we cannot recover them.');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function handleFileRestore(file: File) {
    try {
      const text = await file.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        window.alert('Invalid file — not valid JSON.');
        return;
      }
      if (!isBackupEnvelope(parsed)) {
        window.alert('Invalid backup envelope.');
        return;
      }
      setPendingEnvelope(text);
      setPassphraseMode('restore');
    } catch (e) {
      window.alert(`Restore failed: ${(e as Error).message}`);
    }
  }

  async function confirmRestore() {
    if (!pendingEnvelope) return;
    if (passphrase.length < BACKUP_MIN_PASSPHRASE_LEN) {
      setError(`Passphrase must be at least ${BACKUP_MIN_PASSPHRASE_LEN} characters.`);
      return;
    }
    setBusy(true);
    try {
      const envelope = JSON.parse(pendingEnvelope) as unknown;
      if (!isBackupEnvelope(envelope)) throw new Error('Invalid backup envelope');
      const payload = decryptBackup(envelope, passphrase);
      resetPassphrase();
      await hydrateIdentity();
      await hydrateContacts();
      const msg = `Account restored. Aegis ID: ${payload.identity.aegisId}, ${payload.contacts.length} contacts recovered.`;
      if (onRestored) {
        window.alert(msg);
        onRestored();
      } else {
        window.alert(msg);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100, padding: '0 22px', boxSizing: 'border-box',
  };

  const modalStyle: CSSProperties = {
    backgroundColor: t.surface, borderRadius: t.radius,
    border: `1px solid ${t.borderStrong}`,
    padding: 20, width: '100%', maxWidth: 420,
    display: 'flex', flexDirection: 'column', gap: 14,
    boxSizing: 'border-box',
  };

  const inputStyle: CSSProperties = {
    width: '100%', padding: 12, fontFamily: t.fontMono, fontSize: 14,
    color: t.text, backgroundColor: t.bg,
    border: `1px solid ${t.border}`, borderRadius: t.radiusS,
    boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Backup & Restore" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 32px', boxSizing: 'border-box' }}>
        {/* Stats card */}
        <div style={{ padding: 22, border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, backgroundColor: t.surface, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: lastBackupAt ? t.accent : t.warn, letterSpacing: 1.1 }}>{lastBackupLabel}</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim }}>REALTIME STATS</span>
          </div>
          <span style={{ fontFamily: t.fontDisplay, fontSize: 32, fontWeight: '600', letterSpacing: -0.6, color: t.text, display: 'block' }}>
            {totalMessages.toLocaleString()} messages
          </span>
          <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, marginTop: 2, display: 'block' }}>
            Database encrypted at rest
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 18, gap: 10 }}>
            <div style={{ width: 'calc(50% - 5px)' }}><Stat t={t} label="CONVERSATIONS" val={String(totalConversations)} /></div>
            <div style={{ width: 'calc(50% - 5px)' }}><Stat t={t} label="GROUPS" val={String(totalGroups)} /></div>
            <div style={{ width: 'calc(50% - 5px)' }}><Stat t={t} label="MEDIA" val={String(totalMedia)} /></div>
            <div style={{ width: 'calc(50% - 5px)' }}><Stat t={t} label="DEVICES" val="1" /></div>
          </div>
        </div>

        {/* Recovery phrase card */}
        <div style={{ padding: 16, backgroundColor: t.surface, borderRadius: t.radius, border: `1px solid ${t.border}`, marginBottom: 16 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>
            RECOVERY PHRASE
          </span>
          <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text, lineHeight: '20px', letterSpacing: 0.2, display: 'block', marginBottom: 10, wordBreak: 'break-all' }}>
            {revealed ? mnemonic : '●●●● '.repeat(16)}
          </span>
          <button
            onClick={() => setRevealed((v) => !v)}
            style={{
              padding: '6px 12px', fontFamily: t.fontMono, fontSize: 10, color: t.text,
              backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`,
              borderRadius: t.radiusS, cursor: 'pointer', letterSpacing: 0.6,
            }}
          >
            {revealed ? 'HIDE' : 'REVEAL'}
          </button>
        </div>

        {/* Mnemonic restore */}
        {restoring && (
          <div style={{ padding: 16, backgroundColor: t.surface, borderRadius: t.radius, border: `1px solid ${t.border}`, marginBottom: 16 }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>
              PASTE RECOVERY PHRASE
            </span>
            <textarea
              value={mnemonicInput}
              onChange={(e) => setMnemonicInput(e.target.value)}
              placeholder="word1 word2 word3…"
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', marginBottom: 12 }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={async () => {
                  const words = mnemonicInput.trim().toLowerCase().split(/\s+/);
                  if (words.length !== 32) {
                    window.alert('Frase de recuperación inválida. Debe contener exactamente 32 palabras.');
                    return;
                  }
                  // Duress containment (parity with mobile Backup.tsx):
                  // linkDevice() writes the supplied identity over the REAL
                  // stored keys — under coercion that is a data-destruction
                  // vector. Refuse with the same generic error a typo shows.
                  {
                    const { usePreferences } = require('../store/preferences') as typeof import('../store/preferences');
                    if (usePreferences.getState().duressActive) {
                      window.alert('Error al recuperar identidad: frase de recuperación inválida.');
                      return;
                    }
                  }
                  let secretKeyBytes: Uint8Array | null = null;
                  let keypair: nacl.BoxKeyPair | null = null;
                  let signKeys: nacl.SignKeyPair | null = null;
                  try {
                    const bytes = words.map((w) => {
                      const idx = WORDLIST_256.indexOf(w);
                      if (idx === -1) throw new Error(`Palabra no encontrada en el diccionario: ${w}`);
                      return idx;
                    });
                    secretKeyBytes = new Uint8Array(bytes);
                    keypair = nacl.box.keyPair.fromSecretKey(secretKeyBytes);
                    signKeys = nacl.sign.keyPair.fromSeed(secretKeyBytes);

                    const restored = identityFromStored({
                      publicKeyB64: encodeBase64(keypair.publicKey),
                      secretKeyB64: encodeBase64(keypair.secretKey),
                      signingPublicKeyB64: encodeBase64(signKeys.publicKey),
                      signingSecretKeyB64: encodeBase64(signKeys.secretKey),
                      createdAt: Date.now(),
                    });

                    await useIdentity.getState().linkDevice(restored);

                    await useIdentity.getState().hydrate();
                    setRestoring(false);
                    setMnemonicInput('');
                    window.alert(`Identidad recuperada exitosamente:\n${restored.aegisId}`);
                    onRestored?.();
                  } catch (e) {
                    window.alert(`Error al recuperar identidad: ${(e as Error).message}`);
                  } finally {
                    secretKeyBytes?.fill(0);
                    keypair?.secretKey.fill(0);
                    signKeys?.secretKey.fill(0);
                  }
                }}
                style={{ flex: 1, padding: '10px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.accentInk, fontSize: 13 }}
              >
                Import phrase
              </button>
              <button
                onClick={() => setRestoring(false)}
                style={{ flex: 1, padding: '10px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '500', color: t.text, fontSize: 13 }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Action buttons */}
        <button
          onClick={() => {
            if (!identity) { window.alert('Generate an identity first.'); return; }
            setPassphraseMode('backup');
          }}
          style={{ width: '100%', padding: '13px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radius, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.accentInk, marginBottom: 10 }}
        >
          Create encrypted backup
        </button>

        <label style={{ display: 'block', marginBottom: 10 }}>
          <span
            style={{ display: 'block', width: '100%', padding: '13px 0', textAlign: 'center', fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.text, backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, cursor: 'pointer', boxSizing: 'border-box' }}
          >
            Restore from file
          </span>
          <input
            type="file"
            accept=".aegisbak"
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.[0]) void handleFileRestore(e.target.files[0]); e.target.value = ''; }}
          />
        </label>

        {!restoring && (
          <button
            onClick={() => setRestoring(true)}
            style={{ width: '100%', padding: '13px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.text }}
          >
            Restore from recovery phrase
          </button>
        )}
      </div>

      {/* Passphrase modal */}
      {passphraseMode !== null && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '600', color: t.text }}>
              {passphraseMode === 'backup' ? 'Set backup passphrase' : 'Enter backup passphrase'}
            </span>
            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '18px' }}>
              {passphraseMode === 'backup'
                ? 'This passphrase is the only key to your backup. We cannot recover it — store it somewhere safe.'
                : 'Enter the passphrase you set when you created this backup.'}
            </span>

            <input
              type="password"
              autoComplete="new-password"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => { setPassphrase(e.target.value); setError(''); }}
              style={inputStyle}
            />

            {passphraseMode === 'backup' && (
              <>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm passphrase"
                  value={passphraseConfirm}
                  onChange={(e) => { setPassphraseConfirm(e.target.value); setError(''); }}
                  style={inputStyle}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>STRENGTH</span>
                  <span style={{ fontFamily: t.fontMono, fontSize: 11, color: strengthColor[strength] }}>
                    {strengthLabel[strength]}
                  </span>
                </div>
              </>
            )}

            {error && (
              <span style={{ fontFamily: t.font, fontSize: 13, color: '#ef4444' }}>{error}</span>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                disabled={busy}
                onClick={() => { if (!busy) resetPassphrase(); }}
                style={{ flex: 1, padding: '12px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: t.font, fontWeight: '500', color: t.text, fontSize: 13, opacity: busy ? 0.5 : 1 }}
              >
                Cancel
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (passphraseMode === 'backup') void confirmBackup();
                  else void confirmRestore();
                }}
                style={{ flex: 1, padding: '12px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: t.font, fontWeight: '600', color: t.accentInk, fontSize: 13, opacity: busy ? 0.6 : 1 }}
              >
                {busy ? 'Working…' : passphraseMode === 'backup' ? 'Encrypt & export' : 'Decrypt & restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
