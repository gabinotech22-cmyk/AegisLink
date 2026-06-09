/**
 * Scheduled group posts — store-level tests.
 *
 * Covers the full fire path (processDue group branch): marker composition from
 * publish options, image riding the [image:data:…] pipeline, weekly recurrence
 * re-arming, permission re-check at fire time (demotion → failed), locked
 * identity (skip without burning retries), drafts never firing, and the
 * offline-no-retry-burn semantics for 1:1 rows.
 */

// ── db/local ─────────────────────────────────────────────────────────────────
const mockSaveScheduled = jest.fn().mockResolvedValue(undefined);
const mockLoadPending = jest.fn().mockResolvedValue([]);
const mockMarkSent = jest.fn().mockResolvedValue(undefined);
const mockMarkFailed = jest.fn().mockResolvedValue(undefined);
const mockIncrementRetry = jest.fn().mockResolvedValue(undefined);
const mockGetGroup = jest.fn();

jest.mock('../../db/local', () => ({
  __esModule: true,
  saveScheduled: (...a: unknown[]) => mockSaveScheduled(...a),
  loadPendingScheduled: (...a: unknown[]) => mockLoadPending(...a),
  loadAllScheduled: jest.fn().mockResolvedValue([]),
  markScheduledSent: (...a: unknown[]) => mockMarkSent(...a),
  markScheduledFailed: (...a: unknown[]) => mockMarkFailed(...a),
  incrementScheduledRetry: (...a: unknown[]) => mockIncrementRetry(...a),
  deleteScheduled: jest.fn().mockResolvedValue(undefined),
  getGroup: (...a: unknown[]) => mockGetGroup(...a),
  encryptBody: jest.fn(async (s: string) => 'enc:' + s),
  decryptBody: jest.fn(async (s: string) => (s.startsWith('enc:') ? s.slice(4) : s)),
  loadRatchetSession: jest.fn().mockResolvedValue(null),
  saveRatchetSession: jest.fn().mockResolvedValue(undefined),
}));

// ── socket/client ────────────────────────────────────────────────────────────
const mockSendGroupMessage = jest.fn().mockResolvedValue(undefined);
let mockOnline = true;
jest.mock('../../socket/client', () => ({
  __esModule: true,
  getSocket: () => (mockOnline ? { emit: jest.fn() } : null),
  isConnected: () => mockOnline,
  sendGroupMessage: (...a: unknown[]) => mockSendGroupMessage(...a),
}));

// ── store/identity ───────────────────────────────────────────────────────────
let mockIdentity: { aegisId: string } | null = { aegisId: 'me-admin' };
jest.mock('../identity', () => ({
  __esModule: true,
  useIdentity: { getState: () => ({ identity: mockIdentity }) },
}));

// ── expo-crypto / expo-file-system ───────────────────────────────────────────
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn().mockReturnValue('uuid-1') }));
jest.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  readAsStringAsync: jest.fn().mockResolvedValue('B64DATA'),
  EncodingType: { Base64: 'base64' },
}));

import { useScheduledMessages, canScheduleGroupPost } from '../scheduledMessages';
import type { StoredScheduledMessage } from '../../db/local';

const GROUP = { id: 'g-1', adminId: 'me-admin', moderators: ['mod-1'], members: ['me-admin', 'p1'], name: 'X', createdAt: 0 };

function pendingPost(over: Partial<StoredScheduledMessage> = {}): StoredScheduledMessage {
  return {
    id: 'post-1',
    recipientAegisId: 'g-1',
    groupId: 'g-1',
    encryptedPayload: 'enc:Hola anuncio',
    postMeta: 'enc:' + JSON.stringify({ asGroup: true, pinned: true, notify: false, replies: true, repeatWeekly: false }),
    sendAt: Date.now() - 1000,
    createdAt: 0,
    status: 'pending',
    retryCount: 0,
    ...over,
  };
}

describe('canScheduleGroupPost', () => {
  it('allows owner and moderators, denies members and null inputs', () => {
    expect(canScheduleGroupPost(GROUP, 'me-admin')).toBe(true);
    expect(canScheduleGroupPost(GROUP, 'mod-1')).toBe(true);
    expect(canScheduleGroupPost(GROUP, 'p1')).toBe(false);
    expect(canScheduleGroupPost(undefined, 'me-admin')).toBe(false);
    expect(canScheduleGroupPost(GROUP, undefined)).toBe(false);
  });
});

