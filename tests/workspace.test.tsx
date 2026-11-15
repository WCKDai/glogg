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
import { LIBRARY_KEY, parseLibrary, libraryExport } from '../src/client/library.js';

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


let root: Root;
let container: HTMLDivElement;
let requests: string[];
let capabilityMode: 'private' | 'public' | 'error' = 'public';
const source = { id: 'crossref', name: 'Crossref', category: 'Academic', description: 'Research publications and citations', homepage: 'https://crossref.org' };
async function flush() { for (let i = 0; i < 8; i++) await act(async () => new Promise((r) => setTimeout(r, 0))); }
async function mount(path = '/') {
  window.history.replaceState({}, '', path);
  container = document.createElement('div'); document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(<App />); });
  await flush();
}
async function click(selector: string) { const element = container.querySelector<HTMLElement>(selector); expect(element).toBeTruthy(); await act(async () => element!.click()); await flush(); }
beforeEach(() => {
  localStorage.clear(); requests = []; capabilityMode = 'public';
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost'); requests.push(url.pathname);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/capabilities') return capabilityMode === 'error' ? json({}, 503) : json({ mode: capabilityMode, features: { tools: capabilityMode === 'private', research: capabilityMode === 'private', downloads: capabilityMode === 'private', administration: capabilityMode === 'private', savedProfiles: capabilityMode === 'private' } });
    if (url.pathname === '/api/auth') return json({ required: false, authenticated: true });
    if (url.pathname === '/api/sources') return json({ sources: [source, { ...source, id: 'wiki', name: 'Wikipedia', category: 'Reference' }] });
    if (url.pathname === '/api/plugins') return json({ plugins: [], userDir: '' });
    if (url.pathname === '/api/downloads') return json({ jobs: [] });
    if (url.pathname === '/api/directory') return json({ items: [] });
    if (url.pathname === '/api/deep') return json({ available: true, posts: 0, byKind: [] });
    if (url.pathname === '/api/search/stream') return json({}, 404);
    if (url.pathname === '/api/search') return json({ query: 'test', results: [{ id: 'r1', url: 'https://example.com/article', title: 'A useful article', snippet: 'An independent guide.', domain: 'example.com', rootDomain: 'example.com', source: 'wiki', signals: [], verdict: 'clean', netScore: 80 }], p2pResults: [], filteredSlop: [], compiledQuery: { escapeUrls: [] }, metrics: { durationMs: 25, filteredSlopCount: 0, sourceTimings: {} } });
    return json({ error: 'Not scripted' }, 404);
  });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); vi.unstubAllGlobals(); });
const privateRequests = () => requests.filter((url) => /^\/api\/(plugins|downloads|profile|integrations|nodes|research)/.test(url));

