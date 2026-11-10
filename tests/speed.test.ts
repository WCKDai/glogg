/**
 * Search speed: the first results go out as soon as the main sources have
 * enough, instead of waiting on the slowest one and the grace timers.
 */
import fsys from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankedSearchResponse } from '../src/core/index.js';
import { useTempGloggHome } from './helpers.js';

useTempGloggHome();
process.env.GLOGG_CONTAINER_RUNTIME = 'none';
const fs = await import('../server/federatedSearch.js');
const answers = await import('../server/answerEngine.js');

const QUERY = 'rust borrow checker';
const TOPICS = ['lifetimes', 'two-phase borrows', 'non-lexical lifetimes', 'interior mutability', 'Polonius', 'self-referential structs', 'closures', 'async functions'];
const hnHits = (n: number) => ({
  hits: Array.from({ length: n }, (_, i) => ({
    objectID: String(i + 1),
    title: `How the Rust borrow checker handles ${TOPICS[i % TOPICS.length]}`,
    url: `https://blog${i}.example/rust-borrow-checker-${i}`,
    points: 10,
    num_comments: 2,
    created_at: '2020-01-01T00:00:00Z',
  })),
});
const ghRepos = {
  items: [{ full_name: 'ferris/borrow-checker-explained', html_url: 'https://github.com/ferris/borrow-checker-explained', description: 'The Rust borrow checker, explained with diagrams', stargazers_count: 900, topics: ['rust'] }],
};

/** Upstreams with a delay per host; HN and GitHub have results, the rest answer empty. */
function stubUpstreams(delays: Record<string, number>): void {
  const local = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1') return local(input, init);
    const delay = Object.entries(delays).find(([h]) => url.hostname.endsWith(h))?.[1] ?? 0;
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => {
        if (url.hostname === 'hn.algolia.com') resolve(Response.json(hnHits(8)));
        else if (url.hostname === 'api.github.com') resolve(Response.json(ghRepos));
        else resolve(new Response('', { status: 404 }));
      }, delay);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  });
}

beforeEach(() => {
  fs.clearSearchCache();
  fs.resetSourceHealth();
  answers.clearInstantAnswerCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('first results, early', () => {
  it('go out once the main sources have enough, without waiting for the slowest', async () => {
    stubUpstreams({ 'hn.algolia.com': 20, 'api.github.com': 900 });
    const t0 = Date.now();
    let early: { at: number; response: RankedSearchResponse } | undefined;
    const final = await fs.executeFederatedSearch(QUERY, { lens: 'all' }, { onPartial: (response) => (early ??= { at: Date.now() - t0, response }) });
    const finalAt = Date.now() - t0;
    expect(early).toBeDefined();
    expect(early!.at).toBeLessThan(400);
    expect(early!.response.partial).toBe(true);
    expect(early!.response.results.length).toBeGreaterThanOrEqual(6);
    expect(early!.response.instantAnswer).toBeUndefined();
    // The full ranking still waits for GitHub, and has its result.
    expect(finalAt).toBeGreaterThanOrEqual(900);
    expect(final.partial).toBeUndefined();
    expect(final.results.map((r) => r.url)).toContain('https://github.com/ferris/borrow-checker-explained');
  });

  it('aren\'t sent separately when everything answers at once', async () => {
    stubUpstreams({});
    const onPartial = vi.fn();
    const final = await fs.executeFederatedSearch(QUERY, { lens: 'all' }, { onPartial });
    expect(onPartial).not.toHaveBeenCalled();
    expect(final.results.length).toBeGreaterThan(0);
  });

  it('a listener that throws doesn\'t break the search', async () => {
    stubUpstreams({ 'hn.algolia.com': 10, 'api.github.com': 300 });
    const final = await fs.executeFederatedSearch(QUERY, { lens: 'all' }, {
      onPartial: () => {
        throw new Error('listener failed');
      },
    });
    expect(final.results.length).toBeGreaterThan(0);
  });

  it('the gather reports its early batch once, with what had arrived', async () => {
    const batches: Record<string, unknown[]>[] = [];
    const slow = new Promise<never[]>((r) => setTimeout(() => r([]), 400));
    const got = await fs.gatherSources(
      [
        { key: 'fast', core: true, run: async () => Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, url: `https://x.example/${i}`, snippet: '', source: 'web' as const })) },
        { key: 'slow', core: true, run: () => slow },
      ],
      { onFirstBatch: (sofar) => batches.push(sofar), graceMs: 0, minWaitMs: 0 }
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].fast).toHaveLength(6);
    expect(batches[0].slow).toEqual([]);
    expect(got.fast).toHaveLength(6);
  });
});

describe('the search API streams when asked', () => {
  let port = 0;
  let server: http.Server;

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    const { createGloggServer } = await import('../server/index.js');
    server = http.createServer(await createGloggServer());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query: QUERY, config: { lens: 'all' } }) });

  it('sends the early batch, then the full ranking, one JSON object per line', async () => {
    stubUpstreams({ 'hn.algolia.com': 20, 'api.github.com': 700 });
    const t0 = Date.now();
    const res = await post({ Accept: 'application/x-ndjson' });
    expect(res.headers.get('content-type')).toMatch(/application\/x-ndjson/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: { type: string; at: number; response?: RankedSearchResponse }[] = [];
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        events.push({ ...JSON.parse(buf.slice(0, nl)), at: Date.now() - t0 });
        buf = buf.slice(nl + 1);
      }
    }
    expect(buf).toBe('');
    expect(events.map((e) => e.type)).toEqual(['partial', 'final']);
    expect(events[0].at).toBeLessThan(500);
    expect(events[1].at).toBeGreaterThanOrEqual(700);
    expect(events[1].response!.results.length).toBeGreaterThanOrEqual(events[0].response!.results.length);
  });

  it('answers plain JSON, as before, to everyone else', async () => {
    stubUpstreams({ 'hn.algolia.com': 20, 'api.github.com': 100 });
    const res = await post({});
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as RankedSearchResponse;
    expect(body.query).toBe(QUERY);
    expect(body.partial).toBeUndefined();
  });
});

