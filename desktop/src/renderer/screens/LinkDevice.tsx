import { useState, useEffect, useRef } from 'react';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8 } from 'tweetnacl-util';
import QRCode from 'qrcode';
import { io, Socket } from 'socket.io-client';
import { SERVER_URL } from '../config';
import { identityFromStored } from '../crypto/identity';
import { saveSpkSecret } from '../socket/client';
import { useIdentity } from '../store/identity';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import { I } from '../components/icons';

interface Props {
  onBack: () => void;
  onLinked: () => void;
}

function QRCanvas({ payload, t }: { payload: string; t: { radius: number; borderStrong: string } }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !payload) return;
    void QRCode.toCanvas(canvasRef.current, payload, {
      width: 220,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
  }, [payload]);

  return (
    <div style={{ width: 220, height: 220, borderRadius: t.radius, overflow: 'hidden', flexShrink: 0, border: `2px solid ${t.borderStrong}` }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}

export function LinkDeviceScreen({ onBack, onLinked }: Props) {
  const { t } = useTheme();
  const [aegisId, setAegisId] = useState('');
  const [step, setStep] = useState<'input' | 'qr'>('input');
  const [qrPayload, setQrPayload] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  const ephemeralKeyRef = useRef<{ publicKey: Uint8Array, secretKey: Uint8Array } | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Zeroize the ephemeral secret in EVERY terminal path (connect error, server
  // error, decrypt failure, success, unmount) — not only on success. Idempotent.
  function wipeEphemeralKey() {
    if (ephemeralKeyRef.current) {
      ephemeralKeyRef.current.secretKey.fill(0);
      ephemeralKeyRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      wipeEphemeralKey();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleNext() {
    const trimmed = aegisId.trim();
    if (!trimmed) {
      setError('Please enter a valid Aegis ID.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      // 1. Generate ephemeral keypair
      const keypair = nacl.box.keyPair();
      ephemeralKeyRef.current = keypair;
      const ephemeralPubKeyB64 = encodeBase64(keypair.publicKey);

      // 2. Connect temp socket to relay
      const socket = io(SERVER_URL, { transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('connect_error', (err: Error) => {
        setError('Connection error: ' + err.message);
        setStep('input');
        setLoading(false);
        socket.disconnect();
        wipeEphemeralKey();
      });

      socket.on('connect', () => {
        // 3. Emit device:link
        socket.emit('device:link', { targetAegisId: trimmed, desktopPubKey: ephemeralPubKeyB64 });
        
        // 4. Generate QR payload
        const payloadJson = JSON.stringify({ v: 1, pubKey: ephemeralPubKeyB64, relay: SERVER_URL });
        setQrPayload(payloadJson);
        setStep('qr');
        setLoading(false);
      });

      socket.on('device:link:approved', async (payload: { encryptedPayload: string, nonceB64: string, mobilePubKey: string }) => {
        if (!ephemeralKeyRef.current) return;
        let dec: Uint8Array | null = null;
        try {
          dec = nacl.box.open(
            decodeBase64(payload.encryptedPayload),
            decodeBase64(payload.nonceB64),
            decodeBase64(payload.mobilePubKey),
            ephemeralKeyRef.current.secretKey
          );
          if (!dec) {
            setError('Error decrypting identity');
            return;
          }

          const parsed = JSON.parse(encodeUTF8(dec));
          if (
            typeof parsed !== 'object' || parsed === null ||
            typeof parsed.publicKeyB64 !== 'string' ||
            typeof parsed.secretKeyB64 !== 'string' ||
            typeof parsed.signingPublicKeyB64 !== 'string' ||
            typeof parsed.signingSecretKeyB64 !== 'string' ||
            typeof parsed.aegisId !== 'string'
          ) {
            setError('Received malformed identity data');
            return;
          }
          
          const json = parsed as {
            publicKeyB64: string;
            secretKeyB64: string;
            signingPublicKeyB64: string;
            signingSecretKeyB64: string;
            aegisId: string;
            spkId?: number;
            spkSecretB64?: string;
          };
          const newIdentity = identityFromStored({
            publicKeyB64: json.publicKeyB64,
            secretKeyB64: json.secretKeyB64,
            signingPublicKeyB64: json.signingPublicKeyB64,
            signingSecretKeyB64: json.signingSecretKeyB64,
            createdAt: Date.now()
          });

          // Trust the aegisId DERIVED from the transported pubkey, never the one
          // supplied alongside it. A mismatch means a corrupt/tampered transfer —
          // reject it instead of silently overwriting the derived value.
          if (json.aegisId && json.aegisId !== newIdentity.aegisId) {
            setError('Identity mismatch — transfer rejected');
            return;
          }

          await useIdentity.getState().linkDevice(newIdentity);

          if (json.spkId != null && json.spkSecretB64) {
            await saveSpkSecret(json.spkId, json.spkSecretB64);
          }

          await useIdentity.getState().hydrate();

          onLinked();
        } catch (err) {
          setError('Error processing approval: ' + (err as Error).message);
        } finally {
          dec?.fill(0);
          wipeEphemeralKey();
        }
      });

      socket.on('error_msg', (e: { code?: string }) => {
        setError('Server error: ' + (e?.code || 'Unknown'));
        setStep('input');
        setLoading(false);
        socket.disconnect();
        wipeEphemeralKey();
      });

    } catch (err) {
      // Synchronous failure (e.g. io() throwing) after the ephemeral keypair was
      // assigned to ephemeralKeyRef but before any socket handler could wipe it:
      // zeroize here too so the secret never lingers until unmount.
      setError('Connection error: ' + (err as Error).message);
      setLoading(false);
      wipeEphemeralKey();
    }
  }

  const inputStyle = {
    width: '100%', padding: '14px', fontFamily: t.fontMono, fontSize: 16,
    color: t.text, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`,
    borderRadius: t.radiusS, boxSizing: 'border-box' as const, marginBottom: 12,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Link Device" left={
        <button onClick={onBack} aria-label="Back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.text} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {step === 'input' && (
          <div style={{ width: '100%', maxWidth: 400 }}>
            <p style={{ fontFamily: t.font, fontSize: 15, color: t.textDim, marginBottom: 24, lineHeight: 1.5 }}>
              To link this desktop, you must first enter your Aegis ID. You can find it in your profile within the mobile app.
            </p>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>
              YOUR AEGIS ID
            </span>
            <input
              type="text"
              value={aegisId}
              onChange={(e) => { setAegisId(e.target.value); setError(''); }}
              placeholder="ABC-1234-5678"
              style={inputStyle}
            />
            {error && (
              <div style={{ padding: 12, backgroundColor: `${t.danger}22`, border: `1px solid ${t.danger}66`, borderRadius: t.radiusS, marginBottom: 16 }}>
                <span style={{ fontFamily: t.font, fontSize: 13, color: t.danger }}>{error}</span>
              </div>
            )}
            <PrimaryButton t={t} label={loading ? 'Connecting...' : 'Next'} onPress={handleNext} disabled={loading} />
          </div>
        )}

        {step === 'qr' && (
          <div style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <p style={{ fontFamily: t.font, fontSize: 15, color: t.textDim, marginBottom: 32, lineHeight: 1.5, textAlign: 'center' }}>
              Open AegisLink on your mobile, go to <strong>Settings &gt; Linked Devices</strong> and scan this QR code.
            </p>
            
            <QRCanvas payload={qrPayload} t={t} />
            
            <p style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 32, textAlign: 'center' }}>
              Waiting for mobile approval...
            </p>

            {error && (
              <div style={{ padding: 12, backgroundColor: `${t.danger}22`, border: `1px solid ${t.danger}66`, borderRadius: t.radiusS, marginTop: 16, width: '100%' }}>
                <span style={{ fontFamily: t.font, fontSize: 13, color: t.danger }}>{error}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
