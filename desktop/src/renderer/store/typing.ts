import { create } from 'zustand';

interface TypingState {
  /** aegisId → true if that peer is currently typing */
  typing: Record<string, boolean>;
  setTyping: (aegisId: string, isTyping: boolean) => void;
}

export const useTyping = create<TypingState>((set) => ({
  typing: {},
  setTyping(aegisId, isTyping) {
    set((s) => ({ typing: { ...s.typing, [aegisId]: isTyping } }));
  },
}));
