import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
;
import { getSocket, isConnected } from './client';
import { useCall } from '../store/call';
import { displayIncomingCall, endNativeCall, reportCallConnected, setNativeMuted } from '../calls/callkeep';
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

// ---------------------------------------------------------------------------
// Sealed WebRTC signaling
// ---------------------------------------------------------------------------
// SDP offers/answers and ICE candidates leak DTLS fingerprints, codecs, and —
// critically — both peers' real IP addresses. To honour the zero-metadata
// principle they are E2EE-sealed with NaCl box (the same XSalsa20-Poly1305
// authenticated box used for 1:1 chat) addressed to the peer's static X25519
// public key BEFORE being handed to the relay. The relay only ever forwards an
// opaque { ciphertext, nonce } pair; it can neither read nor tamper with the
// payload (Poly1305 MAC verified on open). The signed inner JSON also carries
// `from` (sealed-sender) so the receiver can bind the payload to a known peer.
//
// Privacy note: signaling here is NOT yet sealed-sender at the routing layer —
// the relay still sees who calls whom (it routes by `to` and stamps `from`).
// What this change guarantees is that the relay can no longer observe SDP/ICE
// content, i.e. real IPs, DTLS fingerprints, and media capabilities.

const SIGNAL_VERSION = 1;

interface SealedSignalWire {
  ciphertext: string; // Base64 NaCl box output
  nonce: string;      // Base64, 24 random bytes
}

interface SignalInner {
  v: number;
  from: string;
  /** The original signaling payload (SDP JSON or ICE candidate JSON). */
  payload: string;
}

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

/** Our long-term X25519 secret + public keys and aegisId, loaded from the in-memory identity. */
function ownKeys(): { secretKey: Uint8Array; aegisId: string } | null {
  try {
    const { useIdentity } = require('../store/identity') as {
      useIdentity: { getState: () => { identity: { secretKey: Uint8Array; aegisId: string } | null } };
    };
    const id = useIdentity.getState().identity;
    if (!id) return null;
    return { secretKey: id.secretKey, aegisId: id.aegisId };
  } catch {
    return null;
  }
}

/**
 * Seal a signaling payload for `recipientAegisId`. Returns null if we cannot
 * resolve the peer's public key or our own identity (caller must abort the
 * emit — never fall back to plaintext).
 */
function sealSignal(recipientAegisId: string, payload: string): SealedSignalWire | null {
  const recipientPub = peerPublicKey(recipientAegisId);
  const me = ownKeys();
  if (!recipientPub || !me) return null;

  const inner: SignalInner = { v: SIGNAL_VERSION, from: me.aegisId, payload };
  const innerBytes = new TextEncoder().encode(JSON.stringify(inner));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(innerBytes, nonce, recipientPub, me.secretKey);
  return { ciphertext: encodeBase64(ciphertext), nonce: encodeBase64(nonce) };
}

/**
 * Open a sealed signaling envelope. Verifies the Poly1305 MAC (open returns
 * null on tamper), the protocol version, and that the embedded `from` matches
 * the expected sender. Returns the inner payload string or null on any failure.
 */
