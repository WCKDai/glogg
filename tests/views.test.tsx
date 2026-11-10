// @vitest-environment jsdom
/**
 * The views and the components they're built from, in jsdom against a scripted
 * API: what each one shows, what each control changes and which requests it
 * sends, plus the accessibility basics. No server, no network.
 */
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BangDefinition,
  ContainerServiceStatus,
  ContainerStackReport,
  DownloadJob,
  DownloadManagerReport,
  ExtractedPageLink,
  InstantAnswerPayload,
  PageAutopsyReport,
  PluginInfo,
  RankedSearchResponse,
  ScoredSearchResult,
  ToolResult,
} from '../src/core/browser.js';
import { BUILTIN_BANGS, DEFAULT_SLOP_DOMAINS, exportUBlacklistRuleset } from '../src/core/browser.js';
import type { PaletteCommand } from '../src/client/components/CommandPalette.js';
import type { SearchPrefs } from '../src/client/views/SettingsView.js';
import type { ToolsTarget } from '../src/client/views/ToolsView.js';
import { BASE_SEED, forAll, html, list, pick, rng, RUNS, text, urlish } from './fuzz.js';

/** jsdom renders a view per case: slow under coverage on a busy machine, so time grows with RUNS. */
const HEAVY = Math.max(30_000, RUNS * 100);
import type { Rng } from './fuzz.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom gaps, as in ui.test.tsx. Node 26 ships its own global localStorage
// (undefined without --localstorage-file) that shadows jsdom's.
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
const { ReaderSheet } = await import('../src/client/components/ReaderSheet.js');
const { AnswerCard, ReleaseList, ResultItem } = await import('../src/client/components/Results.js');
const { SearchBox } = await import('../src/client/components/SearchBox.js');
const { CommandPalette } = await import('../src/client/components/CommandPalette.js');
const { ToolCard, ToolForm, ToolOutput } = await import('../src/client/components/ToolKit.js');
const { DownloadsView } = await import('../src/client/views/DownloadsView.js');
const { ServicesView } = await import('../src/client/views/ServicesView.js');
const { ToolsView } = await import('../src/client/views/ToolsView.js');
const { SettingsView } = await import('../src/client/views/SettingsView.js');
const { DownloadTargetsContext, indexTools, mergeTargets } = await import('../src/client/lib.js');

// ── Scripted API ─────────────────────────────────────────────────────────────
type Call = { method: string; path: string; search: string; body?: any };
type Handler = (call: Call) => unknown;

const reply = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let calls: Call[] = [];

/** Answers fetch from a table of "METHOD /path" routes; a key ending in * matches by prefix. Functions get the call. */
function serve(routes: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method || 'GET';
    const call: Call = { method, path: url.pathname, search: url.search, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${method} ${url.pathname}`;
    const route = key in routes ? routes[key] : Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (route === undefined) return reply(404, { error: `unscripted ${key}` });
    const out = typeof route === 'function' ? await (route as Handler)(call) : route;
    return out instanceof Response ? out : reply(200, out);
  });
}

const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ── Rendering and interaction ────────────────────────────────────────────────
const roots: { root: Root; host: HTMLElement }[] = [];

async function mount(ui: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => root.render(ui));
  await flush();
  return host;
}

async function unmount() {
  const { root, host } = roots.pop()!;
  await act(async () => root.unmount());
  host.remove();
}

async function rerender(ui: React.ReactNode) {
  await act(async () => roots[roots.length - 1].root.render(ui));
  await flush();
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function until(check: () => unknown, what = check.toString()) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await flush(1);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => [...scope.querySelectorAll<T>(sel)];
const textIn = (scope: ParentNode = document.body) => (scope as HTMLElement).textContent?.replace(/\s+/g, ' ').trim() ?? '';

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mouse(type: 'mousedown' | 'mouseover', el: Element | null | undefined) {
  expect(el, `element for ${type}`).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
}

/** Types into an input, textarea or select the way the browser reports it to React. */
async function type(el: Element | null | undefined, value: string) {
  expect(el, 'field to type into').toBeTruthy();
  const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : field instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function press(key: string, target: Element | null = document.activeElement, init: KeyboardEventInit = {}) {
  await act(async () => {
    (target || document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
  await flush(1);
}

/** Submits the field's form like pressing Enter in it: constraint validation first. */
async function submit(el: Element | null | undefined) {
  expect(el, 'field to submit').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).closest('form')!.requestSubmit();
  });
  await flush();
}

// ── Roles and accessible names (enough of the ARIA rules for these views) ──
const INTERACTIVE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="option"], [role="menuitem"], [role="listbox"], [role="combobox"], [role="textbox"]';
const CANDIDATES = `${INTERACTIVE}, [role], section, nav, aside`;
const NAMED_BY_CONTENT = new Set(['button', 'link', 'switch', 'checkbox', 'radio', 'tab', 'option', 'menuitem', 'summary']);

function textOf(node: Node | null): string {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element) || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden')) return '';
  if (node instanceof HTMLImageElement) return node.alt;
  const label = node.getAttribute('aria-label');
  if (label?.trim()) return label;
  return [...node.childNodes].map(textOf).join('');
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  switch (el.tagName) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : '';
    case 'BUTTON':
      return 'button';
    case 'SELECT':
      return 'combobox';
    case 'TEXTAREA':
      return 'textbox';
    case 'SUMMARY':
      return 'summary';
    case 'SECTION':
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
    case 'NAV':
      return 'navigation';
    case 'ASIDE':
      return 'complementary';
    case 'INPUT': {
      const t = (el as HTMLInputElement).type;
      if (t === 'checkbox' || t === 'radio') return t;
      if (['button', 'submit', 'reset'].includes(t)) return 'button';
      return t === 'number' ? 'spinbutton' : t === 'password' ? '' : 'textbox';
    }
    default:
      return '';
  }
}

function nameOf(el: Element): string {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) return squash(by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '));
  const label = el.getAttribute('aria-label');
  if (label?.trim()) return squash(label);
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) return squash([...labels].map(textOf).join(' '));
  if (NAMED_BY_CONTENT.has(roleOf(el))) {
    const own = squash(textOf(el));
    if (own) return own;
  }
  return squash(el.getAttribute('title') || el.getAttribute('placeholder') || '');
}

/** Hidden from everyone: under aria-hidden, [hidden], or inside a closed <details> (its summary aside). */
function isHidden(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden')) return true;
    const details = n.parentElement;
    if (details instanceof HTMLDetailsElement && !details.open && n.tagName !== 'SUMMARY') return true;
  }
  return false;
}

function byRole(role: string, name?: string | RegExp, scope: ParentNode = document.body): HTMLElement {
  const found = queryRole(role, name, scope);
  if (found) return found;
  const seen = $$(CANDIDATES, scope)
    .filter((el) => roleOf(el) === role)
    .map((el) => `"${nameOf(el)}"`);
  throw new Error(`No ${role} named ${String(name)}. Saw: ${seen.join(', ') || 'none'}`);
}

function queryRole(role: string, name?: string | RegExp, scope: ParentNode = document.body): HTMLElement | undefined {
  return $$(CANDIDATES, scope).find(
    (el) => roleOf(el) === role && !isHidden(el) && (name === undefined || (typeof name === 'string' ? nameOf(el) === name : name.test(nameOf(el))))
  );
}

/** A form control by its accessible name, whatever its role. */
function byLabel(name: string, scope: ParentNode = document.body): HTMLInputElement {
  const found = $$<HTMLInputElement>('input, select, textarea, [role="switch"]', scope).find((el) => !isHidden(el) && nameOf(el) === name);
  if (!found) throw new Error(`No field named "${name}". Saw: ${$$('input, select, textarea, [role="switch"]', scope).map((el) => `"${nameOf(el)}"`).join(', ')}`);
  return found;
}

const rolesNamed = (role: string, scope: ParentNode = document.body) =>
  $$(CANDIDATES, scope)
    .filter((el) => roleOf(el) === role && !isHidden(el))
    .map(nameOf);

/** Interactive elements a screen reader would announce without a name. */
function unnamed(scope: ParentNode = document.body): string[] {
  return $$(INTERACTIVE, scope)
    .filter((el) => !isHidden(el) && !nameOf(el))
    .map((el) => el.outerHTML.slice(0, 140));
}

/** Links that would run script, read the way a browser reads a URL. React swaps such hrefs for an inert one, which is fine. */
const REACT_BLOCKED_URL = "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')";
function scriptLinks(scope: ParentNode = document.body): string[] {
  return $$('[href], [src], [action], [formaction]', scope)
    .flatMap((el) => ['href', 'src', 'action', 'formaction'].map((a) => el.getAttribute(a)).filter((u): u is string => u !== null))
    .filter((u) => /^[\u0000-\u0020]*javascript:/i.test(u.replace(/[\r\n\t]/g, '')) && u !== REACT_BLOCKED_URL);
}

/** Elements that only upstream markup could have put there. */
const foreignMarkup = (scope: ParentNode) =>
  [...$$('script, iframe, object, embed, style, form, svg:not([aria-hidden="true"])', scope), ...$$('img', scope).filter((img) => !img.closest('.favicon'))].map(
    (el) => el.outerHTML.slice(0, 80)
  );

const handlerAttributes = (scope: ParentNode) =>
  $$('*', scope).flatMap((el) => [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('on')));

/** forAll for checks that have to wait on React: same seeds, same replay line. */
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

// ── Globals each test may change, restored after it ─────────────────────────
let clipboard: string[] = [];

beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (t: string) => void clipboard.push(t) },
    configurable: true,
  });
});

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  document.body.replaceChildren();
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  document.title = '';
  document.documentElement.removeAttribute('class');
});

// ── Fixtures ──────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const result = (i: number, extra: Partial<ScoredSearchResult> = {}): ScoredSearchResult => ({
  id: `r${i}`,
  title: `Result ${i}`,
  url: `https://site${i}.example/notes/page-${i}`,
  snippet: `Snippet ${i}`,
  source: 'web',
  domain: `site${i}.example`,
  rootDomain: `site${i}.example`,
  tld: 'example',
  slopScore: 5,
  authenticityScore: 70,
  relevanceScore: 80,
  netScore: 80,
  verdict: 'neutral',
  signals: [],
  isPreLlm: false,
  isIndieWeb: false,
  isPrimarySource: false,
  isSponsored: false,
  isBigTechMonoculture: false,
  ...extra,
});

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=debian-12.iso';

const torrent = (i: number, p2p: Partial<NonNullable<ScoredSearchResult['p2p']>> = {}, extra: Partial<ScoredSearchResult> = {}) =>
  result(i, {
    title: `debian-12.${i}-amd64-DVD-1.iso`,
    url: MAGNET.replace('01234567&', `0123456${i}&`),
    domain: 'dht',
    rootDomain: 'dht',
    source: 'bitmagnet-dht',
    verdict: 'verified-p2p',
    p2p: {
      protocol: 'bittorrent-dht',
      magnetUri: MAGNET.replace('01234567&', `0123456${i}&`),
      sizeFormatted: '3.7 GB',
      seeders: 412,
      leechers: 33,
      indexerName: 'DHT',
      healthVerdict: 'verified-swarm',
      ...p2p,
    },
    ...extra,
  });

const PLUGIN_TARGETS = [{ id: 'plugin:realdebrid' as const, pluginId: 'realdebrid', label: 'Real-Debrid', accepts: ['magnet' as const, 'link' as const], configured: true }];
const TARGETS = mergeTargets(PLUGIN_TARGETS);
const withTargets = (ui: React.ReactNode) => <DownloadTargetsContext.Provider value={TARGETS}>{ui}</DownloadTargetsContext.Provider>;

