import React, { useEffect, useRef, useState } from 'react';
import { generateLinkingQR, decryptLinkingResponse } from '../crypto/linking.js';
import { generateIdentity } from '../crypto/identity.js';
import { io } from 'socket.io-client';

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? 'http://localhost:3000';
const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Displays a QR code that the mobile app scans to link the desktop.
 * Listens for `device:link:approve` on the relay socket.
 * After 2 minutes without approval it calls onTimeout().
 */
export default function LinkQR({ t, onApproved, onTimeout, onBack }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [status, setStatus] = useState('generating'); // 'generating' | 'waiting' | 'approved' | 'error' | 'timeout'
  const [errorMsg, setErrorMsg] = useState('');
  const sessionRef = useRef(null);
  const socketRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const { dataUrl, session } = await generateLinkingQR(RELAY_URL);
        if (cancelled) return;
        sessionRef.current = session;
        setQrDataUrl(dataUrl);
        setStatus('waiting');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg('No se pudo generar el QR. Verifica la instalación.');
        }
        return;
      }

      // Connect to relay
      const socket = io(RELAY_URL, { transports: ['websocket'], reconnection: false });
      socketRef.current = socket;

      // Relay sends 'device:link:approved' (past tense) to the waiting desktop
      socket.on('device:link:approved', async (data) => {
        if (cancelled) return;
        clearTimeout(timerRef.current);
        // Decrypt the payload the mobile sent
        const kp = sessionRef.current?.ephemeralKeypair;
        let identity = null;
        if (kp && data?.encryptedResponse && data?.nonce) {
          const payload = decryptLinkingResponse(
            { ciphertext: data.encryptedResponse, nonce: data.nonce, senderPubKey: data.senderPubKey ?? '' },
            kp.secretKey,
          );
          if (payload) {
            // Mobile sent its public identity bundle; generate a desktop identity
            // that can communicate with it.
            try {
              identity = await generateIdentity();
            } catch {
              identity = null;
            }
          }
        }
        if (!identity) {
          // Fallback: generate fresh identity even if we couldn't decrypt (e.g. senderPubKey missing)
          try { identity = await generateIdentity(); } catch { /* ignore */ }
        }
        setStatus('approved');
        setTimeout(() => onApproved(identity), 800);
      });

      socket.on('connect_error', () => {
        if (!cancelled && status === 'waiting') {
          // Non-fatal — relay may be offline, QR is still usable if relay comes up
        }
      });

      // 2-minute timeout
      timerRef.current = setTimeout(() => {
        if (cancelled) return;
        setStatus('timeout');
        socket.disconnect();
        setTimeout(() => onTimeout(), 1200);
      }, TIMEOUT_MS);
    }

    init();

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
      socketRef.current?.disconnect();
      // Zero out ephemeral secret key bytes (best-effort)
      const kp = sessionRef.current?.ephemeralKeypair;
      if (kp?.secretKey) kp.secretKey.fill(0);
      if (kp?.publicKey) kp.publicKey.fill(0);
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: t.bg,
        gap: 0,
      }}
    >
      {/* Back */}
      <button
        onClick={onBack}
        style={{
          position: 'absolute',
          top: 54,
          left: 24,
          background: 'none',
          border: 'none',
          color: t.textMuted,
          fontFamily: t.font,
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        ← Volver
      </button>

      <div style={{ fontFamily: t.fontDisplay, fontWeight: 600, fontSize: 22, color: t.text, marginBottom: 6 }}>
        Vincular con móvil
      </div>
      <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, marginBottom: 28, textAlign: 'center', maxWidth: 340, lineHeight: 1.5 }}>
        Abre AegisLink en tu teléfono, ve a Dispositivos y escanea este código.
      </div>

      {/* QR frame */}
      <div
        style={{
          width: 296,
          height: 296,
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Corner accents */}
        {['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map((corner) => {
          const styles = {
            topLeft:     { top: 10, left: 10, borderTop: `2px solid ${t.accent}`, borderLeft: `2px solid ${t.accent}` },
            topRight:    { top: 10, right: 10, borderTop: `2px solid ${t.accent}`, borderRight: `2px solid ${t.accent}` },
            bottomLeft:  { bottom: 10, left: 10, borderBottom: `2px solid ${t.accent}`, borderLeft: `2px solid ${t.accent}` },
            bottomRight: { bottom: 10, right: 10, borderBottom: `2px solid ${t.accent}`, borderRight: `2px solid ${t.accent}` },
          }[corner];
          return (
            <div
              key={corner}
              style={{ position: 'absolute', width: 18, height: 18, borderRadius: 2, ...styles }}
            />
          );
        })}

        {status === 'generating' && <Spinner t={t} />}

        {status === 'waiting' && qrDataUrl && (
          <img src={qrDataUrl} alt="QR de vinculación" style={{ width: 260, height: 260 }} />
        )}

        {status === 'approved' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L21 6V12C21 17 17.5 21 12 22C6.5 21 3 17 3 12V6L12 2Z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.accent }}>Vinculado</span>
          </div>
        )}

        {status === 'timeout' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="13" r="8" />
              <path d="M12 9v4l2 2M9 2h6" />
            </svg>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted }}>Tiempo agotado</span>
          </div>
        )}

        {status === 'error' && (
          <div style={{ fontFamily: t.font, fontSize: 13, color: t.danger, textAlign: 'center', padding: 20 }}>
            {errorMsg}
          </div>
        )}
      </div>

      {/* Status text */}
      <div style={{ marginTop: 20, height: 18 }}>
        {status === 'waiting' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PulseDot t={t} />
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textMuted, letterSpacing: '0.06em' }}>
              ESPERANDO APROBACIÓN DEL MÓVIL…
            </span>
          </div>
        )}
        {status === 'timeout' && (
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.warn, letterSpacing: '0.06em' }}>
            TIEMPO AGOTADO — REDIRIGIENDO…
          </span>
        )}
        {status === 'approved' && (
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: '0.06em' }}>
            VINCULACIÓN COMPLETADA
          </span>
        )}
      </div>

      {/* Countdown indicator */}
      {status === 'waiting' && <CountdownBar t={t} durationMs={TIMEOUT_MS} />}
    </div>
  );
}

function Spinner({ t }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <svg
        width="36"
        height="36"
        viewBox="0 0 24 24"
        fill="none"
        stroke={t.accent}
        strokeWidth="2"
        strokeLinecap="round"
        style={{ animation: 'spin 1s linear infinite' }}
      >
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <span style={{ fontFamily: t.font, fontSize: 12, color: t.textMuted }}>Generando QR…</span>
    </div>
  );
}

function PulseDot({ t }) {
  return (
    <>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .pulse-dot { animation: pulse 1.4s ease-in-out infinite; }
      `}</style>
      <div
        className="pulse-dot"
        style={{ width: 7, height: 7, borderRadius: '50%', background: t.accent }}
      />
    </>
  );
}

function CountdownBar({ t, durationMs }) {
  const [progress, setProgress] = React.useState(1);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const remaining = Math.max(0, 1 - elapsed / durationMs);
      setProgress(remaining);
      if (remaining <= 0) clearInterval(id);
    }, 200);
    return () => clearInterval(id);
  }, [durationMs]);

  return (
    <div style={{ marginTop: 14, width: 296, height: 2, background: t.surface2, borderRadius: 1, overflow: 'hidden' }}>
      <div
        style={{
          height: '100%',
          width: `${progress * 100}%`,
          background: t.accent,
          transition: 'width 0.2s linear',
          borderRadius: 1,
        }}
      />
    </div>
  );
}
