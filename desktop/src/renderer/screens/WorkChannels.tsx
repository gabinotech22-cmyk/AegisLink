import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useWork } from '../store/work';
import type { WorkChannel } from '../store/work';
import { useIdentity } from '../store/identity';

interface Props {
  onBack: () => void;
  onOpenAdmin: () => void;
  onCreateOrg?: () => void;
  onOpenChannel?: (channel: WorkChannel) => void;
}

export function WorkChannels({ onBack, onOpenAdmin, onCreateOrg, onOpenChannel }: Props) {
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);
  const aegisId = identity?.aegisId ?? '';
  const { org, members, channels, fetchChannels, createChannel } = useWork();

  const [newChannelModal, setNewChannelModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const isAdmin = org?.adminId === aegisId;

  useEffect(() => {
    if (org?.orgId) void fetchChannels(org.orgId);
  }, [org?.orgId]);

  async function handleCreateChannel() {
    const name = newChannelName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name || !org || !aegisId) return;
    await createChannel(org.orgId, name, aegisId, false);
    setNewChannelModal(false);
    setNewChannelName('');
  }

  const selectedChannel = channels.find((c) => c.channelId === selectedChannelId);

  const sidebarStyle: CSSProperties = {
    width: 240,
    backgroundColor: t.surface,
    borderRight: `1px solid ${t.border}`,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  };

  const headerStyle: CSSProperties = {
    padding: '14px 16px',
    borderBottom: `1px solid ${t.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  };

  const sectionLabelStyle: CSSProperties = {
    fontFamily: t.fontMono,
    fontSize: 10,
    color: t.textFaint,
    letterSpacing: 1.2,
    padding: '14px 16px 6px',
  };

  const channelRowStyle = (active: boolean): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 16px',
    cursor: 'pointer',
    backgroundColor: active ? t.accentInk : 'transparent',
    borderRadius: 6,
    margin: '1px 6px',
  });

  return (
    <div style={{ display: 'flex', height: '100%', backgroundColor: t.bg }}>
      {/* Sidebar */}
      <div style={sidebarStyle}>
        {/* Org header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: t.accentDeep, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <I.Shield size={16} color={t.accent} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: t.fontDisplay, fontSize: 13, fontWeight: 700, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {org?.name ?? 'Workspace'}
              </div>
              <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, letterSpacing: 1 }}>WORK</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {isAdmin && (
              <button
                onClick={onOpenAdmin}
                title="Admin panel"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 4, color: t.textDim }}
              >
                <I.Shield size={16} color={t.textDim} />
              </button>
            )}
            <button
              onClick={onBack}
              title="Cerrar workspace"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 4 }}
            >
              <I.X size={16} color={t.textDim} />
            </button>
          </div>
        </div>

        {/* Channels */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 12 }}>
            <span style={sectionLabelStyle}>CANALES</span>
            {isAdmin && (
              <button
                onClick={() => setNewChannelModal(true)}
                title="Nuevo canal"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: t.textDim }}
              >
                <I.Plus size={13} color={t.textDim} />
              </button>
            )}
          </div>

          {channels.length === 0 ? (
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, padding: '6px 16px', display: 'block' }}>
              Sin canales
            </span>
          ) : (
            channels.map((ch) => (
              <div
                key={ch.channelId}
                style={channelRowStyle(selectedChannelId === ch.channelId)}
                onClick={() => {
                  setSelectedChannelId(ch.channelId);
                  if (onOpenChannel) onOpenChannel(ch);
                }}
              >
                <span style={{ fontFamily: t.fontMono, fontSize: 13, color: t.textDim }}>#</span>
                <span style={{ fontFamily: t.font, fontSize: 13, color: selectedChannelId === ch.channelId ? t.accent : t.text, flex: 1 }}>
                  {ch.name}
                </span>
                {ch.isAnnouncements && (
                  <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, letterSpacing: 0.5 }}>ANUNCIOS</span>
                )}
              </div>
            ))
          )}

          {/* DMs */}
          <span style={sectionLabelStyle}>MENSAJES DIRECTOS</span>
          {members.filter((m) => m.aegis_id !== aegisId).length === 0 ? (
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, padding: '6px 16px', display: 'block' }}>
              Sin miembros
            </span>
          ) : (
            members
              .filter((m) => m.aegis_id !== aegisId)
              .map((m) => (
                <div key={m.aegis_id} style={channelRowStyle(false)}>
                  <div style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.text }}>{m.aegis_id.slice(0, 2).toUpperCase()}</span>
                  </div>
                  <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.aegis_id.slice(0, 10)}…
                  </span>
                </div>
              ))
          )}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: t.bg }}>
        {selectedChannel ? (
          <>
            <span style={{ fontFamily: t.fontMono, fontSize: 22, color: t.textDim }}>#</span>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: 700, color: t.text }}>{selectedChannel.name}</span>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>
              {selectedChannel.isAnnouncements ? 'Solo admins pueden escribir' : 'Canal del equipo'}
            </span>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, marginTop: 8 }}>
              El chat de canales llega en la próxima iteración
            </span>
          </>
        ) : (
          <>
            <I.Shield size={40} color={t.textFaint} />
            <span style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: 600, color: t.text }}>
              {org?.name ?? 'Workspace'}
            </span>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', maxWidth: 280, lineHeight: '20px' }}>
              Selecciona un canal de la barra lateral para empezar a comunicarte con tu equipo.
            </span>
          </>
        )}
      </div>

      {/* New channel modal */}
      {newChannelModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 24, boxSizing: 'border-box' }}>
          <div style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: 600, color: t.text }}>Nuevo canal</span>
            <input
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder="nombre-del-canal"
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateChannel(); }}
              autoFocus
              style={{ width: '100%', padding: 12, fontFamily: t.font, fontSize: 14, color: t.text, backgroundColor: t.bg, border: `1px solid ${t.border}`, borderRadius: t.radiusS, boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { setNewChannelModal(false); setNewChannelName(''); }}
                style={{ flex: 1, padding: '11px 0', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', background: 'none', fontFamily: t.font, color: t.text }}
              >
                Cancelar
              </button>
              <button
                onClick={() => void handleCreateChannel()}
                style={{ flex: 1, padding: '11px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: 700, color: t.accentInk }}
              >
                Crear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
