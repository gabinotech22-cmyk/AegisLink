/**
 * mailboxStatelessFetch — federation F5b: the desktop drains a relay's copy of
 * its mailbox with one HTTP round (challenge → signed fetch), parity with mobile.
 *   - the possession proof is over the relay's 32-byte nonce only;
 *   - persisted ids are acked on the NEXT fetch, never before; a handler that
 *     throws leaves its id un-acked;
 *   - acks are kept per relay copy (previous home vs home);
 *   - `onionUrl` targets another relay; fail-soft (0) on any error; off without
 *     mailbox mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

const h = vi.hoisted(() => ({ root: new Uint8Array(32).fill(7), enabled: true }));
vi.mock('../../config', () => ({ get MAILBOX_ENABLED() { return h.enabled; }, ONION_URL: 'http://' + 'o'.repeat(56) + '.onion', RELAY_URL: 'https://relay.test' }));
vi.mock('../../net/homeRelay', () => ({ homeRelayOnionUrl: () => 'http://' + 'o'.repeat(56) + '.onion' }));
vi.mock('../../net/tor', () => ({ TorSioSocket: class {} }));
vi.mock('../../crypto/mailboxStore', async () => {
  const { currentMailbox } = await import('../../crypto/mailbox');
  return {
    getOwnCurrentMailbox: async (now: number) => currentMailbox(h.root, now),
    getOwnMailboxesForEpochs: async () => [],
    getLastMailboxConnectEpoch: async () => null,
    setLastMailboxConnectEpoch: async () => undefined,
    getOwnMailboxRoot: async () => h.root,
  };
});

import { currentMailbox, verifyMailboxAuth } from '../../crypto/mailbox';

// Fresh module per test: the pending-ack table is module state.
let fetchMailboxOverTor: typeof import('../mailboxSocket').fetchMailboxOverTor;

const HOME = 'http://' + 'o'.repeat(56) + '.onion';
const PREV = 'http://' + 'p'.repeat(56) + '.onion';

type Call = { url: string; body: Record<string, unknown> };
function fakeRelay(envelopesByBase: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const nonce = nacl.randomBytes(32);
  const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith('/mailbox/challenge')) return { ok: true, json: async () => ({ nonce: encodeBase64(nonce) }) };
    if (url.endsWith('/mailbox/fetch')) {
      const base = url.replace('/mailbox/fetch', '');
      const mb = currentMailbox(h.root, Date.now());
      const sigOk = verifyMailboxAuth(mb.signPublicKey, nonce, decodeBase64(body.sig as string));
      if (!sigOk || body.mailboxId !== mb.mailboxIdB64) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ envelopes: envelopesByBase[base] ?? [] }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}

const env = (id: string) => ({ id, to: 'x', ciphertext: 'c', nonce: 'n', epk: 'e', createdAt: 1 });

describe('fetchMailboxOverTor (desktop, F5b)', () => {
  beforeEach(async () => {
    h.enabled = true;
    vi.resetModules();
    ({ fetchMailboxOverTor } = await import('../mailboxSocket'));
  });

  it('challenge → signed fetch on the home by default, persists envelopes, acks them only on the NEXT fetch', async () => {
    const { calls } = fakeRelay({ [HOME]: [env('a'), env('b')] });
    const seen: string[] = [];
    expect(await fetchMailboxOverTor(async (e) => { seen.push(e.id); })).toBe(2);
    expect(seen).toEqual(['a', 'b']);
    expect(calls.map((c) => c.url)).toEqual([`${HOME}/mailbox/challenge`, `${HOME}/mailbox/fetch`]);
    expect(calls[1].body.ackIds).toBeUndefined(); // nothing to ack yet
    expect(calls[1].body.mailboxSignPubKey).toBeDefined();

    calls.length = 0;
    await fetchMailboxOverTor(async () => undefined);
    expect(calls[1].body.ackIds).toEqual(['a', 'b']); // acked after being stored
  });

  it('a handler that throws leaves its id un-acked; acks are per relay copy; onionUrl targets the previous home', async () => {
    const { calls } = fakeRelay({ [PREV]: [env('p1'), env('p2')], [HOME]: [env('h1')] });
    expect(await fetchMailboxOverTor(async (e) => { if (e.id === 'p2') throw new Error('not persisted'); }, { onionUrl: PREV })).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([`${PREV}/mailbox/challenge`, `${PREV}/mailbox/fetch`]);

    calls.length = 0;
    await fetchMailboxOverTor(async () => undefined); // home: its own ack list (empty)
    expect(calls[1].url).toBe(`${HOME}/mailbox/fetch`);
    expect(calls[1].body.ackIds).toBeUndefined();

    calls.length = 0;
    await fetchMailboxOverTor(async () => undefined, { onionUrl: PREV });
    expect(calls[1].body.ackIds).toEqual(['p1']); // p2 was never acked
  });

  it('fails soft: mailbox mode off → 0 without network; a non-32-byte nonce is never signed; transport errors → 0', async () => {
    const { fetchMock } = fakeRelay({});
    h.enabled = false;
    expect(await fetchMailboxOverTor(async () => undefined)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    h.enabled = true;

    const bad = vi.fn(async (url: string) => url.endsWith('/mailbox/challenge')
      ? { ok: true, json: async () => ({ nonce: encodeBase64(nacl.randomBytes(16)) }) }
      : { ok: true, json: async () => ({ envelopes: [env('x')] }) });
    globalThis.fetch = bad as unknown as typeof fetch;
    expect(await fetchMailboxOverTor(async () => undefined)).toBe(0);
    expect(bad).toHaveBeenCalledTimes(1); // never reached /mailbox/fetch

    globalThis.fetch = vi.fn(async () => { throw new Error('tor down'); }) as unknown as typeof fetch;
    expect(await fetchMailboxOverTor(async () => undefined)).toBe(0);
  });
});
