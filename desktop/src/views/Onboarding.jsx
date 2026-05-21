import React, { useState, useEffect } from 'react';
import { generateIdentity } from '../crypto/identity.js';
import { sha256 } from '@noble/hashes/sha256';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { deriveAegisId } from '../crypto/identity.js';

// ─── Restore from mnemonic ───────────────────────────────────────────────────

async function restoreFromMnemonic(phrase) {
  const phraseBytes = new TextEncoder().encode(phrase.trim());
  const seed = sha256(phraseBytes);
  const { publicKey, secretKey } = nacl.box.keyPair.fromSecretKey(seed);
  const signSeed = sha256(new Uint8Array([...seed, 0x01]));
  const signKeys = nacl.sign.keyPair.fromSeed(signSeed);
  const identity = {
    aegisId: deriveAegisId(publicKey),
    publicKey, secretKey,
    publicKeyB64: encodeBase64(publicKey),
    secretKeyB64: encodeBase64(secretKey),
    signingPublicKey: signKeys.publicKey,
    signingSecretKey: signKeys.secretKey,
    signingPublicKeyB64: encodeBase64(signKeys.publicKey),
    signingSecretKeyB64: encodeBase64(signKeys.secretKey),
    createdAt: Date.now(),
  };
  if (window.secureStore) {
    await window.secureStore.set('aegis.secretKey.b64', identity.secretKeyB64);
    await window.secureStore.set('aegis.signSecretKey.b64', identity.signingSecretKeyB64);
    await window.secureStore.set('aegis.identity.meta.v1', JSON.stringify({
      aegisId: identity.aegisId,
      publicKeyB64: identity.publicKeyB64,
      signingPublicKeyB64: identity.signingPublicKeyB64,
      createdAt: identity.createdAt,
    }));
  }
  return identity;
}

// ─── Fingerprint: split public key into 8 hex chunks ────────────────────────

