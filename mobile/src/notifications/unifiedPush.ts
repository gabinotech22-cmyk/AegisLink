/**
 * UnifiedPush — app-killed wake on Android without Google (Slice 2b.3c,
 * docs/FASE4-SLICE2B-PUSH-DESIGN.md §9; native side: plugins/withUnifiedPush.js).
 *
 * The user installs a UnifiedPush distributor (the ntfy app, Sunup…) and picks
 * it in Privacy settings. We then register with it and bind the endpoint it
 * hands us to our CURRENT-epoch mailbox over the authenticated mailbox socket
 * (`mailbox:push:endpoint`: the relay only accepts it for a mailbox whose key
 * we just proved, golden rule #3). When a message queues for that mailbox, the
 * relay POSTs an empty wake to the endpoint (server/src/push/ntfy.ts); the
 * distributor wakes us, and the headless task below drains the mailbox over
 * Tor. Nothing readable rides the wake (R2).
 *
 * R1 (no stable id across epochs or profiles): one UnifiedPush INSTANCE per
 * mailbox — the mailbox id already rotates per epoch and differs per profile —
 * so the relay never sees one endpoint bound to two epochs' (or two profiles')
 * mailboxes. Older instances are unregistered once the new one exists
 * (connector 3.x forgets the distributor when its LAST registration goes, so
 * the order matters).
 *
 * Honest reduct: the distributor's server (ntfy.sh, or the user's own) sees the
 * phone's IP and when wakes arrive — never who writes or what. The user chooses
 * it; nothing of Google or Apple is involved.
 *
 * No-op off Android and wherever the native module is missing (Expo Go, jest).
 */
import { AppRegistry, DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { logger } from '../utils/logger';

interface UnifiedPushNative {
  getDistributors(): Promise<string[]>;
  getSavedDistributor(): Promise<string | null>;
  saveDistributor(distributor: string): Promise<boolean>;
  register(instance: string): Promise<boolean>;
  unregister(instance: string): Promise<boolean>;
  getEndpoint(instance: string): Promise<string | null>;
  getInstances(): Promise<string[]>;
  removeDistributor(): Promise<boolean>;
}

/** Headless JS task run by AegisMailboxWakeService on a UnifiedPush wake. */
export const MAILBOX_WAKE_TASK = 'AegisMailboxWake';
const ENDPOINT_EVENT = 'AegisUnifiedPushEndpoint';

function native(): UnifiedPushNative | null {
  if (Platform?.OS !== 'android') return null; // partial RN environments: fail closed (no-op)
  return (NativeModules?.AegisUnifiedPush as UnifiedPushNative | undefined) ?? null;
}

/** True when this binary carries the UnifiedPush connector (prebuilt Android app). */
export function isUnifiedPushAvailable(): boolean {
  return native() !== null;
}

/**
 * The UnifiedPush instance of a mailbox: a fresh endpoint per epoch and per
 * profile (R1). Local to the phone (the distributor gets a random token, not
 * this name); base64url so it is a safe preference key.
 */
export const instanceFor = (mailboxIdB64: string): string =>
  'mb-' + mailboxIdB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The relay refuses anything else (server isSafeUpEndpoint); don't even send it. */
const isHttpsEndpoint = (url: string): boolean => /^https:\/\/[^\s]{1,504}$/.test(url);

type Emitter = { emit: (event: string, payload?: unknown) => unknown };

/** A registration whose endpoint has not arrived yet: bind it on the socket that asked. */
let pending: { sock: Emitter; mailboxIdB64: string; instance: string } | null = null;
let listening = false;

function listenForEndpoints(): void {
  if (listening) return;
  listening = true;
  DeviceEventEmitter.addListener(ENDPOINT_EVENT, (instance: unknown) => {
    const p = pending;
    if (!p || instance !== p.instance) return;
    void (async () => {
      const endpoint = await native()?.getEndpoint(p.instance);
      if (!endpoint || !isHttpsEndpoint(endpoint) || pending !== p) return;
      pending = null;
      p.sock.emit('mailbox:push:endpoint', { mailboxId: p.mailboxIdB64, endpoint });
    })().catch(() => { /* best effort: the next mailbox auth binds it */ });
  });
}

/** Installed distributors (package names). Empty when none, or off Android. */
export async function listDistributors(): Promise<string[]> {
  const up = native();
  if (!up) return [];
  try {
    return await up.getDistributors();
  } catch {
    return [];
  }
}

/** The distributor the user chose, or null (UnifiedPush off). */
export async function currentDistributor(): Promise<string | null> {
  const up = native();
  if (!up) return null;
  try {
    return await up.getSavedDistributor();
  } catch {
    return null;
  }
}

/** Opt in with `distributor`; the endpoint is bound at the next mailbox authentication. */
export async function enableUnifiedPush(distributor: string): Promise<void> {
  const up = native();
  if (!up) throw new Error('UnifiedPush is not available in this build');
  await up.saveDistributor(distributor);
}

/**
 * Opt out (also panic wipe / profile switch): unregister every instance and
 * forget the distributor. The relay drops its binding when the dead endpoint
 * answers 404/410, and purges any binding after 48 h regardless.
 */
export async function disableUnifiedPush(): Promise<void> {
  pending = null;
  const up = native();
  if (!up) return;
  try {
    await up.removeDistributor();
  } catch (e) {
    if (__DEV__) logger.warn('[unifiedPush] disable failed:', (e as Error).message);
  }
}

/**
 * Bind (or start registering) the endpoint of `mailboxIdB64` on an
 * AUTHENTICATED mailbox socket. Called on every mailbox auth:ok, so it follows
 * the epoch rotation and profile switches. No-op unless the user picked a
 * distributor.
 */
export async function bindUnifiedPushEndpoint(sock: Emitter, mailboxIdB64: string): Promise<void> {
  const up = native();
  if (!up) return;
  try {
    if (!(await up.getSavedDistributor())) return;
    const instance = instanceFor(mailboxIdB64);
    const endpoint = await up.getEndpoint(instance);
    if (endpoint && isHttpsEndpoint(endpoint)) {
      sock.emit('mailbox:push:endpoint', { mailboxId: mailboxIdB64, endpoint });
    } else {
      // New epoch: ask the distributor; its endpoint arrives asynchronously.
      listenForEndpoints();
      pending = { sock, mailboxIdB64, instance };
      await up.register(instance);
    }
    // Retire the other mailboxes' instances (the new one is registered first).
    for (const other of await up.getInstances()) {
      if (other !== instance) await up.unregister(other);
    }
  } catch (e) {
    if (__DEV__) logger.warn('[unifiedPush] endpoint binding failed:', (e as Error).message);
  }
}

/** The headless run: reconnect + drain, exactly like a background push wake. */
async function runMailboxWake(): Promise<void> {
  try {
    const { wakeAndReconnect } = require('./backgroundReconnect') as typeof import('./backgroundReconnect');
    await wakeAndReconnect(); // duress-gated; holds the runtime while the mailbox drains
  } catch (e) {
    if (__DEV__) logger.warn('[unifiedPush] wake failed:', (e as Error).message);
  }
}

let registered = false;

/** Register the headless task (index.ts, before App mounts). No-op off Android / in Expo Go. */
export function registerMailboxWakeTask(): void {
  if (registered || Platform?.OS !== 'android') return;
  if (typeof AppRegistry.registerHeadlessTask !== 'function') return;
  registered = true;
  AppRegistry.registerHeadlessTask(MAILBOX_WAKE_TASK, () => runMailboxWake);
}