// ── Result rows ───────────────────────────────────────────────────────────────
describe('result rows', () => {
  const handlers = () => ({ onHover: vi.fn(), onRead: vi.fn(), onSend: vi.fn(), onPin: vi.fn(), onMute: vi.fn() });

  async function row(item: ScoredSearchResult, opts: { detailed?: boolean } = {}) {
    const h = handlers();
    await mount(withTargets(<ResultItem item={item} active={false} detailed={opts.detailed} {...h} />));
    return h;
  }

  it('shows the site, a breadcrumb of the path, and the title as a link that opens in a new tab', async () => {
    await row(result(1, { publishedAt: daysAgo(3), source: 'hn' }));
    const title = byRole('link', 'Result 1');
    expect(title.getAttribute('href')).toBe('https://site1.example/notes/page-1');
    expect(title.getAttribute('target')).toBe('_blank');
    expect(title.getAttribute('rel')).toContain('noreferrer');
    expect(textIn()).toContain('site1.example');
    expect(textIn()).toContain('notes › page-1');
    expect(textIn()).toContain('Snippet 1');
    expect(textIn()).toContain('Hacker News · 3 days ago');
    expect(unnamed()).toEqual([]);
  });

  it('reads a result clean, and reports hovering so the keyboard cursor can follow', async () => {
    const h = await row(result(1));
    await click(byRole('button', 'Read'));
    expect(h.onRead).toHaveBeenCalledWith('https://site1.example/notes/page-1');
    await mouse('mouseover', $('.result'));
    expect(h.onHover).toHaveBeenCalled();
  });

  it('shows a torrent with its size and seeders, sends its magnet, and has no reader for a bare magnet', async () => {
    const item = torrent(1);
    const h = await row(item);
    expect(textIn()).toContain('DHT · 3.7 GB · 412 seeds');
    expect(queryRole('button', 'Read')).toBeUndefined();
    await click(byRole('button', 'Send'));
    expect(h.onSend).toHaveBeenCalledWith(item, 'auto');
  });

  it('lets you pick where a torrent goes, including configured plugins, or copy its magnet', async () => {
    const item = torrent(1);
    const h = await row(item);
    const caret = byRole('button', 'Choose destination');
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    await click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect($$('[role="menuitem"]').map((m) => m.firstChild!.textContent)).toEqual([
      'Auto',
      'Offcloud',
      'aria2',
      'Nextcloud',
      'Real-Debrid',
      'This machine',
      'Copy link',
    ]);
    expect(byRole('menuitem', /^Real-Debrid/).textContent).toContain('Takes magnet, link');
    await click(byRole('menuitem', /^aria2/));
    expect(h.onSend).toHaveBeenCalledWith(item, 'aria2-rpc');
    expect($('[role="menu"]')).toBeNull();

    await click(caret);
    await click(byRole('menuitem', 'Copy link'));
    expect(clipboard).toEqual([item.p2p!.magnetUri]);
    expect(byRole('menuitem', 'Copied')).toBeTruthy();
  });

  it('closes the destination menu on a click elsewhere', async () => {
    await row(torrent(1));
    await click(byRole('button', 'Choose destination'));
    expect($('[role="menu"]')).toBeTruthy();
    await mouse('mousedown', document.body);
    await flush();
    expect($('[role="menu"]')).toBeNull();
  });

  it('keeps the reader for a release found on a web page, and leaves out seeds a source did not give', async () => {
    await row(
      result(2, {
        source: 'usenet-nzb',
        url: 'https://nzbindex.example/release/42',
        p2p: { protocol: 'usenet-nzb', nzbUrl: 'https://nzbindex.example/download/42.nzb', sizeFormatted: '700 MB', indexerName: 'NZBIndex', healthVerdict: 'active' },
      })
    );
    expect(textIn()).toContain('Usenet · 700 MB');
    expect(textIn()).not.toContain('seeds');
    expect(byRole('button', 'Read')).toBeTruthy();
    expect(byRole('button', 'Send')).toBeTruthy();
  });

  it.each([
    ['atproto', 'https://bsky.app/profile/alice.bsky.social/post/3kq2xyzab7c2u', 'bsky.app', 'Bluesky', 'profile › alice.bsky.social › post'],
    ['activitypub', 'https://fosstodon.org/@bob/111222333444', 'fosstodon.org', 'Mastodon', '@bob'],
    ['matrix', 'https://matrix.to/#/%23linux%3Amatrix.org', 'matrix.to', 'Matrix', ''],
    ['lemmy', 'https://lemmy.world/post/123456', 'lemmy.world', 'Lemmy', 'post'],
  ] as const)('shows a %s result by its network, and reads it like any page', async (source, url, domain, network, crumb) => {
    const h = await row(
      result(3, {
        source,
        url,
        domain,
        rootDomain: domain,
        verdict: 'fediverse-node',
        title: `[${network}] a post about sqlite`,
        publishedAt: daysAgo(1.5),
        fediverse: { protocol: source === 'lemmy' ? 'activitypub' : source, handleOrRoom: '@alice', uri: url, instanceDomain: domain },
      })
    );
    expect(textIn()).toContain(`${network} · yesterday`);
    expect($('.result-domain')!.textContent).toBe(domain);
    expect($('.result-crumb')?.textContent ?? '').toBe(crumb);
    expect(byRole('link', `[${network}] a post about sqlite`).getAttribute('href')).toBe(url);
    await click(byRole('button', 'Read'));
    expect(h.onRead).toHaveBeenCalledWith(url);
  });

  it('tags 18+ results, primary sources, and finds from imageboards and old forums', async () => {
    await row(result(1, { isNsfw: true, verdict: 'primary-source', source: 'chanboards' }));
    expect($$('.result-meta .tag').map((t) => t.textContent)).toEqual(['18+', 'primary', 'Imageboards']);
    await row(result(2, { source: 'wild-west' }));
    expect(textIn(roots[1].host.querySelector('.result-meta')!)).toContain('Forums');
  });

  it('shows the ranking signals only in the advanced view', async () => {
    const item = result(1, { relevanceScore: 81.6, authenticityScore: 64.2, slopScore: 44.5, isPrimarySource: true, isIndieWeb: true, isPreLlm: true, tld: '.org' });
    await row(item);
    expect($('[aria-label="Ranking signals"]')).toBeNull();
    await row(item, { detailed: true });
    expect($$('[aria-label="Ranking signals"] span').map((s) => s.textContent)).toEqual([
      'match 82',
      'signal 64',
      'slop 45',
      'primary source',
      'independent',
      'pre-LLM',
      '.org',
    ]);
  });

  it('offers to save the page, prefer or hide its site, copy the link, or see old snapshots', async () => {
    const item = result(1);
    const h = await row(item);
    const more = byRole('button', 'More actions');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(rolesNamed('menuitem')).toEqual(['Save page', 'Prefer site1.example', 'Hide site1.example', 'Copy link', 'Wayback snapshots']);
    const wayback = byRole('menuitem', 'Wayback snapshots');
    expect(wayback.getAttribute('href')).toBe('https://web.archive.org/web/*/https://site1.example/notes/page-1');
    expect(wayback.getAttribute('target')).toBe('_blank');

    await click(byRole('menuitem', 'Save page'));
    expect(h.onSend).toHaveBeenCalledWith(item, 'auto');
    expect($('[role="menu"]')).toBeNull();
    await click(more);
    await click(byRole('menuitem', 'Prefer site1.example'));
    expect(h.onPin).toHaveBeenCalledWith('site1.example');
    await click(more);
    await click(byRole('menuitem', 'Hide site1.example'));
    expect(h.onMute).toHaveBeenCalledWith('site1.example');
    await click(more);
    await click(byRole('menuitem', 'Copy link'));
    expect(clipboard).toEqual(['https://site1.example/notes/page-1']);
    expect($('[role="menu"]')).toBeNull();
  });

  it('does not offer "Save page" for a release, which has its own Send button', async () => {
    await row(torrent(1));
    await click(byRole('button', 'More actions'));
    expect(rolesNamed('menuitem')).toEqual(['Prefer dht', 'Hide dht', 'Copy link', 'Wayback snapshots']);
  });

  it('closes the menu when you follow the Wayback link', async () => {
    await row(result(1));
    await click(byRole('button', 'More actions'));
    // The browser's part: opening the new tab. Stop jsdom navigating after glogg's handler ran.
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('click', stop);
    try {
      await click(byRole('menuitem', 'Wayback snapshots'));
    } finally {
      window.removeEventListener('click', stop);
    }
    expect($('[role="menu"]')).toBeNull();
  });

  it('sends and copies the .torrent link of a release that has no magnet', async () => {
    const item = torrent(1, { magnetUri: undefined, torrentUrl: 'https://academictorrents.example/download/1.torrent' }, { url: 'https://academictorrents.example/details/1' });
    const h = await row(item);
    await click(byRole('button', 'Send'));
    expect(h.onSend).toHaveBeenCalledWith(item, 'auto');
    await click(byRole('button', 'Choose destination'));
    await click(byRole('menuitem', 'Copy link'));
    expect(clipboard).toEqual(['https://academictorrents.example/download/1.torrent']);
  });

  it('never renders markup or script links from upstream text in a result or release row, whatever it contains', async () => {
    const h = handlers();
    await mount(withTargets(<ResultItem item={result(0)} active={false} {...h} />));
    forAll(
      'result row',
      (r) => ({
        title: text(r),
        snippet: html(r),
        url: pick(r, [urlish(r), 'javascript:alert(document.domain)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', '\u0000javascript:alert(1)']),
        domain: text(r, 3),
        magnet: r() < 0.3 ? pick(r, [MAGNET, 'javascript:alert(1)', urlish(r)]) : undefined,
      }),
      ({ title, snippet, url, domain, magnet }) => {
        const item = result(9, {
          title,
          snippet,
          url,
          domain,
          rootDomain: domain,
          p2p: magnet ? { protocol: 'bittorrent-dht', magnetUri: magnet, sizeFormatted: '3.7 GB', indexerName: 'DHT', healthVerdict: 'active' } : undefined,
        });
        act(() => roots[0].root.render(withTargets(<ResultItem item={item} active={false} detailed {...h} />)));
        const host = roots[0].host;
        expect(scriptLinks(host)).toEqual([]);
        expect(foreignMarkup(host)).toEqual([]);
        expect(handlerAttributes(host)).toEqual([]);
        expect($('.result-title', host)!.textContent).toBe(title);
        expect($('.result-snippet', host)!.textContent).toBe(snippet);
      }
    );
    await mount(withTargets(<ReleaseList items={[]} onSend={h.onSend} />));
    forAll(
      'release row',
      (r) => ({ title: html(r), magnet: pick(r, [MAGNET, 'javascript:alert(1)', ' javascript:alert(1)', urlish(r)]), indexer: text(r, 3) }),
      ({ title, magnet, indexer }) => {
        const item = torrent(1, { magnetUri: magnet, indexerName: indexer }, { title });
        act(() => roots[1].root.render(withTargets(<ReleaseList items={[item]} onSend={h.onSend} />)));
        const host = roots[1].host;
        expect(scriptLinks(host)).toEqual([]);
        expect(foreignMarkup(host)).toEqual([]);
        expect($('.release-title', host)!.textContent).toBe(title);
      }
    );
  }, HEAVY);
});

describe('torrent and NZB list', () => {
  async function releases(items: ScoredSearchResult[]) {
    const onSend = vi.fn();
    await mount(withTargets(<ReleaseList items={items} onSend={onSend} />));
    return onSend;
  }

  it('lists torrents with indexer, size, seeds and peers, and a magnet link for your client', async () => {
    const item = torrent(1);
    const onSend = await releases([item]);
    expect($('.release-title')!.textContent).toBe('debian-12.1-amd64-DVD-1.iso');
    expect($$('.release-meta > span').map((s) => s.textContent)).toEqual(['DHT', '3.7 GB', '412 seeds · 33 peers']);
    const magnet = byRole('link', 'Open magnet in your client');
    expect(magnet.getAttribute('href')).toBe(item.p2p!.magnetUri);
    await click(byRole('button', 'Send to best destination'));
    expect(onSend).toHaveBeenCalledWith(item, 'auto');
    await click(byRole('button', 'Choose destination'));
    await click(byRole('menuitem', /^Real-Debrid/));
    expect(onSend).toHaveBeenLastCalledWith(item, 'plugin:realdebrid');
    expect(unnamed()).toEqual([]);
  });

  it('counts missing seeds and peers as zero', async () => {
    await releases([torrent(1, { seeders: undefined, leechers: undefined })]);
    expect(textIn()).toContain('0 seeds · 0 peers');
  });

  it('dates NZBs by age, or names their newsgroup, and has no magnet link for them', async () => {
    const nzb = (i: number, p2p: object) =>
      result(i, {
        title: `nzb ${i}`,
        source: 'usenet-nzb',
        p2p: { protocol: 'usenet-nzb', nzbUrl: `https://nzb.example/${i}.nzb`, sizeFormatted: '700 MB', indexerName: 'NZBIndex', healthVerdict: 'active', ...p2p },
      });
    await releases([nzb(1, { usenetAgeDays: 12 }), nzb(2, { newsgroup: 'alt.binaries.linux' }), nzb(3, {})]);
    expect($$('.release-meta').map((m) => [...m.children].map((s) => s.textContent))).toEqual([
      ['NZBIndex', '700 MB', '12d old'],
      ['NZBIndex', '700 MB', 'alt.binaries.linux'],
      ['NZBIndex', '700 MB', 'usenet'],
    ]);
    expect(queryRole('link', 'Open magnet in your client')).toBeUndefined();
  });

  it('flags adult and suspect releases', async () => {
    await releases([torrent(1, { isAdultNsfw: true, healthVerdict: 'suspect-spam' })]);
    expect($$('.release .tag').map((t) => t.textContent)).toEqual(['18+', 'suspect']);
  });

  it('says when nothing was found, and suggests a bang', async () => {
    await releases([]);
    expect(textIn()).toBe('No releases found. Try a different scope, or a !btdig / !nzb bang.');
  });
});

