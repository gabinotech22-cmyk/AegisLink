import React, { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import Chat from './Chat';
import Settings from './Settings';
import Devices from './Devices';
import WorkDashboard from './WorkDashboard';
import Profile from './Profile';
import ContactDetail from './ContactDetail';
import SearchOverlay from './SearchOverlay';
import Groups from './Groups';
import GroupChat from './GroupChat';
import Polls from './Polls';

export default function Home({ t, onLinkNew }) {
  // null | 'settings' | 'devices' | 'work' | 'profile' | 'contact-detail' | 'search' | 'groups' | 'group-chat' | 'polls'
  const [panel, setPanel] = useState(null);
  const [activeGroupId, setActiveGroupId] = useState(null);

  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setPanel((p) => (p === 'search' ? null : 'search'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', position: 'relative' }}>
      <Sidebar
        t={t}
        onOpenSettings={() => setPanel('settings')}
        onOpenDevices={() => setPanel('devices')}
        onOpenWork={() => setPanel('work')}
        onOpenProfile={() => setPanel('profile')}
        onOpenSearch={() => setPanel('search')}
        onSelectContact={() => setPanel('contact-detail')}
        onOpenGroups={() => setPanel('groups')}
      />

      {panel === 'groups' ? (
        <Groups
          t={t}
          onOpenGroup={(id) => {
            setActiveGroupId(id);
            setPanel('group-chat');
          }}
          onBack={() => setPanel(null)}
        />
      ) : panel === 'group-chat' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <GroupChat
            t={t}
            groupId={activeGroupId}
            onBack={() => setPanel('groups')}
          />
          <div
            style={{
              padding: '6px 18px',
              background: t.surface,
              borderTop: `1px solid ${t.border}`,
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <button
              onClick={() => setPanel('polls')}
              style={{
                background: 'none',
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusS,
                color: t.textMuted,
                fontFamily: t.font,
                fontSize: 11,
                padding: '4px 12px',
                cursor: 'pointer',
              }}
            >
              📊 Encuestas
            </button>
          </div>
        </div>
      ) : panel === 'polls' ? (
        <Polls
          t={t}
          groupId={activeGroupId}
          onBack={() => setPanel('group-chat')}
        />
      ) : panel === 'work' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            style={{
              padding: '10px 18px',
              background: t.surface,
              borderBottom: `1px solid ${t.border}`,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => setPanel(null)}
              style={{
                background: 'none',
                border: 'none',
                color: t.textMuted,
                fontFamily: t.font,
                fontSize: 13,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: 0,
              }}
            >
              ← Volver al chat
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <WorkDashboard t={t} />
          </div>
        </div>
      ) : (
        <Chat t={t} />
      )}

      {panel === 'settings' && (
        <Settings t={t} onClose={() => setPanel(null)} />
      )}

      {panel === 'devices' && (
        <Devices
          t={t}
          onClose={() => setPanel(null)}
          onLinkNew={() => {
            setPanel(null);
            onLinkNew?.();
          }}
        />
      )}

      {panel === 'profile' && (
        <Profile
          t={t}
          onClose={() => setPanel(null)}
          onDevices={() => setPanel('devices')}
          onPanic={() => setPanel('settings')}
        />
      )}

      {panel === 'contact-detail' && (
        <ContactDetail
          t={t}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'search' && (
        <SearchOverlay
          t={t}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
