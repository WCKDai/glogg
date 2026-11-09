/**
 * Speed budgets. Each test measures a hot path and fails when it gets much
 * slower than it should be. Budgets sit roughly 5–10× above local timings,
 * so they catch real regressions, not a busy CI runner. Run `npm run test:perf`
 * to see the measured numbers.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  analyzeQueryIntent,
  cleanAndAutopsyHtml,
  diversifyAndRankResults,
  extractiveAnswer,
  queryTerms,
  scoreSearchResult,
  selectPassages,
} from '../src/core/index.js';
import type { RawSearchResult, ResearchEvent } from '../src/core/index.js';
import { Markdown } from '../src/client/components/Markdown.js';
import { startGloggServer, stats, useTempGloggHome } from './helpers.js';

useTempGloggHome();
process.env.GLOGG_MIN_WAIT_MS = '0';

const report: [string, string][] = [];
afterAll(() => {
  if (process.env.GLOGG_PERF_REPORT) console.table(Object.fromEntries(report));
});

/** Runs fn `runs` times after a warm-up and returns the median in ms. */
async function measure(label: string, fn: () => unknown, runs = 5): Promise<number> {
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  const { median } = stats(samples);
  report.push([label, `${median.toFixed(2)} ms`]);
  return median;
}

const WORDS = 'rust borrow checker lifetime ownership compiler error reference mutable slice vector thread async tokio cargo crate'.split(' ');
const pick = (i: number, n: number) => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(' ');

function syntheticResults(n: number): RawSearchResult[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `${pick(i, 6)} ${i % 9 === 0 ? '15 Best Tools (2026 Ultimate Guide)' : ''}`,
    url: `https://${i % 40 === 0 ? 'www.' : ''}site${i % 120}.${['com', 'org', 'dev', 'io', 'net'][i % 5]}/post/${i}?utm_source=x&ref=${i}`,
    snippet: `${pick(i + 1, 24)}. ${i % 11 === 0 ? 'In today’s fast-paced world, sponsored partner offer.' : 'Practical notes from the field.'}`,
    source: (['web', 'marginalia', 'hn', 'stackexchange', 'lemmy', 'wiby'] as const)[i % 6],
    publishedAt: i % 3 === 0 ? '2019-05-01' : '2025-02-01',
  }));
}

function bigPage(paragraphs: number): string {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    i % 25 === 0
      ? `<h2>Section ${i}</h2><pre>cargo build --release # step ${i}</pre>`
      : `<p>${pick(i, 40)} — paragraph ${i} with <a href="https://ref${i % 30}.example/doc">a reference</a> and <em>emphasis</em>.</p>`
  ).join('\n');
  const junk = '<script src="https://www.googletagmanager.com/gtm.js"></script><div class="cookie-banner">Accept cookies</div>'.repeat(20);
  return `<!doctype html><html><head><title>Big page</title>${junk}</head><body><nav>Home Docs Blog</nav><main>${body}</main></body></html>`;
}

describe('core hot paths', () => {
  it('ranks 600 raw results in well under a frame budget per hundred', async () => {
    const raw = syntheticResults(600);
    const ms = await measure('rank 600 results', () => diversifyAndRankResults(raw, { lens: 'all', maxPerDomain: 2 }, 'rust borrow checker lifetime'));
    expect(ms).toBeLessThan(150);
  });

  it('scores 2,000 results', async () => {
    const raw = syntheticResults(2000);
    const ms = await measure('score 2,000 results', () => raw.forEach((r) => scoreSearchResult(r, undefined, 'rust borrow checker')));
    expect(ms).toBeLessThan(300);
  });

  it('analyses 5,000 queries', async () => {
    const qs = Array.from({ length: 5000 }, (_, i) => `how do I fix ${pick(i, 5)} error in version ${i % 30}?`);
    const ms = await measure('analyse 5,000 queries', () => qs.forEach((q) => analyzeQueryIntent(q)));
    expect(ms).toBeLessThan(150);
  });

  it('cleans a 1 MB page for the reader', async () => {
    const html = bigPage(2400);
    expect(html.length).toBeGreaterThan(900_000);
    const ms = await measure('clean 1 MB page', () => cleanAndAutopsyHtml(html, 'https://big.example/post'), 3);
    expect(ms).toBeLessThan(800);
  });

  it('picks passages and quotes from a long page', async () => {
    const report = cleanAndAutopsyHtml(bigPage(2400), 'https://big.example/post');
    const terms = queryTerms('rust borrow checker lifetime error');
    const ms = await measure('select passages + quote', () => {
      const passages = selectPassages(report.sections, terms, 5, 3200);
      extractiveAnswer('rust borrow checker lifetime error', [{ index: 1, title: 'Big', url: 'https://big.example', domain: 'big.example', read: true, passages }]);
    });
    expect(ms).toBeLessThan(250);
  });

  it('renders a long streamed answer quickly enough to re-render on every token', async () => {
    const answer = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? `## Part ${i}\n` : `- point ${i} with \`code\` and a cite [${(i % 5) + 1}]`)).join('\n');
    const sources = [1, 2, 3, 4, 5].map((i) => ({ index: i, title: `S${i}`, url: `https://s${i}.example` }));
    const ms = await measure('render 120-line answer', () => renderToStaticMarkup(<Markdown text={answer} sources={sources} />));
    expect(ms).toBeLessThan(30);
  });
});