describe('scheduled group posts — fire path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnline = true;
    mockIdentity = { aegisId: 'me-admin' };
    mockGetGroup.mockResolvedValue(GROUP);
    useScheduledMessages.setState({ scheduled: [] });
  });

  it('composes the wire marker from publish options (asGroup+pinned+silent)', async () => {
    mockLoadPending.mockResolvedValue([pendingPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).toHaveBeenCalledTimes(1);
    expect(mockSendGroupMessage.mock.calls[0][0]).toMatchObject({
      groupId: 'g-1',
      plaintext: '[post:gps]Hola anuncio',
    });
    expect(mockMarkSent).toHaveBeenCalledWith('post-1');
  });

  it('image posts ride the [image:data:…] pipeline with the marker in the caption', async () => {
    mockLoadPending.mockResolvedValue([pendingPost({
      postMeta: 'enc:' + JSON.stringify({
        asGroup: false, pinned: false, notify: true, replies: true, repeatWeekly: false,
        imagePath: 'file:///doc/scheduledposts/p.jpg', imageName: 'p.jpg',
      }),
    })]);

    await useScheduledMessages.getState().processDue();

    const sent = mockSendGroupMessage.mock.calls[0][0] as { plaintext: string; msgType?: string; mediaUri?: string };
    expect(sent.plaintext).toBe('[image:data:image/jpeg;base64,B64DATA][post:]Hola anuncio');
    expect(sent.msgType).toBe('image');
    expect(sent.mediaUri).toBe('file:///doc/scheduledposts/p.jpg');
  });

  it('weekly recurrence re-arms one week ahead instead of marking sent', async () => {
    const post = pendingPost({
      postMeta: 'enc:' + JSON.stringify({ asGroup: true, pinned: false, notify: true, replies: true, repeatWeekly: true }),
    });
    mockLoadPending.mockResolvedValue([post]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).toHaveBeenCalledTimes(1);
    expect(mockMarkSent).not.toHaveBeenCalled();
    expect(mockSaveScheduled).toHaveBeenCalledTimes(1);
    const rearmed = mockSaveScheduled.mock.calls[0][0] as StoredScheduledMessage;
    expect(rearmed.id).toBe(post.id);
    expect(rearmed.status).toBe('pending');
    expect(rearmed.sendAt).toBe(post.sendAt + 7 * 24 * 60 * 60 * 1000);
  });

  it('author demoted since scheduling → permanent failure, nothing sent', async () => {
    mockGetGroup.mockResolvedValue({ ...GROUP, adminId: 'someone-else', moderators: [] });
    mockLoadPending.mockResolvedValue([pendingPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith('post-1', 0);
  });

  it('group deleted/left → permanent failure', async () => {
    mockGetGroup.mockResolvedValue(null);
    mockLoadPending.mockResolvedValue([pendingPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith('post-1', 0);
  });

  it('identity locked → skip WITHOUT burning a retry (fires on next run)', async () => {
    mockIdentity = null;
    mockLoadPending.mockResolvedValue([pendingPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockIncrementRetry).not.toHaveBeenCalled();
  });

  it('sendGroupMessage failure burns a retry; MAX_RETRIES → failed', async () => {
    mockSendGroupMessage.mockRejectedValueOnce(new Error('boom'));
    mockLoadPending.mockResolvedValue([pendingPost()]);
    await useScheduledMessages.getState().processDue();
    expect(mockIncrementRetry).toHaveBeenCalledWith('post-1', 1);

    jest.clearAllMocks();
    mockGetGroup.mockResolvedValue(GROUP);
    mockSendGroupMessage.mockRejectedValueOnce(new Error('boom'));
    mockLoadPending.mockResolvedValue([pendingPost({ retryCount: 2 })]);
    await useScheduledMessages.getState().processDue();
    expect(mockMarkFailed).toHaveBeenCalledWith('post-1', 3);
  });

  it('1:1 rows wait offline without burning retries (regression for fast runner)', async () => {
    mockOnline = false;
    mockLoadPending.mockResolvedValue([{
      id: 'm1', recipientAegisId: 'peer-1', encryptedPayload: '{"id":"m1"}',
      sendAt: Date.now() - 1000, createdAt: 0, status: 'pending', retryCount: 0,
    }]);

    await useScheduledMessages.getState().processDue();

    expect(mockIncrementRetry).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('scheduleGroupPost persists drafts that processDue never fires', async () => {
    await useScheduledMessages.getState().scheduleGroupPost({
      groupId: 'g-1', plaintext: 'Borrador', sendAt: Date.now() + 60_000, status: 'draft',
    });
    const saved = mockSaveScheduled.mock.calls[0][0] as StoredScheduledMessage;
    expect(saved.status).toBe('draft');
    expect(saved.groupId).toBe('g-1');
    expect(saved.encryptedPayload).toBe('enc:Borrador');
    // loadPendingScheduled only returns status='pending' rows in production —
    // here we just assert the draft was stored as draft, never as pending.
  });

  it('scheduleGroupPost with an id updates the same row (edit in place)', async () => {
    useScheduledMessages.setState({ scheduled: [pendingPost()] });
    await useScheduledMessages.getState().scheduleGroupPost({
      groupId: 'g-1', plaintext: 'Editado', sendAt: 123, id: 'post-1',
    });
    const saved = mockSaveScheduled.mock.calls[0][0] as StoredScheduledMessage;
    expect(saved.id).toBe('post-1');
    expect(saved.encryptedPayload).toBe('enc:Editado');
    const inMem = useScheduledMessages.getState().scheduled;
    expect(inMem).toHaveLength(1);
    expect(inMem[0].encryptedPayload).toBe('enc:Editado');
  });
});
