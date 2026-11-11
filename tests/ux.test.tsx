// @vitest-environment jsdom
/**
 * The UX review's client-side findings, in the real App against a scripted
 * API: failures say what happened and offer a retry, hidden results can be
 * shown, bangs from the address bar redirect, overlays manage focus, menus
 * take the keyboard, and the results page has structure a screen reader can use.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankedSearchResponse } from '../src/core/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
}
Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
window.matchMedia ||= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
window.scrollTo = () => undefined;
Element.prototype.scrollIntoView = () => undefined;
(globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };

const { App } = await import('../src/client/App.js');

const row = (i: number, extra: object = {}) => ({
  id: `r${i}`, title: `Result ${i}`, url: `https://site${i}.example/page`, snippet: `Snippet ${i}`, source: 'web', domain: `site${i}.example`,
  rootDomain: `site${i}.example`, tld: 'example', slopScore: 5, authenticityScore: 70, relevanceScore: 80, netScore: 80, verdict: 'clean',
  signals: [], isPreLlm: false, isIndieWeb: true, isPrimarySource: false, isSponsored: false, isBigTechMonoculture: false, ...extra,
});
type Timing = { ms: number; count: number; status: string; note?: string };
let reply: (query: string) => Response | Promise<Response>;
const answer = (query: string, results = [row(1), row(2), row(3)], hidden: object[] = [], timings: Record<string, Timing> = { wiki: { ms: 100, count: 3, status: 'ok' } }) =>
  new Response(
    JSON.stringify({
      query, lens: 'all', uncensoredMode: false,
      compiledQuery: { rawQuery: query, cleanedTokens: [], lens: 'all', synthesizedQuery: query, negativeSiteOperators: [], positiveOperators: [], escapeUrls: [] },
      results, p2pResults: [], filteredSlop: hidden,
      metrics: { durationMs: 100, filteredSlopCount: hidden.length, sourceTimings: timings },
    } as unknown as RankedSearchResponse),
    { headers: { 'Content-Type': 'application/json' } }
  );
let searches = 0;
let inspected: string[] = [];
let crawlStarted = false;

function installApi() {
  searches = 0;
  inspected = [];
  crawlStarted = false;
  reply = (q) => answer(q);
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/plugins':
        return json({ plugins: [], userDir: '/tmp' });
      case 'GET /api/auth':
        return json({ required: false, authenticated: true });
      case 'GET /api/directory':
        return json({ items: [] });
      case 'GET /api/deep':
        return json({ available: true, crawling: crawlStarted, posts: 0, byKind: [] });
      case 'POST /api/deep/crawl':
        crawlStarted = true;
        return json({ available: true, crawling: true });
      case 'GET /api/deep/sites':
        return json({ available: true, total: 1, counts: { blog: 43000 }, items: [{ id: 1, url: 'https://tiny.example/feed', kind: 'blog', site: 'tiny.example', origin: 'smallweb', title: 'Tiny', nsfw: 0, posts: 0, status: null, fetched_at: null }], origins: [], errors: [] });
      case 'POST /api/inspect':
        inspected.push(body.url);
        return json({ url: body.url, title: `Page ${body.url}`, domain: 'x', verdict: 'clean', slopScore: 0, authenticityScore: 90, signals: [], hasRssFeed: false, hasIndieWebMarkers: false, stats: { estimatedCleanReadMinutes: 1, bloatReductionPercent: 0, totalScriptsRemoved: 0, fluffPreambleParagraphs: 0 }, coreTakeaway: '', primarySources: [], sections: [{ id: 's', tag: 'p', text: `Text of ${body.url}`, isFluffPreamble: false, isCoreAnswer: false, wordCount: 3, fluffTriggers: [] }], links: [] });
      case 'POST /api/search':
        searches += 1;
        return reply(body.query);
      default:
        return json({ error: `unscripted ${method} ${url.pathname}` }, 404);
    }
  });
}

let root: Root;
let container: HTMLDivElement;
async function flush(times = 5) {
  for (let i = 0; i < times; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function render(path = '/') {
  window.history.replaceState({}, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
  await flush();
}
const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const byText = (sel: string, text: string) => $$(sel).find((el) => el.textContent?.trim() === text);
async function click(el: Element | undefined | null) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}
async function key(k: string, target: EventTarget = window, opts: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
  });
  await flush(2);
}
async function search(q = 'rust borrow checker') {
  const input = $<HTMLInputElement>('input[aria-label="Search"]')!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, q);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
  (document.activeElement as HTMLElement | null)?.blur();
}

beforeEach(async () => {
  localStorage.clear();
  installApi();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('when a search can\'t run', () => {
  it('says glogg couldn\'t be reached, and Try again searches again', async () => {
    reply = () => {
      throw new TypeError('Failed to fetch');
    };
    await render();
    await search();
    expect($('.search-problem')?.textContent).toContain("Couldn't reach glogg. Check your connection, then try again.");
    reply = (q) => answer(q);
    await click(byText('button', 'Try again'));
    expect(searches).toBe(2);
    expect($$('article.result')).toHaveLength(3);
  });

  it('tells "no source answered" apart from "nothing matched"', async () => {
    reply = (q) => answer(q, [], [], { wiki: { ms: 4000, count: 0, status: 'error' }, se: { ms: 7000, count: 0, status: 'late' } });
    await render();
    await search();
    expect($('.search-problem')?.textContent).toContain('None of the sources answered');
    reply = (q) => answer(q, [], [], { wiki: { ms: 100, count: 0, status: 'empty' } });
    await search('something else');
    expect($('.search-problem')).toBeNull();
    expect($('.empty')?.textContent).toContain('No results for “something else”');
  });

  it('counts sources that turned glogg away as not answering', async () => {
    reply = (q) =>
      answer(q, [], [], {
        ddg: { ms: 80, count: 0, status: 'refused', note: 'Asked for a bot check. Tries again in 1 min.' },
        searxng: { ms: 1, count: 0, status: 'unset', note: 'Nothing answers at localhost:8080.' },
      });
    await render();
    await search();
    expect($('.search-problem')?.textContent).toContain('None of the sources answered');
  });

  it('the status bar says which sources turned glogg away and why, and leaves out ones not set up', async () => {
    reply = (q) =>
      answer(q, [row(1)], [], {
        wiki: { ms: 100, count: 1, status: 'ok' },
        brave: { ms: 300, count: 0, status: 'refused', note: 'Asked for a captcha. Tries again in 5 min.' },
        searxng: { ms: 2, count: 0, status: 'unset', note: 'Nothing answers at localhost:8080.' },
      });
    await render();
    await search();
    const summary = $$('.statusbar button').find((b) => b.textContent?.includes('sources'))!;
    expect(summary.textContent).toContain('1/2 sources');
    expect(summary.textContent).toContain('1 turned away');
    await click(summary);
    const rows = $$('.sb-pop .sb-row').map((r) => r.textContent);
    expect(rows.find((r) => r?.includes('Brave'))).toContain('turned away');
    expect(rows.find((r) => r?.includes('SearXNG'))).toContain('not set up');
    expect($$('.sb-pop .sb-note').map((n) => n.textContent)).toEqual(['Asked for a captcha. Tries again in 5 min.', 'Nothing answers at localhost:8080.']);
  });

  it('on a phone, the results line opens the same breakdown, since phones have no status bar', async () => {
    reply = (q) =>
      answer(q, [row(1)], [], {
        wiki: { ms: 100, count: 1, status: 'ok' },
        brave: { ms: 300, count: 0, status: 'refused', note: 'Asked for a captcha. Tries again in 5 min.' },
      });
    await render();
    await search();
    const button = $('.sources-btn button')!;
    expect(button.textContent).toBe('1/2 sources');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect($('.sb-sheet[role="dialog"]')?.getAttribute('aria-label')).toBe('Sources');
    expect($$('.sb-sheet .sb-note').map((n) => n.textContent)).toEqual(['Asked for a captcha. Tries again in 5 min.']);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect($('.sb-sheet')).toBeNull();
  });

  it('the status bar counts failed sources apart from late ones', async () => {
    reply = (q) => answer(q, [row(1)], [], { wiki: { ms: 100, count: 1, status: 'ok' }, se: { ms: 4000, count: 0, status: 'error' }, hn: { ms: 7000, count: 0, status: 'late' } });
    await render();
    await search();
    const bar = $('.statusbar')!.textContent!;
    expect(bar).toContain('1/3 sources');
    expect(bar).toContain('1 failed');
    expect(bar).toContain('1 late');
  });
});

describe('hidden results', () => {
  it('can be shown anyway, and join the list', async () => {
    reply = (q) => answer(q, [row(1)], [row(9, { demotedReason: "Doesn't seem to be about your search" })]);
    await render();
    await search();
    await click($('button.more-toggle'));
    expect($('.filtered-row .why')?.textContent).toBe("Doesn't seem to be about your search");
    await click($('.filtered-row button[aria-label="Show Result 9 anyway"]'));
    expect($$('article.result a.result-title').map((a) => a.textContent)).toEqual(['Result 1', 'Result 9']);
  });
});

describe('bangs from the address bar', () => {
  it('go there in this tab, since a new one would be blocked as a popup', async () => {
    const replace = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const real = window.location;
    Object.defineProperty(window, 'location', { value: { ...real, pathname: '/', search: '?q=!w%20turing', href: 'http://localhost/?q=!w%20turing', replace }, configurable: true });
    try {
      await render('/?q=!w%20turing');
      expect(replace).toHaveBeenCalledWith('https://en.wikipedia.org/w/index.php?search=turing');
      expect(open).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { value: real, configurable: true });
      open.mockRestore();
    }
  });
});

describe('the reader', () => {
  it('is modal: focus goes in, Escape closes, and focus comes back to the Read button', async () => {
    await render();
    await search();
    const read = $<HTMLButtonElement>('button[aria-label="Read Result 1"]')!;
    read.focus();
    await click(read);
    const sheet = $('[role="dialog"][aria-label="Reader"]')!;
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(sheet.contains(document.activeElement)).toBe(true);
    await key('Escape');
    expect($('[role="dialog"][aria-label="Reader"]')).toBeNull();
    expect(document.activeElement).toBe(read);
  });

  it('steps to the next and previous result without closing', async () => {
    await render();
    await search();
    await click($('button[aria-label="Read Result 1"]'));
    await key('j');
    await flush();
    expect(inspected.at(-1)).toBe('https://site2.example/page');
    expect($('[role="dialog"][aria-label="Reader"]')?.textContent).toContain('Text of https://site2.example/page');
    await click($('button[aria-label="Previous result (k)"]'));
    expect(inspected.at(-1)).toBe('https://site1.example/page');
  });
});

describe('a result\'s menu', () => {
  it('takes the keyboard: arrows move in it, Escape closes it and returns to its button', async () => {
    await render();
    await search();
    const button = $<HTMLButtonElement>('button[aria-label="More actions for Result 1"]')!;
    await click(button);
    const items = $$('[role="menu"] [role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    await key('ArrowDown', document.activeElement!);
    expect(document.activeElement).toBe(items[1]);
    // The result selection didn't move with it.
    expect($$('article.result')[0].getAttribute('aria-current')).toBe('true');
    await key('Escape', document.activeElement!);
    expect($('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('results for screen readers', () => {
  it('a heading for the page, a list of results with headed titles, and the selected scope marked', async () => {
    await render();
    await search();
    expect($('h1.sr-only')?.textContent).toBe('Results for “rust borrow checker”');
    const list = $('[role="list"]')!;
    expect(list.getAttribute('aria-label')).toBe('3 results');
    expect([...list.children].every((c) => c.getAttribute('role') === 'listitem')).toBe(true);
    expect($$('article.result h2 a.result-title')).toHaveLength(3);
    expect($$('nav.scopes button[aria-pressed="true"]').map((b) => b.textContent)).toEqual(['All']);
    expect(new Set($$('button[aria-label^="More actions for"]').map((b) => b.getAttribute('aria-label'))).size).toBe(3);
  });

  it('moving with j says where you are', async () => {
    await render();
    await search();
    await key('j');
    expect($('[aria-live="polite"].sr-only')?.textContent).toBe('2 of 3: Result 2, site2.example');
  });
});

describe('palette and home', () => {
  it('the palette input is labelled, points at the highlighted command, and each group shows once', async () => {
    await render();
    await key('k', window, { ctrlKey: true });
    const input = $<HTMLInputElement>('[role="dialog"][aria-label="Command palette"] input')!;
    expect(input.getAttribute('aria-label')).toBe('Search or type a command');
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)).toBeTruthy();
    const groups = $$('.palette-group').map((g) => g.textContent);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('the home hints do what they say', async () => {
    await render();
    await click(byText('.home-hint button', '? all shortcuts'));
    expect($('.shortcuts[role="dialog"]')).toBeTruthy();
  });
});

describe('a first visit to the Atlas', () => {
  it('says nothing is indexed yet and offers to build it right there', async () => {
    await render('/atlas?tab=blog');
    await flush();
    expect($('.atlas-first-run')?.textContent).toContain('None of these are in your deep index yet');
    await click(byText('.atlas-first-run button', 'Build the deep index'));
    expect(crawlStarted).toBe(true);
    expect($('.atlas-first-run')).toBeNull();
  });
});
