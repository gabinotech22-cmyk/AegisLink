import { create } from 'zustand';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkPresenceState {
  onlineIds: Set<string>;
  typingByChannel: Record<string, string[]>;
  setOnline: (ids: string[]) => void;
  addOnline: (aegisId: string) => void;
  removeOnline: (aegisId: string) => void;
  setTyping: (channelId: string, aegisId: string, isTyping: boolean) => void;
  clearPresence: () => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useWorkPresence = create<WorkPresenceState>((set) => ({
  onlineIds: new Set<string>(),
  typingByChannel: {},

  setOnline: (ids) =>
    set({ onlineIds: new Set(ids) }),

  addOnline: (aegisId) =>
    set((s) => {
      const next = new Set(s.onlineIds);
      next.add(aegisId);
      return { onlineIds: next };
    }),

  removeOnline: (aegisId) =>
    set((s) => {
      const next = new Set(s.onlineIds);
      next.delete(aegisId);
      return { onlineIds: next };
    }),

  setTyping: (channelId, aegisId, isTyping) =>
    set((s) => {
      const current = s.typingByChannel[channelId] ?? [];
      let next: string[];
      if (isTyping) {
        next = current.includes(aegisId) ? current : [...current, aegisId];
      } else {
        next = current.filter((id) => id !== aegisId);
      }
      return {
        typingByChannel: {
          ...s.typingByChannel,
          [channelId]: next,
        },
      };
    }),

  clearPresence: () =>
    set({ onlineIds: new Set<string>(), typingByChannel: {} }),
}));
