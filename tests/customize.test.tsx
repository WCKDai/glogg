// @vitest-environment jsdom
/**
 * Customization, in the real App against a scripted API: every setting reaches
 * the search it should change, or the page it should change, and your settings
 * travel as a file or through this glogg.
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
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => undefined }, configurable: true });

const { App } = await import('../src/client/App.js');
const { applyProfile, readProfile, PROFILE_KEYS, withDomainRule, cleanDomain } = await import('../src/client/lib.js');

const row = (i: number) => ({
  id: `r${i}`, title: `Result ${i}`, url: `https://site${i}.example/page`, snippet: `Snippet ${i}`, source: 'web', domain: `site${i}.example`,
  rootDomain: `site${i}.example`, tld: 'example', slopScore: 5, authenticityScore: 70, relevanceScore: 80, netScore: 80, verdict: 'clean',
  signals: [], isPreLlm: false, isIndieWeb: true, isPrimarySource: false, isSponsored: false, isBigTechMonoculture: false,
});
const response = (query: string) =>
  ({
    query, lens: 'all', uncensoredMode: false,
    compiledQuery: { rawQuery: query, cleanedTokens: [], lens: 'all', synthesizedQuery: query, negativeSiteOperators: [], positiveOperators: [], escapeUrls: [] },
    results: [row(1), row(2), row(3)], p2pResults: [], filteredSlop: [],
    metrics: { durationMs: 100, filteredSlopCount: 0, sourceTimings: { wiki: { ms: 100, count: 3, status: 'ok' } } },
  }) as unknown as RankedSearchResponse;

let searches: { query: string; compact?: boolean; config: Record<string, unknown> }[] = [];
let savedProfile: unknown = null;

function installApi() {
  searches = [];
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
      case 'GET /api/integrations':
        return json({ config: {} });
      case 'GET /api/profile':
        return savedProfile ? json(savedProfile) : json({ error: 'No settings saved on this glogg yet.' }, 404);
      case 'PUT /api/profile':
        savedProfile = { savedAt: '2026-11-10T12:00:00.000Z', settings: body.settings };
        return json(savedProfile);
      case 'POST /api/search':
        searches.push(body);
        return json(response(body.query));
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

async function unmount() {
  await act(async () => root.unmount());
  container.remove();
}

const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const byText = (sel: string, text: string) => $$(sel).find((el) => el.textContent?.trim() === text || el.getAttribute('aria-label') === text);
const setting = (label: string) => $$('.setting').find((s) => s.querySelector('.setting-label')?.textContent?.trim() === label);

async function click(el: Element | undefined | null) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function type(input: HTMLInputElement | null, value: string) {
  expect(input).toBeTruthy();
  await act(async () => {
    input!.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(input: HTMLInputElement | null) {
  await act(async () => {
    input!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function key(k: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
  await flush(2);
}

async function search(q = 'rust borrow checker') {
  await type($<HTMLInputElement>('input[aria-label="Search"]'), q);
  await submit($<HTMLInputElement>('input[aria-label="Search"]'));
  return searches[searches.length - 1];
}

const stored = <T,>(k: string): T => JSON.parse(localStorage.getItem(k) || 'null') as T;

beforeEach(async () => {
  localStorage.clear();
  savedProfile = null;
  installApi();
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.classList.remove('dark', 'light');
});

describe('settings page', () => {
  it('has an index that names every section, and every section is there', async () => {
    await render('/settings');
    const links = $$('.settings-index a').map((a) => a.getAttribute('href'));
    expect(links.length).toBeGreaterThanOrEqual(10);
    for (const href of links) expect($(href!), `${href} exists`).toBeTruthy();
  });

  it('labels every control', async () => {
    await render('/settings');
    const unnamed = $$('button, input, select').filter((el) => {
      if ((el as HTMLInputElement).type === 'file') return false;
      const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent?.trim() || el.closest('label');
      return !labelled;
    });
    expect(unnamed.map((el) => el.outerHTML.slice(0, 100))).toEqual([]);
  });
});

describe('each setting reaches the search', () => {
  it('a source you turn off is not asked', async () => {
    await render('/settings');
    await click(setting('DuckDuckGo')?.querySelector('[role="switch"]'));
    expect(stored<{ disabledSources: string[] }>('glogg.prefs').disabledSources).toEqual(['ddg']);
    await unmount();
    await render('/');
    expect((await search()).config.disabledSources).toEqual(['ddg']);
  });

  it('the junk filter sets how readily results are hidden', async () => {
    localStorage.setItem('glogg.prefs', JSON.stringify({ strictness: 'strict' }));
    await render('/');
    expect((await search()).config.slopThreshold).toBe(36);
  });

  it('hidden phrases go with every search', async () => {
    await render('/settings');
    await type($<HTMLInputElement>('input[aria-label="Phrase to hide"]'), 'top 10');
    await submit($<HTMLInputElement>('input[aria-label="Phrase to hide"]'));
    expect(stored<string[]>('glogg.phrases')).toEqual(['top 10']);
    await unmount();
    await render('/');
    expect((await search()).config.blockedPhrases).toEqual(['top 10']);
  });

  it('a new search starts in your default scope, unless the address names one', async () => {
    localStorage.setItem('glogg.prefs', JSON.stringify({ defaultScope: 'forums' }));
    await render('/');
    expect((await search()).config.lens).toBe('forums');
    await unmount();
    await render('/?q=rust&scope=fediverse');
    await flush();
    expect(searches[searches.length - 1].config.lens).toBe('fediverse');
  });

  it('the web app asks for the compact response', async () => {
    await render('/');
    expect((await search()).compact).toBe(true);
  });
});

describe('domain rules', () => {
  it('from a result: pin, then hide, with one rule per site', async () => {
    await render('/');
    await search();
    const first = $$('article.result')[0];
    await click(first.querySelector('button[aria-label="More actions"]'));
    await click(byText('[role="menuitem"]', 'Pin site1.example'));
    expect(stored<string[]>('glogg.pinned')).toEqual(['site1.example']);
    await click(first.querySelector('button[aria-label="More actions"]'));
    await click(byText('[role="menuitem"]', 'Hide site1.example'));
    expect(stored<string[]>('glogg.pinned')).toEqual([]);
    expect(stored<string[]>('glogg.blocked')).toContain('site1.example');
    expect((await search('again')).config).toMatchObject({ pinnedDomains: [], loweredDomains: [] });
  });

  it('in Settings: add with a rule, from whatever was pasted', async () => {
    await render('/settings');
    await type($<HTMLInputElement>('input[aria-label="Domain"]'), 'https://www.Lowly.example/some/page');
    await act(async () => {
      const select = $<HTMLSelectElement>('select[aria-label="What to do with it"]')!;
      select.value = 'lower';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await submit($<HTMLInputElement>('input[aria-label="Domain"]'));
    expect(stored<string[]>('glogg.lowered')).toEqual(['lowly.example']);
  });

  it('resetting hidden domains asks first', async () => {
    localStorage.setItem('glogg.blocked', JSON.stringify(['mine.example']));
    await render('/settings');
    await click(byText('button', 'Reset to defaults'));
    expect(stored<string[]>('glogg.blocked')).toEqual(['mine.example']);
    expect($('.confirm-inline')?.textContent).toMatch(/Replace your 1 hidden domains/);
    await click($('.confirm-inline .danger'));
    expect(stored<string[]>('glogg.blocked').length).toBeGreaterThan(30);
  });

  it('withDomainRule keeps a domain on one list, and cleanDomain reads pasted addresses', () => {
    const lists = { pin: ['a.example'], raise: ['b.example'], lower: [], hide: ['a.example'] };
    expect(withDomainRule(lists, 'a.example', 'lower')).toEqual({ pin: [], raise: ['b.example'], lower: ['a.example'], hide: [] });
    expect(withDomainRule(lists, 'b.example', null).raise).toEqual([]);
    expect(cleanDomain('HTTPS://www.Example.co.uk/path?q=1')).toBe('example.co.uk');
  });
});

describe('results and appearance', () => {
  it('compact density, site icons off, and links in the same tab', async () => {
    localStorage.setItem('glogg.prefs', JSON.stringify({ density: 'compact', siteIcons: false, newTab: false }));
    await render('/');
    await search();
    expect($('.results.compact')).toBeTruthy();
    expect($$('.favicon img')).toHaveLength(0);
    expect($$('.favicon-letter').length).toBeGreaterThan(0);
    expect($$('a.result-title').every((a) => !a.getAttribute('target'))).toBe(true);
  });

  it('theme and accent apply at once', async () => {
    await render('/settings');
    await click(setting('Theme')?.querySelector('[role="radio"][aria-checked="false"]:last-child'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await click($('button[role="radio"][aria-label="green"]'));
    expect(document.documentElement.dataset.accent).toBe('green');
    expect(stored<{ accent: string }>('glogg.prefs').accent).toBe('green');
  });
});

describe('keyboard', () => {
  it('single-key shortcuts can be turned off; arrows still move', async () => {
    localStorage.setItem('glogg.prefs', JSON.stringify({ singleKeys: false }));
    await render('/');
    await search();
    (document.activeElement as HTMLElement | null)?.blur();
    await key('j');
    expect($$('article.result')[0].classList.contains('active')).toBe(true);
    await key('ArrowDown');
    expect($$('article.result')[1].classList.contains('active')).toBe(true);
  });
});

describe('history', () => {
  it('isn\'t kept when you say so, and clears in one go', async () => {
    await render('/');
    await search('first');
    expect(stored<string[]>('glogg.history')).toEqual(['first']);
    await unmount();
    localStorage.setItem('glogg.prefs', JSON.stringify({ rememberHistory: false }));
    await render('/');
    await search('second');
    expect(stored<string[]>('glogg.history')).toEqual(['first']);
    await unmount();
    await render('/settings');
    await click(byText('button', 'Clear 1 recent searches'));
    expect(stored<string[]>('glogg.history')).toEqual([]);
  });
});

describe('your settings', () => {
  it('a profile carries settings, never 18+ mode or history', () => {
    localStorage.setItem('glogg.pinned', JSON.stringify(['a.example']));
    localStorage.setItem('glogg.uncensored', 'true');
    localStorage.setItem('glogg.history', JSON.stringify(['secret']));
    const p = readProfile();
    expect(p.glogg).toBe('settings');
    expect(p.settings['glogg.pinned']).toEqual(['a.example']);
    expect(Object.keys(p.settings)).not.toContain('glogg.uncensored');
    expect(Object.keys(p.settings)).not.toContain('glogg.history');
    expect(PROFILE_KEYS).not.toContain('glogg.uncensored');
  });

  it('applying one writes what fits and skips what doesn\'t', () => {
    localStorage.clear();
    const n = applyProfile({ glogg: 'settings', version: 1, savedAt: '', settings: { 'glogg.pinned': ['b.example'], 'glogg.theme': 'neon', 'glogg.bangs': [{ trigger: 'x' }], 'glogg.uncensored': true } });
    expect(n).toBe(1);
    expect(stored<string[]>('glogg.pinned')).toEqual(['b.example']);
    expect(localStorage.getItem('glogg.theme')).toBeNull();
    expect(localStorage.getItem('glogg.uncensored')).toBeNull();
    expect(() => applyProfile({ some: 'json' })).toThrow("That isn't a glogg settings file.");
  });

  it('saves to this glogg and loads back', async () => {
    localStorage.setItem('glogg.lowered', JSON.stringify(['meh.example']));
    await render('/settings');
    await click(byText('button', 'Save to this glogg'));
    expect((savedProfile as { settings: { settings: Record<string, unknown> } }).settings.settings['glogg.lowered']).toEqual(['meh.example']);
    expect($('#settings-yours')?.textContent).toMatch(/Last saved here/);
    localStorage.removeItem('glogg.lowered');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true });
    try {
      await act(async () => {
        byText('button', 'Load from this glogg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.runAllTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(stored<string[]>('glogg.lowered')).toEqual(['meh.example']);
    expect(reload).toHaveBeenCalled();
  });
});
