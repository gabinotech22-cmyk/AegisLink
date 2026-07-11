/**
 * crypto/media.ts — unit tests
 *
 * Coverage:
 * 1. encryptAndUploadMedia resolves PoW challenge and attaches powChallenge/powNonce to upload URL
 * 2. encryptAndUploadMedia throws with a clear message if the PoW challenge fetch fails
 * 3. encryptAndUploadMedia throws 'file_too_large' when file exceeds MAX_BYTES
 * 4. encryptAndUploadMedia returns a correctly-formed blob URI
 */

// ── expo-file-system/legacy ───────────────────────────────────────────────────
const mockGetInfoAsync = jest.fn();
const mockReadAsStringAsync = jest.fn();
const mockWriteAsStringAsync = jest.fn();
const mockUploadAsync = jest.fn();
const mockDeleteAsync = jest.fn();
const mockDownloadAsync = jest.fn();
const mockMakeDirectoryAsync = jest.fn();

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file://cache/',
  getInfoAsync: (...args: unknown[]) => mockGetInfoAsync(...args),
  readAsStringAsync: (...args: unknown[]) => mockReadAsStringAsync(...args),
  writeAsStringAsync: (...args: unknown[]) => mockWriteAsStringAsync(...args),
  uploadAsync: (...args: unknown[]) => mockUploadAsync(...args),
  deleteAsync: (...args: unknown[]) => mockDeleteAsync(...args),
  downloadAsync: (...args: unknown[]) => mockDownloadAsync(...args),
  makeDirectoryAsync: (...args: unknown[]) => mockMakeDirectoryAsync(...args),
  FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
  EncodingType: { Base64: 'base64' },
}));

// ── config ────────────────────────────────────────────────────────────────────
jest.mock('../../config', () => ({
  RELAY_URL: 'https://relay.test',
}));

// ── tweetnacl ─────────────────────────────────────────────────────────────────
// Deterministic bytes for key/nonce — makes the returned blob URI predictable
jest.mock('tweetnacl', () => ({
  randomBytes: jest.fn((n: number) => new Uint8Array(n).fill(1)),
  secretbox: Object.assign(
    jest.fn((_m: Uint8Array) => new Uint8Array(8).fill(2)),
    { keyLength: 32, nonceLength: 24 },
  ),
}));

jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn((b: Uint8Array) => Buffer.from(b).toString('base64')),
  decodeBase64: jest.fn((s: string) => Buffer.from(s, 'base64')),
}));

// ── crypto/registration (PoW helpers) ─────────────────────────────────────────
const mockFetchPowChallenge = jest.fn();
const mockSolvePoW = jest.fn();

jest.mock('../registration', () => ({
  // media.ts uses fetchPowChallengeAt (full URL variant); keep the legacy name
  // mapped to the same spy so existing assertions still hold.
  fetchPowChallengeAt: (...args: unknown[]) => mockFetchPowChallenge(...args),
  fetchPowChallenge: (...args: unknown[]) => mockFetchPowChallenge(...args),
  solvePoW: (...args: unknown[]) => mockSolvePoW(...args),
}));

// ── import SUT after mocks ─────────────────────────────────────────────────────
// Loaded via require() AFTER the jest.mock registrations above instead of a
// top-level `import`, and AFTER jest.resetModules(). In CI (Linux workers,
// full parallel suite) this exact suite failed 12/12 with the REAL
// expo-file-system/legacy bound by media.ts — even once the SUT was loaded via
// a require() that provably ran after every factory registration. The only
// mechanism consistent with that: the real module was ALREADY in the module
// registry before this file's mocks registered (jest-expo's setupFiles can
// pull in expo-modules-core/expo-file-system transitively, environment-
// dependently — which is why it never reproduces locally and tracked
// worker/scheduling changes in CI, not code changes). jest.mock() after a
// module is already required is a no-op for the cached instance.
// jest.resetModules() clears that primed registry while KEEPING the mock
// factories registered above, so the require below re-resolves everything
// fresh and the factories are guaranteed to intercept.
/* eslint-disable @typescript-eslint/no-var-requires */
jest.resetModules();
const {
  encryptAndUploadMedia,
  persistEncryptedBlob,
  resolveMediaDetailed,
  downloadAndDecryptMedia,
} = require('../media') as typeof import('../media');

// ── helpers ───────────────────────────────────────────────────────────────────

