// Initialise i18n before anything else renders
import './src/i18n';
import { logger } from './src/utils/logger';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { View, Text, ActivityIndicator, AppState, Pressable, type AppStateStatus, Dimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  useReducedMotion,
  Easing,
} from 'react-native-reanimated';
import * as SecureStore from 'expo-secure-store';
import { useFonts } from 'expo-font';
import { fontAssets } from './src/theme/fontAssets';
import { I } from './src/components/icons';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { OnboardingScreen } from './src/screens/Onboarding';
import { HomeScreen } from './src/screens/Home';
import { GroupsScreen } from './src/screens/Groups';
import { PrivacyScreen } from './src/screens/Privacy';
import { ChatScreen } from './src/screens/Chat';
import { GroupChatScreen } from './src/screens/GroupChat';
import { GroupPostsScreen } from './src/screens/GroupPosts';
import { AddContactScreen } from './src/screens/AddContact';
import { ScanQRScreen } from './src/screens/ScanQR';
import { VerifyScreen } from './src/screens/Verify';
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
import { GroupJoinScreen } from './src/screens/GroupJoin';
import { VoiceRecorderScreen } from './src/screens/VoiceRecorder';
import { ContactsScreen } from './src/screens/Contacts';
import { PollScreen } from './src/screens/Poll';
import { FirstContactScreen } from './src/screens/FirstContact';
import { AppIconScreen } from './src/screens/AppIcon';
import { CallScreen } from './src/screens/Call';
import { IncomingCallScreen } from './src/screens/IncomingCall';
import { GroupCallScreen } from './src/screens/GroupCall';
import { IncomingGroupCallScreen } from './src/screens/IncomingGroupCall';
import { FloatingCallBar } from './src/components/FloatingCallBar';
import { FloatingGroupCallBar } from './src/components/FloatingGroupCallBar';
import { NetworkErrorScreen } from './src/screens/NetworkError';
import { LockSettingsScreen } from './src/screens/LockSettings';
import { KeysScreen } from './src/screens/Keys';
import { ChannelDiscoverScreen } from './src/screens/ChannelDiscover';
import { ChannelCreateScreen } from './src/screens/ChannelCreate';
import { ChannelFeedScreen } from './src/screens/ChannelFeed';
import { ChannelInfoScreen } from './src/screens/ChannelInfo';
import { DistributionListsScreen } from './src/screens/DistributionLists';
import { BroadcastComposeScreen } from './src/screens/BroadcastCompose';
import { ProfileSwitcherScreen } from './src/screens/ProfileSwitcher';
import { CreateProfileScreen } from './src/screens/CreateProfile';
import { useIdentity } from './src/store/identity';
import { usePreferences } from './src/store/preferences';
import { useProfiles } from './src/store/profiles';

import { useCall } from './src/store/call';
import { connect as connectSocket, disconnect as disconnectSocket } from './src/socket/client';
import { warmUpDb, dbReadyPromise } from './src/db/local';
import { useConnection } from './src/store/connection';
import { isPicking } from './src/utils/pickingGuard';
import { attachCallHandlers, acceptCall, endCall } from './src/socket/calls';
import { attachGroupCallHandlers, acceptGroupCall, declineGroupCall } from './src/socket/groupCalls';
import { useGroupCall } from './src/store/groupCall';
import { registerForPush, setNotificationOpenChatHandler } from './src/notifications/push';
import { initCallKeep } from './src/calls/callkeep';
import { WEBRTC_AVAILABLE } from './src/runtime';
import { clearTurnCache } from './src/webrtc/ice';
import { handlePanicDeepLink } from './src/utils/panicLink';

