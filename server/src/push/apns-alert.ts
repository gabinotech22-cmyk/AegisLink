/**
 * iOS message wake-up via DIRECT APNs (apns-push-type: alert) over HTTP/2.
 *
 * Why not Expo? Expo's push service is an extra hop (Expo servers -> APNs) that
 * adds latency and a dependency. Session/Signal talk to APNs directly with their
 * own provider key. The relay already holds the .p8 (used for VoIP), so a message
 * wake can go straight to APNs — same trust model as Session's push server: APNs
 * sees only an opaque device token and a ZERO-METADATA generic alert, never the
 * sender or content (which stays E2EE and is fetched on-device after the wake).
 *
 * Fail-safe: no-op (returns 0) when APNs is unconfigured, so callers keep their
 * Expo visible-push fallback and nothing regresses.
 *
 * Reuses the audited ES256 provider-token builder + config check from apns-voip;
 * only the topic (bundle, not <bundle>.voip), push-type (alert) and payload (a
 * visible aps.alert) differ. VoIP code is intentionally left untouched.
 */
import http2 from 'node:http2';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { isApnsConfigured, buildProviderToken } from './apns-voip.js';
import { apnsTokenRepo } from '../db/client.js';

const isDev = process.env['NODE_ENV'] !== 'production';

const KEY_ID = process.env['APNS_KEY_ID'] ?? '';
const TEAM_ID = process.env['APNS_TEAM_ID'] ?? '';
const BUNDLE_ID = process.env['APNS_BUNDLE_ID'] ?? 'com.aegislink.app';
const KEY_P8 = (process.env['APNS_KEY_P8'] ?? '').replace(/\\n/g, '\n');
const HOST =
  process.env['APNS_HOST'] === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';

// The alert topic is the plain bundle id — NOT the .voip topic.
const ALERT_TOPIC = BUNDLE_ID;

// ── Cached provider token (ES256 JWT), 40-min refresh (Apple allows 20-60) ────
const TOKEN_TTL_MS = 40 * 60 * 1000;
let _cachedKey: KeyObject | null = null;
let _cachedJwt = '';
let _cachedJwtAt = 0;

function privateKey(): KeyObject {
  if (!_cachedKey) _cachedKey = createPrivateKey(KEY_P8);
  return _cachedKey;
}

function providerToken(): string {
  const now = Date.now();
  if (_cachedJwt && now - _cachedJwtAt < TOKEN_TTL_MS) return _cachedJwt;
  _cachedJwt = buildProviderToken({ keyId: KEY_ID, teamId: TEAM_ID, key: privateKey(), nowMs: now });
  _cachedJwtAt = now;
  return _cachedJwt;
}

/**
 * Zero-metadata visible alert payload. Generic title/body only — no sender, no
 * recipient, no count, no content. The app replaces it with a richer local
 * notification once it wakes and drains the queue. Exported for a regression
 * test that asserts the no-metadata invariant.
 */
export function buildAlertPayload(): string {
  return JSON.stringify({
    aps: {
      alert: { title: 'AegisLink', body: 'Nuevo mensaje cifrado · E2EE' },
      sound: 'default',
    },
  });
}

// ── HTTP/2 session (reused across sends) ──────────────────────────────────────
let _session: http2.ClientHttp2Session | null = null;
function getSession(): http2.ClientHttp2Session {
  if (_session && !_session.closed && !_session.destroyed) return _session;
  const session = http2.connect(HOST);
  session.on('error', () => { /* swallow — next send reconnects. Never log token/aegisId. */ });
  session.on('close', () => { if (_session === session) _session = null; });
  _session = session;
  return session;
}

interface ApnsResult { status: number; reason?: string; }

function postAlert(deviceToken: string, body: string): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let session: http2.ClientHttp2Session;
    let req: http2.ClientHttp2Stream;
    try {
      session = getSession();
      req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken()}`,
        'apns-topic': ALERT_TOPIC,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': `${Math.floor(Date.now() / 1000) + 3600}`,
        'content-type': 'application/json',
      });
    } catch {
      resolve({ status: 0 });
      return;
    }
    let status = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => { status = Number(headers[':status'] ?? 0); });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      let reason: string | undefined;
      if (status !== 200 && data) {
        try { reason = (JSON.parse(data) as { reason?: string }).reason; } catch { /* non-JSON */ }
      }
      resolve({ status, reason });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(10_000, () => { req.close(); resolve({ status: 0 }); });
    req.end(body);
  });
}

async function sendOne(deviceToken: string): Promise<boolean> {
  const { status, reason } = await postAlert(deviceToken, buildAlertPayload());
  if (status === 200) return true;
  if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
    void apnsTokenRepo.delete(deviceToken).catch(() => {});
  }
  if (isDev) console.warn('[apns-alert] send failed', status, reason ?? '');
  return false;
}

/**
 * Send a direct-APNs message wake-up to every registered raw APNs token for
 * `aegisId`. Returns the number of devices APNs accepted (200), so the caller
 * can suppress the redundant Expo push for those devices. No-op (returns 0) when
 * APNs is unconfigured or the recipient has no raw APNs token — Expo fallback.
 */
export async function sendMessageApnsAlert(aegisId: string): Promise<number> {
  if (!isApnsConfigured()) return 0;
  try {
    const tokens = await apnsTokenRepo.forRecipient(aegisId);
    if (tokens.length === 0) return 0;
    const results = await Promise.all(tokens.map((t) => sendOne(t.apns_token)));
    return results.filter(Boolean).length;
  } catch {
    return 0;
  }
}