function setupHappyPath(): void {
  mockGetInfoAsync.mockResolvedValue({ exists: true, size: 1024 });
  mockReadAsStringAsync.mockResolvedValue('AAAA'); // base64-encoded payload
  mockWriteAsStringAsync.mockResolvedValue(undefined);
  mockDeleteAsync.mockResolvedValue(undefined);
  mockFetchPowChallenge.mockResolvedValue({ challenge: 'ch-abc', difficulty: 1 });
  mockSolvePoW.mockResolvedValue('nonce-xyz');
  mockUploadAsync.mockResolvedValue({
    status: 200,
    body: JSON.stringify({ id: 'blob-id-001', token: 'tok-123' }),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('encryptAndUploadMedia', () => {
  // ── 1. PoW params attached to upload URL ─────────────────────────────────────
  it('fetches PoW challenge and attaches powChallenge/powNonce as query params to the upload URL', async () => {
    setupHappyPath();

    await encryptAndUploadMedia('file:///test.jpg', 'image/jpeg');

    // fetchPowChallenge must be called with the blob challenge endpoint
    expect(mockFetchPowChallenge).toHaveBeenCalledWith('https://relay.test/blob/challenge');

    // solvePoW must be called with the challenge string and difficulty
    expect(mockSolvePoW).toHaveBeenCalledWith('ch-abc', 1);

    // uploadAsync must have been called with a URL that contains the PoW params
    const [uploadUrl] = mockUploadAsync.mock.calls[0] as [string, ...unknown[]];
    expect(uploadUrl).toContain('powChallenge=ch-abc');
    expect(uploadUrl).toContain('powNonce=nonce-xyz');
    expect(uploadUrl).toContain('https://relay.test/blob/upload');
  });

  // ── 2. PoW failure throws with clear message ──────────────────────────────────
  it('throws a clear blob_pow_failed error if fetchPowChallenge rejects', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 512 });
    mockReadAsStringAsync.mockResolvedValue('AAAA');
    mockWriteAsStringAsync.mockResolvedValue(undefined);
    mockDeleteAsync.mockResolvedValue(undefined);
    mockFetchPowChallenge.mockRejectedValue(new Error('HTTP 503'));

    await expect(
      encryptAndUploadMedia('file:///test.jpg', 'image/jpeg'),
    ).rejects.toThrow('blob_pow_failed');

    // Upload must NOT have been attempted
    expect(mockUploadAsync).not.toHaveBeenCalled();
  });

  // ── 3. file_too_large guard ───────────────────────────────────────────────────
  it('throws file_too_large when file exceeds 50 MB', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 51 * 1024 * 1024 });

    await expect(
      encryptAndUploadMedia('file:///huge.mp4', 'video/mp4'),
    ).rejects.toThrow('file_too_large');

    expect(mockFetchPowChallenge).not.toHaveBeenCalled();
  });

  // ── 4. returned URI format (v2: includes the C-1 download token) ─────────────
  it('returns a v2 blob URI blob:<id>:<key>:<nonce>:<token> when the relay returns a token', async () => {
    setupHappyPath();

    const result = await encryptAndUploadMedia('file:///img.jpg', 'image/jpeg');

    expect(result).toMatch(/^blob:[^:]+:[^:]+:[^:]+:[^:]+$/);
    expect(result.startsWith('blob:blob-id-001:')).toBe(true);
    expect(result.endsWith(':tok-123')).toBe(true);
  });

  // ── 4b. legacy fallback: relay without a token yields the v1 4-part URI ──────
  it('falls back to the v1 4-part URI when the relay returns no token', async () => {
    setupHappyPath();
    mockUploadAsync.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ id: 'blob-id-001' }), // no token
    });

    const result = await encryptAndUploadMedia('file:///img.jpg', 'image/jpeg');

    expect(result).toMatch(/^blob:[^:]+:[^:]+:[^:]+$/);
    expect(result.startsWith('blob:blob-id-001:')).toBe(true);
  });

  // ── 5. Upload retry: succeeds on 2nd attempt after initial failure ─────────────
  it('retries upload on non-200 HTTP status and succeeds on the 2nd attempt', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 512 });
    mockReadAsStringAsync.mockResolvedValue('AAAA');
    mockWriteAsStringAsync.mockResolvedValue(undefined);
    mockDeleteAsync.mockResolvedValue(undefined);
    mockFetchPowChallenge.mockResolvedValue({ challenge: 'ch-retry', difficulty: 1 });
    mockSolvePoW.mockResolvedValue('nonce-retry');

    // First attempt returns 503, second attempt returns 200
    mockUploadAsync
      .mockResolvedValueOnce({ status: 503, body: 'Service Unavailable' })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ id: 'blob-retry-ok' }) });

    const result = await encryptAndUploadMedia('file:///retry.jpg', 'image/jpeg');

    // Should have been called twice
    expect(mockUploadAsync).toHaveBeenCalledTimes(2);
    // Final result should use the ID from the successful 2nd attempt
    expect(result.startsWith('blob:blob-retry-ok:')).toBe(true);
  });

  // ── 6. Upload retry exhausted: throws after MAX_ATTEMPTS failures ─────────────
  it('throws after all retry attempts fail (MAX_ATTEMPTS = 3 non-200 responses)', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 512 });
    mockReadAsStringAsync.mockResolvedValue('AAAA');
    mockWriteAsStringAsync.mockResolvedValue(undefined);
    mockDeleteAsync.mockResolvedValue(undefined);
    mockFetchPowChallenge.mockResolvedValue({ challenge: 'ch-fail', difficulty: 1 });
    mockSolvePoW.mockResolvedValue('nonce-fail');

    // All 3 attempts return 503
    mockUploadAsync.mockResolvedValue({ status: 503, body: 'Server Error' });

    await expect(
      encryptAndUploadMedia('file:///always-fail.jpg', 'image/jpeg'),
    ).rejects.toThrow('Failed to upload media');

    expect(mockUploadAsync).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS = 3
  });

  // ── 7. Content-Type header (regression) ───────────────────────────────────────
  // Without an explicit Content-Type, FileSystem.uploadAsync sends none and the
  // relay's express.raw body parser (type-is) skips buffering → req.body is not a
  // Buffer → HTTP 400 body_must_be_binary. This broke ALL media uploads (1:1 and
  // groups, which share this path). Guard the header so it can't regress.
  it('declares Content-Type application/octet-stream on the upload request', async () => {
    setupHappyPath();

    await encryptAndUploadMedia('file:///img.jpg', 'image/jpeg');

    const [, , options] = mockUploadAsync.mock.calls[0] as [
      string,
      string,
      { headers?: Record<string, string> },
    ];
    expect(options.headers?.['Content-Type']).toBe('application/octet-stream');
  });
});

