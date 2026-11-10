/**
 * The search pipeline with every upstream stubbed: deadlines, source health,
 * caching and the instant-answer budget. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawSearchResult } from '../src/core/index.js';
import { useTempGloggHome } from './helpers.js';

// Never read the real ~/.glogg (the deep index lives there).
useTempGloggHome();

// Short deadlines so the timing rules are observable in milliseconds.
process.env.GLOGG_SOURCE_DEADLINE_MS = '400';
process.env.GLOGG_HARD_DEADLINE_MS = '900';
process.env.GLOGG_CORE_GRACE_MS = '100';
process.env.GLOGG_MIN_WAIT_MS = '150';
process.env.GLOGG_ANSWER_BUDGET_MS = '500';

const fs = await import('../server/federatedSearch.js');
const answers = await import('../server/answerEngine.js');

const results = (n: number): RawSearchResult[] =>
  Array.from({ length: n }, (_, i) => ({ title: `r${i}`, url: `https://s${i}.example/x`, snippet: 'x', source: 'web' }));
const after = <T>(ms: number, value: T, fail = false) =>
  () => new Promise<T>((resolve, reject) => setTimeout(() => (fail ? reject(new Error('boom')) : resolve(value)), ms));

describe('gathering sources', () => {
  it('returns shortly after core sources answer, without waiting for the soft deadline', async () => {
    const t = Date.now();
    const out = await fs.gatherSources(
      [
        { key: 'core', core: true, run: after(20, results(8)) },
        { key: 'quick', core: false, run: after(60, results(2)) },
        { key: 'stuck', core: false, run: () => new Promise(() => undefined) },
      ],
      { softMs: 2000, hardMs: 5000, graceMs: 100, minWaitMs: 50 }
    );
    const ms = Date.now() - t;
    expect(ms).toBeGreaterThanOrEqual(110);
    expect(ms).toBeLessThan(400);
    expect(out.core).toHaveLength(8);
    expect(out.quick).toHaveLength(2);
    expect(out.stuck).toEqual([]);
  });

  it('never finishes before the minimum wait, so quick small-web sources make it', async () => {
    const t = Date.now();
    const out = await fs.gatherSources(
      [
        { key: 'core', core: true, run: after(1, results(8)) },
        { key: 'small', core: false, run: after(120, results(3)) },
        { key: 'stuck', core: false, run: () => new Promise(() => undefined) },
      ],
      { softMs: 2000, hardMs: 5000, graceMs: 10, minWaitMs: 200 }
    );
    expect(Date.now() - t).toBeGreaterThanOrEqual(195);
    expect(out.small).toHaveLength(3);
  });

  it('finishes at once when every source has settled', async () => {
    const t = Date.now();
    await fs.gatherSources([{ key: 'a', core: true, run: after(5, results(1)) }], { softMs: 2000, hardMs: 5000, minWaitMs: 1000 });
    expect(Date.now() - t).toBeLessThan(150);
  });

  it('stops at the soft deadline when core sources are done but thin', async () => {
    const t = Date.now();
    await fs.gatherSources(
      [
        { key: 'core', core: true, run: after(10, results(2)) },
        { key: 'stuck', core: false, run: () => new Promise(() => undefined) },
      ],
      { softMs: 150, hardMs: 5000, graceMs: 10, minWaitMs: 10 }
    );
    const ms = Date.now() - t;
    expect(ms).toBeGreaterThanOrEqual(145);
    expect(ms).toBeLessThan(400);
  });

  it('gives up at the hard deadline when a core source hangs', async () => {
    const t = Date.now();
    await fs.gatherSources(
      [
        { key: 'hung', core: true, run: () => new Promise(() => undefined) },
        { key: 'core', core: true, run: after(5, results(1)) },
      ],
      { softMs: 50, hardMs: 250 }
    );
    const ms = Date.now() - t;
    expect(ms).toBeGreaterThanOrEqual(245);
    expect(ms).toBeLessThan(500);
  });

  it.each([
    // [label, results from the answering core source, sources that never answer, options, when it must end]
    ['the hard deadline, with a core source that never answers', 1, [{ key: 'hung', core: true }], { softMs: 50, hardMs: 250 }, 250],
    ['the soft deadline, once core sources have enough', 8, [{ key: 'slow', core: false }], { softMs: 60, hardMs: 1500, minCore: 6 }, 60],
  ] as const)('ends at %s when its timer fires, even if the clock reads a hair earlier', async (_label, coreResults, extra, opts, endsAt) => {
    // Node can run a timer a millisecond before Date.now() shows its full delay. Faking the timers but
    // not the clock makes that gap total (the clock barely moves), so only the timers can end the wait.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let done = false;
      const run = fs
        .gatherSources(
          [
            { key: 'core', core: true, run: after(5, results(coreResults)) },
            ...extra.map((t) => ({ ...t, run: () => new Promise<RawSearchResult[]>(() => undefined) })),
          ],
          opts
        )
        .then(() => (done = true));
      await vi.advanceTimersByTimeAsync(endsAt - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it('records how each source did, and reports late ones when they finally settle', async () => {
    const timings: Record<string, import('../server/federatedSearch.js').SourceTiming> = {};
    const settled: string[] = [];
    await fs.gatherSources(
      [
        { key: 'ok', core: true, run: after(5, results(7)) },
        { key: 'empty', core: false, run: after(5, []) },
        { key: 'error', core: false, run: after(5, [], true) },
        { key: 'throws', core: false, run: () => { throw new Error('sync'); } },
        { key: 'late', core: false, run: after(300, results(1)) },
      ],
      { softMs: 50, hardMs: 1000, graceMs: 10, minWaitMs: 10, timings, onSettle: (k) => settled.push(k) }
    );
    expect(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, v.status]))).toEqual({
      ok: 'ok',
      empty: 'empty',
      error: 'error',
      throws: 'error',
      late: 'late',
    });
    expect(settled).not.toContain('late');
    await new Promise((r) => setTimeout(r, 350));
    expect(settled).toContain('late');
  });
});

describe('source health', () => {
  beforeEach(() => fs.resetSourceHealth());

  it('rests a source after it hangs twice', () => {
    fs.recordSourceOutcome('gdelt', 3800, 0, false);
    expect(fs.isSourceResting('gdelt')).toBe(false);
    fs.recordSourceOutcome('gdelt', 3800, 0, false);
    expect(fs.isSourceResting('gdelt')).toBe(true);
  });

  it('does not count fast empty answers (no match, rate limits)', () => {
    for (let i = 0; i < 5; i++) fs.recordSourceOutcome('openalex', 120, 0, false);
    expect(fs.isSourceResting('openalex')).toBe(false);
  });

  it('counts errors, and a good answer clears the record', () => {
    fs.recordSourceOutcome('wiby', 50, 0, true);
    fs.recordSourceOutcome('wiby', 400, 3, false);
    fs.recordSourceOutcome('wiby', 50, 0, true);
    expect(fs.isSourceResting('wiby')).toBe(false);
  });

  it('lets a rested source try again once the rest is over', () => {
    fs.recordSourceOutcome('x', 0, 0, true);
    fs.recordSourceOutcome('x', 0, 0, true);
    expect(fs.isSourceResting('x', Date.now() + 10 * 60_000)).toBe(false);
  });
});

describe('source cache', () => {
  beforeEach(() => fs.clearSearchCache());

  it('serves a repeat call from memory', async () => {
    const run = vi.fn(async () => results(3));
    expect(await fs.cachedSource('k', run)).toHaveLength(3);
    expect(await fs.cachedSource('k', run)).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('joins a request that is still in flight instead of starting another', async () => {
    const run = vi.fn(after(30, results(2)));
    const [a, b] = await Promise.all([fs.cachedSource('k', run), fs.cachedSource('k', run)]);
    expect(a).toBe(b);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures', async () => {
    const fail = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(fs.cachedSource('k', fail)).rejects.toThrow('down');
    const ok = vi.fn(async () => results(1));
    expect(await fs.cachedSource('k', ok)).toHaveLength(1);
  });

  it('expires empty answers sooner than full ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const empty = vi.fn(async () => [] as RawSearchResult[]);
      const full = vi.fn(async () => results(1));
      await fs.cachedSource('e', empty);
      await fs.cachedSource('f', full);
      vi.setSystemTime(Date.now() + 2 * 60_000);
      await fs.cachedSource('e', empty);
      await fs.cachedSource('f', full);
      expect(empty).toHaveBeenCalledTimes(2);
      expect(full).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('federated search with stubbed upstreams', () => {
  type Rule = { delayMs?: number; hang?: boolean };
  let rules: Record<string, Rule> = {};
  const calls: { host: string; url: string; at: number }[] = [];
  let started = 0;

  beforeEach(() => {
    rules = {};
    calls.length = 0;
    fs.clearSearchCache();
    fs.resetSourceHealth();
    answers.clearInstantAnswerCache();
    vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}) => {
      const host = new URL(String(input)).hostname;
      calls.push({ host, url: String(input), at: Date.now() - started });
      const rule = Object.entries(rules).find(([h]) => host.endsWith(h))?.[1] ?? {};
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) return abort();
        init.signal?.addEventListener('abort', abort);
        if (!rule.hang) setTimeout(() => resolve(new Response('', { status: 404 })), rule.delayMs ?? 0);
      });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const search = (q: string) => {
    started = Date.now();
    return fs.executeFederatedSearch(q, { lens: 'all' });
  };

  it('returns a complete response when every upstream is empty', async () => {
    const res = await search('offline smoke test query');
    expect(res.results).toBeInstanceOf(Array);
    expect(Object.keys(res.metrics.sourceTimings || {})).toEqual(expect.arrayContaining(['wiki', 'se', 'ddg', 'marginalia', 'p2p']));
    expect(res.metrics.durationMs).toBeLessThan(400);
  });

  it('starts the instant-answer lookups together with the sources', async () => {
    rules['html.duckduckgo.com'] = { delayMs: 200 };
    await search('what is the borrow checker');
    const answerCall = calls.find((c) => c.host === 'api.duckduckgo.com' || c.host === 'en.wikipedia.org');
    expect(answerCall).toBeDefined();
    expect(answerCall!.at).toBeLessThan(50);
  });

  it('caps the wait for a slow instant answer at its budget', async () => {
    rules['api.duckduckgo.com'] = { hang: true };
    const t = Date.now();
    const res = await search('what is the borrow checker');
    const ms = Date.now() - t;
    expect(ms).toBeGreaterThanOrEqual(450);
    expect(ms).toBeLessThan(800);
    expect(res.instantAnswer).toBeUndefined();
  });

  it('serves a repeated search from cache without calling upstreams again', async () => {
    await search('cached repeat query');
    const before = calls.length;
    const t = Date.now();
    await search('cached repeat query');
    expect(Date.now() - t).toBeLessThan(80);
    expect(calls.length).toBe(before);
  });

  it('skips a resting source and says so', async () => {
    fs.recordSourceOutcome('marginalia', 3800, 0, false);
    fs.recordSourceOutcome('marginalia', 3800, 0, false);
    const res = await search('resting source query');
    expect(calls.some((c) => c.host === 'api2.marginalia-search.com')).toBe(false);
    expect(res.metrics.sourceTimings?.marginalia).toMatchObject({ status: 'resting' });
  });

  it('sends the Stack Exchange key when one is configured', async () => {
    started = Date.now();
    await fs.executeFederatedSearch('how to undo a git commit', { lens: 'all', endpoints: { stackexchangeKey: 'k3y' } });
    const se = calls.filter((c) => c.host === 'api.stackexchange.com');
    expect(se.length).toBeGreaterThan(0);
    expect(se.every((c) => c.url.includes('&key=k3y'))).toBe(true);
  });

  it('asks the Bluesky AppView and Matrix homeserver set in the settings', async () => {
    started = Date.now();
    await fs.executeFederatedSearch('rust borrow checker', { lens: 'all', endpoints: { atprotoAppViewUrl: 'https://appview.example', matrixHomeserverUrl: 'https://matrix.example' } });
    expect(calls.some((c) => c.url.startsWith('https://appview.example/xrpc/app.bsky.feed.searchPosts'))).toBe(true);
    expect(calls.some((c) => c.url.startsWith('https://matrix.example/_matrix/client/v3/publicRooms'))).toBe(true);
    expect(calls.filter((c) => c.host === 'public.api.bsky.app' || c.host === 'matrix.org')).toEqual([]);
  });

  it('keeps SafeSearch on for the old-forum search unless 18+ is on', async () => {
    const forumSearches = () => calls.filter((c) => c.host === 'html.duckduckgo.com' && c.url.includes('site%3Avogons.org'));
    started = Date.now();
    await fs.executeFederatedSearch('sound blaster drivers', { lens: 'forums' });
    expect(forumSearches()).toHaveLength(1);
    expect(forumSearches()[0].url).not.toContain('kp=');
    calls.length = 0;
    await fs.executeFederatedSearch('sound blaster drivers', { lens: 'forums', uncensoredMode: true });
    expect(forumSearches()).toHaveLength(1);
    expect(forumSearches()[0].url).toContain('&kp=-2');
  });

  it('searches Discourse forums live only in the Forums scope, and asks Mwmbl everywhere', async () => {
    started = Date.now();
    await fs.executeFederatedSearch('home assistant zigbee pairing', { lens: 'forums' });
    expect(calls.some((c) => c.url.includes('/search.json?q='))).toBe(true);
    expect(calls.some((c) => c.host === 'api.mwmbl.org')).toBe(true);
    calls.length = 0;
    fs.clearSearchCache();
    await fs.executeFederatedSearch('home assistant zigbee pairing', { lens: 'all' });
    expect(calls.some((c) => c.url.includes('/search.json?q='))).toBe(false);
  });

  it('is bounded by the hard deadline when a core source hangs', async () => {
    rules['api.stackexchange.com'] = { hang: true };
    const t = Date.now();
    await search('hanging core source query');
    expect(Date.now() - t).toBeLessThan(1100);
  });
});
