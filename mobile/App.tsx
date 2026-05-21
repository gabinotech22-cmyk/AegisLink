// Initialise i18n before anything else renders
import './src/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, AppState, Pressable, type AppStateStatus, Dimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  useReducedMotion,
  Easing,
} from 'react-native-reanimated';
import { usePanicGesture } from './src/hooks/usePanicGesture';
import * as SecureStore from 'expo-secure-store';
import { I } from './src/components/icons';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { OnboardingScreen } from './src/screens/Onboarding';
import { HomeScreen } from './src/screens/Home';
import { GroupsScreen } from './src/screens/Groups';
import { VerifyScreen } from './src/screens/Verify';
import { PrivacyScreen } from './src/screens/Privacy';
import { ChatScreen } from './src/screens/Chat';
import { GroupChatScreen } from './src/screens/GroupChat';
import { AddContactScreen } from './src/screens/AddContact';
import { ScanQRScreen } from './src/screens/ScanQR';
import { InviteAddScreen } from './src/screens/InviteAdd';
import { ProfileScreen } from './src/screens/Profile';
import { NotificationsScreen } from './src/screens/Notifications';
import { BackupScreen } from './src/screens/Backup';
import { DevicesScreen } from './src/screens/Devices';
import { LockScreen } from './src/screens/Lock';
import { LockConfigScreen } from './src/screens/LockConfig';
import { PanicScreen } from './src/screens/Panic';
import { EphemeralScreen } from './src/screens/Ephemeral';
import { DataExportScreen } from './src/screens/DataExport';
import { ContactDetailScreen } from './src/screens/ContactDetail';
import { AttachSheetScreen } from './src/screens/AttachSheet';
import { ViewOnceScreen } from './src/screens/ViewOnce';
import { ViewOnceSendScreen } from './src/screens/ViewOnceSend';
import { ScheduledScreen } from './src/screens/Scheduled';
import { LocationScreen } from './src/screens/Location';
import { SearchScreen } from './src/screens/Search';
import { GroupAdminScreen } from './src/screens/GroupAdmin';
import { VoiceRecorderScreen } from './src/screens/VoiceRecorder';
import { ContactsScreen } from './src/screens/Contacts';
import { PollScreen } from './src/screens/Poll';
import { FirstContactScreen } from './src/screens/FirstContact';
import { AppIconScreen } from './src/screens/AppIcon';
import { WorkDashboard } from './src/screens/WorkDashboard';
import { WorkGenerationScreen } from './src/screens/WorkGeneration';
import { SubscriptionScreen } from './src/screens/Subscription';
import { CallScreen } from './src/screens/Call';
import { IncomingCallScreen } from './src/screens/IncomingCall';
import { NetworkErrorScreen } from './src/screens/NetworkError';
import { LockSettingsScreen } from './src/screens/LockSettings';
import { KeysScreen } from './src/screens/Keys';
import { useIdentity } from './src/store/identity';
import { usePreferences } from './src/store/preferences';

import { useCall } from './src/store/call';
import { connect as connectSocket, disconnect as disconnectSocket } from './src/socket/client';
import { useConnection } from './src/store/connection';
import { isPicking } from './src/utils/pickingGuard';
import { attachCallHandlers, acceptCall, endCall } from './src/socket/calls';
import { registerForPush, setNotificationOpenChatHandler } from './src/notifications/push';
import { WEBRTC_AVAILABLE } from './src/runtime';
import { clearTurnCache } from './src/webrtc/ice';

