/**
 * Tests for the anonymous poll vote store.
 *
 * Covers:
 * - castVote produces a commitment and increments local count
 * - castVote is idempotent (second call on same poll+option → null, toggle-off)
 * - castVote blocks changing vote to a different option after commitment
 * - receiveVote increments count for a new commitment
 * - receiveVote is a no-op for a duplicate commitment (deduplication)
 * - computeCommitment is deterministic
 */

import { usePollsStore, computeCommitment } from '../store/polls';

// Reset Zustand store between tests.
beforeEach(() => {
  usePollsStore.setState({
    results: {},
    seenCommitments: new Set(),
    myVoteSecrets: {},
  });
});

describe('computeCommitment', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeCommitment('user1', 'poll1', 'abcd1234');
    const b = computeCommitment('user1', 'poll1', 'abcd1234');
    expect(a).toBe(b);
  });

  it('differs when any input changes', () => {
    const base = computeCommitment('user1', 'poll1', 'nonce1');
    expect(computeCommitment('user2', 'poll1', 'nonce1')).not.toBe(base);
    expect(computeCommitment('user1', 'poll2', 'nonce1')).not.toBe(base);
    expect(computeCommitment('user1', 'poll1', 'nonce2')).not.toBe(base);
  });

  it('returns a 64-char hex string (sha256)', () => {
    const c = computeCommitment('x', 'y', 'z');
    expect(c).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('castVote', () => {
  it('increments the correct option and returns a VoteCommitment', () => {
    const result = usePollsStore.getState().castVote('alice', 'poll1', 1, 3);
    expect(result).not.toBeNull();
    expect(result!.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(result!.nonceHex).toMatch(/^[0-9a-f]{32}$/);

    const counts = usePollsStore.getState().results['poll1']?.counts;
    expect(counts).toEqual([0, 1, 0]);
    expect(usePollsStore.getState().results['poll1']?.myVote).toBe(1);
  });

  it('toggles off when the same option is tapped again', () => {
    usePollsStore.getState().castVote('alice', 'poll1', 1, 3);
    const result = usePollsStore.getState().castVote('alice', 'poll1', 1, 3);
    expect(result).toBeNull();

    const { counts, myVote } = usePollsStore.getState().results['poll1']!;
    expect(counts[1]).toBe(0);
    expect(myVote).toBeUndefined();
  });

  it('blocks changing to a different option after commitment', () => {
    usePollsStore.getState().castVote('alice', 'poll1', 1, 3);
    const result = usePollsStore.getState().castVote('alice', 'poll1', 2, 3);
    expect(result).toBeNull();

    // Original vote must remain unchanged.
    expect(usePollsStore.getState().results['poll1']?.counts[1]).toBe(1);
    expect(usePollsStore.getState().results['poll1']?.counts[2]).toBe(0);
  });

  it('adds the commitment to seenCommitments', () => {
    const result = usePollsStore.getState().castVote('alice', 'poll1', 0, 2);
    expect(usePollsStore.getState().seenCommitments.has(result!.commitment)).toBe(true);
  });
});

describe('receiveVote', () => {
  it('increments count for a new commitment', () => {
    const c = computeCommitment('bob', 'poll1', 'deadbeef'.repeat(4));
    usePollsStore.getState().receiveVote('poll1', 0, c);

    expect(usePollsStore.getState().results['poll1']?.counts[0]).toBe(1);
  });

  it('is a no-op for a duplicate commitment (replay protection)', () => {
    const c = computeCommitment('bob', 'poll1', 'cafebabe'.repeat(4));
    usePollsStore.getState().receiveVote('poll1', 0, c);
    usePollsStore.getState().receiveVote('poll1', 0, c); // replay

    expect(usePollsStore.getState().results['poll1']?.counts[0]).toBe(1);
  });

  it('does not increment when commitment matches own cast vote', () => {
    // Simulate: user cast their own vote, then their own encrypted message loops back.
    const result = usePollsStore.getState().castVote('alice', 'poll1', 2, 3);
    const countBefore = usePollsStore.getState().results['poll1']!.counts[2];

    usePollsStore.getState().receiveVote('poll1', 2, result!.commitment); // duplicate
    expect(usePollsStore.getState().results['poll1']!.counts[2]).toBe(countBefore);
  });

  it('accumulates multiple unique votes from different peers', () => {
    const c1 = computeCommitment('bob', 'poll1', 'aabb'.repeat(8));
    const c2 = computeCommitment('carol', 'poll1', 'ccdd'.repeat(8));
    usePollsStore.getState().receiveVote('poll1', 1, c1);
    usePollsStore.getState().receiveVote('poll1', 1, c2);

    expect(usePollsStore.getState().results['poll1']?.counts[1]).toBe(2);
  });
});

describe('hydrate', () => {
  it('resolves without error (no-op)', async () => {
    await expect(usePollsStore.getState().hydrate()).resolves.toBeUndefined();
  });
});
