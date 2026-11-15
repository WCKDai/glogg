// @vitest-environment jsdom
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compileSearchQuery,
  diversifyAndRankResults,
  evaluateInstantComputation,
  extractDomainInfo,
  isSearchTimeRange,
  scoreSearchResult,
  type RawSearchResult,
  type ScoredSearchResult,
} from '../src/core/index.js';
import { exportOpml, parseOpml } from '../server/deep/parse.js';
import { ftsQuery, openDeepStore } from '../server/deep/store.js';
import { buildInstantAnswer, clearInstantAnswerCache, prefetchInstantAnswer } from '../server/answerEngine.js';
import { quickCalc } from '../src/client/components/CommandPalette.js';
import { AnswerCard, ResultItem, renderHighlightedSnippet } from '../src/client/components/Results.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('0.5.0 instant computation engine', () => {
  it('evaluates scientific, trig, logarithmic, and bitwise expressions', () => {
    expect(evaluateInstantComputation('sqrt(144) + 2')?.directAnswer).toContain('= 14');
    expect(evaluateInstantComputation('cbrt(27)')?.directAnswer).toContain('= 3');
    expect(evaluateInstantComputation('1 << 10')?.directAnswer).toContain('1,024');
    expect(evaluateInstantComputation('log2(1024)')?.directAnswer).toContain('= 10');
    expect(evaluateInstantComputation('sin(0)')?.directAnswer).toContain('= 0');
  });

  it('evaluates percentages and integer base conversions', () => {
    expect(evaluateInstantComputation('15% of 240')?.directAnswer).toContain('= 36');
    expect(evaluateInstantComputation('30 is what % of 120')?.directAnswer).toContain('25%');
    expect(evaluateInstantComputation('255 in hex')?.directAnswer).toContain('0xFF');
    expect(evaluateInstantComputation('0xff in dec')?.directAnswer).toContain('255');
    expect(evaluateInstantComputation('10 in bin')?.directAnswer).toContain('0b1010');
  });

  it('converts temperatures, binary/decimal storage, length, mass, speed, and time units', () => {
    expect(evaluateInstantComputation('100 C in F')?.directAnswer).toContain('212');
    expect(evaluateInstantComputation('32 F to C')?.directAnswer).toContain('0');
    expect(evaluateInstantComputation('1 GiB in MiB')?.directAnswer).toContain('1,024');
    expect(evaluateInstantComputation('5 km in mi')?.directAnswer).toContain('3.107');
    expect(evaluateInstantComputation('70 kg in lb')?.directAnswer).toContain('154.3');
    expect(evaluateInstantComputation('2 hours in seconds')?.directAnswer).toContain('7200');
  });

  it('inspects CSS colors (#hex, rgb, hsl) with swatchColor and WCAG contrast ratios', () => {
    const hex = evaluateInstantComputation('#ff5733');
    expect(hex?.swatchColor?.toLowerCase()).toBe('#ff5733');
    expect(hex?.directAnswer).toContain('rgb(255, 87, 51)');
    expect(hex?.keyFacts?.some((f) => f.label.includes('Contrast'))).toBe(true);

    const rgb = evaluateInstantComputation('rgb(37, 99, 235)');
    expect(rgb?.swatchColor?.toLowerCase()).toBe('#2563eb');

    const hsl = evaluateInstantComputation('hsl(120, 100%, 50%)');
    expect(hsl?.swatchColor?.toLowerCase()).toBe('#00ff00');
  });

  it('calculates IPv4 CIDR subnet ranges, Unix timestamps, HTTP statuses, and cron schedules', () => {
    const cidr = evaluateInstantComputation('192.168.1.0/24');
    expect(cidr?.directAnswer).toContain('254');
    expect(cidr?.keyFacts?.some((f) => f.value.includes('255.255.255.0'))).toBe(true);

    const epoch = evaluateInstantComputation('1700000000');
    expect(epoch?.directAnswer).toContain('2023-11-14T22:13:20.000Z');

    const iso = evaluateInstantComputation('unix 2026-11-15T12:00:00Z');
    expect(iso?.directAnswer).toContain('1794744000');

    const http418 = evaluateInstantComputation('http 418');
    expect(http418?.title).toContain("418 I'm a teapot");
    expect(http418?.directAnswer.toLowerCase()).toContain('teapot');

    const cron = evaluateInstantComputation('*/15 9-17 * * 1-5');
    expect(cron?.title.toLowerCase()).toContain('15 minutes');
    expect(cron?.directAnswer).toContain('Mon-Fri');
  });
});

