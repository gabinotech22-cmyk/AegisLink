import { useMemo, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { useWork } from '../store/work';
import type { WorkMember } from '../store/work';
import { useWorkPresence } from '../store/workPresence';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { SERVER_URL } from '../config';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  onStartDM: (aegisId: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORK_ACCENT = '#6366f1';

function avatarColor(aegisId: string): string {
  return '#' + aegisId.replace(/-/g, '').slice(0, 6);
}

function initials(aegisId: string): string {
  return aegisId.replace(/-/g, '').slice(0, 2).toUpperCase();
}

// ─── Member row ───────────────────────────────────────────────────────────────

function MemberRow({
  t,
  member,
  isOnline,
  isLoading,
  onDM,
}: {
  t: Theme;
  member: WorkMember;
  isOnline: boolean;
  isLoading: boolean;
  onDM: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const bg = avatarColor(member.aegis_id);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        borderBottom: `1px solid rgba(255,255,255,0.05)`,
        backgroundColor: hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
        transition: 'background-color 0.1s',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Avatar */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#fff' }}>
          {initials(member.aegis_id)}
        </span>
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: 12,
              color: t.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {member.aegis_id.slice(0, 12)}…
          </span>
          {/* Presence dot */}
          <div
            title={isOnline ? 'Online' : 'Offline'}
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: isOnline ? '#22c55e' : t.textFaint,
              flexShrink: 0,
            }}
          />
        </div>
        {/* Role badge */}
        <span
          style={{
            fontFamily: 'monospace',
            fontSize: 9,
            letterSpacing: 0.8,
            padding: '2px 5px',
            borderRadius: 4,
            backgroundColor: member.role === 'admin' ? 'rgba(99,102,241,0.18)' : t.surface2,
            border: `1px solid ${member.role === 'admin' ? 'rgba(99,102,241,0.45)' : t.border}`,
            color: member.role === 'admin' ? '#818cf8' : t.textFaint,
          }}
        >
          {member.role === 'admin' ? 'ADMIN' : 'MEMBER'}
        </span>
      </div>

      {/* DM button */}
      <button
        onClick={onDM}
        disabled={isLoading}
        aria-label={`Enviar DM a ${member.aegis_id.slice(0, 12)}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '6px 10px',
          backgroundColor: isLoading ? t.surface2 : WORK_ACCENT,
          border: 'none',
          borderRadius: 7,
          cursor: isLoading ? 'default' : 'pointer',
          flexShrink: 0,
          transition: 'opacity 0.1s',
          opacity: isLoading ? 0.5 : 1,
        }}
      >
        <span
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            fontWeight: 700,
            color: '#fff',
          }}
        >
          DM
        </span>
      </button>
    </div>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function WorkDirectory({ onClose, onStartDM }: Props) {
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);
  const members = useWork((s) => s.members);
  const onlineIds = useWorkPresence((s) => s.onlineIds);
  const contacts = useContacts((s) => s.contacts);
  const [query, setQuery] = useState('');
  const [loadingDM, setLoadingDM] = useState<string | null>(null);

  const ownId = identity?.aegisId ?? '';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((m) => m.aegis_id !== ownId)
      .filter((m) => !q || m.aegis_id.toLowerCase().includes(q));
  }, [members, ownId, query]);

  async function handleDM(aegisId: string) {
    if (loadingDM) return;
    setLoadingDM(aegisId);
    try {
      const existing = contacts.find((c) => c.aegisId === aegisId);
      if (existing) {
        onStartDM(aegisId);
        return;
      }
      // Fetch identity from relay then add as contact
      try {
        const { useContacts: _useContacts } = await import('../store/contacts');
        await _useContacts.getState().addByAegisId(aegisId);
        onStartDM(aegisId);
      } catch {
        // Show a simple browser alert as fallback — we are in desktop Electron renderer
        // eslint-disable-next-line no-alert
        alert(`No se pudo obtener la clave de ${aegisId.slice(0, 12)}…\nPuedes añadirlo manualmente por AegisID.`);
      }
    } finally {
      setLoadingDM(null);
    }
  }

  return (
    /* Overlay */
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Panel */}
      <div
        style={{
          width: 440,
          maxWidth: '90vw',
          maxHeight: '80vh',
          backgroundColor: t.surface,
          borderRadius: 14,
          border: `1px solid ${WORK_ACCENT}44`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px 12px',
            borderBottom: `1px solid ${t.border}`,
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <I.Users size={18} color={WORK_ACCENT} />
            <span
              style={{
                fontFamily: t.fontDisplay,
                fontSize: 16,
                fontWeight: 700,
                color: t.text,
              }}
            >
              Directorio del equipo
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar directorio"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              padding: 4,
              borderRadius: 6,
            }}
          >
            <I.X size={18} color={t.textDim} />
          </button>
        </div>

        {/* Search */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '10px 12px',
            backgroundColor: t.surface2,
            borderRadius: 20,
            padding: '8px 12px',
            flexShrink: 0,
          }}
        >
          <I.Search size={13} color={t.textFaint} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por AegisID…"
            aria-label="Buscar miembros"
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              fontFamily: t.font,
              fontSize: 13,
              color: t.text,
            }}
          />
          {query.length > 0 && (
            <button
              onClick={() => setQuery('')}
              aria-label="Limpiar búsqueda"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
            >
              <I.X size={12} color={t.textFaint} />
            </button>
          )}
        </div>

        {/* Member count */}
        <div style={{ padding: '0 16px 6px', flexShrink: 0 }}>
          <span
            style={{
              fontFamily: t.fontMono,
              fontSize: 9,
              letterSpacing: 1,
              color: WORK_ACCENT,
              opacity: 0.7,
            }}
          >
            {filtered.length} MIEMBRO{filtered.length !== 1 ? 'S' : ''}
          </span>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 32px',
                gap: 10,
              }}
            >
              <I.Users size={32} color={t.textFaint} />
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center' }}>
                {query.trim() ? 'Sin resultados para tu búsqueda.' : 'Este workspace no tiene otros miembros aún.'}
              </span>
            </div>
          ) : (
            filtered.map((m) => (
              <MemberRow
                key={m.aegis_id}
                t={t}
                member={m}
                isOnline={onlineIds.has(m.aegis_id)}
                isLoading={loadingDM === m.aegis_id}
                onDM={() => void handleDM(m.aegis_id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
