import { useState, useCallback, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useIdentity } from '../store/identity';
import { getSocket } from '../socket/client';

interface Props {
  onBack: () => void;
}

interface LinkedDevice {
  id: string;
  name: string;
  platform: string;
  linkedAt: number;
}

function formatLinkedAt(ts: number): string {
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return String(ts); }
}

function truncatePubKey(b64: string): string {
  if (b64.length <= 14) return b64;
  return `${b64.slice(0, 8)}…${b64.slice(-4)}`;
}

export function DevicesScreen({ onBack }: Props) {
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);

  const [linkedDevices, setLinkedDevices] = useState<LinkedDevice[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [manualId, setManualId] = useState('');
  const [showLinkPanel, setShowLinkPanel] = useState(false);
  const [confirmDevice, setConfirmDevice] = useState<{ pubKey: string; relay: string } | null>(null);
  const [linking, setLinking] = useState(false);

  const loadDevices = useCallback(() => {
    setLoadingList(true);
    const socket = getSocket();
    if (!socket) { setLoadingList(false); return; }
    socket.emit('device:list', (res: { ok: boolean; devices?: LinkedDevice[] }) => {
      setLoadingList(false);
      if (res.ok && res.devices) setLinkedDevices(res.devices);
    });
  }, []);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  function handleManualLink() {
    const trimmed = manualId.trim();
    if (!trimmed) { setLinkError('Enter a device ID or JSON payload.'); return; }
    let payload: { pubKey?: string; relay?: string };
    try {
      payload = JSON.parse(trimmed) as { pubKey?: string; relay?: string };
    } catch {
      setLinkError('Could not parse input. Paste the full JSON from AegisLink Desktop QR.');
      return;
    }
    if (typeof payload.pubKey !== 'string' || typeof payload.relay !== 'string') {
      setLinkError('Invalid format — missing pubKey or relay.');
      return;
    }
    setConfirmDevice({ pubKey: payload.pubKey, relay: payload.relay });
    setLinkError(null);
  }

  async function handleConfirmLink() {
    if (!confirmDevice || !identity) return;
    setLinking(true);
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('device:link:approve', {
          desktopPubKey: confirmDevice.pubKey,
          deviceName: 'AegisLink Desktop',
          platform: 'desktop',
        });
      }
      loadDevices();
      setConfirmDevice(null);
      setShowLinkPanel(false);
      setManualId('');
    } catch (e) {
      setLinkError((e as Error).message);
    } finally {
      setLinking(false);
    }
  }

  async function handleRevoke(device: LinkedDevice) {
    if (!window.confirm(`Revoke "${device.name}"? New messages will immediately become unreadable.`)) return;
    setRevoking(device.id);
    try {
      const socket = getSocket();
      if (socket) {
        await new Promise<void>((resolve, reject) => {
          socket.emit('device:revoke', { deviceId: device.id }, (res: { ok: boolean; error?: string }) => {
            if (res.ok) resolve(); else reject(new Error(res.error ?? 'revoke_failed'));
          });
        });
      }
      setLinkedDevices((prev) => prev.filter((d) => d.id !== device.id));
    } catch (e) {
      window.alert(`Revoke failed: ${(e as Error).message}`);
    } finally {
      setRevoking(null);
    }
  }

  const inputStyle: CSSProperties = {
    width: '100%', padding: '10px 12px', fontFamily: t.fontMono, fontSize: 12,
    color: t.text, backgroundColor: t.bg, border: `1px solid ${t.borderStrong}`,
    borderRadius: t.radiusS, marginBottom: 10, boxSizing: 'border-box',
    resize: 'vertical' as const,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Devices" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } right={
        <button onClick={() => setShowLinkPanel((v) => !v)} aria-label="Link new device" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.Plus size={22} color={t.accent} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 24 }}>
        {/* Info banner */}
        <div style={{ margin: '12px 18px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>
            Each device has its own key. If you lose one, revoke it here — new messages will immediately become unreadable.
          </span>
        </div>

        {linkError && (
          <div style={{ margin: '0 18px 10px', padding: 12, backgroundColor: `${t.danger}22`, border: `1px solid ${t.danger}66`, borderRadius: t.radiusS }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.danger }}>{linkError}</span>
          </div>
        )}

        {/* Link panel */}
        {showLinkPanel && (
          <div style={{ margin: '0 18px 16px', padding: 16, backgroundColor: t.surface, border: `1px solid ${t.accent}44`, borderRadius: t.radius }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.1, display: 'block', marginBottom: 12 }}>
              LINK A NEW DEVICE
            </span>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '18px', display: 'block', marginBottom: 10 }}>
              On the mobile app, open Add Device and scan the QR. Then paste the full JSON payload from the desktop QR below.
            </span>
            <textarea
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder={'{ "v": 1, "pubKey": "...", "relay": "..." }'}
              rows={3}
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleManualLink}
                style={{ flex: 1, padding: '10px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.accentInk, fontSize: 13 }}
              >
                Parse &amp; link
              </button>
              <button
                onClick={() => { setShowLinkPanel(false); setManualId(''); setLinkError(null); }}
                style={{ flex: 1, padding: '10px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, color: t.text, fontSize: 13 }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* This device */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${t.divider}` }}>
          <div style={{ width: 38, height: 38, borderRadius: t.radius, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I.Monitor size={18} color={t.text} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>This Device (Desktop)</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, border: `1px solid ${t.accent}`, borderRadius: 99, padding: '1px 5px', letterSpacing: 0.5 }}>
                THIS DEVICE
              </span>
            </div>
            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim }}>Desktop · Active now</span>
          </div>
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent }} />
        </div>

        {loadingList && linkedDevices.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.8 }}>LOADING…</span>
          </div>
        )}

        {linkedDevices.map((device) => (
          <div key={device.id} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${t.divider}` }}>
            <div style={{ width: 38, height: 38, borderRadius: t.radius, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <I.Phone size={18} color={t.text} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{device.name}</span>
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim }}>Linked {formatLinkedAt(device.linkedAt)}</span>
            </div>
            {revoking === device.id ? (
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.danger }}>REVOKING…</span>
            ) : (
              <button
                onClick={() => void handleRevoke(device)}
                aria-label={`Revoke ${device.name}`}
                style={{ padding: '6px 10px', fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.danger, backgroundColor: `${t.danger}11`, border: `1px solid ${t.danger}88`, borderRadius: t.radiusS, cursor: 'pointer' }}
              >
                Revoke
              </button>
            )}
          </div>
        ))}

        {!loadingList && linkedDevices.length === 0 && !showLinkPanel && (
          <div style={{ padding: '32px 18px', textAlign: 'center' }}>
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>No other linked devices</span>
          </div>
        )}
      </div>

      {/* Confirm link overlay */}
      {confirmDevice && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 24, boxSizing: 'border-box' }}>
          <div style={{ backgroundColor: t.surface, borderRadius: t.radius, border: `1px solid ${t.border}`, padding: 24, width: '100%', maxWidth: 360, boxSizing: 'border-box' }}>
            <div style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: `${t.accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <I.Monitor size={24} color={t.accent} />
            </div>
            <span style={{ fontFamily: t.fontDisplay, fontWeight: '600', fontSize: 18, color: t.text, display: 'block', textAlign: 'center', marginBottom: 8 }}>
              Link AegisLink Desktop?
            </span>
            <div style={{ backgroundColor: t.surface2, borderRadius: t.radiusS, padding: 10, marginBottom: 16 }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5, display: 'block' }}>DEVICE KEY</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, display: 'block', marginTop: 4 }}>{truncatePubKey(confirmDevice.pubKey)}</span>
              <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, display: 'block', marginTop: 4 }}>Relay: {confirmDevice.relay}</span>
            </div>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: '19px', display: 'block', marginBottom: 20 }}>
              This desktop will be able to send and receive messages using your AegisLink identity. Keys never leave your devices.
            </span>
            {linking ? (
              <div style={{ textAlign: 'center', padding: 8 }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent }}>LINKING…</span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setConfirmDevice(null)}
                  style={{ flex: 1, padding: '12px 0', backgroundColor: 'transparent', border: `1px solid ${t.border}`, borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.text, fontSize: 14 }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleConfirmLink()}
                  style={{ flex: 1, padding: '12px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.accentInk, fontSize: 14 }}
                >
                  Link
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
