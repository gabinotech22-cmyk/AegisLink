import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TabBar, type Tab } from '../components/TabBar';

// ---------------------------------------------------------------------------
// Stub types
// ---------------------------------------------------------------------------

interface Identity {
  aegisId: string;
  publicKey: Uint8Array;
  publicKeyB64: string;
}

interface Props {
  onBack: () => void;
  onScan: () => void;
  onTab?: (tab: Tab) => void;
}

// Stub fingerprint functions
function fingerprintWords(key: Uint8Array): string[] {
  const wordlist = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  return wordlist.slice(0, 8);
}
function fingerprintHex(key: Uint8Array): string[] {
  const hex = Array.from(key).map((b) => b.toString(16).padStart(2, '0')).join('');
  const padded = hex.padEnd(32, '0').slice(0, 32);
  return [padded.slice(0, 4), padded.slice(4, 8), padded.slice(8, 12), padded.slice(12, 16),
          padded.slice(16, 20), padded.slice(20, 24), padded.slice(24, 28), padded.slice(28, 32)].map((s) => s.toUpperCase());
}
function encodeIdentityQR(aegisId: string, pubKeyB64: string): string {
  return `aegislink:v1:${aegisId}:${pubKeyB64}`;
}

export function VerifyScreen({ onBack, onScan, onTab }: Props) {
  const { t } = useTheme();
  const asTab = !!onTab;

  // Stub identity
  const [identity] = useState<Identity>({
    aegisId: 'ABC-1234-5678',
    publicKey: new Uint8Array(32).fill(0x42),
    publicKeyB64: btoa('stub-public-key-data-for-display'),
  });

  const [words, setWords] = useState<string[]>([]);
  const [hex, setHex] = useState<string[]>([]);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  useEffect(() => {
    setWords(fingerprintWords(identity.publicKey));
    setHex(fingerprintHex(identity.publicKey));
  }, [identity.publicKey]);

  const qrPayload = encodeIdentityQR(identity.aegisId, identity.publicKeyB64);

  async function handleCopyId() {
    try {
      await navigator.clipboard.writeText(identity.aegisId);
      setCopyMsg('AegisLink ID copied!');
      setTimeout(() => setCopyMsg(null), 2000);
    } catch {
      setCopyMsg('Copy failed — use Ctrl+C');
      setTimeout(() => setCopyMsg(null), 2000);
    }
  }

  async function handleCopyQR() {
    try {
      await navigator.clipboard.writeText(qrPayload);
      setCopyMsg('QR payload copied!');
      setTimeout(() => setCopyMsg(null), 2000);
    } catch {
      setCopyMsg('Copy failed');
      setTimeout(() => setCopyMsg(null), 2000);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10 }}>
        {asTab ? (
          <div style={{ width: 22 }} />
        ) : (
          <button onClick={onBack} aria-label="Back" style={iconBtn}>
            <I.ChevronL size={22} color={t.text} />
          </button>
        )}
        <span style={{ flex: 1, textAlign: 'center', fontFamily: t.fontDisplay, fontSize: asTab ? 24 : 17, fontWeight: '600', color: t.text, letterSpacing: -0.4 }}>
          Verify
        </span>
        <div style={{ width: 22 }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingLeft: 22, paddingRight: 22, paddingBottom: 40 }}>
        <p style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center', lineHeight: '21px', margin: '12px 0', maxWidth: 320 }}>
          Show this QR to your peer in person, or read the 8 safety words aloud. Matching = no one's in the middle.
        </p>

        {/* QR display — desktop shows payload text in a styled box */}
        <div style={{ padding: 20, backgroundColor: t.surface, borderRadius: t.radius, border: `1px solid ${t.borderStrong}`, marginTop: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, width: '100%', maxWidth: 280, boxSizing: 'border-box' }}>
          {/* QR placeholder grid */}
          <QRPlaceholder payload={qrPayload} t={t} />
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.5, textAlign: 'center', wordBreak: 'break-all' }}>
            {qrPayload.slice(0, 40)}…
          </span>
          <button onClick={handleCopyQR} aria-label="Copy QR payload" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, backgroundColor: 'transparent', cursor: 'pointer' }}>
            <I.Copy size={14} color={t.textDim} />
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>COPY QR DATA</span>
          </button>
        </div>

        {/* AegisLink ID */}
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text, letterSpacing: 0.6 }}>
            {identity.aegisId}
          </span>
          <button onClick={() => void handleCopyId()} aria-label="Copy AegisLink ID" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}>
            <I.Copy size={16} color={t.accent} />
          </button>
        </div>

        {copyMsg && (
          <div style={{ marginTop: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, backgroundColor: `${t.accent}22`, borderRadius: 99 }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent }}>{copyMsg}</span>
          </div>
        )}

        {/* Safety words */}
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.2, marginTop: 24, marginBottom: 10, display: 'block' }}>
          OR — 8 SAFETY WORDS
        </span>

        <div style={{ width: '100%', maxWidth: 320, border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, padding: 14, backgroundColor: t.surface, boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {words.map((w, i) => (
              <div key={i} style={{ width: 'calc(50% - 4px)', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, backgroundColor: t.surface2, borderRadius: t.radiusS, boxSizing: 'border-box' }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, width: 14, flexShrink: 0 }}>
                  {(i + 1).toString().padStart(2, '0')}
                </span>
                <span style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text, fontWeight: '500' }}>{w}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Hex fingerprint */}
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.2, marginTop: 20, marginBottom: 10, display: 'block' }}>
          OR — HEX FINGERPRINT
        </span>
        <div style={{ width: '100%', maxWidth: 320, padding: 14, backgroundColor: t.surface, borderRadius: t.radius, border: `1px solid ${t.borderStrong}`, boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {hex.map((h, i) => (
              <div key={i} style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, backgroundColor: t.surface2, borderRadius: t.radiusS }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text }}>{h}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Security note */}
        <div style={{ width: '100%', maxWidth: 320, marginTop: 20, padding: 14, backgroundColor: `${t.accent}11`, border: `1px solid ${t.accent}33`, borderRadius: t.radius, boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <I.Shield size={16} color={t.accent} />
            <p style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '18px', margin: 0 }}>
              AegisLink uses X3DH + Double Ratchet. No server ever sees your keys. Verification proves end-to-end encryption is intact.
            </p>
          </div>
        </div>
      </div>

      {onTab && <TabBar t={t} current="verify" onChange={onTab} />}
    </div>
  );
}

