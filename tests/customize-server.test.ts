/** Customization on the server side: sources you turn off, domain rules, hidden phrases and saved settings. */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { diversifyAndRankResults, RawSearchResult } from '../src/core/index.js';
import { rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';

const home = useTempGloggHome();
process.env.GLOGG_CONTAINER_RUNTIME = 'none';
const fsearch = await import('../server/federatedSearch.js');

const item = (domain: string, i: number, extra: Partial<RawSearchResult> = {}): RawSearchResult => ({
  title: `Rust borrow checker guide ${['basics', 'lifetimes', 'closures', 'async'][i % 4]} on ${domain}`,
  url: `https://${domain}/rust-borrow-checker-${i}`,
  snippet: 'How the Rust borrow checker reasons about references and lifetimes.',
  source: 'web',
  ...extra,
});
const QUERY = 'rust borrow checker';

describe('domain rules', () => {
  const items = [item('alpha.example', 0), item('beta.example', 1), item('gamma.example', 2), item('delta.example', 3)];
  const order = (cfg: object) => diversifyAndRankResults(items, cfg, QUERY).surfaced.map((r) => r.rootDomain);

  it('a pinned domain goes first, whatever it scored', () => {
    const base = order({});
    const last = base[base.length - 1];
    expect(order({ pinnedDomains: [last] })[0]).toBe(last);
  });

  it('a lowered domain ranks below where it was, and stays on the page', () => {
    const base = order({});
    const first = base[0];
    const lowered = order({ loweredDomains: [first] });
    expect(lowered).toContain(first);
    expect(lowered.indexOf(first)).toBeGreaterThan(0);
  });

  it('one rule per domain: pinned beats raised beats lowered', () => {
    const r = diversifyAndRankResults([item('alpha.example', 0)], { pinnedDomains: ['alpha.example'], boostedDomains: ['alpha.example'], loweredDomains: ['alpha.example'] }, QUERY).surfaced[0];
    expect(r.signals.map((s) => s.id).filter((id) => id.startsWith('user-'))).toEqual(['user-pinned-domain']);
  });
});

describe('hidden phrases', () => {
  it('hide a result outright, even with the junk filter relaxed', () => {
    const out = diversifyAndRankResults([item('alpha.example', 0, { snippet: 'Rust borrow checker, sponsored content by Acme.' }), item('beta.example', 1)], { blockedPhrases: ['sponsored content'], slopThreshold: 62 }, QUERY);
    expect(out.surfaced.map((r) => r.rootDomain)).toEqual(['beta.example']);
    expect(out.filteredSlop[0].demotedReason).toBe('Mentions “sponsored content”');
  });
});

describe('sources you turn off', () => {
  const hosts: string[] = [];
  beforeEach(() => {
    hosts.length = 0;
    fsearch.clearSearchCache();
    fsearch.resetSourceHealth();
    vi.stubGlobal('fetch', async (input: string | URL) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response('', { status: 404 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('are not asked, and the timings say so', async () => {
    const res = await fsearch.executeFederatedSearch(QUERY, { lens: 'all', disabledSources: ['hn', 'github', 'ddg'] });
    expect(hosts).not.toContain('hn.algolia.com');
    expect(hosts).not.toContain('api.github.com');
    expect(hosts).not.toContain('html.duckduckgo.com');
    expect(hosts).toContain('api.stackexchange.com');
    for (const k of ['hn', 'github', 'ddg']) expect(res.metrics.sourceTimings?.[k]).toEqual({ ms: 0, count: 0, status: 'off' });
  });
});

describe('settings saved on this glogg', () => {
  let port = 0;
  let close: () => Promise<void>;
  const json = { 'Content-Type': 'application/json' };
  beforeAll(async () => {
    ({ port, close } = await startGloggServer());
  });
  afterAll(() => close());

  it('round-trip: nothing yet, then saved, then loaded; kept private', async () => {
    expect((await rawRequest(port, { path: '/api/profile' })).status).toBe(404);
    const settings = { glogg: 'settings', version: 1, savedAt: 'x', settings: { 'glogg.pinned': ['alpha.example'] } };
    const put = await rawRequest(port, { method: 'PUT', path: '/api/profile', headers: json, body: JSON.stringify({ settings }) });
    expect(put.status).toBe(200);
    const got = JSON.parse((await rawRequest(port, { path: '/api/profile' })).body);
    expect(got.settings).toEqual(settings);
    expect(Date.parse(got.savedAt)).toBeGreaterThan(0);
    expect(fs.statSync(path.join(home, 'profile.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses things that aren\'t settings, or too much of them', async () => {
    const send = (body: unknown) => rawRequest(port, { method: 'PUT', path: '/api/profile', headers: json, body: JSON.stringify(body) });
    expect((await send({ settings: [1, 2] })).status).toBe(400);
    expect((await send({ settings: 'x' })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    const big = await send({ settings: { blob: 'x'.repeat(300_000) } });
    expect(big.status).toBe(400);
    expect(JSON.parse(big.body).error).toMatch(/too big/);
  });

  it('can\'t be read or written from another site', async () => {
    const evil = { Origin: 'https://evil.example' };
    expect((await rawRequest(port, { path: '/api/profile', headers: evil })).status).toBe(403);
    expect((await rawRequest(port, { method: 'PUT', path: '/api/profile', headers: { ...json, ...evil }, body: '{"settings":{}}' })).status).toBe(403);
  });
});
