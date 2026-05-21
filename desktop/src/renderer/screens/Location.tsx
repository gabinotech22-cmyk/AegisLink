import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { decodeBase64 } from 'tweetnacl-util';
import { sendMessage } from '../socket/client';
import { useIdentity } from '../store/identity';

interface Contact {
  aegisId: string;
  name: string;
  publicKeyB64: string;
}

interface Props {
  contact: Contact;
  onBack: () => void;
  onShare: () => void;
}

const DURATIONS = [
  { id: '15m', label: '15 minutes', sub: 'Expires automatically' },
  { id: '1h',  label: '1 hour',     sub: 'Standard duration' },
  { id: '8h',  label: '8 hours',    sub: 'Extended sharing' },
  { id: 'eod', label: 'End of day', sub: 'Until midnight' },
] as const;

export function LocationScreen({ contact, onBack, onShare }: Props) {
  const { t } = useTheme();
  const { identity } = useIdentity();
  const [dur, setDur] = useState<string>('1h');
  const [precise, setPrecise] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [locationName, setLocationName] = useState('');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [permError, setPermError] = useState<string | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationName('GEOLOCATION NOT SUPPORTED');
      setCoords({ latitude: 47.3769, longitude: 8.5417 });
      setLoading(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setCoords({ latitude, longitude });
        setLocationName(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
        setLoading(false);
      },
      (err) => {
        setPermError(`Location unavailable: ${err.message}`);
        setLocationName('47.37690, 8.54170');
        setCoords({ latitude: 47.3769, longitude: 8.5417 });
        setLoading(false);
      },
      { enableHighAccuracy: precise, timeout: 8000 }
    );
  }, [precise]);

  async function handleShare() {
    if (!identity) return;
    setSharing(true);
    try {
      let lat = coords?.latitude ?? 47.3769;
      let lon = coords?.longitude ?? 8.5417;
      let locStr = locationName;
      if (!precise) {
        lat = Math.round(lat * 200) / 200;
        lon = Math.round(lon * 200) / 200;
        locStr = `Area of ${locStr}`;
      }
      const durObj = DURATIONS.find((d) => d.id === dur);
      const msgText = `[Location] ${precise ? 'Exact' : 'Approximate'} · ${durObj?.label ?? dur} · ${locStr} (Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)})`;
      const now = Date.now();
      const expiresMap: Record<string, number> = {
        '15m': now + 15 * 60 * 1000,
        '1h': now + 60 * 60 * 1000,
        '8h': now + 8 * 60 * 60 * 1000,
      };
      const expiresAt = expiresMap[dur] ?? (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); })();
      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: msgText,
        type: 'location',
        expiresAt,
      });
      window.alert('Location shared successfully.');
      onShare();
    } catch (e) {
      window.alert(`Failed to share location: ${(e as Error).message}`);
    } finally {
      setSharing(false);
    }
  }

  const mapsUrl = coords
    ? `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Share location" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      {/* Map placeholder */}
      <div style={{ margin: '8px 18px 16px', height: 200, borderRadius: t.radius, border: `1px solid ${t.border}`, backgroundColor: '#1a2326', overflow: 'hidden', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg viewBox="0 0 280 200" width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
          <path d="M0 80 Q140 60 280 100" stroke={t.borderStrong} strokeWidth={6} fill="none" opacity={0.5} />
          <path d="M120 0 L160 200" stroke={t.borderStrong} strokeWidth={6} fill="none" opacity={0.5} />
          <path d="M0 150 L280 140" stroke={t.borderStrong} strokeWidth={3} fill="none" opacity={0.4} />
        </svg>
        {loading ? (
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 1 }}>LOCATING…</span>
        ) : (
          <div style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.accent, border: `3px solid ${t.bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I.Shield size={18} color={t.accentInk} />
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 22 }}>
        <div style={{ padding: '0 22px 12px' }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>
            {locationName.toUpperCase() || 'DETECTING…'}
          </span>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px', display: 'block' }}>
            Share your location with {contact.name}
          </span>
          {permError && (
            <span style={{ fontFamily: t.font, fontSize: 12, color: t.danger, display: 'block', marginTop: 4 }}>
              {permError}
            </span>
          )}
          {mapsUrl && (
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5, display: 'block', marginTop: 6 }}>
              Open in Google Maps →
            </a>
          )}
        </div>

        <Section t={t} label="DURATION">
          {DURATIONS.map((o, i) => {
            const sel = dur === o.id;
            return (
              <button
                key={o.id}
                onClick={() => setDur(o.id)}
                aria-label={o.label}
                style={{
                  display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12,
                  padding: '12px 16px', width: '100%', boxSizing: 'border-box',
                  borderBottom: i < DURATIONS.length - 1 ? `1px solid ${t.divider}` : 'none',
                  background: 'none', border: 'none',
                  borderBottomWidth: i < DURATIONS.length - 1 ? 1 : 0, borderBottomStyle: 'solid', borderBottomColor: t.divider,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{ width: 18, height: 18, borderRadius: 9, border: `2px solid ${sel ? t.accent : t.borderStrong}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxSizing: 'border-box' }}>
                  {sel && <div style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.accent }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: sel ? '600' : '400', color: t.text, display: 'block' }}>{o.label}</span>
                  <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginTop: 2 }}>{o.sub}</span>
                </div>
              </button>
            );
          })}
        </Section>

        <Section t={t} label="PRECISION">
          <Toggle
            t={t}
            label="Precise location"
            sub="Share exact coordinates vs approximate area"
            value={precise}
            onChange={setPrecise}
            noBorder
          />
        </Section>

        <div style={{ padding: '10px 18px' }}>
          <button
            onClick={() => void handleShare()}
            disabled={sharing || loading}
            aria-label="Share location"
            style={{
              width: '100%', padding: '13px 0', backgroundColor: t.accent, border: 'none',
              borderRadius: t.radius, cursor: sharing || loading ? 'not-allowed' : 'pointer',
              fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.accentInk,
              opacity: sharing || loading ? 0.7 : 1,
            }}
          >
            {sharing ? 'Sharing…' : 'Share location'}
          </button>
        </div>
      </div>
    </div>
  );
}
