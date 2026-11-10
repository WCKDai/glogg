// @vitest-environment jsdom
/**
 * The browser extension in jsdom: the content script on results pages built
 * like Google's, DuckDuckGo's and Bing's, and the toolbar popup, with the
 * extension APIs stubbed. No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_SEED, html, list, pick, rng, RUNS, text } from './fuzz.js';

/** jsdom builds a page per case: slow under coverage on a busy machine, so time grows with RUNS. */
const HEAVY = Math.max(30_000, RUNS * 100);
import type { Rng } from './fuzz.js';

const POPUP_HTML = fs.readFileSync(path.resolve(import.meta.dirname, '../extension/popup.html'), 'utf8');

/** Every extension API a script could reach for, as spies. */
function extensionApis() {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const area = () => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() });
  return {
    runtime: { id: 'glogg', sendMessage: vi.fn(), connect: vi.fn(), getURL: vi.fn((p: string) => `chrome-extension://glogg/${p}`), onMessage: event() },
    storage: { sync: area(), local: area(), session: area(), onChanged: event() },
    tabs: { query: vi.fn(), create: vi.fn(), update: vi.fn(), sendMessage: vi.fn() },
  };
}

/** Names of the stubbed APIs a script called. */
function used(apis: object, prefix = 'chrome'): string[] {
  return Object.entries(apis).flatMap(([k, v]) =>
    vi.isMockFunction(v) ? (v.mock.calls.length ? [`${prefix}.${k}`] : []) : v && typeof v === 'object' ? used(v, `${prefix}.${k}`) : []
  );
}

let apis: ReturnType<typeof extensionApis>;
let requests: string[];
let opened: unknown[][];

beforeEach(() => {
  apis = extensionApis();
  requests = [];
  opened = [];
  vi.stubGlobal('chrome', apis);
  vi.stubGlobal('browser', apis);
  vi.stubGlobal('fetch', async (input: string) => {
    requests.push(String(input));
    throw new TypeError('no network in tests');
  });
  vi.stubGlobal('open', (...args: unknown[]) => void opened.push(args));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/');
});

/** Loads a script fresh, the way the browser runs it on each page. */
async function run(script: 'content' | 'popup') {
  vi.resetModules();
  if (script === 'content') await import('../extension/content.js');
  else await import('../extension/popup.js');
}

// ── Results pages ────────────────────────────────────────────────────────────
type Hit = { title: string; url: string; snippet: string };

