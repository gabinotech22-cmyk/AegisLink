import * as Crypto from 'expo-crypto';
import { logger } from '../utils/logger';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'tweetnacl-util';
;
import { getSocket, isConnected } from './client';
import { useCall } from '../store/call';
import {
  displayIncomingCall,
  endNativeCall,
  reportCallConnected,
  setNativeMuted,
  answerNativeCall,
  isCallKitAvailable,
} from '../calls/callkeep';
import { saveCall } from '../db/local';
import {
  createPeer,
  createOffer,
  setRemoteOffer,
  createAnswer,
  setRemoteAnswer,
  addRemoteIce,
  type CallMedia,
} from '../webrtc/peer';
import { fetchTurnConfig } from '../webrtc/ice';
import { startInCallAudio, stopInCallAudio } from '../webrtc/inCall';
import { startCallService, stopCallService } from '../webrtc/callForegroundService';
import { themedAlert } from '../components/AlertHost';
import i18n from '../i18n';
import {
  sealCallInvite,
  openCallInvite,
  sealWithCallKey,
  openWithCallKey,
  type CallKeyWire,
} from '../crypto/callSession';

// ---------------------------------------------------------------------------
// Sealed WebRTC signaling (v2-only, sealed-sender)
// ---------------------------------------------------------------------------
// SDP offers/answers and ICE candidates leak DTLS fingerprints, codecs, and —
// critically — both peers' real IP addresses. To honour the zero-metadata
// principle they are E2EE-sealed before being handed to the relay. The relay
// only ever forwards opaque { ciphertext, nonce } pairs; it can neither read
// nor tamper with the payload (Poly1305 MAC verified on open).
//
// The caller's identity is sealed inside the invite ciphertext (ephemeral box +
// Ed25519 signature) and recovered only by the callee. The relay NEVER sees
// who calls whom — it routes by `to` but never stamps `from`. Post-handshake
// signaling (answer, ICE) is sealed symmetrically under a per-call `callKey`
// established by the invite handshake.

