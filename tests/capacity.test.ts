import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import http from 'node:http';
import { BusyError, createWorkLimit, runWithCapacity } from '../server/workLimits.js';
import { rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';
import { fetchUpstream, readUpstreamText } from '../server/upstream.js';

useTempGloggHome();
process.env.GLOGG_CONTAINER_RUNTIME = 'none';
process.env.GLOGG_MAX_SEARCHES = '1';
process.env.GLOGG_SOURCE_DEADLINE_MS = '10';
process.env.GLOGG_HARD_DEADLINE_MS = '20';
const search = await import('../server/federatedSearch.js');
afterEach(() => { vi.unstubAllGlobals(); search.clearSearchCache(); search.resetSourceHealth(); });

describe('bounded background work', () => {
  it('keeps reader DNS work bounded after disconnects, then recovers', async () => {
    vi.stubEnv('GLOGG_MAX_READERS', '1');
    vi.stubEnv('GLOGG_ALLOW_PRIVATE_FETCH', '');
    const lookups: ((value: { address: string; family: number }[]) => void)[] = [];
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation((() => new Promise((resolve) => lookups.push(resolve))) as typeof dns.lookup);
    vi.stubGlobal('fetch', async () => new Response('<html><title>Article</title><body><p>A useful article.</p></body></html>'));
    const server = await startGloggServer();
    const body = JSON.stringify({ url: 'https://slow-reader.example/article' });
    const request = { method: 'POST', path: '/api/inspect', headers: { 'Content-Type': 'application/json' }, body };
    const first = http.request({ hostname: '127.0.0.1', port: server.port, method: 'POST', path: request.path, headers: request.headers });
    first.on('error', () => {});
    first.end(body);
    try {
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
      first.destroy();
      const busy = await Promise.race([rawRequest(server.port, request), new Promise<{ status: number; headers: Record<string, string> }>((resolve) => setTimeout(() => resolve({ status: 0, headers: {} }), 200))]);
      expect(busy.status).toBe(503);
      expect(busy.headers['retry-after']).toBe('1');
      expect(lookup).toHaveBeenCalledOnce();
      lookups.forEach((resolve) => resolve([{ address: '93.184.216.34', family: 4 }]));
      lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
      await vi.waitFor(async () => expect((await rawRequest(server.port, request)).status).toBe(200));
    } finally {
      first.destroy();
      lookups.forEach((resolve) => resolve([{ address: '93.184.216.34', family: 4 }]));
      lookup.mockRestore(); vi.unstubAllEnvs(); await server.close();
    }
  });
  it('bounds distinct favicon producers while preserving in-flight sharing', async () => {
    const { siteIcon, clearIconCache } = await import('../server/favicons.js');
    const resolvers: ((r: Response) => void)[] = [];
    const fetch = vi.fn(() => new Promise<Response>((r) => resolvers.push(r))) as unknown as typeof globalThis.fetch;
    const jobs = Array.from({ length: 32 }, (_, i) => siteIcon(`site${i}.example`, fetch));
    try {
      expect(siteIcon('site0.example', fetch)).toBe(jobs[0]);
      expect(() => siteIcon('overflow.example', fetch)).toThrow(BusyError);
      expect(resolvers).toHaveLength(32);
    } finally {
      resolvers.forEach((r) => r(new Response('', { status: 404 })));
      await Promise.all(jobs); clearIconCache();
    }
  });
  it('holds capacity after an early response until every task settles, including rejections', async () => {
    const limit = createWorkLimit(1);
    let finish!: () => void;
    let fail!: (error: Error) => void;
    await expect(runWithCapacity(limit, async (track) => {
      track(new Promise<void>((resolve) => { finish = resolve; }));
      track(new Promise<void>((_resolve, reject) => { fail = reject; }));
      return 'early response';
    })).resolves.toBe('early response');
    expect(limit.active).toBe(1);
    expect(() => runWithCapacity(limit, async () => 'overflow')).toThrow(BusyError);
    finish(); await Promise.resolve();
    expect(limit.active).toBe(1);
    fail(new Error('upstream failure'));
    await vi.waitFor(() => expect(limit.active).toBe(0));
    await expect(runWithCapacity(limit, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('releases on synchronous errors and makes releases idempotent', async () => {
    const limit = createWorkLimit(1);
    const release = limit.acquire(); release(); release();
    expect(limit.active).toBe(0);
    expect(() => runWithCapacity(limit, () => { throw new Error('failure'); })).toThrow('failure');
    await vi.waitFor(() => expect(limit.active).toBe(0));
    expect(() => createWorkLimit(0)).toThrow();
  });

  it('returns HTTP 503 before NDJSON headers, keeps health responsive, and recovers', async () => {
    let resolve!: (response: Response) => void;
    const localFetch = globalThis.fetch;
    let sourceCalls = 0;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === '127.0.0.1') return localFetch(input, init);
      if (url.hostname === 'slow.example') { sourceCalls++; return new Promise<Response>((r) => { resolve = r; }); }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    const server = await startGloggServer();
    const body = JSON.stringify({ query: 'site:example.com capacity', config: { endpoints: { searxngUrl: 'https://slow.example' } } });
    try {
      const first = await rawRequest(server.port, { method: 'POST', path: '/api/search', headers: { 'Content-Type': 'application/json' }, body });
      expect(first.status).toBe(200);
      expect(sourceCalls).toBe(1);
      const busy = await rawRequest(server.port, { method: 'POST', path: '/api/search', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body });
      expect(busy.status).toBe(503);
      expect(busy.headers['retry-after']).toBe('1');
      expect(busy.headers['content-type']).toMatch(/application\/json/);
      expect(sourceCalls).toBe(1);
      expect((await rawRequest(server.port, { path: '/api/health' })).status).toBe(200);
      resolve(Response.json({ results: [] }));
      await new Promise((r) => setTimeout(r, 10));
      expect((await rawRequest(server.port, { method: 'POST', path: '/api/search', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(200);
    } finally { resolve?.(Response.json({ results: [] })); await server.close(); }
  });
});

describe('upstream body bounds', () => {
  it('cancels unused error bodies before returning headers to a producer', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); }, cancel: cancelled }), { status: 500 }));
    expect((await fetchUpstream('https://example.com')).status).toBe(500);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('rejects and cancels oversized chunked bodies rather than parsing truncated data', async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel: cancelled }));
    await expect(readUpstreamText(response, 10)).rejects.toThrow(/exceeds 10 bytes/);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('preserves UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('café');
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 4)); c.enqueue(bytes.slice(4)); c.close(); } }));
    await expect(readUpstreamText(response)).resolves.toBe('café');
  });
  it('honors caller cancellation while retaining a deadline', async () => {
    vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason)); }));
    const ctrl = new AbortController();
    const pending = fetchUpstream('https://example.com', { signal: ctrl.signal }, 5000);
    ctrl.abort();
    await expect(pending).rejects.toThrow();
  });
});
