import React, { useState, useEffect } from 'react';
import { vault } from './theme/vault';
import TitleBar from './views/TitleBar';
import Onboarding from './views/Onboarding';
import LinkQR from './views/LinkQR';
import Home from './views/Home';
import { loadIdentity } from './crypto/identity.js';
import { initDB, loadContacts } from './db/local.js';
import { connectToRelay } from './socket/client.js';
import { useStore } from './store/index.js';

const t = vault;

export default function App() {
  // 'loading' | 'onboarding' | 'link-qr' | 'home'
  const [view, setView] = useState('loading');
  const setIdentity = useStore((s) => s.setIdentity);
  const addContact = useStore((s) => s.addContact);

  useEffect(() => {
    async function bootstrap() {
      try {
        await initDB();
        const identity = await loadIdentity();
        if (!identity) {
          setView('onboarding');
          return;
        }
        setIdentity(identity);
        // Load persisted contacts
        const contacts = await loadContacts();
        for (const c of contacts) addContact(c);
        // Connect to relay
        connectToRelay(identity);
        setView('home');
      } catch {
        // SecureStore unavailable (e.g. outside Electron) — go to onboarding
        setView('onboarding');
      }
    }
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleNewIdentity(identity) {
    setIdentity(identity);
    connectToRelay(identity);
    setView('home');
  }

  async function handleRestore(identity) {
    setIdentity(identity);
    connectToRelay(identity);
    setView('home');
  }

  async function handleLinkApproved(identity) {
    setIdentity(identity);
    // Load contacts from DB in case they were synced
    try {
      const contacts = await loadContacts();
      for (const c of contacts) addContact(c);
    } catch {
      // DB may not have contacts yet — fine
    }
    connectToRelay(identity);
    setView('home');
  }

  function renderView() {
    switch (view) {
      case 'loading':
        return (
          <div
            style={{
              flex: 1,
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: t.bg,
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke={t.accent}
              strokeWidth="2"
              strokeLinecap="round"
              style={{ animation: 'spin 1s linear infinite' }}
            >
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textMuted, letterSpacing: '0.08em' }}>
              INICIANDO…
            </span>
          </div>
        );

      case 'link-qr':
        return (
          <LinkQR
            t={t}
            onApproved={handleLinkApproved}
            onTimeout={() => setView('onboarding')}
            onBack={() => setView('onboarding')}
          />
        );

      case 'home':
        return <Home t={t} onLinkNew={() => setView('link-qr')} />;

      default:
        return (
          <Onboarding
            t={t}
            onLinkMobile={() => setView('link-qr')}
            onNewIdentity={handleNewIdentity}
            onRestore={handleRestore}
          />
        );
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        background: t.bg,
        color: t.text,
        fontFamily: t.font,
        overflow: 'hidden',
      }}
    >
      <TitleBar t={t} />
      <div style={{ flex: 1, overflow: 'hidden' }}>{renderView()}</div>
    </div>
  );
}
