import { useEffect, useState, useRef, useCallback } from 'react';
import type { CSSProperties } from 'react';
import QRCode from 'qrcode';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useWork } from '../store/work';
import type { WorkMember, WorkAuditEntry, WorkChannel } from '../store/work';
import { getPermissions } from '../utils/workPermissions';
import type { WorkRole } from '../utils/workPermissions';
import { useIdentity } from '../store/identity';
import { useWorkPresence } from '../store/workPresence';
import { getSocket } from '../socket/client';
import { SERVER_URL } from '../config';

type NavItem = 'overview' | 'members' | 'devices' | 'audit';

// ─── MemberDirectory ──────────────────────────────────────────────────────────

type RoleFilter = 'all' | 'owner' | 'admin' | 'member';

const ROLE_ORDER: Record<WorkMember['role'], number> = { owner: 0, admin: 1, member: 2 };

function roleBadgeStyle(role: WorkMember['role'], t: Theme): React.CSSProperties {
  if (role === 'owner') return { color: '#f59e0b', backgroundColor: '#f59e0b22', border: '1px solid #f59e0b55' };
  if (role === 'admin') return { color: t.accent, backgroundColor: `${t.accent}22`, border: `1px solid ${t.accent}55` };
  return { color: t.textDim, backgroundColor: `${t.textDim}18`, border: `1px solid ${t.textDim}44` };
}

function roleColor(role: WorkMember['role'], t: Theme): string {
  if (role === 'owner') return '#f59e0b';
  if (role === 'admin') return t.warn;
  return t.textDim;
}

function avatarBg(role: WorkMember['role'], t: Theme): string {
  if (role === 'owner') return '#f59e0b';
  if (role === 'admin') return t.warn;
  return t.surface2;
}

function avatarInk(role: WorkMember['role'], t: Theme): string {
  if (role === 'owner') return '#000';
  if (role === 'admin') return t.accentInk;
  return t.text;
}

interface MemberDirectoryProps {
  members: WorkMember[];
  currentAegisId: string;
  orgId: string;
  currentUserRole: WorkMember['role'] | null;
  onlineIds: Set<string>;
}

