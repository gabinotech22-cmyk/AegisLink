import { create } from 'zustand';
import type { MediaStream } from 'react-native-webrtc';

export type GroupCallStatus =
  | 'idle'
  | 'ringing-out'
  | 'ringing-in'
  | 'connecting'
  | 'in-call'
  | 'ended';

export interface GroupCallParticipant {
  aegisId: string;
  stream: MediaStream | null;
  connected: boolean;
  muted: boolean;
}

export interface GroupCallState {
  callId: string | null;
  groupId: string | null;
  groupName: string | null;
  initiator: string | null;
  status: GroupCallStatus;
  participants: GroupCallParticipant[];
  localStream: MediaStream | null;
  muted: boolean;
  startedAt: number | null;

  /** When true, GroupChatScreen is NOT handling the call UI → FloatingGroupCallBar shows. */
  minimized: boolean;

  // actions
  startOutgoing: (callId: string, groupId: string, groupName: string, members: string[]) => void;
  startIncoming: (callId: string, groupId: string, groupName: string, initiator: string) => void;
  addParticipant: (aegisId: string) => void;
  setParticipantStream: (aegisId: string, stream: MediaStream) => void;
  setParticipantConnected: (aegisId: string, connected: boolean) => void;
  setLocalStream: (stream: MediaStream | null) => void;
  setStatus: (status: GroupCallStatus) => void;
  setMuted: (muted: boolean) => void;
  setMinimized: (minimized: boolean) => void;
  reset: () => void;
}

const initial = {
  callId: null,
  groupId: null,
  groupName: null,
  initiator: null,
  status: 'idle' as GroupCallStatus,
  participants: [] as GroupCallParticipant[],
  localStream: null,
  muted: false,
  startedAt: null,
  minimized: false,
};

export const useGroupCall = create<GroupCallState>((set) => ({
  ...initial,

  startOutgoing: (callId, groupId, groupName, members) =>
    set({
      callId,
      groupId,
      groupName,
      initiator: null,
      status: 'ringing-out',
      participants: members.map((aegisId) => ({
        aegisId,
        stream: null,
        connected: false,
        muted: false,
      })),
      localStream: null,
      muted: false,
      startedAt: null,
    }),

  startIncoming: (callId, groupId, groupName, initiator) =>
    set({
      callId,
      groupId,
      groupName,
      initiator,
      status: 'ringing-in',
      participants: [],
      localStream: null,
      muted: false,
      startedAt: null,
    }),

  addParticipant: (aegisId) =>
    set((s) => ({
      participants: s.participants.some((p) => p.aegisId === aegisId)
        ? s.participants
        : [...s.participants, { aegisId, stream: null, connected: false, muted: false }],
    })),

  setParticipantStream: (aegisId, stream) =>
    set((s) => ({
      participants: s.participants.map((p) =>
        p.aegisId === aegisId ? { ...p, stream } : p,
      ),
    })),

  setParticipantConnected: (aegisId, connected) =>
    set((s) => ({
      participants: s.participants.map((p) =>
        p.aegisId === aegisId ? { ...p, connected } : p,
      ),
    })),

  setLocalStream: (localStream) => set({ localStream }),

  setStatus: (status) =>
    set((prev) => ({
      status,
      startedAt: status === 'in-call' ? (prev.startedAt ?? Date.now()) : prev.startedAt,
    })),

  setMuted: (muted) => set({ muted }),

  setMinimized: (minimized) => set({ minimized }),

  reset: () => set({ ...initial }),
}));