describe('0.5.0 ranking, ccSLDs, timeRange & memoized scoreCache', () => {
  it('validates SearchTimeRange values and filters out results older than the requested window', () => {
    expect(isSearchTimeRange('week')).toBe(true);
    expect(isSearchTimeRange('decade')).toBe(false);

    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const raw: RawSearchResult[] = [
      { id: '1', title: 'Fresh SQLite WAL note', url: 'https://jvns.ca/blog/wal/', snippet: 'SQLite WAL mode notes', source: 'marginalia', publishedAt: nowIso },
      { id: '2', title: 'Old SQLite WAL note', url: 'https://danluu.com/wal/', snippet: 'SQLite WAL mode archive', source: 'marginalia', publishedAt: oldIso },
    ];
    const cache = new WeakMap<RawSearchResult, ScoredSearchResult>();
    const week = diversifyAndRankResults(raw, { timeRange: 'week' }, 'sqlite wal', undefined, cache);
    expect(week.surfaced.map((r) => r.id)).toEqual(['1']);
    expect(cache.has(raw[0])).toBe(true);

    const all = diversifyAndRankResults(raw, { timeRange: 'any' }, 'sqlite wal', undefined, cache);
    expect(all.surfaced.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('normalizes two-level ccSLDs, suppresses MediaWiki utility namespaces, and preserves Unicode query tokens', () => {
    expect(extractDomainInfo('https://docs.example.co.jp/guide').rootDomain).toBe('example.co.jp');
    expect(extractDomainInfo('https://news.example.com.br/post').rootDomain).toBe('example.com.br');

    const special = scoreSearchResult({
      id: 'w1',
      title: 'Special:Search',
      url: 'https://en.wikipedia.org/wiki/Special:Search/sqlite',
      snippet: 'Search results',
      source: 'wikipedia',
    });
    expect(special.signals.map((s) => s.id)).not.toContain('clean-writing-path');

    const compiled = compileSearchQuery('café 東京 "exact match"');
    expect(compiled.rawQuery).toContain('café');
    expect(compiled.synthesizedQuery).toContain('東京');
  });
});

describe('0.5.0 answer engine subject alignment', () => {
  afterEach(() => {
    clearInstantAnswerCache();
    vi.restoreAllMocks();
  });

  it('skips Wikipedia disambiguation and narrow sub-articles with unqueried title qualifiers', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('w/api.php') && url.includes('gsrsearch=')) {
        return Response.json({
          query: {
            pages: [
              {
                index: 1,
                title: 'Cat care (disambiguation)',
                extract: 'Cat care may refer to multiple topics in veterinary medicine and domestic husbandry across households.',
              },
              {
                index: 2,
                title: 'Community cat',
                extract: 'A community cat is an unowned free-roaming cat cared for by neighbors through trap-neuter-return cat care programs.',
              },
              {
                index: 3,
                title: 'Cat',
                extract: 'The cat is a domesticated species of small carnivorous mammal kept as an indoor companion and cared for with daily nutrition, grooming, litter hygiene, and veterinary care.',
              },
            ],
          },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const lookups = prefetchInstantAnswer('cat care');
    const ans = await buildInstantAnswer('cat care', [], lookups);
    expect(ans?.title).toBe('Cat');
    expect(ans?.primarySourceUrl).toBe('https://en.wikipedia.org/wiki/Cat');
  });
});

describe('0.5.0 deep index OPML, FTS5 operators & user source management', () => {
  it('round-trips OPML 2.0 outlines cleanly and builds operator-aware FTS5 queries', () => {
    const xml = exportOpml(
      [
        { url: 'https://jvns.ca/atom.xml', site: 'jvns.ca', title: 'Julia Evans', kind: 'blog' },
        { url: 'https://danluu.com/atom.xml', site: 'danluu.com', title: 'Dan Luu & Notes', kind: 'blog' },
      ],
      'My Feeds'
    );
    const parsed = parseOpml(xml);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].xmlUrl).toBe('https://jvns.ca/atom.xml');
    expect(parsed[1].title).toBe('Dan Luu & Notes');

    expect(ftsQuery(['sqlite', 'wal'], 'or', { phrases: ['write ahead'], without: ['mysql'] })).toBe(
      '("sqlite" OR "wal") "write ahead" NOT "mysql"'
    );
  });

  it('filters deep store results by phrases, excluded terms, sites, notSites, sinceMs, and deletes user sources', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-050-'));
    try {
      const store = await openDeepStore(path.join(tmp, 'deep.db'));
      store.addSources([
        { url: 'https://jvns.ca/atom.xml', kind: 'blog', site: 'jvns.ca', origin: 'user', title: 'Julia Evans', intervalMin: 1440 },
        { url: 'https://danluu.com/atom.xml', kind: 'blog', site: 'danluu.com', origin: 'user', title: 'Dan Luu', intervalMin: 1440 },
      ]);
      const rows = store.exportableSources({ origin: 'user' });
      expect(rows).toHaveLength(2);

      const due = store.dueSources(Date.now() + 60_000, 10);
      const jvns = due.find((s) => s.site === 'jvns.ca')!;
      const dan = due.find((s) => s.site === 'danluu.com')!;
      const nowMs = Date.now();
      store.savePosts(jvns, [
        { url: 'https://jvns.ca/blog/sqlite/', title: 'SQLite write ahead logging', summary: 'Fast local database durability', published: nowMs },
      ]);
      store.savePosts(dan, [
        { url: 'https://danluu.com/mysql/', title: 'SQLite vs MySQL notes', summary: 'Write ahead logging comparison', published: nowMs - 40 * 86_400_000 },
      ]);

      const filtered = store.search(['sqlite'], {
        phrases: ['write ahead'],
        without: ['mysql'],
        sites: ['jvns.ca'],
        sinceMs: nowMs - 7 * 86_400_000,
      });
      expect(filtered.map((p) => p.url)).toEqual(['https://jvns.ca/blog/sqlite/']);

      expect(store.removeSource(dan.id, 'user')).toBe(true);
      expect(store.exportableSources({ origin: 'user' })).toHaveLength(1);
      store.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('0.5.0 client quickCalc, snippet highlighting & result/answer UI', () => {
  it('computes 0ms client previews in quickCalc and escapes markup while highlighting snippet matches', () => {
    expect(quickCalc('12 * 8')?.directAnswer).toBe('96');
    expect(quickCalc('25% of 80')?.directAnswer).toBe('20');
    expect(quickCalc('#336699')?.swatchColor).toBe('#336699');
    expect(quickCalc('255 in hex')?.directAnswer).toBe('0xff');
    expect(quickCalc('rust borrow checker')).toBeNull();

    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <div>
          <p className="snip">{renderHighlightedSnippet('SQLite <script>alert(1)</script> uses WAL mode', 'sqlite -mysql site:sqlite.org')}</p>
          <AnswerCard
            answer={{
              kind: 'computation',
              title: '#ff5733',
              subtitle: 'Color',
              directAnswer: '#ff5733 · rgb(255, 87, 51)',
              swatchColor: '#ff5733',
              confidence: 'verified',
              citations: [],
            }}
            onRead={() => {}}
          />
          <ResultItem
            item={scoreSearchResult({
              id: 'r1',
              title: 'SQLite WAL Mode',
              url: 'https://sqlite.org/wal.html',
              snippet: 'Write-Ahead Logging in SQLite.',
              source: 'marginalia',
            })}
            active={false}
            onHover={() => {}}
            saved={false}
            onSave={() => {}}
            onRead={() => {}}
            onSend={() => {}}
            onRule={() => {}}
            onSiteSearch={() => {}}
            query="sqlite wal"
          />
        </div>
      );
    });

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('mark.hl').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('i.answer-swatch')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('.answer-eyebrow span')).map((el) => el.textContent)).toEqual(['Calculated']);

    act(() => root.unmount());
  });
});