describe('smaller answers', () => {
  let port = 0;
  let server: http.Server;
  const dist = path.resolve(import.meta.dirname, '../dist/assets');

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    const { createGloggServer } = await import('../server/index.js');
    server = http.createServer(await createGloggServer());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const raw = (p: string, headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  it('compresses big JSON for browsers that accept it, and leaves small JSON alone', async () => {
    stubUpstreams({});
    const body = JSON.stringify({ query: QUERY, config: { lens: 'all' } });
    const plain = await raw('/api/search', { 'Content-Type': 'application/json' }, body);
    const br = await raw('/api/search', { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate, br' }, body);
    const gz = await raw('/api/search', { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' }, body);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(br.headers['content-encoding']).toBe('br');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(br.headers.vary).toMatch(/Accept-Encoding/i);
    const fromBr = JSON.parse(zlib.brotliDecompressSync(br.body).toString('utf8'));
    const fromGz = JSON.parse(zlib.gunzipSync(gz.body).toString('utf8'));
    expect(fromBr.query).toBe(QUERY);
    expect(fromGz.results.map((r: { url: string }) => r.url)).toEqual(JSON.parse(plain.body.toString('utf8')).results.map((r: { url: string }) => r.url));
    expect(br.body.length).toBeLessThan(plain.body.length / 3);
    const health = await raw('/api/health', { 'Accept-Encoding': 'br' });
    expect(health.headers['content-encoding']).toBeUndefined();
  });

  it('gives the web app compact hidden rows, with the full count kept', async () => {
    stubUpstreams({});
    const ask = async (compact: boolean) =>
      JSON.parse((await raw('/api/search', { 'Content-Type': 'application/json' }, JSON.stringify({ query: 'best mechanical keyboard', compact, config: { lens: 'all' } }))).body.toString('utf8')) as RankedSearchResponse;
    const full = await ask(false);
    const compact = await ask(true);
    expect(compact.metrics.filteredSlopCount).toBe(full.metrics.filteredSlopCount);
    expect(compact.filteredSlop.length).toBeLessThanOrEqual(60);
    for (const row of compact.filteredSlop) {
      expect(row.signals).toEqual([]);
      expect(row.snippet.length).toBeLessThanOrEqual(280);
      expect(row.title && row.url && row.id).toBeTruthy();
    }
    expect(compact.results).toEqual(full.results);
  });

  it.skipIf(!fsys.existsSync(dist))('serves the app\'s hashed files compressed and cached for good, and nothing outside them', async () => {
    const js = fsys.readdirSync(dist).find((f) => f.endsWith('.js'))!;
    const r = await raw(`/assets/${js}`, { 'Accept-Encoding': 'br' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(zlib.brotliDecompressSync(r.body).equals(fsys.readFileSync(path.join(dist, js)))).toBe(true);
    expect(r.body.length).toBeLessThan(fsys.statSync(path.join(dist, js)).size / 2.5);
    for (const sneaky of ['/assets/../../package.json', '/assets/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json']) {
      const x = await raw(sneaky, { 'Accept-Encoding': 'br' });
      expect(x.body.toString('utf8')).not.toContain('"name": "glogg"');
    }
  });
});

describe('upstreams that rate-limit', () => {
  it('are left alone until they said, instead of being asked on every search', async () => {
    let asked = 0;
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname !== 'hn.algolia.com') return new Response('', { status: 404 });
      asked += 1;
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } });
    });
    await fs.executeFederatedSearch('first query about rust', { lens: 'all' });
    fs.clearSearchCache();
    await fs.executeFederatedSearch('second query about rust', { lens: 'all' });
    expect(asked).toBe(1);
    fs.resetSourceHealth();
    fs.clearSearchCache();
    await fs.executeFederatedSearch('third query about rust', { lens: 'all' });
    expect(asked).toBe(2);
  });
});

describe('giant upstream text', () => {
  it('is clipped before ranking, so one 200 KB description can\'t bloat or slow a search', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.github.com') return new Response('', { status: 404 });
      return Response.json({ items: [{ full_name: 'ferris/rust-borrow-checker', html_url: 'https://github.com/ferris/rust-borrow-checker', description: `Rust borrow checker ${'notes '.repeat(40_000)}`, stargazers_count: 5 }] });
    });
    const res = await fs.executeFederatedSearch('rust borrow checker', { lens: 'all' });
    const all = [...res.results, ...res.filteredSlop];
    const gh = all.find((r) => r.url === 'https://github.com/ferris/rust-borrow-checker');
    expect(gh).toBeDefined();
    expect(gh!.snippet.length).toBeLessThanOrEqual(1201);
    expect(JSON.stringify(res).length).toBeLessThan(100_000);
  });
});
