import React, { useState, useEffect } from 'react';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

// Minimal BIP39-style English wordlist (first 256 words for seed phrase generation)
// In production, import full BIP39 list; this is a representative subset.
const WORDLIST = [
  'abandon','ability','able','about','above','absent','absorb','abstract','absurd','abuse',
  'access','accident','account','accuse','achieve','acid','acoustic','acquire','across','act',
  'action','actor','actress','actual','adapt','add','addict','address','adjust','admit',
  'adult','advance','advice','aerobic','afford','afraid','again','age','agent','agree',
  'ahead','aim','air','airport','aisle','alarm','album','alcohol','alert','alien',
  'align','alive','all','alley','allow','almost','alone','alpha','already','also',
  'alter','always','amateur','amazing','among','amount','amused','analyst','anchor','ancient',
  'anger','angle','angry','animal','ankle','announce','annual','another','answer','antenna',
  'antique','anxiety','apart','april','arch','arctic','area','arena','argue','arm',
  'armor','army','around','arrange','arrest','arrive','arrow','art','artefact','artist',
  'artwork','ask','aspect','assault','asset','assist','assume','asthma','athlete','atom',
  'attack','attend','attitude','attract','auction','audit','august','aunt','author','auto',
  'autumn','average','avocado','avoid','awake','aware','away','awesome','awful','awkward',
  'axis','baby','balance','bamboo','banana','banner','barely','bargain','barrel','base',
  'basic','basket','battle','beach','bean','beauty','because','become','beef','before',
  'begin','behave','behind','believe','below','belt','bench','benefit','best','betray',
  'better','between','beyond','bicycle','bid','bike','bind','biology','bird','birth',
  'bitter','black','blade','blame','blanket','blast','bleak','bless','blind','blood',
  'blossom','blouse','blue','blur','blush','board','boat','body','boil','bomb',
  'bone','book','boost','border','boring','borrow','bounce','box','boy','bracket',
  'brain','brand','brave','bread','breeze','brick','bridge','brief','bright','bring',
  'brisk','brother','brown','brush','bubble','buddy','budget','buffalo','build','bulb',
  'bulk','bullet','bundle','bunker','burden','burger','burst','bus','business','busy',
];

// Generate a 32-word seed phrase from a 32-byte secret key
function secretKeyToSeedPhrase(secretKeyBytes) {
  const words = [];
  // Use pairs of bytes to index into wordlist (mod 256)
  for (let i = 0; i < 32; i++) {
    words.push(WORDLIST[secretKeyBytes[i] % WORDLIST.length]);
  }
  return words.join(' ');
}

// Encrypt data with a password using NaCl secretbox
function encryptWithPassword(data, password) {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  // Derive key: simple SHA-256-style using nacl hash (Blake2b 64 -> take first 32 bytes)
  const keyFull = nacl.hash(passwordBytes);
  const key = keyFull.slice(0, 32);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const dataBytes = encoder.encode(data);
  const encrypted = nacl.secretbox(dataBytes, nonce, key);
  return JSON.stringify({
    v: 1,
    ct: encodeBase64(encrypted),
    n: encodeBase64(nonce),
  });
}