function MemberDirectory({ members, currentAegisId, orgId, currentUserRole, onlineIds }: MemberDirectoryProps) {
  const { t } = useTheme();
  const { removeMember, patchMember } = useWork();

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(new Map());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [qrPopover, setQrPopover] = useState<{ aegisId: string; dataUrl: string } | null>(null);
  const qrCache = useRef<Map<string, string>>(new Map());

  const myRole: WorkRole = currentUserRole ?? 'member';
  const myPerms = getPermissions(myRole);
  const isAdmin = currentUserRole === 'admin' || currentUserRole === 'owner';

  // Filtered members
  const filtered = members.filter((m) => {
    const matchSearch =
      search === '' ||
      m.aegis_id.toLowerCase().includes(search.toLowerCase()) ||
      m.team.toLowerCase().includes(search.toLowerCase());
    const matchRole = roleFilter === 'all' || m.role === roleFilter;
    return matchSearch && matchRole;
  });

  // Stats (always from full list, not filtered)
  const totalCount = members.length;
  const adminCount = members.filter((m) => m.role === 'admin' || m.role === 'owner').length;
  const verifiedCount = members.filter((m) => m.verified).length;

  // Group by team
  const teamMap = new Map<string, WorkMember[]>();
  for (const m of filtered) {
    const team = m.team || 'Sin equipo';
    if (!teamMap.has(team)) teamMap.set(team, []);
    teamMap.get(team)!.push(m);
  }
  const sortedTeams = Array.from(teamMap.keys()).sort((a, b) => a.localeCompare(b));
  for (const team of sortedTeams) {
    teamMap.get(team)!.sort((a, b) => {
      const ro = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
      if (ro !== 0) return ro;
      return a.aegis_id.localeCompare(b.aegis_id);
    });
  }

  function toggleCollapse(team: string) {
    setCollapsed((prev) => {
      const next = new Map(prev);
      next.set(team, !prev.get(team));
      return next;
    });
  }

  async function handleShowQr(aegisId: string) {
    if (qrCache.current.has(aegisId)) {
      setQrPopover({ aegisId, dataUrl: qrCache.current.get(aegisId)! });
      return;
    }
    const dataUrl = await QRCode.toDataURL(aegisId, { width: 180, margin: 2 }).catch(() => '');
    qrCache.current.set(aegisId, dataUrl);
    setQrPopover({ aegisId, dataUrl });
  }

  async function handleRemove(targetId: string) {
    await removeMember(orgId, targetId, currentAegisId).catch(() => {});
    setConfirmRemove(null);
    setHoveredId(null);
  }

  async function handleToggleRole(m: WorkMember) {
    const newRole: WorkMember['role'] = m.role === 'admin' ? 'member' : 'admin';
    await patchMember(orgId, m.aegis_id, newRole, currentAegisId).catch(() => {});
  }

  const statChipStyle: CSSProperties = {
    flex: '1 1 80px',
    padding: '10px 14px',
    backgroundColor: t.surface,
    border: `1px solid ${t.border}`,
    borderRadius: t.radius,
  };

  const actionBtnStyle: CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    borderRadius: t.radiusS,
    display: 'flex',
    alignItems: 'center',
  };

  if (members.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>No hay miembros en esta organización.</span>
      </div>
    );
  }

  return (
    <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 10 }}>
        {[
          { label: 'TOTAL', val: String(totalCount) },
          { label: 'ADMINS', val: String(adminCount) },
          { label: 'VERIFICADOS', val: String(verifiedCount) },
        ].map((kpi) => (
          <div key={kpi.label} style={statChipStyle}>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1.1, display: 'block' }}>{kpi.label}</span>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', color: t.text, display: 'block', marginTop: 2 }}>{kpi.val}</span>
          </div>
        ))}
      </div>

      {/* Search + filter bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <I.Search size={14} color={t.textFaint} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por ID o equipo…"
            style={{
              width: '100%',
              padding: '9px 10px 9px 32px',
              fontFamily: t.font,
              fontSize: 13,
              color: t.text,
              backgroundColor: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: t.radiusS,
              boxSizing: 'border-box',
              outline: 'none',
            }}
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
          style={{
            padding: '9px 10px',
            fontFamily: t.font,
            fontSize: 12,
            color: t.text,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusS,
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value="all">Todos los roles</option>
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="member">Miembro</option>
        </select>
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, whiteSpace: 'nowrap' }}>
          {filtered.length} miembro{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Team sections */}
      {filtered.length === 0 && (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textFaint }}>Sin resultados para "{search}"</span>
        </div>
      )}

      {sortedTeams.map((team) => {
        const teamMembers = teamMap.get(team)!;
        const isCollapsed = collapsed.get(team) === true;
        return (
          <div key={team} style={{ borderRadius: t.radius, overflow: 'hidden', border: `1px solid ${t.border}` }}>
            {/* Team header */}
            <button
              onClick={() => toggleCollapse(team)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 14px',
                background: t.surface,
                border: 'none',
                cursor: 'pointer',
                borderBottom: isCollapsed ? 'none' : `1px solid ${t.border}`,
              }}
            >
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text, fontWeight: '600', letterSpacing: 0.4, flex: 1, textAlign: 'left' }}>
                {team.toUpperCase()}
              </span>
              <span style={{
                fontFamily: t.fontMono,
                fontSize: 10,
                color: t.accentInk,
                backgroundColor: t.accent,
                borderRadius: 99,
                padding: '1px 7px',
                fontWeight: '700',
              }}>
                {teamMembers.length}
              </span>
              <I.ChevronD
                size={14}
                color={t.textDim}
                style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
              />
            </button>

            {/* Member rows */}
            {!isCollapsed && teamMembers.map((m) => {
              const isMe = m.aegis_id === currentAegisId;
              const isHovered = hoveredId === m.aegis_id;
              const showConfirm = confirmRemove === m.aegis_id;
              const canPromote = myPerms.canPromoteToAdmin && !isMe && m.role === 'member';
              const canDemote = myPerms.canDemoteAdmin && !isMe && m.role === 'admin';
              const canKick = myPerms.canKickMembers && !isMe && m.role !== 'owner';
              const canAct = (canPromote || canDemote || canKick) && !isMe;

              return (
                <div
                  key={m.aegis_id}
                  onMouseEnter={() => setHoveredId(m.aegis_id)}
                  onMouseLeave={() => { setHoveredId(null); setConfirmRemove(null); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 14px',
                    borderBottom: `1px solid ${t.divider}`,
                    backgroundColor: isHovered ? t.surface2 : 'transparent',
                    transition: 'background-color 0.1s',
                  }}
                >
                  {/* Avatar */}
                  <div style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: avatarBg(m.role, t),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    position: 'relative',
                  }}>
                    <span style={{ fontFamily: t.fontMono, fontSize: 12, color: avatarInk(m.role, t), fontWeight: '700' }}>
                      {m.aegis_id.slice(0, 2).toUpperCase()}
                    </span>
                    {onlineIds.has(m.aegis_id) && (
                      <span
                        aria-label="En línea"
                        style={{
                          position: 'absolute',
                          bottom: 0,
                          right: 0,
                          width: 9,
                          height: 9,
                          borderRadius: '50%',
                          backgroundColor: '#22c55e',
                          border: `2px solid ${t.bg}`,
                          boxSizing: 'border-box',
                        }}
                      />
                    )}
                  </div>

                  {/* Identity */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
                        {m.aegis_id.slice(0, 16)}
                      </span>
                      {/* Role badge */}
                      <span style={{
                        fontFamily: t.fontMono,
                        fontSize: 9,
                        borderRadius: 99,
                        padding: '1px 6px',
                        letterSpacing: 0.5,
                        textTransform: 'uppercase',
                        ...roleBadgeStyle(m.role, t),
                      }}>
                        {m.role}
                      </span>
                      {/* Verified checkmark */}
                      {m.verified && <I.CheckCircle size={13} color={t.accent} />}
                      {/* "Tú" chip */}
                      {isMe && (
                        <span style={{
                          fontFamily: t.font,
                          fontSize: 10,
                          color: t.accentInk,
                          backgroundColor: t.accent,
                          borderRadius: 99,
                          padding: '1px 7px',
                          fontWeight: '600',
                        }}>
                          Tú
                        </span>
                      )}
                    </div>
                    <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim }}>{m.team}</span>
                  </div>

                  {/* Hover actions */}
                  {isHovered && canAct && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {showConfirm ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontFamily: t.font, fontSize: 11, color: t.warn }}>¿Confirmar?</span>
                          <button
                            onClick={() => void handleRemove(m.aegis_id)}
                            style={{ ...actionBtnStyle, color: t.danger }}
                            title="Confirmar eliminación"
                          >
                            <I.Check size={14} color={t.danger} />
                          </button>
                          <button
                            onClick={() => setConfirmRemove(null)}
                            style={{ ...actionBtnStyle }}
                            title="Cancelar"
                          >
                            <I.X size={14} color={t.textDim} />
                          </button>
                        </div>
                      ) : (
                        <>
                          {/* QR code popover */}
                          <button
                            onClick={() => void handleShowQr(m.aegis_id)}
                            style={actionBtnStyle}
                            title="Ver ID como QR"
                          >
                            <I.QR size={16} color={t.textDim} />
                          </button>
                          {/* Promote to admin */}
                          {canPromote && (
                            <button
                              onClick={() => void handleToggleRole(m)}
                              style={actionBtnStyle}
                              title="Ascender a admin"
                            >
                              <I.ShieldCheck size={16} color={t.accent} />
                            </button>
                          )}
                          {/* Demote to member */}
                          {canDemote && (
                            <button
                              onClick={() => void handleToggleRole(m)}
                              style={actionBtnStyle}
                              title="Bajar a miembro"
                            >
                              <I.ShieldOff size={16} color={t.warn} />
                            </button>
                          )}
                          {/* Remove */}
                          {canKick && (
                            <button
                              onClick={() => setConfirmRemove(m.aegis_id)}
                              style={actionBtnStyle}
                              title="Eliminar miembro"
                            >
                              <I.UserMinus size={16} color={t.danger} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* QR popover */}
      {qrPopover && (
        <div
          onClick={() => setQrPopover(null)}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: t.surface,
              borderRadius: t.radius,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              alignItems: 'center',
              maxWidth: 260,
              width: '100%',
            }}
          >
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5 }}>AEGIS ID</span>
            {qrPopover.dataUrl && (
              <img
                src={qrPopover.dataUrl}
                width={180}
                height={180}
                alt="QR code del miembro"
                style={{ borderRadius: 8, border: `1px solid ${t.border}` }}
              />
            )}
            <code style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, wordBreak: 'break-all', textAlign: 'center' }}>
              {qrPopover.aegisId}
            </code>
            <button
              onClick={() => setQrPopover(null)}
              style={{
                padding: '8px 20px',
                backgroundColor: 'transparent',
                border: `1px solid ${t.borderStrong}`,
                borderRadius: t.radiusS,
                cursor: 'pointer',
                fontFamily: t.font,
                fontSize: 13,
                color: t.text,
              }}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AuditLog ─────────────────────────────────────────────────────────────────