const HITS: Record<string, Hit> = {
  docs: { title: 'Architecture of SQLite', url: 'https://www.sqlite.org/arch.html', snippet: 'This document describes the architecture of the SQLite library.' },
  blog: { title: 'How does SQLite work? Part 1: pages!', url: 'https://jvns.ca/blog/2014/09/27/how-does-sqlite-work-part-1-pages/', snippet: 'I wrote a tiny program to look at how SQLite stores pages on disk.' },
  listicle: {
    title: '15 Best SQLite Tools (2026 Ultimate Guide) - Top Picks Reviewed',
    url: 'https://www.techradar.com/best/best-sqlite-tools',
    snippet: "In today's fast-paced world, choosing the best SQLite tool is crucial. Affiliate disclosure: we may earn a commission. Sponsored partner offer.",
  },
  farm: { title: 'SQLite Tutorial', url: 'https://www.geeksforgeeks.org/sqlite-tutorial/', snippet: 'Learn SQLite with examples.' },
  repeat: { title: 'Database File Format', url: 'https://www.sqlite.org/fileformat.html', snippet: 'The SQLite database file format.' },
  plain: { title: 'SQLite internals: the B-tree', url: 'https://fly.io/blog/sqlite-internals-btree/', snippet: 'B-trees in SQLite.' },
};
const ORDER = ['docs', 'blog', 'listicle', 'farm', 'repeat', 'plain'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Result pages as each engine builds them; `raw` keeps snippet markup as the page had it. */
const google = (hits: Hit[], raw = false) => `
  <div id="search">
    <div id="tads" aria-label="Ads"><div class="uEierd"><span>Sponsored</span><a href="https://ads.example/db-pro"><h3>DB Pro: the SQLite IDE</h3></a></div></div>
    <div id="rso">
      ${hits
        .map(
          (h) => `<div class="g"><div class="yuRUbf"><a href="${esc(h.url)}"><br><h3 class="LC20lb">${esc(h.title)}</h3><cite>${esc(h.url)}</cite></a></div><div class="VwiC3b"><span>${raw ? h.snippet : esc(h.snippet)}</span></div></div>`
        )
        .join('')}
      <div class="g"><div class="related-question-pair">People also ask: is SQLite a real database?</div></div>
    </div>
    <div id="bottomads"><div><a href="https://ads.example/hosting"><h3>Managed SQLite hosting</h3></a></div></div>
  </div>`;

const duckduckgo = (hits: Hit[], raw = false) => `
  <ol class="react-results--main">
    <li><article class="result--ad" data-testid="ad"><h2><a href="https://ads.example/db-pro">DB Pro</a></h2></article></li>
    ${hits
      .map((h) => `<li><article data-testid="result"><h2><a href="${esc(h.url)}" data-testid="result-title-a"><span>${esc(h.title)}</span></a></h2><div data-result="snippet"><span>${raw ? h.snippet : esc(h.snippet)}</span></div></article></li>`)
      .join('')}
  </ol>`;

const bing = (hits: Hit[], raw = false) => `
  <ol id="b_results">
    <li class="b_ad"><ul><li><h2><a href="https://ads.example/db-pro">DB Pro</a></h2></li></ul></li>
    ${hits.map((h) => `<li class="b_algo"><h2><a href="${esc(h.url)}">${esc(h.title)}</a></h2><div class="b_caption"><p>${raw ? h.snippet : esc(h.snippet)}</p></div></li>`).join('')}
  </ol>`;

function openPage(address: string, markup: string) {
  window.history.replaceState({}, '', address);
  document.body.innerHTML = markup;
}

const results = () => [...document.querySelectorAll<HTMLElement>('div.g, article[data-testid="result"], li.b_algo')].filter((r) => r.querySelector('a[href^="http"]'));
const resultFor = (url: string) => results().find((r) => r.querySelector('a')!.getAttribute('href') === url)!;
const dimmed = (el: Element) => getComputedStyle(el).opacity === '0.25';
const badge = (el: Element) => el.querySelector('.glogg-badge')?.textContent ?? null;
const hud = () => document.getElementById('glogg-serp-hud');

describe('content script on a Google results page', () => {
  beforeEach(() => openPage('/search?q=sqlite+internals&udm=14', google(ORDER.map((k) => HITS[k]))));

  it('hides every ad block', async () => {
    await run('content');
    for (const id of ['tads', 'bottomads']) expect(getComputedStyle(document.getElementById(id)!).display).toBe('none');
    expect(results().every((r) => getComputedStyle(r).display !== 'none')).toBe(true);
  });

  it('dims content farms, sponsored listicles and repeats of a site already shown', async () => {
    await run('content');
    expect(results().map((r) => [r.querySelector('a')!.getAttribute('href'), dimmed(r)])).toEqual([
      [HITS.docs.url, false],
      [HITS.blog.url, false],
      [HITS.listicle.url, true],
      [HITS.farm.url, true],
      [HITS.repeat.url, true],
      [HITS.plain.url, false],
    ]);
  });

  it('badges primary sources and independent sites in their titles, and leaves the rest alone', async () => {
    await run('content');
    expect(badge(resultFor(HITS.docs.url))).toMatch(/^PRIMARY · \d+%$/);
    expect(badge(resultFor(HITS.blog.url))).toMatch(/^INDIE · \d+%$/);
    expect(results().filter((r) => badge(r)).map((r) => r.querySelector('a')!.getAttribute('href'))).toEqual([HITS.docs.url, HITS.blog.url]);
    const title = resultFor(HITS.docs.url).querySelector('h3')!;
    expect(title.firstElementChild).toBe(title.querySelector('.glogg-badge'));
    expect(title.lastChild!.textContent).toBe('Architecture of SQLite');
  });

  it('leaves blocks that are not results untouched', async () => {
    const before = document.querySelector('.related-question-pair')!.closest('.g')!.outerHTML;
    await run('content');
    expect(document.querySelector('.related-question-pair')!.closest('.g')!.outerHTML).toBe(before);
  });

  it('puts a summary bar on top with the counts and two ways out', async () => {
    await run('content');
    const bar = hud()!;
    expect(document.body.firstElementChild).toBe(bar);
    expect(bar.querySelector('.glogg-hud-brand')!.textContent).toBe('glogg SERP Shield');
    expect(bar.querySelector('.glogg-hud-stats')!.textContent).toBe('2 Ads Killed · 3 Slop/Dupes Demoted · 1 Primary Sources');
    const [small, filter] = [...bar.querySelectorAll('a')];
    expect([small.textContent, small.getAttribute('href'), small.target, small.rel]).toEqual([
      'Marginalia Small-Web ↗',
      'https://search.marginalia.nu/search?query=sqlite%20internals',
      '_blank',
      'noreferrer',
    ]);
    expect(filter.textContent).toBe('Apply -site: Slop Filter');
    const url = new URL(filter.href);
    expect(url.origin).toBe('https://html.duckduckgo.com');
    expect(url.searchParams.get('q')).toMatch(/^sqlite internals( -site:\S+)+$/);
  });

  it('changes nothing when it runs again on the same page', async () => {
    await run('content');
    const once = document.body.innerHTML;
    await run('content');
    expect(document.body.innerHTML).toBe(once);
    expect(document.querySelectorAll('#glogg-ext-styles')).toHaveLength(1);
    expect(document.querySelectorAll('.glogg-badge')).toHaveLength(2);
  });

  it('keeps to the page: no extension messages, no storage, no network', async () => {
    await run('content');
    expect(used(apis)).toEqual([]);
    expect(requests).toEqual([]);
    expect(opened).toEqual([]);
    expect(document.querySelectorAll('script, iframe, img, link')).toHaveLength(0);
  });
});

describe('content script elsewhere', () => {
  it('works the same on DuckDuckGo', async () => {
    openPage('/?q=sqlite+internals&t=h_&ia=web', duckduckgo(ORDER.map((k) => HITS[k])));
    await run('content');
    expect(getComputedStyle(document.querySelector('.result--ad')!).display).toBe('none');
    expect(results().map(dimmed)).toEqual([false, false, true, true, true, false]);
    expect(badge(resultFor(HITS.docs.url))).toMatch(/^PRIMARY/);
    expect(hud()!.querySelector('.glogg-hud-stats')!.textContent).toBe('1 Ads Killed · 3 Slop/Dupes Demoted · 1 Primary Sources');
  });

  it('works the same on Bing', async () => {
    openPage('/search?q=sqlite+internals&form=QBLH', bing(ORDER.map((k) => HITS[k])));
    await run('content');
    expect(getComputedStyle(document.querySelector('.b_ad')!).display).toBe('none');
    expect(results().map(dimmed)).toEqual([false, false, true, true, true, false]);
    expect(badge(resultFor(HITS.blog.url))).toMatch(/^INDIE/);
    expect(hud()).toBeTruthy();
  });

  it('reads the query from "query" when there is no "q"', async () => {
    openPage('/search?query=rust+lifetimes', google([HITS.plain]));
    await run('content');
    expect(hud()!.querySelector('a')!.getAttribute('href')).toBe('https://search.marginalia.nu/search?query=rust%20lifetimes');
  });

  it('cleans the page but adds no bar when there is no query', async () => {
    openPage('/search', google(ORDER.map((k) => HITS[k])));
    await run('content');
    expect(hud()).toBeNull();
    expect(getComputedStyle(document.getElementById('tads')!).display).toBe('none');
    expect(results().filter(dimmed)).toHaveLength(3);
  });

  it('does nothing visible on a page without results or ads', async () => {
    openPage('/search?q=sqlite', '<main><p>No results found for <b>sqlite</b>.</p></main>');
    await run('content');
    expect(document.querySelector('main')!.outerHTML).toBe('<main><p>No results found for <b>sqlite</b>.</p></main>');
    expect(hud()!.querySelector('.glogg-hud-stats')!.textContent).toBe('0 Ads Killed · 0 Slop/Dupes Demoted · 0 Primary Sources');
  });
});

/** forAll for checks that need to load a script: same seeds, same replay line as fuzz.ts. */
async function forAllAsync<T>(name: string, gen: (r: Rng) => T, check: (input: T) => Promise<void>) {
  for (let i = 0; i < RUNS; i++) {
    const seed = BASE_SEED + i;
    const input = gen(rng(seed));
    try {
      await check(input);
    } catch (e) {
      const shown = JSON.stringify(input);
      throw new Error(
        `${name} failed for seed ${seed} (replay: GLOGG_FUZZ_SEED=${seed} GLOGG_FUZZ_RUNS=1)\ninput: ${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}\n${e instanceof Error ? e.message : e}`
      );
    }
  }
}

/** The page as it was, from the page after the script ran: drop the bar and badges it adds, and the marks and inline styles it leaves. */
function withoutGlogg(): string {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('#glogg-serp-hud, .glogg-badge').forEach((el) => el.remove());
  copy.querySelectorAll<HTMLElement>('*').forEach((el) => {
    delete el.dataset.gloggProcessed;
    // Only elements it marked: classList.remove() rewrites any class attribute it touches.
    if (el.classList.contains('glogg-demoted')) {
      el.classList.remove('glogg-demoted');
      if (!el.classList.length) el.removeAttribute('class');
    }
    if (el.style.display === 'none') {
      el.style.removeProperty('display');
      if (!el.getAttribute('style')) el.removeAttribute('style');
    }
  });
  return copy.innerHTML;
}

describe('content script on hostile pages', () => {
  it('only ever adds its own bar, badges and marks, whatever the page and query contain', async () => {
    // jsdom reports the fuzzed pages' own broken <style> blocks; that is the page, not the script.
    const report = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) report(...args);
    });
    await forAllAsync(
      'results page',
      (r) => ({
        query: text(r),
        engine: pick(r, ['google', 'duckduckgo', 'bing'] as const),
        hits: list(r, 6, (x) => ({
          title: text(x),
          url: pick(x, ['https://', 'http://']) + pick(x, ['sqlite.org', 'jvns.ca', 'geeksforgeeks.org', 'example.com', 'a.b.example.co.uk', 'xn--bcher-kva.example']) + '/' + encodeURIComponent(text(x, 3)),
          snippet: html(x),
        })),
      }),
      async ({ query, engine, hits }) => {
        openPage(`/search?q=${encodeURIComponent(query)}`, { google, duckduckgo, bing }[engine](hits, true));
        const before = document.body.innerHTML;
        await run('content');
        expect(withoutGlogg()).toBe(before);
        expect([...document.querySelectorAll('.glogg-badge')].every((b) => /^(PRIMARY|INDIE) · \d+%$/.test(b.textContent!))).toBe(true);
        const bar = hud();
        if (query.trim()) {
          expect(bar).toBeTruthy();
          expect([...bar!.querySelectorAll('*')].map((el) => el.tagName).sort()).toEqual(['A', 'A', 'DIV', 'DIV', 'DIV', 'SPAN', 'SPAN']);
          expect([...bar!.querySelectorAll('a')].every((a) => a.href.startsWith('https://'))).toBe(true);
          expect(bar!.textContent).toMatch(/^glogg SERP Shield\d+ Ads Killed · \d+ Slop\/Dupes Demoted · \d+ Primary SourcesMarginalia Small-Web ↗Apply -site: Slop Filter$/);
        }
        document.head.replaceChildren();
      }
    );
  }, HEAVY);
});

