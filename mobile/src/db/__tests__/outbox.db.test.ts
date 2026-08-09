/**
 * DB-layer tests for the persistent outbox (Signal-style reliable delivery).
 *
 * Tests the real enqueueOutboxJob / loadOutboxJobs / deleteOutboxJob /
 * incrementOutboxAttempts / countOutboxJobs functions from db/local.ts using
 * the expo-sqlite mock (via jest.config.js moduleNameMapper).
 *
 * Pattern: follows withDb.test.ts — jest.resetModules() + require() inside
 * each test so each test gets a fresh module state (clean dbPromise = null).
 */

// ─── Top-level mock registrations (Babel-hoisted) ────────────────────────────

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  SQLiteDatabase: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///test/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(mockFixedKeyB64),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

// ─── Per-test module reset (same pattern as withDb.test.ts) ──────────────────

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  // Re-apply stable mock for SecureStore key (cleared by clearAllMocks)
  const ss = require('expo-secure-store') as { getItemAsync: jest.Mock };
  ss.getItemAsync.mockResolvedValue(mockFixedKeyB64);
  const utils = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  utils.ss.get.mockResolvedValue(mockFixedKeyB64);
});

// ─── Helper: create a standard mock DB compatible with initSchema ─────────────
// getFirstAsync returns { user_version: 5 } by default so all migrations are
// skipped (no ALTER TABLE / DELETE calls interfering with the test's runAsync).
function makeMockDb(runAsyncMock?: jest.Mock, getAllAsyncMock?: jest.Mock, getFirstAsyncMock?: jest.Mock) {
  const defaultGetFirst = jest.fn().mockResolvedValue({ user_version: 5 });
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: runAsyncMock ?? jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
    getAllAsync: getAllAsyncMock ?? jest.fn().mockResolvedValue([]),
    getFirstAsync: getFirstAsyncMock ?? defaultGetFirst,
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

function requireLocal() {
  return require('../local') as typeof import('../local');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('outbox DB — enqueueOutboxJob', () => {
  it('calls INSERT OR REPLACE INTO outbox with correct positional args', async () => {
    const mockRunAsync = jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 });
    const mockDb = makeMockDb(mockRunAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { enqueueOutboxJob } = requireLocal();

    await enqueueOutboxJob({
      jobId: 'j-001',
      msgId: 'm-001',
      recipientAegisId: 'peer-a',
      recipientPubkeyB64: 'cHViQQ==',
      payload: '{"type":"direct_msg","text":"hello"}',
      kind: 'direct',
      groupId: null,
      createdAt: 9000,
    });

    // Find the INSERT call (there's also a DELETE from initSchema's expiry purge)
    const insertCall = mockRunAsync.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE INTO outbox'),
    );
    expect(insertCall).toBeDefined();

    if (insertCall) {
      expect(insertCall[1]).toBe('j-001');     // jobId
      expect(insertCall[2]).toBe('m-001');     // msgId
      expect(insertCall[3]).toBe('peer-a');    // recipientAegisId
      expect(insertCall[4]).toBe('cHViQQ=='); // recipientPubkeyB64
      // [5] is the encrypted payload (encv1: prefix) — just check it's a string
      expect(typeof insertCall[5]).toBe('string');
      expect(insertCall[6]).toBe('direct');    // kind
      expect(insertCall[7]).toBeNull();        // groupId
      expect(insertCall[8]).toBe(9000);        // createdAt
    }
  });

  it('encrypts the payload (encv1: prefix) before inserting', async () => {
    const mockRunAsync = jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 });
    const mockDb = makeMockDb(mockRunAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { enqueueOutboxJob } = requireLocal();

    await enqueueOutboxJob({
      jobId: 'j-enc',
      msgId: 'm-enc',
      recipientAegisId: 'peer-b',
      recipientPubkeyB64: 'cHViQg==',
      payload: 'plaintext-not-encrypted',
      kind: 'group',
      groupId: 'g-1',
      createdAt: 1234,
    });

    const insertCall = mockRunAsync.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE INTO outbox'),
    );
    expect(insertCall).toBeDefined();

    if (insertCall) {
      const storedPayload = insertCall[5] as string;
      // encryptBody wraps in encv1:... prefix
      expect(storedPayload.startsWith('encv1:')).toBe(true);
      // Original plaintext is NOT stored verbatim
      expect(storedPayload).not.toContain('plaintext-not-encrypted');
    }
  });
});

