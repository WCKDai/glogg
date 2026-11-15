// @vitest-environment jsdom
/**
 * The real App in jsdom against a scripted API: the main flows end to end,
 * plus basic accessibility. No server, no network.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginInfo, RankedSearchResponse } from '../src/core/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom gaps. Node 26 ships its own global localStorage (undefined without
// --localstorage-file) that shadows jsdom's, so give the tests a simple one.
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
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => undefined }, configurable: true });

const { App } = await import('../src/client/App.js');

const PLUGINS: PluginInfo[] = [
  {
    id: 'utils', name: 'Utilities', description: 'Local helpers', category: 'utility', source: 'builtin', configured: true, hasRunner: true,
    tools: [{ id: 'hash', name: 'Hash', description: 'Hashes text', trigger: 'hash', inputs: [{ key: 'text', label: 'Text', type: 'textarea', required: true }] }],
  },
  {
    id: 'osint', name: 'OSINT', description: 'Lookups', category: 'osint', source: 'builtin', configured: true, hasRunner: true,
    tools: [{ id: 'dns', name: 'DNS records', description: 'DNS', trigger: 'dns', inputs: [{ key: 'domain', label: 'Domain', required: true }] }],
  },
  {
    id: 'ai', name: 'AI', description: 'BYOK', category: 'ai', source: 'builtin', configured: false, hasRunner: true, values: { provider: 'none' },
    settings: [{ key: 'provider', label: 'Provider', type: 'select', options: [{ value: 'none', label: 'Off' }, { value: 'ollama', label: 'Ollama (local)' }] }],
    tools: [{ id: 'test', name: 'Test connection', description: 'Ping the model', inputs: [], requiresSettings: true }],
  },
];

const result = (i: number, extra: object = {}) => ({
  id: `r${i}`, title: `Result ${i}`, url: `https://site${i}.example/page`, snippet: `Snippet ${i}`, source: 'web', domain: `site${i}.example`,
  rootDomain: `site${i}.example`, tld: 'example', slopScore: 5, authenticityScore: 70, relevanceScore: 80, netScore: 80, verdict: 'clean',
  signals: [], isPreLlm: false, isIndieWeb: true, isPrimarySource: false, isSponsored: false, isBigTechMonoculture: false, ...extra,
});

function searchResponse(query: string): RankedSearchResponse {
  return {
    query, lens: 'all', uncensoredMode: false,
    compiledQuery: { rawQuery: query, cleanedTokens: [], lens: 'all', synthesizedQuery: query, negativeSiteOperators: [], positiveOperators: [], escapeUrls: [] },
    results: [result(1), result(2, { p2p: { protocol: 'bittorrent-dht', magnetUri: 'magnet:?xt=urn:btih:abc', sizeFormatted: '1 GB', indexerName: 'DHT' } }), result(3)],
    p2pResults: [], filteredSlop: [],
    metrics: {
      durationMs: 420,
      sourceTimings: {
        wiki: { ms: 310, count: 6, status: 'ok' },
        se: { ms: 280, count: 4, status: 'empty' },
        marginalia: { ms: 1000, count: 0, status: 'late' },
        gdelt: { ms: 0, count: 0, status: 'resting' },
      },
    },
  } as unknown as RankedSearchResponse;
}

const RESEARCH_STREAM = [
  { type: 'status', stage: 'reading', detail: 'Reading 2 sources' },
  { type: 'sources', sources: [{ index: 1, title: 'Result 1', url: 'https://site1.example/page', domain: 'site1.example', read: true, passages: ['x'] }] },
  { type: 'delta', text: 'The answer is ' },
  { type: 'delta', text: 'here [1].' },
  { type: 'done', mode: 'extractive', durationMs: 900 },
];

let calls: { method: string; path: string; search: string; body?: unknown }[] = [];
let deepCrawling = false;
let passwordProtected = false;

function installApi() {
  calls = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/capabilities':
        return json({ mode: 'private', features: { tools: true, research: true, downloads: true, administration: true, savedProfiles: true } });
      case 'GET /api/plugins':
        return json({ plugins: PLUGINS, userDir: '/home/me/.glogg/plugins' });
      case 'GET /api/downloads':
        return json({
          config: {}, jobs: [],
          integrations: { offcloudConfigured: false, nzbLifeConfigured: false, nextcloudConfigured: false, aria2Reachable: false, localDownloadsDir: '/tmp' },
          pluginTargets: [{ id: 'plugin:realdebrid', pluginId: 'realdebrid', label: 'Real-Debrid', accepts: ['magnet', 'link'], configured: true }],
        });
      case 'POST /api/plugins/utils/tools/hash':
        return json({ blocks: [{ type: 'kv', items: [{ label: 'SHA256', value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] }] });
      case 'POST /api/search':
        return json(searchResponse(body.query));
      case 'GET /api/deep':
        return json({ available: true, crawling: deepCrawling, active: 0, posts: 1234, bytes: 2_000_000, byKind: [{ kind: 'blog', sources: 43470, visited: 120, failing: 2, posts: 1100 }, { kind: 'board', sources: 90, visited: 12, failing: 0, posts: 134 }] });
      case 'POST /api/deep/crawl':
        deepCrawling = body.action === 'start';
        return json({ available: true, crawling: deepCrawling });
      case 'GET /api/deep/sites':
        return json({
          available: true,
          total: 2,
          counts: { blog: 43470, site: 962, board: 90, forum: 34 },
          items: [
            { id: 1, url: 'https://tiny.example/feed.xml', kind: 'blog', site: 'tiny.example', origin: 'smallweb', title: 'Tiny Blog', nsfw: 0, posts: 12, status: 'ok', fetched_at: Date.now() },
            { id: 2, url: 'https://other.example/rss', kind: 'blog', site: 'other.example', origin: 'smallweb', title: null, nsfw: 0, posts: 0, status: null, fetched_at: null },
          ],
          origins:
            url.searchParams.get('kind') === 'forum'
              ? [
                  { origin: 'lemmy', sources: 9828 },
                  { origin: 'discourse', sources: 947 },
                  { origin: 'stackexchange', sources: 100 },
                ]
              : [],
          errors: [],
        });
      case 'POST /api/deep/sources':
        return json({ source: { kind: 'blog', url: body.url } });
      case 'GET /api/auth':
        return json({ required: passwordProtected, authenticated: false });
      case 'GET /api/directory':
        return json({ items: [{ title: 'Marginalia Search', url: 'https://marginalia-search.com', domain: 'marginalia-search.com', category: 'search-engines', description: 'Small-web search', tags: ['search'] }] });
      case 'POST /api/auth/login':
        return json({ error: 'Wrong password.' }, 401);
      case 'POST /api/research':
        return new Response(RESEARCH_STREAM.map((e) => JSON.stringify(e)).join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } });
      default:
        return json({ error: `unscripted ${method} ${url.pathname}` }, 404);
    }
  });
}

let root: Root;
let container: HTMLDivElement;

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
  await flush();
}

async function flush(times = 5) {
  for (let i = 0; i < times; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

async function until(check: () => unknown, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await flush(1);
  }
  throw new Error(`Timed out waiting for: ${check.toString()}`);
}

const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const byText = (sel: string, text: string) => $$(sel).find((el) => el.textContent?.includes(text));

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(input: HTMLInputElement) {
  await act(async () => {
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function click(el: Element | undefined | null) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

function unlabeledIconButtons(): string[] {
  return $$('button')
    .filter((b) => !b.textContent?.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'))
    .map((b) => b.outerHTML.slice(0, 120));
}

beforeEach(async () => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  installApi();
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('home', () => {
  it('shows the search box, the view switch and labelled controls', () => {
    expect($('input[aria-label="Search"]')).toBeTruthy();
    expect($$('[role="radiogroup"][aria-label="View"] [role="radio"]').map((b) => b.textContent)).toEqual(['Simple', 'Advanced']);
    expect(unlabeledIconButtons()).toEqual([]);
  });

  it('names every section in the nav, with words, and marks where you are', async () => {
    expect($$('.appnav-btn').map((b) => b.textContent?.trim())).toEqual(['Search', 'Saved', 'Sources', 'Atlas', 'More', 'Tools', 'Downloads', 'Services', 'Settings']);
    expect($('.appnav-btn[aria-current="page"]')!.textContent).toBe('Search');
    await click($('a[aria-label="Atlas"]'));
    expect($('.appnav-btn[aria-current="page"]')!.textContent).toBe('Atlas');
    expect($$('.appnav-btn[aria-current="page"]')).toHaveLength(1);
  });
});

describe('tools from the search box', () => {
  it('suggests tools after ">" and runs one inline', async () => {
    const box = $<HTMLInputElement>('input[aria-label="Search"]')!;
    await type(box, '>ha');
    expect(byText('[role="listbox"][aria-label="Tools"] li', '>hash')).toBeTruthy();
    await type(box, '>hash abc');
    await submit(box);
    await until(() => byText('.toolcard', 'ba7816bf'));
    expect(calls.find((c) => c.path === '/api/plugins/utils/tools/hash')?.body).toEqual({ input: { text: 'abc' } });
    expect(window.location.search).toBe(`?q=${encodeURIComponent('>hash abc')}`);
  });

  it('lists the available tools when a trigger is unknown', async () => {
    const box = $<HTMLInputElement>('input[aria-label="Search"]')!;
    await type(box, '>nope example.com');
    await submit(box);
    await until(() => byText('.toolcard', 'No tool uses >nope'));
    expect($$('.toolcard-suggest .chip').map((c) => c.textContent)).toEqual(expect.arrayContaining(['>hash Hash', '>dns DNS records']));
  });
});

describe('search and research', () => {
  async function searchFor(q: string) {
    const box = $<HTMLInputElement>('input[aria-label="Search"]')!;
    await type(box, q);
    await submit(box);
    await until(() => $$('.result').length === 3);
  }

  it('shows results in the simple view with a way to dig deeper', async () => {
    await searchFor('rust borrow checker');
    expect($('.rail')).toBeNull();
    expect(byText('button', 'Dig deeper')).toBeTruthy();
    expect(unlabeledIconButtons()).toEqual([]);
  });

  it('digs deeper into a cited answer with its sources', async () => {
    await searchFor('rust borrow checker');
    await click(byText('button', 'Dig deeper'));
    await until(() => byText('.research-answer', 'The answer is here'));
    expect($('.rail')).toBeTruthy();
    expect($<HTMLAnchorElement>('.research-answer a.cite-ref')?.href).toBe('https://site1.example/page');
    const research = calls.find((c) => c.path === '/api/research')!.body as { query: string; candidates: { url: string }[] };
    expect(research.query).toBe('rust borrow checker');
    expect(research.candidates.map((c) => c.url)).toContain('https://site1.example/page');
    expect(JSON.parse(localStorage.getItem('glogg.mode')!)).toBe('advanced');
    expect(unlabeledIconButtons()).toEqual([]);
  });

  it('sends earlier turns with a follow-up question', async () => {
    await searchFor('rust borrow checker');
    await click(byText('button', 'Dig deeper'));
    await until(() => $('.research-follow input'));
    const follow = $<HTMLInputElement>('.research-follow input')!;
    await type(follow, 'and lifetimes?');
    await submit(follow);
    await until(() => calls.filter((c) => c.path === '/api/research').length === 2);
    const second = calls.filter((c) => c.path === '/api/research')[1].body as { query: string; history: { query: string; answer: string }[] };
    expect(second.query).toBe('and lifetimes?');
    expect(second.history).toEqual([{ query: 'rust borrow checker', answer: 'The answer is here [1].' }]);
    await until(() => $$('.research-turn').length === 2);
  });

  it('toggles the view with the m key', async () => {
    await searchFor('rust borrow checker');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    });
    await flush();
    expect(JSON.parse(localStorage.getItem('glogg.mode')!)).toBe('advanced');
    expect($('.rail')).toBeTruthy();
  });

  it('offers configured plugins as download destinations', async () => {
    await searchFor('debian iso');
    await until(() => calls.some((c) => c.path === '/api/downloads'));
    await click($('.result button[aria-label="Choose destination"]'));
    expect($$('.menu [role="menuitem"]').map((m) => m.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Real-Debrid')]));
  });
});

describe('start screen and status bar', () => {
  it('offers quick-launch tools that prefill the search box', async () => {
    await until(() => byText('.home-panel[aria-label="Tools"] .home-item', '>hash'));
    await click(byText('.home-panel[aria-label="Tools"] .home-item', '>hash'));
    await flush();
    expect($<HTMLInputElement>('input[aria-label="Search"]')!.value).toBe('>hash ');
  });

  it('remembers searches and replays them from Recent', async () => {
    const box = $<HTMLInputElement>('input[aria-label="Search"]')!;
    await type(box, 'rust borrow checker');
    await submit(box);
    await until(() => $$('.result').length === 3);
    expect(JSON.parse(localStorage.getItem('glogg.history')!)).toEqual(['rust borrow checker']);
    await click($('button[aria-label="glogg home"]'));
    await until(() => byText('.home-panel[aria-label="Recent searches"] .home-item', 'rust borrow checker'));
    const before = calls.filter((c) => c.path === '/api/search').length;
    await click(byText('.home-panel[aria-label="Recent searches"] .home-item', 'rust borrow checker'));
    await until(() => calls.filter((c) => c.path === '/api/search').length === before + 1);
  });

  it('shows which sources answered and how fast', async () => {
    const box = $<HTMLInputElement>('input[aria-label="Search"]')!;
    await type(box, 'rust borrow checker');
    await submit(box);
    await until(() => byText('.statusbar button', 'sources'));
    expect(byText('.statusbar button', 'sources')!.textContent).toContain('2/4 sources');
    expect(byText('.statusbar button', 'sources')!.textContent).toContain('1 late');
    await click(byText('.statusbar button', 'sources'));
    const rows = $$('.sb-pop .sb-row').map((r) => r.textContent);
    // The one that didn't answer comes first, since it's why the count is short; then the rest by speed.
    const names = ['Marginalia', 'Stack Exchange', 'Wikipedia', 'GDELT news'];
    expect(rows.map((r) => names.find((n) => r?.includes(n)))).toEqual(['Marginalia', 'Wikipedia', 'Stack Exchange', 'GDELT news']);
    expect(rows[0]).toContain('late');
    expect(rows[3]).toContain('resting');
  });
});

describe('command palette', () => {
  const press = async (key: string, mods: KeyboardEventInit = {}) =>
    act(async () => {
      (document.activeElement || window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...mods }));
    });

  it('opens with ⌘K from anywhere, even while typing in the search box, and closes with Escape', async () => {
    $<HTMLInputElement>('input[aria-label="Search"]')!.focus();
    await press('k', { metaKey: true });
    await flush();
    expect($('.palette')).toBeTruthy();
    expect(document.activeElement?.closest('.palette')).toBeTruthy();
    await press('Escape');
    await flush();
    expect($('.palette')).toBeNull();
  });

  it('opens with Ctrl+K too, filters as you type, and runs the highlighted command with Enter', async () => {
    await press('k', { ctrlKey: true });
    await flush();
    const input = $<HTMLInputElement>('.palette input')!;
    await type(input, 'hash');
    expect($$('.palette-list li[role="option"]').some((li) => li.textContent?.includes('Hash'))).toBe(true);
    const target = $$('.palette-list li[role="option"]').findIndex((li) => li.textContent?.includes('>hash'));
    for (let i = 0; i < target; i++) await press('ArrowDown');
    await press('Enter');
    await flush();
    expect($('.palette')).toBeNull();
    expect($<HTMLInputElement>('input[aria-label="Search"]')!.value).toBe('>hash ');
  });
});

describe('atlas', () => {
  it('shows the open directories with counts and lets you browse them', async () => {
    deepCrawling = false;
    await click($('a[aria-label="Atlas"]'));
    await until(() => $('.atlas-page'));
    await click(byText('[role="tab"]', 'Blogs'));
    await until(() => $$('.dir-row').length === 2);
    expect($('.atlas-page .page-head p')!.textContent).toContain('43,470 blogs');
    expect($$('.dir-row')[0].textContent).toContain('Tiny Blog');
    expect($$('.dir-row')[1].textContent).toContain('not crawled');
    expect(calls.find((c) => c.path === '/api/deep/sites')).toBeTruthy();
  });

  it('starts the deep index only when asked', async () => {
    deepCrawling = false;
    await click($('a[aria-label="Atlas"]'));
    await click(byText('[role="tab"]', 'Deep index'));
    await until(() => byText('button', 'Resume crawling') || byText('button', 'Build the deep index'));
    expect(calls.some((c) => c.path === '/api/deep/crawl')).toBe(false);
    await click(byText('button', 'Resume crawling') || byText('button', 'Build the deep index'));
    await until(() => calls.some((c) => c.path === '/api/deep/crawl'));
    expect(calls.find((c) => c.path === '/api/deep/crawl')!.body).toEqual({ action: 'start' });
    await until(() => byText('button', 'Pause'));
    expect(unlabeledIconButtons()).toEqual([]);
  });

  it('filters a directory by where its sources came from', async () => {
    await click($('a[aria-label="Atlas"]'));
    await click(byText('[role="tab"]', 'Forums'));
    await until(() => byText('.chips button', 'Lemmy'));
    expect(byText('.chips button', 'Stack Exchange')!.textContent).toContain('100');
    await click(byText('.chips button', 'Lemmy'));
    await until(() => calls.some((c) => c.path === '/api/deep/sites' && c.search.includes('origin=lemmy')));
    expect(byText('.chips button', 'Lemmy')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('offers an 18+ flag for added sources only in 18+ mode', async () => {
    const addFrom = async () => {
      await click($('a[aria-label="Atlas"]'));
      await click(byText('[role="tab"]', 'Deep index'));
      await until(() => $('#deep-add'));
    };
    await addFrom();
    expect($('.check-row')).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    localStorage.setItem('glogg.uncensored', 'true');
    await render();
    await addFrom();
    await click($('.check-row input'));
    await type($<HTMLInputElement>('#deep-add')!, 'late.example/feed.xml');
    await submit($<HTMLInputElement>('#deep-add')!);
    await until(() => calls.some((c) => c.path === '/api/deep/sources'));
    expect(calls.find((c) => c.path === '/api/deep/sources')!.body).toEqual({ url: 'late.example/feed.xml', nsfw: true });
  });
});

describe('sections have addresses', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('puts each section in the URL and the tab title, and Back returns to the last one', async () => {
    const atlas = $<HTMLAnchorElement>('a[aria-label="Atlas"]')!;
    expect(atlas.getAttribute('href')).toBe('/atlas');
    await click(atlas);
    await until(() => $('.atlas-page'));
    expect(window.location.pathname).toBe('/atlas');
    expect(document.title).toBe('Atlas — glogg');

    await click($('a[aria-label="Tools"]'));
    expect(window.location.pathname).toBe('/tools');
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    await until(() => $('.atlas-page'));
    expect(document.title).toBe('Atlas — glogg');
  });

  it('opens straight into a section from its address, and keeps the Atlas tab there', async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/atlas?tab=forum');
    await render();
    await until(() => $('.atlas-page'));
    expect($('[role="tab"][aria-selected="true"]')!.textContent).toContain('Forums');
    await click(byText('[role="tab"]', 'Boards'));
    expect(window.location.search).toBe('?tab=board');
  });

  it('leaves ⌘-click and middle-click to the browser, so a section opens in a new tab', async () => {
    // Runs after glogg's own handler: records whether glogg took the click over, then stops jsdom navigating.
    const takenOver: boolean[] = [];
    const browser = (e: Event) => {
      takenOver.push(e.defaultPrevented);
      e.preventDefault();
    };
    window.addEventListener('click', browser);
    try {
      await act(async () => {
        $('a[aria-label="Settings"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
      });
    } finally {
      window.removeEventListener('click', browser);
    }
    expect(takenOver).toEqual([false]);
    expect(window.location.pathname).toBe('/');
  });
});

describe('keyboard shortcuts', () => {
  it('lists every shortcut on "?", and closes on Escape', async () => {
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    });
    await until(() => $('.shortcuts'));
    expect($$('.shortcuts dd').map((d) => d.textContent)).toContain('Command palette');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect($('.shortcuts')).toBeNull();
  });
});

describe('18+ mode', () => {
  const stored = () => localStorage.getItem('glogg.uncensored');

  it('has no one-click switch anywhere, so a stray click cannot turn it on', async () => {
    expect($('.adult-pill')).toBeNull();
    expect($$('button').some((b) => /18\+/.test(b.textContent || '') || /18\+/.test(b.getAttribute('aria-label') || ''))).toBe(false);
  });

  it('turns on only after confirming in Settings, and off again with one click', async () => {
    await click($('a[aria-label="Settings"]'));
    // Matched in code: jsdom's selector engine misreads the "+" inside [aria-label="18+ mode"].
    const toggle = () => $$('button[role="switch"]').find((b) => b.getAttribute('aria-label') === '18+ mode');
    await until(toggle);

    await click(toggle());
    expect($('.adult-confirm')).toBeTruthy();
    expect(stored()).toBe('false');
    await click(byText('.adult-confirm button', 'Cancel'));
    expect($('.adult-confirm')).toBeNull();
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');

    await click(toggle());
    await click(byText('.adult-confirm button', "I'm 18 or older"));
    expect(stored()).toBe('true');
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    expect($('.adult-pill')).toBeTruthy();

    await click($('.adult-pill'));
    expect(stored()).toBe('false');
    expect($('.adult-pill')).toBeNull();
  });

  it('is reached from the command palette through Settings, never switched on directly', async () => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    });
    await flush();
    await type($<HTMLInputElement>('.palette input')!, '18+');
    const options = $$('.palette-list li[role="option"]');
    const target = options.findIndex((li) => li.textContent?.includes('18+ mode (in Settings)'));
    expect(target).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < target; i++) {
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
    }
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await until(() => $('#settings-adult'));
    expect(stored()).toBe('false');
    expect($('.adult-pill')).toBeNull();
  });
});

describe('password-protected glogg', () => {
  afterEach(() => {
    passwordProtected = false;
  });

  it('asks for the password over everything, and says when it is wrong', async () => {
    expect($('.signin')).toBeNull();
    await act(async () => root.unmount());
    container.remove();
    passwordProtected = true;
    await render();
    await until(() => $('.signin'));
    expect($('.signin')!.getAttribute('aria-modal')).toBe('true');
    await type($<HTMLInputElement>('.signin input[type="password"]')!, 'hunter2');
    await submit($<HTMLInputElement>('.signin input[type="password"]')!);
    await until(() => $('.signin-error'));
    expect($('.signin-error')!.textContent).toBe('Wrong password.');
    expect(calls.find((c) => c.path === '/api/auth/login')!.body).toEqual({ password: 'hunter2' });
    expect($('.signin')).toBeTruthy();
  });
});

describe('tools page', () => {
  it('opens on a tool that works without setup', async () => {
    await click($('a[aria-label="Tools"]'));
    await until(() => $('.tools-main h2'));
    expect($('.tools-main h2')?.textContent).toBe('OSINT');
    expect($$('.tools-item').find((b) => b.textContent?.includes('AI'))?.querySelector('.dot.warn')).toBeTruthy();
    expect(unlabeledIconButtons()).toEqual([]);
  });
});