// ── Popup ────────────────────────────────────────────────────────────────────
function openPopup() {
  const doc = new DOMParser().parseFromString(POPUP_HTML, 'text/html');
  doc.querySelectorAll('script').forEach((s) => s.remove());
  document.head.replaceChildren(...[...doc.head.childNodes].map((n) => document.importNode(n, true)));
  document.body.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  return {
    input: document.getElementById('glogg-q') as HTMLInputElement,
    form: document.getElementById('glogg-popup-form') as HTMLFormElement,
    links: () => [...document.querySelectorAll<HTMLAnchorElement>('#glogg-escape-links a')],
  };
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('popup', () => {
  it('opens with four engines for an example search, each in a new tab', async () => {
    const { links } = openPopup();
    await run('popup');
    expect(links().map((a) => a.textContent)).toEqual(['Marginalia ↗', 'DuckDuckGo ↗', 'Google ↗', 'Bluesky ↗']);
    expect(links().every((a) => a.target === '_blank' && a.rel === 'noreferrer' && a.href.startsWith('https://'))).toBe(true);
    expect(links()[0].getAttribute('href')).toBe('https://search.marginalia.nu/search?query=sqlite%20internals');
  });

  it('points the engines at what you type, and back at the example once the box is empty', async () => {
    const { input, links } = openPopup();
    await run('popup');
    typeInto(input, 'rust lifetimes');
    expect(links()).toHaveLength(4);
    expect(links()[0].getAttribute('href')).toBe('https://search.marginalia.nu/search?query=rust%20lifetimes');
    expect(links().every((a) => a.href.includes('rust%20lifetimes'))).toBe(true);
    typeInto(input, '');
    expect(links()[0].getAttribute('href')).toBe('https://search.marginalia.nu/search?query=sqlite%20internals');
  });

  it('searches DuckDuckGo with the anti-slop filters in a new tab', async () => {
    const { input, form } = openPopup();
    await run('popup');
    typeInto(input, '  rust lifetimes ');
    form.requestSubmit();
    expect(opened).toHaveLength(1);
    const [url, target] = opened[0] as [string, string];
    expect(target).toBe('_blank');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://html.duckduckgo.com/html/');
    expect(u.searchParams.get('q')).toMatch(/^rust lifetimes( -site:\S+)+$/);
  });

  it('opens nothing for an empty or blank search', async () => {
    const { input, form } = openPopup();
    await run('popup');
    form.requestSubmit();
    typeInto(input, '   ');
    form.requestSubmit();
    expect(opened).toEqual([]);
  });

  it('names its controls', async () => {
    const { input } = openPopup();
    await run('popup');
    expect(input.getAttribute('placeholder')).toBe('Unslop search query...');
    expect(document.querySelector('button[type="submit"]')!.textContent).toBe('Go');
    expect([...document.querySelectorAll('img')].every((img) => img.getAttribute('alt') === '')).toBe(true);
  });

  it('keeps to itself: no extension APIs, no network', async () => {
    const { input } = openPopup();
    await run('popup');
    typeInto(input, 'anything');
    expect(used(apis)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('only ever shows plain links, whatever you type', async () => {
    const { input, links } = openPopup();
    await run('popup');
    await forAllAsync(
      'popup query',
      (r) => text(r) + pick(r, ['', '<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', 'javascript:alert(1)']),
      async (q) => {
        typeInto(input, q);
        const box = document.getElementById('glogg-escape-links')!;
        expect([...box.children].map((c) => c.tagName)).toEqual(['A', 'A', 'A', 'A']);
        expect(box.querySelectorAll('*')).toHaveLength(4);
        expect(links().every((a) => a.href.startsWith('https://') && /^[\w.|' -]+ ↗$/.test(a.textContent!))).toBe(true);
        // A one-line box drops line breaks from what was typed, as browsers do.
        const typed = input.value.trim();
        if (typed) expect(links()[0].getAttribute('href')).toBe(`https://search.marginalia.nu/search?query=${encodeURIComponent(typed)}`);
      }
    );
  });
});