// ─── Background Scheduled-Message Task ───────────────────────────────────────
const SCHEDULED_TASK_NAME = 'aegis.scheduled-sender';
(function registerScheduledTask() {
  try {
    const TaskManager = require('expo-task-manager');
    const BackgroundFetch = require('expo-background-fetch');
    TaskManager.defineTask(SCHEDULED_TASK_NAME, async () => {
      try {
        // processDue() reads the SQLite scheduled_messages table — the SAME
        // store that scheduleMessage/scheduleGroupPost write to. (The previous
        // implementation read a legacy 'aegis.scheduled.v1' SecureStore key
        // that nothing wrote anymore, so scheduled messages never fired.)
        const { loadPendingScheduled } = require('./src/db/local') as typeof import('./src/db/local');
        const pending = await loadPendingScheduled();
        const now = Date.now();
        if (!pending.some((m) => m.sendAt <= now)) {
          return BackgroundFetch.BackgroundFetchResult.NoData;
        }
        const { useScheduledMessages } = require('./src/store/scheduledMessages') as typeof import('./src/store/scheduledMessages');
        await useScheduledMessages.getState().processDue();
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
import { useTranslation } from 'react-i18next';
import { useContacts as useContactsStore } from './src/store/contacts';
import { ContactPickerSheet } from './src/components/ContactPickerSheet';
import { AlertHost } from './src/components/AlertHost';
import { MultiPreviewScreen } from './src/screens/MultiPreview';
import type { MultiPreviewAsset } from './src/screens/MultiPreview';

type PushRoute =
  | { name: 'chat'; contact: StoredContact }
  | { name: 'contact'; contact: StoredContact; keyChanged?: boolean }
  | { name: 'add' }
  | { name: 'scan' }
  | { name: 'verify'; contactId?: string }
  | { name: 'profile' }
  | { name: 'notifs' }
  | { name: 'backup' }
  | { name: 'devices' }
  | { name: 'lockConfig' }
  | { name: 'lock' }
  | { name: 'panic' }
  | { name: 'ephemeral'; chatId: string }
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
  | { name: 'groupPosts'; group: StoredGroup; initialText?: string }
  | { name: 'groupAttach'; group: StoredGroup }
  | { name: 'groupVoice'; group: StoredGroup }
  | { name: 'poll'; group?: StoredGroup }
  | { name: 'firstContact'; contact: StoredContact }
  | { name: 'contacts' }
  | { name: 'appIcon' }
  | { name: 'lockSettings' }
  | { name: 'keys' }
  | { name: 'distribution' }
  | { name: 'broadcast'; list: import('./src/store/distribution').DistributionList }
  | { name: 'profileSwitcher' }
  | { name: 'createProfile' }
  | { name: 'groupJoin'; groupId: string; groupName: string; adminId: string }
  | { name: 'groupCall' }
  | { name: 'multiPreview'; contact: StoredContact; assets: import('./src/screens/MultiPreview').MultiPreviewAsset[] }
  | { name: 'groupMultiPreview'; group: StoredGroup; assets: import('./src/screens/MultiPreview').MultiPreviewAsset[] }
  | { name: 'channelDiscover' }
  | { name: 'channelCreate' }
  | { name: 'channelFeed'; channelId: string }
  | { name: 'channelInfo'; channelId: string };

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
  const { t: i18nT } = useTranslation();
  const { identity, status, hydrated, hydrate } = useIdentity();
  const allContacts = useContactsStore((s) => s.contacts);
  const blockScreenshots = usePreferences((s) => s.blockScreenshots);
  const hideRecents = usePreferences((s) => s.hideRecents);
  const hydratePrefs = usePreferences((s) => s.hydrate);
  const appLockEnabled = usePreferences((s) => s.appLockEnabled);
  const lockTimeoutMin = usePreferences((s) => s.lockTimeoutMin);
  const [tab, setTab] = useState<Tab>('home');
  const [isBackgroundShieldActive, setIsBackgroundShieldActive] = useState(false);
  const [stack, setStack] = useState<PushRoute[]>([]);
  // Remembered Groups|Channels segment: GroupsScreen unmounts while a pushed
  // screen (channel feed/create/discover) is on top, so its local segment
  // state resets on pop — this keeps "back" landing on Channels, not Groups.
  const [groupsSeg, setGroupsSeg] = useState<'groups' | 'channels'>('groups');
  const [netError, setNetError] = useState(false);
  // null = not yet determined (loading), true = new user needs onboarding, false = returning user or done
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  // When true, show BackupScreen inside the onboarding flow (restore path)
  const [onboardingRestore, setOnboardingRestore] = useState(false);
  // true once the SQLite DB connection has been confirmed open (cold-start gate)
  const [dbReady, setDbReady] = useState(false);

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
  const [showWipeOverlay, setShowWipeOverlay] = useState(false);
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

  // Purge plaintext media cache 30 s after going to background to reduce forensic window
  useEffect(() => {
    let purgeTimer: ReturnType<typeof setTimeout> | null = null;
    const handler = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        purgeTimer = setTimeout(() => {
          const { purgeCachedDecryptedMedia } = require('./src/crypto/media');
          void (purgeCachedDecryptedMedia as () => Promise<void>)().catch(() => {});
        }, 30_000);
      } else if (nextState === 'active') {
        if (purgeTimer !== null) {
          clearTimeout(purgeTimer);
          purgeTimer = null;
        }
      }
    };
    const sub = AppState.addEventListener('change', handler);
    return () => {
      sub.remove();
      if (purgeTimer !== null) clearTimeout(purgeTimer);
    };
  }, []);

  useEffect(() => {
    // ── Cold-start DB warm-up ────────────────────────────────────────────────
    // Kick off the SQLite connection as early as possible so that the JSI bridge
    // NPE window (expo-sqlite New Architecture, Android x86) is absorbed during
    // the loading splash — BEFORE the user can tap "Generate my identity".
    // warmUpDb() is idempotent: subsequent calls on the same slot are no-ops.
    warmUpDb();
    // Resolve the UI gate (dbReady) as soon as the DB is genuinely open.
    void dbReadyPromise.then(() => setDbReady(true));

    void hydrate();
    void hydratePrefs();
    // Startup: prune messages that expired while the app was closed,
    // and restore per-chat ephemeral timers from SQLite.
    const { deleteExpiredMessages: pruneDb } = require('./src/db/local');
    void (pruneDb as () => Promise<void>)();
    const { useMessages: msgStore } = require('./src/store/messages');
    void (msgStore.getState().loadAllEphemeralTimers as () => Promise<void>)();
  }, [hydrate, hydratePrefs]);

  // Eventual-consistency hydration for groups + contacts + subscribed channels.
  //
  // The Home/Groups screens hydrate their stores on mount, but that is a
  // one-shot: if a load ever returns empty (DB slot not ready on first mount,
  // a transient withDb NPE-retry miss, etc.) the list stays empty until some
  // unrelated event (e.g. an incoming group message) re-hydrates it — which is
  // exactly the "group vanished from the list but reappeared on a new message"
  // symptom. Re-hydrating once the identity/DB slot is guaranteed ready, and
  // again every time the app returns to foreground, makes the lists
  // self-correct without relying on which screen happens to be mounted.
  //
  // channels.subscribed is memory-only and is otherwise repopulated from
  // SecureStore-persisted channel secrets ONLY by ChannelsPanel's own mount
  // effect (Groups → Channels tab). A user who reaches ChannelFeed/ChannelInfo
  // via a deep link or a channel-post notification without ever mounting that
  // tab this session would see subscribed=[] and a false "channel not found"
  // — hydrating it here too (idempotent; see hydrateSubscribed's `known`
  // dedup) closes that gap regardless of navigation path.
  useEffect(() => {
    if (!hydrated || !identity) return;
    const rehydrate = () => {
      const { useGroups } = require('./src/store/groups');
      const { useContacts } = require('./src/store/contacts');
      const { useChannels } = require('./src/store/channels');
      void useGroups.getState().hydrate().catch(() => {});
      void useContacts.getState().hydrate().catch(() => {});
      void useChannels.getState().hydrateSubscribed().catch(() => {});
    };
    rehydrate();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') rehydrate();
    });
    return () => sub.remove();
  }, [hydrated, identity]);

  // Enforce screenshot / screen-recording block.
  // E2E exception: Maestro drives the app through screen capture, which
  // FLAG_SECURE blocks — the automation run errors out before it can assert
  // anything. EXPO_PUBLIC_E2E is inlined ONLY into the CI E2E bundle (see the
  // "Bundle JS into debug assets" step in .github/workflows/ci.yml); it is never
  // set for release builds, so production still defaults to blocking screenshots
  // (fail-closed). This only toggles an anti-capture UX flag — no key material.
  useEffect(() => {
    try {
      const SC = require('expo-screen-capture');
      const e2e = process.env.EXPO_PUBLIC_E2E === '1';
      if (blockScreenshots && !e2e) {
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

    // One-time cleanup: the legacy scheduler stored PLAINTEXT scheduled
    // messages under this SecureStore key. Nothing writes it anymore (the
    // store writes E2EE/at-rest-encrypted rows to SQLite), so wipe any
    // residue from old builds rather than leaving plaintext at rest.
    void SecureStore.deleteItemAsync('aegis.scheduled.v1').catch(() => {});

    // Foreground runner: fire due scheduled messages (1:1 + group posts +
    // channel posts) from the SQLite-backed store. processDue() is cheap when
    // nothing is due (one indexed SELECT), and offline ticks leave messages
    // pending without burning retries.
    //
    // `running` guards against overlap: runDue() is triggered from 3 sources
    // (immediate mount, AppState → active, 10s interval) and processDue() is
    // async — without this guard a slow run (or an `active` event firing
    // mid-interval) could kick off a second processDue() in parallel.
    let running = false;
    const runDue = () => {
      if (running) return;
      running = true;
      try {
        const { useScheduledMessages } = require('./src/store/scheduledMessages') as typeof import('./src/store/scheduledMessages');
        useScheduledMessages
          .getState()
          .processDue()
          .catch((err: unknown) => {
            if (__DEV__) console.warn('[global-scheduler] error in runner:', err);
          })
          .finally(() => {
            running = false;
          });
      } catch (err) {
        // Synchronous throw (e.g. from require()) — processDue() never ran.
        running = false;
        if (__DEV__) console.warn('[global-scheduler] error in runner:', err);
      }
    };

    // Run immediately on identity-ready/launch instead of waiting for the
    // first 10s tick — a post scheduled while the app was backgrounded/closed
    // must fire the instant the app reopens, not up to 10s later. The
    // BackgroundFetch task above is the real fallback while backgrounded; this
    // catch-up run covers the (common) case where the OS never actually woke
    // the background task before the user reopened the app themselves.
    runDue();
    const foregroundSub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') runDue();
    });

    const interval = setInterval(runDue, 10_000);

    return () => {
      clearInterval(interval);
      foregroundSub.remove();
    };
  }, [identity, status]);

  // Show NetworkErrorScreen after 5s of being offline (only when authenticated).
  useEffect(() => {
    if (!identity) return;
    // Suppress network errors in decoy mode — no connection is intentional
    if (usePreferences.getState().duressActive) return;
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
      // Never connect with the decoy identity — doing so leaks that panic mode is active
      if (usePreferences.getState().duressActive) return;
      connectSocket(identity);
      if (WEBRTC_AVAILABLE) {
        attachCallHandlers();
        attachGroupCallHandlers();
      }
      setNotificationOpenChatHandler((target) => {
        // Channel post tap → open the channel feed by id. No lookup needed
        // (unlike group/contact) — ChannelFeedScreen resolves the channel from
        // its own hydrated `subscribed` list, and self-hydrates if it hasn't
        // run yet (see ChannelFeed.tsx).
        if (target.channelId) {
          setStack([]);
          push({ name: 'channelFeed', channelId: target.channelId });
          return;
        }
        // Group tap → open the group chat by id.
        if (target.groupId) {
          const { useGroups } = require('./src/store/groups');
          const group = useGroups.getState().groups.find((g: { id: string }) => g.id === target.groupId);
          if (group) { setStack([]); push({ name: 'groupChat', group }); }
          return;
        }
        // 1:1 tap → open the contact chat.
        if (target.aegisId) {
          const { useContacts } = require('./src/store/contacts');
          const contact = useContacts.getState().contacts.find((c: StoredContact) => c.aegisId === target.aegisId);
          if (contact) { setStack([]); push({ name: 'chat', contact }); }
        }
      });
      void registerForPush(identity);
      initCallKeep();
    } else if (!identity && status === 'idle') {
      disconnectSocket();
      clearTurnCache();
      setStack([]);
    }
  }, [identity, status]);

  // Re-attach call handlers whenever the connection comes back. A reconnect can
  // rebuild the socket.io instance (disconnect() nulls it), which silently drops
  // the call:invite listener — so an incoming call would never ring after any
  // reconnect until app restart. attach*Handlers are idempotent (they off()
  // before on()), so re-running them here is safe.
  useEffect(() => {
    if (online && identity && status === 'ready' && WEBRTC_AVAILABLE) {
      if (usePreferences.getState().duressActive) return;
      attachCallHandlers();
      attachGroupCallHandlers();
    }
  }, [online, identity, status]);

  // Runtime integrity advisory (C1) — local-only, zero telemetry, NON-blocking.
  // Surface a one-time notice if the device looks rooted/hooked; never prevent
  // usage. The enforced consequence (refusing off-device key export) lives in
  // backupUploadAllowed().
  useEffect(() => {
    void (async () => {
      try {
        const { checkIntegrity } = require('./src/security/integrity') as typeof import('./src/security/integrity');
        const r = await checkIntegrity();
        if (!r.compromised) return;
        const { ss } = require('./src/utils/secureStore') as typeof import('./src/utils/secureStore');
        const ACK = 'aegis.integrity.ack.v1';
        if (await ss.get(ACK)) return;
        const { themedAlert } = require('./src/components/AlertHost') as typeof import('./src/components/AlertHost');
        themedAlert(
          'Dispositivo no seguro',
          'Este dispositivo parece tener root o un hook activo. AegisLink no puede garantizar el aislamiento de tus claves aquí, así que la copia de seguridad fuera del dispositivo queda desactivada. Tus mensajes siguen cifrados de extremo a extremo.',
          [{ text: 'Entendido', onPress: () => void ss.set(ACK, '1') }],
        );
      } catch { /* detection unavailable — never block */ }
    })();
  }, []);

  const push = useCallback((r: PushRoute) => setStack((s) => [...s, r]), []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  // ── Panic gesture ───────────────────────────────────────────────────────────
  const triggerPanic = useCallback(async () => {
    setShowWipeOverlay(true);
    // Allow the overlay to render before blocking with async I/O
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    try {
      const { wipeDatabase } = require('./src/db/local') as typeof import('./src/db/local');
      await wipeDatabase();
      const { useIdentity: _useIdentity } = require('./src/store/identity') as typeof import('./src/store/identity');
      await _useIdentity.getState().reset();
    } catch {
      /* wipe failure: app state is now invalid — identity reset forces re-onboarding */
    }
    setShowWipeOverlay(false);
  }, []);

  async function handleFilePick(
    contact: StoredContact,
    onMultiple?: (assets: import('expo-document-picker').DocumentPickerAsset[]) => void
  ) {
    const DocumentPicker = require('expo-document-picker');
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
    if (result.canceled || !result.assets?.[0]) return;
    const assets: import('expo-document-picker').DocumentPickerAsset[] = result.assets;
    if (assets.length > 1) {
      if (onMultiple) {
        onMultiple(assets);
      } else {
        await handleMultipleFiles(contact, assets);
      }
      return;
    }
    const asset = assets[0];
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

  async function handleMultipleImages(
    contact: StoredContact,
    assets: import('expo-image-picker').ImagePickerAsset[],
    caption = ''
  ) {
    if (!identity || assets.length === 0) return;
    const { encryptAndUploadAll } = require('./src/crypto/media') as typeof import('./src/crypto/media');
    const { buildMultiPayload } = require('./src/utils/attachmentFormat') as typeof import('./src/utils/attachmentFormat');
    const { useMessages } = require('./src/store/messages') as typeof import('./src/store/messages');
    const { sendMessage } = require('./src/socket/client');
    const { decodeBase64 } = require('tweetnacl-util');
    const { randomUUID } = await import('expo-crypto');
    const msgId = randomUUID();
    const pendingAttachments: import('./src/db/local').Attachment[] = assets.map((a) => ({
      type: 'image' as const,
      uri: a.uri,
      width: a.width ?? undefined,
      height: a.height ?? undefined,
    }));
    await useMessages.getState().append({
      id: msgId,
      chatId: contact.aegisId,
      direction: 'out',
      body: '',
      createdAt: Date.now(),
      type: 'image',
      attachments: pendingAttachments,
    });
    try {
      const items = assets.map((a) => ({
        uri: a.uri,
        type: 'image/jpeg',
        width: a.width ?? undefined,
        height: a.height ?? undefined,
      }));
      const uploaded = await encryptAndUploadAll(items);
      await useMessages.getState().setAttachments(contact.aegisId, msgId, uploaded);
      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: buildMultiPayload(uploaded, caption),
        skipLocalAppend: true,
      });
    } catch { /* queued */ }
  }

  async function handleMultipleFiles(
    contact: StoredContact,
    assets: import('expo-document-picker').DocumentPickerAsset[],
    caption = ''
  ) {
    if (!identity || assets.length === 0) return;
    const { encryptAndUploadAll } = require('./src/crypto/media') as typeof import('./src/crypto/media');
    const { buildMultiPayload } = require('./src/utils/attachmentFormat') as typeof import('./src/utils/attachmentFormat');
    const { useMessages } = require('./src/store/messages') as typeof import('./src/store/messages');
    const { sendMessage } = require('./src/socket/client');
    const { decodeBase64 } = require('tweetnacl-util');
    const { randomUUID } = await import('expo-crypto');
    const msgId = randomUUID();
    const pendingAttachments: import('./src/db/local').Attachment[] = assets.map((a) => ({
      type: 'file' as const,
      uri: a.uri,
      fileName: a.name ?? 'file',
      mimeType: a.mimeType ?? undefined,
    }));
    await useMessages.getState().append({
      id: msgId,
      chatId: contact.aegisId,
      direction: 'out',
      body: assets.map((a) => a.name ?? 'file').join(', '),
      createdAt: Date.now(),
      type: 'file',
      attachments: pendingAttachments,
    });
    try {
      const items = assets.map((a) => ({
        uri: a.uri,
        type: a.mimeType ?? undefined,
        fileName: a.name ?? 'file',
      }));
      const uploaded = await encryptAndUploadAll(items);
      await useMessages.getState().setAttachments(contact.aegisId, msgId, uploaded);
      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: buildMultiPayload(uploaded, caption),
        skipLocalAppend: true,
      });
    } catch { /* queued */ }
  }

  async function handleGroupFilePick(
    group: StoredGroup,
    onMultiple?: (assets: import('expo-document-picker').DocumentPickerAsset[]) => void
  ) {
    const DocumentPicker = require('expo-document-picker');
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
    if (result.canceled || !result.assets?.[0]) return;
    const assets: import('expo-document-picker').DocumentPickerAsset[] = result.assets;
    if (assets.length > 1) {
      if (onMultiple) {
        onMultiple(assets);
      } else {
        await handleGroupMultipleFiles(group, assets);
      }
      return;
    }
    const asset = assets[0];
    const { useMessages } = require('./src/store/messages');
    const id = (await import('expo-crypto')).randomUUID();
    await useMessages.getState().append({
      id,
      chatId: group.id,
      direction: 'out',
      body: asset.name ?? 'archivo',
      createdAt: Date.now(),
      type: 'file',
      mediaUri: asset.uri,
    });
    if (identity) {
      const { sendGroupMessage: sendGrpMsg } = require('./src/socket/client');
      const { encryptAndUploadMedia } = require('./src/crypto/media');
      try {
        const blobUri: string = await encryptAndUploadMedia(asset.uri);
        await sendGrpMsg({
          identity,
          groupId: group.id,
          plaintext: `[file:${asset.name}:${blobUri}]`,
        });
      } catch { /* queued when offline */ }
    }
  }

  async function handleGroupMultipleImages(
    group: StoredGroup,
    assets: import('expo-image-picker').ImagePickerAsset[],
    caption = ''
  ) {
    if (!identity || assets.length === 0) return;
    const { encryptAndUploadAll } = require('./src/crypto/media') as typeof import('./src/crypto/media');
    const { buildMultiPayload } = require('./src/utils/attachmentFormat') as typeof import('./src/utils/attachmentFormat');
    const { useMessages } = require('./src/store/messages') as typeof import('./src/store/messages');
    const { sendGroupMessage: sendGrpMsg } = require('./src/socket/client');
    const { randomUUID } = await import('expo-crypto');
    const msgId = randomUUID();
    const pendingAttachments: import('./src/db/local').Attachment[] = assets.map((a) => ({
      type: 'image' as const,
      uri: a.uri,
      width: a.width ?? undefined,
      height: a.height ?? undefined,
    }));
    await useMessages.getState().append({
      id: msgId,
      chatId: group.id,
      direction: 'out',
      body: '',
      createdAt: Date.now(),
      type: 'image',
      attachments: pendingAttachments,
    });
    try {
      const items = assets.map((a) => ({
        uri: a.uri,
        type: 'image/jpeg',
        width: a.width ?? undefined,
        height: a.height ?? undefined,
      }));
      const uploaded = await encryptAndUploadAll(items);
      await useMessages.getState().setAttachments(group.id, msgId, uploaded);
      await sendGrpMsg({
        identity,
        groupId: group.id,
        plaintext: buildMultiPayload(uploaded, caption),
        skipLocalAppend: true,
      });
    } catch { /* queued */ }
  }

  async function handleGroupMultipleFiles(
    group: StoredGroup,
    assets: import('expo-document-picker').DocumentPickerAsset[],
    caption = ''
  ) {
    if (!identity || assets.length === 0) return;
    const { encryptAndUploadAll } = require('./src/crypto/media') as typeof import('./src/crypto/media');
    const { buildMultiPayload } = require('./src/utils/attachmentFormat') as typeof import('./src/utils/attachmentFormat');
    const { useMessages } = require('./src/store/messages') as typeof import('./src/store/messages');
    const { sendGroupMessage: sendGrpMsg } = require('./src/socket/client');
    const { randomUUID } = await import('expo-crypto');
    const msgId = randomUUID();
    const pendingAttachments: import('./src/db/local').Attachment[] = assets.map((a) => ({
      type: 'file' as const,
      uri: a.uri,
      fileName: a.name ?? 'file',
      mimeType: a.mimeType ?? undefined,
    }));
    await useMessages.getState().append({
      id: msgId,
      chatId: group.id,
      direction: 'out',
      body: assets.map((a) => a.name ?? 'file').join(', '),
      createdAt: Date.now(),
      type: 'file',
      attachments: pendingAttachments,
    });
    try {
      const items = assets.map((a) => ({
        uri: a.uri,
        type: a.mimeType ?? undefined,
        fileName: a.name ?? 'file',
      }));
      const uploaded = await encryptAndUploadAll(items);
      await useMessages.getState().setAttachments(group.id, msgId, uploaded);
      await sendGrpMsg({
        identity,
        groupId: group.id,
        plaintext: buildMultiPayload(uploaded, caption),
        skipLocalAppend: true,
      });
    } catch { /* queued */ }
  }

  async function handleVideoPick(contact: StoredContact) {
    const ImagePicker = require('expo-image-picker') as typeof import('expo-image-picker');
    const { withPickingGuard } = require('./src/utils/pickingGuard') as typeof import('./src/utils/pickingGuard');
    const result = await withPickingGuard(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'] as import('expo-image-picker').MediaType[],
        quality: 1,
      })
    );
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    const { useMessages } = require('./src/store/messages');
    const { randomUUID } = await import('expo-crypto');
    const id = randomUUID();
    await useMessages.getState().append({
      id,
      chatId: contact.aegisId,
      direction: 'out',
      body: '',
      createdAt: Date.now(),
      type: 'video',
      mediaUri: asset.uri,
    });

    if (identity) {
      const { sendMessage } = require('./src/socket/client');
      const { decodeBase64 } = require('tweetnacl-util');
      const { encryptAndUploadMedia } = require('./src/crypto/media');
      try {
        const blobUri: string = await encryptAndUploadMedia(asset.uri, 'video/mp4');
        await sendMessage({
          identity,
          recipientAegisId: contact.aegisId,
          recipientPublicKey: decodeBase64(contact.publicKeyB64),
          plaintext: `[video:${blobUri}]`,
          skipLocalAppend: true,
        });
      } catch { /* queued */ }
    }
  }

  async function handleGroupVideoPick(group: StoredGroup) {
    const ImagePicker = require('expo-image-picker') as typeof import('expo-image-picker');
    const { withPickingGuard } = require('./src/utils/pickingGuard') as typeof import('./src/utils/pickingGuard');
    const result = await withPickingGuard(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'] as import('expo-image-picker').MediaType[],
        quality: 1,
      })
    );
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    const { useMessages } = require('./src/store/messages');
    const { randomUUID: _uuid } = await import('expo-crypto');
    const id = _uuid();
    await useMessages.getState().append({
      id,
      chatId: group.id,
      direction: 'out',
      body: '',
      createdAt: Date.now(),
      type: 'video',
      mediaUri: asset.uri,
    });

    if (identity) {
      const { sendGroupMessage: _sg } = require('./src/socket/client');
      const { encryptAndUploadMedia: _eu } = require('./src/crypto/media');
      try {
        const blobUri: string = await _eu(asset.uri, 'video/mp4');
        await _sg({ identity, groupId: group.id, plaintext: `[video:${blobUri}]`, skipLocalAppend: true });
      } catch { /* queued */ }
    }
  }

  const popAllTo = useCallback((tabId: Tab) => {
    setStack([]);
    setTab(tabId);
  }, []);

  // ── Compartir contacto (1:1 y grupos) — Vault sheet, no Alert nativo ───────
  const [contactShare, setContactShare] = useState<{
    isGroup: boolean;
    targetId: string;
    targetKeyB64?: string;
    exclude: string[];
  } | null>(null);

  const shareContactCard = useCallback(async (picked: StoredContact) => {
    const share = contactShare;
    setContactShare(null);
    if (!share) return;
    const body = `[contact:${picked.name}:${picked.aegisId}]`;
    const { useMessages } = require('./src/store/messages');
    const { randomUUID } = await import('expo-crypto');
    await useMessages.getState().append({
      id: randomUUID(),
      chatId: share.targetId,
      direction: 'out',
      body,
      createdAt: Date.now(),
      type: 'text',
    });
    if (identity) {
      try {
        if (share.isGroup) {
          const { sendGroupMessage } = require('./src/socket/client');
          await sendGroupMessage({ identity, groupId: share.targetId, plaintext: body, skipLocalAppend: true });
        } else {
          const { sendMessage } = require('./src/socket/client');
          const { decodeBase64 } = require('tweetnacl-util');
          await sendMessage({
            identity,
            recipientAegisId: share.targetId,
            recipientPublicKey: decodeBase64(share.targetKeyB64 ?? ''),
            plaintext: body,
          });
        }
      } catch { /* queued by outbox */ }
    }
    pop(); // close the attach screen under the sheet
  }, [contactShare, identity, pop]);

  // ── Deep link handling ──────────────────────────────────────────────────────
  const handleDeepLink = useCallback(async (url: string) => {
    // https universal links (aegislink.duckdns.org/g#…, /a#…) normalize to
    // their aegislink:// equivalent. Panic has NO universal form by design —
    // only the raw scheme can ever reach the wipe branch below.
    const { universalToScheme } = require('./src/crypto/qr') as typeof import('./src/crypto/qr');
    url = universalToScheme(url) ?? url;
    if (!url.startsWith('aegislink://')) return;

    // Remote panic wipe — handlePanicDeepLink does full Ed25519 + token
    // verification before touching any data. We show the WIPING overlay
    // immediately (prevents flash of app content) and clear it on failure.
    if (url.startsWith('aegislink://panic')) {
      setShowWipeOverlay(true);
      const wiped = await handlePanicDeepLink(url);
      if (wiped) {
        // Wipe + identity reset completed inside handlePanicDeepLink.
        // Brief pause so the overlay is visible before shell unmounts.
        await new Promise<void>((r) => setTimeout(r, 600));
      }
      // Always clear the overlay — on failure this restores the app UI,
      // on success the identity reset already triggered a shell re-render
      // to the onboarding screen.
      setShowWipeOverlay(false);
      return;
    }

    // Group invite: aegislink://group/v1/<groupId>/<groupName>/<adminId>
    if (url.startsWith('aegislink://group/v1/')) {
      const { parseGroupInviteLink } = require('./src/crypto/qr') as typeof import('./src/crypto/qr');
      const parsed = parseGroupInviteLink(url);
      if (parsed) {
        push({ name: 'groupJoin', groupId: parsed.groupId, groupName: parsed.groupName, adminId: parsed.adminId });
      }
      return;
    }

    // Contact link: aegislink://v1/<AEGIS_ID>/<pubkeyB64> — same payload as the
    // identity QR. Confirm before adding (TOFU via addFromQR, which detects a
    // key change for an existing contact and refuses to overwrite silently).
    if (url.startsWith('aegislink://v1/')) {
      const { parseIdentityQR } = require('./src/crypto/qr') as typeof import('./src/crypto/qr');
      const parsed = parseIdentityQR(url);
      if (!parsed) return;
      const { themedAlert: _themedAlert } = require('./src/components/AlertHost') as typeof import('./src/components/AlertHost');
      _themedAlert(
        i18nT('addContact.linkConfirmTitle', 'Agregar contacto'),
        i18nT('addContact.linkConfirmDesc', '¿Agregar a {{id}} como contacto?', { id: parsed.aegisId }),
        [
          { text: i18nT('common.cancel', 'Cancelar'), style: 'cancel' },
          {
            text: i18nT('addContact.linkConfirmAdd', 'Agregar'),
            onPress: () => {
              void (async () => {
                const { useContacts } = require('./src/store/contacts') as typeof import('./src/store/contacts');
                const res = await useContacts.getState().addFromQR(parsed.aegisId, parsed.publicKeyB64);
                if (res.kind === 'mitm_detected') {
                  _themedAlert(
                    i18nT('addContact.keyMismatchTitle', 'Clave distinta'),
                    i18nT('addContact.keyMismatchDesc', 'Ya tienes este contacto con OTRA clave pública. No se ha modificado. Verifica con la otra persona antes de continuar.'),
                  );
                  return;
                }
                const contact = res.contact;
                if (contact) push({ name: 'contact', contact });
              })();
            },
          },
        ],
      );
      return;
    }
  }, [push, i18nT]);

  useEffect(() => {
    Linking.getInitialURL().then((url: string | null) => {
      if (url) void handleDeepLink(url);
    }).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }: { url: string }) => void handleDeepLink(url));
    return () => sub.remove();
  }, [handleDeepLink]);

  // Call overlay state
  const callStatus = useCall((s) => s.status);
  const callMinimized = useCall((s) => s.minimized);
  const callOverlay =
    callStatus === 'outgoing-ringing' ||
    callStatus === 'connecting' ||
    callStatus === 'in-call' ||
    callStatus === 'ended';
  const incomingCall = callStatus === 'incoming-ringing';

  // Group call overlay state
  const groupCallStatus = useGroupCall((s) => s.status);
  const groupCallId = useGroupCall((s) => s.callId);
  const groupCallInitiator = useGroupCall((s) => s.initiator);
  const incomingGroupCall = groupCallStatus === 'ringing-in';
  // 'in-call' and 'connecting' are handled inline by GroupChatScreen's InCallGroupBar.
  // We only show a full-screen overlay for legacy ringing-out (transitional) state.
  const groupCallOverlay = groupCallStatus === 'ringing-out';

  if (showWipeOverlay) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        <I.Shield size={44} color="#ff4444" stroke={1.5} />
        <Text style={{ color: '#ff4444', fontFamily: 'monospace', fontSize: 12, letterSpacing: 3, marginTop: 28 }}>
          WIPING DATA
        </Text>
      </View>
    );
  }

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
        dbReady={dbReady}
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
        onPanic={() => void triggerPanic()}
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
  // Full-screen call UI — skipped when the user has minimized the call,
  // in which case FloatingCallBarRoot (sibling of Shell in App) handles the overlay.
  if (callOverlay && !callMinimized) {
    return (
      <CallScreen
        onClose={() => { /* call store resets itself via useEffect in CallScreen */ }}
        onMinimize={() => useCall.getState().setMinimized(true)}
      />
    );
  }

  // Group call incoming
  if (incomingGroupCall && groupCallId && groupCallInitiator) {
    return (
      <IncomingGroupCallScreen
        onAccept={() => void acceptGroupCall(groupCallId, groupCallInitiator)}
        onReject={() => declineGroupCall(groupCallId, groupCallInitiator)}
      />
    );
  }
  // Group call active
  if (groupCallOverlay) {
    return (
      <GroupCallScreen
        onClose={() => { /* group call store resets itself */ }}
      />
    );
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
            onEphemeral={() => push({ name: 'ephemeral', chatId: top.contact.aegisId })}
            onViewOnce={(mediaUri, messageId) => push({ name: 'viewonce', contact: top.contact, mediaUri, messageId })}
            onVerify={() => push({ name: 'verify', contactId: top.contact.aegisId })}
          />
        );
      case 'groupChat':
        return (
          <GroupChatScreen
            group={top.group}
            onBack={pop}
            onGroupDetail={() => push({ name: 'groupadmin', group: top.group })}
            onPoll={() => push({ name: 'poll', group: top.group })}
            onAttach={() => push({ name: 'groupAttach', group: top.group })}
            onGroupCall={() => push({ name: 'groupCall' })}
            onSchedulePost={(draftText) => push({ name: 'groupPosts', group: top.group, initialText: draftText })}
          />
        );
      case 'groupPosts':
        return (
          <GroupPostsScreen
            group={top.group}
            initialText={top.initialText}
            onBack={pop}
          />
        );
      case 'groupCall':
        return (
          <GroupCallScreen
            onClose={pop}
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
            onEphemeral={() => push({ name: 'ephemeral', chatId: top.contact.aegisId })}
            onVerify={() => push({ name: 'verify', contactId: top.contact.aegisId })}
          />
        );
      case 'add':
        return (
          <AddContactScreen
            onCancel={pop}
            onAdded={(c) => {
              setStack([]);
              push({ name: 'firstContact', contact: c });
            }}
          />
        );
      case 'scan':
        return (
          <ScanQRScreen
            onCancel={pop}
            onAdded={(c) => {
              setStack([]);
              push({ name: 'firstContact', contact: c });
            }}
            onGroupInvite={(groupId, groupName, adminId) => {
              pop();
              push({ name: 'groupJoin', groupId, groupName, adminId });
            }}
          />
        );
      case 'verify':
        return (
          <VerifyScreen
            onBack={pop}
            onScan={() => push({ name: 'scan' })}
            contactId={top.contactId}
          />
        );
      case 'profile':
        return (
          <ProfileScreen
            onBack={pop}
            onKeys={() => push({ name: 'keys' })}
            onDevices={() => push({ name: 'devices' })}
            onAppIcon={() => push({ name: 'appIcon' })}
            onExport={() => push({ name: 'export' })}
            onProfileSwitcher={() => push({ name: 'profileSwitcher' })}
          />
        );
      case 'appIcon':
        return <AppIconScreen onBack={pop} />;
      case 'keys':
        return <KeysScreen onBack={pop} />;
      case 'channelDiscover':
        return (
          <ChannelDiscoverScreen
            onBack={pop}
            onOpenChannel={(channelId) => push({ name: 'channelFeed', channelId })}
          />
        );
      case 'channelCreate':
        return <ChannelCreateScreen onBack={pop} onCreated={pop} />;
      case 'channelFeed':
        return <ChannelFeedScreen channelId={top.channelId} onBack={pop} onOpenInfo={() => push({ name: 'channelInfo', channelId: top.channelId })} />;
      case 'channelInfo':
        return <ChannelInfoScreen channelId={top.channelId} onBack={pop} />;
      case 'distribution':
        return (
          <DistributionListsScreen
            onBack={pop}
            onOpenList={(list) => push({ name: 'broadcast', list })}
          />
        );
      case 'broadcast':
        return (
          <BroadcastComposeScreen
            list={top.list}
            onBack={pop}
          />
        );
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
        return <LockScreen onUnlock={pop} onPanic={() => void triggerPanic()} />;
      case 'panic':
        return <PanicScreen onBack={pop} />;
      case 'ephemeral':
        return <EphemeralScreen onBack={pop} chatId={top.chatId} />;
      case 'export':
        return <DataExportScreen onBack={pop} />;
      case 'attach':
        return (
          <AttachSheetScreen
            onBack={pop}
            onMultipleImages={(assets) => {
              // Bug B fix: AttachSheet no longer calls onBack() for multi-select
              // (see AttachSheet.tsx). We do the single pop here, then push the
              // preview screen. Previously there were two pops which dropped the
              // user all the way to the home screen.
              // Bug C fix: go to MultiPreview instead of sending silently.
              const mapped: MultiPreviewAsset[] = assets.map((a) => ({ kind: 'image' as const, asset: a }));
              pop();
              push({ name: 'multiPreview', contact: top.contact, assets: mapped });
            }}
            onMultipleFiles={(assets) => {
              const mapped: MultiPreviewAsset[] = assets.map((a) => ({ kind: 'file' as const, asset: a }));
              pop();
              push({ name: 'multiPreview', contact: top.contact, assets: mapped });
            }}
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
                handleFilePick(top.contact, (fileAssets) => {
                  const mapped: MultiPreviewAsset[] = fileAssets.map((a) => ({ kind: 'file' as const, asset: a }));
                  pop();
                  push({ name: 'multiPreview', contact: top.contact, assets: mapped });
                }).catch(() => { pop(); });
              } else if (kind === 'video') {
                handleVideoPick(top.contact).then(pop).catch(() => {});
              } else if (kind === 'contact') {
                setContactShare({
                  isGroup: false,
                  targetId: top.contact.aegisId,
                  targetKeyB64: top.contact.publicKeyB64,
                  exclude: [top.contact.aegisId],
                });
              }
              else pop();
            }}
          />
        );
      case 'multiPreview':
        return (
          <MultiPreviewScreen
            assets={top.assets}
            recipientName={top.contact.name}
            onBack={pop}
            onSend={(assets, caption) => {
              pop(); // return to chat immediately; upload happens in background
              const imageAssets = assets
                .filter((a): a is Extract<MultiPreviewAsset, { kind: 'image' }> => a.kind === 'image')
                .map((a) => a.asset);
              const fileAssets = assets
                .filter((a): a is Extract<MultiPreviewAsset, { kind: 'file' }> => a.kind === 'file')
                .map((a) => a.asset);
              if (imageAssets.length > 0) {
                void handleMultipleImages(top.contact, imageAssets, caption).catch(() => {});
              }
              if (fileAssets.length > 0) {
                void handleMultipleFiles(top.contact, fileAssets, caption).catch(() => {});
              }
            }}
          />
        );
      case 'groupMultiPreview':
        return (
          <MultiPreviewScreen
            assets={top.assets}
            recipientName={top.group.name}
            onBack={pop}
            onSend={(assets, caption) => {
              pop();
              const imageAssets = assets
                .filter((a): a is Extract<MultiPreviewAsset, { kind: 'image' }> => a.kind === 'image')
                .map((a) => a.asset);
              const fileAssets = assets
                .filter((a): a is Extract<MultiPreviewAsset, { kind: 'file' }> => a.kind === 'file')
                .map((a) => a.asset);
              if (imageAssets.length > 0) {
                void handleGroupMultipleImages(top.group, imageAssets, caption).catch(() => {});
              }
              if (fileAssets.length > 0) {
                void handleGroupMultipleFiles(top.group, fileAssets, caption).catch(() => {});
              }
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
        return <ScheduledScreen onBack={pop} />;
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
      case 'groupAttach':
        return (
          <AttachSheetScreen
            isGroup={true}
            onBack={pop}
            onMultipleImages={(assets) => {
              const mapped: MultiPreviewAsset[] = assets.map((a) => ({ kind: 'image' as const, asset: a }));
              pop();
              push({ name: 'groupMultiPreview', group: top.group, assets: mapped });
            }}
            onMultipleFiles={(assets) => {
              const mapped: MultiPreviewAsset[] = assets.map((a) => ({ kind: 'file' as const, asset: a }));
              pop();
              push({ name: 'groupMultiPreview', group: top.group, assets: mapped });
            }}
            onPick={(kind) => {
              // photo / camera are handled internally by AttachSheetScreen via
              // setPendingMedia — they never reach onPick. The cases below cover
              // all the explicit-tap options.
              if (kind === 'voice') {
                pop();
                push({ name: 'groupVoice', group: top.group });
              } else if (kind === 'file') {
                handleGroupFilePick(top.group, (fileAssets) => {
                  const mapped: MultiPreviewAsset[] = fileAssets.map((a) => ({ kind: 'file' as const, asset: a }));
                  pop();
                  push({ name: 'groupMultiPreview', group: top.group, assets: mapped });
                }).catch(() => { pop(); });
              } else if (kind === 'video') {
                handleGroupVideoPick(top.group).then(pop).catch(() => {});
              } else if (kind === 'contact') {
                setContactShare({
                  isGroup: true,
                  targetId: top.group.id,
                  exclude: top.group.members,
                });
              } else {
                // scheduled, location, viewoncesend — not yet implemented for groups
                pop();
              }
            }}
          />
        );
      case 'groupVoice':
        return (
          <VoiceRecorderScreen
            onBack={pop}
            onSend={async (uri, durationMs) => {
              if (!identity) { pop(); return; }
              const { randomUUID: _uuid } = await import('expo-crypto');
              const id = _uuid();
              const { useMessages: _um } = require('./src/store/messages');
              const durationSec = Math.round(durationMs / 1000);
              await _um.getState().append({
                id,
                chatId: top.group.id,
                direction: 'out',
                body: `[audio:${durationSec}s]`,
                createdAt: Date.now(),
                type: 'audio',
                mediaUri: uri,
              });
              const { sendGroupMessage: _sg } = require('./src/socket/client');
              const { encryptAndUploadMedia: _eu } = require('./src/crypto/media');
              try {
                const blobUri: string = await _eu(uri);
                await _sg({ identity, groupId: top.group.id, plaintext: `[audio:${durationSec}s:${blobUri}]` });
              } catch { /* queued */ }
              pop();
            }}
          />
        );
      case 'groupJoin':
        return (
          <GroupJoinScreen
            groupId={top.groupId}
            groupName={top.groupName}
            adminId={top.adminId}
            onBack={pop}
            onOpenGroup={(group) => { setStack([]); push({ name: 'groupChat', group }); }}
            onAddContact={() => { pop(); push({ name: 'add' }); }}
          />
        );
      case 'groupadmin':
        return (
          <GroupAdminScreen
            group={top.group}
            onBack={pop}
            onOpenPosts={() => push({ name: 'groupPosts', group: top.group })}
          />
        );
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
                  msgType: 'poll',
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
            onAddAnother={() => { setStack([]); push({ name: 'add' }); }}
          />
        );
      case 'contacts':
        return (
          <ContactsScreen
            onBack={pop}
            onAddContact={() => push({ name: 'add' })}
            onOpenContact={(contact) => push({ name: 'contact', contact })}
            onChat={(contact) => push({ name: 'chat', contact })}
          />
        );
      case 'profileSwitcher':
        return (
          <ProfileSwitcherScreen
            onBack={pop}
            onCreateProfile={() => push({ name: 'createProfile' })}
          />
        );
      case 'createProfile':
        return (
          <CreateProfileScreen
            onBack={pop}
            onCreated={() => { setStack([]); setTab('home'); }}
          />
        );
    }
    }
    return (
      <AnimatedScreen stackDepth={stack.length}>
        {renderTop() ?? null}
        <ContactPickerSheet
          t={t}
          visible={contactShare !== null}
          contacts={allContacts.filter((c) => !(contactShare?.exclude ?? []).includes(c.aegisId))}
          title={i18nT('attach.shareContactTitle', 'Compartir contacto')}
          emptyText={i18nT('attach.shareContactEmpty', 'No tienes contactos disponibles para compartir.')}
          trailingIcon="send"
          onClose={() => setContactShare(null)}
          onPick={(c) => { void shareContactCard(c); }}
        />
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
            onAddContact={() => push({ name: 'add' })}
            onSearch={() => push({ name: 'search' })}
            onProfile={() => push({ name: 'profile' })}
            onContacts={() => push({ name: 'contacts' })}
            onDistribution={() => push({ name: 'distribution' })}
            onProfileSwitcher={() => push({ name: 'profileSwitcher' })}
            onTab={setTab}
          />
        </View>
      );
    case 'groups':
      return (
        <GroupsScreen
          onTab={setTab}
          onOpenGroupChat={(group) => push({ name: 'groupChat', group })}
          onJoinByLink={(groupId, groupName, adminId) =>
            push({ name: 'groupJoin', groupId, groupName, adminId })
          }
          onOpenChannel={(channelId) => push({ name: 'channelFeed', channelId })}
          onDiscoverChannels={() => push({ name: 'channelDiscover' })}
          onCreateChannel={() => push({ name: 'channelCreate' })}
          initialSeg={groupsSeg}
          onSegChange={setGroupsSeg}
        />
      );
    case 'settings':
      return (
        <PrivacyScreen
          onTab={setTab}
          onNav={(name) => push({ name } as PushRoute)}
        />
      );
  }
}