describe('instant answer', () => {
  const answer = (extra: Partial<InstantAnswerPayload> = {}): InstantAnswerPayload => ({
    kind: 'direct-fact',
    title: 'SQLite',
    directAnswer: 'SQLite is a C library that implements an SQL database engine.',
    confidence: 'high',
    citations: [],
    ...extra,
  });

  it('labels a calculation, and shows its working', async () => {
    await mount(<AnswerCard answer={answer({ kind: 'computation', title: '2^10', subtitle: 'Exponent', directAnswer: '1024', codeBlock: '2 ** 10' })} onRead={vi.fn()} />);
    const card = byRole('region', 'Answer');
    expect(textIn(card)).toContain('Calculated');
    expect($('h2', card)!.textContent).toBe('2^10');
    expect(textIn(card)).toContain('Exponent');
    expect($('pre code', card)!.textContent).toBe('2 ** 10');
  });

  it('names its source, lists key facts and takeaways, and caps them', async () => {
    const facts = Array.from({ length: 8 }, (_, i) => ({ label: `Fact ${i}`, value: `v${i}` }));
    const takeaways = Array.from({ length: 6 }, (_, i) => ({ text: `Point ${i}`, citationIndex: i + 1 }));
    await mount(<AnswerCard answer={answer({ primarySourceDomain: 'sqlite.org', keyFacts: facts, takeaways })} onRead={vi.fn()} />);
    expect($$('.answer-eyebrow span').map((s) => s.textContent)).toEqual(['Answer', 'sqlite.org']);
    expect($('h2')!.textContent).toBe('SQLite');
    expect($$('.answer-facts dt').map((d) => `${d.textContent}: ${d.nextElementSibling!.textContent}`)).toEqual(facts.slice(0, 6).map((f) => `${f.label}: ${f.value}`));
    expect($$('.answer-takeaways li').map((l) => `${l.firstChild!.textContent} [${$('sup', l)!.textContent}]`)).toEqual(['Point 0 [1]', 'Point 1 [2]', 'Point 2 [3]', 'Point 3 [4]']);
  });

  it('links up to five citations and reads the primary source in the reader', async () => {
    const citations = Array.from({ length: 7 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`, url: `https://c${i + 1}.example/`, domain: `c${i + 1}.example`, source: 'web' as const }));
    const onRead = vi.fn();
    await mount(<AnswerCard answer={answer({ citations, primarySourceUrl: 'https://sqlite.org/about.html' })} onRead={onRead} />);
    const links = $$<HTMLAnchorElement>('.answer-cites a');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(citations.slice(0, 5).map((c) => c.url));
    expect(links.map((a) => [$('.cite-n', a)!.textContent, a.title])).toEqual(citations.slice(0, 5).map((c) => [String(c.index), c.title]));
    expect(links.every((a) => a.target === '_blank' && nameOf(a).endsWith(new URL(a.href).hostname))).toBe(true);
    await click(byRole('button', 'Read source'));
    expect(onRead).toHaveBeenCalledWith('https://sqlite.org/about.html');
  });

  it('has no Read source button without a primary source', async () => {
    await mount(<AnswerCard answer={answer()} onRead={vi.fn()} />);
    expect(queryRole('button', 'Read source')).toBeUndefined();
  });
});

// ── Reader ────────────────────────────────────────────────────────────────────
const READ_URL = 'https://www.example.org/2019/04/sqlite-pages';

const link = (url: string, extra: Partial<ExtractedPageLink> = {}): ExtractedPageLink => ({
  text: '',
  url,
  domain: new URL(url).hostname,
  kind: 'reference',
  strippedParams: [],
  ...extra,
});

const page = (extra: Partial<PageAutopsyReport> = {}): PageAutopsyReport => ({
  url: READ_URL,
  title: 'How SQLite stores pages',
  domain: 'example.org',
  byline: 'Ada Lovelace',
  publishedDate: '2019-04-02T10:00:00Z',
  hasRssFeed: false,
  hasIndieWebMarkers: true,
  verdict: 'indie-gem',
  slopScore: 4,
  authenticityScore: 80,
  signals: [],
  stats: {
    rawHtmlBytes: 120_000,
    cleanTextBytes: 9_000,
    bloatReductionPercent: 62,
    totalScriptsRemoved: 9,
    trackersBlocked: [],
    sponsoredBlocksRemoved: 0,
    affiliateLinksDisarmed: 0,
    trackingParamsStripped: 0,
    primarySourcesFound: 1,
    aiPhrasesDetected: [],
    seoPatternsDetected: [],
    estimatedRawReadMinutes: 9,
    estimatedCleanReadMinutes: 4,
    fluffPreambleParagraphs: 2,
  },
  coreTakeaway: 'A database file is a sequence of fixed-size B-tree pages.',
  primarySources: [link('https://www.sqlite.org/fileformat.html', { text: 'The SQLite file format', kind: 'primary-source', sourceTypeLabel: 'Spec' })],
  sections: [
    { id: 's1', tag: 'p', text: 'Grab a coffee, this one is long.', isFluffPreamble: true, isCoreAnswer: false, wordCount: 7, fluffTriggers: ['grab a coffee'] },
    { id: 's2', tag: 'p', text: 'In this article we will explore.', isFluffPreamble: true, isCoreAnswer: false, wordCount: 6, fluffTriggers: ['in this article'] },
    { id: 's3', tag: 'h2', text: 'Pages', isFluffPreamble: false, isCoreAnswer: false, wordCount: 1, fluffTriggers: [] },
    { id: 's4', tag: 'p', text: 'Every page is the same size, a power of two.', isFluffPreamble: false, isCoreAnswer: true, wordCount: 10, fluffTriggers: [] },
    { id: 's5', tag: 'pre', text: 'PRAGMA page_size;', isFluffPreamble: false, isCoreAnswer: false, wordCount: 2, fluffTriggers: [] },
    { id: 's6', tag: 'blockquote', text: 'Small. Fast. Reliable.', isFluffPreamble: false, isCoreAnswer: false, wordCount: 3, fluffTriggers: [] },
  ],
  links: [link(MAGNET, { text: 'debian-12.iso', kind: 'magnet-p2p' })],
  ...extra,
});

describe('reader', () => {
  const props = () => ({ onClose: vi.fn(), onNavigate: vi.fn(), onSend: vi.fn() });

  async function open(report: PageAutopsyReport | (() => unknown) = page(), url = READ_URL) {
    serve({ 'POST /api/inspect': typeof report === 'function' ? report : () => report });
    const p = props();
    await mount(withTargets(<ReaderSheet url={url} {...p} />));
    return p;
  }

  it('shows a skeleton while the page loads, then the clean page with what was stripped from it', async () => {
    const pending = deferred();
    await open(() => pending.promise);
    expect(sent('POST', '/api/inspect')[0].body).toEqual({ url: READ_URL });
    const sheet = byRole('dialog', 'Reader');
    expect(textIn($('.sheet-bar', sheet)!)).toContain('example.org');
    expect($$('.skeleton', sheet).length).toBeGreaterThan(0);
    expect($('h1', sheet)).toBeNull();

    pending.resolve(reply(200, page()));
    await until(() => $('h1', sheet));
    expect($$('.skeleton', sheet)).toEqual([]);
    expect($('h1', sheet)!.textContent).toBe('How SQLite stores pages');
    expect(textIn($('.reader-meta', sheet)!)).toBe('Ada Lovelace · 2019-04-02 · 4 min read · 62% lighter · 9 trackers removed');
    expect([...$('.reader-takeaway', sheet)!.children].map((c) => c.textContent)).toEqual(['In short', 'A database file is a sequence of fixed-size B-tree pages.']);
  });

  it('leaves out byline, date and savings the page does not have', async () => {
    const plain = page({ byline: undefined, publishedDate: undefined, coreTakeaway: '' });
    plain.stats = { ...plain.stats, bloatReductionPercent: 0, totalScriptsRemoved: 0 };
    await open(plain);
    expect(textIn($('.reader-meta')!)).toBe('4 min read');
    expect($('.reader-takeaway')).toBeNull();
  });

  it('renders headings, paragraphs, code and quotes, keeping intro filler hidden until asked', async () => {
    await open();
    const content = $('.reader-content')!;
    expect([...content.children].map((c) => `${c.tagName} ${c.textContent}`)).toEqual([
      'H3 Pages',
      'P Every page is the same size, a power of two.',
      'PRE PRAGMA page_size;',
      'BLOCKQUOTE Small. Fast. Reliable.',
    ]);
    await click(byRole('button', 'Show 2 intro paragraphs of filler'));
    expect([...content.children].slice(0, 2).map((c) => c.textContent)).toEqual(['Grab a coffee, this one is long.', 'In this article we will explore.']);
    await click(byRole('button', 'Hide 2 intro paragraphs of filler'));
    expect(content.children).toHaveLength(4);
  });

  it('counts a single filler paragraph in the singular', async () => {
    const one = page();
    one.stats = { ...one.stats, fluffPreambleParagraphs: 1 };
    await open(one);
    expect(byRole('button', 'Show 1 intro paragraph of filler')).toBeTruthy();
  });

  it('offers no filler toggle when the page has none', async () => {
    const none = page();
    none.stats = { ...none.stats, fluffPreambleParagraphs: 0 };
    await open(none);
    expect(queryRole('button', /intro paragraph/)).toBeUndefined();
  });

  it('lists up to ten sources the page cites, and opens one in the reader', async () => {
    const sources = Array.from({ length: 12 }, (_, i) => link(`https://src${i}.example/spec`, { text: i === 1 ? '' : `Source ${i}`, sourceTypeLabel: i === 0 ? 'RFC' : undefined }));
    const p = await open(page({ primarySources: sources }));
    const section = $('.reader-sources')!;
    expect($('h4', section)!.textContent).toBe('Sources this page cites');
    expect($$('li', section)).toHaveLength(10);
    expect($('.muted', $$('li', section)[0])!.textContent).toBe('RFC · src0.example');
    expect(rolesNamed('button', section).slice(0, 3)).toEqual(['Source 0', 'src1.example', 'Source 2']);
    await click(byRole('button', 'Source 2', section));
    expect(p.onNavigate).toHaveBeenCalledWith('https://src2.example/spec');
  });

  it('offers up to eight magnets found on the page, and sends one to downloads', async () => {
    const magnets = Array.from({ length: 10 }, (_, i) => link(MAGNET.replace('dn=debian-12.iso', `dn=file${i}`), { text: i === 2 ? '' : `file${i}`, kind: 'magnet-p2p' }));
    const p = await open(page({ links: [link('https://other.example/'), ...magnets] }));
    const section = $$('.reader-sources').find((s) => s.textContent?.includes('Magnets on this page'))!;
    expect($$('li', section).map((li) => $('span', li)!.textContent)).toEqual(['file0', 'file1', 'magnet', 'file3', 'file4', 'file5', 'file6', 'file7']);
    await click($$('li', section)[1].querySelector('button'));
    expect(p.onSend).toHaveBeenCalledWith(magnets[1].url, 'file1', 'auto');
  });

  it('has no magnets section when the page has none', async () => {
    await open(page({ links: [link('https://other.example/')] }));
    expect(textIn()).not.toContain('Magnets on this page');
  });

  it('saves the page under its title, to the best place or one you pick, and links to the original', async () => {
    const p = await open();
    await click(byRole('button', 'Save'));
    expect(p.onSend).toHaveBeenCalledWith(READ_URL, 'How SQLite stores pages', 'auto');
    await click(byRole('button', 'Choose destination'));
    await click(byRole('menuitem', /^Nextcloud/));
    expect(p.onSend).toHaveBeenLastCalledWith(READ_URL, 'How SQLite stores pages', 'nextcloud');
    const original = byRole('link', 'Original');
    expect(original.getAttribute('href')).toBe(READ_URL);
    expect(original.getAttribute('target')).toBe('_blank');
    expect(original.getAttribute('rel')).toContain('noreferrer');
  });

  it('saves under the site name while the page is still loading', async () => {
    const p = await open(() => new Promise(() => undefined));
    await click(byRole('button', 'Save'));
    expect(p.onSend).toHaveBeenCalledWith(READ_URL, 'example.org', 'auto');
  });

  it('says when a page cannot be cleaned, and links to the original and the Wayback copy', async () => {
    await open(() => reply(502, { error: 'Upstream answered 403' }));
    await until(() => $('.notice-error'));
    expect(textIn($('.notice-error')!)).toBe("Couldn't load this page cleanly (Upstream answered 403). Open the original or try the Wayback copy.");
    expect(byRole('link', 'Open the original').getAttribute('href')).toBe(READ_URL);
    expect(byRole('link', 'Wayback copy').getAttribute('href')).toBe(`https://web.archive.org/web/2/${READ_URL}`);
    expect($$('.skeleton')).toEqual([]);
  });

  it('closes with Escape, the close button, or a click outside it', async () => {
    const p = await open();
    await press('Escape', document.body);
    expect(p.onClose).toHaveBeenCalledTimes(1);
    await click(byRole('button', 'Close reader (Esc)'));
    expect(p.onClose).toHaveBeenCalledTimes(2);
    await click($('.scrim'));
    expect(p.onClose).toHaveBeenCalledTimes(3);
    await press('Enter', document.body);
    expect(p.onClose).toHaveBeenCalledTimes(3);
  });

  it('loads the next page when you follow a source, and ignores the old one if it answers late', async () => {
    const first = deferred();
    const second = deferred();
    serve({ 'POST /api/inspect': (c: Call) => (c.body.url === READ_URL ? first.promise : second.promise) });
    const p = props();
    await mount(withTargets(<ReaderSheet url={READ_URL} {...p} />));
    await rerender(withTargets(<ReaderSheet url="https://www.sqlite.org/fileformat.html" {...p} />));
    expect(textIn($('.sheet-bar')!)).toContain('sqlite.org');
    first.resolve(reply(200, page({ title: 'Old page' })));
    await flush();
    expect($('h1')).toBeNull();
    second.resolve(reply(200, page({ title: 'The SQLite file format' })));
    await until(() => $('h1'));
    expect($('h1')!.textContent).toBe('The SQLite file format');
    expect(sent('POST', '/api/inspect').map((c) => c.body.url)).toEqual([READ_URL, 'https://www.sqlite.org/fileformat.html']);
  });

  it('shows an address it cannot parse as it is', async () => {
    await open(page(), 'not a url');
    expect(textIn($('.sheet-bar')!)).toContain('not a url');
  });

  it('is a labelled dialog, and every control in it has a name', async () => {
    await open();
    expect(byRole('dialog', 'Reader')).toBeTruthy();
    expect(unnamed()).toEqual([]);
    await click(byRole('button', 'Choose destination'));
    expect(unnamed()).toEqual([]);
  });

  it('never renders markup or script links from the page, whatever it contains', async () => {
    const nasty = (r: Rng) => pick(r, [urlish(r), 'javascript:alert(1)', '\u0001javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\nscript:alert(1)']);
    let current = page();
    let n = 0;
    // A body that is already read, so each case settles in a few microtasks instead of a stream read.
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => current }));
    const p = props();
    await mount(withTargets(<ReaderSheet url={READ_URL} {...p} />));
    await forAllAsync(
      'reader page',
      (r) =>
        page({
          url: nasty(r),
          title: text(r),
          byline: text(r, 4),
          coreTakeaway: html(r),
          sections: list(r, 6, (x) => ({
            id: String(x()),
            tag: pick(x, ['h1', 'h2', 'h3', 'p', 'pre', 'blockquote', 'ul', 'table'] as const),
            text: html(x),
            isFluffPreamble: x() < 0.3,
            isCoreAnswer: x() < 0.3,
            wordCount: 1,
            fluffTriggers: [],
          })),
          primarySources: list(r, 3, (x) => ({ ...link('https://a.example/'), url: nasty(x), text: html(x), domain: text(x, 2) })),
          links: list(r, 3, (x) => ({ ...link('https://a.example/'), url: nasty(x), text: text(x), kind: 'magnet-p2p' as const })),
        }),
      async (report) => {
        current = report;
        // The address comes from a result row, so it is upstream text too.
        await act(async () => roots[0].root.render(withTargets(<ReaderSheet url={`${report.url}#${++n}`} {...p} />)));
        await act(async () => {
          for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        await until(() => $('h1'));
        const sheet = byRole('dialog', 'Reader');
        expect(scriptLinks(sheet)).toEqual([]);
        expect(foreignMarkup(sheet)).toEqual([]);
        expect(handlerAttributes(sheet)).toEqual([]);
        expect($('h1', sheet)!.textContent).toBe(report.title);
        expect($$('.reader-content > *', sheet).map((el) => el.textContent)).toEqual(report.sections.filter((s) => !s.isFluffPreamble).map((s) => s.text));
      }
    );
  }, HEAVY);
});

// ── The results page, in the real App ───────────────────────────────────────
const plugin = (p: Partial<PluginInfo> & { id: string }): PluginInfo => ({
  name: p.id,
  description: `${p.id} plugin`,
  category: 'utility',
  tools: [],
  source: 'builtin',
  configured: true,
  hasRunner: true,
  ...p,
});

const job = (id: string, extra: Partial<DownloadJob> = {}): DownloadJob => ({
  id,
  title: `Job ${id}`,
  sourceUrl: `magnet:?xt=urn:btih:${id}`,
  kind: 'magnet',
  target: 'aria2-rpc',
  status: 'completed',
  progressPercent: 100,
  createdAt: daysAgo(2),
  statusDetail: 'Done',
  ...extra,
});

const downloads = (jobs: DownloadJob[] = [], extra: Partial<DownloadManagerReport> = {}): DownloadManagerReport => ({
  config: {},
  jobs,
  integrations: { offcloudConfigured: true, nzbLifeConfigured: false, nextcloudConfigured: false, aria2Reachable: true, localDownloadsDir: '/Users/ada/Downloads/glogg' },
  pluginTargets: PLUGIN_TARGETS,
  ...extra,
});

const response = (extra: Partial<RankedSearchResponse> = {}, metrics: Partial<RankedSearchResponse['metrics']> = {}): RankedSearchResponse => ({
  query: 'sqlite internals',
  lens: 'all',
  uncensoredMode: false,
  compiledQuery: { rawQuery: 'sqlite internals', cleanedTokens: [], lens: 'all', synthesizedQuery: 'sqlite internals', negativeSiteOperators: [], positiveOperators: [], escapeUrls: [] },
  results: [result(1), result(2), result(3)],
  p2pResults: [],
  filteredSlop: [],
  metrics: {
    totalRawResults: 3,
    surfacedCount: 3,
    p2pCount: 0,
    fediverseCount: 0,
    filteredSlopCount: 0,
    sponsoredRemovedCount: 0,
    primarySourcesCount: 0,
    demotedDuplicateDomainsCount: 0,
    uniqueDomainsCount: 3,
    tldDistribution: {},
    sourceDistribution: {},
    domainDiversityRatio: 1,
    avgAuthenticityScore: 70,
    avgSlopScore: 5,
    sourcesQueried: [],
    sourceTimings: { wiki: { ms: 300, count: 3, status: 'ok' } },
    durationMs: 420,
    ...metrics,
  },
  ...extra,
});

/** Opens glogg at a search address, as a bookmark or the browser's Back would. */
async function resultsPage(search: RankedSearchResponse | ((call: Call, n: number) => unknown), routes: Record<string, unknown> = {}) {
  let n = 0;
  serve({
    'GET /api/auth': { required: false, authenticated: false },
    'GET /api/plugins': { plugins: [], userDir: '' },
    'GET /api/downloads': downloads(),
    'POST /api/search': (c: Call) => (typeof search === 'function' ? search(c, ++n) : search),
    ...routes,
  });
  window.history.replaceState({}, '', '/?q=sqlite+internals');
  await mount(<App />);
  await until(() => $('.status-count'), 'the results');
}

const rows = () => $$('.result').map((r) => $('.result-title', r)!.textContent);
const toasts = () => $$('.toast').map((t) => t.textContent);

describe('the results page', () => {
  it('shows the instant answer above the results, and hides it while you filter by source', async () => {
    const instantAnswer: InstantAnswerPayload = {
      kind: 'direct-fact',
      title: 'SQLite',
      directAnswer: 'A small, fast SQL database engine in a C library.',
      confidence: 'high',
      citations: [],
      primarySourceUrl: 'https://www.sqlite.org/about.html',
      primarySourceDomain: 'sqlite.org',
    };
    await resultsPage(response({ instantAnswer, results: [result(1), result(2, { source: 'hn' }), result(3, { source: 'hn' })] }), {
      'POST /api/inspect': () => page({ title: 'About SQLite' }),
    });
    const answer = byRole('region', 'Answer');
    expect(answer.compareDocumentPosition($('.results')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(textIn(answer)).toContain('A small, fast SQL database engine in a C library.');

    await click(byRole('button', 'Hacker News 2'));
    expect(queryRole('region', 'Answer')).toBeUndefined();
    expect(rows()).toEqual(['Result 2', 'Result 3']);
    expect($('.status-count')!.textContent).toBe('2 results · 0.4s');
    await click(byRole('button', 'All'));
    expect(byRole('region', 'Answer')).toBeTruthy();
    expect(rows()).toEqual(['Result 1', 'Result 2', 'Result 3']);

    await click(byRole('button', 'Read source'));
    await until(() => $('.sheet h1'));
    expect(sent('POST', '/api/inspect')[0].body).toEqual({ url: 'https://www.sqlite.org/about.html' });
  });

  it('tucks filtered results away behind a count, with the reason each was dropped', async () => {
    await resultsPage(
      response(
        {
          filteredSlop: [
            result(7, { title: '15 Best SQLite Tools (2026)', isSponsored: true, verdict: 'sponsored-ad' }),
            result(8, { title: 'SQLite, again', demotedReason: '3rd result from site1.example' }),
            result(9, { title: 'SQLite explained', verdict: 'slop-farm' }),
          ],
        },
        { sponsoredRemovedCount: 1, demotedDuplicateDomainsCount: 2 }
      )
    );
    const toggle = byRole('button', '3 hidden · 1 sponsored · 2 repeats');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect($('.filtered-list')).toBeNull();
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect($$('.filtered-row').map((r) => [nameOf($('a', r)!), $('.why', r)!.textContent])).toEqual([
      ['15 Best SQLite Tools (2026)', 'sponsored'],
      ['SQLite, again', '3rd result from site1.example'],
      ['SQLite explained', 'slop farm'],
    ]);
    expect($$<HTMLAnchorElement>('.filtered-row a').map((a) => [a.getAttribute('href'), a.target])).toEqual([
      ['https://site7.example/notes/page-7', '_blank'],
      ['https://site8.example/notes/page-8', '_blank'],
      ['https://site9.example/notes/page-9', '_blank'],
    ]);
    await click(toggle);
    expect($('.filtered-list')).toBeNull();
  });

  it('counts a single repeat in the singular, and leaves out counts that are zero', async () => {
    await resultsPage(response({ filteredSlop: [result(8)] }, { demotedDuplicateDomainsCount: 1 }));
    expect(byRole('button', '1 hidden · 1 repeat')).toBeTruthy();
  });

  it('says when nothing is left to show', async () => {
    await resultsPage(response({ results: [] }));
    expect(textIn($('.results-wrap')!)).toContain('Nothing here. Try another scope, or one of the engines below.');
    expect($('.status-count')!.textContent).toBe('0 results · 0.4s');
  });

  it('says the same when every result is from a site you hid', async () => {
    localStorage.setItem('glogg.blocked', JSON.stringify(['site1.example', 'site2.example', 'site3.example']));
    await resultsPage(response());
    expect(rows()).toEqual([]);
    expect(textIn()).toContain('Nothing here. Try another scope, or one of the engines below.');
    expect(sent('POST', '/api/search')[0].body.config.blockedDomains).toEqual(['site1.example', 'site2.example', 'site3.example']);
  });

  it('adds results that arrive late below the ones on screen, without reordering them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await resultsPage((_c, n) =>
      n === 1
        ? response({ results: [result(1), result(2)] }, { sourceTimings: { wiki: { ms: 300, count: 2, status: 'ok' }, marginalia: { ms: 1000, count: 0, status: 'late' } } })
        : response({ results: [result(3), result(1), result(2)] }, { sourceTimings: { wiki: { ms: 300, count: 2, status: 'ok' }, marginalia: { ms: 1400, count: 1, status: 'ok' } } })
    );
    expect(rows()).toEqual(['Result 1', 'Result 2']);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(sent('POST', '/api/search')).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await until(() => rows().length === 3, 'the late result');
    expect(rows()).toEqual(['Result 1', 'Result 2', 'Result 3']);
    expect($('.status-count')!.textContent).toBe('3 results · 0.4s');
    const [first, second] = sent('POST', '/api/search');
    expect(second.body).toEqual(first.body);
  });

  it('fills in an instant answer that missed the first response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const late = { ms: 1000, count: 0, status: 'late' as const };
    await resultsPage((_c, n) =>
      n === 1
        ? response({}, { sourceTimings: { answer: late } })
        : response({ instantAnswer: { kind: 'direct-fact', title: 'SQLite', directAnswer: 'An embedded database.', confidence: 'high', citations: [] } })
    );
    expect(queryRole('region', 'Answer')).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(2600));
    await until(() => queryRole('region', 'Answer'), 'the late answer');
    expect(textIn(byRole('region', 'Answer'))).toContain('An embedded database.');
  });

  it('does not ask again when every source answered in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await resultsPage(response());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(sent('POST', '/api/search')).toHaveLength(1);
  });

  it('hides a site at once and leaves it out of later searches', async () => {
    await resultsPage(response());
    const second = $$('.result')[1];
    await click(byRole('button', 'More actions', second));
    await click(byRole('menuitem', 'Hide site2.example', second));
    expect(rows()).toEqual(['Result 1', 'Result 3']);
    expect(toasts()).toContain('Hidden site2.example');
    expect(JSON.parse(localStorage.getItem('glogg.blocked')!)[0]).toBe('site2.example');

    await type(byRole('textbox', 'Search'), 'sqlite wal');
    await submit(byRole('textbox', 'Search'));
    await until(() => sent('POST', '/api/search').length === 2);
    expect(sent('POST', '/api/search')[1].body.config.blockedDomains[0]).toBe('site2.example');
  });

  it('prefers a site in later searches', async () => {
    await resultsPage(response());
    await click(byRole('button', 'More actions', $$('.result')[0]));
    await click(byRole('menuitem', 'Prefer site1.example'));
    expect(toasts()).toContain('Preferring site1.example in future searches');
    await type(byRole('textbox', 'Search'), 'sqlite wal');
    await submit(byRole('textbox', 'Search'));
    await until(() => sent('POST', '/api/search').length === 2);
    expect(sent('POST', '/api/search')[1].body.config.boostedDomains[0]).toBe('site1.example');
  });

  it('saves a page to downloads and says where it went, or why it could not', async () => {
    let answer: unknown = { job: job('j1', { target: 'offcloud', status: 'queued', statusDetail: 'Queued' }) };
    await resultsPage(response(), { 'POST /api/downloads': () => answer });
    const save = async () => {
      await click(byRole('button', 'More actions', $$('.result')[0]));
      await click(byRole('menuitem', 'Save page'));
      await flush();
    };
    await save();
    expect(sent('POST', '/api/downloads')[0].body).toEqual({ url: 'https://site1.example/notes/page-1', title: 'Result 1', target: 'auto' });
    expect(toasts()).toContain('Sent to Offcloud');

    answer = { job: job('j2', { target: 'offcloud', status: 'failed', statusDetail: 'Offcloud key missing' }) };
    await save();
    expect(toasts()).toContain('Offcloud: Offcloud key missing');

    answer = reply(507, { error: 'Disk full' });
    await save();
    expect(toasts()).toContain('Auto: Disk full');
  });

  it('sends a torrent with its size, and points to the torrent list when releases match', async () => {
    const t = torrent(4);
    await resultsPage(
      (c) => (c.body.config.lens === 'p2p-magnet' ? response({ lens: 'p2p-magnet', results: [t], p2pResults: [t] }) : response({ results: [result(1), result(2), result(3), t] })),
      { 'POST /api/downloads': () => ({ job: job('j1', { target: 'aria2-rpc', status: 'downloading' }) }) }
    );
    await click(byRole('button', 'Send', $$('.result')[3]));
    await flush();
    expect(sent('POST', '/api/downloads')[0].body).toEqual({ url: t.p2p!.magnetUri, title: t.title, target: 'auto', sizeFormatted: '3.7 GB' });
    expect(toasts()).toContain('Sent to aria2');

    const banner = byRole('button', /1 torrent or NZB matches this/);
    expect(banner.compareDocumentPosition($$('.result')[3]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(banner);
    await until(() => $('.releases'));
    expect(sent('POST', '/api/search')[1].body.config.lens).toBe('p2p-magnet');
    expect(window.location.search).toBe('?q=sqlite%20internals&scope=p2p-magnet');
    expect($$('.release-title').map((r) => r.textContent)).toEqual([t.title]);
  });

  it('opens a result in the reader, and Escape closes it with focus still on its Read button', async () => {
    await resultsPage(response(), { 'POST /api/inspect': () => page({ title: 'Page one, clean' }) });
    const read = byRole('button', 'Read', $$('.result')[0]);
    read.focus();
    await click(read);
    await until(() => $('.sheet h1'));
    expect(byRole('dialog', 'Reader')).toBeTruthy();
    expect(sent('POST', '/api/inspect')[0].body).toEqual({ url: 'https://site1.example/notes/page-1' });
    await press('Escape');
    expect(queryRole('dialog', 'Reader')).toBeUndefined();
    expect(document.activeElement).toBe(read);
  });

  it('names every control on the page', async () => {
    await resultsPage(response({ results: [result(1), torrent(2)], filteredSlop: [result(8)] }));
    expect(unnamed()).toEqual([]);
  });
});