// ── B-7: expired-attachment handling (graceful 404) ──────────────────────────
describe('B-7 — expired attachment (server blob TTL elapsed)', () => {
  const BLOB = 'blob:bid-b7:AAAA:BBBB:CCCC';

  beforeEach(() => {
    // MEDIA_DIR exists (skip makeDirectory); no local ciphertext/cache files.
    mockGetInfoAsync.mockImplementation((uri: string) =>
      Promise.resolve({ exists: typeof uri === 'string' && uri.endsWith('media/') }),
    );
    mockDeleteAsync.mockResolvedValue(undefined);
  });

  it('persistEncryptedBlob returns "expired" on HTTP 404 WITHOUT retrying', async () => {
    mockDownloadAsync.mockResolvedValue({ status: 404 });
    const state = await persistEncryptedBlob(BLOB);
    expect(state).toBe('expired');
    // The 24h TTL elapsed — the blob never comes back, so we must not burn the
    // retry budget on it.
    expect(mockDownloadAsync).toHaveBeenCalledTimes(1);
  });

  it('persistEncryptedBlob returns "ok" on HTTP 200', async () => {
    mockDownloadAsync.mockResolvedValue({ status: 200 });
    expect(await persistEncryptedBlob(BLOB)).toBe('ok');
    expect(mockDownloadAsync).toHaveBeenCalledTimes(1);
  });

  it('resolveMediaDetailed reports state "expired" when the blob is gone', async () => {
    mockDownloadAsync.mockResolvedValue({ status: 404 });
    const res = await resolveMediaDetailed(BLOB, 'jpg');
    expect(res).toEqual({ path: null, state: 'expired' });
  });

  it('downloadAndDecryptMedia throws a distinguishable "attachment_expired"', async () => {
    mockDownloadAsync.mockResolvedValue({ status: 404 });
    await expect(downloadAndDecryptMedia(BLOB, 'mp4')).rejects.toThrow('attachment_expired');
  });
});
