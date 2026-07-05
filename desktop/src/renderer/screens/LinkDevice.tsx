import { useState, useEffect, useRef } from 'react';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8 } from 'tweetnacl-util';
import QRCode from 'qrcode';
import { io, Socket } from 'socket.io-client';
import { SERVER_URL } from '../config';
import { identityFromStored } from '../crypto/identity';
import { useIdentity } from '../store/identity';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import { I } from '../components/icons';

interface Props {
  onBack: () => void;
  onLinked: () => void;
}

function QRCanvas({ payload, t }: { payload: string; t: { radius: number } }) {
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

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  async function handleNext() {
    const trimmed = aegisId.trim();
    if (!trimmed) {
      setError('Por favor, ingresa un Aegis ID válido.');
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
        try {
          const dec = nacl.box.open(
            decodeBase64(payload.encryptedPayload),
            decodeBase64(payload.nonceB64),
            decodeBase64(payload.mobilePubKey),
            ephemeralKeyRef.current.secretKey
          );
          if (!dec) {
            setError('Error al descifrar la identidad');
            return;
          }
          
          const json = JSON.parse(decodeUTF8(dec));
          
          const newIdentity = identityFromStored({
            publicKeyB64: json.publicKeyB64,
            secretKeyB64: json.secretKeyB64,
            signingPublicKeyB64: json.signingPublicKeyB64,
            signingSecretKeyB64: json.signingSecretKeyB64,
            createdAt: Date.now()
          });

          newIdentity.aegisId = json.aegisId; // Ensure Aegis ID matches exactly

          await useIdentity.getState().linkDevice(newIdentity);
          
          if (json.spkId != null && json.spkSecretB64) {
            const { saveSpkSecret } = await import('../../db/local');
            await saveSpkSecret(json.spkId, json.spkSecretB64);
          }
          
          await useIdentity.getState().hydrate();
          
          onLinked();
        } catch (err) {
          setError('Error al procesar la aprobación: ' + (err as Error).message);
        }
      });

      socket.on('error_msg', (e: any) => {
        setError('Error del servidor: ' + (e?.code || 'Desconocido'));
        setStep('input');
        setLoading(false);
        socket.disconnect();
      });

    } catch (err) {
      setError('Error de conexión: ' + (err as Error).message);
      setLoading(false);
    }
  }

  const inputStyle = {
    width: '100%', padding: '14px', fontFamily: t.fontMono, fontSize: 16,
    color: t.text, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`,
    borderRadius: t.radiusS, boxSizing: 'border-box' as const, marginBottom: 12,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Vincular Dispositivo" left={
        <button onClick={onBack} aria-label="Volver" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.text} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {step === 'input' && (
          <div style={{ width: '100%', maxWidth: 400 }}>
            <p style={{ fontFamily: t.font, fontSize: 15, color: t.textDim, marginBottom: 24, lineHeight: 1.5 }}>
              Para vincular este escritorio, primero debes ingresar tu Aegis ID. Puedes encontrarlo en tu perfil dentro de la aplicación móvil.
            </p>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>
              TU AEGIS ID
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
            <PrimaryButton t={t} label={loading ? 'Conectando...' : 'Siguiente'} onPress={handleNext} />
          </div>
        )}

        {step === 'qr' && (
          <div style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <p style={{ fontFamily: t.font, fontSize: 15, color: t.textDim, marginBottom: 32, lineHeight: 1.5, textAlign: 'center' }}>
              Abre AegisLink en tu móvil, ve a <strong>Ajustes &gt; Dispositivos Vinculados</strong> y escanea este código QR.
            </p>
            
            <QRCanvas payload={qrPayload} t={t} />
            
            <p style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 32, textAlign: 'center' }}>
              Esperando aprobación del móvil...
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
