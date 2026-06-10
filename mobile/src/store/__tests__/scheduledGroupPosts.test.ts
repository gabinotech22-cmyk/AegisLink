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

// ── crypto/media (E2EE blob upload for document posts) ──────────────────────
const mockUpload = jest.fn().mockResolvedValue('blob:b1:k1:n1');
jest.mock('../../crypto/media', () => ({
  __esModule: true,
  encryptAndUploadMedia: (...a: unknown[]) => mockUpload(...a),
}));

// ── store/identity ───────────────────────────────────────────────────────────
let mockIdentity: { aegisId: string } | null = { aegisId: 'me-admin' };
jest.mock('../identity', () => ({
  __esModule: true,
  useIdentity: { getState: () => ({ identity: mockIdentity }) },
}));

// ── expo-crypto / expo-file-system ───────────────────────────────────────────
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn().mockReturnValue('uuid-1') }));
const mockDeleteAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  readAsStringAsync: jest.fn().mockResolvedValue('B64DATA'),
  deleteAsync: (...a: unknown[]) => mockDeleteAsync(...a),
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

// ── Staged image cleanup ──────────────────────────────────────────────────────
// The staged JPEG is the only plaintext artifact of a scheduled post, so every
// path that stops referencing it must unlink it from disk.

const IMG = 'file:///doc/scheduledposts/p.jpg';

function imagePost(over: Partial<StoredScheduledMessage> = {}): StoredScheduledMessage {
  return pendingPost({
    postMeta: 'enc:' + JSON.stringify({
      asGroup: true, pinned: false, notify: true, replies: true, repeatWeekly: false,
      imagePath: IMG, imageName: 'p.jpg',
    }),
    ...over,
  });
}

describe('scheduled group posts — staged image cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnline = true;
    mockIdentity = { aegisId: 'me-admin' };
    mockGetGroup.mockResolvedValue(GROUP);
    useScheduledMessages.setState({ scheduled: [] });
  });

  it('cancelScheduled unlinks the staged image of a group post', async () => {
    useScheduledMessages.setState({ scheduled: [imagePost()] });
    await useScheduledMessages.getState().cancelScheduled('post-1');
    expect(mockDeleteAsync).toHaveBeenCalledWith(IMG, { idempotent: true });
  });

  it('publishing a NON-recurring image post unlinks the staged file; recurring keeps it', async () => {
    mockLoadPending.mockResolvedValue([imagePost()]);
    await useScheduledMessages.getState().processDue();
    expect(mockDeleteAsync).toHaveBeenCalledWith(IMG, { idempotent: true });

    jest.clearAllMocks();
    mockGetGroup.mockResolvedValue(GROUP);
    mockLoadPending.mockResolvedValue([imagePost({
      postMeta: 'enc:' + JSON.stringify({
        asGroup: true, pinned: false, notify: true, replies: true, repeatWeekly: true,
        imagePath: IMG, imageName: 'p.jpg',
      }),
    })]);
    await useScheduledMessages.getState().processDue();
    expect(mockSendGroupMessage).toHaveBeenCalledTimes(1);
    expect(mockDeleteAsync).not.toHaveBeenCalled(); // re-armed next week — file still needed
  });

  it('editing a post replacing/removing its image unlinks the OLD file only', async () => {
    useScheduledMessages.setState({ scheduled: [imagePost()] });
    const NEW_IMG = 'file:///doc/scheduledposts/q.jpg';
    await useScheduledMessages.getState().scheduleGroupPost({
      groupId: 'g-1', plaintext: 'Editado', sendAt: Date.now() + 60_000, id: 'post-1',
      options: {
        asGroup: true, pinned: false, notify: true, replies: true, repeatWeekly: false,
        imagePath: NEW_IMG, imageName: 'q.jpg',
      },
    });
    expect(mockDeleteAsync).toHaveBeenCalledWith(IMG, { idempotent: true });
    expect(mockDeleteAsync).not.toHaveBeenCalledWith(NEW_IMG, expect.anything());

    // Same image kept on edit → nothing unlinked.
    jest.clearAllMocks();
    useScheduledMessages.setState({ scheduled: [imagePost()] });
    await useScheduledMessages.getState().scheduleGroupPost({
      groupId: 'g-1', plaintext: 'Editado 2', sendAt: Date.now() + 60_000, id: 'post-1',
      options: {
        asGroup: true, pinned: false, notify: true, replies: true, repeatWeekly: false,
        imagePath: IMG, imageName: 'p.jpg',
      },
    });
    expect(mockDeleteAsync).not.toHaveBeenCalled();
  });
});