/**
 * Renders the FloatingCallBar when the user has minimized the call UI.
 * Lives OUTSIDE Shell so it can overlay any screen in the navigation stack
 * without Shell needing to track call state in its render logic.
 *
 * Situation matrix:
 *   in-call + minimized=true  → renders the bar
 *   in-call + minimized=false → Shell shows full CallScreen (bar is null)
 *   ended / connecting        → setStatus auto-resets minimized=false → bar is null
 *   outgoing-ringing          → minimized is always false → bar is null
 *   incoming-ringing          → IncomingCallScreen (full-screen), bar is null
 *   app lock triggers         → LockScreen (higher priority in Shell), bar is null
 *     (WebRTC audio continues; bar reappears after unlock since Zustand persists)
 *   other person hangs up     → setStatus('ended') resets minimized → full CallScreen briefly
 *   app backgrounded          → bar state persists in memory; visible on return
 */
function FloatingCallBarRoot() {
  const status = useCall((s) => s.status);
  const minimized = useCall((s) => s.minimized);

  if (status !== 'in-call' || !minimized) return null;

  return (
    <FloatingCallBar
      onExpand={() => useCall.getState().setMinimized(false)}
    />
  );
}

/**
 * Shows a floating group-call bar when the user is in a group call but has
 * navigated away from the GroupChatScreen (minimized=true in the store).
 */
