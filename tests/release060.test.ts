import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_BANGS,
  evaluateInstantComputation,
  resolveBang,
  suggestBangs,
} from '../src/core/index.js';
import { SEARCH_SOURCES as SOURCE_CATALOG } from '../src/core/sourceCatalog.js';
import { discoverFeeds } from '../server/deep/parse.js';
import { buildExtension, createZipArchive } from '../scripts/build-extension.js';
import { checkBundle } from '../scripts/check-bundle.js';
import { startGloggServer, useTempGloggHome } from './helpers.js';

useTempGloggHome();
const deep = await import('../server/deep/index.js');
const { executeFederatedSearch } = await import('../server/federatedSearch.js');
const { createGloggServer } = await import('../server/index.js');
const { runCli } = await import('../scripts/glogg-cli.js');

describe('0.6.0 developer & sysadmin instant computations', () => {
  it('evaluates Unix chmod numeric (3- and 4-digit) and symbolic permissions', () => {
    const c755 = evaluateInstantComputation('chmod 755');
    expect(c755?.title).toContain('rwxr-xr-x');
    expect(c755?.title).toContain('0755');
    expect(c755?.directAnswer).toContain('Owner: read + write + execute (7)');

    const c4755 = evaluateInstantComputation('chmod 4755');
    expect(c4755?.title).toContain('rwsr-xr-x');
    expect(c4755?.keyFacts?.some((f) => f.value.toLowerCase().includes('setuid'))).toBe(true);

    const c2750 = evaluateInstantComputation('chmod 2750');
    expect(c2750?.title).toContain('rwxr-s---');

    const c1777 = evaluateInstantComputation('chmod 1777');
    expect(c1777?.title).toContain('rwxrwxrwt');

    const sym = evaluateInstantComputation('chmod rwxr-x---');
    expect(sym?.title).toContain('0750');
    expect(sym?.title).toContain('rwxr-x---');

    expect(evaluateInstantComputation('chmod 999')).toBeNull();
    expect(evaluateInstantComputation('0755')).toBeNull();
  });

  it('evaluates display resolutions, aspect ratios, and megapixels', () => {
    const fhd = evaluateInstantComputation('1920x1080');
    expect(fhd?.directAnswer).toContain('16:9');
    expect(fhd?.directAnswer).toContain('2.07 MP');
    expect(fhd?.title).toContain('Full HD');

    const uhd = evaluateInstantComputation('3840×2160');
    expect(uhd?.directAnswer).toContain('16:9');
    expect(uhd?.title).toContain('4K UHD');

    const wqxga = evaluateInstantComputation('2560x1600');
    expect(wqxga?.directAnswer).toContain('8:5');
    expect(wqxga?.title).toContain('WQXGA');

    expect(evaluateInstantComputation('0x1080')).toBeNull();
  });

  it('identifies well-known TCP/UDP network ports', () => {
    const pg = evaluateInstantComputation('port 5432');
    expect(pg?.title).toContain('PostgreSQL (TCP)');
    expect(pg?.directAnswer).toContain('PostgreSQL');

    const redis = evaluateInstantComputation('tcp port 6379');
    expect(redis?.title).toContain('Redis');

    expect(evaluateInstantComputation('port 65535')).toBeNull();
    expect(evaluateInstantComputation('port 99999')).toBeNull();
  });

  it('encodes and decodes Base64 and URL strings strictly offline', () => {
    const b64Enc = evaluateInstantComputation('base64 encode glögg search');
    expect(b64Enc?.directAnswer).toBe(Buffer.from('glögg search', 'utf8').toString('base64'));

    const b64Dec = evaluateInstantComputation(`base64 decode ${b64Enc!.directAnswer}`);
    expect(b64Dec?.directAnswer).toBe('glögg search');

    const urlEnc = evaluateInstantComputation('url encode https://glogg.app/?q=small web & forums');
    expect(urlEnc?.directAnswer).toBe('https%3A%2F%2Fglogg.app%2F%3Fq%3Dsmall%20web%20%26%20forums');

    const urlDec = evaluateInstantComputation('url decode https%3A%2F%2Fglogg.app%2F%3Fq%3Dsmall%20web');
    expect(urlDec?.directAnswer).toBe('https://glogg.app/?q=small web');
    expect(evaluateInstantComputation('url decode %E0%A4%A')).toBeNull();
  });

  it('decodes JWT headers, payloads, and claims without contacting the network', () => {
    const seg = (obj: object) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: 'user_42', iss: 'glogg.local', iat: 1700000000, exp: futureExp })}.signature`;
    const ans = evaluateInstantComputation(`jwt ${token}`);
    expect(ans?.kind).toBe('computation');
    expect(ans?.title).toBe('JWT (HS256)');
    expect(ans?.directAnswer).toContain('user_42');
    expect(ans?.keyFacts?.some((f) => f.label === 'Algorithm' && f.value === 'HS256')).toBe(true);
    expect(ans?.keyFacts?.some((f) => f.label === 'Expires (exp)')).toBe(true);

    const bareAns = evaluateInstantComputation(token);
    expect(bareAns?.title).toBe('JWT (HS256)');

    expect(evaluateInstantComputation('jwt eyJbad.eyJbad.sig')).toBeNull();
  });
});

describe('0.6.0 developer !bangs & 28-source catalog', () => {
  it('resolves all 8 new reference and package-ecosystem !bangs and registers Mojeek + Kagi connectors', () => {
    expect(SOURCE_CATALOG).toHaveLength(28);
    expect(SOURCE_CATALOG.map((s) => s.id)).toEqual(expect.arrayContaining(['mojeek', 'kagi']));
    expect(BUILTIN_BANGS.map((b) => b.trigger)).toEqual(
      expect.arrayContaining(['rfc', 'cve', 'man', 'crates', 'docsrs', 'pypi', 'go', 'aur'])
    );

    expect(resolveBang('!rfc 9110')?.url).toBe('https://datatracker.ietf.org/doc/search?name=9110&rfcs=on');
    expect(resolveBang('!cve CVE-2024-3094')?.url).toContain('CVE-2024-3094');
    expect(resolveBang('!man epoll')?.url).toBe('https://manpages.debian.org/jump?q=epoll');
    expect(resolveBang('!crates serde')?.url).toBe('https://crates.io/search?q=serde');
    expect(resolveBang('!docsrs tokio')?.url).toBe('https://docs.rs/releases/search?query=tokio');
    expect(resolveBang('!pypi httpx')?.url).toBe('https://pypi.org/search/?q=httpx');
    expect(resolveBang('!go net/http')?.url).toBe('https://pkg.go.dev/search?q=net%2Fhttp');
    expect(resolveBang('!aur ripgrep')?.url).toBe('https://aur.archlinux.org/packages?K=ripgrep');
    expect(suggestBangs('!cr').map((b) => b.trigger)).toContain('crates');
  });
});

describe('0.6.0 feed discovery, refreshUserSource, Mojeek/Kagi connectors & OpenSearch', () => {
  let upstreamServer: http.Server;
  let upstreamBase = '';
  let server: Awaited<ReturnType<typeof startGloggServer>>;
  let feedCounter = 0;

  beforeAll(async () => {
    upstreamServer = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname === '/anchor-linked') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><a href="/posts/rss.xml">Subscribe RSS</a></body></html>');
        return;
      }
      if (u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>No head link blog</h1></body></html>');
        return;
      }
      if (u.pathname === '/feed.xml' || u.pathname === '/posts/rss.xml') {
        feedCounter += 1;
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>Indie Log</title>` +
            `<item><title>Post #${feedCounter} on unikernels</title><link>${upstreamBase}/post-${feedCounter}</link>` +
            `<description>unikernels and sqlite fts5 notes ${feedCounter}</description></item></channel></rss>`
        );
        return;
      }
      if (u.pathname === '/mojeek-ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            response: {
              status: 'OK',
              results: [
                {
                  title: 'Unikernel Design Notes',
                  url: 'https://unikernel-notes.example/design',
                  desc: 'Independent Mojeek crawler hit on unikernel memory isolation.',
                },
              ],
            },
          })
        );
        return;
      }
      if (u.pathname === '/kagi-ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                t: 0,
                title: 'Kagi Teclis Unikernel Paper',
                url: 'https://teclis-research.example/unikernels',
                snippet: 'Primary unikernel scheduling notes from Kagi Search API.',
                published: '2025-04-01T00:00:00Z',
              },
              { t: 1, list: ['related query'] },
            ],
          })
        );
        return;
      }
      res.writeHead(404).end('not found');
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstreamBase = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`;
    server = await startGloggServer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => upstreamServer?.close(() => resolve()));
    deep.resetDeepIndex();
  });

  it('discovers application/json feeds, anchor-linked feeds, and root /feed.xml fallback, then refreshes on demand', async () => {
    expect(discoverFeeds('<link rel="alternate" type="application/json" href="/f.json">', 'https://b.example/')).toEqual([
      'https://b.example/f.json',
    ]);
    expect(discoverFeeds('<html><body><a href="/posts/atom.xml">RSS</a></body></html>', 'https://b.example/')).toEqual([
      'https://b.example/posts/atom.xml',
    ]);

    const addedRoot = await deep.addUserSource(upstreamBase);
    expect(addedRoot.url).toBe(`${upstreamBase}/feed.xml`);

    const addedAnchor = await deep.addUserSource(`${upstreamBase}/anchor-linked`);
    expect(addedAnchor.url).toBe(`${upstreamBase}/posts/rss.xml`);

    // Refresh via HTTP API
    const okRes = await fetch(`http://127.0.0.1:${server.port}/api/deep/sources/${addedRoot.id}/refresh`, { method: 'POST' });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { visit: string; source: { posts: number } };
    expect(okBody.visit).toBe('ok');
    expect(okBody.source.posts).toBeGreaterThanOrEqual(1);

    // Unknown ID -> 404, invalid ID -> 400
    const missingRes = await fetch(`http://127.0.0.1:${server.port}/api/deep/sources/999999/refresh`, { method: 'POST' });
    expect(missingRes.status).toBe(404);
    const badIdRes = await fetch(`http://127.0.0.1:${server.port}/api/deep/sources/not-a-number/refresh`, { method: 'POST' });
    expect(badIdRes.status).toBe(400);

    // Refresh via CLI
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
    await runCli(['node', 'glogg', 'deep', 'refresh', String(addedAnchor.id), '--json']);
    spy.mockRestore();
    expect(JSON.parse(logs.join('\n'))).toMatchObject({ visit: 'ok' });
  });

  it('queries Mojeek and Kagi connectors only when their API keys are configured and records refusals on 401/403', async () => {
    const realFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seenUrls.push(url);
      if (url.startsWith('https://api.mojeek.com/search')) {
        if (url.includes('api_key=bad-key')) return new Response('Forbidden', { status: 403 });
        return realFetch(`${upstreamBase}/mojeek-ok`, init);
      }
      if (url.startsWith('https://kagi.com/api/v0/search')) {
        const auth = new Headers(init?.headers).get('Authorization') || '';
        if (auth.includes('bad-key')) return new Response('Unauthorized', { status: 401 });
        return realFetch(`${upstreamBase}/kagi-ok`, init);
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    // Without keys: neither Mojeek nor Kagi is contacted
    await executeFederatedSearch('unikernels alpha', { endpoints: {} });
    expect(seenUrls.some((u) => u.includes('mojeek.com') || u.includes('kagi.com'))).toBe(false);

    // With valid keys: both return results with their respective connector IDs
    const withKeys = await executeFederatedSearch('unikernel', {
      endpoints: { mojeekApiKey: 'mj-valid', kagiApiKey: 'kg-valid' },
    });
    expect(withKeys.results.map((i) => i.source)).toEqual(expect.arrayContaining(['mojeek', 'kagi']));

    // With rejected keys: refusal status surfaces cleanly without throwing
    const rejected = await executeFederatedSearch('unikernel gamma', {
      endpoints: { mojeekApiKey: 'bad-key', kagiApiKey: 'bad-key' },
    });
    expect(rejected.metrics.sourceTimings?.mojeek?.status).toBe('refused');
    expect(rejected.metrics.sourceTimings?.kagi?.status).toBe('refused');
  });

  it('serves OpenSearch suggestions for instant computations, !bangs, curated sites, and same-origin private deep posts', async () => {
    const calcRes = await fetch(`http://127.0.0.1:${server.port}/api/opensearch/suggest?q=${encodeURIComponent('chmod 755')}`);
    const [, calcCompletions, calcDescs] = (await calcRes.json()) as [string, string[], string[], string[]];
    expect(calcCompletions[0]).toContain('Owner: read + write + execute');
    expect(calcDescs[0]).toContain('Unix File Permissions');

    const bangRes = await fetch(`http://127.0.0.1:${server.port}/api/opensearch/suggest?q=${encodeURIComponent('!cr')}`);
    const [, bangCompletions] = (await bangRes.json()) as [string, string[]];
    expect(bangCompletions[0]).toBe('!crates ');

    // Same-origin / omnibox request in private mode includes local deep-index title match ("Post #1 on unikernels")
    const localRes = await fetch(`http://127.0.0.1:${server.port}/api/opensearch/suggest?q=unikernels`);
    const [, localCompletions] = (await localRes.json()) as [string, string[]];
    expect(localCompletions.some((c) => c.toLowerCase().includes('unikernels'))).toBe(true);

    // Cross-site browser request MUST NOT leak private deep-index titles
    const crossRes = await fetch(`http://127.0.0.1:${server.port}/api/opensearch/suggest?q=unikernels`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    const [, crossCompletions] = (await crossRes.json()) as [string, string[]];
    expect(crossCompletions.some((c) => c.includes('Post #'))).toBe(false);
  });
});