// ─── Background Scheduled-Message Task ───────────────────────────────────────
const SCHEDULED_TASK_NAME = 'aegis.scheduled-sender';
(function registerScheduledTask() {
  try {
    const TaskManager = require('expo-task-manager');
    const BackgroundFetch = require('expo-background-fetch');
    TaskManager.defineTask(SCHEDULED_TASK_NAME, async () => {
      try {
        const raw = await SecureStore.getItemAsync('aegis.scheduled.v1');
        if (!raw) return BackgroundFetch.BackgroundFetchResult.NoData;
        const loaded = JSON.parse(raw) as Array<{
          id: string;
          toContact: { aegisId: string; publicKeyB64: string };
          text: string;
          sendAt: number;
        }>;
        const now = Date.now();
        const due = loaded.filter((i) => i.sendAt <= now);
        if (due.length === 0) return BackgroundFetch.BackgroundFetchResult.NoData;

        const remaining = loaded.filter((i) => i.sendAt > now);
        await SecureStore.setItemAsync('aegis.scheduled.v1', JSON.stringify(remaining));

        const { useIdentity } = require('./src/store/identity');
        const identity = useIdentity.getState().identity;
        if (!identity) return BackgroundFetch.BackgroundFetchResult.Failed;

        const { sendMessage } = require('./src/socket/client');
        const { decodeBase64 } = require('tweetnacl-util');
        for (const item of due) {
          try {
            await sendMessage({
              identity,
              recipientAegisId: item.toContact.aegisId,
              recipientPublicKey: decodeBase64(item.toContact.publicKeyB64),
              plaintext: item.text,
            });
          } catch {
            /* best effort per message */
          }
        }
        return BackgroundFetch.BackgroundFetchResult.NewData;
      } catch {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });
  } catch {
    /* expo-task-manager / expo-background-fetch not available (Expo Go) — setInterval fallback is active */
  }
})();
import type { Tab } from './src/components/TabBar';
import type { StoredContact, StoredGroup } from './src/db/local';

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
  | { name: 'workGeneration' }
  | { name: 'keys' };

const SCREEN_WIDTH = Dimensions.get('window').width;

/**
 * Wraps a pushed screen in a slide-in animation that runs on the UI thread.
 * On pop the parent component unmounts the child — no explicit slide-out needed
 * because React Native removes the element; we only animate push (enter).
 * Respects reduceMotion: skips animation when the OS accessibility setting is on.
 */
function AnimatedScreen({ children, stackDepth }: { children: React.ReactNode; stackDepth: number }) {
  const reduceMotion = useReducedMotion() ?? false;
  const translateX = useSharedValue(reduceMotion ? 0 : SCREEN_WIDTH);

  useEffect(() => {
    translateX.value = withTiming(0, {
      duration: reduceMotion ? 0 : 280,
      easing: Easing.out(Easing.cubic),
    });
  // Only animate when stackDepth changes (new push)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackDepth]);

  const animStyle = useAnimatedStyle(() => ({
    flex: 1,
    transform: [{ translateX: translateX.value }],
  }));

  return <Animated.View style={animStyle}>{children}</Animated.View>;
}

function Shell() {
  const { t } = useTheme();
  const { identity, status, hydrated, hydrate } = useIdentity();
  const blockScreenshots = usePreferences((s) => s.blockScreenshots);
  const hideRecents = usePreferences((s) => s.hideRecents);
  const hydratePrefs = usePreferences((s) => s.hydrate);
  const appLockEnabled = usePreferences((s) => s.appLockEnabled);
  const lockTimeoutMin = usePreferences((s) => s.lockTimeoutMin);
  const [tab, setTab] = useState<Tab>('home');
  const [isBackgroundShieldActive, setIsBackgroundShieldActive] = useState(false);
  const [stack, setStack] = useState<PushRoute[]>([]);
  const [netError, setNetError] = useState(false);
  // null = not yet determined (loading), true = new user needs onboarding, false = returning user or done
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  // When true, show BackupScreen inside the onboarding flow (restore path)
  const [onboardingRestore, setOnboardingRestore] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    if (showOnboarding === null) {
      // Initial determination after cold-start hydration
      setShowOnboarding(!identity);
    } else if (showOnboarding === false && !identity) {
      // Identity cleared via reset() while already in the app → back to onboarding
      setShowOnboarding(true);
    }
    // showOnboarding === true + identity set = generate() mid-onboarding → do nothing
  }, [hydrated, identity, showOnboarding]);
  const netTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const online = useConnection((s) => s.online);

  // ── App lock state ──────────────────────────────────────────────────────────
  const [appLocked, setAppLocked] = useState(false);
  const lastBgTimeRef = useRef<number | null>(null);
  const didColdLockRef = useRef(false);

  // Cold-start lock: lock once when identity is confirmed and lock is enabled
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

  // Background → foreground lock enforcement
  useEffect(() => {
    if (!appLockEnabled || !identity) return;
    const handler = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        // Don't record bg time if the system picker is open — that transition
        // is caused by the picker overlay, not the user leaving the app.
        if (!isPicking()) lastBgTimeRef.current = Date.now();
      } else if (nextState === 'active') {
        const bg = lastBgTimeRef.current;
        if (bg !== null && !isPicking()) {
          const elapsedMin = (Date.now() - bg) / 60000;
          if (elapsedMin >= lockTimeoutMin) {
            setAppLocked(true);
          }
          lastBgTimeRef.current = null;
        }
      }
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, [appLockEnabled, lockTimeoutMin, identity]);

  useEffect(() => {
    if (!hideRecents) {
      setIsBackgroundShieldActive(false);
      return;
    }
    const handler = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        if (!isPicking()) setIsBackgroundShieldActive(true);
      } else if (nextState === 'active') {
        setIsBackgroundShieldActive(false);
      }
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, [hideRecents]);

  useEffect(() => {
    void hydrate();
    void hydratePrefs();
  }, [hydrate, hydratePrefs]);

  // Enforce screenshot / screen-recording block
  useEffect(() => {
    try {
      const SC = require('expo-screen-capture');
      if (blockScreenshots) {
        SC.preventScreenCaptureAsync().catch(() => {});
      } else {
        SC.allowScreenCaptureAsync().catch(() => {});
      }
    } catch { /* package not installed — graceful no-op */ }
  }, [blockScreenshots]);

  useEffect(() => {
    const { useMessages } = require('./src/store/messages');
    const interval = setInterval(() => {
      useMessages.getState().pruneExpired();
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Global Scheduled Messages Background Runner (Gap 4)
  useEffect(() => {
    if (!identity || status !== 'ready') return;

    // Register expo-background-fetch so messages fire even when the app is closed.
    // The OS controls exact timing (minimum ~15 min on iOS), but messages that
    // arrive past their sendAt will be dispatched on the next background wake-up.
    (async () => {
      try {
        const BackgroundFetch = require('expo-background-fetch');
        const TaskManager = require('expo-task-manager');
        const isRegistered = await TaskManager.isTaskRegisteredAsync(SCHEDULED_TASK_NAME);
        if (!isRegistered) {
          await BackgroundFetch.registerTaskAsync(SCHEDULED_TASK_NAME, {
            minimumInterval: 60, // seconds — OS may enforce a longer minimum
            stopOnTerminate: false,
            startOnBoot: true,
          });
        }
      } catch {
        /* Expo Go or device policy prevents background fetch — setInterval covers foreground */
      }
    })();

    const interval = setInterval(async () => {
      try {
        const raw = await SecureStore.getItemAsync('aegis.scheduled.v1');
        if (!raw) return;
        const loaded = JSON.parse(raw) as any[];
        const now = Date.now();
        const due = loaded.filter((i) => i.sendAt <= now);
        if (due.length === 0) return;

        const remaining = loaded.filter((i) => i.sendAt > now);
        await SecureStore.setItemAsync('aegis.scheduled.v1', JSON.stringify(remaining));

        for (const item of due) {
          try {
            const { sendMessage } = require('./src/socket/client');
            const { decodeBase64 } = require('tweetnacl-util');
            await sendMessage({
              identity,
              recipientAegisId: item.toContact.aegisId,
              recipientPublicKey: decodeBase64(item.toContact.publicKeyB64),
              plaintext: item.text,
            });
          } catch (e) {
            if (__DEV__) console.error('[global-scheduler] Failed to send scheduled message:', e);
          }
        }
      } catch (err) {
        if (__DEV__) console.warn('[global-scheduler] error in runner:', err);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [identity, status]);

  // Show NetworkErrorScreen after 5s of being offline (only when authenticated).
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

  useEffect(() => {
    if (identity && status === 'ready') {
      connectSocket(identity);
      if (WEBRTC_AVAILABLE) attachCallHandlers();
      setNotificationOpenChatHandler((aegisId) => {
        const { useContacts } = require('./src/store/contacts');
        const contact = useContacts.getState().contacts.find((c: StoredContact) => c.aegisId === aegisId);
        if (contact) { setStack([]); push({ name: 'chat', contact }); }
      });
      void registerForPush(identity);
    } else if (!identity && status === 'idle') {
      disconnectSocket();
      clearTurnCache();
      setStack([]);
    }
  }, [identity, status]);

  const push = useCallback((r: PushRoute) => setStack((s) => [...s, r]), []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  // ── Panic gesture ───────────────────────────────────────────────────────────
  const triggerPanic = useCallback(async () => {
    try {
      const { wipeDatabase } = require('./src/db/local') as typeof import('./src/db/local');
      await wipeDatabase();
      const { useIdentity: _useIdentity } = require('./src/store/identity') as typeof import('./src/store/identity');
      await _useIdentity.getState().reset();
    } catch {
      /* wipe failure: app state is now invalid — identity reset forces re-onboarding */
    }
  }, []);

  const { registerTap } = usePanicGesture(triggerPanic);

  async function handleFilePick(contact: StoredContact) {
    const DocumentPicker = require('expo-document-picker');
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const { useMessages } = require('./src/store/messages');
    const id = (await import('expo-crypto')).randomUUID();
    await useMessages.getState().append({
      id,
      chatId: contact.aegisId,
      direction: 'out',
      body: asset.name ?? 'archivo',
      createdAt: Date.now(),
      type: 'file',
      mediaUri: asset.uri,
    });
    if (identity) {
      const { sendMessage } = require('./src/socket/client');
      const { decodeBase64 } = require('tweetnacl-util');
      const { encryptAndUploadMedia } = require('./src/crypto/media');
      try {
        const blobUri: string = await encryptAndUploadMedia(asset.uri);
        await sendMessage({
          identity,
          recipientAegisId: contact.aegisId,
          recipientPublicKey: decodeBase64(contact.publicKeyB64),
          plaintext: `[file:${asset.name}:${blobUri}]`,
        });
      } catch { /* queued */ }
    }
  }
  const popAllTo = useCallback((tabId: Tab) => {
    setStack([]);
    setTab(tabId);
  }, []);

  // Call overlay state (takes over the entire UI when active)
  const callStatus = useCall((s) => s.status);
  const callOverlay =
    callStatus === 'outgoing-ringing' ||
    callStatus === 'connecting' ||
    callStatus === 'in-call' ||
    callStatus === 'ended';
  const incomingCall = callStatus === 'incoming-ringing';

  if (status === 'loading' || showOnboarding === null) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }

  if (showOnboarding) {
    if (onboardingRestore) {
      return (
        <BackupScreen
          onBack={() => setOnboardingRestore(false)}
          onRestored={() => { setOnboardingRestore(false); setShowOnboarding(false); setTab('home'); }}
        />
      );
    }
    return (
      <OnboardingScreen
        onDone={() => { setShowOnboarding(false); setTab('home'); }}
        onRestore={() => setOnboardingRestore(true)}
      />
    );
  }

  // Multitasking Privacy Shield — prevents task-switcher E2EE layout leakage
  if (isBackgroundShieldActive) {
    return (
      <View style={{ flex: 1, backgroundColor: '#07090a', alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: '#11181a', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#1f2d30' }}>
          <I.Lock size={32} color={t.accent} />
        </View>
        <Text style={{ marginTop: 20, fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.5 }}>
          AEGISLINK SECURE SESSION
        </Text>
      </View>
    );
  }

  // App lock — shown after identity is confirmed, takes priority over everything
  if (appLocked) {
    return (
      <LockScreen
        onUnlock={() => setAppLocked(false)}
        onPanic={() => { setAppLocked(false); push({ name: 'panic' }); }}
      />
    );
  }

  if (netError) {
    return (
      <NetworkErrorScreen
        onRetry={() => {
          setNetError(false);
          if (identity) connectSocket(identity);
        }}
      />
    );
  }

  if (incomingCall) {
    return <IncomingCallScreen onAccept={() => void acceptCall()} onReject={() => endCall('declined')} />;
  }
  if (callOverlay) {
    return <CallScreen onClose={() => { /* state resets itself */ }} />;
  }

  // Top of stack wins; otherwise show the current tab.
  const top = stack[stack.length - 1];
  if (top) {
    // eslint-disable-next-line no-inner-declarations
    function renderTop() {
      switch (top!.name) {
      case 'chat':
        return (
          <ChatScreen
            contact={top.contact}
            onBack={pop}
            onContactDetail={() => push({ name: 'contact', contact: top.contact })}
            onAttach={() => push({ name: 'attach', contact: top.contact })}
            onEphemeral={() => push({ name: 'ephemeral' })}
            onViewOnce={(mediaUri, messageId) => push({ name: 'viewonce', contact: top.contact, mediaUri, messageId })}
          />
        );
      case 'groupChat':
        return (
          <GroupChatScreen
            group={top.group}
            onBack={pop}
            onGroupDetail={() => push({ name: 'groupadmin', group: top.group })}
            onPoll={() => push({ name: 'poll', group: top.group })}
            onAttach={async () => {
              const ImagePicker = require('expo-image-picker');
              const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
                quality: 1,
              });
              if (!result.canceled && result.assets?.[0]?.uri) {
                const { useMessages } = require('./src/store/messages');
                useMessages.getState().setPendingMedia(result.assets[0].uri);
              }
            }}
          />
        );
      case 'contact':
        return (
          <ContactDetailScreen
            contact={top.contact}
            keyChanged={top.keyChanged}
            onBack={pop}
            onChat={() => {
              pop();
              push({ name: 'chat', contact: top.contact });
            }}
            onCall={(media) => {
              pop();
              push({ name: 'chat', contact: top.contact });
              // Slight delay so ChatScreen mounts before we trigger the call
              setTimeout(() => {
                const { startCall } = require('./src/socket/calls');
                void startCall(top.contact.aegisId, media).catch(() => {});
              }, 400);
            }}
            onVerify={() => popAllTo('verify')}
            onEphemeral={() => push({ name: 'ephemeral' })}
          />
        );
      case 'add':
        return (
          <AddContactScreen
            onCancel={pop}
            onAdded={(c) => {
              setStack([]);
              push({ name: 'chat', contact: c });
            }}
          />
        );
      case 'scan':
        return (
          <ScanQRScreen
            onCancel={pop}
            onAdded={(c) => {
              setStack([]);
              push({ name: 'chat', contact: c });
            }}
          />
        );
      case 'invite':
        return (
          <InviteAddScreen
            onBack={pop}
            onShowMyQR={() => popAllTo('verify')}
            onScanQR={() => setStack((s) => [...s.slice(0, -1), { name: 'scan' }])}
            onPasteId={() => setStack((s) => [...s.slice(0, -1), { name: 'add' }])}
          />
        );
      case 'profile':
        return (
          <ProfileScreen
            onBack={pop}
            onKeys={() => push({ name: 'keys' })}
            onDevices={() => push({ name: 'devices' })}
            onPanic={() => push({ name: 'panic' })}
            onAppIcon={() => push({ name: 'appIcon' })}
            onWorkDashboard={() => { pop(); setTab('dashboard'); }}
            onSwitchToPersonal={() => { pop(); setTab('home'); }}
            onSubscription={() => push({ name: 'subscription' })}
            onWorkGeneration={() => push({ name: 'workGeneration' })}
            onNotifications={() => push({ name: 'notifs' })}
            onLockConfig={() => push({ name: 'lockConfig' })}
            onExport={() => push({ name: 'export' })}
          />
        );
      case 'workGeneration':
        return (
          <WorkGenerationScreen
            onDone={() => {
              pop();
              setTab('dashboard');
            }}
            onBack={pop}
          />
        );
      case 'appIcon':
        return <AppIconScreen onBack={pop} />;
      case 'keys':
        return <KeysScreen onBack={pop} />;
      case 'workDashboard':
        return <WorkDashboard onBack={pop} />;
      case 'subscription':
        return <SubscriptionScreen onBack={pop} />;
      case 'notifs':
        return <NotificationsScreen onBack={pop} />;
      case 'backup':
        return <BackupScreen onBack={pop} />;
      case 'devices':
        return <DevicesScreen onBack={pop} />;
      case 'lockConfig':
        return <LockConfigScreen onBack={pop} onLockTest={() => push({ name: 'lock' })} onLockSettings={() => push({ name: 'lockSettings' })} />;
      case 'lockSettings':
        return <LockSettingsScreen onBack={pop} />;
      case 'lock':
        return <LockScreen onUnlock={pop} onPanic={() => push({ name: 'panic' })} />;
      case 'panic':
        return <PanicScreen onBack={pop} />;
      case 'ephemeral':
        return <EphemeralScreen onBack={pop} />;
      case 'export':
        return <DataExportScreen onBack={pop} />;
      case 'attach':
        return (
          <AttachSheetScreen
            onBack={pop}
            onPick={(kind) => {
              if (kind === 'scheduled') {
                pop();
                push({ name: 'scheduled', contact: top.contact });
              } else if (kind === 'location') {
                pop();
                push({ name: 'location', contact: top.contact });
              } else if (kind === 'viewoncesend') {
                pop();
                push({ name: 'viewoncesend', contact: top.contact });
              } else if (kind === 'voice') {
                pop();
                push({ name: 'voice', contact: top.contact });
              } else if (kind === 'file') {
                handleFilePick(top.contact).then(pop).catch(() => {});
              } else if (kind === 'contact') {
                const { useContacts } = require('./src/store/contacts');
                const contacts: StoredContact[] = useContacts.getState().contacts.filter(
                  (c: StoredContact) => c.aegisId !== top.contact.aegisId
                );
                if (contacts.length === 0) {
                  const { Alert } = require('react-native');
                  Alert.alert('Sin contactos', 'No tienes otros contactos para compartir.');
                  return;
                }
                const { Alert } = require('react-native');
                Alert.alert(
                  'Compartir contacto',
                  'Selecciona un contacto para compartir su ID',
                  [
                    ...contacts.slice(0, 5).map((c: StoredContact) => ({
                      text: c.name,
                      onPress: async () => {
                        const { useMessages } = require('./src/store/messages');
                        const { randomUUID } = await import('expo-crypto');
                        const msgId = randomUUID();
                        await useMessages.getState().append({
                          id: msgId,
                          chatId: top.contact.aegisId,
                          direction: 'out',
                          body: `[contact:${c.name}:${c.aegisId}]`,
                          createdAt: Date.now(),
                          type: 'text',
                        });
                        if (identity) {
                          const { sendMessage } = require('./src/socket/client');
                          const { decodeBase64 } = require('tweetnacl-util');
                          try {
                            await sendMessage({
                              identity,
                              recipientAegisId: top.contact.aegisId,
                              recipientPublicKey: decodeBase64(top.contact.publicKeyB64),
                              plaintext: `[contact:${c.name}:${c.aegisId}]`,
                            });
                          } catch { /* queued */ }
                        }
                        pop();
                      },
                    })),
                    { text: 'Cancelar', style: 'cancel' },
                  ]
                );
              }
              else pop();
            }}
          />
        );
      case 'voice':
        return (
          <VoiceRecorderScreen
            onBack={pop}
            onSend={async (uri, durationMs) => {
              if (!identity) { pop(); return; }
              const { randomUUID } = await import('expo-crypto');
              const id = randomUUID();
              const { useMessages } = require('./src/store/messages');
              const durationSec = Math.round(durationMs / 1000);
              await useMessages.getState().append({
                id,
                chatId: top.contact.aegisId,
                direction: 'out',
                body: `[audio:${durationSec}s]`,
                createdAt: Date.now(),
                type: 'audio',
                mediaUri: uri,
              });
              const { sendMessage } = require('./src/socket/client');
              const { decodeBase64 } = require('tweetnacl-util');
              try {
                const { encryptAndUploadMedia } = require('./src/crypto/media');
                const blobUri: string = await encryptAndUploadMedia(uri);
                await sendMessage({
                  identity,
                  recipientAegisId: top.contact.aegisId,
                  recipientPublicKey: decodeBase64(top.contact.publicKeyB64),
                  plaintext: `[audio:${durationSec}s:${blobUri}]`,
                  skipLocalAppend: true,
                });
              } catch { /* queued */ }
              pop();
            }}
          />
        );
      case 'viewonce':
        return <ViewOnceScreen contact={top.contact} mediaUri={top.mediaUri} messageId={(top as any).messageId} onBack={pop} />;
      case 'viewoncesend':
        return <ViewOnceSendScreen contact={top.contact} onBack={pop} onSent={pop} />;
      case 'scheduled':
        return <ScheduledScreen contact={top.contact} onBack={pop} />;
      case 'location':
        return <LocationScreen contact={top.contact} onBack={pop} onShare={pop} />;
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
        return <GroupAdminScreen group={top.group} onBack={pop} />;
      case 'poll':
        return (
          <PollScreen
            group={top.group}
            onBack={pop}
            onSend={top.group && identity ? async (question, options) => {
              const { sendGroupMessage } = require('./src/socket/client');
              try {
                await sendGroupMessage({
                  identity,
                  groupId: top.group!.id,
                  plaintext: `[poll:${question}|${options.join('|')}]`,
                });
              } catch { /* queued */ }
              pop();
            } : undefined}
          />
        );
      case 'firstContact':
        return (
          <FirstContactScreen
            contact={top.contact}
            onOpenChat={() => { setStack([]); push({ name: 'chat', contact: top.contact }); }}
            onAddAnother={() => { setStack([]); push({ name: 'invite' }); }}
          />
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
    }
    }
    return (
      <AnimatedScreen stackDepth={stack.length}>
        {renderTop() ?? null}
      </AnimatedScreen>
    );
  }

  // Tab destinations
  switch (tab) {
    case 'home':
      return (
        <View style={{ flex: 1 }}>
          <HomeScreen
            onOpenChat={(contact) => push({ name: 'chat', contact })}
            onAddContact={() => push({ name: 'invite' })}
            onSearch={() => push({ name: 'search' })}
            onProfile={() => push({ name: 'profile' })}
            onContacts={() => push({ name: 'contacts' })}
            onTab={setTab}
          />
          {/* Invisible tap target over the logo area for the 'tap' panic gesture.
              Positioned top-left to cover the AegisLink wordmark (~120×52 px).
              pointer-events passthrough is off intentionally — the logo's own
              onPress (→ profile) fires via HomeScreen; this Pressable sits behind
              it but Android/iOS let both fire because we use hitSlop only. */}
          <Pressable
            onPress={registerTap}
            accessibilityLabel="Panic gesture tap zone"
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 130,
              height: 66,
              opacity: 0,
            }}
            hitSlop={{ top: 8, left: 8, right: 8, bottom: 8 }}
          />
        </View>
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
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar style="auto" />
        <Shell />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
