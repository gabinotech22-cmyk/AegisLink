// CRITICAL: install the crypto RNG sources (TweetNaCl PRNG + @noble's
// globalThis.crypto.getRandomValues) BEFORE any other import. See cryptoSetup.ts
// for why this must be the very first import (ESM hoisting + @noble capturing
// crypto at module-load time).
import './cryptoSetup';

// Define the background notification task at module load — BEFORE App mounts —
// so it exists when the OS launches us headless from a wake-up push.
import './src/notifications/backgroundReconnect';
// Same for the channel background-sync task (device-scheduled delta pull —
// leak-free channel notifications, no server push). Must be defined before a
// headless BGAppRefresh / background-fetch launch can fire it.
import './src/notifications/channelBackgroundSync';
// Same for the daily-summary background-fetch task — TaskManager.defineTask
// must run at module load so the OS can find 'aegis.daily-summary' when it
// launches us headless, before App ever mounts.
import './src/notifications/dailySummaryTask';

// Register the persistent call-wake headless task (Android) BEFORE App mounts,
// so AegisWakeService can find "AegisCallWake" when it launches us headless
// (START_STICKY restart or boot receiver). No-op on iOS / Expo Go / jest.
import { registerCallWakeTask } from './src/webrtc/callWakeTask';
registerCallWakeTask();

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