function FloatingGroupCallBarRoot() {
  const status = useGroupCall((s) => s.status);
  const minimized = useGroupCall((s) => s.minimized);
  const groupId = useGroupCall((s) => s.groupId);

  if (status !== 'in-call' || !minimized) return null;

  return (
    <FloatingGroupCallBar
      onExpand={() => {
        useGroupCall.getState().setMinimized(false);
        // Navigate to the group chat — find it in the nav stack or push groupCall
        // We can't directly access push() here; the expand is handled by tapping
        // the bar which calls onExpand. For now we just un-minimize and the
        // GroupChatScreen's useEffect will pick it up once the user navigates back.
        void groupId; // keep reference in case we add direct navigation later
      }}
    />
  );
}

export default function App() {
  // Load the VAULT brand fonts (Space Grotesk + JetBrains Mono) before render so
  // screens match the prototype. Render proceeds on error too — a font failure
  // must never brick the UI; RN falls back to the system font in that case.
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ErrorBoundary onError={(e) => logger.error('Uncaught React boundary error:', e)}>
          <StatusBar style="auto" />
          <Shell />
          {/* FloatingCallBar overlays any screen for minimized 1:1 calls */}
          <FloatingCallBarRoot />
          {/* FloatingGroupCallBar overlays any screen for minimized group calls */}
          <FloatingGroupCallBarRoot />
          {/* AlertHost mounts once inside ThemeProvider so themedAlert() has theme access */}
          <AlertHost />
        </ErrorBoundary>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
