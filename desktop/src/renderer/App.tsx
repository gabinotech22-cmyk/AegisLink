import './crypto/ipc-types';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import type { Theme } from './theme/vault';
import { SplashScreen } from './screens/Splash';
import { EntryScreen } from './screens/Entry';
import { OnboardingScreen } from './screens/Onboarding';
import { HomeScreen } from './screens/Home';
import { GroupsScreen } from './screens/Groups';
import { VerifyScreen } from './screens/Verify';
import { PrivacyScreen } from './screens/Privacy';
import { ChatScreen } from './screens/Chat';
import { GroupChatScreen } from './screens/GroupChat';
import { AddContactScreen } from './screens/AddContact';
import { ContactsScreen } from './screens/Contacts';
import { ContactDetailScreen } from './screens/ContactDetail';
import { ProfileScreen } from './screens/Profile';
import { NotificationsScreen } from './screens/Notifications';
import { SearchScreen } from './screens/Search';
import { ScanQRScreen } from './screens/ScanQR';
import { InviteAddScreen } from './screens/InviteAdd';
import { BackupScreen } from './screens/Backup';
import { DevicesScreen } from './screens/Devices';
import { LockConfigScreen } from './screens/LockConfig';
import { LockSettingsScreen } from './screens/LockSettings';
import { LockScreen } from './screens/Lock';
import { PanicScreen } from './screens/Panic';
import { EphemeralScreen } from './screens/Ephemeral';
import { DataExportScreen } from './screens/DataExport';
import { AttachSheetScreen } from './screens/AttachSheet';
import { VoiceRecorderScreen } from './screens/VoiceRecorder';
import { ViewOnceScreen } from './screens/ViewOnce';
import { ViewOnceSendScreen } from './screens/ViewOnceSend';
import { ScheduledScreen } from './screens/Scheduled';
import { LocationScreen } from './screens/Location';
import { GroupAdminScreen } from './screens/GroupAdmin';
import { PollScreen } from './screens/Poll';
import { FirstContactScreen } from './screens/FirstContact';
import { AppIconScreen } from './screens/AppIcon';
import { WorkDashboard } from './screens/WorkDashboard';
import { SubscriptionScreen } from './screens/Subscription';
import { WorkGenerationScreen } from './screens/WorkGeneration';
import { CallScreen } from './screens/Call';
import { IncomingCallScreen } from './screens/IncomingCall';
import { NetworkErrorScreen } from './screens/NetworkError';
import { useIdentity } from './store/identity';
import { usePreferences } from './store/preferences';
import { useCall } from './store/call';
import { useConnection } from './store/connection';
import { connect as connectSocket, disconnect as disconnectSocket } from './socket/client';
import { attachCallHandlers, acceptCall, endCall } from './socket/calls';
import { setNotificationOpenChatHandler } from './notifications/push';
import { Sidebar } from './components/Sidebar';
import { AegisMark } from './components/AegisMark';
import type { Tab } from './components/TabBar';
import type { StoredContact, StoredGroup } from './db/local';

// ─── PushRoute — mirrors mobile/App.tsx exactly ──────────────────────────────
type PushRoute =
  | { name: 'chat'; contact: StoredContact }
  | { name: 'contact'; contact: StoredContact; keyChanged?: boolean }
  | { name: 'add' }
  | { name: 'scan' }
  | { name: 'invite' }
  | { name: 'profile' }
  | { name: 'notifs' }
  | { name: 'backup' }
  | { name: 'devices' }
  | { name: 'lockConfig' }
  | { name: 'lock' }
  | { name: 'panic' }
  | { name: 'ephemeral' }
  | { name: 'export' }
  | { name: 'attach'; contact: StoredContact }
  | { name: 'voice'; contact: StoredContact }
  | { name: 'viewonce'; contact: StoredContact; mediaUri?: string; messageId?: string }
  | { name: 'viewoncesend'; contact: StoredContact }
  | { name: 'scheduled'; contact?: StoredContact }
  | { name: 'location'; contact: StoredContact }
  | { name: 'search' }
  | { name: 'groupadmin'; group: StoredGroup }
  | { name: 'groupChat'; group: StoredGroup }
  | { name: 'poll'; group?: StoredGroup }
  | { name: 'firstContact'; contact: StoredContact }
  | { name: 'contacts' }
  | { name: 'appIcon' }
  | { name: 'workDashboard' }
  | { name: 'subscription' }
  | { name: 'lockSettings' }
  | { name: 'workGeneration' };

