import { create } from 'zustand';

interface WorkPresenceState {
  onlineIds: Set<string>;
  typingByChannel: Record<string, string[]>;
  setOnline: (ids: string[]) => void;
  addOnline: (aegisId: string) => void;
  removeOnline: (aegisId: string) => void;
  setTyping: (channelId: string, aegisId: string, isTyping: boolean) => void;
  clearPresence: () => void;
}

export const useWorkPresence = create<WorkPresenceState>((set) => ({
  onlineIds: new Set<string>(),
  typingByChannel: {},

  setOnline: (ids) =>
    set({ onlineIds: new Set(ids) }),

  addOnline: (aegisId) =>
    set((state) => {
      const next = new Set(state.onlineIds);
      next.add(aegisId);
      return { onlineIds: next };
    }),

  removeOnline: (aegisId) =>
    set((state) => {
      const next = new Set(state.onlineIds);
      next.delete(aegisId);
      return { onlineIds: next };
    }),

  setTyping: (channelId, aegisId, isTyping) =>
    set((state) => {
      const current = state.typingByChannel[channelId] ?? [];
      let next: string[];
      if (isTyping) {
        next = current.includes(aegisId) ? current : [...current, aegisId];
      } else {
        next = current.filter((id) => id !== aegisId);
      }
      return {
        typingByChannel: {
          ...state.typingByChannel,
          [channelId]: next,
        },
      };
    }),

  clearPresence: () =>
    set({ onlineIds: new Set<string>(), typingByChannel: {} }),
}));
