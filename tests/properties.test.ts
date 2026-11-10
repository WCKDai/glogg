/**
 * Properties that must hold for any input, checked on seeded random inputs
 * (tests/fuzz.ts): parsers never throw or hang on hostile text, ranking keeps
 * its promises, links stay http(s), and the request guard and sessions can't
 * be talked into saying yes.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BUILTIN_BANGS,
  cleanAndAutopsyHtml,
  compileSearchQuery,
  diversifyAndRankResults,
  evaluateInstantComputation,
  RawSearchResult,
  resolveBang,
  scoreSearchResult,
  SearchLensId,
  stripTrackingFromUrl,
  suggestBangs,
} from '../src/core/index.js';
import { Markdown } from '../src/client/components/Markdown.js';
import { plural, relativeDate, urlCrumb } from '../src/client/lib.js';
import {
  discoverFeeds,
  htmlToText,
  parse512kbSites,
  parseChanCatalog,
  parseDiscourseDirectory,
  parseFeed,
  parseFeedList,
  parseJsonFeed,
  parseLemmyverse,
  parseWebring,
} from '../server/deep/parse.js';
import { ftsQuery, openDeepStore } from '../server/deep/store.js';
import { createAuth } from '../server/auth.js';
import { isAllowedHost, isAllowedOrigin, rejectReason } from '../server/security.js';
import { anyString, forAll, html, int, list, pick, Rng, text, TIMEOUT, urlish } from './fuzz.js';

const LENSES: SearchLensId[] = ['all', 'pre-llm', 'indie', 'primary', 'forums', 'academic', 'p2p-magnet', 'usenet-nzb', 'fediverse', 'wild-west'] as SearchLensId[];
const SOURCES = ['web', 'marginalia', 'wiby', 'hn', 'stackexchange', 'wikipedia', 'lemmy', 'github', 'reddit', 'indie-index', 'deep-blogs'] as const;
const DOMAINS = ['example.com', 'blog.example.com', 'medium.com', 'news.ycombinator.com', 'en.wikipedia.org', 'github.com', 'tiny.example', 'forbes.com', 'danluu.com', 'pinterest.com'];

const isWebOrMagnet = (u: string) => /^(https?:\/\/|magnet:\?)/i.test(u);
const time = (fn: () => void) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

function rawResult(r: Rng): RawSearchResult {
  const domain = pick(r, DOMAINS);
  return {
    title: text(r, 8) || 'untitled',
    url: r() < 0.9 ? `https://${domain}/${int(r, 0, 30)}${r() < 0.3 ? '?utm_source=x&id=1' : ''}` : urlish(r),
    snippet: text(r, 20),
    source: pick(r, SOURCES) as RawSearchResult['source'],
    publishedAt: r() < 0.5 ? new Date(int(r, 0, 2_000_000_000) * 1000).toISOString() : undefined,
    isNsfw: r() < 0.1,
  };
}

describe('query compiler', () => {
  it('never throws, and every escape link is a real URL carrying the query', () => {
    forAll(
      'compileSearchQuery',
      (r) => ({ q: r() < 0.8 ? text(r) : anyString(r), lens: pick(r, LENSES), blocked: list(r, 10, (x) => pick(x, DOMAINS)) }),
      ({ q, lens, blocked }) => {
        const plan = compileSearchQuery(q, { lens, blockedDomains: blocked });
        expect(typeof plan.synthesizedQuery).toBe('string');
        // Ten from your list and the built-in one, plus the few a lens adds.
        expect(plan.negativeSiteOperators.length).toBeLessThanOrEqual(13);
        for (const op of plan.negativeSiteOperators) expect(op).toMatch(/^-site:\S+$/);
        for (const escape of plan.escapeUrls) {
          const url = new URL(escape.url);
          expect(['https:', 'http:']).toContain(url.protocol);
        }
      }
    );
  });

  it('reads a query with half an emoji (a lone surrogate) instead of failing', () => {
    expect(() => compileSearchQuery('rust \udde9 async')).not.toThrow();
    expect(resolveBang('!w \ud83d turing')!.url).toBe('https://en.wikipedia.org/w/index.php?search=%EF%BF%BD%20turing');
  });

  it('puts your blocked domains first', () => {
    forAll(
      'blocked domains',
      (r) => list(r, 8, (x) => pick(x, DOMAINS)),
      (blocked) => {
        const plan = compileSearchQuery('anything', { blockedDomains: blocked });
        for (const d of new Set(blocked)) expect(plan.negativeSiteOperators).toContain(`-site:${d}`);
      }
    );
  });
});

describe('bangs', () => {
  it('a resolved bang sends the rest of the query, encoded, to that engine', () => {
    forAll(
      'resolveBang',
      (r) => {
        const bang = pick(r, BUILTIN_BANGS);
        const words = list(r, 5, (x) => text(x, 2)).filter((w) => !w.includes('!'));
        const at = int(r, 0, words.length);
        words.splice(at, 0, `!${bang.trigger}`);
        return { q: words.join(' '), trigger: bang.trigger };
      },
      ({ q, trigger }) => {
        const m = resolveBang(q);
        expect(m).not.toBeNull();
        expect(m!.bang.trigger.toLowerCase()).toBe(trigger.toLowerCase());
        expect(m!.query).not.toMatch(new RegExp(`(^|\\s)!${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i'));
        expect(m!.url).toBe(m!.bang.url.replace('{q}', encodeURIComponent(m!.query)));
        const target = new URL(m!.url);
        // Local services (Bitmagnet, …) are plain http on this machine.
        expect(target.protocol === 'https:' || (target.protocol === 'http:' && target.hostname === 'localhost')).toBe(true);
      }
    );
  });

  it('suggestions and lookups never throw on junk', () => {
    forAll('bang junk', (r) => (r() < 0.5 ? anyString(r) : `${text(r, 4)} !${anyString(r, 6)}`), (q) => {
      expect(suggestBangs(q).length).toBeLessThanOrEqual(8);
      resolveBang(q);
    });
  });
});

describe('scoring', () => {
  it('scores stay within 0–100, tracking parameters go, and the same input scores the same', () => {
    forAll('scoreSearchResult', rawResult, (raw) => {
      const a = scoreSearchResult(raw, { blockedDomains: ['forbes.com'] }, 'rust borrow checker');
      const b = scoreSearchResult(raw, { blockedDomains: ['forbes.com'] }, 'rust borrow checker');
      for (const n of [a.slopScore, a.authenticityScore, a.relevanceScore]) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(100);
      }
      expect(a.url).not.toMatch(/[?&]utm_/);
      expect({ ...b, id: a.id }).toEqual(a);
    });
  });

  it('stripping tracking parameters never loses the address', () => {
    forAll('stripTrackingFromUrl', (r) => (r() < 0.7 ? `https://${pick(r, DOMAINS)}/p?${list(r, 4, (x) => `${pick(x, ['utm_source', 'gclid', 'fbclid', 'id', 'q', 'ref', 'tag'])}=${int(x, 0, 99)}`).join('&')}` : urlish(r)), (u) => {
      const { cleanUrl, strippedParams } = stripTrackingFromUrl(u);
      let parsed: URL | null = null;
      try {
        parsed = new URL(u);
      } catch {
        expect(cleanUrl).toBe(u);
      }
      if (!parsed) return;
      const clean = new URL(cleanUrl);
      expect(clean.host).toBe(parsed.host);
      expect(clean.pathname).toBe(parsed.pathname);
      for (const p of strippedParams) expect(clean.searchParams.has(p)).toBe(false);
    });
  });
});

describe('ranking', () => {
  it('keeps its promises for any mix of results', () => {
    forAll(
      'diversifyAndRankResults',
      (r) => ({
        items: list(r, 60, rawResult),
        maxPerDomain: int(r, 1, 4),
        blocked: list(r, 2, (x) => pick(x, DOMAINS)),
        pinned: list(r, 1, (x) => pick(x, DOMAINS)),
        uncensored: r() < 0.3,
        q: r() < 0.8 ? text(r, 4) : '',
      }),
      ({ items, maxPerDomain, blocked, pinned, uncensored, q }) => {
        const out = diversifyAndRankResults(items, { maxPerDomain, blockedDomains: blocked, pinnedDomains: pinned, uncensoredMode: uncensored }, q);
        const inputUrls = new Set(items.map((i) => scoreSearchResult(i).url));
        const surfacedIds = new Set(out.surfaced.map((s) => s.id));

        // Everything shown came from the input, once, and nothing is both shown and filtered.
        for (const s of [...out.surfaced, ...out.filteredSlop]) expect(inputUrls.has(s.url)).toBe(true);
        expect(surfacedIds.size).toBe(out.surfaced.length);
        for (const f of out.filteredSlop) expect(surfacedIds.has(f.id)).toBe(false);

        // Pinned sites first, then best first.
        const isPinned = (s: (typeof out.surfaced)[number]) => s.signals.some((g) => g.id === 'user-pinned-domain');
        for (let i = 1; i < out.surfaced.length; i++) {
          const [a, b] = [out.surfaced[i - 1], out.surfaced[i]];
          expect(Number(isPinned(a))).toBeGreaterThanOrEqual(Number(isPinned(b)));
          if (isPinned(a) === isPinned(b)) expect(a.netScore).toBeGreaterThanOrEqual(b.netScore);
        }

        const perDomain = new Map<string, number>();
        for (const s of out.surfaced) {
          expect(blocked).not.toContain(s.rootDomain);
          if (!uncensored) expect(s.isNsfw).toBeFalsy();
          if (!s.p2p && !s.fediverse && s.rootDomain !== 'wikipedia.org') perDomain.set(s.rootDomain, (perDomain.get(s.rootDomain) ?? 0) + 1);
        }
        for (const n of perDomain.values()) expect(n).toBeLessThanOrEqual(maxPerDomain);

        // The same input ranks the same way.
        const again = diversifyAndRankResults(items, { maxPerDomain, blockedDomains: blocked, pinnedDomains: pinned, uncensoredMode: uncensored }, q);
        expect(again.surfaced.map((s) => s.url)).toEqual(out.surfaced.map((s) => s.url));
      }
    );
  }, TIMEOUT);
});

describe('instant answers compute exactly', () => {
  it('percentages', () => {
    forAll('percent', (r) => ({ p: int(r, 0, 100), t: int(r, 0, 100_000) }), ({ p, t }) => {
      const a = evaluateInstantComputation(`${p}% of ${t}`);
      expect(a?.kind).toBe('computation');
      expect(a!.title).toBe(((p / 100) * t).toLocaleString('en-US', { maximumFractionDigits: 6 }));
    });
  });

  it('bases, both ways', () => {
    forAll('base', (r) => int(r, 0, Number.MAX_SAFE_INTEGER), (n) => {
      expect(evaluateInstantComputation(`${n} in hex`)!.title).toBe(`0x${n.toString(16).toUpperCase()}`);
      expect(evaluateInstantComputation(`0x${n.toString(16)} in decimal`)!.title).toBe(String(n));
      expect(evaluateInstantComputation(`${n} in binary`)!.title).toBe(`0b${n.toString(2)}`);
    });
  });

  it('temperatures round-trip', () => {
    forAll('temperature', (r) => int(r, -400, 1000), (c) => {
      const f = Number(evaluateInstantComputation(`${c}c in f`)!.title.replace(/[^\d.-]/g, ''));
      const back = Number(evaluateInstantComputation(`${f}f in c`)!.title.replace(/[^\d.-]/g, ''));
      expect(Math.abs(back - c)).toBeLessThan(0.02);
    });
  });

  it('anything else is not mistaken for a computation, and never throws', () => {
    forAll('computation junk', (r) => text(r, 6), (q) => {
      const a = evaluateInstantComputation(q);
      if (a) expect(a.kind).toBe('computation');
    });
  });
});

describe('reader: cleaning hostile pages', () => {
  it('never throws or hangs, and its numbers stay sane', () => {
    let slowest = 0;
    forAll('cleanAndAutopsyHtml', (r) => html(r), (page) => {
      let report!: ReturnType<typeof cleanAndAutopsyHtml>;
      slowest = Math.max(slowest, time(() => (report = cleanAndAutopsyHtml(page, 'https://example.com/post'))));
      const s = report.stats;
      for (const n of [s.rawHtmlBytes, s.cleanTextBytes, s.bloatReductionPercent, s.estimatedCleanReadMinutes, report.slopScore, report.authenticityScore]) {
        expect(Number.isFinite(n)).toBe(true);
      }
      expect(s.bloatReductionPercent).toBeGreaterThanOrEqual(0);
      expect(s.bloatReductionPercent).toBeLessThanOrEqual(100);
      for (const section of report.sections) expect(section.text).not.toMatch(/<script/i);
      for (const link of [...report.links, ...report.primarySources]) expect(link.url).toSatisfy(isWebOrMagnet);
    });
    expect(slowest).toBeLessThan(500);
  }, TIMEOUT);

  it('stays fast on pathological repetition', () => {
    for (const page of ['<div>'.repeat(1500), '<a href="'.repeat(3000), `<p>${'in today\'s fast-paced world '.repeat(2000)}</p>`, '&amp;'.repeat(20_000), `<p>${'a'.repeat(200_000)}</p>`, '<'.repeat(100_000)]) {
      expect(time(() => cleanAndAutopsyHtml(page, 'https://example.com/'))).toBeLessThan(1500);
    }
  });

  it('says so when a page is nested too deeply to read, instead of overflowing', () => {
    expect(() => cleanAndAutopsyHtml(`${'<div>'.repeat(5000)}hello`, 'https://example.com/')).toThrow('This page is nested too deeply to clean. Open the original instead.');
  });

  it('keeps only links a reader can follow', () => {
    const page = [
      '<a href="https://ok.example/a">fine link</a>',
      '<a href="/relative/path">relative link</a>',
      '<a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567">magnet link</a>',
      '<a href="JAVASCRIPT:alert(1)">shouty script</a>',
      '<a href="java\tscript:alert(1)">tabbed script</a>',
      '<a href=" javascript:alert(1)">spaced script</a>',
      '<a href="data:text/html,<b>x</b>">data link</a>',
      '<a href="ms-msdt:/id PCWDiagnostic">app launcher</a>',
      '<a href="to-https://example.com/a">odd scheme</a>',
      '<a href="mailto:a@example.com">mail me</a>',
    ].join(' ');
    const report = cleanAndAutopsyHtml(`<html><head><link rel="alternate" type="application/rss+xml" href="javascript:alert(1)"></head><body><p>${page}</p></body></html>`, 'https://example.com/post');
    expect(report.links.map((l) => l.url).sort()).toEqual(['https://example.com/relative/path', 'https://ok.example/a', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567']);
    expect(report.rssFeedUrl).toBeUndefined();
  });
});

describe('deep index parsers', () => {
  const junkJson = (r: Rng): unknown => {
    const roll = r();
    if (roll < 0.15) return null;
    if (roll < 0.3) return anyString(r);
    if (roll < 0.45) return int(r, -5, 5);
    if (roll < 0.6) return list(r, 4, junkJson as (x: Rng) => unknown);
    return Object.fromEntries(list(r, 5, (x) => [pick(x, ['items', 'threads', 'posts', 'url', 'title', 'communities', 'directory_items', 'boards', 'no', 'sub', 'com', 'id', 'name', 'actor_id', 'nsfw', 'counts']), x() < 0.5 ? junkJson(x) : text(x, 3)]));
  };
  const feedXml = (r: Rng) =>
    pick(r, ['<rss><channel>', '<feed xmlns="http://www.w3.org/2005/Atom">', '<rdf:RDF>', '']) +
    list(r, 5, (x) => `<${pick(x, ['item', 'entry'])}><title>${text(x, 4)}</title><link${x() < 0.5 ? ` href="${urlish(x)}"/>` : `>${urlish(x)}</link>`}<description>${html(x, 2)}</description><pubDate>${anyString(x, 12)}</pubDate></${pick(x, ['item', 'entry'])}>`).join('') +
    pick(r, ['</channel></rss>', '</feed>', '']);

  it('never throw, and every address they return is http(s)', () => {
    forAll('parsers', (r) => ({ xml: feedXml(r), page: html(r), json: junkJson(r), txt: text(r, 30) }), ({ xml, page, json, txt }) => {
      const urls: string[] = [];
      const feed = parseFeed(xml, 'https://example.com/feed');
      urls.push(...feed.posts.map((p) => p.url));
      urls.push(...parseJsonFeed(json, 'https://example.com/feed.json').posts.map((p) => p.url));
      urls.push(...parseChanCatalog(json, (no) => `https://boards.example/g/thread/${no}`).map((p) => p.url));
      urls.push(...discoverFeeds(page, 'https://example.com/'));
      urls.push(...parseWebring(page, 'https://ring.example/').map((s) => s.url));
      urls.push(...parseDiscourseDirectory(json, 'https://discover.example/').forums.map((f) => f.url));
      parseLemmyverse(json);
      parse512kbSites(txt);
      parseFeedList(txt);
      for (const u of urls) expect(u).toMatch(/^https?:\/\//);
    });
  }, TIMEOUT);

  it('summaries are never longer than asked', () => {
    forAll('htmlToText', (r) => ({ page: html(r), max: int(r, 5, 400) }), ({ page, max }) => {
      expect(htmlToText(page, max).length).toBeLessThanOrEqual(max + 1);
    });
  });

  it('summaries leave out scripts, styles and embeds', () => {
    expect(htmlToText('<p>Hi</p><script>alert(1)</script><style>p{color:red}</style><iframe><b>x</b></iframe><noscript>enable js</noscript> there')).toBe('Hi there');
  });

  it('one malformed item doesn\'t lose the rest of a feed', () => {
    const feed = parseJsonFeed(
      { items: [{ url: 'https://a.example/1', title: 5, summary: { html: 'x' } }, { url: 'https://a.example/2', title: 'Fine post', content_html: ['nope'] }, { url: 'https://a.example/3', title: 'Also fine', summary: 'Words.' }] },
      'https://a.example/feed.json'
    );
    expect(feed.posts.map((p) => [p.url, p.title, p.summary])).toEqual([
      ['https://a.example/1', 'https://a.example/1', ''],
      ['https://a.example/2', 'Fine post', ''],
      ['https://a.example/3', 'Also fine', 'Words.'],
    ]);
    expect(parseChanCatalog([{ threads: [{ no: 1, sub: { x: 1 }, com: 42, replies: 3 }] }], (no) => `https://b.example/t/${no}`).map((p) => p.url)).toEqual(['https://b.example/t/1']);
    expect(htmlToText(`${'<div>'.repeat(5000)}deep`)).toBe('');
  });

  it('searching the index never fails, whatever you type', async () => {
    const store = await openDeepStore(':memory:');
    store.addSources([{ url: 'https://tiny.example/feed.xml', kind: 'blog', site: 'tiny.example', origin: 'test', intervalMin: 60 }]);
    store.savePosts(store.getSourceByUrl('https://tiny.example/feed.xml')!, [{ url: 'https://tiny.example/a', title: 'Borrow checker notes', summary: 'lifetimes "quoted" (and) * NEAR OR AND' }]);
    forAll('deep search', (r) => list(r, 6, (x) => (x() < 0.5 ? anyString(x, 8) : pick(x, ['"', '*', 'OR', 'AND', 'NOT', 'NEAR', '(', ')', '^', ':', '-', 'borrow', 'checker']))), (words) => {
      expect(() => store.search(words)).not.toThrow();
      expect(() => store.search(words, { kinds: ['blog'] })).not.toThrow();
      const q = ftsQuery(words);
      if (q) expect(q).toMatch(/^"[^"]+"( (OR )?"[^"]+")*$/);
    });
    expect(store.search(['borrow', 'checker']).length).toBe(1);
    store.close();
  });
});

describe('markdown never produces markup it shouldn’t', () => {
  it('only http(s) links, no raw HTML, whatever the model writes', () => {
    forAll(
      'Markdown',
      (r) => list(r, 8, (x) => pick(x, ['# ', '- ', '1. ', '> ', '```', '`code`', '**bold**', '*em*', '_em_', `[${text(x, 2)}](${urlish(x)})`, `[${int(x, 0, 9)}]`, '[1-30]', text(x, 4), '\n', '<b>x</b>', '<script>alert(1)</script>'])).join(pick(r, ['', ' ', '\n'])),
      (md) => {
        const out = renderToStaticMarkup(React.createElement(Markdown, { text: md, sources: [{ index: 1, title: 'One', url: 'https://one.example/' }] }));
        // Raw markup shows as text (&lt;script&gt;), never as elements.
        expect(out).not.toMatch(/<(script|img|iframe|b)\b/i);
        for (const [, href] of out.matchAll(/href="([^"]*)"/g)) expect(href).toMatch(/^https?:\/\//);
      }
    );
  });
});

describe('client helpers', () => {
  it('breadcrumbs, dates and plurals never throw', () => {
    forAll('client helpers', (r) => ({ u: urlish(r), d: r() < 0.5 ? anyString(r, 24) : new Date(int(r, -1e12, 4e12)).toISOString(), n: int(r, -5, 1e6) }), ({ u, d, n }) => {
      expect(typeof urlCrumb(u)).toBe('string');
      expect(typeof relativeDate(d)).toBe('string');
      expect(plural(n, 'result')).toMatch(/result/);
    });
  });
});

describe('request guard', () => {
  const HOSTS = ['localhost:4173', '127.0.0.1:4173', 'glogg.example.com', 'evil.example', 'glogg.local', '[::1]:4173', 'x.localhost'];
  const ORIGINS = ['https://evil.example', 'http://localhost:4173', 'https://glogg.example.com', 'chrome-extension://abc', 'null', 'http://127.0.0.1:4173', 'https://glogg.example.com.evil.example', 'http://localhost:4173.evil.example'];

  it('allows a cross-site origin only when it is this glogg or on your list', () => {
    forAll('isAllowedOrigin', (r) => ({ origin: r() < 0.8 ? pick(r, ORIGINS) : anyString(r, 20), host: pick(r, HOSTS), allowed: r() < 0.3 ? pick(r, ['https://glogg.example.com', 'chrome-extension://abc']) : '' }), ({ origin, host, allowed }) => {
      const ok = isAllowedOrigin(origin, host, { GLOGG_ALLOWED_ORIGINS: allowed });
      let expected = false;
      try {
        const u = new URL(origin);
        expected = u.host === host || (allowed !== '' && origin.toLowerCase() === allowed);
      } catch {
        expected = false;
      }
      expect(ok).toBe(expected);
    });
  });

  it('a Host that only looks like an allowed one is refused', () => {
    forAll('isAllowedHost', (r) => `${pick(r, ['glogg.example.com', 'localhost', 'evil'])}${pick(r, ['.evil.example', '-evil.example', 'x', '.com'])}:${int(r, 1, 65535)}`, (host) => {
      const expected = /\.localhost$|^localhost$|\.local$/.test(host.replace(/:\d+$/, ''));
      expect(isAllowedHost(host, { GLOGG_ALLOWED_HOSTS: 'glogg.example.com' })).toBe(expected);
    });
  });

  it('a page elsewhere never gets through, whatever headers it sends', () => {
    forAll(
      'rejectReason',
      (r) => ({ host: pick(r, ['localhost:4173', 'glogg.example.com']), origin: pick(r, ['https://evil.example', 'null', 'https://glogg.example.com.evil.example']), site: pick(r, ['cross-site', 'same-site', undefined]) }),
      ({ host, origin, site }) => {
        expect(rejectReason({ headers: { host, origin, 'sec-fetch-site': site } }, { GLOGG_ALLOWED_HOSTS: 'glogg.example.com' })).not.toBeNull();
      }
    );
  });
});

describe('sessions', () => {
  const auth = createAuth({ password: 'correct horse battery', secret: Buffer.alloc(32, 7), now: () => 1_700_000_000_000 });

  it('random and tampered tokens never verify', () => {
    const good = auth.issue();
    expect(auth.verify(good)).toBe(true);
    forAll('verify', (r) => {
      if (r() < 0.5) return anyString(r, 60);
      const chars = good.split('');
      const i = int(r, 0, chars.length - 1);
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';
      let c = pick(r, alphabet.split(''));
      while (c === chars[i]) c = pick(r, alphabet.split(''));
      chars[i] = c;
      return chars.join('');
    }, (token) => {
      expect(auth.verify(token)).toBe(false);
    });
  });

  it('a token from another password or secret never verifies', () => {
    const other = createAuth({ password: 'correct horse battery!', secret: Buffer.alloc(32, 7), now: () => 1_700_000_000_000 });
    const otherSecret = createAuth({ password: 'correct horse battery', secret: Buffer.alloc(32, 8), now: () => 1_700_000_000_000 });
    expect(auth.verify(other.issue())).toBe(false);
    expect(auth.verify(otherSecret.issue())).toBe(false);
  });

  it('only the exact password passes', () => {
    forAll('checkPassword', (r) => (r() < 0.5 ? anyString(r, 30) : `correct horse battery${pick(r, [' ', '!', 'x', '\0', ''])}`.slice(0, int(r, 0, 25))), (guess) => {
      expect(auth.checkPassword(guess)).toBe(guess === 'correct horse battery');
    });
    expect(auth.checkPassword('correct horse battery')).toBe(true);
    for (const v of [undefined, null, 42, ['correct horse battery'], { toString: () => 'correct horse battery' }]) expect(auth.checkPassword(v)).toBe(false);
  });
});