// ── File / poll / link attachments — fire path ───────────────────────────────

const DOC = 'file:///doc/scheduledposts/d.pdf';

function postWith(extra: Record<string, unknown>, over: Partial<StoredScheduledMessage> = {}): StoredScheduledMessage {
  return pendingPost({
    postMeta: 'enc:' + JSON.stringify({
      asGroup: true, pinned: false, notify: true, replies: true, repeatWeekly: false, ...extra,
    }),
    ...over,
  });
}

describe('scheduled group posts — file/poll/link attachments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnline = true;
    mockIdentity = { aegisId: 'me-admin' };
    mockGetGroup.mockResolvedValue(GROUP);
    useScheduledMessages.setState({ scheduled: [] });
  });

  it('document post: uploads the blob first, announcement then [file:…] message', async () => {
    mockLoadPending.mockResolvedValue([postWith({ filePath: DOC, fileName: 'informe.pdf' })]);

    await useScheduledMessages.getState().processDue();

    expect(mockUpload).toHaveBeenCalledWith(DOC);
    expect(mockSendGroupMessage).toHaveBeenCalledTimes(2);
    expect(mockSendGroupMessage.mock.calls[0][0]).toMatchObject({ plaintext: '[post:g]Hola anuncio' });
    expect(mockSendGroupMessage.mock.calls[1][0]).toMatchObject({
      plaintext: '[file:informe.pdf:blob:b1:k1:n1]', msgType: 'file', mediaUri: 'blob:b1:k1:n1',
    });
    // Non-recurring → staged document unlinked after publish.
    expect(mockDeleteAsync).toHaveBeenCalledWith(DOC, { idempotent: true });
  });

  it('document-only post (empty text) sends just the [file:…] message and sanitizes the name', async () => {
    mockLoadPending.mockResolvedValue([postWith(
      { filePath: DOC, fileName: 'ra:ro[1].pdf' },
      { encryptedPayload: 'enc:' }, // decrypts to '' — must NOT be treated as failure
    )]);

    await useScheduledMessages.getState().processDue();

    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockSendGroupMessage).toHaveBeenCalledTimes(1);
    expect(mockSendGroupMessage.mock.calls[0][0]).toMatchObject({
      plaintext: '[file:raro1.pdf:blob:b1:k1:n1]', msgType: 'file',
    });
  });

  it('document post offline: waits WITHOUT burning a retry (blob upload needs the relay)', async () => {
    mockOnline = false;
    mockLoadPending.mockResolvedValue([postWith({ filePath: DOC, fileName: 'informe.pdf' })]);

    await useScheduledMessages.getState().processDue();

    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSendGroupMessage).not.toHaveBeenCalled();
    expect(mockIncrementRetry).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('upload failure burns a retry and nothing fans out', async () => {
    mockUpload.mockRejectedValueOnce(new Error('relay down'));
    mockLoadPending.mockResolvedValue([postWith({ filePath: DOC, fileName: 'informe.pdf' })]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).not.toHaveBeenCalled();
    expect(mockIncrementRetry).toHaveBeenCalledWith('post-1', 1);
  });

  it('poll post fires the [poll:q|…] message after the announcement', async () => {
    mockLoadPending.mockResolvedValue([postWith({
      poll: { question: '¿Quedamos?', options: ['Sí', 'No', 'Luego'] },
    })]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).toHaveBeenCalledTimes(2);
    expect(mockSendGroupMessage.mock.calls[1][0]).toMatchObject({
      plaintext: '[poll:¿Quedamos?|Sí|No|Luego]', msgType: 'poll',
    });
  });

  it('link rides the announcement text inside the marker body', async () => {
    mockLoadPending.mockResolvedValue([postWith({ linkUrl: 'https://aegis.link/x' })]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).toHaveBeenCalledTimes(1);
    expect(mockSendGroupMessage.mock.calls[0][0]).toMatchObject({
      plaintext: '[post:g]Hola anuncio\n\nhttps://aegis.link/x',
    });
  });

  it('link-only post (empty text) publishes the URL as the announcement body', async () => {
    mockLoadPending.mockResolvedValue([postWith(
      { linkUrl: 'https://aegis.link/x' },
      { encryptedPayload: 'enc:' },
    )]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendGroupMessage).toHaveBeenCalledTimes(1);
    expect(mockSendGroupMessage.mock.calls[0][0]).toMatchObject({
      plaintext: '[post:g]https://aegis.link/x',
    });
  });
});
