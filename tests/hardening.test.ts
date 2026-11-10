/**
 * The security review's findings, each pinned by a test that failed before its
 * fix: private-address fetching, stored keys sent to strange indexers, download
 * names that climb out of their folder, regex built from queries, headers,
 * the OpenSearch descriptor, site icons and aria2's secret.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeQueryRelevance } from '../src/core/index.js';
import { fixtureServer, rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';

const home = useTempGloggHome();
const downloads = path.join(home, 'dl', 'inner');
process.env.GLOGG_DOWNLOADS_DIR = downloads;
process.env.GLOGG_CONTAINER_RUNTIME = 'none';

const { assertPublicUrl, isPrivateAddress, PrivateAddressError, publicFetch } = await import('../server/publicFetch.js');
const dm = await import('../server/downloadManager.js');
const icons = await import('../server/favicons.js');

/** Runs `fn` with private addresses refused, as in production (tests normally allow them for fixtures). */
async function asInProduction<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.GLOGG_ALLOW_PRIVATE_FETCH;
  delete process.env.GLOGG_ALLOW_PRIVATE_FETCH;
  try {
    return await fn();
  } finally {
    process.env.GLOGG_ALLOW_PRIVATE_FETCH = saved;
  }
}

describe('fetching addresses from outside', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['::1', true],
    ['[::1]', true],
    ['fe80::1', true],
    ['fd12:3456::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:a9fe:a9fe', true],
    ['64:ff9b::a00:1', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['2606:4700:4700::1111', false],
    ['::ffff:8.8.8.8', false],
    ['not an address', true],
  ])('%s is private: %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it('refuses a name that resolves to a private address, or to several where one is private', async () => {
    await asInProduction(async () => {
      const lookup = (answers: string[]) => async () => answers.map((address) => ({ address }));
      await expect(assertPublicUrl(new URL('https://intranet.example/'), lookup(['10.0.0.5']))).rejects.toBeInstanceOf(PrivateAddressError);
      await expect(assertPublicUrl(new URL('https://mixed.example/'), lookup(['93.184.216.34', '127.0.0.1']))).rejects.toBeInstanceOf(PrivateAddressError);
      await expect(assertPublicUrl(new URL('https://ok.example/'), lookup(['93.184.216.34']))).resolves.toBeUndefined();
      await expect(assertPublicUrl(new URL('http://2130706433/'), lookup([]))).rejects.toBeInstanceOf(PrivateAddressError);
      await expect(assertPublicUrl(new URL('file:///etc/passwd'), lookup([]))).rejects.toThrow(/Only http\(s\)/);
    });
  });

  it('checks every redirect, so a public page can\'t bounce glogg to a private one', async () => {
    await asInProduction(async () => {
      const seen: string[] = [];
      vi.stubGlobal('fetch', async (input: URL) => {
        seen.push(String(input));
        return new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
      });
      try {
        await expect(publicFetch('https://ok.example/start', {}, async () => [{ address: '93.184.216.34' }])).rejects.toBeInstanceOf(PrivateAddressError);
        expect(seen).toEqual(['https://ok.example/start']);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('follows public redirects itself and returns the last answer', async () => {
    const site = await fixtureServer({
      '/a': { status: 301, headers: { Location: '/b' } },
      '/b': { status: 302, headers: { Location: '/c' } },
      '/c': { body: 'arrived' },
    });
    try {
      const res = await publicFetch(`${site.baseUrl}/a`);
      expect(await res.text()).toBe('arrived');
      expect(site.hits).toEqual(['GET /a', 'GET /b', 'GET /c']);
    } finally {
      await site.close();
    }
  });
});

describe('the server, as it runs for real', () => {
  let port = 0;
  let close: () => Promise<void>;
  const json = { 'Content-Type': 'application/json' };

  beforeAll(async () => {
    ({ port, close } = await startGloggServer());
  });
  afterAll(() => close());
  afterEach(() => icons.clearIconCache());

  it('won\'t read a page on a private address for the reader', async () => {
    const site = await fixtureServer({ '/': { body: '<p>router admin</p>' } });
    try {
      const r = await asInProduction(() =>
        rawRequest(port, { method: 'POST', path: '/api/inspect', headers: json, body: JSON.stringify({ url: `${site.baseUrl}/` }) })
      );
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body).error).toMatch(/private or local address/);
      expect(site.hits).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it('lets other sites search with GET, but not POST, which can name indexers', async () => {
    const post = await rawRequest(port, { method: 'POST', path: '/api/search', headers: { ...json, Origin: 'https://evil.example' }, body: '{"query":"x"}' });
    expect(post.status).toBe(403);
    const preflight = await rawRequest(port, { method: 'OPTIONS', path: '/api/search', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(preflight.status).toBe(403);
    const getPreflight = await rawRequest(port, { method: 'OPTIONS', path: '/api/search', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(getPreflight.status).toBe(204);
    expect(getPreflight.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
  });

  it('never sends a stored indexer key to an indexer the request names', async () => {
    const asked: string[] = [];
    const evil = http.createServer((req, res) => {
      asked.push(req.url || '');
      res.writeHead(200, { 'Content-Type': 'application/xml' }).end('<rss><channel></channel></rss>');
    });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    const evilUrl = `http://127.0.0.1:${(evil.address() as AddressInfo).port}/api`;
    try {
      dm.saveIntegrationConfig({ torznabUrl: 'http://127.0.0.1:9/stored', torznabApiKey: 'STORED-KEY-1234' });
      const r = await rawRequest(port, {
        method: 'POST',
        path: '/api/search',
        headers: json,
        body: JSON.stringify({ query: 'ubuntu iso', config: { lens: 'p2p-magnet', endpoints: { torznabUrl: evilUrl } } }),
      });
      expect(r.status).toBe(200);
      expect(asked.length).toBeGreaterThan(0);
      for (const u of asked) expect(u).not.toContain('STORED-KEY');
    } finally {
      dm.saveIntegrationConfig({ torznabUrl: '', torznabApiKey: '' });
      await new Promise<void>((r) => evil.close(() => r()));
    }
  });

  it('sends security headers, and no x-powered-by', async () => {
    for (const p of ['/api/health', '/api/plugins', '/opensearch.xml']) {
      const r = await rawRequest(port, { path: p });
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(r.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('describes itself for browsers without echoing a strange Host or protocol', async () => {
    const odd = await rawRequest(port, { path: '/opensearch.xml', headers: { Host: 'evil"><x a="', 'X-Forwarded-Proto': 'javascript' } });
    expect(odd.body).not.toContain('evil');
    expect(odd.body).not.toContain('javascript');
    expect(odd.body).toContain('template="http://localhost:4173/?q={searchTerms}"');
    const behindProxy = await rawRequest(port, { path: '/opensearch.xml', headers: { Host: 'glogg.example.com', 'X-Forwarded-Proto': 'https' } });
    expect(behindProxy.body).toContain('template="https://glogg.example.com/?q={searchTerms}"');
  });

  it('serves site icons itself: raster only, small, and asked for once', async () => {
    const asked: string[] = [];
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://icons.duckduckgo.com/')) return real(input, init);
      asked.push(url);
      if (url.includes('svg.example')) return new Response('<svg onload="alert(1)"/>', { headers: { 'Content-Type': 'image/svg+xml' } });
      if (url.includes('huge.example')) return new Response(Buffer.alloc(200_000), { headers: { 'Content-Type': 'image/png' } });
      if (url.includes('missing.example')) return new Response('', { status: 404 });
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    });
    try {
      const get = (d: string) => rawRequest(port, { path: `/api/favicon/${d}` });
      const ok = await get('tiny.example');
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toBe('image/png');
      await get('tiny.example');
      expect(asked.filter((u) => u.includes('tiny.example'))).toHaveLength(1);
      expect((await get('svg.example')).status).toBe(404);
      expect((await get('huge.example')).status).toBe(404);
      expect((await get('missing.example')).status).toBe(404);
      for (const bad of ['localhost', '127.0.0.1', '..%2F..%2Fetc', 'a%20b.example', 'x'.repeat(300) + '.example']) {
        expect((await get(bad)).status).toBe(400);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('downloads', () => {
  it.each([
    ['https://x.example/file/..%2Fescaped.txt', 'escaped.txt'],
    ['https://x.example/file/..%2F..%2F..%2Fetc%2Fcron.d%2Fjob.sh', 'job.sh'],
    ['https://x.example/a/..%5C..%5Cwin.ini', 'win.ini'],
    ['https://x.example/a/.bashrc.txt', 'bashrc.txt'],
    ['https://x.example/a/nul%00l.iso', 'null.iso'],
    ['https://x.example/a/plain-name.zip', 'plain-name.zip'],
  ])('keeps %s inside its folder as "%s"', (url, name) => {
    expect(dm.filenameFor(url, 'title', 'direct-file')).toBe(name);
  });

  it('saves into the folder, never over a file, and never outside it', async () => {
    fs.mkdirSync(downloads, { recursive: true });
    const first = await dm.saveNew(downloads, 'a.txt', new Response('one'));
    const second = await dm.saveNew(downloads, 'a.txt', new Response('two'));
    expect(path.basename(first)).toBe('a.txt');
    expect(path.basename(second)).toBe('a (1).txt');
    expect(fs.readFileSync(first, 'utf8')).toBe('one');
    await expect(dm.saveNew(downloads, '../out.txt', new Response('x'))).rejects.toThrow(/leaves the downloads folder/);
    expect(fs.existsSync(path.join(downloads, '..', 'out.txt'))).toBe(false);
  });

  it('a link ending in ..%2F lands in the downloads folder, not above it', async () => {
    const site = await fixtureServer({ '/file/..%2Fescaped-probe.txt': { body: 'probe' }, '/file/../escaped-probe.txt': { body: 'probe' } });
    try {
      const job = await dm.enqueueDownload({ url: `${site.baseUrl}/file/..%2Fescaped-probe.txt`, target: 'local-vault' });
      expect(job.status).toBe('completed');
      expect(job.destinationUrl).toBe(path.join(downloads, 'escaped-probe.txt'));
      expect(fs.existsSync(path.join(downloads, '..', 'escaped-probe.txt'))).toBe(false);
    } finally {
      await site.close();
    }
  });

  it('refuses a target it doesn\'t know', async () => {
    await expect(dm.enqueueDownload({ url: 'https://x.example/a.zip', target: 'elsewhere' as never })).rejects.toThrow(/Unknown download target/);
  });
});

describe('queries are text, not patterns', () => {
  it('a query full of regex syntax neither throws nor hangs', () => {
    for (const q of ['what is the capital of (rust', 'what is the capital of (a+)+$', 'what is the capital of ([a-z]+)*$', 'what is the capital of [[[']) {
      const t = performance.now();
      expect(() => computeQueryRelevance(q, 'capital of aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', `${'a'.repeat(40)}!`, 'https://x.example/')).not.toThrow();
      expect(performance.now() - t).toBeLessThan(50);
    }
  });
});

describe('aria2 secret', () => {
  it('is made once per install, at random, kept private, and handed to the services stack', async () => {
    dm.saveIntegrationConfig({ aria2RpcSecret: '' });
    const secret = dm.aria2Secret();
    expect(secret).toMatch(/^[\w-]{32}$/);
    expect(secret).not.toBe('glogg-secret');
    expect(dm.aria2Secret()).toBe(secret);
    expect(fs.statSync(path.join(home, 'integrations.json')).mode & 0o777).toBe(0o600);
    const { composeEnv } = await import('../server/containerManager.js');
    expect(composeEnv().ARIA2_RPC_SECRET).toBe(secret);
    expect(fs.readFileSync(path.resolve(import.meta.dirname, '../infra/docker-compose.services.yml'), 'utf8')).not.toContain('glogg-secret');
  });
});