function fingerprintOf(publicKeyB64) {
  try {
    const bytes = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => hex.slice(i * 4, i * 4 + 4));
  } catch {
    return ['a7f3', '92e1', 'b4c8', '5d0a', '6f12', 'eb73', '8c9d', '1a45'];
  }
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function Onboarding({ t, onLinkMobile, onNewIdentity, onRestore }) {
  // 'start' | 'generating' | 'identity' | 'restore'
  const [step, setStep] = useState('start');
  const [generatedIdentity, setGeneratedIdentity] = useState(null);
  const [mnemonic, setMnemonic] = useState('');
  const [mnemonicError, setMnemonicError] = useState('');
  const [loading, setLoading] = useState(false);

  // When "generate" is clicked: show spinner for ≥2.5 s, then show identity
  async function handleGenerateClick() {
    setStep('generating');
    const [id] = await Promise.all([
      generateIdentity().catch(() => null),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
    if (id) {
      setGeneratedIdentity(id);
      setStep('identity');
    } else {
      setStep('start');
    }
  }

  async function handleRestore() {
    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 12) {
      setMnemonicError('Se requieren exactamente 12 palabras.');
      return;
    }
    setMnemonicError('');
    setLoading(true);
    try {
      const id = await restoreFromMnemonic(mnemonic.trim());
      onRestore(id);
    } catch {
      setMnemonicError('Error al restaurar. Verifica las palabras.');
      setLoading(false);
    }
  }

  // ── Step: generating ──────────────────────────────────────────────────────
  if (step === 'generating') {
    return (
      <FullPage t={t}>
        <style>{`
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        `}</style>
        <KeySpinner t={t} />
        <div style={{
          fontFamily: t.fontDisplay, fontWeight: t.displayWeight,
          fontSize: 24, letterSpacing: '-0.02em', marginTop: 36, color: t.text,
        }}>
          Generando tu par de claves
        </div>
        <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textMuted, marginTop: 10, letterSpacing: '0.06em' }}>
          Curve25519 · 256-bit · en dispositivo
        </div>
        <div style={{ marginTop: 28, width: '100%', maxWidth: 320 }}>
          <ProgressBar t={t} />
        </div>
        <button
          onClick={() => setStep('identity')}
          style={{ marginTop: 32, background: 'transparent', border: 'none', color: t.accent, fontFamily: t.fontMono, fontSize: 11, letterSpacing: '0.1em', cursor: 'pointer' }}
        >
          SALTAR ANIMACIÓN ▸
        </button>
      </FullPage>
    );
  }

  // ── Step: identity revealed ───────────────────────────────────────────────
  if (step === 'identity' && generatedIdentity) {
    const fingerprint = fingerprintOf(generatedIdentity.publicKeyB64);
    return (
      <FullPage t={t} justify="flex-start">
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <div style={{ width: '100%', maxWidth: 440 }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: '0.1em', marginBottom: 14 }}>
            TU IDENTIDAD
          </div>
          <div style={{ fontFamily: t.fontDisplay, fontWeight: t.displayWeight, fontSize: 28, letterSpacing: '-0.02em', marginBottom: 24, color: t.text, lineHeight: 1.15 }}>
            Esta es tuya.<br />Nadie más la tiene.
          </div>

          {/* Identity card */}
          <div style={{
            border: `1px solid ${t.borderStrong ?? t.border}`,
            borderRadius: t.radius,
            padding: 20,
            marginBottom: 16,
            background: t.surface,
          }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 8 }}>
              AEGIS ID
            </div>
            <div style={{ fontFamily: t.fontMono, fontSize: 22, color: t.text, marginBottom: 18, letterSpacing: '0.04em' }}>
              {generatedIdentity.aegisId}
            </div>

            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.1em', marginBottom: 8 }}>
              HUELLA DE CLAVE PÚBLICA
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {fingerprint.map((f) => (
                <div
                  key={f}
                  style={{
                    fontFamily: t.fontMono,
                    fontSize: 12,
                    color: t.text,
                    padding: '6px 4px',
                    background: t.surface2,
                    borderRadius: t.radiusS,
                    textAlign: 'center',
                    letterSpacing: '0.06em',
                  }}
                >
                  {f}
                </div>
              ))}
            </div>
          </div>

          <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, lineHeight: 1.55, marginBottom: 24 }}>
            Anótalo o guárdalo cifrado. Si lo pierdes, nadie — ni nosotros — puede recuperarlo.
          </div>

          <button
            onClick={() => onNewIdentity(generatedIdentity)}
            style={{
              width: '100%',
              padding: '15px 0',
              background: t.accent,
              color: t.accentInk,
              border: 'none',
              borderRadius: t.radius,
              fontFamily: t.font,
              fontWeight: 600,
              fontSize: 15,
              cursor: 'pointer',
              letterSpacing: '-0.01em',
            }}
          >
            Entrar a AegisLink
          </button>
        </div>
      </FullPage>
    );
  }

  // ── Step: restore form ────────────────────────────────────────────────────
  if (step === 'restore') {
    return (
      <FullPage t={t}>
        <div style={{ width: '100%', maxWidth: 400, background: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 28 }}>
          <button
            onClick={() => { setStep('start'); setMnemonicError(''); setMnemonic(''); }}
            style={{ background: 'none', border: 'none', color: t.textMuted, fontFamily: t.font, fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            ← Volver
          </button>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 17, color: t.text, marginBottom: 6 }}>Restaurar identidad</div>
          <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, marginBottom: 18, lineHeight: 1.5 }}>
            Introduce las 12 palabras de recuperación en el orden correcto.
          </div>
          <textarea
            value={mnemonic}
            onChange={(e) => setMnemonic(e.target.value)}
            placeholder="palabra1 palabra2 … palabra12"
            rows={4}
            style={{
              width: '100%', background: t.surface2,
              border: `1px solid ${mnemonicError ? t.danger : t.border}`,
              borderRadius: t.radiusS, color: t.text,
              fontFamily: t.fontMono, fontSize: 13, padding: '10px 12px',
              resize: 'none', outline: 'none', lineHeight: 1.6, boxSizing: 'border-box',
            }}
          />
          {mnemonicError && (
            <div style={{ fontFamily: t.font, fontSize: 12, color: t.danger, marginTop: 6 }}>{mnemonicError}</div>
          )}
          <button
            onClick={loading ? undefined : handleRestore}
            style={{
              marginTop: 14, width: '100%', padding: '11px 0',
              background: t.accent, border: 'none', borderRadius: t.radiusS,
              color: t.accentInk, fontFamily: t.font, fontWeight: 600, fontSize: 13,
              cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Restaurando…' : 'Restaurar'}
          </button>
        </div>
      </FullPage>
    );
  }

  // ── Step: start (default) ─────────────────────────────────────────────────
  return (
    <FullPage t={t}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      {/* Logo */}
      <div style={{ marginBottom: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L21 6V12C21 17 17.5 21 12 22C6.5 21 3 17 3 12V6L12 2Z"
            stroke={t.accent} strokeWidth="1.8" strokeLinejoin="round" fill="none" />
          <path d="M9 12l2 2 4-4" stroke={t.accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: t.fontDisplay, fontWeight: t.displayWeight, fontSize: 32, letterSpacing: '-0.02em', color: t.text }}>
            AegisLink
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.12em', marginTop: 4 }}>
            SECURE · ANONYMOUS · ON-DEVICE
          </div>
        </div>
      </div>

      {/* Card */}
      <div style={{ width: 400, background: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 28 }}>
        <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 17, color: t.text, marginBottom: 6 }}>Comenzar</div>
        <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, marginBottom: 22, lineHeight: 1.5 }}>
          Sin email. Sin teléfono. Sin nombre real.
        </div>

        <ActionButton t={t} primary
          label="Vincular con móvil"
          description="Escanea el QR desde tu app AegisLink"
          onClick={onLinkMobile}
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 14h3v3h-3zM21 14v3M14 21h7M17 17v4" />
          </svg>}
        />
        <div style={{ marginTop: 10 }} />
        <ActionButton t={t}
          label="Restaurar identidad"
          description="Introduce tus 12 palabras de recuperación"
          onClick={() => setStep('restore')}
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
          </svg>}
        />
        <div style={{ marginTop: 10 }} />
        <ActionButton t={t}
          label="Nueva identidad"
          description="Genera claves nuevas en este dispositivo"
          onClick={handleGenerateClick}
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>}
        />
      </div>

      <div style={{ marginTop: 24, fontFamily: t.fontMono, fontSize: 10, color: t.textMuted, letterSpacing: '0.06em' }}>
        ZERO METADATA · E2EE · OPEN SOURCE
      </div>
    </FullPage>
  );
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