/** Resolve a peer's static X25519 public key from the local contacts store. */
function peerPublicKey(aegisId: string): Uint8Array | null {
  try {
    const { useContacts } = require('../store/contacts') as {
      useContacts: { getState: () => { get: (id: string) => { publicKeyB64: string } | undefined } };
    };
    const b64 = useContacts.getState().get(aegisId)?.publicKeyB64;
    if (!b64) return null;
    const key = decodeBase64(b64);
    return key.length === nacl.box.publicKeyLength ? key : null;
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// Per-call symmetric key management (v2)
// ---------------------------------------------------------------------------
// The call:invite carries a sealed-sender handshake (ephemeral box + signature)
// embedding a random `callKey`; answer/ICE are then sealed symmetrically under
// callKey (cheap, for the ICE trickle). The relay never stamps `from`. We hold
// the callKey for the lifetime of the call, keyed by callId.
const callKeys = new Map<string, Uint8Array>();

function rememberCallKey(callId: string, key: Uint8Array): void {
  callKeys.set(callId, key);
}
function forgetCallKey(callId: string): void {
  const k = callKeys.get(callId);
  if (k) { k.fill(0); callKeys.delete(callId); } // zeroize (golden rule #9)
}

/** Our Ed25519 signing secret + box secret + aegisId from the in-memory identity. */
function ownSealedKeys(): { secretKey: Uint8Array; signingSecretKey: Uint8Array; aegisId: string } | null {
  try {
    const { useIdentity } = require('../store/identity') as {
      useIdentity: { getState: () => { identity: { secretKey: Uint8Array; signingSecretKey: Uint8Array; aegisId: string } | null } };
    };
    const id = useIdentity.getState().identity;
    if (!id?.signingSecretKey) return null;
    return { secretKey: id.secretKey, signingSecretKey: id.signingSecretKey, aegisId: id.aegisId };
  } catch {
    return null;
  }
}

/** Resolve a contact's Ed25519 signing public key (to authenticate a v2 invite). */
function peerSigningKey(aegisId: string): Uint8Array | null {
  try {
    const { useContacts } = require('../store/contacts') as {
      useContacts: { getState: () => { get: (id: string) => { signingPublicKeyB64?: string } | undefined } };
    };
    const b64 = useContacts.getState().get(aegisId)?.signingPublicKeyB64;
    if (!b64) return null;
    const key = decodeBase64(b64);
    return key.length === nacl.sign.publicKeyLength ? key : null;
  } catch {
    return null;
  }
}

/**
 * Emit a post-handshake signaling message (ICE candidate or SDP answer). Uses
 * the v2 symmetric channel (callKey). Returns false if the callKey is missing
 * (caller must abort — fail-closed, never fall back to plaintext or v1).
 */
function emitSealedSignal(
  socket: ReturnType<typeof getSocket>,
  kind: 'answer' | 'ice',
  callId: string,
  toAegisId: string,
  payload: string,
): boolean {
  if (!socket) return false;
  const key = callKeys.get(callId);
  if (!key) return false; // fail-closed: no callKey → cannot seal (golden rule #6)
  const wire: CallKeyWire = sealWithCallKey(key, payload);
  socket.emit(`call:${kind}:v2`, { callId, to: toAegisId, ...wire });
  return true;
}

// ---------------------------------------------------------------------------
// Ring timeout — cleared whenever the call advances past outgoing-ringing
// ---------------------------------------------------------------------------
let _ringTimeout: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Pending ICE candidate queue — candidates can arrive before setRemoteDescription
// is called (e.g. while the callee is still ringing). Buffer them and flush once
// the remote description is set.
// ---------------------------------------------------------------------------
let _pendingIceCandidates: string[] = [];
let _remoteDescriptionSet = false;

async function flushPendingIce(pc: import('../webrtc/peer').ActivePeer['pc']): Promise<void> {
  _remoteDescriptionSet = true;
  const queued = _pendingIceCandidates.splice(0);
  for (const c of queued) {
    await addRemoteIce(pc, c);
  }
}

function resetIceQueue(): void {
  _pendingIceCandidates = [];
  _remoteDescriptionSet = false;
}

function clearRingTimeout(): void {
  if (_ringTimeout !== null) {
    clearTimeout(_ringTimeout);
    _ringTimeout = null;
  }
}

// ---------------------------------------------------------------------------
// Finalize-once guard
// ---------------------------------------------------------------------------
// A call must be finalized (history persisted + peer torn down) EXACTLY ONCE.
// The peer connection fires 'failed'/'closed' as a side effect of our own
// pc.close() during teardown, and peer.ts dispatches each transition through
// BOTH the connectionstatechange and iceconnectionstatechange listeners — so a
// single hang-up can re-enter the finalizer up to ~4 times. Without this guard
// each re-entry re-runs the persist block, and because `status` has already
// moved to 'ended' it re-derives the call as 'missed', appending duplicate
// `[call:missed:…]` rows and stacking duplicate "Call failed" alerts.
//
// Keyed by callId so a brand-new call (always a fresh UUID) is never blocked.
let _finalizedCallId: string | null = null;

/**
 * Subscribes to incoming-call signaling events (v2-only, sealed-sender).
 * Must be called after the socket is connected and authenticated.
 * The relay NEVER sees who is calling whom — the caller's identity is sealed
 * inside the invite ciphertext and recovered only by the callee.
 */
export function attachCallHandlers(): void {
  const socket = getSocket();
  if (!socket) return;

  // Idempotent: a fresh connect() builds a NEW socket.io instance (disconnect()
  // nulls the old one), so the previous listeners are gone — and re-running this
  // on reconnect must not stack duplicate handlers that would fire startIncoming
  // twice. Clear v2 call events first, then (re)register.
  socket.off('call:invite:v2');
  socket.off('call:answer:v2');
  socket.off('call:ice:v2');
  socket.off('call:hangup:v2');

  // Sealed-sender v2 invite: no `from` on the wire; openCallInvite recovers and
  // authenticates the caller and yields the per-call symmetric key.
  socket.on('call:invite:v2', async (msg: SealedInviteWire) => {
    if (__DEV__) logger.warn('[calls] call:invite:v2 received callId=', msg.callId);
    const me = ownSealedKeys();
    if (!me) return;
    const opened = openCallInvite(
      { ciphertext: msg.ciphertext, nonce: msg.nonce, epk: msg.epk },
      me.secretKey,
      peerSigningKey,
      Date.now(),
    );
    if (!opened) {
      if (__DEV__) logger.warn('[calls] call:invite:v2 open/auth failed — dropping');
      return;
    }
    rememberCallKey(msg.callId, opened.callKey);
    await processIncomingInvite(socket, opened.from, msg.callId, msg.media, opened.offer);
  });

  socket.on('call:answer:v2', async (msg: SealedKeyWire) => {
    const key = callKeys.get(msg.callId);
    if (!key) return;
    const answer = openWithCallKey(key, { ciphertext: msg.ciphertext, nonce: msg.nonce });
    if (!answer) {
      if (__DEV__) logger.warn('[calls] call:answer:v2 decrypt failed — dropping');
      return;
    }
    await processIncomingAnswer(msg.callId, answer);
  });

  socket.on('call:ice:v2', async (msg: SealedKeyWire) => {
    const key = callKeys.get(msg.callId);
    if (!key) return;
    const candidate = openWithCallKey(key, { ciphertext: msg.ciphertext, nonce: msg.nonce });
    if (!candidate) {
      if (__DEV__) logger.warn('[calls] call:ice:v2 decrypt failed — dropping');
      return;
    }
    processIncomingIce(msg.callId, candidate);
  });

  socket.on('call:hangup:v2', (msg: { callId: string; reason?: string }) => {
    const { callId } = useCall.getState();
    if (callId !== msg.callId) return;
    finalizeCall(msg.reason ?? 'remote_hangup', { emitHangup: false });
  });
}

/** Wire shape for an incoming v2 call:invite (no `from`). */
interface SealedInviteWire {
  callId: string;
  media: CallMedia;
  ciphertext: string;
  nonce: string;
  epk: string;
}
/** Wire shape for an incoming v2 answer / ICE (symmetric, no `from`). */
interface SealedKeyWire {
  callId: string;
  ciphertext: string;
  nonce: string;
}

/**
 * Shared incoming-invite handling (busy check, ring UI, notification). The
 * caller's identity (`from`) is recovered from the sealed invite ciphertext —
 * the relay never sees it.
 */
async function processIncomingInvite(
  socket: NonNullable<ReturnType<typeof getSocket>>,
  from: string,
  callId: string,
  media: CallMedia,
  offer: string,
): Promise<void> {
  const state = useCall.getState();
  if (state.status !== 'idle' && state.status !== 'ended') {
    // Busy — auto-reject via the sealed v2 channel (the only channel).
    // Any notification-press intent belonged to THIS rejected invite; drop it
    // so it cannot leak onto a later call.
    if (state.pendingAction !== null) state.setPendingAction(null);
    socket.emit('call:hangup:v2', { callId, to: from, reason: 'busy' });
    saveCall({ id: callId, contactId: from, direction: 'in', media, status: 'declined', startedAt: Date.now(), durationS: 0 }).catch(() => {});
    const { useMessages } = require('../store/messages');
    const { useIdentity } = require('../store/identity');
    if (useIdentity.getState().identity) {
      void useMessages.getState().append({
        id: Crypto.randomUUID(),
        chatId: from,
        direction: 'in',
        body: `[call:declined:${media}:0s]`,
        createdAt: Date.now(),
        type: 'text',
      });
    }
    return;
  }
  // Captured BEFORE startIncoming() below, which resets it to null (spreads
  // ...initial) — this is the user's Accept/Decline pressed on the OS call
  // notification while the app was killed and only the generic wake push had
  // arrived (no offer yet). Now that the relay redelivered the real invite, act
  // on that intent instead of just ringing.
  //
  // Freshness gate: the relay holds a queued invite at most 35s and the caller
  // rings 45s, so a press older than 60s can no longer belong to this invite.
  // Without this, a press whose invite was never redelivered would linger and
  // silently auto-answer the NEXT incoming call — hours later, without consent.
  const { pendingAction, pendingActionAt } = state;
  const pendingActionFresh =
    pendingAction !== null && pendingActionAt !== null && Date.now() - pendingActionAt < 60_000;

  resetIceQueue();
  _finalizedCallId = null;
  state.startIncoming(from, callId, media, offer); // NOTE: resets pendingAction → null

  // Decline needs neither foreground nor mic — safe to run right here.
  if (pendingActionFresh && pendingAction === 'decline') {
    endCall('declined');
    return;
  }
  // Accept must NOT run here: acceptCall() opens the mic + starts a
  // foregroundServiceType=microphone service, both of which only work with the
  // app actually in the foreground (Android 12+). Running it from this
  // background/headless path is what made "answer from the notification" flaky
  // (connect-then-drop, or the call screen opening without connecting). Instead
  // re-arm the intent (startIncoming just cleared it) and let IncomingCallScreen
  // — which only mounts once the app IS foregrounded — consume it and call
  // acceptCall() there, exactly where the manual Accept button already works.
  if (pendingActionFresh && pendingAction === 'accept') {
    useCall.getState().setPendingAction('accept');
  }

  const callerName = (() => {
    try {
      const { useContacts } = require('../store/contacts') as { useContacts: { getState: () => { get: (id: string) => { name: string } | undefined } } };
      return useContacts.getState().get(from)?.name ?? from;
    } catch { return from; }
  })();
  // ── ONE ring surface, always ────────────────────────────────────────────────
  // App in the FOREGROUND → IncomingCallScreen rings and owns Accept/Decline.
  // Nothing else is shown: reporting the call to CallKit here too drew a second,
  // system-owned call UI on top of our screen, and left CallKit holding the
  // AVAudioSession in a ringing/never-answered state — which is what made an
  // accepted call connect with NO audio (see answerNativeCall in calls/callkeep).
  // App NOT in the foreground → only the OS can ring, so exactly one of:
  // CallKit where it exists (iOS), our heads-up banner everywhere else.
  const { AppState } = require('react-native') as typeof import('react-native');
  if (AppState.currentState !== 'active') {
    surfaceIncomingCallOnOs(callId, from, callerName, media === 'video');
  } else {
    // Foreground now, but the user may walk away while it is still ringing —
    // hand the ring over to the OS if that happens, so it can't die on screen.
    armRingHandoff(callId, from, callerName, media === 'video');
  }
}

/**
 * Ring an incoming call through the OS, picking the single surface that applies
 * on this platform. Idempotent per callId on both branches (CallKit dedupes via
 * its own `_displayed` set; the banner via its stable per-callId identifier).
 */
function surfaceIncomingCallOnOs(
  callId: string,
  from: string,
  callerName: string,
  isVideo: boolean,
): void {
  if (isCallKitAvailable()) {
    displayIncomingCall(callId, from, callerName, isVideo);
    return;
  }
  const { showIncomingCallNotification } = require('../notifications/push') as {
    showIncomingCallNotification: (callerAegisId: string, callerName: string, isVideo: boolean, callId: string) => Promise<void>;
  };
  void showIncomingCallNotification(from, callerName, isVideo, callId).catch(() => {});
}

// Pending "the app left the foreground while this call was still ringing"
// watcher. At most one is armed at a time (a single call rings at a time), and
// it is always torn down — on fire, on a status change, and in finalizeCall.
let _ringHandoff: { remove: () => void } | null = null;

function disarmRingHandoff(): void {
  try { _ringHandoff?.remove(); } catch { /* already removed */ }
  _ringHandoff = null;
}

/**
 * Watch for the app leaving the foreground while `callId` is still ringing, and
 * move the ring to the OS surface when it does. Without this, a call that
 * arrived with the app open would keep ringing only inside a screen the user can
 * no longer see, and would be missed for no reason.
 */
function armRingHandoff(callId: string, from: string, callerName: string, isVideo: boolean): void {
  disarmRingHandoff();
  try {
    const { AppState } = require('react-native') as typeof import('react-native');
    const sub = AppState.addEventListener('change', (next: string) => {
      if (next === 'active') return;
      const { status, callId: currentCallId } = useCall.getState();
      // Only hand over a call that is STILL ringing and is still this one.
      if (status === 'incoming-ringing' && currentCallId === callId) {
        surfaceIncomingCallOnOs(callId, from, callerName, isVideo);
      }
      disarmRingHandoff();
    });
    _ringHandoff = sub;
  } catch {
    // No AppState to subscribe to (non-RN runtime / test harness). The in-app
    // ring still works; only the leave-the-app handoff is unavailable.
  }
}

/** Handle an incoming v2 answer (decrypted upstream via callKey). */
async function processIncomingAnswer(msgCallId: string, answer: string): Promise<void> {
  clearRingTimeout(); // callee answered — cancel the no-answer timeout
  const { activePeer, callId, status } = useCall.getState();
  if (!activePeer || callId !== msgCallId) return;
  // Transition to 'connecting' BEFORE the awaits, and only from
  // 'outgoing-ringing'. On a fast network the peer connection reaches
  // 'connected' (status 'in-call', timer running) while flushPendingIce is
  // still applying candidates — an unconditional setStatus afterwards then
  // DOWNGRADED the live call back to "Connecting…" and nothing re-fired
  // 'connected' to repair it until a lucky ICE pair switch (or never).
  if (status === 'outgoing-ringing') {
    useCall.getState().setStatus('connecting');
  }
  await setRemoteAnswer(activePeer.pc, answer);
  await flushPendingIce(activePeer.pc);
}

/** Handle an incoming v2 ICE candidate (decrypted upstream via callKey). */
function processIncomingIce(msgCallId: string, candidate: string): void {
  // Gate on callId only — NOT on activePeer (the callee is still ringing while
  // the caller trickles). Buffer until the peer exists + remote offer is applied.
  const { callId } = useCall.getState();
  if (callId !== msgCallId) return;
  const { activePeer } = useCall.getState();
  if (activePeer && _remoteDescriptionSet) {
    void addRemoteIce(activePeer.pc, candidate);
  } else {
    _pendingIceCandidates.push(candidate);
  }
}

/** Start an outgoing call. */
export async function startCall(toAegisId: string, media: CallMedia): Promise<void> {
  if (!isConnected()) throw new Error('not_connected');
  const socket = getSocket();
  if (!socket) throw new Error('no_socket');

  const callId = Crypto.randomUUID();
  _finalizedCallId = null; // re-arm the finalize-once guard for this new call
  useCall.getState().startOutgoing(toAegisId, callId, media);

  // Sealed-sender v2: resolve the peer's box key + our own signing identity.
  // Generate the callKey UP FRONT so ICE candidates trickling out during
  // createOffer are already sealed under it.
  const canSeal = !!peerPublicKey(toAegisId) && !!ownSealedKeys();
  if (canSeal) rememberCallKey(callId, nacl.randomBytes(nacl.secretbox.keyLength));

  const { useIdentity } = require('../store/identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  // M4 (audit 2026-07): honor the `hideCallIp` preference (default ON) → relay-only
  // ICE so the peer never sees a host/srflx candidate carrying our real IP. The
  // prior one-way-audio caveat was a coturn empty-external-ip bug (relay advertised
  // a docker-bridge 172.x), fixed at the relay; relay-only now connects both ways.
  // Kicked off BEFORE the audio-mode setup so the round-trip (up to 3s uncached)
  // overlaps with it instead of adding to the pre-ring latency.
  const hideCallIp = (require('../store/preferences') as typeof import('../store/preferences')).usePreferences.getState().hideCallIp;
  const turnConfigPromise = fetchTurnConfig(ownAegisId, hideCallIp);

  // Set audio mode for call — earpiece for audio, speakerphone for video
  try {
    const { Audio } = require('expo-av') as typeof import('expo-av');
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: media !== 'video',
    });
  } catch { /* expo-av not available in this context */ }

  const turnConfig = await turnConfigPromise;

  // Reset the ICE queue for this new call
  resetIceQueue();

  // createPeer triggers getUserMedia, which is what actually requests/grants the
  // RECORD_AUDIO (and CAMERA) runtime permission on Android. The foreground
  // service notification (below) MUST start after that — starting a
  // foregroundServiceType=microphone service before RECORD_AUDIO is granted
  // throws a SecurityException and crashes the app on Android 14+ (matches the
  // already-correct ordering in groupCalls.ts).
  const peer = await createPeer(media, {
    onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
    onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
    onIceCandidate: (candidate) => {
      if (!emitSealedSignal(socket, 'ice', callId, toAegisId, JSON.stringify(candidate.toJSON?.() ?? candidate))) {
        if (__DEV__) logger.warn('[calls] cannot seal outgoing ICE — peer key missing');
      }
    },
    onConnectionStateChange: (state) => {
      if (__DEV__) logger.debug('[calls] connectionState:', state);
      if (state === 'connected') {
        useCall.getState().setStatus('in-call');
        const { callId: cid } = useCall.getState();
        if (cid) reportCallConnected(cid);
      }
      // 'closed' is the NORMAL terminal state after pc.close() during teardown —
      // it is NEVER a failure and must not surface an alert (this was the bug
      // behind the "Call failed" dialog appearing ~4× on every hang-up). Only a
      // genuine 'failed' (ICE found no working path) is a real media failure,
      // and even then we only alert when the call never reached 'in-call' — i.e.
      // it failed to *establish*. A 'failed' that arrives as a side effect of
      // teardown (status already 'ended') or after a connected call is just noise.
      if (state === 'failed') {
        const { status } = useCall.getState();
        const neverConnected = status !== 'in-call' && status !== 'ended';
        endCall('rtc_failure');
        if (neverConnected) {
          themedAlert(i18n.t('call.failedTitle'), i18n.t('call.failedMedia'));
        }
      }
    },
  }, turnConfig);
  // setActivePeer BEFORE createOffer so toggleMute/toggleCamera always see a
  // valid peer reference from this point forward.
  useCall.getState().setActivePeer(peer);

  // Earpiece + proximity sensor for audio (screen blanks at the ear) / speaker
  // for video, and an Android foreground service so the call survives the app
  // being backgrounded. iOS background is covered by UIBackgroundModes.
  startInCallAudio(media === 'video' ? 'video' : 'audio');
  startCallService('AegisLink', i18n.t(media === 'video' ? 'call.ongoingVideo' : 'call.ongoingAudio'));

  const offer = await createOffer(peer.pc);
  if (canSeal) {
    // Sealed-sender v2: the invite carries the handshake (no `from`); reuse the
    // callKey generated up front so it matches the one already securing ICE.
    const me = ownSealedKeys();
    const recipientPub = peerPublicKey(toAegisId);
    const callKey = callKeys.get(callId);
    if (!me || !recipientPub || !callKey) {
      endCall('encrypt_failure');
      themedAlert(i18n.t('call.failedTitle'), i18n.t('call.failedEncrypt'));
      return;
    }
    const sealed = sealCallInvite(recipientPub, me.aegisId, me.signingSecretKey, offer, Date.now(), callKey);
    socket.emit('call:invite:v2', { callId, to: toAegisId, media, ...sealed.wire });
    if (__DEV__) logger.warn('[calls] call:invite:v2 emitted callId=', callId, 'socketConnected=', socket.connected);
  } else {
    // Sealed-sender impossible — the peer's box key or our own signing identity
    // is unavailable. Fail CLOSED: never fall back to a `from`-leaking v1 invite
    // (golden rules #4 sealed-sender-in-calls + #6 fail-closed). The call ends
    // cleanly with a clear, actionable message.
    endCall('encrypt_failure');
    themedAlert(i18n.t('call.failedTitle'), i18n.t('call.failedNoSealed'));
    return; // don't throw — call is already ended cleanly
  }

  // Auto-end if callee does not answer within 45 seconds
  _ringTimeout = setTimeout(() => {
    if (useCall.getState().status === 'outgoing-ringing') {
      endCall('no_answer');
    }
  }, 45_000);
}

/** Accept an incoming call (we already have the offer in pendingOffer). */
export async function acceptCall(): Promise<void> {
  const { peer: peerId, callId, media, pendingOffer, status } = useCall.getState();
  if (!peerId || !callId || !pendingOffer) return;
  // Idempotency: a call has TWO possible Accept surfaces (the in-app
  // IncomingCallScreen button and the OS notification's "Contestar", the latter
  // routed through pendingAction → the screen). Both converge here. Only proceed
  // from the ringing state — a second invocation (double-drive / double-tap)
  // would otherwise tear into a half-built peer (new createPeer, new offer),
  // which is exactly what made answering feel slow/flaky when both surfaces were
  // live. Once we've moved past 'incoming-ringing', ignore re-entry.
  if (status !== 'incoming-ringing') return;
  const socket = getSocket();
  if (!socket) throw new Error('no_socket');

  useCall.getState().setStatus('connecting');

  // The ring is over — stop watching for a leave-the-app handoff.
  disarmRingHandoff();

  // When CallKit rang this call (app was not in the foreground), the SYSTEM owns
  // the AVAudioSession and activates it only when the answer action is fulfilled.
  // Accepting from our own UI without this left the call connected and SILENT.
  // Re-entrancy is safe: the resulting native 'answerCall' event calls back into
  // acceptCall(), which returns on the guard above (status is 'connecting' now).
  // No-op when CallKit never displayed this call (foreground path).
  answerNativeCall(callId);

  const { useIdentity } = require('../store/identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  // M4 (audit 2026-07): honor the `hideCallIp` preference (default ON) → relay-only
  // ICE so the peer never sees a host/srflx candidate carrying our real IP. The
  // prior one-way-audio caveat was a coturn empty-external-ip bug, fixed at the
  // relay; relay-only now connects both ways. Kicked off BEFORE the audio-mode
  // setup so the network round-trip overlaps with it instead of delaying the answer.
  const hideCallIp = (require('../store/preferences') as typeof import('../store/preferences')).usePreferences.getState().hideCallIp;
  const turnConfigPromise = fetchTurnConfig(ownAegisId, hideCallIp);

  // NOTE: do NOT resetIceQueue() here — the buffer was armed in the call:invite
  // handler and has been collecting the caller's trickled candidates during the
  // ring. Resetting now would discard exactly the candidates we need. They are
  // flushed below via flushPendingIce() once the remote offer is set.

  // Set audio mode for call — earpiece for audio, speakerphone for video.
  // On iOS this is called before CallKit activates the session; the
  // didActivateAudioSession handler in callkeep.ts will re-apply the routing
  // once CallKit hands over the audio session.
  try {
    const { Audio } = require('expo-av') as typeof import('expo-av');
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: media !== 'video',
    });
  } catch { /* expo-av not available in this context */ }

  const turnConfig = await turnConfigPromise;

  // createPeer triggers getUserMedia, which is what actually requests/grants the
  // RECORD_AUDIO (and CAMERA) runtime permission on Android. The foreground
  // service notification (below) MUST start after that — starting a
  // foregroundServiceType=microphone service before RECORD_AUDIO is granted
  // throws a SecurityException and crashes the app on Android 14+ (matches the
  // already-correct ordering in groupCalls.ts).
  const peer = await createPeer(media, {
    onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
    onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
    onIceCandidate: (candidate) => {
      if (!emitSealedSignal(socket, 'ice', callId, peerId, JSON.stringify(candidate.toJSON?.() ?? candidate))) {
        if (__DEV__) logger.warn('[calls] cannot seal outgoing ICE — peer key missing');
      }
    },
    onConnectionStateChange: (state) => {
      if (__DEV__) logger.debug('[calls] connectionState:', state);
      if (state === 'connected') {
        useCall.getState().setStatus('in-call');
        const { callId: cid } = useCall.getState();
        if (cid) reportCallConnected(cid);
      }
      // 'closed' is the NORMAL terminal state after pc.close() during teardown —
      // it is NEVER a failure and must not surface an alert (this was the bug
      // behind the "Call failed" dialog appearing ~4× on every hang-up). Only a
      // genuine 'failed' (ICE found no working path) is a real media failure,
      // and even then we only alert when the call never reached 'in-call' — i.e.
      // it failed to *establish*. A 'failed' that arrives as a side effect of
      // teardown (status already 'ended') or after a connected call is just noise.
      if (state === 'failed') {
        const { status } = useCall.getState();
        const neverConnected = status !== 'in-call' && status !== 'ended';
        endCall('rtc_failure');
        if (neverConnected) {
          themedAlert(i18n.t('call.failedTitle'), i18n.t('call.failedMedia'));
        }
      }
    },
  }, turnConfig);
  // setActivePeer BEFORE setRemoteOffer so toggleMute/toggleCamera never see null
  useCall.getState().setActivePeer(peer);

  // Earpiece + proximity sensor for audio (screen blanks at the ear) / speaker
  // for video, and an Android foreground service so the call survives the app
  // being backgrounded. iOS background is covered by UIBackgroundModes.
  startInCallAudio(media === 'video' ? 'video' : 'audio');
  startCallService('AegisLink', i18n.t(media === 'video' ? 'call.ongoingVideo' : 'call.ongoingAudio'));

  await setRemoteOffer(peer.pc, pendingOffer);
  // Flush ICE candidates that arrived while we were still ringing
  await flushPendingIce(peer.pc);
  const answer = await createAnswer(peer.pc);
  // Seal the answer with the per-call key. Abort on seal failure (never plaintext).
  if (!emitSealedSignal(socket, 'answer', callId, peerId, answer)) {
    endCall('encrypt_failure');
    themedAlert(
      i18n.t('call.failedTitle'),
      i18n.t('call.failedEncrypt'),
    );
    return; // don't throw — call is already ended cleanly
  }
  // Clear pendingOffer — direction is already stored in the call store.
  useCall.getState().setPendingOffer(null);
}

