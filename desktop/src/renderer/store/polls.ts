import { create } from 'zustand';
import '../crypto/ipc-types';

const secureStorage = () => window.aegis.secureStorage;
const STORAGE_KEY = 'aegis.polls.v1';

export interface PollResult {
  counts: number[];
  myVote?: number;
}

interface PollState {
  /** messageId -> { counts per option, myVote index (local only) } */
  results: Record<string, PollResult>;
  castVote: (
    messageId: string,
    groupId: string,
    optionIndex: number,
    totalOptions: number,
  ) => void;
  receiveVote: (messageId: string, optionIndex: number) => void;
  hydrate: () => Promise<void>;
}

export const usePollsStore = create<PollState>((set) => ({
  results: {},

  castVote(messageId, _groupId, optionIndex, totalOptions) {
    set((state) => {
      const existing = state.results[messageId];
      const counts = existing?.counts ?? Array<number>(totalOptions).fill(0);
      const prevVote = existing?.myVote;

      const safeCounts =
        counts.length >= totalOptions
          ? [...counts]
          : [...counts, ...Array<number>(totalOptions - counts.length).fill(0)];

      if (prevVote !== undefined && prevVote !== optionIndex) {
        safeCounts[prevVote] = Math.max(0, safeCounts[prevVote] - 1);
      }

      const isSame = prevVote === optionIndex;
      if (!isSame) {
        safeCounts[optionIndex] = safeCounts[optionIndex] + 1;
      } else {
        safeCounts[optionIndex] = Math.max(0, safeCounts[optionIndex] - 1);
      }

      const newMyVote = isSame ? undefined : optionIndex;
      const updated: PollResult = { counts: safeCounts, myVote: newMyVote };

      const allMyVotes: Record<string, number> = {};
      const currentResults = { ...state.results, [messageId]: updated };
      for (const [mId, r] of Object.entries(currentResults)) {
        if (r.myVote !== undefined) allMyVotes[mId] = r.myVote;
      }
      secureStorage().set(STORAGE_KEY, JSON.stringify(allMyVotes)).catch(() => {});

      return { results: currentResults };
    });
  },

  receiveVote(messageId, optionIndex) {
    set((state) => {
      const existing = state.results[messageId];
      const counts = existing?.counts ? [...existing.counts] : [];
      while (counts.length <= optionIndex) counts.push(0);
      counts[optionIndex] = counts[optionIndex] + 1;
      return {
        results: {
          ...state.results,
          [messageId]: { counts, myVote: existing?.myVote },
        },
      };
    });
  },

  async hydrate() {
    try {
      const raw = await secureStorage().get(STORAGE_KEY);
      if (!raw) return;
      const myVotes = JSON.parse(raw) as Record<string, number>;
      set((state) => {
        const merged: Record<string, PollResult> = { ...state.results };
        for (const [messageId, optionIndex] of Object.entries(myVotes)) {
          const existing = merged[messageId];
          merged[messageId] = {
            counts: existing?.counts ?? [],
            myVote: optionIndex,
          };
        }
        return { results: merged };
      });
    } catch {
      // Corrupt storage — ignore, votes will reinitialise
    }
  },
}));
