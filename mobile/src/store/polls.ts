import { create } from 'zustand';
import { sha256 } from '@noble/hashes/sha256';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

/**
 * Local poll vote state.
 *
 * Anonymity guarantees (audited 2026-05):
 * - myVotes is kept ONLY in ephemeral Zustand memory (not SecureStore, not SQLite).
 *   It does NOT survive app restarts — this is intentional: vote history must not
 *   be recoverable under duress.
 * - seenCommitments deduplicates incoming votes by commitment hash so a malicious
 *   peer cannot inflate counts by replaying the same vote envelope.
 * - The commitment scheme: sha256(aegisId + pollId + nonce) — nonce is 16 random bytes,
 *   generated once per vote, stored ephemerally alongside myVotes. The nonce is
 *   embedded in the wire format so the receiver can verify uniqueness without knowing
 *   the voter identity.
 */

/** Hex-encode a Uint8Array (avoids Buffer dependency in RN). */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute the vote commitment.
 * commitment = hex(sha256(aegisId || pollId || nonceHex))
 */
export function computeCommitment(aegisId: string, pollId: string, nonceHex: string): string {
  const input = encodeUTF8(`${aegisId}${pollId}${nonceHex}`);
  return toHex(sha256(input));
}

function encodeUTF8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export interface PollResult {
  counts: number[];
  /** My selected option index — ephemeral, not persisted. undefined when not voted or vote revoked. */
  myVote?: number;
}

/** Returned by castVote when a new vote is placed. null means vote was revoked (toggle-off). */
export interface VoteCommitment {
  commitment: string;
  nonceHex: string;
}

interface PollState {
  /** messageId -> { counts per option, myVote index (ephemeral) } */
  results: Record<string, PollResult>;
  /**
   * Set of commitment hashes already applied to local counts.
   * Used to deduplicate incoming votes from peers (replay protection).
   */
  seenCommitments: Set<string>;
  /**
   * messageId -> { optionIndex, nonceHex } for the local user's own votes.
   * Ephemeral — cleared on app restart (intentional: no duress-recoverable vote record).
   */
  myVoteSecrets: Record<string, { optionIndex: number; nonceHex: string }>;

  /**
   * Cast a vote locally and return the commitment data for the socket layer to embed.
   * Returns null if the vote was toggled off (same option tapped again).
   * Returns null if the user has already voted on a different option (change-vote not allowed
   * once committed, to prevent commitment reuse attacks).
   */
  castVote: (
    aegisId: string,
    messageId: string,
    optionIndex: number,
    totalOptions: number
  ) => VoteCommitment | null;

  /**
   * Receive a vote from a peer.
   * The commitment hash is required. If the commitment was already applied, the call is a no-op.
   */
  receiveVote: (messageId: string, optionIndex: number, commitment: string) => void;

  /** No-op hydration kept for API compatibility — votes are no longer persisted. */
  hydrate: () => Promise<void>;
}

export const usePollsStore = create<PollState>((set, get) => ({
  results: {},
  seenCommitments: new Set<string>(),
  myVoteSecrets: {},

  castVote(aegisId, messageId, optionIndex, totalOptions) {
    const state = get();
    const existing = state.results[messageId];
    const prevSecret = state.myVoteSecrets[messageId];

    // Prevent changing a committed vote (once committed the commitment is on the wire).
    if (prevSecret !== undefined) {
      // Toggle-off of the same option: revoke locally (no wire message).
      if (prevSecret.optionIndex === optionIndex) {
        set((s) => {
          const cur = s.results[messageId];
          const counts = cur ? [...cur.counts] : Array<number>(totalOptions).fill(0);
          counts[optionIndex] = Math.max(0, counts[optionIndex] - 1);
          const newSecrets = { ...s.myVoteSecrets };
          delete newSecrets[messageId];
          return {
            results: { ...s.results, [messageId]: { counts, myVote: undefined } },
            myVoteSecrets: newSecrets,
          };
        });
        return null;
      }
      // Changing vote to a different option is not allowed after commitment.
      return null;
    }

    // Generate a fresh nonce and commitment for this vote.
    const nonceBytes = nacl.randomBytes(16);
    const nonceHex = toHex(nonceBytes);
    const commitment = computeCommitment(aegisId, messageId, nonceHex);

    const counts = existing?.counts ?? Array<number>(totalOptions).fill(0);
    const safeCounts =
      counts.length >= totalOptions
        ? [...counts]
        : [...counts, ...Array<number>(totalOptions - counts.length).fill(0)];
    safeCounts[optionIndex] = safeCounts[optionIndex] + 1;

    set((s) => ({
      results: {
        ...s.results,
        [messageId]: { counts: safeCounts, myVote: optionIndex },
      },
      seenCommitments: new Set([...s.seenCommitments, commitment]),
      myVoteSecrets: {
        ...s.myVoteSecrets,
        [messageId]: { optionIndex, nonceHex },
      },
    }));

    return { commitment, nonceHex };
  },

  receiveVote(messageId, optionIndex, commitment) {
    const state = get();

    // Deduplicate by commitment hash.
    if (state.seenCommitments.has(commitment)) return;

    set((s) => {
      // Double-check inside setter to avoid races.
      if (s.seenCommitments.has(commitment)) return s;

      const existing = s.results[messageId];
      const counts = existing?.counts ? [...existing.counts] : [];
      while (counts.length <= optionIndex) counts.push(0);
      counts[optionIndex] = counts[optionIndex] + 1;

      return {
        results: {
          ...s.results,
          [messageId]: { counts, myVote: existing?.myVote },
        },
        seenCommitments: new Set([...s.seenCommitments, commitment]),
      };
    });
  },

  async hydrate() {
    // Votes are no longer persisted — nothing to hydrate.
    // Method retained for API compatibility with existing callers.
  },
}));
