/**
 * iOS VoIP push (PushKit) sender — direct APNs over HTTP/2.
 *
 * Why not Expo? Expo's push service does not support the VoIP push type
 * (`apns-push-type: voip`), which is the ONLY push that can wake a fully-killed
 * iOS app to ring. So for iOS calls we talk to APNs directly.
 *
 * Zero dependencies: token-based auth (ES256 JWT) is signed with Node's built-in
 * `crypto`, and the request goes over the built-in `http2` client. No
 * `jsonwebtoken`, no `node-apn` — the whole path is auditable in this one file.
 *
 * ── Zero-metadata ─────────────────────────────────────────────────────────────
 * The push payload carries ONLY a random `callId` (+ optional media hint). No
 * sender, no recipient identity, no content. APNs sees an opaque token and an
 * opaque UUID; the relay never puts identity on the wire.
 *
 * ── Fail-closed / inert until configured ──────────────────────────────────────
 * If the APNS_* env vars are absent (e.g. before the Apple Developer account is
 * wired up), `isApnsConfigured()` is false and every send is a silent no-op that
 * returns false. Nothing crashes; iOS callers simply fall back to the Expo
 * visible wake-up like today.
 */
import http2 from 'node:http2';
import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { voipTokenRepo } from '../db/client.js';

const isDev = process.env['NODE_ENV'] !== 'production';

// ── Configuration (all from env) ──────────────────────────────────────────────
const KEY_ID = process.env['APNS_KEY_ID'] ?? '';
const TEAM_ID = process.env['APNS_TEAM_ID'] ?? '';
const BUNDLE_ID = process.env['APNS_BUNDLE_ID'] ?? 'com.aegislink.app';
// The .p8 private key PEM. Newlines may be escaped as \n in the env value.
const KEY_P8 = (process.env['APNS_KEY_P8'] ?? '').replace(/\\n/g, '\n');
// Production APNs host by default; APNS_HOST=sandbox switches to development.
const HOST =
  process.env['APNS_HOST'] === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';

const VOIP_TOPIC = `${BUNDLE_ID}.voip`;

export function isApnsConfigured(): boolean {
  return KEY_ID !== '' && TEAM_ID !== '' && KEY_P8 !== '';
}

// ── ES256 JWT (Apple provider token) ──────────────────────────────────────────
// Apple requires the token be refreshed periodically (valid 20–60 min). We cache
// it and regenerate every 40 minutes.
const TOKEN_TTL_MS = 40 * 60 * 1000;
let _cachedKey: KeyObject | null = null;
let _cachedJwt = '';
let _cachedJwtAt = 0;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function privateKey(): KeyObject {
  if (!_cachedKey) _cachedKey = createPrivateKey(KEY_P8);
  return _cachedKey;
}

/**
 * Build an Apple provider token (ES256 JWS). Pure + injectable for testing.
 * The signature is raw r||s (`ieee-p1363`) as JWS ES256 mandates — NOT DER.
 */
export function buildProviderToken(opts: {
  keyId: string;
  teamId: string;
  key: KeyObject;
  nowMs: number;
}): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: opts.keyId }));
  const claims = b64url(JSON.stringify({ iss: opts.teamId, iat: Math.floor(opts.nowMs / 1000) }));
  const signingInput = `${header}.${claims}`;
  const signature = cryptoSign('SHA256', Buffer.from(signingInput), {
    key: opts.key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Serialize the VoIP push payload. Zero-metadata by construction: ONLY the
 * random callId and an optional media hint — never a sender, recipient, or any
 * identifying field. Exported so a regression test can assert that invariant.
 */
export function buildVoipPayload(callId: string, media: CallMedia): string {
  return JSON.stringify({ callId, media });
}

function providerToken(): string {
  const now = Date.now();
  if (_cachedJwt && now - _cachedJwtAt < TOKEN_TTL_MS) return _cachedJwt;
  _cachedJwt = buildProviderToken({ keyId: KEY_ID, teamId: TEAM_ID, key: privateKey(), nowMs: now });
  _cachedJwtAt = now;
  return _cachedJwt;
}

// ── HTTP/2 session (reused across sends) ──────────────────────────────────────
let _session: http2.ClientHttp2Session | null = null;

function getSession(): http2.ClientHttp2Session {
  if (_session && !_session.closed && !_session.destroyed) return _session;
  const session = http2.connect(HOST);
  session.on('error', () => {
    /* swallow — next send reconnects. Never log token/aegisId. */
  });
  session.on('close', () => {
    if (_session === session) _session = null;
  });
  _session = session;
  return session;
}

interface ApnsResult {
  status: number;
  /** Apple's `reason` string on failure (e.g. "BadDeviceToken"), if any. */
  reason?: string;
}

function postToApns(deviceToken: string, body: string): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let session: http2.ClientHttp2Session;
    try {
      session = getSession();
    } catch {
      resolve({ status: 0 });
      return;
    }

    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': VOIP_TOPIC,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': `${Math.floor(Date.now() / 1000) + 30}`,
      'content-type': 'application/json',
    });

    let status = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      let reason: string | undefined;
      if (status !== 200 && data) {
        try {
          reason = (JSON.parse(data) as { reason?: string }).reason;
        } catch {
          /* non-JSON error body — ignore */
        }
      }
      resolve({ status, reason });
    });
    req.on('error', () => resolve({ status: 0 }));

    req.setTimeout(10_000, () => {
      req.close();
      resolve({ status: 0 });
    });

    req.end(body);
  });
}

export type CallMedia = 'audio' | 'video';

/**
 * Send a single VoIP push. Returns true on APNs 200. Prunes the token on the
 * permanent-failure statuses (410 Unregistered, or BadDeviceToken).
 */
async function sendOne(deviceToken: string, callId: string, media: CallMedia): Promise<boolean> {
  // Minimal, zero-metadata payload. Read natively in AppDelegate (withIosVoip.js)
  // via payload.dictionaryPayload["callId"] / ["media"]. No `aps` alert needed —
  // VoIP pushes are silent-by-nature and never show a banner themselves.
  const body = buildVoipPayload(callId, media);
  const { status, reason } = await postToApns(deviceToken, body);
  if (status === 200) return true;
  if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
    void voipTokenRepo.delete(deviceToken).catch(() => {});
  }
  if (isDev) console.warn('[apns-voip] send failed', status, reason ?? '');
  return false;
}

/**
 * Send a VoIP wake-up to every registered iOS VoIP token for `aegisId`.
 * Returns true if at least one push was accepted by APNs.
 *
 * No-op (returns false) when APNs is not configured — callers keep their
 * existing Expo visible-push fallback.
 */
export async function sendVoipWakeUp(
  aegisId: string,
  callId: string,
  media: CallMedia,
): Promise<boolean> {
  if (!isApnsConfigured()) return false;
  const tokens = await voipTokenRepo.forRecipient(aegisId);
  if (tokens.length === 0) return false;

  const results = await Promise.all(tokens.map((t) => sendOne(t.voip_token, callId, media)));
  return results.some(Boolean);
}