// ── Search box ────────────────────────────────────────────────────────────────
const TOOL_PLUGINS: PluginInfo[] = [
  plugin({
    id: 'utils',
    name: 'Utilities',
    tools: [
      { id: 'hash', name: 'Hash', description: 'Hashes text', trigger: 'hash', inputs: [{ key: 'text', label: 'Text', type: 'textarea', required: true }] },
      { id: 'uuid', name: 'UUIDs', description: 'Makes UUIDs', trigger: 'uuid', inputs: [{ key: 'count', label: 'Count', type: 'number', default: 5 }] },
    ],
  }),
  plugin({
    id: 'osint',
    name: 'OSINT',
    category: 'osint',
    tools: [{ id: 'dns', name: 'DNS records', description: 'Looks up DNS', trigger: 'dns', inputs: [{ key: 'domain', label: 'Domain', required: true }] }],
  }),
];
const TOOLS = indexTools(TOOL_PLUGINS);

describe('search box', () => {
  function Box({ onSubmit, initial = '', ...rest }: { onSubmit: (q: string) => void; initial?: string; customBangs?: BangDefinition[]; busy?: boolean; uncensored?: boolean }) {
    const [value, setValue] = useState(initial);
    return <SearchBox value={value} onChange={setValue} onSubmit={onSubmit} customBangs={rest.customBangs ?? []} tools={TOOLS} busy={rest.busy} uncensored={rest.uncensored} />;
  }

  async function box(props: Partial<React.ComponentProps<typeof Box>> = {}) {
    const onSubmit = vi.fn();
    await mount(<Box onSubmit={onSubmit} {...props} />);
    return { onSubmit, input: byRole('textbox', 'Search') as HTMLInputElement };
  }

  const triggers = () => $$('[role="option"] .mono').map((m) => m.textContent);
  const highlighted = () => $('[role="option"][aria-selected="true"] .mono')?.textContent;

  it('suggests bangs after "!": the exact trigger first, then triggers that start with it', async () => {
    const { input } = await box();
    await type(input, '!g');
    expect(byRole('listbox')).toBeTruthy();
    expect(triggers().slice(0, 2)).toEqual(['!g', '!gh']);
    expect(triggers()).toHaveLength(7);
    expect(highlighted()).toBe('!g');
    expect(textIn($('[role="option"]')!)).toContain('Google (udm=14, no AI)');
  });

  it('moves through the suggestions with the arrow keys, wrapping at both ends', async () => {
    const { input } = await box();
    await type(input, '!g');
    const all = triggers();
    await press('ArrowDown', input);
    expect(highlighted()).toBe(all[1]);
    await press('ArrowUp', input);
    await press('ArrowUp', input);
    expect(highlighted()).toBe(all[6]);
    await press('ArrowDown', input);
    expect(highlighted()).toBe(all[0]);
  });

  it('completes the highlighted bang with Tab, keeping the words before it', async () => {
    const { input, onSubmit } = await box();
    await type(input, 'sqlite !g');
    await press('ArrowDown', input);
    await press('Tab', input);
    expect(input.value).toBe('sqlite !gh ');
    expect($('[role="listbox"]')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('completes a partial bang on Enter instead of searching', async () => {
    const { input, onSubmit } = await box();
    await type(input, '!gi');
    expect(triggers()).toEqual(['!k', '!mg', '!gh']);
    await submit(input);
    expect(input.value).toBe('!k ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('searches at once with a complete bang, at either end, and says where it will go', async () => {
    const { input, onSubmit } = await box();
    await type(input, '!w turing');
    expect($('[role="listbox"]')).toBeNull();
    const hint = $('.searchbox-bang')!;
    expect(hint.textContent?.trim()).toBe('Wikipedia');
    expect(hint.title).toBe('https://en.wikipedia.org/w/index.php?search=turing');
    await submit(input);
    expect(onSubmit).toHaveBeenLastCalledWith('!w turing');

    await type(input, 'turing !w');
    expect(highlighted()).toBe('!w');
    await submit(input);
    expect(onSubmit).toHaveBeenLastCalledWith('turing !w');
  });

  it('puts your own bang first when it shares a trigger with a built-in', async () => {
    const { input } = await box({ customBangs: [{ trigger: 'w', name: 'Team wiki', url: 'https://wiki.example/?q={q}', category: 'reference' }] });
    await type(input, '!w');
    expect(textIn($('[role="option"]')!)).toContain('Team wiki');
    await type(input, '!w onboarding');
    expect($('.searchbox-bang')!.title).toBe('https://wiki.example/?q=onboarding');
  });

  it('suggests tools after ">", completes one that needs input, and runs one that does not', async () => {
    const { input, onSubmit } = await box();
    await type(input, '>');
    expect(byRole('listbox', 'Tools')).toBeTruthy();
    expect(triggers()).toEqual(['>dns', '>hash', '>uuid']);
    expect(textIn($('[role="option"]')!)).toContain('DNS records');

    await type(input, '>ha');
    await press('Tab', input);
    expect(input.value).toBe('>hash ');

    await type(input, '>hash');
    await submit(input);
    expect(input.value).toBe('>hash ');
    expect(onSubmit).not.toHaveBeenCalled();

    await type(input, '>uuid');
    await submit(input);
    expect(onSubmit).toHaveBeenLastCalledWith('>uuid');

    await type(input, '>dns example.com');
    expect($('[role="listbox"]')).toBeNull();
    expect($('.searchbox-bang')!.textContent?.trim()).toBe('DNS records');
    await submit(input);
    expect(onSubmit).toHaveBeenLastCalledWith('>dns example.com');
  });

  it('picks a suggestion with the mouse', async () => {
    const { input } = await box();
    await type(input, '!g');
    const third = $$('[role="option"]')[2];
    await mouse('mouseover', third);
    await flush(1);
    expect(third.getAttribute('aria-selected')).toBe('true');
    await mouse('mousedown', third);
    await flush(1);
    expect(input.value).toBe('!ddg ');
  });

  it('picks a tool suggestion with the mouse', async () => {
    const { input } = await box();
    await type(input, '>');
    const uuid = $$('[role="option"]')[2];
    await mouse('mouseover', uuid);
    await flush(1);
    expect(highlighted()).toBe('>uuid');
    await mouse('mousedown', uuid);
    await flush(1);
    expect(input.value).toBe('>uuid ');
  });

  it('closes the suggestions on Escape', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { input } = await box();
    await type(input, '!g');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect($('[role="listbox"]')).toBeTruthy();
    await press('Escape', input);
    expect(document.activeElement).not.toBe(input);
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect($('[role="listbox"]')).toBeNull();
    expect(input.value).toBe('!g');
  });

  it('clears the box, and shows a spinner while busy and a marker in 18+ mode', async () => {
    const { input } = await box({ initial: 'sqlite' });
    await click(byRole('button', 'Clear'));
    expect(input.value).toBe('');
    await mount(<Box onSubmit={vi.fn()} initial="sqlite" busy uncensored />);
    const busy = roots[1].host;
    expect($('[aria-label="Searching"]', busy)).toBeTruthy();
    expect(queryRole('button', 'Clear', busy)).toBeUndefined();
    expect(textIn(busy)).toContain('18+');
  });

  it('is a search landmark whose box and tool list are labelled', async () => {
    const { input } = await box();
    expect(input.closest('[role="search"]')).toBeTruthy();
    await type(input, '>');
    expect(byRole('listbox', 'Tools')).toBeTruthy();
    expect(unnamed()).toEqual([]);
  });
});

// ── Command palette ─────────────────────────────────────────────────────────
describe('command palette', () => {
  const commands = (): PaletteCommand[] => [
    { id: 'v-home', label: 'New search', group: 'Go to', hint: 'home', run: vi.fn() },
    { id: 'v-dl', label: 'Downloads', group: 'Go to', keywords: 'aria2 offcloud queue', run: vi.fn() },
    { id: 'm-mode', label: 'Advanced view', group: 'View', hint: 'm', run: vi.fn() },
    { id: 't-theme', label: 'Dark theme', group: 'Toggle', run: vi.fn() },
  ];

  async function palette(list = commands(), customBangs: BangDefinition[] = []) {
    const onSearch = vi.fn();
    const onClose = vi.fn();
    await mount(<CommandPalette commands={list} customBangs={customBangs} onSearch={onSearch} onClose={onClose} />);
    return { list, onSearch, onClose, input: $<HTMLInputElement>('.palette input')! };
  }

  const labels = () => $$('[role="option"]').map((o) => o.firstChild!.textContent);
  const highlighted = () => $('[role="option"][aria-selected="true"]')?.firstChild?.textContent;

  it('opens focused, with every command under its group and the first one highlighted', async () => {
    const { input } = await palette();
    expect(document.activeElement).toBe(input);
    expect($$('.palette-group').map((g) => g.textContent)).toEqual(['Go to', 'View', 'Toggle']);
    expect(labels()).toEqual(['New search', 'Downloads', 'Advanced view', 'Dark theme']);
    expect(highlighted()).toBe('New search');
    expect($$('.palette-hint').map((h) => h.textContent)).toEqual(['home', 'm']);
  });

  it('filters by name, group and keywords, ignoring case, with a plain search on top', async () => {
    const { input } = await palette();
    await type(input, 'QUEUE');
    expect(labels()).toEqual(['Search “QUEUE”', 'Downloads']);
    await type(input, 'toggle');
    expect(labels()).toEqual(['Search “toggle”', 'Dark theme']);
    await type(input, 'nothing like it');
    expect(labels()).toEqual(['Search “nothing like it”']);
  });

  it('searches for what you typed with Enter', async () => {
    const { input, onSearch, onClose } = await palette();
    await type(input, '  sqlite wal  ');
    await press('Enter', input);
    expect(onClose).toHaveBeenCalled();
    expect(onSearch).toHaveBeenCalledWith('sqlite wal');
  });

  it('says when there is nothing to run, and then does nothing on Enter', async () => {
    const { input, onClose, onSearch } = await palette([]);
    expect(textIn($('.palette-list')!)).toBe('Nothing matches.');
    await press('Enter', input);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('jumps to a bang with the rest of what you typed', async () => {
    const { input, onSearch } = await palette(commands(), [{ trigger: 'tw', name: 'Team wiki', url: 'https://wiki.example/?q={q}', category: 'reference' }]);
    await type(input, '!gh react hooks');
    expect(labels()).toEqual(['Search “!gh react hooks”', '!gh  GitHub']);
    expect($$('.palette-hint').map((h) => h.textContent)).toEqual(['“react hooks”']);
    await press('ArrowDown', input);
    await press('Enter', input);
    expect(onSearch).toHaveBeenCalledWith('!gh react hooks');

    await type(input, '!tw');
    expect(labels()).toContain('!tw  Team wiki');
    expect($$('.palette-hint').map((h) => h.textContent)).toContain('type a query after the bang');
    await type(input, '!hacker');
    expect(labels()).toContain('!hn  Hacker News');
  });

  it('moves the highlight with the arrow keys, stopping at the ends, and runs it with Enter', async () => {
    const { input, list, onClose } = await palette();
    await press('ArrowUp', input);
    expect(highlighted()).toBe('New search');
    for (let i = 0; i < 6; i++) await press('ArrowDown', input);
    expect(highlighted()).toBe('Dark theme');
    await press('Enter', input);
    expect(list[3].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(list.slice(0, 3).every((c) => (c.run as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
  });

  it('starts from the top again when the text changes', async () => {
    const { input } = await palette();
    await press('ArrowDown', input);
    await press('ArrowDown', input);
    await type(input, 'e');
    expect(highlighted()).toBe('Search “e”');
  });

  it('highlights a command on hover and runs it on click', async () => {
    const { list } = await palette();
    const third = $$('[role="option"]')[2];
    await mouse('mouseover', third);
    await flush(1);
    expect(highlighted()).toBe('Advanced view');
    await mouse('mousedown', third);
    expect(list[2].run).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape or a click outside it', async () => {
    const { input, onClose } = await palette();
    await press('Escape', input);
    expect(onClose).toHaveBeenCalledTimes(1);
    await click($('.scrim'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('is a labelled dialog whose options all have names', async () => {
    await palette();
    expect(byRole('dialog', 'Command palette')).toBeTruthy();
    expect(rolesNamed('option')).toHaveLength(4);
    expect(nameOf($<HTMLInputElement>('.palette input')!)).toBe('Search, jump with !bang, or run a command…');
  });
});

// ── Tool kit: inline card, forms, output ────────────────────────────────────
describe('tool card', () => {
  const hash = TOOLS.find((t) => t.tool.id === 'hash')!;
  const handlers = () => ({ onSend: vi.fn(), onRunTool: vi.fn(), onCopied: vi.fn() });

  it('shows a tool running, then its output, with a way into the Tools page', async () => {
    const onOpen = vi.fn();
    const h = handlers();
    await mount(<ToolCard run={{ query: '>hash abc', ref: hash, input: { text: 'abc' }, loading: true }} handlers={h} onOpenInTools={onOpen} />);
    const card = byRole('region', 'Hash result');
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(textIn(card)).toContain('Running Hash…');
    expect(textIn(card)).toContain('Utilities');
    await rerender(
      <ToolCard
        run={{ query: '>hash abc', ref: hash, input: { text: 'abc' }, loading: false, result: { blocks: [{ type: 'kv', items: [{ label: 'SHA256', value: 'ba7816bf8f01cfea' }] }] } }}
        handlers={h}
        onOpenInTools={onOpen}
      />
    );
    expect(card.getAttribute('aria-busy')).toBe('false');
    expect(textIn(card)).toContain('SHA256');
    await click(byRole('button', 'Open in Tools'));
    expect(onOpen).toHaveBeenCalled();
  });

  it("shows a tool's error", async () => {
    await mount(<ToolCard run={{ query: '>hash', ref: hash, input: {}, loading: false, error: 'Text is required' }} handlers={handlers()} onOpenInTools={vi.fn()} />);
    expect(textIn($('.notice')!)).toBe('Text is required');
  });

  it('explains an unknown trigger and offers the tools there are', async () => {
    const onPick = vi.fn();
    await mount(
      <ToolCard
        run={{ query: '>nope x', input: {}, loading: false, error: 'No tool uses >nope. Try one of these:' }}
        handlers={handlers()}
        onOpenInTools={vi.fn()}
        suggestions={TOOLS}
        onPick={onPick}
      />
    );
    const card = byRole('region', 'Tool');
    expect(textIn(card)).toContain('Unknown tool');
    expect(queryRole('button', 'Open in Tools')).toBeUndefined();
    expect(rolesNamed('button', card)).toEqual(['>hash Hash', '>uuid UUIDs', '>dns DNS records']);
    await click(byRole('button', '>dns DNS records'));
    expect(onPick).toHaveBeenCalledWith(TOOLS[2]);
  });
});

describe('tool forms', () => {
  const FIELDS = [
    { key: 'domain', label: 'Domain', required: true, help: 'Without https://', placeholder: 'example.com' },
    { key: 'site', label: 'Site', type: 'url' as const },
    { key: 'count', label: 'Count', type: 'number' as const },
    { key: 'key', label: 'Key', type: 'password' as const },
    { key: 'token', label: 'Token', secret: true },
    { key: 'notes', label: 'Notes', type: 'textarea' as const },
    { key: 'mode', label: 'Mode', type: 'select' as const, options: [{ value: 'hex', label: 'Hex' }, { value: 'b64', label: 'Base64' }] },
    { key: 'strict', label: 'Strict', type: 'toggle' as const },
  ];

  function Form({ busy, submitLabel, onSubmit, onChange }: { busy?: boolean; submitLabel?: string; onSubmit: () => void; onChange: (k: string, v: unknown) => void }) {
    const [values, setValues] = useState<Record<string, unknown>>({ mode: 'hex', strict: 'true' });
    return (
      <ToolForm
        fields={FIELDS}
        values={values}
        onChange={(k, v) => {
          onChange(k, v);
          setValues((x) => ({ ...x, [k]: v }));
        }}
        onSubmit={onSubmit}
        busy={busy}
        submitLabel={submitLabel}
      />
    );
  }

  it('labels every field by its name, marks required ones, and shows help', async () => {
    await mount(<Form onSubmit={vi.fn()} onChange={vi.fn()} />);
    expect(unnamed()).toEqual([]);
    expect(byLabel('Domain').labels![0].textContent).toBe('Domain *');
    expect(byLabel('Domain').required).toBe(true);
    expect(byLabel('Domain').placeholder).toBe('example.com');
    expect(textIn()).toContain('Without https://');
    expect(byLabel('Count').type).toBe('number');
    expect(byLabel('Key').type).toBe('password');
    expect(byLabel('Token').type).toBe('password');
    expect(byLabel('Site').type).toBe('text');
    expect(byLabel('Notes').tagName).toBe('TEXTAREA');
    expect([...(byLabel('Mode') as unknown as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Hex', 'Base64']);
    expect(byLabel('Strict').getAttribute('role')).toBe('switch');
  });

  it('reports each change with the field it belongs to', async () => {
    const onChange = vi.fn();
    await mount(<Form onSubmit={vi.fn()} onChange={onChange} />);
    await type(byLabel('Domain'), 'example.com');
    await type(byLabel('Notes'), 'two\nlines');
    await type(byLabel('Mode'), 'b64');
    expect(byLabel('Strict').getAttribute('aria-checked')).toBe('true');
    await click(byLabel('Strict'));
    expect(onChange.mock.calls).toEqual([
      ['domain', 'example.com'],
      ['notes', 'two\nlines'],
      ['mode', 'b64'],
      ['strict', false],
    ]);
    expect(byLabel('Strict').getAttribute('aria-checked')).toBe('false');
  });

  it('submits with Enter, and says it is running while busy', async () => {
    const onSubmit = vi.fn();
    await mount(<Form onSubmit={onSubmit} onChange={vi.fn()} />);
    await type(byLabel('Domain'), 'example.com');
    await submit(byLabel('Domain'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await rerender(<Form busy onSubmit={onSubmit} onChange={vi.fn()} />);
    const run = byRole('button', 'Running…') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    await rerender(<Form busy submitLabel="Save" onSubmit={onSubmit} onChange={vi.fn()} />);
    expect((byRole('button', 'Save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('tool output', () => {
  const handlers = () => ({ onSend: vi.fn(), onRunTool: vi.fn(), onCopied: vi.fn() });

  it('opens links in a new tab, sends to downloads, runs another tool, and copies', async () => {
    const h = handlers();
    const result: ToolResult = {
      blocks: [
        {
          type: 'list',
          items: [
            {
              title: 'example.com',
              subtitle: 'A record',
              href: 'https://example.com/',
              badge: 'live',
              actions: [
                { label: 'Open', href: 'https://example.com/' },
                { label: 'Send', send: { url: MAGNET, title: 'debian' } },
                { label: 'WHOIS', run: { tool: 'osint/whois', inputs: { domain: 'example.com' } } },
                { label: 'Copy IP', copy: '192.0.2.1' },
              ],
            },
          ],
        },
        { type: 'actions', items: [{ label: 'Copy all', copy: 'everything' }] },
      ],
    };
    await mount(<ToolOutput result={result} handlers={h} />);
    const title = byRole('link', 'example.com');
    expect([title.getAttribute('href'), title.getAttribute('target')]).toEqual(['https://example.com/', '_blank']);
    const open = byRole('link', 'Open');
    expect(open.getAttribute('rel')).toBe('noreferrer noopener');
    expect(textIn()).toContain('A record');
    expect(textIn()).toContain('live');
    await click(byRole('button', 'Send'));
    expect(h.onSend).toHaveBeenCalledWith(MAGNET, 'debian');
    await click(byRole('button', 'WHOIS'));
    expect(h.onRunTool).toHaveBeenCalledWith('osint/whois', { domain: 'example.com' });
    await click(byRole('button', 'Copy IP'));
    await click(byRole('button', 'Copy all'));
    expect(clipboard).toEqual(['192.0.2.1', 'everything']);
    expect(h.onCopied).toHaveBeenCalledTimes(2);
    expect(unnamed()).toEqual([]);
  });

  it('copies long values and code with one click, and links values that have an address', async () => {
    const h = handlers();
    await mount(
      <ToolOutput
        result={{
          blocks: [
            { type: 'kv', title: 'Hashes', items: [{ label: 'SHA256', value: 'ba7816bf8f01cfea414140de5dae2223' }, { label: 'Size', value: '3 B' }, { label: 'Site', value: 'example.com', href: 'https://example.com' }] },
            { type: 'code', content: 'dig +short example.com' },
          ],
        }}
        handlers={h}
      />
    );
    expect($('h4')!.textContent).toBe('Hashes');
    const copies = $$('button[aria-label="Copy"]');
    expect(copies).toHaveLength(3);
    for (const c of copies) await click(c);
    expect(clipboard).toEqual(['ba7816bf8f01cfea414140de5dae2223', 'example.com', 'dig +short example.com']);
    expect(h.onCopied).toHaveBeenCalledTimes(3);
    expect(byRole('link', 'example.com').getAttribute('href')).toBe('https://example.com');
  });

  it('says whether each check passed, failed or does not apply', async () => {
    await mount(
      <ToolOutput
        result={{ blocks: [{ type: 'checks', items: [{ label: 'HTTPS', pass: true }, { label: 'CSP', pass: false, detail: 'missing' }, { label: 'HSTS preload', pass: null }] }] }}
        handlers={handlers()}
      />
    );
    expect($$('.checks li').map((li) => [$('.check-icon', li)!.getAttribute('aria-label'), $('.check-label', li)!.textContent, $('.check-detail', li)?.textContent ?? ''])).toEqual([
      ['Pass', 'HTTPS', ''],
      ['Fail', 'CSP', 'missing'],
      ['Not applicable', 'HSTS preload', ''],
    ]);
  });
});

// ── Tools page ────────────────────────────────────────────────────────────────
const VIEW_PLUGINS: PluginInfo[] = [
  plugin({
    id: 'realdebrid',
    name: 'Real-Debrid',
    category: 'debrid',
    description: 'Premium links and cached torrents',
    configured: false,
    settings: [{ key: 'apiToken', label: 'API token', secret: true, required: true, help: 'From real-debrid.com/apitoken' }],
    tools: [{ id: 'user', name: 'Account', description: 'Your plan and when it ends', requiresSettings: true, inputs: [] }],
  }),
  plugin({
    id: 'nextcloud',
    name: 'Nextcloud',
    category: 'storage',
    description: 'Your own cloud',
    configured: false,
    tools: [{ id: 'list', name: 'Files', description: 'List a folder', requiresSettings: true, inputs: [{ key: 'path', label: 'Path' }] }],
  }),
  plugin({
    id: 'osint',
    name: 'OSINT',
    category: 'osint',
    description: 'Lookups about domains',
    tools: [
      { id: 'dns', name: 'DNS records', description: 'A, AAAA, MX and TXT records', trigger: 'dns', inputs: [{ key: 'domain', label: 'Domain', required: true }] },
      { id: 'whois', name: 'WHOIS', description: 'Who registered it', trigger: 'whois', inputs: [{ key: 'domain', label: 'Domain', required: true }] },
    ],
  }),
  plugin({
    id: 'utils',
    name: 'Utilities',
    category: 'utility',
    description: 'Local helpers',
    source: 'user',
    homepage: 'https://example.com/utils',
    tools: [{ id: 'uuid', name: 'UUIDs', description: 'Random UUIDs', trigger: 'uuid', inputs: [] }],
  }),
  plugin({ id: 'broken', name: 'Broken', error: 'SyntaxError: Unexpected token' }),
];

const SABNZBD = plugin({
  id: 'sabnzbd',
  name: 'SABnzbd',
  category: 'usenet',
  description: 'Self-hosted Usenet downloader',
  configured: true,
  values: { url: 'http://localhost:8085', apiKey: '••••abcd' },
  settings: [
    { key: 'url', label: 'URL', default: 'http://localhost:8085', placeholder: 'http://localhost:8085' },
    { key: 'apiKey', label: 'API key', secret: true, required: true, help: 'SABnzbd → Config → General → API Key' },
  ],
  container: { image: 'lscr.io/linuxserver/sabnzbd:latest', webUrl: 'http://localhost:8085' },
  tools: [
    { id: 'queue', name: 'Queue', description: 'What is downloading right now', requiresSettings: true, inputs: [] },
    { id: 'add', name: 'Add NZB', description: 'Queue an NZB by URL', trigger: 'sab', requiresSettings: true, inputs: [{ key: 'url', label: 'NZB URL', required: true }] },
  ],
});

describe('tools page', () => {
  async function toolsView(opts: { plugins?: PluginInfo[] | null; target?: ToolsTarget | null; onReload?: () => Promise<void>; routes?: Record<string, unknown> } = {}) {
    serve(opts.routes ?? {});
    const p = {
      onReload: opts.onReload ?? vi.fn(async () => undefined),
      onChanged: vi.fn(),
      onToast: vi.fn(),
      handlers: { onSend: vi.fn(), onCopied: vi.fn() },
      onOpenSettings: vi.fn(),
    };
    await mount(<ToolsView plugins={opts.plugins === undefined ? VIEW_PLUGINS : opts.plugins} userDir="/home/ada/.glogg/plugins" target={opts.target ?? null} {...p} />);
    return p;
  }

  const nav = () => byRole('navigation', 'Plugins');
  const heading = () => $('.tools-main h2')?.textContent;

  it('shows a placeholder until the plugins arrive', async () => {
    await toolsView({ plugins: null });
    expect($('[aria-busy="true"][aria-label="Loading tools"]')).toBeTruthy();
    expect($('h1')).toBeNull();
  });

  it('groups plugins by category, marks the ones that need setup, and lists the ones that failed to load', async () => {
    await toolsView();
    expect($$('.tools-group-title', nav()).map((t) => t.textContent)).toEqual(['Debrid', 'Cloud storage', 'OSINT', 'Utilities', "Didn't load"]);
    expect(rolesNamed('button', nav())).toEqual(['Real-Debrid', 'Nextcloud', 'OSINT', 'Utilities']);
    expect($$('.tools-item', nav()).filter((b) => $('[title="Needs setup"]', b)).map((b) => b.textContent)).toEqual(['Real-Debrid', 'Nextcloud']);
    const broken = $('.tools-item.broken', nav())!;
    expect([broken.textContent, broken.title]).toEqual(['broken', 'SyntaxError: Unexpected token']);
    expect(textIn($('.tools-foot')!)).toContain('/home/ada/.glogg/plugins');
  });

  it('opens on the first plugin that works without setup', async () => {
    await toolsView();
    expect(heading()).toBe('OSINT');
    expect(textIn($('.plugin-badges')!)).toBe('Ready');
    expect(byRole('button', 'OSINT', nav()).getAttribute('aria-current')).toBe('true');
    expect(byRole('button', 'Real-Debrid', nav()).getAttribute('aria-current')).toBe('false');
  });

  it("filters plugins by name, tool, trigger or description, and says when nothing matches", async () => {
    await toolsView();
    await type(byRole('textbox', 'Filter tools'), 'whois');
    expect(rolesNamed('button', nav())).toEqual(['OSINT']);
    await type(byRole('textbox', 'Filter tools'), 'random uuids');
    expect(rolesNamed('button', nav())).toEqual(['Utilities']);
    await type(byRole('textbox', 'Filter tools'), 'gopher');
    expect(rolesNamed('button', nav())).toEqual([]);
    expect(textIn(nav())).toContain('No tool matches “gopher”.');
  });

  it('runs a tool from its form, says it is running, and shows what it found', async () => {
    const answer = deferred();
    await toolsView({ routes: { 'POST /api/plugins/osint/tools/dns': () => answer.promise } });
    expect(rolesNamed('tab', byRole('tablist', 'OSINT tools'))).toEqual(['DNS records', 'WHOIS']);
    expect(byRole('tab', 'DNS records').getAttribute('aria-selected')).toBe('true');
    expect($('.tool-desc')!.firstChild!.textContent).toBe('A, AAAA, MX and TXT records');
    expect(textIn($('.tool-trigger')!)).toBe('Shortcut >dns');
    expect(document.activeElement).toBe(byLabel('Domain'));
    await type(byLabel('Domain'), 'example.com');
    await submit(byLabel('Domain'));
    expect(sent('POST', '/api/plugins/osint/tools/dns')[0].body).toEqual({ input: { domain: 'example.com' } });
    expect((byRole('button', 'Running…') as HTMLButtonElement).disabled).toBe(true);
    answer.resolve(reply(200, { blocks: [{ type: 'table', columns: ['Type', 'Value'], rows: [['A', '93.184.215.14']] }] }));
    await until(() => $('table'));
    expect($$('td').map((td) => td.textContent)).toEqual(['A', '93.184.215.14']);
    expect((byRole('button', 'Run') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows why a tool failed', async () => {
    await toolsView({ routes: { 'POST /api/plugins/osint/tools/dns': () => reply(502, { error: 'Lookup failed: SERVFAIL' }) } });
    await type(byLabel('Domain'), 'example.com');
    await submit(byLabel('Domain'));
    await until(() => $('.notice'));
    expect(textIn($('.notice')!)).toBe('Lookup failed: SERVFAIL');
  });

  it('runs a tool without inputs in one click, and marks a plugin of your own', async () => {
    await toolsView({ routes: { 'POST /api/plugins/utils/tools/uuid': { blocks: [{ type: 'code', content: '1b4e28ba-2fa1-11d2-883f-0016d3cca427' }] } } });
    await click(byRole('button', 'Utilities', nav()));
    expect(heading()).toBe('Utilities');
    expect(queryRole('tablist', 'Utilities tools')).toBeUndefined();
    expect(textIn($('.plugin-badges')!)).toContain('Yours');
    expect(byRole('link', 'Site').getAttribute('href')).toBe('https://example.com/utils');
    await click(byRole('button', 'Run'));
    expect(sent('POST', '/api/plugins/utils/tools/uuid')[0].body).toEqual({ input: {} });
    await until(() => $('pre code'));
    expect($('pre code')!.textContent).toBe('1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  });

  it("keeps what you typed in each of a plugin's tools when you switch between them", async () => {
    await toolsView();
    await type(byLabel('Domain'), 'a.example');
    await click(byRole('tab', 'WHOIS'));
    expect(byRole('tab', 'WHOIS').getAttribute('aria-selected')).toBe('true');
    expect(byLabel('Domain').value).toBe('');
    await type(byLabel('Domain'), 'b.example');
    await click(byRole('tab', 'DNS records'));
    expect(byLabel('Domain').value).toBe('a.example');
  });

  it('asks for settings before a tool that needs them, and saves them', async () => {
    let configured = true;
    const p = await toolsView({ routes: { 'PUT /api/plugins/realdebrid/settings': () => ({ configured }) } });
    await click(byRole('button', 'Real-Debrid', nav()));
    expect(textIn($('.plugin-badges')!)).toBe('Needs setup');
    expect(textIn($('.tool-pane .notice')!)).toBe('Add your Real-Debrid settings below to use this.');
    expect($<HTMLDetailsElement>('details.plugin-settings')!.open).toBe(true);
    const token = byLabel('API token');
    expect(token.type).toBe('password');
    expect(textIn($('details.plugin-settings')!)).toContain('From real-debrid.com/apitoken');
    await type(token, 'RDTOKEN');
    await submit(token);
    expect(sent('PUT', '/api/plugins/realdebrid/settings')[0].body).toEqual({ values: { apiToken: 'RDTOKEN' } });
    expect(p.onToast).toHaveBeenLastCalledWith('Real-Debrid is ready', 'ok');
    expect(p.onChanged).toHaveBeenCalledTimes(1);

    configured = false;
    await type(byLabel('API token'), 'other');
    await submit(byLabel('API token'));
    expect(p.onToast).toHaveBeenLastCalledWith('Real-Debrid settings saved', 'ok');
  });

  it('says when settings could not be saved', async () => {
    const p = await toolsView({ routes: { 'PUT /api/plugins/realdebrid/settings': () => reply(400, { error: 'API token is not valid' }) } });
    await click(byRole('button', 'Real-Debrid', nav()));
    await type(byLabel('API token'), 'nope');
    await submit(byLabel('API token'));
    expect(p.onToast).toHaveBeenLastCalledWith('API token is not valid', 'error');
    expect(p.onChanged).not.toHaveBeenCalled();
    expect((byRole('button', 'Save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends you to Settings for a plugin that is set up there', async () => {
    const p = await toolsView();
    await click(byRole('button', 'Nextcloud', nav()));
    expect(textIn($('.tool-pane .notice')!)).toContain('Set up Nextcloud in Settings → Integrations to use this.');
    expect(queryRole('textbox', 'Path')).toBeUndefined();
    await click(byRole('button', 'Open Settings'));
    expect(p.onOpenSettings).toHaveBeenCalled();
  });

  it('says a secret is saved without showing it', async () => {
    await toolsView({ plugins: [SABNZBD], routes: { 'GET /api/plugins/sabnzbd/container': { runtime: 'docker', state: 'running' } } });
    const details = $<HTMLDetailsElement>('details.plugin-settings')!;
    expect(details.open).toBe(false);
    details.open = true;
    await flush(1);
    expect(byLabel('API key').value).toBe('••••abcd');
    expect(textIn(details)).toContain('Saved. Type to replace it, or clear the field to remove it. SABnzbd → Config → General → API Key');
    expect(textIn(details)).toContain('Keys are never sent to the browser.');
  });

  it("starts a plugin's container, then stops or opens it, and removes it once stopped", async () => {
    let state = 'stopped';
    const p = await toolsView({
      plugins: [SABNZBD],
      routes: {
        'GET /api/plugins/sabnzbd/container': () => ({ runtime: 'docker', state }),
        'POST /api/plugins/sabnzbd/container': (c: Call) => {
          state = { up: 'running', down: 'stopped', remove: 'missing' }[c.body.action as string]!;
          return { runtime: 'docker', state, output: '' };
        },
      },
    });
    await until(() => $('.container-info .tag')?.textContent === 'stopped');
    expect(textIn($('.container-info')!)).toContain('lscr.io/linuxserver/sabnzbd:latest');
    expect(rolesNamed('button', $('.container-box')!)).toEqual(['Start', 'Remove']);

    await click(byRole('button', 'Start'));
    expect(sent('POST', '/api/plugins/sabnzbd/container')[0].body).toEqual({ action: 'up' });
    expect(p.onToast.mock.calls).toEqual([
      ['Starting SABnzbd… (first run pulls the image)', 'info'],
      ['SABnzbd: running', 'ok'],
    ]);
    expect(rolesNamed('button', $('.container-box')!)).toEqual(['Stop']);
    expect(byRole('link', 'Open', $('.container-box')!).getAttribute('href')).toBe('http://localhost:8085');

    await click(byRole('button', 'Stop'));
    expect(p.onToast).toHaveBeenLastCalledWith('SABnzbd: stopped', 'ok');
    await click(byRole('button', 'Remove'));
    expect(sent('POST', '/api/plugins/sabnzbd/container').map((c) => c.body.action)).toEqual(['up', 'down', 'remove']);
    expect(p.onToast.mock.calls.map((c) => c[0])).toContain('Removing SABnzbd…');
    expect($('.container-info .tag')!.textContent).toBe('missing');
  });

  it('cannot start a container without a runtime, and says why', async () => {
    const p = await toolsView({
      plugins: [SABNZBD],
      routes: {
        'GET /api/plugins/sabnzbd/container': { runtime: 'none', state: 'unavailable', detail: 'Install Docker or Podman to run this here.' },
        'POST /api/plugins/sabnzbd/container': () => reply(500, { error: 'no runtime' }),
      },
    });
    await until(() => $('.container-info .tag')?.textContent === 'unavailable');
    expect((byRole('button', 'Start') as HTMLButtonElement).disabled).toBe(true);
    expect(textIn($('.plugin-section')!)).toContain('Install Docker or Podman to run this here.');
    expect(p.onToast).not.toHaveBeenCalled();
  });

  it("says when a container action fails, and still offers Start when its status is unknown", async () => {
    const p = await toolsView({
      plugins: [SABNZBD],
      routes: {
        'GET /api/plugins/sabnzbd/container': () => reply(500, { error: 'status unavailable' }),
        'POST /api/plugins/sabnzbd/container': () => reply(500, { error: 'pull access denied for lscr.io/linuxserver/sabnzbd' }),
      },
    });
    expect($('.container-info .tag')!.textContent).toBe('…');
    await click(byRole('button', 'Start'));
    expect(p.onToast).toHaveBeenLastCalledWith('pull access denied for lscr.io/linuxserver/sabnzbd', 'error');
    expect((byRole('button', 'Start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens a link to a tool prefilled and runs it, or shows a result it was given', async () => {
    await toolsView({
      target: { pluginId: 'osint', toolId: 'whois', input: { domain: 'a.example' }, autorun: true },
      routes: { 'POST /api/plugins/osint/tools/whois': { blocks: [{ type: 'notice', content: 'Registered 1995' }] } },
    });
    expect(byRole('tab', 'WHOIS').getAttribute('aria-selected')).toBe('true');
    expect(byLabel('Domain').value).toBe('a.example');
    expect(sent('POST', '/api/plugins/osint/tools/whois')[0].body).toEqual({ input: { domain: 'a.example' } });
    await until(() => $('.notice'));
    expect(textIn($('.notice')!)).toBe('Registered 1995');

    await unmount();
    await toolsView({ target: { pluginId: 'osint', toolId: 'dns', input: { domain: 'b.example' }, result: { blocks: [{ type: 'notice', content: 'From the search box' }] } } });
    expect(textIn($('.notice')!)).toBe('From the search box');
    expect(calls).toEqual([]);
  });

  it('ignores a link to a plugin it does not have', async () => {
    await toolsView({ target: { pluginId: 'gone', toolId: 'x', autorun: true } });
    expect(heading()).toBe('OSINT');
    expect(calls).toEqual([]);
  });

  it("opens a plugin's first tool when a link names a tool it does not have", async () => {
    await toolsView({ target: { pluginId: 'osint', toolId: 'traceroute' } });
    expect(byRole('tab', 'DNS records').getAttribute('aria-selected')).toBe('true');
    expect(calls).toEqual([]);
  });

  it('points to the default plugin folder when the server did not say', async () => {
    serve({});
    await mount(<ToolsView plugins={VIEW_PLUGINS} userDir="" target={null} onReload={async () => undefined} onChanged={vi.fn()} onToast={vi.fn()} handlers={{ onSend: vi.fn() }} onOpenSettings={vi.fn()} />);
    expect(textIn($('.tools-foot')!)).toContain('~/.glogg/plugins');
  });

  it('follows an output action that runs another tool', async () => {
    await toolsView({
      routes: {
        'POST /api/plugins/osint/tools/dns': { blocks: [{ type: 'list', items: [{ title: 'example.com', actions: [{ label: 'WHOIS it', run: { tool: 'osint/whois', inputs: { domain: 'example.com' } } }] }] }] },
        'POST /api/plugins/osint/tools/whois': { blocks: [{ type: 'notice', content: 'Registered 1995' }] },
      },
    });
    await type(byLabel('Domain'), 'example.com');
    await submit(byLabel('Domain'));
    await until(() => queryRole('button', 'WHOIS it'));
    await click(byRole('button', 'WHOIS it'));
    expect(byRole('tab', 'WHOIS').getAttribute('aria-selected')).toBe('true');
    expect(sent('POST', '/api/plugins/osint/tools/whois')[0].body).toEqual({ input: { domain: 'example.com' } });
  });

  it('reloads the plugins and says so', async () => {
    const done = deferred<void>();
    const p = await toolsView({ onReload: () => done.promise });
    await click(byRole('button', 'Reload'));
    expect((byRole('button', 'Reload') as HTMLButtonElement).disabled).toBe(true);
    done.resolve();
    await flush();
    expect(p.onToast).toHaveBeenCalledWith('Plugins reloaded', 'ok');
    expect((byRole('button', 'Reload') as HTMLButtonElement).disabled).toBe(false);
  });

  it('names every control', async () => {
    await toolsView();
    expect(unnamed()).toEqual([]);
    await click(byRole('button', 'Real-Debrid', nav()));
    expect(unnamed()).toEqual([]);
  });
});

// ── Downloads page ────────────────────────────────────────────────────────────
const JOBS = [
  job('j-dl', { title: 'debian-12.iso', status: 'downloading', progressPercent: 42, statusDetail: '1.2 MB/s', sizeFormatted: '3.7 GB', createdAt: daysAgo(0.1) }),
  job('j-q', { title: 'archlinux.iso', status: 'queued', progressPercent: 0, target: 'plugin:realdebrid', statusDetail: 'Waiting for a slot', createdAt: daysAgo(0.1) }),
  job('j-done', { title: 'paper.pdf', kind: 'direct-file', sourceUrl: 'https://arxiv.org/pdf/1706.03762', target: 'nextcloud', destinationUrl: 'https://cloud.example/f/1', statusDetail: 'Saved to Nextcloud' }),
  job('j-fail', { title: 'old.nzb', kind: 'nzb', status: 'failed', target: 'offcloud', statusDetail: 'Offcloud key missing' }),
  job('j-local', { title: 'notes.html', kind: 'web-archive', target: 'local-vault', destinationUrl: '/Users/ada/Downloads/glogg/notes.html', statusDetail: 'Saved' }),
];

describe('downloads page', () => {
  async function downloadsView(report: DownloadManagerReport | ((c: Call) => unknown) = downloads(JOBS), routes: Record<string, unknown> = {}) {
    serve({ 'GET /api/downloads': typeof report === 'function' ? report : () => report, ...routes });
    const p = { onToast: vi.fn(), onOpenSettings: vi.fn() };
    await mount(withTargets(<DownloadsView {...p} />));
    return p;
  }

  const section = (title: string) => $$('section').find((s) => $('h2', s)?.textContent === title);
  const titles = (scope?: Element) => (scope ? $$('.job-title', scope).map((t) => t.textContent) : []);

  it('lists running downloads with their progress, and finished ones under History', async () => {
    await downloadsView();
    const running = section('In progress')!;
    expect(titles(running)).toEqual(['debian-12.iso', 'archlinux.iso']);
    expect($$('[role="progressbar"]', running).map((b) => b.getAttribute('aria-valuenow'))).toEqual(['42', '0']);
    expect($$('.job-meta', running).map((m) => [...m.children].map((c) => c.textContent))).toEqual([
      ['aria2', '1.2 MB/s', '3.7 GB', 'today'],
      ['Real-Debrid', 'Waiting for a slot', 'today'],
    ]);
    const history = section('History')!;
    expect(titles(history)).toEqual(['paper.pdf', 'old.nzb', 'notes.html']);
    expect($$('[role="progressbar"]', history)).toEqual([]);
    expect(textIn($$('.job-meta', history)[0])).toContain('2 days ago');
    expect($$('.job-title', history)[0].getAttribute('title')).toBe('https://arxiv.org/pdf/1706.03762');
    const open = byRole('link', 'Open', history);
    expect([open.getAttribute('href'), open.getAttribute('target')]).toEqual(['https://cloud.example/f/1', '_blank']);
    expect($$('a', history)).toHaveLength(1);
  });

  it('shows which destinations are set up, and where local downloads go', async () => {
    const p = await downloadsView();
    // Set up or not is said in words too, not only by an icon a screen reader skips.
    expect($$('.destination').map((d) => [textIn(d), d.classList.contains('on')])).toEqual([
      ['Offcloud (set up)', true],
      ['aria2 (set up)', true],
      ['Nextcloud (not set up)', false],
      ['NZB.life (not set up)', false],
      ['Real-Debrid (set up)', true],
    ]);
    const local = $('.destinations-local')!;
    expect([textIn(local), local.title]).toEqual(['~/Downloads/glogg', '/Users/ada/Downloads/glogg']);
    await click(byRole('button', 'Configure'));
    expect(p.onOpenSettings).toHaveBeenCalled();
  });

  it('sends a link to the destination you pick, then empties the box', async () => {
    const answer = deferred();
    const p = await downloadsView(downloads(JOBS), { 'POST /api/downloads': () => answer.promise });
    const send = byRole('button', 'Send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await type(byRole('textbox', 'URL to download'), '   ');
    expect(send.disabled).toBe(true);
    await type(byRole('textbox', 'URL to download'), '  magnet:?xt=urn:btih:abc  ');
    expect(send.disabled).toBe(false);
    const destination = byRole('combobox', 'Destination') as HTMLSelectElement;
    expect([...destination.options].map((o) => o.textContent)).toEqual(['Auto', 'Offcloud', 'aria2', 'Nextcloud', 'Real-Debrid', 'This machine']);
    await type(destination, 'plugin:realdebrid');
    await submit(send);
    expect(sent('POST', '/api/downloads')[0].body).toEqual({ url: 'magnet:?xt=urn:btih:abc', target: 'plugin:realdebrid' });
    expect(byRole('button', 'Sending…')).toBeTruthy();
    const loads = sent('GET', '/api/downloads').length;
    answer.resolve(reply(200, { job: job('new', { target: 'plugin:realdebrid', status: 'queued' }) }));
    await flush();
    expect(p.onToast).toHaveBeenCalledWith('Sent to Real-Debrid', 'ok');
    expect(byRole('textbox', 'URL to download')).toHaveProperty('value', '');
    expect(sent('GET', '/api/downloads').length).toBe(loads + 1);
  });

  it('sends nothing from an empty box', async () => {
    await downloadsView();
    await submit(byRole('textbox', 'URL to download'));
    expect(sent('POST', '/api/downloads')).toEqual([]);
  });

  it('says why a download failed, keeping the link when the server refused it', async () => {
    let answer: () => unknown = () => ({ job: job('x', { status: 'failed', target: 'offcloud', statusDetail: 'Offcloud key missing' }) });
    const p = await downloadsView(downloads(JOBS), { 'POST /api/downloads': () => answer() });
    await type(byRole('textbox', 'URL to download'), 'https://example.com/file.nzb');
    await submit(byRole('textbox', 'URL to download'));
    expect(p.onToast).toHaveBeenLastCalledWith('Offcloud key missing', 'error');

    answer = () => reply(400, { error: 'glogg cannot download gopher:// links' });
    await type(byRole('textbox', 'URL to download'), 'gopher://example.com/1');
    await submit(byRole('textbox', 'URL to download'));
    expect(p.onToast).toHaveBeenLastCalledWith('glogg cannot download gopher:// links', 'error');
    expect(byRole('textbox', 'URL to download')).toHaveProperty('value', 'gopher://example.com/1');
    expect((byRole('button', 'Send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('removes a job', async () => {
    let jobs = JOBS;
    await downloadsView(() => downloads(jobs), {
      'DELETE /api/downloads/*': (c: Call) => {
        jobs = jobs.filter((j) => `/api/downloads/${j.id}` !== c.path);
        return { ok: true };
      },
    });
    const row = $$('.job').find((j) => j.textContent?.includes('paper.pdf'))!;
    await click(byRole('button', 'Remove', row));
    expect(sent('DELETE', '/api/downloads/j-done')).toHaveLength(1);
    await flush();
    expect(titles(section('History'))).toEqual(['old.nzb', 'notes.html']);
  });

  it('clears finished downloads', async () => {
    let jobs = JOBS;
    await downloadsView(() => downloads(jobs), {
      'DELETE /api/downloads/finished': () => {
        jobs = jobs.filter((j) => j.status === 'downloading' || j.status === 'queued');
        return { removed: 3 };
      },
    });
    await click(byRole('button', 'Clear'));
    await flush();
    expect(sent('DELETE', '/api/downloads/finished')).toHaveLength(1);
    expect($('.empty', section('History'))!.textContent).toBe('Nothing yet. Use “Send” on any torrent, NZB, or result.');
    expect(queryRole('button', 'Clear')).toBeUndefined();
    expect(titles(section('In progress'))).toEqual(['debian-12.iso', 'archlinux.iso']);
  });

  it('says when there are no downloads yet', async () => {
    await downloadsView(downloads([]));
    expect(section('In progress')).toBeUndefined();
    expect($('.empty', section('History'))!.textContent).toBe('Nothing yet. Use “Send” on any torrent, NZB, or result.');
    expect(queryRole('button', 'Clear')).toBeUndefined();
  });

  it('says when the list cannot be loaded, and still takes links', async () => {
    const p = await downloadsView(() => reply(503, { error: 'Download manager is starting' }));
    expect(p.onToast).toHaveBeenCalledWith('Download manager is starting', 'error');
    expect($('.destinations')).toBeNull();
    expect(byRole('textbox', 'URL to download')).toBeTruthy();
  });

  it('updates progress every few seconds, and stops asking once you leave', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let percent = 42;
    await downloadsView(() => downloads([job('j-dl', { title: 'debian-12.iso', status: 'downloading', progressPercent: percent })]));
    expect($('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('42');
    percent = 87;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await flush();
    expect($('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('87');
    const asked = sent('GET', '/api/downloads').length;
    await unmount();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(sent('GET', '/api/downloads').length).toBe(asked);
  });

  it('names every control', async () => {
    await downloadsView();
    expect(unnamed()).toEqual([]);
  });
});

// ── Services page ────────────────────────────────────────────────────────────
const service = (id: string, extra: Partial<ContainerServiceStatus> = {}): ContainerServiceStatus => ({
  id,
  name: id,
  containerName: `glogg-${id}`,
  image: `${id}:latest`,
  category: 'Meta-Search',
  description: '',
  webUrl: 'http://localhost:8080',
  apiUrl: '',
  ports: ['8080:8080'],
  state: 'running',
  reachable: true,
  statusText: 'Up 2 hours',
  ...extra,
});

const stack = (services: ContainerServiceStatus[], extra: Partial<ContainerStackReport> = {}): ContainerStackReport => ({
  runtimes: { docker: true, podman: false, colima: false },
  activeRuntime: 'docker',
  daemonRunning: true,
  composeFilePath: '/srv/glogg/infra/docker-compose.services.yml',
  services,
  ...extra,
});

const SEARXNG = service('searxng', { name: 'SearXNG' });
const BITMAGNET = service('bitmagnet', {
  name: 'Bitmagnet',
  category: 'P2P & DHT',
  state: 'stopped',
  reachable: false,
  statusText: 'Exited (0) 3 days ago',
  ports: ['3333:3333', '3334:3334/udp'],
  webUrl: 'http://localhost:3333',
});

describe('services page', () => {
  async function servicesView(status: ContainerStackReport | (() => unknown) = stack([SEARXNG, BITMAGNET]), action?: (c: Call) => unknown) {
    serve({ 'GET /api/containers': typeof status === 'function' ? status : () => status, 'POST /api/containers/action': action ?? (() => ({ ok: true, command: 'docker', output: '' })) });
    const onToast = vi.fn();
    await mount(<ServicesView onToast={onToast} />);
    return onToast;
  }

  const rowOf = (name: string) => $$('.service').find((s) => $('.service-name', s)!.firstChild!.textContent === name)!;
  const status = () => textIn($('.status')!);

  it("shows the runtime, how many services are running, and each one's state", async () => {
    await servicesView();
    expect(status()).toBe('docker · 1/2 running');
    expect($$('.service').map((s) => [$('.service-name', s)!.firstChild!.textContent, $('.service-cat', s)!.textContent, textIn($('.service-meta', s)!)])).toEqual([
      ['SearXNG', 'Meta-Search', 'Up 2 hours · 8080:8080'],
      ['Bitmagnet', 'P2P & DHT', 'Exited (0) 3 days ago · 3333:3333, 3334:3334/udp'],
    ]);
    expect(rolesNamed('link', rowOf('SearXNG'))).toEqual(['Open']);
    expect(byRole('link', 'Open', rowOf('SearXNG')).getAttribute('href')).toBe('http://localhost:8080');
    expect(rolesNamed('button', rowOf('SearXNG'))).toEqual(['Restart', 'Stop', 'Logs']);
    expect(rolesNamed('button', rowOf('Bitmagnet'))).toEqual(['Start', 'Logs']);
    expect(queryRole('button', 'Start runtime')).toBeUndefined();
  });

  it('starts a service, holding the other actions until it is done, then shows its new state', async () => {
    const answer = deferred();
    const onToast = await servicesView(undefined, () => answer.promise);
    await click(byRole('button', 'Start', rowOf('Bitmagnet')));
    expect(sent('POST', '/api/containers/action')[0].body).toEqual({ action: 'up', serviceId: 'bitmagnet' });
    expect(byRole('button', 'Starting…', rowOf('Bitmagnet'))).toBeTruthy();
    expect(['Start all', 'Stop all', 'Restart', 'Stop'].map((n) => (byRole('button', n) as HTMLButtonElement).disabled)).toEqual([true, true, true, true]);
    answer.resolve(reply(200, { ok: true, command: 'docker compose up -d bitmagnet', output: '', stack: stack([SEARXNG, { ...BITMAGNET, state: 'running', statusText: 'Up 1 second' }]) }));
    await flush();
    expect(onToast).toHaveBeenCalledWith('docker compose up -d bitmagnet — done', 'ok');
    expect(rolesNamed('button', rowOf('Bitmagnet'))).toEqual(['Restart', 'Stop', 'Logs']);
    expect(status()).toBe('docker · 2/2 running');
    expect((byRole('button', 'Start all') as HTMLButtonElement).disabled).toBe(false);
  });

  it('stops and restarts a running service', async () => {
    await servicesView();
    await click(byRole('button', 'Stop', rowOf('SearXNG')));
    await click(byRole('button', 'Restart', rowOf('SearXNG')));
    expect(sent('POST', '/api/containers/action').map((c) => c.body)).toEqual([
      { action: 'stop', serviceId: 'searxng' },
      { action: 'restart', serviceId: 'searxng' },
    ]);
  });

  it('starts and stops the whole stack', async () => {
    const answer = deferred();
    await servicesView(undefined, (c) => (c.body.action === 'stack-up' ? answer.promise : { ok: true, command: 'docker compose down', output: '' }));
    await click(byRole('button', 'Start all'));
    expect(byRole('button', 'Starting…')).toBeTruthy();
    answer.resolve(reply(200, { ok: true, command: 'docker compose up -d', output: '' }));
    await flush();
    await click(byRole('button', 'Stop all'));
    expect(sent('POST', '/api/containers/action').map((c) => c.body)).toEqual([{ action: 'stack-up' }, { action: 'stack-down' }]);
  });

  it("shows a service's logs, and clears them", async () => {
    await servicesView(undefined, () => ({ ok: true, command: 'docker logs --tail 200 glogg-searxng', output: 'line 1\nline 2' }));
    expect($('.log')).toBeNull();
    await click(byRole('button', 'Logs', rowOf('SearXNG')));
    expect(sent('POST', '/api/containers/action')[0].body).toEqual({ action: 'logs', serviceId: 'searxng' });
    const output = $$('section').find((s) => $('h2', s)?.textContent === 'Output')!;
    expect($('pre', output)!.textContent).toBe('$ docker logs --tail 200 glogg-searxng\nline 1\nline 2');
    await click(byRole('button', 'Clear', output));
    expect($('.log')).toBeNull();
  });

  it('shows what went wrong when an action fails', async () => {
    const onToast = await servicesView(undefined, () => ({ ok: false, command: 'docker compose up -d bitmagnet', output: 'port 3333 is already allocated' }));
    await click(byRole('button', 'Start', rowOf('Bitmagnet')));
    expect(onToast).toHaveBeenCalledWith('Failed: port 3333 is already allocated', 'error');
    expect($('.log')!.textContent).toBe('$ docker compose up -d bitmagnet\nport 3333 is already allocated');
  });

  it('says when the server refuses an action', async () => {
    const onToast = await servicesView(undefined, () => reply(400, { error: 'Unknown service: bitmagnet' }));
    await click(byRole('button', 'Start', rowOf('Bitmagnet')));
    expect(onToast).toHaveBeenCalledWith('Unknown service: bitmagnet', 'error');
    expect((byRole('button', 'Start', rowOf('Bitmagnet')) as HTMLButtonElement).disabled).toBe(false);
  });

  it('when the runtime is stopped, says so and offers to start it', async () => {
    await servicesView(stack([{ ...SEARXNG, state: 'stopped', statusText: 'Daemon offline' }], { daemonRunning: false }));
    expect(status()).toBe('docker · daemon stopped');
    await click(byRole('button', 'Start runtime'));
    expect(sent('POST', '/api/containers/action')[0].body).toEqual({ action: 'start-daemon' });
  });

  it('when there is no container runtime, says so and shows why an action cannot run', async () => {
    const offline = stack(
      [SEARXNG, BITMAGNET].map((s) => ({ ...s, state: 'not-created' as const, reachable: false, statusText: 'Daemon offline' })),
      { runtimes: { docker: false, podman: false, colima: false }, activeRuntime: 'none', daemonRunning: false }
    );
    const onToast = await servicesView(offline, () => ({ ok: false, command: '', output: 'Container management is off here (GLOGG_CONTAINER_RUNTIME=none).', stack: offline }));
    expect(status()).toBe('No container runtime · daemon stopped');
    expect($$('.service').map((s) => rolesNamed('button', s))).toEqual([
      ['Start', 'Logs'],
      ['Start', 'Logs'],
    ]);
    expect($$('.service-meta').map((m) => textIn(m).split(' · ')[0])).toEqual(['Daemon offline', 'Daemon offline']);
    await click(byRole('button', 'Start all'));
    expect(textIn($('.log')!)).toContain('Container management is off here (GLOGG_CONTAINER_RUNTIME=none).');
    expect(onToast.mock.calls.at(-1)![1]).toBe('error');
  });

  it('says when the status cannot be loaded', async () => {
    const onToast = await servicesView(() => reply(500, { error: 'docker: permission denied' }));
    expect(onToast).toHaveBeenCalledWith('docker: permission denied', 'error');
    expect($('.status')).toBeNull();
    expect($$('.service')).toEqual([]);
  });

  it('refreshes on demand and every few seconds, and stops once you leave', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await servicesView();
    expect(sent('GET', '/api/containers')).toHaveLength(1);
    await click(byRole('button', 'Refresh'));
    expect(sent('GET', '/api/containers')).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(sent('GET', '/api/containers')).toHaveLength(3);
    await unmount();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(sent('GET', '/api/containers')).toHaveLength(3);
  });

  it('names every control', async () => {
    await servicesView();
    expect(unnamed()).toEqual([]);
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────
const PREFS: SearchPrefs = { maxPerDomain: 2, stripSponsored: true, obscureWebOnly: false, preLlmOnly: false, newTab: true };

describe('settings', () => {
  /** What the app would keep: Settings reports every change through these setters. */
  let state: { prefs: SearchPrefs; blocked: string[]; boosted: string[]; customBangs: BangDefinition[]; adultMode: boolean };

  function Settings({ focus, onToast }: { focus: string | null; onToast: (t: string, tone?: 'ok' | 'error' | 'info') => void }) {
    const [prefs, setPrefs] = useState(PREFS);
    const [blocked, setBlocked] = useState(['contentfarm.example']);
    const [boosted, setBoosted] = useState(['sqlite.org']);
    const [customBangs, setCustomBangs] = useState<BangDefinition[]>([]);
    const [adultMode, setAdultMode] = useState(false);
    state = { prefs, blocked, boosted, customBangs, adultMode };
    return (
      <SettingsView
        prefs={prefs}
        setPrefs={setPrefs}
        blocked={blocked}
        setBlocked={setBlocked}
        boosted={boosted}
        setBoosted={setBoosted}
        customBangs={customBangs}
        setCustomBangs={setCustomBangs}
        adultMode={adultMode}
        setAdultMode={setAdultMode}
        focus={focus}
        onToast={onToast}
      />
    );
  }

  async function settingsView(routes: Record<string, unknown> = {}, focus: string | null = null) {
    serve({ 'GET /api/auth': { required: false, authenticated: false }, 'GET /api/integrations': { config: {} }, ...routes });
    const onToast = vi.fn();
    await mount(<Settings focus={focus} onToast={onToast} />);
    return onToast;
  }

  const fieldset = (legend: string) => $$('fieldset').find((f) => $('legend', f)!.textContent === legend)!;
  const domains = (title: string) => {
    const block = $$('.domain-block').find((b) => $('h3', b)!.firstChild!.textContent!.trim() === title)!;
    return { count: $('h3 .muted', block)!.textContent, items: $$('.chip', block).map((c) => c.textContent) };
  };

  it.each([
    [/^Hide sponsored & affiliate results/, 'stripSponsored'],
    [/^Independent sites only/, 'obscureWebOnly'],
    [/^Before ChatGPT/, 'preLlmOnly'],
    [/^Open results in a new tab/, 'newTab'],
  ] as const)('flips the %s switch, and only that preference', async (name, key) => {
    await settingsView();
    const toggle = byRole('switch', name);
    expect(toggle.getAttribute('aria-checked')).toBe(String(PREFS[key]));
    await click(toggle);
    expect(state.prefs).toEqual({ ...PREFS, [key]: !PREFS[key] });
    expect(toggle.getAttribute('aria-checked')).toBe(String(!PREFS[key]));
  });

  it('flips a ranking switch from anywhere on its row', async () => {
    await settingsView();
    await click($$('.setting-label').find((l) => l.textContent === 'Independent sites only'));
    expect(state.prefs.obscureWebOnly).toBe(true);
  });

  it('sets how many results one site may have', async () => {
    await settingsView();
    const row = $$('.setting').find((s) => s.textContent?.includes('Results per site'))!;
    expect(rolesNamed('button', row)).toEqual(['1', '2', '3', '∞']);
    await click(byRole('button', '∞', row));
    expect(state.prefs.maxPerDomain).toBe(0);
    await click(byRole('button', '1', row));
    expect(state.prefs).toEqual({ ...PREFS, maxPerDomain: 1 });
  });

  it('turns 18+ mode on only after you confirm, and off again at once', async () => {
    await settingsView();
    const toggle = byRole('switch', '18+ mode');
    await click(toggle);
    const confirm = byRole('alertdialog', 'Turn on 18+ mode?');
    expect(textIn(confirm)).toContain('Only for people 18 or older.');
    expect(state.adultMode).toBe(false);
    await click(byRole('button', 'Cancel', confirm));
    expect(queryRole('alertdialog')).toBeUndefined();
    expect(state.adultMode).toBe(false);

    await click(toggle);
    await click(byRole('button', "I'm 18 or older, turn it on"));
    expect(state.adultMode).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(queryRole('alertdialog')).toBeUndefined();

    await click(toggle);
    expect(state.adultMode).toBe(false);
    expect(queryRole('alertdialog')).toBeUndefined();
  });

  it('does not ask about 18+ mode on a click elsewhere on its row', async () => {
    await settingsView();
    await click($$('.setting-label').find((l) => l.textContent === 'Unfiltered results'));
    expect(queryRole('alertdialog')).toBeUndefined();
  });

  it('loads the integrations, and saves them only once something changed', async () => {
    const onToast = await settingsView({
      'GET /api/integrations': { config: { offcloudApiKey: '••••1234', searxngUrl: 'http://localhost:8080' } },
      'PUT /api/integrations': (c: Call) => ({ config: { ...c.body.config, offcloudApiKey: '••••1234' } }),
    });
    expect($$('legend').map((l) => l.textContent)).toEqual(['Offcloud', 'NZB.life', 'Marginalia', 'Stack Exchange', 'Nextcloud', 'aria2', 'Search backends']);
    const key = byLabel('API key', fieldset('Offcloud'));
    expect([key.type, key.value]).toEqual(['password', '••••1234']);
    expect(byLabel('SearXNG').value).toBe('http://localhost:8080');
    expect(byLabel('Bitmagnet GraphQL').placeholder).toBe('http://localhost:3333/graphql');
    const save = byRole('button', 'Save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await type(byLabel('SearXNG'), 'http://localhost:8888');
    expect(save.disabled).toBe(false);
    await click(save);
    expect(sent('PUT', '/api/integrations')[0].body).toEqual({ config: { offcloudApiKey: '••••1234', searxngUrl: 'http://localhost:8888' } });
    expect(onToast).toHaveBeenCalledWith('Integrations saved on this machine', 'ok');
    expect(save.disabled).toBe(true);
  });

  it('says when the integrations could not be saved', async () => {
    const onToast = await settingsView({ 'PUT /api/integrations': () => reply(500, { error: 'Could not write ~/.glogg/config.json' }) });
    await type(byLabel('User'), 'ada');
    await click(byRole('button', 'Save'));
    expect(onToast).toHaveBeenCalledWith('Could not write ~/.glogg/config.json', 'error');
    expect((byRole('button', 'Save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('selects a saved secret when you focus it, so typing replaces it', async () => {
    await settingsView({ 'GET /api/integrations': { config: { offcloudApiKey: '••••1234' } } });
    const key = byLabel('API key', fieldset('Offcloud'));
    await act(async () => key.focus());
    expect([key.selectionStart, key.selectionEnd]).toEqual([0, 8]);
  });

  it('adds a bang, tidying its trigger, and replaces one with the same trigger', async () => {
    await settingsView();
    await type(byLabel('!trigger'), '!TeamWiki ');
    await type(byLabel('Name'), ' Team wiki ');
    await type(byLabel('https://example.com/search?q={q}'), ' https://wiki.example/search?q={q} ');
    await click(byRole('button', 'Add'));
    expect(state.customBangs).toEqual([{ trigger: 'teamwiki', name: 'Team wiki', url: 'https://wiki.example/search?q={q}', category: 'web' }]);
    expect($$('.bang-list li').map((li) => [...li.children].slice(0, 3).map((c) => c.textContent))).toEqual([['!teamwiki', 'Team wiki', 'https://wiki.example/search?q={q}']]);
    expect([byLabel('!trigger').value, byLabel('Name').value, byLabel('https://example.com/search?q={q}').value]).toEqual(['', '', '']);

    await type(byLabel('!trigger'), 'teamwiki');
    await type(byLabel('https://example.com/search?q={q}'), 'https://wiki2.example/?s={q}');
    await click(byRole('button', 'Add'));
    expect(state.customBangs).toEqual([{ trigger: 'teamwiki', name: 'teamwiki', url: 'https://wiki2.example/?s={q}', category: 'web' }]);
  });

  it('refuses a bang without a trigger or a {q} in its URL', async () => {
    const onToast = await settingsView();
    await type(byLabel('!trigger'), 'x');
    await type(byLabel('https://example.com/search?q={q}'), 'https://x.example/');
    await click(byRole('button', 'Add'));
    await type(byLabel('!trigger'), '!');
    await type(byLabel('https://example.com/search?q={q}'), 'https://x.example/?q={q}');
    await click(byRole('button', 'Add'));
    expect(onToast.mock.calls).toEqual([
      ['A bang needs a trigger and a URL containing {q}', 'error'],
      ['A bang needs a trigger and a URL containing {q}', 'error'],
    ]);
    expect(state.customBangs).toEqual([]);
    expect(byLabel('https://example.com/search?q={q}').value).toBe('https://x.example/?q={q}');
  });

  it('removes a bang', async () => {
    await settingsView();
    await type(byLabel('!trigger'), 'tw');
    await type(byLabel('https://example.com/search?q={q}'), 'https://wiki.example/?q={q}');
    await click(byRole('button', 'Add'));
    await click(byRole('button', 'Remove', $('.bang-list')!));
    expect(state.customBangs).toEqual([]);
    expect($('.bang-list')).toBeNull();
  });

  it('shows and hides the built-in bangs', async () => {
    await settingsView();
    await click(byRole('button', `Show ${BUILTIN_BANGS.length} built-in bangs`));
    expect($$('.bang-list.compact li')).toHaveLength(BUILTIN_BANGS.length);
    expect([...$$('.bang-list.compact li')[0].children].map((c) => c.textContent)).toEqual(['!g', 'Google (udm=14, no AI)', 'web']);
    await click(byRole('button', `Hide ${BUILTIN_BANGS.length} built-in bangs`));
    expect($('.bang-list.compact')).toBeNull();
  });

  it('hides a domain however it was typed, and only once', async () => {
    await settingsView();
    const input = byLabel('Hide a domain, e.g. contentfarm.com');
    await type(input, '  https://www.Example.COM/some/path ');
    await click(byRole('button', 'Hide'));
    expect(state.blocked).toEqual(['example.com', 'contentfarm.example']);
    expect(input.value).toBe('');
    await type(input, 'example.com');
    await submit(input);
    await type(input, '   ');
    await submit(input);
    expect(state.blocked).toEqual(['example.com', 'contentfarm.example']);
    expect(domains('Hidden')).toEqual({ count: '2', items: ['example.com', 'contentfarm.example'] });
  });

  it('removes preferred and hidden domains, and resets the hidden ones to the defaults', async () => {
    await settingsView();
    expect(domains('Preferred')).toEqual({ count: '1', items: ['sqlite.org'] });
    await click(byRole('button', 'Remove sqlite.org'));
    expect(state.boosted).toEqual([]);
    expect(domains('Preferred')).toEqual({ count: '0', items: [] });
    expect($('.empty', $$('.domain-block')[0])!.textContent).toBe('None.');
    await click(byRole('button', 'Remove contentfarm.example'));
    expect(state.blocked).toEqual([]);
    await click(byRole('button', 'Reset to defaults'));
    expect(state.blocked).toEqual(DEFAULT_SLOP_DOMAINS);
    expect(domains('Hidden').count).toBe(String(DEFAULT_SLOP_DOMAINS.length));
    expect(domains('Hidden').items).toHaveLength(Math.min(80, DEFAULT_SLOP_DOMAINS.length));
  });

  it('exports the hidden domains as a uBlacklist ruleset, and imports one', async () => {
    const onToast = await settingsView();
    const details = $<HTMLDetailsElement>('details.details')!;
    await click($('summary', details));
    expect(details.open).toBe(true);
    const rules = (t: string) => t.split('\n').filter((l) => !l.startsWith('# Generated'));
    const box = $<HTMLTextAreaElement>('textarea', details)!;
    expect(rules(box.value)).toEqual(rules(exportUBlacklistRuleset(['contentfarm.example'])));
    await click(byRole('button', 'Copy', details));
    expect(clipboard[0]).toContain('*://*.contentfarm.example/*');
    expect(onToast).toHaveBeenLastCalledWith('Copied ruleset', 'ok');

    await type(box, '# mine\n*://*.spam.example/*\nhttps://www.junk.example/path\nnot a domain');
    await click(byRole('button', 'Import from text'));
    expect(state.blocked).toEqual(['spam.example', 'junk.example', 'contentfarm.example']);
    expect(onToast).toHaveBeenLastCalledWith('Imported 2 domains', 'ok');

    await type(box, '# nothing here');
    await click(byRole('button', 'Import from text'));
    expect(onToast).toHaveBeenCalledTimes(2);
  });

  it('offers to sign out only on a protected glogg you are signed in to', async () => {
    await settingsView();
    expect(queryRole('button', 'Sign out')).toBeUndefined();
    await unmount();
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom cannot reload the page
    await settingsView({ 'GET /api/auth': { required: true, authenticated: true }, 'POST /api/auth/logout': { ok: true } });
    await click(byRole('button', 'Sign out'));
    expect(sent('POST', '/api/auth/logout')).toHaveLength(1);
  });

  it('brings the section you asked for into view', async () => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    await settingsView({}, 'adult');
    expect(scrolled.map((el) => el.id)).toEqual(['settings-adult']);
  });

  it('names every control', async () => {
    await settingsView();
    expect(unnamed()).toEqual([]);
    await click(byRole('switch', '18+ mode'));
    expect(unnamed()).toEqual([]);
  });
});

describe('found by these tests, and fixed', () => {
  const toolProps = (onReload: () => Promise<void> = async () => undefined) => ({
    onReload,
    onChanged: vi.fn(),
    onToast: vi.fn(),
    handlers: { onSend: vi.fn(), onCopied: vi.fn() },
    onOpenSettings: vi.fn(),
  });

  async function settings() {
    serve({ 'GET /api/auth': { required: false, authenticated: false }, 'GET /api/integrations': { config: {} } });
    function S() {
      const [prefs, setPrefs] = useState(PREFS);
      const [blocked, setBlocked] = useState(['contentfarm.example']);
      const [adult, setAdult] = useState(false);
      return (
        <SettingsView
          prefs={prefs}
          setPrefs={setPrefs}
          blocked={blocked}
          setBlocked={setBlocked}
          boosted={[]}
          setBoosted={vi.fn()}
          customBangs={[]}
          setCustomBangs={vi.fn()}
          adultMode={adult}
          setAdultMode={setAdult}
          onToast={vi.fn()}
        />
      );
    }
    await mount(<S />);
  }
  it('downloads: says when a download could not be removed', async () => {
    serve({ 'GET /api/downloads': () => downloads(JOBS), 'DELETE /api/downloads/*': () => reply(409, { error: 'Stop the download before removing it' }) });
    const onToast = vi.fn();
    await mount(withTargets(<DownloadsView onToast={onToast} onOpenSettings={vi.fn()} />));
    await click(byRole('button', 'Remove', $$('.job')[0]));
    await flush();
    expect(onToast).toHaveBeenCalledWith('Stop the download before removing it', 'error');
  });


  it('downloads: says when finished downloads could not be cleared', async () => {
    serve({ 'GET /api/downloads': () => downloads(JOBS), 'DELETE /api/downloads/finished': () => reply(500, { error: 'Could not write ~/.glogg/downloads.json' }) });
    const onToast = vi.fn();
    await mount(withTargets(<DownloadsView onToast={onToast} onOpenSettings={vi.fn()} />));
    await click(byRole('button', 'Clear'));
    await flush();
    expect(onToast).toHaveBeenCalledWith('Could not write ~/.glogg/downloads.json', 'error');
  });


  it('tools: says when reloading the plugins failed', async () => {
    const p = toolProps(() => Promise.reject(new Error('Plugin folder is not readable')));
    serve({});
    await mount(<ToolsView plugins={VIEW_PLUGINS} userDir="" target={null} {...p} />);
    await click(byRole('button', 'Reload'));
    await flush();
    expect(p.onToast).toHaveBeenCalledWith('Plugin folder is not readable', 'error');
  });


  it('tools: labels each settings field, even when a tool has a field with the same key', async () => {
    serve({ 'GET /api/plugins/sabnzbd/container': { runtime: 'docker', state: 'running' } });
    await mount(<ToolsView plugins={[SABNZBD]} userDir="" target={null} {...toolProps()} />);
    await click(byRole('tab', 'Add NZB'));
    const details = $<HTMLDetailsElement>('details.plugin-settings')!;
    details.open = true;
    await flush(1);
    // Before, the tool's "url" and its plugin's "url" setting were both #f-url.
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect.soft(new Set(ids).size, 'ids on the page are unique').toBe(ids.length);
    expect.soft(nameOf($('input', details)!)).toBe('URL');
    expect.soft(nameOf($('.tool-pane input')!)).toBe('NZB URL');
  });


  it('tool forms: tells assistive tech which fields are required, and does not submit without them', async () => {
    const onSubmit = vi.fn();
    await mount(<ToolForm fields={[{ key: 'domain', label: 'Domain', required: true }]} values={{}} onChange={vi.fn()} onSubmit={onSubmit} />);
    const domain = byLabel('Domain');
    expect.soft(domain.required || domain.getAttribute('aria-required') === 'true').toBe(true);
    await submit(domain);
    expect.soft(onSubmit).not.toHaveBeenCalled();
  });


  it('search box: labels the bang suggestions like the tool suggestions', async () => {
    function Box() {
      const [value, setValue] = useState('');
      return <SearchBox value={value} onChange={setValue} onSubmit={vi.fn()} customBangs={[]} tools={TOOLS} />;
    }
    await mount(<Box />);
    await type(byRole('textbox', 'Search'), '!g');
    expect(unnamed()).toEqual([]);
  });


  it('settings: moves focus into the 18+ confirmation, and Escape cancels it', async () => {
    await settings();
    const toggle = byRole('switch', '18+ mode');
    toggle.focus();
    await click(toggle);
    const confirm = byRole('alertdialog', 'Turn on 18+ mode?');
    expect.soft(confirm.contains(document.activeElement)).toBe(true);
    await press('Escape');
    expect.soft(queryRole('alertdialog')).toBeUndefined();
  });


  it('services: shows why the server could not run an action', async () => {
    // What the server sends when an action throws: the reason in output and in error.
    serve({ 'GET /api/containers': () => stack([SEARXNG]), 'POST /api/containers/action': () => reply(500, { ok: false, output: 'spawn docker ENOENT', error: 'spawn docker ENOENT' }) });
    const onToast = vi.fn();
    await mount(<ServicesView onToast={onToast} />);
    await click(byRole('button', 'Stop all'));
    expect(onToast).toHaveBeenLastCalledWith(expect.stringContaining('spawn docker ENOENT'), 'error');
  });


  it('services: says why an action failed when there is no container runtime', async () => {
    const offline = stack([{ ...SEARXNG, state: 'not-created', statusText: 'Daemon offline' }], { runtimes: { docker: false, podman: false, colima: false }, activeRuntime: 'none', daemonRunning: false });
    serve({ 'GET /api/containers': () => offline, 'POST /api/containers/action': () => ({ ok: false, command: '', output: 'Container management is off here (GLOGG_CONTAINER_RUNTIME=none).', stack: offline }) });
    const onToast = vi.fn();
    await mount(<ServicesView onToast={onToast} />);
    await click(byRole('button', 'Start all'));
    expect(onToast.mock.calls.at(-1)![0]).toContain('Container management is off here');
  });


  it('downloads: names each progress bar after its download', async () => {
    serve({ 'GET /api/downloads': () => downloads(JOBS) });
    await mount(withTargets(<DownloadsView onToast={vi.fn()} onOpenSettings={vi.fn()} />));
    expect($$('[role="progressbar"]').map(nameOf)).toEqual(['debian-12.iso', 'archlinux.iso']);
  });


  it('downloads: tells a screen reader which destinations are set up', async () => {
    serve({ 'GET /api/downloads': () => downloads(JOBS) });
    await mount(withTargets(<DownloadsView onToast={vi.fn()} onOpenSettings={vi.fn()} />));
    expect($$('.destination').map((d) => textOf(d).trim())).not.toEqual(['Offcloud', 'aria2', 'Nextcloud', 'NZB.life', 'Real-Debrid']);
  });


  it('results: counts one matching torrent in the singular', async () => {
    await resultsPage(response({ results: [result(1), result(2), result(3), torrent(4)] }));
    expect(textIn($('.banner')!)).not.toMatch(/\b1 torrents\b/);
  });


  it('reader: tells assistive tech the page is loading', async () => {
    serve({ 'POST /api/inspect': () => new Promise(() => undefined) });
    await mount(withTargets(<ReaderSheet url={READ_URL} onClose={vi.fn()} onNavigate={vi.fn()} onSend={vi.fn()} />));
    expect($('.sheet [aria-busy="true"]')).toBeTruthy();
  });
});

describe('nothing left running after a view goes away', () => {
  it('useLater runs what is due, and drops what is still pending when the component unmounts', async () => {
    const { useLater } = await import('../src/client/lib.js');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fired: string[] = [];
      let later!: (fn: () => void, ms: number) => void;
      function Probe() {
        later = useLater();
        return null;
      }
      await mount(<Probe />);
      later(() => fired.push('soon'), 50);
      later(() => fired.push('later'), 500);
      await act(async () => vi.advanceTimersByTime(60));
      expect(fired).toEqual(['soon']);
      // The search box's blur, a "Copied" or a toast scheduled like this used to fire after the view
      // was gone (on CI: after the test's window was torn down).
      await unmount();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(fired).toEqual(['soon']);
    } finally {
      vi.useRealTimers();
    }
  });
});
