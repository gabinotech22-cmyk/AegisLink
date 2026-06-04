/**
 * groupCall store — state machine tests
 *
 * Covers:
 * - initial state
 * - startOutgoing: sets correct status/participants/callId
 * - startIncoming: sets ringing-in with initiator
 * - addParticipant: idempotent
 * - setParticipantConnected / setParticipantStream
 * - setStatus transitions with startedAt
 * - setMuted toggle
 * - reset returns to initial
 */

import { useGroupCall } from '../groupCall';

describe('groupCall store — state machine', () => {
  beforeEach(() => {
    useGroupCall.getState().reset();
  });

  // ── Initial state ───────────────────────────────────────────────────────────

  it('initial state is idle with no participants', () => {
    const s = useGroupCall.getState();
    expect(s.status).toBe('idle');
    expect(s.callId).toBeNull();
    expect(s.groupId).toBeNull();
    expect(s.groupName).toBeNull();
    expect(s.initiator).toBeNull();
    expect(s.participants).toHaveLength(0);
    expect(s.localStream).toBeNull();
    expect(s.muted).toBe(false);
    expect(s.startedAt).toBeNull();
  });

  // ── startOutgoing ────────────────────────────────────────────────────────────

  it('startOutgoing sets ringing-out status and participants', () => {
    useGroupCall.getState().startOutgoing('call-1', 'group-1', 'AegisGroup', ['peer-a', 'peer-b']);
    const s = useGroupCall.getState();
    expect(s.status).toBe('ringing-out');
    expect(s.callId).toBe('call-1');
    expect(s.groupId).toBe('group-1');
    expect(s.groupName).toBe('AegisGroup');
    expect(s.initiator).toBeNull(); // we are the initiator, not stored in initiator
    expect(s.participants).toHaveLength(2);
    expect(s.participants[0].aegisId).toBe('peer-a');
    expect(s.participants[0].connected).toBe(false);
    expect(s.participants[0].stream).toBeNull();
    expect(s.participants[1].aegisId).toBe('peer-b');
  });

  // ── startIncoming ────────────────────────────────────────────────────────────

  it('startIncoming sets ringing-in with initiator', () => {
    useGroupCall.getState().startIncoming('call-2', 'group-2', 'SecretGroup', 'initiator-x');
    const s = useGroupCall.getState();
    expect(s.status).toBe('ringing-in');
    expect(s.callId).toBe('call-2');
    expect(s.groupId).toBe('group-2');
    expect(s.groupName).toBe('SecretGroup');
    expect(s.initiator).toBe('initiator-x');
    expect(s.participants).toHaveLength(0);
  });

  // ── addParticipant — idempotent ───────────────────────────────────────────────

  it('addParticipant adds a new entry', () => {
    useGroupCall.getState().startIncoming('call-3', 'group-3', 'G', 'init');
    useGroupCall.getState().addParticipant('peer-c');
    expect(useGroupCall.getState().participants).toHaveLength(1);
    expect(useGroupCall.getState().participants[0].aegisId).toBe('peer-c');
  });

  it('addParticipant is idempotent — same id added twice stays one entry', () => {
    useGroupCall.getState().startIncoming('call-4', 'group-4', 'G', 'init');
    useGroupCall.getState().addParticipant('peer-d');
    useGroupCall.getState().addParticipant('peer-d');
    expect(useGroupCall.getState().participants).toHaveLength(1);
  });

  // ── setParticipantConnected ───────────────────────────────────────────────────

  it('setParticipantConnected marks the correct peer as connected', () => {
    useGroupCall.getState().startOutgoing('call-5', 'g', 'G', ['p1', 'p2']);
    useGroupCall.getState().setParticipantConnected('p1', true);
    const { participants } = useGroupCall.getState();
    expect(participants.find((p) => p.aegisId === 'p1')?.connected).toBe(true);
    expect(participants.find((p) => p.aegisId === 'p2')?.connected).toBe(false);
  });

  // ── setStatus with startedAt ──────────────────────────────────────────────────

  it('setStatus("in-call") sets startedAt', () => {
    const before = Date.now();
    useGroupCall.getState().setStatus('in-call');
    const after = Date.now();
    const { startedAt } = useGroupCall.getState();
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeGreaterThanOrEqual(before);
    expect(startedAt!).toBeLessThanOrEqual(after);
  });

  it('setStatus("in-call") does not overwrite existing startedAt', () => {
    useGroupCall.getState().setStatus('in-call');
    const first = useGroupCall.getState().startedAt;
    useGroupCall.getState().setStatus('in-call');
    expect(useGroupCall.getState().startedAt).toBe(first);
  });

  it('setStatus("connecting") does not change startedAt', () => {
    useGroupCall.getState().setStatus('in-call');
    const first = useGroupCall.getState().startedAt;
    useGroupCall.getState().setStatus('connecting');
    expect(useGroupCall.getState().startedAt).toBe(first);
  });

  // ── setMuted ─────────────────────────────────────────────────────────────────

  it('setMuted toggles muted state', () => {
    expect(useGroupCall.getState().muted).toBe(false);
    useGroupCall.getState().setMuted(true);
    expect(useGroupCall.getState().muted).toBe(true);
    useGroupCall.getState().setMuted(false);
    expect(useGroupCall.getState().muted).toBe(false);
  });

  // ── reset ─────────────────────────────────────────────────────────────────────

  it('reset returns store to initial state', () => {
    useGroupCall.getState().startOutgoing('call-99', 'g', 'G', ['p1']);
    useGroupCall.getState().setStatus('in-call');
    useGroupCall.getState().setMuted(true);
    useGroupCall.getState().reset();
    const s = useGroupCall.getState();
    expect(s.status).toBe('idle');
    expect(s.callId).toBeNull();
    expect(s.participants).toHaveLength(0);
    expect(s.muted).toBe(false);
    expect(s.startedAt).toBeNull();
    expect(s.localStream).toBeNull();
  });
});