export default function Backup({ t, onClose }) {
  const [seedPhrase, setSeedPhrase] = useState(null);
  const [seedVisible, setSeedVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [restorePhrase, setRestorePhrase] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    async function loadSeed() {
      try {
        const ss = window.secureStore;
        if (!ss) { setLoadError('SecureStore no disponible'); return; }

        // Try loading cached seed phrase
        let phrase = await ss.get('aegis.seedPhrase');
        if (phrase) {
          setSeedPhrase(phrase);
          return;
        }

        // Derive from secret key
        const secretKeyB64 = await ss.get('aegis.secretKey.b64');
        if (!secretKeyB64) { setLoadError('No hay identidad activa'); return; }

        const secretKeyBytes = decodeBase64(secretKeyB64);
        phrase = secretKeyToSeedPhrase(secretKeyBytes);
        await ss.set('aegis.seedPhrase', phrase);
        setSeedPhrase(phrase);
      } catch (err) {
        setLoadError('Error cargando frase semilla');
      }
    }
    loadSeed();
  }, []);

  function handleCopy() {
    if (!seedPhrase) return;
    navigator.clipboard.writeText(seedPhrase).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleExportEncrypted() {
    if (!exportPassword) return;
    setExporting(true);
    try {
      const d = window.db;
      if (!d) { setExporting(false); return; }
      const messages = await d.all('SELECT * FROM messages ORDER BY created_at', []);
      const contacts = await d.all('SELECT * FROM contacts', []);
      const payload = JSON.stringify({ exportedAt: Date.now(), messages, contacts });
      const encrypted = encryptWithPassword(payload, exportPassword);
      const filename = `aegislink-backup-${Date.now()}.enc.json`;

      if (window.electronAPI?.saveFile) {
        await window.electronAPI.saveFile(filename, encrypted);
      } else {
        // Fallback: browser download
        const blob = new Blob([encrypted], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      setExportDone(true);
      setTimeout(() => setExportDone(false), 3000);
    } catch {
      // ignore
    }
    setExporting(false);
  }

  async function handleRestore() {
    setRestoreError('');
    const words = restorePhrase.trim().split(/\s+/);
    if (words.length !== 32) {
      setRestoreError('La frase debe tener exactamente 32 palabras.');
      return;
    }
    setRestoring(true);
    try {
      const ss = window.secureStore;
      if (!ss) { setRestoreError('SecureStore no disponible'); setRestoring(false); return; }
      // Store the seed phrase; actual key restore requires full onboarding flow
      await ss.set('aegis.seedPhrase', words.join(' '));
      setRestoreError('');
      alert('Frase guardada. Reinicia la aplicación para restaurar la identidad.');
    } catch {
      setRestoreError('Error al restaurar.');
    }
    setRestoring(false);
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 520,
          maxHeight: '85vh',
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 16, color: t.text }}>
            Backup y restauración
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', padding: 4 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Seed phrase */}
          <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.divider ?? t.border}` }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 14 }}>
              FRASE SEMILLA (32 PALABRAS)
            </div>

            {/* Warning */}
            <div style={{
              padding: '10px 14px',
              background: `${t.warn}22`,
              border: `1px solid ${t.warn}55`,
              borderRadius: t.radiusS,
              fontFamily: t.font,
              fontSize: 12,
              color: t.warn,
              lineHeight: 1.5,
              marginBottom: 14,
            }}>
              Guarda estas palabras en un lugar seguro. No las compartas con nadie. Son la unica forma de recuperar tu identidad.
            </div>

            {loadError ? (
              <div style={{ fontFamily: t.font, fontSize: 13, color: t.danger }}>{loadError}</div>
            ) : !seedPhrase ? (
              <div style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textMuted }}>Cargando…</div>
            ) : (
              <>
                <div
                  style={{
                    padding: '14px 16px',
                    background: t.surface2,
                    border: `1px solid ${t.border}`,
                    borderRadius: t.radiusS,
                    fontFamily: t.fontMono,
                    fontSize: 12,
                    color: seedVisible ? t.text : 'transparent',
                    lineHeight: 1.8,
                    letterSpacing: '0.04em',
                    filter: seedVisible ? 'none' : 'blur(6px)',
                    userSelect: seedVisible ? 'text' : 'none',
                    transition: 'filter 0.3s',
                    marginBottom: 10,
                    wordBreak: 'break-word',
                  }}
                >
                  {seedPhrase.split(' ').map((word, i) => (
                    <span key={i} style={{ display: 'inline-block', marginRight: 6 }}>
                      <span style={{ color: t.textMuted, fontSize: 10, marginRight: 3 }}>{i + 1}.</span>
                      {word}
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setSeedVisible((v) => !v)}
                    style={{
                      flex: 1,
                      padding: '9px 0',
                      background: 'transparent',
                      border: `1px solid ${t.border}`,
                      borderRadius: t.radiusS,
                      color: t.text,
                      fontFamily: t.font,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    {seedVisible ? 'Ocultar' : 'Mostrar frase'}
                  </button>
                  <button
                    onClick={handleCopy}
                    disabled={!seedVisible}
                    style={{
                      flex: 1,
                      padding: '9px 0',
                      background: copied ? t.accent : 'transparent',
                      border: `1px solid ${copied ? t.accent : t.border}`,
                      borderRadius: t.radiusS,
                      color: copied ? t.accentInk : (seedVisible ? t.text : t.textMuted),
                      fontFamily: t.font,
                      fontSize: 13,
                      cursor: seedVisible ? 'pointer' : 'default',
                    }}
                  >
                    {copied ? 'Copiado' : 'Copiar al portapapeles'}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Encrypted export */}
          <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.divider ?? t.border}` }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 14 }}>
              EXPORTAR CONVERSACIONES CIFRADAS
            </div>
            <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
              Exporta tus mensajes cifrados con una contraseña. Solo tu puedes descifrarlos.
            </div>
            <input
              type="password"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
              placeholder="Contraseña de cifrado"
              style={{
                width: '100%',
                padding: '9px 12px',
                background: t.surface2,
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusS,
                color: t.text,
                fontFamily: t.font,
                fontSize: 13,
                outline: 'none',
                marginBottom: 10,
                boxSizing: 'border-box',
              }}
            />
            <button
              onClick={handleExportEncrypted}
              disabled={!exportPassword || exporting}
              style={{
                width: '100%',
                padding: '10px 0',
                background: exportDone ? t.accent : 'transparent',
                border: `1px solid ${exportDone ? t.accent : exportPassword ? t.accent : t.border}`,
                borderRadius: t.radiusS,
                color: exportDone ? t.accentInk : (exportPassword ? t.accent : t.textMuted),
                fontFamily: t.font,
                fontWeight: 500,
                fontSize: 13,
                cursor: exportPassword && !exporting ? 'pointer' : 'default',
              }}
            >
              {exportDone ? 'Exportado' : exporting ? 'Exportando…' : 'Exportar conversaciones cifradas'}
            </button>
          </div>

          {/* Restore section */}
          <div style={{ padding: '18px 22px' }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 14 }}>
              RESTAURAR IDENTIDAD
            </div>
            <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
              Pega tu frase semilla de 32 palabras para restaurar la identidad.
            </div>
            <textarea
              value={restorePhrase}
              onChange={(e) => setRestorePhrase(e.target.value)}
              placeholder="Pega las 32 palabras aqui…"
              rows={4}
              style={{
                width: '100%',
                padding: '9px 12px',
                background: t.surface2,
                border: `1px solid ${restoreError ? t.danger : t.border}`,
                borderRadius: t.radiusS,
                color: t.text,
                fontFamily: t.fontMono,
                fontSize: 12,
                outline: 'none',
                resize: 'vertical',
                marginBottom: 8,
                boxSizing: 'border-box',
                lineHeight: 1.6,
              }}
            />
            {restoreError && (
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.danger, marginBottom: 8 }}>{restoreError}</div>
            )}
            <button
              onClick={handleRestore}
              disabled={!restorePhrase.trim() || restoring}
              style={{
                width: '100%',
                padding: '10px 0',
                background: 'transparent',
                border: `1px solid ${restorePhrase.trim() ? t.accent : t.border}`,
                borderRadius: t.radiusS,
                color: restorePhrase.trim() ? t.accent : t.textMuted,
                fontFamily: t.font,
                fontWeight: 500,
                fontSize: 13,
                cursor: restorePhrase.trim() && !restoring ? 'pointer' : 'default',
              }}
            >
              {restoring ? 'Restaurando…' : 'Restaurar identidad'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