/**
 * Finalize a call EXACTLY ONCE: optionally signal the peer, persist history,
 * restore audio, tear down the peer connection, and move the store to 'ended'.
 *
 * Re-entrant invocations for the same callId are no-ops — this is the single
 * point that neutralizes the peer connection's teardown-time 'failed'/'closed'
 * events (dispatched twice over connectionstatechange + iceconnectionstatechange)
 * so they can no longer double-log the call as 'missed' or stack alerts.
 *
 * `status` is read at entry, BEFORE the transition to 'ended', so a connected
 * call (status === 'in-call') is always logged 'answered' and never 'missed'.
 */
function finalizeCall(reason: string, opts: { emitHangup: boolean }): void {
  const { peer: peerId, callId, activePeer, status, media, startedAt, direction } = useCall.getState();

  // Idempotency guard — keyed by callId so a brand-new call is never blocked.
  if (callId && _finalizedCallId === callId) return;
  if (callId) _finalizedCallId = callId;

  clearRingTimeout(); // always cancel the no-answer timer, regardless of direction
  resetIceQueue();

  const socket = getSocket();
  if (opts.emitHangup && socket && peerId && callId) {
    // Always v2 — the relay never sees `from` (sealed-sender).
    socket.emit('call:hangup:v2', { callId, to: peerId, reason });
  }
  // Drop the per-call session key (zeroized) now the call is over.
  if (callId) forgetCallKey(callId);

  // Persist call history
  if (callId && peerId) {
    // Use the direction field set at call start — reliable even after pendingOffer is cleared.
    const wasIncoming = direction === 'in';
    const wasAnswered = status === 'in-call';
    const callStatus: 'missed' | 'answered' | 'declined' =
      reason === 'declined' ? 'declined' : wasAnswered ? 'answered' : 'missed';
    const durationS = wasAnswered && startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    saveCall({
      id: callId, contactId: peerId,
      direction: wasIncoming ? 'in' : 'out',
      media: media ?? 'audio',
      status: callStatus,
      startedAt: startedAt ?? Date.now(), durationS,
    }).catch(() => {});

    // Append a system message to the chat thread so the call appears inline
    const { useMessages } = require('../store/messages');
    const { useIdentity } = require('../store/identity');
    if (useIdentity.getState().identity) {
      void useMessages.getState().append({
        id: Crypto.randomUUID(),
        chatId: peerId,
        direction: wasIncoming ? 'in' : 'out',
        body: `[call:${callStatus}:${media ?? 'audio'}:${durationS}s]`,
        createdAt: Date.now(),
        type: 'text',
      });
    }

    // Clean up the OS call notification for THIS incoming call. Whatever the
    // outcome, the "Contestar / Rechazar" banner must never outlive the call.
    // If it was genuinely missed (not answered, not user-declined), leave a
    // passive "Llamada perdida" record in its place — parity with other apps.
    if (wasIncoming) {
      const { dismissIncomingCallNotification, showMissedCallNotification } =
        require('../notifications/push') as {
          dismissIncomingCallNotification: (callId: string) => Promise<void>;
          showMissedCallNotification: (callerAegisId: string, callerName: string, callId: string) => Promise<void>;
        };
      void dismissIncomingCallNotification(callId).catch(() => {});
      if (callStatus === 'missed') {
        const callerName = (() => {
          try {
            const { useContacts } = require('../store/contacts') as { useContacts: { getState: () => { get: (id: string) => { name: string } | undefined } } };
            return useContacts.getState().get(peerId)?.name ?? peerId;
          } catch { return peerId; }
        })();
        void showMissedCallNotification(peerId, callerName, callId).catch(() => {});
      }
    }
  }

  // Restore normal audio mode
  try {
    const { Audio } = require('expo-av') as typeof import('expo-av');
    void Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: false,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
  } catch { /* no-op */ }

  // The call is over — a ring handoff watcher must never outlive it.
  disarmRingHandoff();

  // Release proximity/audio session and tear down the Android foreground service.
  stopInCallAudio();
  stopCallService();

  activePeer?.cleanup();

  // Dismiss native call UI
  if (callId) endNativeCall(callId);

  useCall.getState().setStatus('ended');
  setTimeout(() => useCall.getState().reset(), 600);
}

/** Reject an incoming call or end an active one (local-initiated — signals the peer). */
export function endCall(reason: string = 'hangup'): void {
  finalizeCall(reason, { emitHangup: true });
}

export function toggleMute(): void {
  const { activePeer, muted } = useCall.getState();
  if (!activePeer?.localStream) return;
  const newMuted = !muted;
  for (const track of activePeer.localStream.getAudioTracks()) track.enabled = !newMuted;
  useCall.getState().setMuted(newMuted);
  const { callId: cid } = useCall.getState();
  if (cid) setNativeMuted(cid, newMuted);
}

export function toggleCamera(): void {
  const { activePeer, cameraOff } = useCall.getState();
  if (!activePeer?.localStream) return;
  const newOff = !cameraOff;
  for (const track of activePeer.localStream.getVideoTracks()) track.enabled = !newOff;
  useCall.getState().setCameraOff(newOff);
}