function openSignal(senderAegisId: string, wire: SealedSignalWire): string | null {
  const senderPub = peerPublicKey(senderAegisId);
  const me = ownKeys();
  if (!senderPub || !me) return null;

  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
  try {
    ciphertext = decodeBase64(wire.ciphertext);
    nonce = decodeBase64(wire.nonce);
  } catch {
    return null;
  }
  if (nonce.length !== nacl.box.nonceLength) return null;

  const opened = nacl.box.open(ciphertext, nonce, senderPub, me.secretKey);
  if (!opened) return null;

  let inner: SignalInner;
  try {
    inner = JSON.parse(new TextDecoder().decode(opened)) as SignalInner;
  } catch {
    return null;
  }
  if (inner.v !== SIGNAL_VERSION) return null;
  if (inner.from !== senderAegisId) return null;
  if (typeof inner.payload !== 'string') return null;
  return inner.payload;
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

interface CallInvitePayload extends SealedSignalWire {
  callId: string;
  from: string;
  media: CallMedia;
  // `ciphertext`/`nonce` seal the SDP offer (see SealedSignalWire).
}

interface CallAnswerPayload extends SealedSignalWire {
  callId: string;
  from: string;
  // `ciphertext`/`nonce` seal the SDP answer.
}

interface CallIcePayload extends SealedSignalWire {
  callId: string;
  from: string;
  // `ciphertext`/`nonce` seal the ICE candidate JSON.
}

interface CallHangupPayload {
  callId: string;
  from: string;
  reason?: string;
}

/**
 * Subscribes to incoming-call signaling events. Must be called after the
 * socket is connected and authenticated.
 *
 * NOTE: signaling is NOT sealed-sender — the server sees who is calling whom.
 * Media itself is E2EE via DTLS-SRTP (built into WebRTC). Sealed signaling
 * is Fase 4+ hardening.
 */
export function attachCallHandlers(): void {
  const socket = getSocket();
  if (!socket) return;

  // Idempotent: a fresh connect() builds a NEW socket.io instance (disconnect()
  // nulls the old one), so the previous listeners are gone — and re-running this
  // on reconnect must not stack duplicate handlers that would fire startIncoming
  // twice. Clear our four call events first, then (re)register.
  socket.off('call:invite');
  socket.off('call:answer');
  socket.off('call:ice');
  socket.off('call:hangup');

  socket.on('call:invite', async (msg: CallInvitePayload) => {
    // Decrypt the sealed SDP offer before doing anything else. A failed open
    // (unknown sender, tampered ciphertext, missing identity) drops the invite.
    const offer = openSignal(msg.from, msg);
    if (!offer) {
      if (__DEV__) console.warn('[calls] call:invite signal decrypt failed — dropping');
      return;
    }
    const state = useCall.getState();
    if (state.status !== 'idle' && state.status !== 'ended') {
      // Busy — auto-reject; log as declined
      socket.emit('call:hangup', { callId: msg.callId, to: msg.from, reason: 'busy' });
      saveCall({ id: msg.callId, contactId: msg.from, direction: 'in', media: msg.media, status: 'declined', startedAt: Date.now(), durationS: 0 }).catch(() => {});
      const { useMessages } = require('../store/messages');
      const { useIdentity } = require('../store/identity');
      if (useIdentity.getState().identity) {
        void useMessages.getState().append({
          id: Crypto.randomUUID(),
          chatId: msg.from,
          direction: 'in',
          body: `[call:declined:${msg.media}:0s]`,
          createdAt: Date.now(),
          type: 'text',
        });
      }
      return;
    }
    // Fresh incoming call: clear any leftover ICE buffer from a previous call and
    // arm the buffer so the caller's candidates that arrive WHILE WE RING are kept
    // (and later flushed in acceptCall), instead of being dropped.
    resetIceQueue();
    _finalizedCallId = null; // re-arm the finalize-once guard for this new call
    state.startIncoming(msg.from, msg.callId, msg.media, offer);

    // Show native incoming call UI (CallKit on iOS, ConnectionService on Android)
    const callerName = (() => {
      try {
        const { useContacts } = require('../store/contacts') as { useContacts: { getState: () => { get: (id: string) => { name: string } | undefined } } };
        return useContacts.getState().get(msg.from)?.name ?? msg.from;
      } catch { return msg.from; }
    })();
    displayIncomingCall(msg.callId, msg.from, callerName, msg.media === 'video');

    // Show a local push notification when the app is in the background so the
    // user sees a heads-up banner. CallKit / ConnectionService handles the
    // full-screen UI on iOS / Android 10+; the push is a fallback for cases
    // where native call UI is not available or not rendered (e.g. kill state).
    const { AppState } = require('react-native') as typeof import('react-native');
    if (AppState.currentState !== 'active') {
      const { showIncomingCallNotification } = require('../notifications/push') as {
        showIncomingCallNotification: (callerAegisId: string, callerName: string, isVideo: boolean) => Promise<void>;
      };
      void showIncomingCallNotification(msg.from, callerName, msg.media === 'video').catch(() => {});
    }
  });

  socket.on('call:answer', async (msg: CallAnswerPayload) => {
    clearRingTimeout(); // callee answered — cancel the no-answer timeout
    const { activePeer, callId } = useCall.getState();
    if (!activePeer || callId !== msg.callId) return;
    const answer = openSignal(msg.from, msg);
    if (!answer) {
      if (__DEV__) console.warn('[calls] call:answer signal decrypt failed — dropping');
      return;
    }
    await setRemoteAnswer(activePeer.pc, answer);
    // Flush any ICE candidates that arrived before the remote description was set
    await flushPendingIce(activePeer.pc);
    useCall.getState().setStatus('connecting');
  });

  socket.on('call:ice', async (msg: CallIcePayload) => {
    // Gate on callId only — NOT on activePeer. While the callee is still ringing,
    // activePeer is null (acceptCall hasn't run yet), but the caller has already
    // finished trickling its ICE candidates. The old `if (!activePeer) return`
    // dropped every one of them, leaving the callee with no route back to the
    // caller, so the call never connected. Buffer them instead and flush once the
    // peer exists and the remote offer is applied (in acceptCall).
    const { callId } = useCall.getState();
    if (callId !== msg.callId) return;
    const candidate = openSignal(msg.from, msg);
    if (!candidate) {
      if (__DEV__) console.warn('[calls] call:ice signal decrypt failed — dropping');
      return;
    }
    const { activePeer } = useCall.getState();
    if (activePeer && _remoteDescriptionSet) {
      void addRemoteIce(activePeer.pc, candidate);
    } else {
      _pendingIceCandidates.push(candidate);
    }
  });

  socket.on('call:hangup', (msg: CallHangupPayload) => {
    const { callId } = useCall.getState();
    if (callId !== msg.callId) return;
    // Persist history + tear down through the shared finalizer (emitHangup:false
    // — the peer initiated this, no need to echo a hangup back). This replaces
    // the old path that let activePeer.cleanup() drive the connection to 'closed'
    // and reach the rtc_failure branch, which logged answered calls as 'missed'
    // on the receiver and popped a spurious "Call failed" alert. The status is
    // captured BEFORE we move to 'ended', so a connected call is logged 'answered'.
    finalizeCall(msg.reason ?? 'remote_hangup', { emitHangup: false });
  });
}

/** Start an outgoing call. */
export async function startCall(toAegisId: string, media: CallMedia): Promise<void> {
  if (!isConnected()) throw new Error('not_connected');
  const socket = getSocket();
  if (!socket) throw new Error('no_socket');

  const callId = Crypto.randomUUID();
  _finalizedCallId = null; // re-arm the finalize-once guard for this new call
  useCall.getState().startOutgoing(toAegisId, callId, media);

  const { useIdentity } = require('../store/identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  // forceRelay=false: allow host/srflx (direct + STUN) candidates alongside TURN.
  // Relay-only produced one-way audio when both peers shared the same coturn
  // (hairpinning asymmetry). Direct/STUN connects bidirectionally; TURN stays as
  // fallback. Trade-off: peer IPs may be visible to each other on a direct path —
  // acceptable for a working first release; can re-tighten to relay-only later.
  const turnConfig = await fetchTurnConfig(ownAegisId, false);

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

  // Earpiece + proximity sensor for audio (screen blanks at the ear) / speaker
  // for video, and an Android foreground service so the call survives the app
  // being backgrounded. iOS background is covered by UIBackgroundModes.
  startInCallAudio(media === 'video' ? 'video' : 'audio');
  startCallService('AegisLink', media === 'video' ? 'Videollamada en curso' : 'Llamada en curso');

  // Reset the ICE queue for this new call
  resetIceQueue();

  const peer = await createPeer(media, {
    onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
    onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
    onIceCandidate: (candidate) => {
      const sealed = sealSignal(toAegisId, JSON.stringify(candidate.toJSON?.() ?? candidate));
      if (!sealed) {
        if (__DEV__) console.warn('[calls] cannot seal outgoing ICE — peer key missing');
        return;
      }
      socket.emit('call:ice', { callId, to: toAegisId, ...sealed });
    },
    onConnectionStateChange: (state) => {
      if (__DEV__) console.log('[calls] connectionState:', state);
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
          themedAlert(
            'Call failed',
            'Could not establish a media connection. Make sure both devices are on the same network or a TURN relay server is configured.',
          );
        }
      }
    },
  }, turnConfig);
  // setActivePeer BEFORE createOffer so toggleMute/toggleCamera always see a
  // valid peer reference from this point forward.
  useCall.getState().setActivePeer(peer);

  const offer = await createOffer(peer.pc);
  const sealedOffer = sealSignal(toAegisId, offer);
  if (!sealedOffer) {
    // Cannot encrypt the offer — abort rather than leak plaintext SDP to the relay.
    endCall('encrypt_failure');
    themedAlert(
      'Call failed',
      'Could not encrypt the call setup. Make sure the contact is in your contacts list.',
    );
    return; // don't throw — call is already ended cleanly
  }
  socket.emit('call:invite', { callId, to: toAegisId, media, ...sealedOffer });

  // Auto-end if callee does not answer within 45 seconds
  _ringTimeout = setTimeout(() => {
    if (useCall.getState().status === 'outgoing-ringing') {
      endCall('no_answer');
    }
  }, 45_000);
}