describe('capability-aware workspace', () => {
  it('public mode never requests private APIs and retains browser preferences', async () => {
    await mount('/settings');
    expect(privateRequests()).toEqual([]);
    expect(container.textContent).not.toContain('Keys and services');
    expect(container.textContent).not.toContain('Save to this glogg');
    expect(container.textContent).toContain('Appearance');
    expect(container.querySelector('a[href="/tools"]')).toBeNull();
    expect(container.querySelector('a[href="/saved"]')).not.toBeNull();
  });
  it('capability failure fails closed with a retry', async () => {
    capabilityMode = 'error'; await mount('/tools');
    expect(privateRequests()).toEqual([]);
    expect(container.textContent).toContain('Could not verify');
    capabilityMode = 'private';
    await click('[data-capability-retry]');
    expect(requests).toContain('/api/plugins');
  });
  it('public Atlas is readable without crawl or source-writing controls', async () => {
    await mount('/atlas?tab=index');
    expect(requests).not.toContain('/api/deep');
    expect(container.textContent).not.toContain('Build the deep index');
    expect(container.querySelector('#deep-add')).toBeNull();
    expect(privateRequests()).toEqual([]);
  });
  it('a delayed capabilities response cannot reopen a cancelled tool query', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => input === '/api/capabilities' ? pending : original(input, init));
    await mount('/?q=%3Ehash%20abc');
    await click('[aria-label="glogg home"]');
    await act(async () => resolve(new Response(JSON.stringify({ mode: 'private', features: { tools: true, research: true, downloads: true, administration: true, savedProfiles: true } }))));
    await flush();
    expect(container.querySelector('.toolcard')).toBeNull();
    expect(container.querySelector('.home')).not.toBeNull();
    expect(window.location.search).toBe('');
  });
  it('public advanced searches keep filters but hide every research and download action', async () => {
    localStorage.setItem('glogg.mode', JSON.stringify('advanced'));
    await mount('/?q=test');
    expect(container.querySelector('.rail')).not.toBeNull();
    expect(container.querySelector('.research-start')).toBeNull();
    expect(container.querySelector('.rail-model')).toBeNull();
    expect(container.textContent).not.toContain('Answer every search');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true })));
    await flush();
    expect(privateRequests()).toEqual([]);
  });
  it('public tool triggers do not discover or run private tools', async () => {
    await mount('/?q=%3Ehash%20abc');
    expect(container.textContent).toContain('Tools are unavailable');
    expect(container.querySelector('input[aria-label="Search"]')?.getAttribute('placeholder')).not.toContain('>tool');
    expect(privateRequests()).toEqual([]);
  });
  it('malformed capability responses never grant private access', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => input === '/api/capabilities' ? Promise.resolve(new Response(JSON.stringify({ mode: 'private', features: { tools: true } }))) : original(input, init));
    await mount('/settings');
    expect(privateRequests()).toEqual([]);
    expect(container.textContent).toContain('Could not verify');
  });
  it('source category and text filters narrow the catalog', async () => {
    await mount('/sources');
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Source category"]')!;
    await act(async () => { select.value = 'Academic'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelectorAll('.source-card')).toHaveLength(1);
    expect(container.querySelector('.source-card h2')?.textContent).toBe('Crossref');
    const input = container.querySelector<HTMLInputElement>('[aria-label="Filter sources"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'no match'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(container.querySelectorAll('.source-card')).toHaveLength(0);
    expect(container.textContent).toContain('No matching sources');
  });
  it('saved-library storage events update the view without server synchronization', async () => {
    await mount('/saved');
    const saved = { title: 'From another tab', url: 'https://saved.example', snippet: 'Notes', source: 'wiki', savedAt: new Date().toISOString() };
    localStorage.setItem(LIBRARY_KEY, JSON.stringify([saved]));
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: LIBRARY_KEY })));
    expect(container.querySelector('.saved-card')?.textContent).toContain('From another tab');
    expect(requests).not.toContain('/api/favicon');
    expect(privateRequests()).toEqual([]);
  });
  it('source switches persist gather-task IDs to browser preferences', async () => {
    await mount('/sources');
    expect(container.textContent).toContain('Crossref');
    await click('[aria-label="Enable Crossref"]');
    expect(JSON.parse(localStorage.getItem('glogg.prefs')!).disabledSources).toEqual(['crossref']);
    expect(container.querySelector('[aria-label="Enable Crossref"]')?.getAttribute('aria-checked')).toBe('false');
    expect(privateRequests()).toEqual([]);
  });
  it('saves a result, browses it after navigation, and removes it', async () => {
    await mount('/?q=test');
    await click('[aria-label="Save A useful article"]');
    expect(parseLibrary(localStorage.getItem(LIBRARY_KEY))).toHaveLength(1);
    await click('a[href="/saved"]');
    expect(container.querySelector('.saved-card')?.textContent).toContain('An independent guide.');
    await click('[aria-label="Remove A useful article from saved library"]');
    expect(parseLibrary(localStorage.getItem(LIBRARY_KEY))).toEqual([]);
    expect(container.textContent).toContain('No saved items yet');
    expect(privateRequests()).toEqual([]);
  });
  it('does not claim success when local saving fails', async () => {
    await mount('/?q=test');
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    await click('[aria-label="Save A useful article"]');
    expect(container.textContent).toContain('Could not save');
    expect(container.querySelector('[aria-label="Save A useful article"]')?.getAttribute('aria-pressed')).toBe('false');
    spy.mockRestore();
  });
});
describe('saved-library format', () => {
  it('rejects unsafe URLs and deduplicates while preserving title and snippet', () => {
    const row = { url: 'https://example.org', title: 'Example', snippet: 'Notes', source: 'wiki', savedAt: '2026-01-01T00:00:00.000Z' };
    expect(parseLibrary(JSON.stringify([row, row, { ...row, url: 'javascript:alert(1)' }, null]))).toEqual([row]);
    expect(JSON.parse(libraryExport([row]))).toMatchObject({ format: 'glogg-library', version: 1, items: [row] });
  });
});
