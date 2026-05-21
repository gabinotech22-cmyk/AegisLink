import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

/**
 * Local poll vote state.
 * Votes are never attributed to identities — only aggregated counts are stored.
 * myVote is kept only in the local device to restore UI selection after restart.
 */

const STORAGE_KEY = 'aegis.polls.v1';

export interface PollResult {
  counts: number[];
  myVote?: number;
}

interface PollState {
  /** messageId -> { counts per option, myVote index (local only) } */
  results: Record<string, PollResult>;
  /** Cast a vote: update local count and persist myVote for UX restoration. */
  castVote: (
    messageId: string,
    groupId: string,
    optionIndex: number,
    totalOptions: number
  ) => void;
  /** Receive a vote from a peer: increment the option count (anonymous). */
  receiveVote: (messageId: string, optionIndex: number) => void;
  /** Hydrate persisted myVote entries from SecureStore on startup. */
  hydrate: () => Promise<void>;
}

export const usePollsStore = create<PollState>((set, get) => ({
  results: {},

  castVote(messageId, _groupId, optionIndex, totalOptions) {
    set((state) => {
      const existing = state.results[messageId];
      const counts = existing?.counts ?? Array<number>(totalOptions).fill(0);
      const prevVote = existing?.myVote;

      // Ensure counts array is long enough (defensive)
      const safeCounts = counts.length >= totalOptions
        ? [...counts]
        : [...counts, ...Array<number>(totalOptions - counts.length).fill(0)];

      // Remove previous vote if toggling
      if (prevVote !== undefined && prevVote !== optionIndex) {
        safeCounts[prevVote] = Math.max(0, safeCounts[prevVote] - 1);
      }

      // Toggle off if same option tapped again
      const isSame = prevVote === optionIndex;
      if (!isSame) {
        safeCounts[optionIndex] = safeCounts[optionIndex] + 1;
      } else {
        // Undo local vote
        safeCounts[optionIndex] = Math.max(0, safeCounts[optionIndex] - 1);
      }

      const newMyVote = isSame ? undefined : optionIndex;

      const updated: PollResult = { counts: safeCounts, myVote: newMyVote };

      // Persist my votes asynchronously so they survive app restart
      const allMyVotes: Record<string, number> = {};
      const currentResults = { ...state.results, [messageId]: updated };
      for (const [mId, r] of Object.entries(currentResults)) {
        if (r.myVote !== undefined) allMyVotes[mId] = r.myVote;
      }
      SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(allMyVotes)).catch(() => {});

      return { results: currentResults };
    });
  },

  receiveVote(messageId, optionIndex) {
    set((state) => {
      const existing = state.results[messageId];
      const counts = existing?.counts ? [...existing.counts] : [];

      // Extend array if needed
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
      const raw = await SecureStore.getItemAsync(STORAGE_KEY);
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