describe('plugins', () => {
  it('loads every built-in plugin quickly', async () => {
    const rt = await import('../server/plugins/runtime.js');
    const t = performance.now();
    await rt.loadPlugins({ force: true });
    const ms = performance.now() - t;
    report.push(['load all plugins (cold)', `${ms.toFixed(1)} ms`]);
    expect(rt.listPlugins().filter((p) => !p.error).length).toBeGreaterThanOrEqual(11);
    expect(ms).toBeLessThan(1500);
  });
});

describe('API latency (local server)', () => {
  let baseUrl = '';
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ baseUrl, close } = await startGloggServer());
  });
  afterAll(() => close());

  async function p95(label: string, n: number, call: () => Promise<Response>) {
    await call();
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      const res = await call();
      await res.arrayBuffer();
      expect(res.ok).toBe(true);
      samples.push(performance.now() - t);
    }
    const s = stats(samples);
    report.push([label, `p50 ${s.median.toFixed(1)} · p95 ${s.p95.toFixed(1)} ms`]);
    return s.p95;
  }

  it('answers health checks fast', async () => {
    expect(await p95('GET /api/health', 100, () => fetch(`${baseUrl}/api/health`))).toBeLessThan(25);
  });

  it('lists plugins fast', async () => {
    expect(await p95('GET /api/plugins', 100, () => fetch(`${baseUrl}/api/plugins`))).toBeLessThan(40);
  });

  it('runs a local tool with little overhead', async () => {
    const run = () =>
      fetch(`${baseUrl}/api/plugins/utils/tools/hash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { text: 'abc' } }) });
    expect(await p95('POST tool (hash)', 100, run)).toBeLessThan(40);
  });
});

describe('search and research end to end (stubbed upstreams)', () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    // Upstreams answer instantly with nothing; this measures glogg's own overhead.
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
  });
  afterAll(() => vi.stubGlobal('fetch', realFetch));

  it('adds little overhead on top of the upstreams, and repeats come from cache', async () => {
    const search = await import('../server/federatedSearch.js');
    search.clearSearchCache();
    const t = performance.now();
    await search.executeFederatedSearch('rust borrow checker lifetimes', { lens: 'all' });
    const first = performance.now() - t;
    const t2 = performance.now();
    await search.executeFederatedSearch('rust borrow checker lifetimes', { lens: 'all' });
    const repeat = performance.now() - t2;
    report.push(['search overhead (first)', `${first.toFixed(1)} ms`], ['search (cached repeat)', `${repeat.toFixed(1)} ms`]);
    expect(first).toBeLessThan(150);
    expect(repeat).toBeLessThan(30);
  });

  it('researches eight 200 KB pages in well under a second', async () => {
    const { runResearch } = await import('../server/research.js');
    const html = bigPage(450);
    const candidates = Array.from({ length: 8 }, (_, i) => ({ title: `Page ${i}`, url: `https://p${i}.example/a`, snippet: 's' }));
    const t = performance.now();
    const events: ResearchEvent[] = [];
    for await (const e of runResearch({ query: 'rust borrow checker lifetime', candidates, depth: 'deep' }, { ai: null, fetchPage: async () => html })) events.push(e);
    const ms = performance.now() - t;
    report.push(['research 8 pages (deep, extractive)', `${ms.toFixed(1)} ms`]);
    expect(events.at(-1)?.type).toBe('done');
    expect(ms).toBeLessThan(1200);
  });
});
