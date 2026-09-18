/**
 * relayHttp — one `fetch` for relay HTTP that knows where `.onion` lives.
 *
 * Federation F5: with a self-hosted home relay every HTTP call the app makes to
 * ITS relay (PoW challenge, registration, prekeys, TURN credentials, blob
 * challenge, push bindings, public channels, link/GIF proxies, health) targets
 * `http://<onion>` — which the OS network stack cannot reach. `relayFetch`
 * dispatches by URL: a `.onion` host rides the embedded Tor
 * (`torHttpRequest`, fail-closed: no Tor → a rejected promise, never a
 * clearnet fallback), anything else is the global `fetch` exactly as before
 * (clearnet HTTPS with certificate pinning for the official relay).
 *
 * The Tor branch returns a minimal Response-shaped object (`ok`, `status`,
 * `statusText`, `json()`, `text()`) — the subset every caller uses. Bodies must
 * be strings (every relay call sends JSON); binary uploads go through
 * `torHttpUpload` (crypto/media.ts) instead.
 */
import { torHttpRequest, isTorAvailable } from './tor';

export interface RelayResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** Response headers; the Tor bridge returns none (`get` → null) — callers treat headers as hints only. */
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RelayFetchInit {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

const ONION_HOST_RE = /^https?:\/\/[a-z2-7]{56}\.onion(?::\d+)?(?:\/|$)/i;

/** True when the URL targets a Tor hidden service (v3 onion host). */
export function isOnionUrl(url: string): boolean {
  return ONION_HOST_RE.test(url);
}

function torResponse(status: number, body: string): RelayResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  };
}

/**
 * `fetch` for relay endpoints. Same call shape as the global fetch for the
 * (string) bodies the relay API uses; see the module doc for the dispatch rule.
 */
export async function relayFetch(url: string, init: RelayFetchInit = {}): Promise<RelayResponse> {
  if (!isOnionUrl(url)) {
    return fetch(url, init as RequestInit) as unknown as Promise<RelayResponse>;
  }
  if (!isTorAvailable()) throw new Error('tor_unavailable');
  const res = await torHttpRequest(url, init.method ?? 'GET', init.body ?? '', init.headers ?? {});
  if (!res) throw new Error('relay_unreachable');
  return torResponse(res.status, res.body);
}
