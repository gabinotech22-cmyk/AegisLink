/**
 * proxyLinkPreview.rebinding.test.ts — audit 2026-09-16 AL-03
 *
 * The proxy used to validate a hostname's DNS answer and then call fetch(),
 * which resolved the name AGAIN (TOCTOU: public to the check, private to the
 * connect), and read the whole upstream body with arrayBuffer() before slicing
 * 8 KB (unbounded memory). Now every hop resolves once, the connection is pinned
 * to the validated addresses through a dispatcher whose lookup never touches
 * DNS, and the body is streamed and cancelled at 8192 bytes.
 *
 * No network: the module's `__deps` seam replaces DNS, the dispatcher factory
 * and fetch.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Response as UndiciResponse } from 'undici';
import proxyLinkPreviewRoutes, { __deps, pinnedLookup, readBounded, MAX_PREVIEW_BYTES, type ResolvedAddr } from '../routes/proxyLinkPreview.js';

const app = express();
app.use('/proxy/linkpreview', proxyLinkPreviewRoutes);

const PUBLIC_A = { address: '93.184.216.34', family: 4 };
const PUBLIC_B = { address: '151.101.1.69', family: 4 };
const PRIVATE = { address: '10.0.0.7', family: 4 };

const original = { ...__deps };
afterEach(() => { Object.assign(__deps, original); });

interface FakeDispatcher { addrs: readonly ResolvedAddr[]; closed: boolean; close: () => Promise<void> }
function fakeDispatcherFactory(made: FakeDispatcher[]) {
  return (addrs: readonly ResolvedAddr[]) => {
    const d: FakeDispatcher = { addrs, closed: false, close: async () => { d.closed = true; } };
    made.push(d);
    return d as unknown as ReturnType<typeof __deps.makeDispatcher>;
  };
}

const HTML = '<html><head><meta property="og:title" content="Pinned"></head></html>';

describe('pinnedLookup never resolves DNS', () => {
  test('answers the pre-validated addresses in both net.connect call shapes', () => {
    const lk = pinnedLookup([PUBLIC_A, PUBLIC_B]);
    const all = jest.fn();
    lk('evil.example', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [PUBLIC_A, PUBLIC_B]);
    const single = jest.fn();
    lk('evil.example', {}, single);
    expect(single).toHaveBeenCalledWith(null, PUBLIC_A.address, 4);
  });

  test('fails closed with no addresses', () => {
    const cb = jest.fn();
    pinnedLookup([])('x', {}, cb);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe('GET /proxy/linkpreview — connection pinned to the validated answer', () => {
  test('resolves once per hop and fetches through a dispatcher built from that answer', async () => {
    const made: FakeDispatcher[] = [];
    const lookup = jest.fn(async () => [PUBLIC_A, PUBLIC_B]);
    const fetchSpy = jest.fn(async (_url: unknown, init?: { dispatcher?: unknown }) => {
      // The request MUST go through the dispatcher made from the validated addrs.
      expect(init?.dispatcher).toBe(made[0]);
      return new UndiciResponse(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    Object.assign(__deps, { lookup, makeDispatcher: fakeDispatcherFactory(made), fetch: fetchSpy });

    const res = await request(app).get('/proxy/linkpreview').query({ url: 'https://example.com/page' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Pinned');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
    expect(made[0]!.addrs).toEqual([PUBLIC_A, PUBLIC_B]);
    expect(made[0]!.closed).toBe(true);
  });

  test('a rebinding answer on a redirect hop is rejected before any request to it', async () => {
    const made: FakeDispatcher[] = [];
    // First host resolves public; the redirect target resolves into a private range.
    const lookup = jest.fn(async (host: string) => (host === 'example.com' ? [PUBLIC_A] : [PRIVATE]));
    const fetchSpy = jest.fn(async () =>
      new UndiciResponse(null, { status: 302, headers: { location: 'https://rebind.example/internal' } }));
    Object.assign(__deps, { lookup, makeDispatcher: fakeDispatcherFactory(made), fetch: fetchSpy });

    const res = await request(app).get('/proxy/linkpreview').query({ url: 'https://example.com/r' });
    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the first, validated hop
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('each redirect hop gets its own dispatcher pinned to its own answer', async () => {
    const made: FakeDispatcher[] = [];
    const lookup = jest.fn(async (host: string) => (host === 'a.example' ? [PUBLIC_A] : [PUBLIC_B]));
    let call = 0;
    const fetchSpy = jest.fn(async (_url: unknown, init?: { dispatcher?: unknown }) => {
      call += 1;
      expect(init?.dispatcher).toBe(made[call - 1]);
      return call === 1
        ? new UndiciResponse(null, { status: 301, headers: { location: 'https://b.example/final' } })
        : new UndiciResponse(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    Object.assign(__deps, { lookup, makeDispatcher: fakeDispatcherFactory(made), fetch: fetchSpy });

    const res = await request(app).get('/proxy/linkpreview').query({ url: 'https://a.example/start' });
    expect(res.status).toBe(200);
    expect(made.map((d) => d.addrs)).toEqual([[PUBLIC_A], [PUBLIC_B]]);
    expect(made.every((d) => d.closed)).toBe(true);
  });
});

describe('GET /proxy/linkpreview — body read is bounded', () => {
  test('an endless upstream body is cut at 8192 bytes and the stream is cancelled', async () => {
    const made: FakeDispatcher[] = [];
    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(HTML + ' '.repeat(4096 - HTML.length)); // 4 KB per pull
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    Object.assign(__deps, {
      lookup: async () => [PUBLIC_A],
      makeDispatcher: fakeDispatcherFactory(made),
      fetch: async () => new UndiciResponse(endless, { status: 200, headers: { 'content-type': 'text/html' } }),
    });

    const res = await request(app).get('/proxy/linkpreview').query({ url: 'https://example.com/huge' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Pinned');
    // 8192 / 4096 = 2 pulls (+ at most one pre-buffered by the stream's HWM).
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  test('readBounded returns exactly `limit` bytes from an oversized stream', async () => {
    const big = new Uint8Array(MAX_PREVIEW_BYTES * 4).fill(65);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(big); c.close(); } });
    const out = await readBounded(stream, MAX_PREVIEW_BYTES);
    expect(out.byteLength).toBe(MAX_PREVIEW_BYTES);
  });
});