describe('0.6.0 concurrent dev servers (#21), extension ZIP (#24) & bundle budget checker', () => {
  it('starts two concurrent non-production glogg servers on random ports without HMR port 24678 collision', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const s1 = http.createServer();
    const s2 = http.createServer();
    try {
      const [app1, app2] = await Promise.all([createGloggServer(s1), createGloggServer(s2)]);
      s1.on('request', app1);
      s2.on('request', app2);
      await Promise.all([
        new Promise<void>((r) => s1.listen(0, '127.0.0.1', r)),
        new Promise<void>((r) => s2.listen(0, '127.0.0.1', r)),
      ]);
      const p1 = (s1.address() as AddressInfo).port;
      const p2 = (s2.address() as AddressInfo).port;
      expect(p1).not.toBe(p2);
      const [h1, h2] = await Promise.all([
        fetch(`http://127.0.0.1:${p1}/api/health`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${p2}/api/health`).then((r) => r.json()),
      ]);
      expect(h1.status).toBe('ok');
      expect(h2.status).toBe('ok');
    } finally {
      process.env.NODE_ENV = prevEnv;
      await Promise.all([
        new Promise<void>((r) => s1.close(() => r())),
        new Promise<void>((r) => s2.close(() => r())),
      ]);
    }
  });

  it('builds a valid PKZIP extension archive with synced package version and Firefox gecko metadata', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-ext-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'glogg-extension-v0.0.1.zip'), 'stale');
      const { version, zipPath } = await buildExtension(tmpDir);
      expect(version).toBe('0.6.0');
      expect(fs.existsSync(path.join(tmpDir, 'glogg-extension-v0.0.1.zip'))).toBe(false);
      expect(fs.existsSync(zipPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
      expect(manifest.version).toBe('0.6.0');
      expect(manifest.browser_specific_settings?.gecko?.id).toBe('extension@glogg.app');

      const zipBuf = fs.readFileSync(zipPath);
      expect(zipBuf.readUInt32LE(0)).toBe(0x04034b50);
      expect(zipBuf.readUInt32LE(zipBuf.length - 22)).toBe(0x06054b50);

      // Verify round-trip DEFLATE decompression on a single-entry archive
      const sample = Buffer.from('hello glogg extension zip', 'utf8');
      const single = createZipArchive([{ name: 'hello.txt', data: sample }]);
      const nameLen = single.readUInt16LE(26);
      const compLen = single.readUInt32LE(18);
      const inflated = zlib.inflateRawSync(single.subarray(30 + nameLen, 30 + nameLen + compLen));
      expect(inflated.equals(sample)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('evaluates gzipped asset budgets accurately in checkBundle', () => {
    const missing = checkBundle('/nonexistent/glogg-bundle-dir');
    expect(missing.ok).toBe(false);

    const tmpAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-bundle-test-'));
    try {
      fs.writeFileSync(path.join(tmpAssets, 'app.js'), 'console.log("hello");\n');
      fs.writeFileSync(path.join(tmpAssets, 'app.css'), 'body { margin: 0; }\n');
      fs.writeFileSync(path.join(tmpAssets, 'note.txt'), 'ignored');

      expect(checkBundle(tmpAssets, { '.js': 10, '.css': 10 }).ok).toBe(true);
      expect(checkBundle(tmpAssets, { '.js': 0.001, '.css': 10 }).ok).toBe(false);
    } finally {
      fs.rmSync(tmpAssets, { recursive: true, force: true });
    }
  });
});
