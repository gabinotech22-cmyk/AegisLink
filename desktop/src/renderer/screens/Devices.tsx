import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
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
  useTranslation(); // re-render on language change
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
    if (!trimmed) { setLinkError(i18n.t('devices.enterADeviceId')); return; }
    let payload: { pubKey?: string; relay?: string };
    try {
      payload = JSON.parse(trimmed) as { pubKey?: string; relay?: string };
    } catch {
      setLinkError(i18n.t('devices.couldNotParseInput'));
      return;
    }
    if (typeof payload.pubKey !== 'string' || typeof payload.relay !== 'string') {
      setLinkError(i18n.t('devices.invalidFormatMissingPubkey'));
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
    if (!window.confirm(i18n.t('devices.revokeV0NewMessages', { v0: device.name }))) return;
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
      window.alert(i18n.t('devices.revokeFailedV0', { v0: (e as Error).message }));
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
      <TopBar t={t} title={i18n.t('workDashboard.navDevices')} left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } right={
        <button onClick={() => setShowLinkPanel((v) => !v)} aria-label={i18n.t('devices.linkDevice')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.Plus size={22} color={t.accent} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 24 }}>
        {/* Info banner */}
        <div style={{ margin: '12px 18px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>{i18n.t('devices.infoDesc')}</span>
        </div>

        {linkError && (
          <div style={{ margin: '0 18px 10px', padding: 12, backgroundColor: `${t.danger}22`, border: `1px solid ${t.danger}66`, borderRadius: t.radiusS }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.danger }}>{linkError}</span>
          </div>
        )}

        {/* Link panel */}
        {showLinkPanel && (
          <div style={{ margin: '0 18px 16px', padding: 16, backgroundColor: t.surface, border: `1px solid ${t.accent}44`, borderRadius: t.radius }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.1, display: 'block', marginBottom: 12 }}>{i18n.t('devices.linkANewDevice')}</span>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '18px', display: 'block', marginBottom: 10 }}>{i18n.t('devices.onTheMobileApp')}</span>
            <textarea
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder={i18n.t('devices.v1PubkeyRelay')}
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
              >{i18n.t('common.cancel')}</button>
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
              <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>{i18n.t('devices.thisDeviceDesktop')}</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, border: `1px solid ${t.accent}`, borderRadius: 99, padding: '1px 5px', letterSpacing: 0.5 }}>{i18n.t('devices.thisDevice')}</span>
            </div>
            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim }}>{i18n.t('devices.desktopActiveNow')}</span>
          </div>
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent }} />
        </div>

        {loadingList && linkedDevices.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.8 }}>{i18n.t('devices.loading')}</span>
          </div>
        )}

        {linkedDevices.map((device) => (
          <div key={device.id} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${t.divider}` }}>
            <div style={{ width: 38, height: 38, borderRadius: t.radius, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <I.Phone size={18} color={t.text} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{device.name}</span>
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim }}>{i18n.t('devices.linkedAtLine', { v0: formatLinkedAt(device.linkedAt) })}</span>
            </div>
            {revoking === device.id ? (
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.danger }}>{i18n.t('devices.revoking')}</span>
            ) : (
              <button
                onClick={() => void handleRevoke(device)}
                aria-label={i18n.t('devices.revokeV0', { v0: device.name })}
                style={{ padding: '6px 10px', fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.danger, backgroundColor: `${t.danger}11`, border: `1px solid ${t.danger}88`, borderRadius: t.radiusS, cursor: 'pointer' }}
              >{i18n.t('devices.revoke')}</button>
            )}
          </div>
        ))}

        {!loadingList && linkedDevices.length === 0 && !showLinkPanel && (
          <div style={{ padding: '32px 18px', textAlign: 'center' }}>
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>{i18n.t('devices.noOtherLinkedDevices')}</span>
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
            <span style={{ fontFamily: t.fontDisplay, fontWeight: '600', fontSize: 18, color: t.text, display: 'block', textAlign: 'center', marginBottom: 8 }}>{i18n.t('devices.linkDesktopConfirmTitle')}</span>
            <div style={{ backgroundColor: t.surface2, borderRadius: t.radiusS, padding: 10, marginBottom: 16 }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5, display: 'block' }}>{i18n.t('devices.deviceKeyLabel')}</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, display: 'block', marginTop: 4 }}>{truncatePubKey(confirmDevice.pubKey)}</span>
              <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, display: 'block', marginTop: 4 }}>{i18n.t('devices.relayLine', { v0: confirmDevice.relay })}</span>
            </div>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: '19px', display: 'block', marginBottom: 20 }}>{i18n.t('devices.linkDesktopConfirmDesc')}</span>
            {linking ? (
              <div style={{ textAlign: 'center', padding: 8 }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent }}>{i18n.t('devices.linking')}</span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setConfirmDevice(null)}
                  style={{ flex: 1, padding: '12px 0', backgroundColor: 'transparent', border: `1px solid ${t.border}`, borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.text, fontSize: 14 }}
                >{i18n.t('common.cancel')}</button>
                <button
                  onClick={() => void handleConfirmLink()}
                  style={{ flex: 1, padding: '12px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.accentInk, fontSize: 14 }}
                >{i18n.t('devices.link')}</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