// Simple QR-like grid placeholder for desktop
function QRPlaceholder({ payload, t }: { payload: string; t: { text: string; surface: string; surface2: string; accent: string } }) {
  // Generate a deterministic 11x11 bit matrix from payload hash
  const bits: boolean[] = [];
  for (let i = 0; i < 121; i++) {
    const charCode = payload.charCodeAt(i % payload.length) ^ (i * 31);
    bits.push((charCode & (1 << (i % 8))) !== 0);
  }
  // Force corner finder patterns
  const forced = new Set([0,1,2,3,4,5,6,11,12,13,14,15,16,17,22,77,88,99,110,114,115,116,117,118,119,120]);
  const blank = new Set([7,8,9,10,18,19,20,21,23,24,25,26]);

  return (
    <div style={{ width: 176, height: 176, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {Array.from({ length: 11 }).map((_, row) => (
        <div key={row} style={{ display: 'flex', flexDirection: 'row', gap: 2, flex: 1 }}>
          {Array.from({ length: 11 }).map((_, col) => {
            const idx = row * 11 + col;
            const on = forced.has(idx) ? true : blank.has(idx) ? false : bits[idx];
            return (
              <div
                key={col}
                style={{ flex: 1, backgroundColor: on ? t.text : t.surface, borderRadius: 1 }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

const iconBtn: CSSProperties = {
  padding: 6, background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
