import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useWork } from '../store/work';
import { useIdentity } from '../store/identity';

type NavItem = 'overview' | 'members' | 'devices' | 'audit';

interface Props {
  onBack: () => void;
}

const inputStyle = (t: { font: string; text: string; bg: string; border: string; radiusS: number; }): CSSProperties => ({
  width: '100%', padding: 12, fontFamily: t.font, fontSize: 14,
  color: t.text, backgroundColor: t.bg,
  border: `1px solid ${t.border}`, borderRadius: t.radiusS,
  boxSizing: 'border-box',
});

export function WorkDashboard({ onBack }: Props) {
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);
  const aegisId = identity?.aegisId ?? '';
  const { org, members, devices, auditLog, loading, fetchOrg, createOrg, createInvite, revokeDevice } = useWork();

  const [activeNav, setActiveNav] = useState<NavItem>('overview');
  const [setupModal, setSetupModal] = useState(false);
  const [joinModal, setJoinModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);
  const [orgNameInput, setOrgNameInput] = useState('');
  const [joinTokenInput, setJoinTokenInput] = useState('');
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('aegis.work.orgId');
    if (stored && aegisId) void fetchOrg(stored, aegisId);
  }, [aegisId]);

  async function handleCreateOrg() {
    if (!orgNameInput.trim() || !aegisId) return;
    try {
      const orgId = await createOrg(orgNameInput.trim(), aegisId);
      localStorage.setItem('aegis.work.orgId', orgId);
      setSetupModal(false);
      setOrgNameInput('');
    } catch (e) { window.alert((e as Error).message); }
  }

  async function handleJoin() {
    if (!joinTokenInput.trim() || !aegisId) return;
    try {
      const { useWork: w } = await import('../store/work');
      const { orgId } = await w.getState().joinOrg(joinTokenInput.trim(), aegisId, `${aegisId}-primary`, 'AegisLink Desktop', 'desktop');
      localStorage.setItem('aegis.work.orgId', orgId);
      setJoinModal(false);
      setJoinTokenInput('');
      void fetchOrg(orgId, aegisId);
    } catch (e) { window.alert(`Join failed: ${(e as Error).message}`); }
  }

  async function handleCreateInvite() {
    if (!org || !aegisId) return;
    try {
      const token = await createInvite(org.orgId, aegisId, 'General', 'member');
      setPendingInviteToken(token);
    } catch (e) { window.alert((e as Error).message); }
  }

  const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100, padding: 24, boxSizing: 'border-box',
  };
  const modalStyle: CSSProperties = {
    backgroundColor: t.surface, borderRadius: t.radius, padding: 20,
    width: '100%', maxWidth: 400, boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', gap: 14,
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 1 }}>LOADING…</span>
      </div>
    );
  }

  if (!org) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', padding: '0 32px', gap: 16 }}>
        <I.Shield size={40} color={t.accent} />
        <span style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '700', color: t.text, textAlign: 'center', display: 'block' }}>AegisLink Work</span>
        <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: '20px', display: 'block' }}>
          Secure organization workspace. E2EE by default — no plaintext on server.
        </span>
        <button onClick={() => setSetupModal(true)} style={{ width: '100%', maxWidth: 360, padding: '12px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '700', color: t.accentInk, fontSize: 14 }}>
          Create organization
        </button>
        <button onClick={() => setJoinModal(true)} style={{ width: '100%', maxWidth: 360, padding: '12px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '500', color: t.text, fontSize: 14 }}>
          Join with invite token
        </button>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', marginTop: 8, fontFamily: t.fontMono, fontSize: 11, color: t.textFaint }}>
          ← Back
        </button>

        {setupModal && (
          <div style={overlayStyle}>
            <div style={modalStyle}>
              <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>Organization name</span>
              <input value={orgNameInput} onChange={(e) => setOrgNameInput(e.target.value)} placeholder="Acme Corp" style={inputStyle(t) as React.CSSProperties} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setSetupModal(false)} style={{ flex: 1, padding: '11px 0', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', background: 'none', fontFamily: t.font, color: t.text }}>Cancel</button>
                <button onClick={() => void handleCreateOrg()} style={{ flex: 1, padding: '11px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '700', color: t.accentInk }}>Create</button>
              </div>
            </div>
          </div>
        )}
        {joinModal && (
          <div style={overlayStyle}>
            <div style={modalStyle}>
              <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>Enter invite token</span>
              <input value={joinTokenInput} onChange={(e) => setJoinTokenInput(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style={inputStyle(t) as React.CSSProperties} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setJoinModal(false)} style={{ flex: 1, padding: '11px 0', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', background: 'none', fontFamily: t.font, color: t.text }}>Cancel</button>
                <button onClick={() => void handleJoin()} style={{ flex: 1, padding: '11px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '700', color: t.accentInk }}>Join</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const navItems: { id: NavItem; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'members', label: 'Members' },
    { id: 'devices', label: 'Devices' },
    { id: 'audit', label: 'Audit log' },
  ];

  function renderContent() {
    if (activeNav === 'overview') {
      return (
        <div style={{ padding: '16px 18px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
            {[
              { label: 'MEMBERS', val: String(members.length) },
              { label: 'DEVICES', val: String(devices.length) },
              { label: 'ORG ID', val: (org?.orgId ?? '').slice(0, 8) + '…' },
            ].map((kpi) => (
              <div key={kpi.label} style={{ flex: '1 1 120px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1.1, display: 'block' }}>{kpi.label}</span>
                <span style={{ fontFamily: t.fontDisplay, fontSize: 26, fontWeight: '600', color: t.text, display: 'block', marginTop: 4 }}>{kpi.val}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => { setInviteModal(true); }}
            style={{ width: '100%', padding: '12px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radius, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.accentInk }}
          >
            Invite member
          </button>
        </div>
      );
    }
    if (activeNav === 'members') {
      return (
        <div>
          {members.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>No members</span>
            </div>
          )}
          {members.map((m) => (
            <div key={m.aegis_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: `1px solid ${t.divider}` }}>
              <div style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text }}>{m.aegis_id.slice(0, 2).toUpperCase()}</span>
              </div>
              <div style={{ flex: 1 }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text, display: 'block' }}>{m.aegis_id.slice(0, 11)}</span>
                <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim }}>{m.role} · {m.team}</span>
              </div>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: m.verified ? t.accent : t.warn, letterSpacing: 0.5 }}>
                {m.verified ? 'VERIFIED' : 'UNVERIFIED'}
              </span>
            </div>
          ))}
        </div>
      );
    }
    if (activeNav === 'devices') {
      return (
        <div>
          {devices.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>No devices</span>
            </div>
          )}
          {devices.map((d) => (
            <div key={d.device_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: `1px solid ${t.divider}` }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text, display: 'block' }}>{d.device_name}</span>
                <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim }}>{d.platform} · {d.aegis_id.slice(0, 8)}</span>
              </div>
              <button
                onClick={() => { if (window.confirm(`Revoke ${d.device_name ?? d.name}?`)) void revokeDevice(org?.orgId ?? '', d.device_id, aegisId); }}
                aria-label={`Revoke ${d.device_name}`}
                style={{ padding: '6px 10px', fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.danger, backgroundColor: `${t.danger}11`, border: `1px solid ${t.danger}88`, borderRadius: t.radiusS, cursor: 'pointer' }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      );
    }
    if (activeNav === 'audit') {
      return (
        <div>
          {auditLog.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>No audit events</span>
            </div>
          )}
          {auditLog.map((entry, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 18px', borderBottom: `1px solid ${t.divider}` }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5, flexShrink: 0, paddingTop: 2 }}>
                {new Date(entry.ts ?? entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>{entry.action}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={org?.name ?? 'Work'} left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } right={
        <button onClick={() => setInviteModal(true)} aria-label="Invite" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.Plus size={22} color={t.accent} />
        </button>
      } />

      {/* Nav tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${t.divider}`, overflowX: 'auto' }}>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveNav(item.id)}
            aria-label={item.label}
            style={{
              padding: '10px 16px', fontFamily: t.fontMono, fontSize: 10,
              color: activeNav === item.id ? t.accent : t.textDim,
              letterSpacing: 0.8, background: 'none', border: 'none',
              borderBottom: activeNav === item.id ? `2px solid ${t.accent}` : '2px solid transparent',
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {item.label.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {renderContent()}
      </div>

      {/* Invite modal */}
      {inviteModal && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>Invite member</span>
            {pendingInviteToken ? (
              <>
                <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5, display: 'block' }}>INVITE TOKEN</span>
                <div style={{ padding: 12, backgroundColor: t.bg, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, wordBreak: 'break-all' }}>
                  <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent }}>{pendingInviteToken}</span>
                </div>
                <button
                  onClick={() => { navigator.clipboard.writeText(pendingInviteToken).catch(() => {}); }}
                  style={{ padding: '10px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.accentInk }}
                >
                  Copy token
                </button>
                <button
                  onClick={() => { setPendingInviteToken(null); setInviteModal(false); }}
                  style={{ padding: '10px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, color: t.text }}
                >
                  Close
                </button>
              </>
            ) : (
              <>
                <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>A one-time token will be generated. Share it with the new member securely.</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setInviteModal(false)} style={{ flex: 1, padding: '11px 0', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', background: 'none', fontFamily: t.font, color: t.text }}>Cancel</button>
                  <button onClick={() => void handleCreateInvite()} style={{ flex: 1, padding: '11px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '700', color: t.accentInk }}>Generate</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
