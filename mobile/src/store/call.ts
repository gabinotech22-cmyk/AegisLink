import { create } from 'zustand';
import type { MediaStream } from 'react-native-webrtc';
import type { CallMedia, ActivePeer } from '../webrtc/peer';

export type CallStatus =
  | 'idle'
  | 'outgoing-ringing'
  | 'incoming-ringing'
  | 'connecting'
  | 'in-call'
  | 'ended';

export interface CallState {
  callId: string | null;
  /** Peer's Aegis ID. */
  peer: string | null;
  /** Set only for incoming ringing — the offer SDP we'll answer once accepted. */
  pendingOffer: string | null;
  media: CallMedia;
  status: CallStatus;
  /** Direction of the call — needed for history logging even after pendingOffer is cleared. */
  direction: 'in' | 'out' | null;
  startedAt: number | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  activePeer: ActivePeer | null;
  muted: boolean;
  cameraOff: boolean;
  /**
   * Whether the user has navigated away from the full-screen call UI.
   * When true, a FloatingCallBar overlay is shown instead of CallScreen.
   * Auto-resets to false on any status transition other than 'in-call'
   * (e.g. 'ended', 'connecting') so the appropriate full-screen UI always
   * shows for non-interactive states.
   */
  minimized: boolean;

  setStatus: (s: CallStatus) => void;
  setStreams: (local: MediaStream | null, remote: MediaStream | null) => void;
  setActivePeer: (p: ActivePeer | null) => void;
  setPendingOffer: (offer: string | null) => void;
  setMuted: (m: boolean) => void;
  setCameraOff: (off: boolean) => void;
  setMinimized: (v: boolean) => void;
  reset: () => void;
  startOutgoing: (peer: string, callId: string, media: CallMedia) => void;
  startIncoming: (peer: string, callId: string, media: CallMedia, offer: string) => void;
}

const initial: Omit<
  CallState,
  | 'setStatus'
  | 'setStreams'
  | 'setActivePeer'
  | 'setPendingOffer'
  | 'setMuted'
  | 'setCameraOff'
  | 'setMinimized'
  | 'reset'
  | 'startOutgoing'
  | 'startIncoming'
> = {
  callId: null,
  peer: null,
  pendingOffer: null,
  media: 'audio',
  direction: null,
  status: 'idle',
  startedAt: null,
  localStream: null,
  remoteStream: null,
  activePeer: null,
  muted: false,
  cameraOff: false,
  minimized: false,
};

export const useCall = create<CallState>((set) => ({
  ...initial,
  // Only overwrite startedAt when actually entering in-call; leave it unchanged
  // for all other transitions so duration calculation remains accurate.
  // Also auto-reset `minimized` for every state except 'in-call' so that
  // 'ended', 'connecting', etc. always render the full-screen CallScreen.
  setStatus: (s) =>
    set((prev) => ({
      status: s,
      startedAt: s === 'in-call' ? Date.now() : prev.startedAt,
      minimized: s === 'in-call' ? prev.minimized : false,
    })),
  setStreams: (local, remote) => set({ localStream: local, remoteStream: remote }),
  setActivePeer: (p) => set({ activePeer: p }),
  setPendingOffer: (offer) => set({ pendingOffer: offer }),
  setMuted: (m) => set({ muted: m }),
  setCameraOff: (off) => set({ cameraOff: off }),
  setMinimized: (v) => set({ minimized: v }),
  reset: () => set({ ...initial }),
  startOutgoing: (peer, callId, media) =>
    set({ ...initial, peer, callId, media, direction: 'out', status: 'outgoing-ringing' }),
  startIncoming: (peer, callId, media, offer) =>
    set({ ...initial, peer, callId, media, direction: 'in', status: 'incoming-ringing', pendingOffer: offer }),
}));