// ─── Placeholder — used for screens not yet ported to desktop ────────────────
function PlaceholderScreen({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, color: '#e8ede9', background: '#0a0e0d', height: '100%' }}>
      <span style={{ fontSize: 18, opacity: 0.6 }}>{name}</span>
      <button
        onClick={onBack}
        style={{ padding: '8px 24px', background: '#1e4a3a', color: '#e8ede9', border: 'none', borderRadius: 8, cursor: 'pointer' }}
      >
        Back
      </button>
    </div>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────
function Shell() {
  const { t } = useTheme();
  const { identity, status, hydrated, hydrate } = useIdentity();
  const hydratePrefs = usePreferences((s) => s.hydrate);
  const appLockEnabled = usePreferences((s) => s.appLockEnabled);
  const lockTimeoutMin = usePreferences((s) => s.lockTimeoutMin);
  const hideRecents = usePreferences((s) => s.hideRecents);

  const activeProfile = useIdentity((s) => s.activeProfile);
  const [tab, setTab] = useState<Tab>('home');
  const [stack, setStack] = useState<PushRoute[]>([]);
  const [showSplash, setShowSplash] = useState(true);
  const [showEntry, setShowEntry] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  const [onboardingRestore, setOnboardingRestore] = useState(false);
  const [onboardingMode, setOnboardingMode] = useState<'generate' | 'restore'>('generate');
  const [netError, setNetError] = useState(false);
  const [appLocked, setAppLocked] = useState(false);
  const [isBackgroundShieldActive, setIsBackgroundShieldActive] = useState(false);

  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  // Refs so callbacks never go stale.
  const identityRef = useRef(identity);
  useEffect(() => { identityRef.current = identity; }, [identity]);
  const hydratedRef = useRef(hydrated);
  useEffect(() => { hydratedRef.current = hydrated; }, [hydrated]);
  const splashTimerFiredRef = useRef(false);

  // Stable callback — never recreated, so Splash's timer never resets on re-render.
  // If hydration is already done when the timer fires → transition immediately.
  // Otherwise, just flag and let the effect below handle it when hydration completes.
  const handleSplashDone = useCallback(() => {
    splashTimerFiredRef.current = true;
    if (hydratedRef.current) {
      setShowSplash(false);
      if (!identityRef.current) setShowEntry(true);
    }
  }, []);

  // When hydration completes AFTER the splash timer already fired → proceed now.
  useEffect(() => {
    if (splashTimerFiredRef.current && hydrated && showSplash) {
      setShowSplash(false);
      if (!identity) setShowEntry(true);
    }
  }, [hydrated, identity, showSplash]);

  const netTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBgTimeRef = useRef<number | null>(null);
  const didColdLockRef = useRef(false);
  const online = useConnection((s) => s.online);

  // ── Hydrate stores on mount ─────────────────────────────────────────────────
  useEffect(() => {
    void hydrate();
    void hydratePrefs();
  }, [hydrate, hydratePrefs]);

  // ── Sync tab to active profile ──────────────────────────────────────────────
  useEffect(() => {
    if (activeProfile === 'work' && tab === 'home') setTab('dashboard');
    if (activeProfile === 'personal' && tab === 'dashboard') setTab('home');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile]);

  // ── Determine onboarding state ──────────────────────────────────────────────
  useEffect(() => {
    if (!hydrated) return;
    if (showOnboarding === null) {
      if (!identity) {
        // Will show Entry after Splash, so mark as "not yet decided"
        // showOnboarding stays null until user picks an option from Entry
        setShowOnboarding(false);
      } else {
        setShowOnboarding(false);
      }
    } else if (showOnboarding === false && !identity && !showSplash && !showEntry) {
      // Identity was wiped mid-session — send back to Entry
      setShowEntry(true);
    }
  }, [hydrated, identity, showOnboarding, showSplash, showEntry]);

  // ── Cold-start app lock ─────────────────────────────────────────────────────
  useEffect(() => {
    if (identity && status === 'ready' && appLockEnabled && !didColdLockRef.current) {
      didColdLockRef.current = true;
      setAppLocked(true);
    }
    if (!identity) {
      didColdLockRef.current = false;
      setAppLocked(false);
    }
  }, [identity, status, appLockEnabled]);

  // ── Visibility-based lock enforcement (desktop equiv. of AppState) ──────────
  useEffect(() => {
    if (!appLockEnabled || !identity) return;
    const handler = () => {
      if (document.hidden) {
        lastBgTimeRef.current = Date.now();
      } else {
        const bg = lastBgTimeRef.current;
        if (bg !== null) {
          const elapsedMin = (Date.now() - bg) / 60000;
          if (elapsedMin >= lockTimeoutMin) {
            setAppLocked(true);
          }
          lastBgTimeRef.current = null;
        }
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [appLockEnabled, lockTimeoutMin, identity]);

  // Background privacy shield disabled on desktop — visibilitychange fires on
  // every window switch, which would black out the app constantly.

  // ── Scheduled message runner (foreground) ───────────────────────────────────
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    void import('./store/messages').then(({ useMessages }) => {
      interval = setInterval(() => {
        useMessages.getState().pruneExpired();
      }, 1000);
    });
    return () => clearInterval(interval);
  }, []);

  // ── Network error screen after 5s offline ───────────────────────────────────
  useEffect(() => {
    if (!identity) return;
    if (!online) {
      netTimer.current = setTimeout(() => setNetError(true), 5000);
    } else {
      if (netTimer.current) clearTimeout(netTimer.current);
      setNetError(false);
    }
    return () => { if (netTimer.current) clearTimeout(netTimer.current); };
  }, [online, identity]);

  // ── Socket connect / disconnect ─────────────────────────────────────────────
  useEffect(() => {
    if (identity && status === 'ready') {
      connectSocket(identity);
      attachCallHandlers();
      setNotificationOpenChatHandler((aegisId) => {
        void import('./store/contacts').then(({ useContacts }) => {
          const contact = (useContacts.getState() as { contacts: StoredContact[] }).contacts.find((c) => c.aegisId === aegisId);
          if (contact) { setStack([]); push({ name: 'chat', contact }); }
        });
      });
    } else if (!identity && status === 'idle') {
      disconnectSocket();
      setStack([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, status]);

  // ── Panic keyboard shortcut: Ctrl+Shift+P / Cmd+Shift+P ────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        push({ name: 'panic' });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Dynamic document.title ──────────────────────────────────────────────────
  const callStatus = useCall((s) => s.status);
  useEffect(() => {
    const top = stack[stack.length - 1];
    if (top) {
      document.title = `AegisLink — ${top.name}`;
    } else {
      document.title = 'AegisLink';
    }
  }, [stack]);

  const push = useCallback((r: PushRoute) => setStack((s) => [...s, r]), []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const popAllTo = useCallback((tabId: Tab) => { setStack([]); setTab(tabId); }, []);

  // ── Panic wipe ──────────────────────────────────────────────────────────────
  const triggerPanic = useCallback(async () => {
    try {
      const { wipeDatabase } = await import('./db/local');
      await wipeDatabase();
      const { useIdentity: _useIdentity } = await import('./store/identity');
      await _useIdentity.getState().reset();
    } catch {
      /* wipe failure — force re-onboarding via identity reset */
    }
  }, []);

  // ── Call overlays ────────────────────────────────────────────────────────────
  const callOverlay =
    callStatus === 'outgoing-ringing' ||
    callStatus === 'connecting' ||
    callStatus === 'in-call' ||
    callStatus === 'ended';
  const incomingCall = callStatus === 'incoming-ringing';

  // ── Loading (hydration) — only blocks if splash already gone ────────────────
  const isLoading = !showSplash && (status === 'loading' || showOnboarding === null);

  // ── Derive the main content to render (behind splash overlay if needed) ──────
  const mainContent = (() => {
    if (isLoading) {
      return (
        <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: t.bg }}>
          <div style={{ width: 32, height: 32, border: `3px solid ${t.accent}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      );
    }
    // The blocks below are the original early-return logic, now returning JSX instead.
    return null; // sentinel — replaced by the ifs below
  })();
  // If loading, render immediately (with splash overlay on top if still showing).
  if (mainContent !== null) {
    return (
      <>
        {mainContent}
        {showSplash && <SplashScreen onDone={handleSplashDone} />}
      </>
    );
  }

  // ── Entry ────────────────────────────────────────────────────────────────────
  if (showEntry && !identity) {
    return (
      <EntryScreen
        onNewIdentity={() => {
          setShowEntry(false);
          setOnboardingMode('generate');
          setShowOnboarding(true);
        }}
        onRestore={() => {
          setShowEntry(false);
          setOnboardingMode('restore');
          setOnboardingRestore(true);
          setShowOnboarding(true);
        }}
        onLinkMobile={() => {
          // Link-with-mobile: for now treat as new identity flow; a QR pairing
          // screen can be swapped in here by another agent when ready.
          setShowEntry(false);
          setOnboardingMode('generate');
          setShowOnboarding(true);
        }}
      />
    );
  }

  // ── Onboarding ───────────────────────────────────────────────────────────────
  if (showOnboarding) {
    if (onboardingRestore || onboardingMode === 'restore') {
      return <PanicScreen onBack={() => { setOnboardingRestore(false); setOnboardingMode('generate'); setShowEntry(true); setShowOnboarding(false); }} />;
    }
    return (
      <OnboardingScreen
        onDone={() => setShowOnboarding(false)}
        onRestore={() => { setOnboardingRestore(true); setOnboardingMode('restore'); }}
        initialStep={onboardingMode === 'generate' ? 'generating' : 'welcome'}
      />
    );
  }

  // ── App lock overlay ─────────────────────────────────────────────────────────
  if (appLocked) {
    return <LockScreen onUnlock={() => setAppLocked(false)} onPanic={() => push({ name: 'panic' })} />;
  }

  // ── Background privacy shield ─────────────────────────────────────────────
  if (isBackgroundShieldActive) {
    return <div style={{ position: 'fixed', inset: 0, background: '#0a0e0d', zIndex: 9999 }} />;
  }

  // ── Incoming call overlay ─────────────────────────────────────────────────
  if (incomingCall) {
    return <IncomingCallScreen onAccept={acceptCall} onReject={() => endCall('declined')} />;
  }

  // ── Active call overlay ───────────────────────────────────────────────────
  if (callOverlay) {
    return <CallScreen onClose={() => endCall('hangup')} />;
  }

  // ── Helper: open a chat from the sidebar ─────────────────────────────────────
  const openChat = useCallback((contact: StoredContact) => {
    setActiveChatId(contact.aegisId);
    setStack([{ name: 'chat', contact }]);
    setTab('home');
  }, []);

  // ── Helper: render the right-panel content ────────────────────────────────────
  function renderContent(): ReactNode {
    const top = stack[stack.length - 1];
    if (top) {
      switch (top.name) {
        case 'chat':
          return (
            <ChatScreen
              onBack={() => { setActiveChatId(null); pop(); }}
              contact={top.contact}
              onContactDetail={() => push({ name: 'contact', contact: top.contact })}
              onAttach={() => push({ name: 'attach', contact: top.contact })}
              onEphemeral={() => push({ name: 'ephemeral' })}
            />
          );
        case 'contact':
          return (
            <ContactDetailScreen
              onBack={pop}
              contact={top.contact}
              keyChanged={top.keyChanged}
              onChat={() => { setStack([]); push({ name: 'chat', contact: top.contact }); }}
              onCall={(_media) => push({ name: 'chat', contact: top.contact })}
              onVerify={() => push({ name: 'scan' })}
              onEphemeral={() => push({ name: 'ephemeral' })}
            />
          );
        case 'add':
          return <AddContactScreen onCancel={pop} onAdded={(contact) => { pop(); push({ name: 'firstContact', contact }); }} />;
        case 'scan':
          return <ScanQRScreen onCancel={pop} onAdded={(contact) => { pop(); push({ name: 'firstContact', contact }); }} />;
        case 'invite':
          return <InviteAddScreen onBack={pop} onShowMyQR={() => push({ name: 'scan' })} onPasteId={() => push({ name: 'add' })} onScanQR={() => push({ name: 'scan' })} />;
        case 'profile':
          return (
            <ProfileScreen
              onBack={pop}
              onDevices={() => push({ name: 'devices' })}
              onPanic={() => push({ name: 'panic' })}
              onAppIcon={() => push({ name: 'appIcon' })}
              onWorkDashboard={() => push({ name: 'workDashboard' })}
              onSwitchToPersonal={pop}
            />
          );
        case 'notifs':
          return <NotificationsScreen onBack={pop} />;
        case 'backup':
          return <BackupScreen onBack={pop} />;
        case 'devices':
          return <DevicesScreen onBack={pop} />;
        case 'lockConfig':
          return <LockConfigScreen onBack={pop} onLockTest={() => push({ name: 'lock' })} />;
        case 'lockSettings':
          return <LockSettingsScreen onBack={pop} />;
        case 'lock':
          return <LockScreen onUnlock={() => { setAppLocked(false); pop(); }} onPanic={() => push({ name: 'panic' })} />;
        case 'panic':
          return <PanicScreen onBack={pop} />;
        case 'ephemeral':
          return <EphemeralScreen onBack={pop} />;
        case 'export':
          return <DataExportScreen onBack={pop} />;
        case 'attach':
          return <AttachSheetScreen onBack={pop} onPick={(_kind) => pop()} />;
        case 'voice':
          return <VoiceRecorderScreen onBack={pop} onSend={(_url, _dur) => pop()} />;
        case 'viewonce':
          return <ViewOnceScreen onBack={pop} mediaUri={top.mediaUri} contactName={top.contact.name} />;
        case 'viewoncesend':
          return <ViewOnceSendScreen onBack={pop} onSend={(_dataUrl) => pop()} />;
        case 'scheduled':
          return <ScheduledScreen onBack={pop} contactId={top.contact?.aegisId} />;
        case 'location':
          return <LocationScreen onBack={pop} contact={top.contact} onShare={pop} />;
        case 'search':
          return (
            <SearchScreen
              onBack={pop}
              onOpenChat={(contact) => push({ name: 'chat', contact })}
              onOpenContact={(contact) => push({ name: 'contact', contact })}
              onOpenGroupChat={(group) => push({ name: 'groupChat', group })}
            />
          );
        case 'groupadmin':
          return <GroupAdminScreen onBack={pop} group={top.group} />;
        case 'groupChat':
          return <GroupChatScreen onBack={pop} group={top.group} onGroupDetail={() => push({ name: 'groupadmin', group: top.group })} />;
        case 'poll':
          return <PollScreen onBack={pop} groupName={top.group?.name} memberCount={top.group?.members?.length} />;
        case 'firstContact':
          return (
            <FirstContactScreen contact={top.contact} onOpenChat={() => { setStack([]); push({ name: 'chat', contact: top.contact }); }} onAddAnother={() => push({ name: 'invite' })} />
          );
        case 'contacts':
          return (
            <ContactsScreen
              onBack={pop}
              onAddContact={() => push({ name: 'invite' })}
              onOpenContact={(contact) => push({ name: 'contact', contact })}
              onChat={(contact) => push({ name: 'chat', contact })}
            />
          );
        case 'appIcon':
          return <AppIconScreen onBack={pop} />;
        case 'workDashboard':
          return <WorkDashboard onBack={pop} />;
        case 'subscription':
          return <SubscriptionScreen onBack={pop} />;
        case 'workGeneration':
          return <WorkGenerationScreen onBack={pop} onDone={pop} />;
      }
    }

    // Tab destinations
    switch (tab) {
      case 'home':
        return (
          <HomeScreen
            onOpenChat={(contact) => { setActiveChatId(contact.aegisId); push({ name: 'chat', contact }); }}
            onAddContact={() => push({ name: 'invite' })}
            onSearch={() => push({ name: 'search' })}
            onProfile={() => push({ name: 'profile' })}
            onContacts={() => push({ name: 'contacts' })}
            onTab={setTab}
          />
        );
      case 'groups':
        return <GroupsScreen onTab={setTab} onOpenGroupChat={(group) => push({ name: 'groupChat', group })} />;
      case 'verify':
        return (
          <VerifyScreen
            onBack={() => setTab('home')}
            onScan={() => push({ name: 'scan' })}
            onTab={setTab}
          />
        );
      case 'settings':
        return (
          <PrivacyScreen
            onTab={setTab}
            onNav={(name) => push({ name } as PushRoute)}
          />
        );
      case 'dashboard':
        return <WorkDashboard onBack={() => setTab('groups')} />;
      default:
        return null;
    }
  }

  // ── Two-panel layout (Telegram-style) ─────────────────────────────────────────
  const handleNavigate = useCallback((newTab: Tab) => {
    setStack([]);
    setActiveChatId(null);
    setTab(newTab);
  }, []);

  return (
    <>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: t.bg }}>
        {/* Left: sidebar */}
        <Sidebar
          activeSection={tab}
          activeChatId={activeChatId}
          onNavigate={handleNavigate}
          onSelectChat={openChat}
          onNewChat={() => push({ name: 'invite' })}
        />
        {/* Right: content area */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {renderContent() ?? <NoChatPlaceholder t={t} />}
        </div>
      </div>
      {/* Splash overlaid on top — already mounted content shows instantly when it lifts */}
      {showSplash && <SplashScreen onDone={handleSplashDone} />}
    </>
  );
}

// ── No-chat placeholder ───────────────────────────────────────────────────────
const PULSE_CSS = `
@keyframes ncp-ring {
  0%   { transform: scale(1);   opacity: 0.5; }
  100% { transform: scale(2.6); opacity: 0; }
}
.ncp-ring { animation: ncp-ring 2.4s ease-out infinite; }
.ncp-ring-2 { animation: ncp-ring 2.4s ease-out 0.7s infinite; }
.ncp-ring-3 { animation: ncp-ring 2.4s ease-out 1.4s infinite; }
@keyframes ncp-fadein {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.ncp-text  { animation: ncp-fadein 0.5s ease 0.2s both; }
.ncp-hint  { animation: ncp-fadein 0.5s ease 0.45s both; }
.ncp-pills { animation: ncp-fadein 0.5s ease 0.65s both; }
`;

function NoChatPlaceholder({ t }: { t: Theme }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
        backgroundColor: t.bg,
        userSelect: 'none',
      }}
    >
      <style>{PULSE_CSS}</style>

      {/* Logo + pulse rings */}
      <div style={{ position: 'relative', width: 80, height: 80, marginBottom: 32 }}>
        {(['ncp-ring', 'ncp-ring-2', 'ncp-ring-3'] as const).map(cls => (
          <div
            key={cls}
            className={cls}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              border: `1.5px solid ${t.accent}`,
            }}
          />
        ))}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <AegisMark t={t} size={48} />
        </div>
      </div>

      {/* Headline */}
      <span
        className="ncp-text"
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: -0.4,
          color: t.text,
          marginBottom: 8,
        }}
      >
        AegisLink Desktop
      </span>

      {/* Subtext */}
      <span
        className="ncp-hint"
        style={{
          fontFamily: t.font,
          fontSize: 14,
          color: t.textDim,
          marginBottom: 28,
          textAlign: 'center',
          maxWidth: 280,
          lineHeight: '21px',
        }}
      >
        Selecciona una conversación o inicia un nuevo chat cifrado.
      </span>

      {/* Pills */}
      <div className="ncp-pills" style={{ display: 'flex', gap: 8 }}>
        {['Zero metadata', 'E2EE', 'On-device keys'].map(label => (
          <span
            key={label}
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              letterSpacing: 0.8,
              color: t.accent,
              border: `1px solid ${t.accent}`,
              borderRadius: 99,
              paddingLeft: 10,
              paddingRight: 10,
              paddingTop: 4,
              paddingBottom: 4,
              opacity: 0.7,
            }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
