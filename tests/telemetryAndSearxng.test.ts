import fs from 'node:fs';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeQueryRelevance } from '../src/core/queryIntelligence.js';
import { clearSearchCache, executeFederatedSearch, resetSourceHealth } from '../server/federatedSearch.js';
import { getTelemetrySnapshot, resetTelemetry } from '../server/telemetry.js';
import { rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';

useTempGloggHome();
process.env.GLOGG_CONTAINER_RUNTIME = 'none';

let closeServer: (() => Promise<void>) | undefined;
let closeFixture: (() => Promise<void>) | undefined;

beforeEach(() => {
  clearSearchCache();
  resetSourceHealth();
  resetTelemetry();
});

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  await closeFixture?.();
  closeFixture = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UK/US lexical spelling equivalence', () => {
  it.each([
    ['bicycle tyre puncture', 'How to patch a bicycle tire puncture on the road'],
    ['aluminium anodising guide', 'Anodizing aluminum parts at home: complete guide'],
    ['watercolour pigment catalogue', 'Watercolor pigment catalog for illustrators'],
    ['optical fibre splicing centre', 'Optical fiber splicing center operations manual'],
    ['network behaviour defence', 'Network behavior defense handbook'],
    ['greyscale organisation chart', 'Grayscale chart for engineering organization'],
  ])('matches %s against %s without degrading coverage', (query, title) => {
    const evalResult = computeQueryRelevance(query, title, title, 'https://handbook.example/guide');
    expect(evalResult.coverageRatio).toBeGreaterThanOrEqual(0.99);
    expect(evalResult.relevanceScore).toBeGreaterThanOrEqual(55);
  });

  it('never conflates tyre with tired, tiring or retire', () => {
    const alone = computeQueryRelevance(
      'tyre',
      'Tired of commuting before you retire',
      'Tiring schedules and workplace stress.',
      'https://notes.example/work'
    );
    expect(alone.matchedCoreCount).toBe(0);
    expect(alone.relevanceScore).toBe(0);

    const paired = computeQueryRelevance(
      'tyre pressure',
      'Tired of pressure at work before you retire',
      'Tiring schedules and workplace stress.',
      'https://notes.example/work'
    );
    expect(paired.matchedCoreCount).toBe(1);
    expect(paired.relevanceScore).toBeLessThan(34);
  });
});

describe('SearXNG datacenter configuration and upstream refusal reporting', () => {
  it('enables resilient web engines and disables CAPTCHA-prone scrapers in infra/searxng/settings.yml', () => {
    const yml = fs.readFileSync(new URL('../infra/searxng/settings.yml', import.meta.url), 'utf8');
    for (const enabled of ['bing', 'yahoo', 'duckduckgo web']) {
      expect(yml).toMatch(new RegExp(`- name:\\s*${enabled}\\s*\\n\\s*disabled:\\s*false`));
    }
    for (const disabled of ['duckduckgo', 'brave', 'google', 'brave.news', 'google news', 'reuters']) {
      const escaped = disabled.replace('.', '\\.');
      expect(yml).toMatch(new RegExp(`- name:\\s*${escaped}\\s*\\n\\s*disabled:\\s*true`));
    }
    const dockerfile = fs.readFileSync(new URL('../infra/searxng/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('RUN mkdir -p -m 0755 /etc/searxng-glogg');
    expect(dockerfile).toContain('COPY --chmod=0644 settings.yml /etc/searxng-glogg/settings.yml');
    expect(dockerfile).toContain('ENV SEARXNG_SETTINGS_PATH=/etc/searxng-glogg/settings.yml');
  });

  it('reports SearXNG as refused rather than empty when all engines were blocked upstream', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        results: [],
        unresponsive_engines: [
          ['brave', 'Suspended: too many requests'],
          ['duckduckgo', 'CAPTCHA'],
        ],
      }));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;
    closeFixture = () => new Promise<void>((resolve) => srv.close(() => resolve()));

    const allExceptSearx = [
      'marginalia', 'wiby', 'lemmy', 'fediverse', 'gdelt', 'archive', 'openalex',
      'hn', 'wiki', 'se', 'arxiv', 'github', 'ddg', 'brave', 'p2p', 'mwmbl', 'deep',
    ];
    const response = await executeFederatedSearch('cat care', {
      disabledSources: allExceptSearx,
      endpoints: { searxngUrl: `http://127.0.0.1:${port}` },
    });
    expect(response.metrics.sourceTimings?.searxng).toMatchObject({
      status: 'refused',
      count: 0,
    });
    expect(response.metrics.sourceTimings?.searxng.note).toMatch(/brave.*too many requests/i);
    expect(response.metrics.sourceTimings?.searxng.note).toMatch(/duckduckgo.*CAPTCHA/i);
  });

  it('still returns SearXNG hits normally when at least one engine succeeded alongside an unresponsive engine', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        results: [{ title: 'Cat Care Guide', url: 'https://vet.example/cat-care', content: 'Complete cat care handbook.' }],
        unresponsive_engines: [['brave', 'Suspended: too many requests']],
      }));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;
    closeFixture = () => new Promise<void>((resolve) => srv.close(() => resolve()));

    const allExceptSearx = [
      'marginalia', 'wiby', 'lemmy', 'fediverse', 'gdelt', 'archive', 'openalex',
      'hn', 'wiki', 'se', 'arxiv', 'github', 'ddg', 'brave', 'p2p', 'mwmbl', 'deep',
    ];
    const response = await executeFederatedSearch('cat care', {
      disabledSources: allExceptSearx,
      endpoints: { searxngUrl: `http://127.0.0.1:${port}` },
    });
    expect(response.metrics.sourceTimings?.searxng?.status).toBe('ok');
    expect(response.results.map((r) => r.url)).toContain('https://vet.example/cat-care');
  });
});