type KindFilter = 'all' | 'member' | 'channel' | 'message' | 'device' | 'org';

const KIND_FILTER_LABELS: { id: KindFilter; label: string; prefix: string | null }[] = [
  { id: 'all', label: 'Todos', prefix: null },
  { id: 'member', label: 'Miembros', prefix: 'member.' },
  { id: 'channel', label: 'Canales', prefix: 'channel.' },
  { id: 'message', label: 'Mensajes', prefix: 'message.' },
  { id: 'device', label: 'Dispositivos', prefix: 'device.' },
  { id: 'org', label: 'Org', prefix: 'org.' },
];

function kindIcon(kind: string, t: Theme): React.ReactElement {
  if (kind.startsWith('member.')) return <I.UserIcon size={14} color={t.accent} />;
  if (kind.startsWith('channel.')) return <I.Hash size={14} color={t.textDim} />;
  if (kind.startsWith('message.')) return <I.MessageSquare size={14} color={t.textDim} />;
  if (kind.startsWith('device.')) return <I.Shield size={14} color={t.warn} />;
  if (kind.startsWith('org.')) return <I.Building size={14} color={t.textDim} />;
  return <I.Zap size={14} color={t.textFaint} />;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

interface AuditLogProps {
  orgId: string;
  requesterId: string;
  isOwner: boolean;
  channels: WorkChannel[];
}

function AuditLog({ orgId, requesterId, isOwner, channels }: AuditLogProps) {
  const { t } = useTheme();
  const { auditLog, auditHasMore, auditLoading, auditFilters, fetchAuditPage, setAuditFilters } = useWork();

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [actorInput, setActorInput] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const channelMap = useRef<Map<string, string>>(new Map());
  for (const ch of channels) {
    channelMap.current.set(ch.channelId, ch.name);
  }

  const doFetch = useCallback((kf: KindFilter, actor: string, reset: boolean) => {
    const prefix = KIND_FILTER_LABELS.find((x) => x.id === kf)?.prefix ?? null;
    const kindParam = prefix ?? undefined;
    const actorParam = actor.trim() || undefined;
    if (reset) {
      void fetchAuditPage(orgId, { kind: kindParam, actorId: actorParam });
    } else {
      const oldest = auditLog[auditLog.length - 1]?.createdAt;
      void fetchAuditPage(orgId, { before: oldest, kind: kindParam, actorId: actorParam });
    }
  }, [orgId, auditLog, fetchAuditPage]);

  // Initial load
  useEffect(() => {
    void fetchAuditPage(orgId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  function handleKindFilter(kf: KindFilter) {
    setKindFilter(kf);
    const prefix = KIND_FILTER_LABELS.find((x) => x.id === kf)?.prefix ?? null;
    setAuditFilters({ kind: prefix, actorId: auditFilters.actorId });
    const prefix2 = prefix ?? undefined;
    const actorParam = actorInput.trim() || undefined;
    void fetchAuditPage(orgId, { kind: prefix2, actorId: actorParam });
  }

  function handleActorInput(val: string) {
    setActorInput(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const prefix = KIND_FILTER_LABELS.find((x) => x.id === kindFilter)?.prefix ?? null;
      setAuditFilters({ kind: prefix, actorId: val.trim() || null });
      void fetchAuditPage(orgId, { kind: prefix ?? undefined, actorId: val.trim() || undefined });
    }, 400);
  }

  async function handleExportCsv() {
    try {
      const { useWork: w } = await import('../store/work');
      const identity = (() => {
        const { useIdentity: ui } = require('../store/identity') as { useIdentity: { getState: () => { identity: { signingSecretKeyB64: string; aegisId: string } | null } } };
        return ui.getState().identity;
      })();
      if (!identity) return;
      const nacl = (await import('tweetnacl')).default;
      const { encodeBase64, decodeBase64 } = await import('tweetnacl-util');
      const ts = Date.now();
      const timeBucket = Math.floor(ts / 30_000);
      const message = new TextEncoder().encode(`${orgId}:export_audit:${timeBucket}`);
      const sigBytes = nacl.sign.detached(message, decodeBase64(identity.signingSecretKeyB64));
      const sig = encodeBase64(sigBytes);
      const params = new URLSearchParams({ aegisId: identity.aegisId, sig, ts: String(ts) });
      const res = await fetch(`${SERVER_URL}/work/org/${orgId}/audit/export?${params.toString()}`);
      if (!res.ok) return;
      const csv = await res.text();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${orgId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      void w; // suppress unused warning
    } catch {
      // non-fatal
    }
  }

  const pillBase: CSSProperties = {
    padding: '5px 12px',
    borderRadius: 99,
    fontFamily: t.fontMono,
    fontSize: 10,
    cursor: 'pointer',
    border: 'none',
    letterSpacing: 0.4,
    transition: 'background-color 0.1s, color 0.1s',
  };

  const colHeader: CSSProperties = {
    fontFamily: t.fontMono,
    fontSize: 9,
    color: t.textFaint,
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    padding: '8px 10px',
  };

  if (auditLog.length === 0 && !auditLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Toolbar */}
        <AuditToolbar
          kindFilter={kindFilter}
          actorInput={actorInput}
          isOwner={isOwner}
          t={t}
          pillBase={pillBase}
          onKindFilter={handleKindFilter}
          onActorInput={handleActorInput}
          onExport={() => void handleExportCsv()}
        />
        <div style={{ padding: 40, textAlign: 'center' }}>
          <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>No hay eventos de auditoría aún.</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <AuditToolbar
        kindFilter={kindFilter}
        actorInput={actorInput}
        isOwner={isOwner}
        t={t}
        pillBase={pillBase}
        onKindFilter={handleKindFilter}
        onActorInput={handleActorInput}
        onExport={() => void handleExportCsv()}
      />

      {/* Table header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '28px 1fr 2fr 1fr 1fr 60px',
        borderBottom: `1px solid ${t.border}`,
        backgroundColor: t.surface,
      }}>
        {['', 'Actor', 'Acción', 'Target', 'Canal', 'Tiempo'].map((h, i) => (
          <span key={i} style={colHeader}>{h}</span>
        ))}
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {auditLog.map((entry) => (
          <AuditRow
            key={entry.id}
            entry={entry}
            t={t}
            channelMap={channelMap.current}
            expanded={expandedId === entry.id}
            onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
          />
        ))}

        {/* Load more */}
        {auditHasMore && (
          <div style={{ padding: '14px 0', textAlign: 'center' }}>
            {auditLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <I.Loader size={14} color={t.textDim} style={{ animation: 'spin 1s linear infinite' }} />
                <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim }}>Cargando…</span>
              </div>
            ) : (
              <button
                onClick={() => doFetch(kindFilter, actorInput, false)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: t.fontMono,
                  fontSize: 11,
                  color: t.accent,
                  letterSpacing: 0.4,
                }}
              >
                Cargar más
              </button>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

interface AuditToolbarProps {
  kindFilter: KindFilter;
  actorInput: string;
  isOwner: boolean;
  t: Theme;
  pillBase: CSSProperties;
  onKindFilter: (kf: KindFilter) => void;
  onActorInput: (val: string) => void;
  onExport: () => void;
}

function AuditToolbar({ kindFilter, actorInput, isOwner, t, pillBase, onKindFilter, onActorInput, onExport }: AuditToolbarProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 14px',
      borderBottom: `1px solid ${t.divider}`,
      flexWrap: 'wrap',
    }}>
      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
        {KIND_FILTER_LABELS.map((item) => (
          <button
            key={item.id}
            onClick={() => onKindFilter(item.id)}
            style={{
              ...pillBase,
              color: kindFilter === item.id ? t.accentInk : t.textDim,
              backgroundColor: kindFilter === item.id ? t.accent : t.surface2,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Actor search */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <I.Search size={12} color={t.textFaint} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
        <input
          value={actorInput}
          onChange={(e) => onActorInput(e.target.value)}
          placeholder="Actor ID…"
          style={{
            padding: '7px 10px 7px 26px',
            fontFamily: t.fontMono,
            fontSize: 11,
            color: t.text,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            outline: 'none',
            width: 140,
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Export CSV (owner only) */}
      {isOwner && (
        <button
          onClick={onExport}
          title="Exportar CSV"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '7px 12px',
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.textDim,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            cursor: 'pointer',
            letterSpacing: 0.4,
            flexShrink: 0,
          }}
        >
          <I.Download size={13} color={t.textDim} />
          CSV
        </button>
      )}
    </div>
  );
}

interface AuditRowProps {
  entry: WorkAuditEntry;
  t: Theme;
  channelMap: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
}

function AuditRow({ entry, t, channelMap, expanded, onToggle }: AuditRowProps) {
  const [hovered, setHovered] = useState(false);

  const channelName = entry.channelId ? (channelMap.get(entry.channelId) ?? null) : null;
  const isoTs = new Date(entry.createdAt).toISOString();

  const cellStyle: CSSProperties = {
    padding: '9px 10px',
    fontFamily: t.font,
    fontSize: 12,
    color: t.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'flex',
    alignItems: 'center',
  };

  const dimStyle: CSSProperties = { ...cellStyle, color: t.textDim };
  const monoStyle: CSSProperties = { ...cellStyle, fontFamily: t.fontMono, fontSize: 11 };

  return (
    <div>
      <div
        onClick={onToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'grid',
          gridTemplateColumns: '28px 1fr 2fr 1fr 1fr 60px',
          borderBottom: `1px solid ${t.divider}`,
          backgroundColor: hovered ? t.surface2 : 'transparent',
          cursor: 'pointer',
          transition: 'background-color 0.1s',
        }}
      >
        {/* Icon */}
        <div style={{ ...cellStyle, justifyContent: 'center', padding: '9px 4px' }}>
          {kindIcon(entry.kind, t)}
        </div>

        {/* Actor */}
        <div style={monoStyle}>
          {entry.actorId
            ? <span style={{ color: t.accent }}>@{entry.actorId.slice(0, 10)}</span>
            : <span style={{ color: t.textFaint }}>—</span>
          }
        </div>

        {/* Acción */}
        <div style={cellStyle}>{entry.message}</div>

        {/* Target */}
        <div style={monoStyle}>
          {entry.targetId
            ? <span style={{ color: t.textDim }}>@{entry.targetId.slice(0, 10)}</span>
            : <span style={{ color: t.textFaint }}>—</span>
          }
        </div>

        {/* Canal */}
        <div style={dimStyle}>
          {channelName
            ? <span style={{ fontFamily: t.fontMono, fontSize: 11 }}>#{channelName}</span>
            : <span style={{ color: t.textFaint }}>—</span>
          }
        </div>

        {/* Tiempo */}
        <div style={{ ...dimStyle, fontFamily: t.fontMono, fontSize: 10, justifyContent: 'flex-end', paddingRight: 12 }}>
          <span title={isoTs}>{relativeTime(entry.createdAt)}</span>
        </div>
      </div>

      {/* Expanded metadata panel */}
      {expanded && entry.metadata && (
        <div style={{
          backgroundColor: '#0a0e0d',
          borderBottom: `1px solid ${t.border}`,
          padding: '10px 14px',
        }}>
          <pre style={{
            fontFamily: t.fontMono,
            fontSize: 11,
            color: t.accent,
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            borderRadius: 6,
            lineHeight: 1.6,
          }}>
            {JSON.stringify(entry.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
  onJoinSuccess?: () => void;
}

const inputStyle = (t: { font: string; text: string; bg: string; border: string; radiusS: number; }): CSSProperties => ({
  width: '100%', padding: 12, fontFamily: t.font, fontSize: 14,
  color: t.text, backgroundColor: t.bg,
  border: `1px solid ${t.border}`, borderRadius: t.radiusS,
  boxSizing: 'border-box',
});

export function WorkDashboard({ onBack, onJoinSuccess }: Props) {
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);
  const aegisId = identity?.aegisId ?? '';
  const { org, members, devices, channels, loading, fetchOrg, fetchChannels, createOrg, createInvite, revokeDevice } = useWork();
  const currentUserRole = members.find((m) => m.aegis_id === aegisId)?.role ?? null;
  const onlineIds = useWorkPresence((s) => s.onlineIds);

  const [activeNav, setActiveNav] = useState<NavItem>('overview');
  const [setupModal, setSetupModal] = useState(false);
  const [joinModal, setJoinModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);
  const [orgNameInput, setOrgNameInput] = useState('');
  const [joinTokenInput, setJoinTokenInput] = useState('');
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('aegis.work.orgId');
    if (!stored || !aegisId) return;

    void fetchOrg(stored, aegisId);

    const sock = getSocket();
    if (!sock) return;

    sock.emit('work:join', { orgId: stored, aegisId });

    const handleSync = (data: { onlineIds: string[] }) => {
      useWorkPresence.getState().setOnline(data.onlineIds);
    };
    const handleJoin = (data: { aegisId: string }) => {
      useWorkPresence.getState().addOnline(data.aegisId);
    };
    const handleLeave = (data: { aegisId: string }) => {
      useWorkPresence.getState().removeOnline(data.aegisId);
    };

    sock.on('work:presence_sync', handleSync);
    sock.on('work:presence_join', handleJoin);
    sock.on('work:presence_leave', handleLeave);

    return () => {
      sock.off('work:presence_sync', handleSync);
      sock.off('work:presence_join', handleJoin);
      sock.off('work:presence_leave', handleLeave);
      useWorkPresence.getState().clearPresence();
    };
  }, [aegisId]);

  useEffect(() => {
    if (!pendingInviteToken) { setQrDataUrl(null); return; }
    const link = `aegislink://work/join?token=${pendingInviteToken}`;
    QRCode.toDataURL(link, { width: 200, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [pendingInviteToken]);

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
      await fetchOrg(orgId, aegisId);
      await fetchChannels(orgId);
      onJoinSuccess?.();
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
        <MemberDirectory
          members={members}
          currentAegisId={aegisId}
          orgId={org?.orgId ?? ''}
          currentUserRole={currentUserRole}
          onlineIds={onlineIds}
        />
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
        <AuditLog
          orgId={org?.orgId ?? ''}
          requesterId={aegisId}
          isOwner={currentUserRole === 'owner'}
          channels={channels}
        />
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
                <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5, display: 'block' }}>INVITE LINK</span>
                {qrDataUrl && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
                    <img
                      src={qrDataUrl}
                      width={200}
                      height={200}
                      alt="Invite QR code"
                      style={{ borderRadius: 8, border: `1px solid ${t.border}` }}
                    />
                  </div>
                )}
                <div style={{ padding: 12, backgroundColor: t.bg, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, wordBreak: 'break-all' }}>
                  <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, display: 'block', marginBottom: 4 }}>TOKEN</span>
                  <code style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent }}>{pendingInviteToken}</code>
                </div>
                <button
                  onClick={() => {
                    const link = `aegislink://work/join?token=${pendingInviteToken}`;
                    navigator.clipboard.writeText(link).catch(() => {});
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 2000);
                  }}
                  style={{ padding: '10px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: t.accentInk }}
                >
                  {linkCopied ? 'Copied!' : 'Copiar link'}
                </button>
                <button
                  onClick={() => { setPendingInviteToken(null); setQrDataUrl(null); setLinkCopied(false); setInviteModal(false); }}
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