function FullPage({ t, children, justify = 'center' }) {
  return (
    <div style={{
      flex: 1, height: '100%', background: t.bg,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: justify,
      padding: justify === 'flex-start' ? '48px 24px 32px' : '0 24px',
      gap: 0, overflowY: 'auto',
    }}>
      {children}
    </div>
  );
}

// ─── KeySpinner — matches screens.jsx exactly ─────────────────────────────────

function KeySpinner({ t }) {
  return (
    <div style={{
      width: 96, height: 96, borderRadius: '50%',
      border: `2px solid ${t.surface2 ?? '#1a2422'}`,
      borderTopColor: t.accent,
      animation: 'spin 1.4s linear infinite',
      position: 'relative',
    }}>
      <div style={{
        position: 'absolute', inset: 18, borderRadius: '50%',
        background: t.surface, display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: t.accent,
      }}>
        <KeyIcon />
      </div>
    </div>
  );
}

function ProgressBar({ t }) {
  return (
    <div style={{ height: 3, background: t.surface2 ?? '#1a2422', borderRadius: 99, overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: '62%', background: t.accent,
        borderRadius: 99, animation: 'pulse 2s ease-in-out infinite',
      }} />
    </div>
  );
}

// ─── Reusable action button ───────────────────────────────────────────────────

function ActionButton({ t, label, description, primary, disabled, onClick, icon }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px',
        background: primary
          ? hovered ? t.accentDim : t.accent
          : hovered ? t.surface2 : 'transparent',
        border: primary ? 'none' : `1px solid ${hovered ? t.borderStrong : t.border}`,
        borderRadius: t.radiusS, cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left', transition: 'background 0.14s, border-color 0.14s',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ color: primary ? t.accentInk : t.accent, flexShrink: 0 }}>{icon}</span>
      <div>
        <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 13, color: primary ? t.accentInk : t.text }}>
          {label}
        </div>
        <div style={{ fontFamily: t.font, fontSize: 11, color: primary ? t.accentInk : t.textMuted, marginTop: 2, opacity: primary ? 0.8 : 1 }}>
          {description}
        </div>
      </div>
    </button>
  );
}

function KeyIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="14" r="4" />
      <path d="M11 13l9-9M17 7l3 3M14 10l3 3" />
    </svg>
  );
}