/** Accept an incoming call (we already have the offer in pendingOffer). */
export async function acceptCall(): Promise<void> {
  const { peer: peerId, callId, media, pendingOffer } = useCall.getState();
  if (!peerId || !callId || !pendingOffer) return;
  const socket = getSocket();
  if (!socket) throw new Error('no_socket');

  useCall.getState().setStatus('connecting');

  const { useIdentity } = require('../store/identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  // forceRelay=false: allow host/srflx (direct + STUN) candidates alongside TURN.
  // Relay-only produced one-way audio when both peers shared the same coturn
  // (hairpinning asymmetry). Direct/STUN connects bidirectionally; TURN stays as
  // fallback. Trade-off: peer IPs may be visible to each other on a direct path —
  // acceptable for a working first release; can re-tighten to relay-only later.
  const turnConfig = await fetchTurnConfig(ownAegisId, false);

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

  // Earpiece + proximity sensor for audio (screen blanks at the ear) / speaker
  // for video, and an Android foreground service so the call survives the app
  // being backgrounded. iOS background is covered by UIBackgroundModes.
  startInCallAudio(media === 'video' ? 'video' : 'audio');
  startCallService('AegisLink', media === 'video' ? 'Videollamada en curso' : 'Llamada en curso');

  const peer = await createPeer(media, {
    onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
    onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
    onIceCandidate: (candidate) => {
      const sealed = sealSignal(peerId, JSON.stringify(candidate.toJSON?.() ?? candidate));
      if (!sealed) {
        if (__DEV__) console.warn('[calls] cannot seal outgoing ICE — peer key missing');
        return;
      }
      socket.emit('call:ice', { callId, to: peerId, ...sealed });
    },
    onConnectionStateChange: (state) => {
      if (__DEV__) console.log('[calls] connectionState:', state);
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
          themedAlert(
            'Call failed',
            'Could not establish a media connection. Make sure both devices are on the same network or a TURN relay server is configured.',
          );
        }
      }
    },
  }, turnConfig);
  // setActivePeer BEFORE setRemoteOffer so toggleMute/toggleCamera never see null
  useCall.getState().setActivePeer(peer);

  await setRemoteOffer(peer.pc, pendingOffer);
  // Flush ICE candidates that arrived while we were still ringing
  await flushPendingIce(peer.pc);
  const answer = await createAnswer(peer.pc);
  const sealedAnswer = sealSignal(peerId, answer);
  if (!sealedAnswer) {
    // Cannot encrypt the answer — abort rather than leak plaintext SDP.
    endCall('encrypt_failure');
    themedAlert(
      'Call failed',
      'Could not encrypt the call setup. Make sure the contact is in your contacts list.',
    );
    return; // don't throw — call is already ended cleanly
  }
  socket.emit('call:answer', { callId, to: peerId, ...sealedAnswer });
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
    socket.emit('call:hangup', { callId, to: peerId, reason });
  }

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