describe('privacy-preserving operational telemetry', () => {
  it('records latency quantiles, cache hits, overload rejections and source statuses without ever storing query text or URLs', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        results: [{
          title: 'CanaryGuide secretphrase9911',
          url: 'https://canary-domain-8822.example/private-path-7733',
          content: 'Guide covering secretphrase9911 in detail.',
        }],
      }));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const searxPort = (srv.address() as { port: number }).port;
    closeFixture = () => new Promise<void>((resolve) => srv.close(() => resolve()));

    vi.stubEnv('SEARXNG_URL', `http://127.0.0.1:${searxPort}`);
    const server = await startGloggServer();
    closeServer = server.close;

    const allExceptSearx = [
      'marginalia', 'wiby', 'lemmy', 'fediverse', 'gdelt', 'archive', 'openalex',
      'hn', 'wiki', 'se', 'arxiv', 'github', 'ddg', 'brave', 'p2p', 'mwmbl', 'deep',
    ];
    const body = JSON.stringify({
      query: 'secretphrase9911 canarytoken4455',
      config: {
        disabledSources: allExceptSearx,
        blockedDomains: ['blocked-canary-6611.example'],
        blockedPhrases: ['hidden-phrase-5522'],
      },
    });

    const first = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/search',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body,
    });
    expect(first.status).toBe(200);

    const second = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/search',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(second.status).toBe(200);

    const telemetryRes = await rawRequest(server.port, { path: '/api/telemetry' });
    expect(telemetryRes.status).toBe(200);
    const snap = JSON.parse(telemetryRes.body) as ReturnType<typeof getTelemetrySnapshot>;
    expect(snap.searches.admitted).toBe(2);
    expect(snap.searches.completed).toBe(2);
    expect(snap.latencyMs.final.count).toBe(2);
    expect(snap.cache.misses).toBeGreaterThanOrEqual(1);
    expect(snap.cache.hits).toBeGreaterThanOrEqual(1);
    expect(snap.sources.searxng?.ok).toBe(2);

    const serialized = JSON.stringify(snap);
    for (const secret of [
      'secretphrase9911',
      'canarytoken4455',
      'canary-domain-8822',
      'private-path-7733',
      'blocked-canary-6611',
      'hidden-phrase-5522',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('denies /api/telemetry in public mode unless an operator bearer token is configured and supplied', async () => {
    vi.stubEnv('GLOGG_MODE', 'public');
    vi.stubEnv('GLOGG_ALLOW_PRIVATE_FETCH', '');
    const server = await startGloggServer();
    closeServer = server.close;

    expect((await rawRequest(server.port, { path: '/api/telemetry' })).status).toBe(403);

    vi.stubEnv('GLOGG_TELEMETRY_TOKEN', 'short');
    expect((await rawRequest(server.port, {
      path: '/api/telemetry',
      headers: { Authorization: 'Bearer short' },
    })).status).toBe(403);

    const token = 'operator-telemetry-token-0123456789';
    vi.stubEnv('GLOGG_TELEMETRY_TOKEN', token);
    expect((await rawRequest(server.port, {
      path: '/api/telemetry',
      headers: { Authorization: 'Bearer wrong-operator-telemetry-token' },
    })).status).toBe(403);

    const ok = await rawRequest(server.port, {
      path: '/api/telemetry',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ searches: { admitted: 0 } });
  });

  it('tracks coalesced in-flight cache joins and overload 503 counters while keeping /api/telemetry responsive', async () => {
    let releaseUpstream: (() => void) | undefined;
    const srv = http.createServer((_req, res) => {
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          results: [{ title: ' Resilience Guide ', url: 'https://guide.example/resilience', content: 'Resilience manual.' }],
        }));
      };
      if (!releaseUpstream) releaseUpstream = send;
      else send();
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const searxPort = (srv.address() as { port: number }).port;
    closeFixture = () => new Promise<void>((resolve) => srv.close(() => resolve()));

    vi.stubEnv('GLOGG_MAX_API_REQUESTS', '2');
    const server = await startGloggServer();
    closeServer = server.close;

    const allExceptSearx = [
      'marginalia', 'wiby', 'lemmy', 'fediverse', 'gdelt', 'archive', 'openalex',
      'hn', 'wiki', 'se', 'arxiv', 'github', 'ddg', 'brave', 'p2p', 'mwmbl', 'deep',
    ];
    const body = JSON.stringify({
      query: 'resilience manual',
      config: { disabledSources: allExceptSearx, endpoints: { searxngUrl: `http://127.0.0.1:${searxPort}` } },
    });

    const p1 = rawRequest(server.port, { method: 'POST', path: '/api/search', headers: { 'Content-Type': 'application/json' }, body });
    const p2 = rawRequest(server.port, { method: 'POST', path: '/api/search', headers: { 'Content-Type': 'application/json' }, body });
    for (let i = 0; i < 20 && !releaseUpstream; i++) await new Promise((r) => setTimeout(r, 10));

    // Third concurrent API call hits GLOGG_MAX_API_REQUESTS=2 -> 503, while /api/telemetry remains exempt and 200!
    const busyRes = await rawRequest(server.port, { method: 'POST', path: '/api/search', headers: { 'Content-Type': 'application/json' }, body });
    expect(busyRes.status).toBe(503);
    const liveTelemetry = await rawRequest(server.port, { path: '/api/telemetry' });
    expect(liveTelemetry.status).toBe(200);

    releaseUpstream?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const snap = getTelemetrySnapshot();
    expect(snap.http.rejectedBusy).toBeGreaterThanOrEqual(1);
    expect(snap.cache.coalesced).toBeGreaterThanOrEqual(1);
  });
});