describe('outbox DB — deleteOutboxJob', () => {
  it('calls DELETE FROM outbox WHERE job_id = ? with correct jobId', async () => {
    const mockRunAsync = jest.fn().mockResolvedValue({ lastInsertRowId: 0, changes: 1 });
    const mockDb = makeMockDb(mockRunAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { deleteOutboxJob } = requireLocal();
    await deleteOutboxJob('j-xyz');

    const deleteCall = mockRunAsync.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE FROM outbox WHERE job_id = ?'),
    );
    expect(deleteCall).toBeDefined();
    if (deleteCall) {
      expect(deleteCall[1]).toBe('j-xyz');
    }
  });
});

describe('outbox DB — incrementOutboxAttempts', () => {
  it('calls UPDATE outbox SET attempts = attempts + 1 WHERE job_id = ?', async () => {
    const mockRunAsync = jest.fn().mockResolvedValue({ lastInsertRowId: 0, changes: 1 });
    const mockDb = makeMockDb(mockRunAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { incrementOutboxAttempts } = requireLocal();
    await incrementOutboxAttempts('j-abc');

    const updateCall = mockRunAsync.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE outbox SET attempts = attempts + 1 WHERE job_id = ?'),
    );
    expect(updateCall).toBeDefined();
    if (updateCall) {
      expect(updateCall[1]).toBe('j-abc');
    }
  });
});

describe('outbox DB — loadOutboxJobs', () => {
  it('queries outbox with ORDER BY created_at ASC (FIFO) and returns parsed jobs', async () => {
    const rawRows = [
      {
        job_id: 'j1',
        msg_id: 'm1',
        recipient_aegis_id: 'alice',
        recipient_pubkey_b64: 'cHViQQ==',
        payload: 'plain-not-encrypted',  // decryptBody returns as-is when no encv1: prefix
        kind: 'direct',
        group_id: null,
        created_at: 100,
        attempts: 0,
      },
      {
        job_id: 'j2',
        msg_id: 'm2',
        recipient_aegis_id: 'bob',
        recipient_pubkey_b64: 'cHViQg==',
        payload: 'plain-group-payload',
        kind: 'group',
        group_id: 'g-1',
        created_at: 200,
        attempts: 3,
      },
    ];

    const mockGetAllAsync = jest.fn().mockResolvedValue(rawRows);
    const mockDb = makeMockDb(undefined, mockGetAllAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { loadOutboxJobs } = requireLocal();
    const jobs = await loadOutboxJobs();

    // Verify FIFO order query
    const selectCall = mockGetAllAsync.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string'
        && (c[0] as string).includes('FROM outbox')
        && (c[0] as string).includes('ORDER BY created_at ASC'),
    );
    expect(selectCall).toBeDefined();

    // Jobs returned in DB order (FIFO)
    expect(jobs).toHaveLength(2);
    expect(jobs[0].jobId).toBe('j1');
    expect(jobs[0].recipientAegisId).toBe('alice');
    expect(jobs[0].kind).toBe('direct');
    expect(jobs[0].groupId).toBeNull();
    expect(jobs[0].attempts).toBe(0);
    expect(jobs[1].jobId).toBe('j2');
    expect(jobs[1].kind).toBe('group');
    expect(jobs[1].groupId).toBe('g-1');
    expect(jobs[1].attempts).toBe(3);
  });
});

describe('outbox DB — countOutboxJobs', () => {
  it('returns the count from the query result', async () => {
    // getFirstAsync: first call is for PRAGMA user_version (returns { user_version: 5 }),
    // second call is for the COUNT query.
    const mockGetFirstAsync = jest.fn()
      .mockResolvedValueOnce({ user_version: 5 })  // schema check
      .mockResolvedValueOnce({ n: 7 });             // count query
    const mockDb = makeMockDb(undefined, undefined, mockGetFirstAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { countOutboxJobs } = requireLocal();
    const count = await countOutboxJobs();
    expect(count).toBe(7);
  });

  it('returns 0 when the count query returns null', async () => {
    const mockGetFirstAsync = jest.fn()
      .mockResolvedValueOnce({ user_version: 5 })
      .mockResolvedValueOnce(null);
    const mockDb = makeMockDb(undefined, undefined, mockGetFirstAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { countOutboxJobs } = requireLocal();
    const count = await countOutboxJobs();
    expect(count).toBe(0);
  });
});

// ─── Retry scheduling (regression: the outbox had no backoff at all) ──────────
//
// `attempts` used to be incremented and never read: no backoff, no cap, no
// terminal state, and the only drain trigger was a socket reconnect. A job that
// failed while the connection stayed up was retried on no schedule whatsoever.
// These cover the durable half of the fix — the columns and queries the
// scheduler in socket/client.ts depends on.

describe('outbox DB — loadDueOutboxJobs', () => {
  it('asks only for jobs whose backoff has elapsed, in FIFO order', async () => {
    const mockGetAllAsync = jest.fn().mockResolvedValue([]);
    const mockDb = makeMockDb(undefined, mockGetAllAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { loadDueOutboxJobs } = requireLocal();
    await loadDueOutboxJobs(1_700_000_000_000);

    const [sql, arg] = mockGetAllAsync.mock.calls[0] as [string, number];
    // Backed-off jobs must be filtered OUT by the query, not loaded and skipped
    // in JS — otherwise a large parked queue is decrypted on every drain tick.
    expect(sql).toContain('next_attempt_at <= ?');
    expect(sql).toContain('ORDER BY created_at ASC');
    expect(arg).toBe(1_700_000_000_000);
  });

  it('defaults a NULL next_attempt_at to due-now', async () => {
    // Rows written before the v13 migration have no scheduling column value.
    // They must drain immediately, not be parked forever by a NULL comparison.
    const mockGetAllAsync = jest.fn().mockResolvedValue([{
      job_id: 'j1', msg_id: 'm1', recipient_aegis_id: 'peer', recipient_pubkey_b64: 'cHVi',
      payload: 'plain:{"text":"hi"}', kind: 'direct', group_id: null,
      created_at: 100, attempts: 0, next_attempt_at: null,
    }]);
    const mockDb = makeMockDb(undefined, mockGetAllAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { loadDueOutboxJobs } = requireLocal();
    const jobs = await loadDueOutboxJobs(Date.now());
    expect(jobs[0].nextAttemptAt).toBe(0);
  });
});

describe('outbox DB — markOutboxAttemptFailed', () => {
  it('increments attempts AND parks the job in one statement', async () => {
    const mockRunAsync = jest.fn().mockResolvedValue({ lastInsertRowId: 0, changes: 1 });
    const mockDb = makeMockDb(mockRunAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { markOutboxAttemptFailed } = requireLocal();
    await markOutboxAttemptFailed('job-7', 1_700_000_005_000);

    // One statement, not two: a crash between an attempts bump and a backoff
    // write would leave the job retrying immediately, forever.
    const call = mockRunAsync.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('UPDATE outbox'));
    expect(call).toBeDefined();
    const [sql, nextAt, jobId] = call as [string, number, string];
    expect(sql).toContain('attempts = attempts + 1');
    expect(sql).toContain('next_attempt_at = ?');
    expect(nextAt).toBe(1_700_000_005_000);
    expect(jobId).toBe('job-7');
  });
});

describe('outbox DB — nextOutboxDueAt', () => {
  it('returns the earliest due timestamp so the scheduler can sleep exactly', async () => {
    const mockGetFirstAsync = jest.fn()
      .mockResolvedValueOnce({ user_version: 5 })
      .mockResolvedValueOnce({ due: 1_700_000_009_000 });
    const mockDb = makeMockDb(undefined, undefined, mockGetFirstAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { nextOutboxDueAt } = requireLocal();
    expect(await nextOutboxDueAt()).toBe(1_700_000_009_000);
  });

  it('returns null on an empty outbox so the scheduler stands down', async () => {
    // MIN() over zero rows yields NULL — the scheduler must read that as
    // "nothing queued" and not arm a timer that wakes up to do nothing.
    const mockGetFirstAsync = jest.fn()
      .mockResolvedValueOnce({ user_version: 5 })
      .mockResolvedValueOnce({ due: null });
    const mockDb = makeMockDb(undefined, undefined, mockGetFirstAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { nextOutboxDueAt } = requireLocal();
    expect(await nextOutboxDueAt()).toBeNull();
  });
});

// ─── Bubble linkage (REL-1: group messages could not carry a send state) ──────
//
// A group send fans out into one job per member, each with its own wire msg_id,
// and the sender's own bubble used a third unrelated id. There was no path from
// a resolved job back to the row the user is looking at, so A-2's pending/failed
// model could only ever apply to 1:1. bubble_id is that path.

describe('outbox DB — bubble linkage', () => {
  it('defaults bubble_id to msgId, so a 1:1 job IS its own bubble', async () => {
    const mockRunAsync = jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 });
    const mockDb = makeMockDb(mockRunAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { enqueueOutboxJob } = requireLocal();
    await enqueueOutboxJob({
      jobId: 'j1', msgId: 'm1', recipientAegisId: 'peer', recipientPubkeyB64: 'cHVi',
      payload: '{}', kind: 'direct', groupId: null, createdAt: 1,
    });

    const call = mockRunAsync.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE INTO outbox'));
    expect(call).toBeDefined();
    // Last positional arg is bubble_id.
    expect((call as unknown[])[(call as unknown[]).length - 1]).toBe('m1');
  });

  it('keeps an explicit bubbleId, so every member of a fan-out shares one', async () => {
    const mockRunAsync = jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 });
    const mockDb = makeMockDb(mockRunAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { enqueueOutboxJob } = requireLocal();
    await enqueueOutboxJob({
      jobId: 'j2', msgId: 'wire-per-member', recipientAegisId: 'member-a',
      recipientPubkeyB64: 'cHVi', payload: '{}', kind: 'group', groupId: 'g1',
      createdAt: 1, bubbleId: 'the-one-bubble',
    });

    const call = mockRunAsync.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE INTO outbox'));
    const args = call as unknown[];
    expect(args[args.length - 1]).toBe('the-one-bubble');
    // The wire id stays per-member — recipients dedup on it independently.
    expect(args[2]).toBe('wire-per-member');
  });

  it('counts the jobs still queued for a bubble', async () => {
    // This is what stops the first of twenty members flipping the whole
    // message to `sent` while nineteen are still waiting.
    const mockGetFirstAsync = jest.fn()
      .mockResolvedValueOnce({ user_version: 5 })
      .mockResolvedValueOnce({ n: 19 });
    const mockDb = makeMockDb(undefined, undefined, mockGetFirstAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { countOutboxJobsForBubble } = requireLocal();
    expect(await countOutboxJobsForBubble('the-one-bubble')).toBe(19);
  });

  it('reports zero for a bubble whose fan-out has fully drained', async () => {
    const mockGetFirstAsync = jest.fn()
      .mockResolvedValueOnce({ user_version: 5 })
      .mockResolvedValueOnce({ n: 0 });
    const mockDb = makeMockDb(undefined, undefined, mockGetFirstAsync);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { countOutboxJobsForBubble } = requireLocal();
    expect(await countOutboxJobsForBubble('done')).toBe(0);
  });
});
