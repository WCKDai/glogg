import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type {
  DownloadJob,
  DownloadTargetId,
  PluginCategory,
  PluginDownloadTargetInfo,
  PluginField,
  PluginInfo,
  PluginToolDef,
  RankedSearchResponse,
  ResearchEvent,
  ResearchSource,
  SearchLensId,
  ToolResult,
} from '../core/browser.js';

export type View = 'search' | 'downloads' | 'atlas' | 'services' | 'settings' | 'tools';
export type ThemePref = 'system' | 'light' | 'dark';
export type Mode = 'simple' | 'advanced';

export const SCOPES: { id: SearchLensId; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Everything, ranked for signal' },
  { id: 'wild-west', label: 'Wild West', hint: 'Imageboards, chan archives, old forums, BBS text files' },
  { id: 'forums', label: 'Forums', hint: 'HN, Lobsters, StackExchange, Lemmy, niche boards' },
  { id: 'small-web', label: 'Small Web', hint: 'Personal sites via Marginalia & Wiby' },
  { id: 'primary', label: 'Docs & Papers', hint: 'Specs, papers, man pages, repos' },
  { id: 'fediverse', label: 'Fediverse', hint: 'Bluesky, Mastodon, Matrix, Lemmy' },
  { id: 'deep-archives', label: 'Archives', hint: 'Internet Archive, FOIA, leaks' },
  { id: 'raw-news', label: 'News', hint: 'GDELT wire, OSINT, raw reporting' },
  { id: 'p2p-magnet', label: 'Torrents', hint: 'DHT, Bitmagnet, Torznab' },
  { id: 'usenet-nzb', label: 'Usenet', hint: 'NZBIndex, NZB.life, Newznab' },
];

export const SOURCE_LABELS: Record<string, string> = {
  marginalia: 'Marginalia',
  wiby: 'Wiby',
  'indie-index': 'Atlas',
  chanboards: 'Imageboards',
  'wild-west': 'Forums',
  atproto: 'Bluesky',
  activitypub: 'Mastodon',
  matrix: 'Matrix',
  stoat: 'Stoat',
  lemmy: 'Lemmy',
  lobsters: 'Lobsters',
  'gdelt-news': 'News wire',
  'archive-deep': 'Internet Archive',
  'bitmagnet-dht': 'DHT',
  'archive-bt': 'Archive torrents',
  'academic-torrents': 'Academic Torrents',
  'usenet-nzb': 'Usenet',
  'nzb-life': 'NZB.life',
  openalex: 'OpenAlex',
  arxiv: 'arXiv',
  hn: 'Hacker News',
  stackexchange: 'StackExchange',
  github: 'GitHub',
  codeberg: 'Codeberg',
  wikipedia: 'Wikipedia',
  web: 'Web',
  'deep-blogs': 'Indexed blogs',
  'deep-boards': 'Indexed boards',
  'deep-forums': 'Indexed forums',
  mwmbl: 'Mwmbl',
  discourse: 'Discourse',
};

export interface TargetOption {
  id: DownloadTargetId;
  label: string;
  hint: string;
}

export const DOWNLOAD_TARGETS: TargetOption[] = [
  { id: 'auto', label: 'Auto', hint: 'Best available destination' },
  { id: 'offcloud', label: 'Offcloud', hint: 'Cloud download via API' },
  { id: 'aria2-rpc', label: 'aria2', hint: 'Local download engine' },
  { id: 'nextcloud', label: 'Nextcloud', hint: 'Push to your cloud via WebDAV' },
  { id: 'local-vault', label: 'This machine', hint: '~/Downloads/glogg or your torrent client' },
];

/** Built-in destinations plus every configured plugin (Real-Debrid, TorBox…), local last. */
export function mergeTargets(pluginTargets: PluginDownloadTargetInfo[] = []): TargetOption[] {
  const plugins = pluginTargets
    .filter((t) => t.configured)
    .map((t) => ({ id: t.id, label: t.label, hint: `Takes ${t.accepts.join(', ')}` }));
  const local = DOWNLOAD_TARGETS.filter((t) => t.id === 'local-vault');
  return [...DOWNLOAD_TARGETS.filter((t) => t.id !== 'local-vault'), ...plugins, ...local];
}

export const DownloadTargetsContext = createContext<TargetOption[]>(DOWNLOAD_TARGETS);

export function useDownloadTargets(): TargetOption[] {
  return useContext(DownloadTargetsContext);
}

export function targetLabel(id: string, targets: TargetOption[]): string {
  return targets.find((t) => t.id === id)?.label || id.replace(/^plugin:/, '');
}

// ── Plugins & tools ───────────────────────────────────────────────────────
export interface PluginsResponse {
  plugins: PluginInfo[];
  userDir: string;
}

export interface ToolRef {
  /** `pluginId/toolId` */
  key: string;
  pluginId: string;
  pluginName: string;
  category: PluginCategory;
  icon?: string;
  configured: boolean;
  tool: PluginToolDef;
}

export function indexTools(plugins: PluginInfo[]): ToolRef[] {
  return plugins
    .filter((p) => !p.error)
    .flatMap((p) =>
      p.tools.map((tool) => ({
        key: `${p.id}/${tool.id}`,
        pluginId: p.id,
        pluginName: p.name,
        category: p.category,
        icon: p.icon,
        configured: p.configured,
        tool,
      }))
    );
}

/** `>dn` → tools whose trigger starts with "dn", until a space is typed. */
export function suggestTools(tools: ToolRef[], raw: string, limit = 7): ToolRef[] {
  const m = raw.match(/^>\s*([\w.-]*)$/);
  if (!m) return [];
  const prefix = m[1].toLowerCase();
  return tools
    .filter((t) => t.tool.trigger && t.tool.trigger.startsWith(prefix))
    .sort((a, b) => (a.tool.trigger!.length - b.tool.trigger!.length) || a.tool.trigger!.localeCompare(b.tool.trigger!))
    .slice(0, limit);
}

export function defaultInputs(fields: PluginField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.key] = f.default;
    else if (f.type === 'select' && f.options?.length) out[f.key] = f.options[0].value;
    else if (f.type === 'toggle') out[f.key] = false;
  }
  return out;
}

/** `>dns example.com`: the text after the trigger fills the tool's first input. */
export function inputsFromTrigger(tool: PluginToolDef, rest: string): Record<string, unknown> {
  const input = defaultInputs(tool.inputs);
  const first = tool.inputs.find((f) => f.type !== 'toggle' && f.type !== 'select') || tool.inputs[0];
  if (first && rest) input[first.key] = rest;
  return input;
}

export function runTool(pluginId: string, toolId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  return api<ToolResult>(`/api/plugins/${encodeURIComponent(pluginId)}/tools/${encodeURIComponent(toolId)}`, {
    method: 'POST',
    json: { input },
    signal,
  });
}

/** Fired when the server asks for a sign-in: this glogg has a password and the session is missing or expired. */
export const SIGN_IN_EVENT = 'glogg:sign-in';

function noteSignIn(res: Response): void {
  if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(SIGN_IN_EVENT));
}

/** What a streamed search sends: an early batch (when the main sources answer first), then the full ranking. */
export type SearchEvent = { type: 'partial' | 'final'; response: RankedSearchResponse } | { type: 'error'; error: string };

async function postForStream(path: string, json: unknown, signal: AbortSignal): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(json),
    signal,
  });
  noteSignIn(res);
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res as Response & { body: ReadableStream<Uint8Array> };
}

/** POSTs JSON and calls onEvent for each line of a newline-delimited JSON response. */
export async function streamEvents<T>(path: string, json: unknown, signal: AbortSignal, onEvent: (e: T) => void): Promise<void> {
  await readLines(await postForStream(path, json, signal), (line) => onEvent(JSON.parse(line) as T));
}

/** Searches: the early batch and the full ranking when the server streams; a plain JSON answer counts as the full one. */
export async function streamSearch(json: unknown, signal: AbortSignal, onEvent: (e: SearchEvent) => void): Promise<void> {
  const res = await postForStream('/api/search', json, signal);
  if (!/ndjson/.test(res.headers.get('content-type') || '')) {
    onEvent({ type: 'final', response: (await res.json()) as RankedSearchResponse });
    return;
  }
  await readLines(res, (line) => onEvent(JSON.parse(line) as SearchEvent));
}

async function readLines(res: Response & { body: ReadableStream<Uint8Array> }, onLine: (line: string) => void): Promise<void> {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

// ── Late results ──────────────────────────────────────────────────────────
/** Re-ask this long after a response with late sources; the server has cached them by then. */
export const LATE_REFRESH_MS = 2500;

/**
 * Adds results that arrived after the first response. Results already on screen
 * keep their place; new ones are appended so nothing jumps under the cursor.
 * Returns `current` unchanged when there is nothing new.
 */
export function mergeLateResults(current: RankedSearchResponse | null, later: RankedSearchResponse): RankedSearchResponse | null {
  if (!current || current.query !== later.query) return current;
  const seen = new Set(current.results.map((r) => r.url));
  const extra = later.results.filter((r) => !seen.has(r.url));
  const seenReleases = new Set(current.p2pResults.map((r) => r.url));
  const extraReleases = later.p2pResults.filter((r) => !seenReleases.has(r.url));
  const answer = current.instantAnswer ?? later.instantAnswer;
  if (extra.length === 0 && extraReleases.length === 0 && answer === current.instantAnswer) return current;
  return {
    ...current,
    instantAnswer: answer,
    results: [...current.results, ...extra],
    p2pResults: [...current.p2pResults, ...extraReleases],
    metrics: {
      ...current.metrics,
      surfacedCount: current.results.length + extra.length,
      sourceTimings: later.metrics.sourceTimings ?? current.metrics.sourceTimings,
    },
  };
}

// ── Research ──────────────────────────────────────────────────────────────
export interface ResearchState {
  id: number;
  query: string;
  stage: 'searching' | 'reading' | 'writing' | 'done' | 'error';
  detail: string;
  sources: ResearchSource[];
  answer: string;
  mode?: 'ai' | 'extractive';
  model?: string;
  notice?: string;
  error?: string;
  durationMs?: number;
}

export function reduceResearch(s: ResearchState, e: ResearchEvent): ResearchState {
  switch (e.type) {
    case 'status':
      return { ...s, stage: e.stage, detail: e.detail };
    case 'sources':
      return { ...s, sources: e.sources };
    case 'delta':
      return { ...s, answer: s.answer + e.text, stage: 'writing' };
    case 'notice':
      return { ...s, notice: e.message };
    case 'done':
      return { ...s, stage: 'done', mode: e.mode, model: e.model, durationMs: e.durationMs };
    case 'error':
      return { ...s, stage: 'error', error: e.message };
    default:
      return s;
  }
}

export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text);
}

export function faviconUrl(domain: string): string {
  // Through glogg, so the icon service never learns which sites are on your results page.
  return `/api/favicon/${encodeURIComponent(domain)}`;
}

export function urlCrumb(url: string): string {
  try {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    if (!p || p === '/') return '';
    // Bare ids, hashes and one-letter route parts ("a", "t") say nothing; years do.
    const parts = p
      .split('/')
      .filter(Boolean)
      .filter((seg) => !/^\d+$/.test(seg) || /^(19|20)\d\d$/.test(seg))
      .filter((seg) => seg.length > 1 && !/^[0-9a-f]{12,}$/i.test(seg));
    const crumb = parts.slice(0, 3).join(' › ');
    return crumb.length > 56 ? `${crumb.slice(0, 56)}…` : crumb;
  } catch {
    return '';
  }
}

/** "today", "yesterday", "3 days ago", then the date: "Mar 12", or "Mar 2019" for other years. */
export function relativeDate(iso?: string, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.floor((now - t) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(t);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
}

const pluralRules = new Intl.PluralRules('en');

/** "1 post", "1,204 posts": a count with its noun in the right number. */
export function plural(n: number, one: string, other = `${one}s`): string {
  return `${n.toLocaleString()} ${pluralRules.select(n) === 'one' ? one : other}`;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init || {};
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (path !== '/api/auth/login') noteSignIn(res);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function sendToDownloads(params: {
  url: string;
  title?: string;
  target?: DownloadTargetId;
  sizeFormatted?: string;
}): Promise<{ job: DownloadJob }> {
  return api<{ job: DownloadJob }>('/api/downloads', { method: 'POST', json: params });
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage full or disabled
    }
  }, [key, value]);
  return [value, setValue];
}

export function useClickOutside<T extends HTMLElement>(onOutside: () => void, active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [active, onOutside]);
  return ref;
}

export interface Toast {
  id: number;
  text: string;
  tone?: 'ok' | 'error' | 'info';
}

/**
 * setTimeout for a component: callbacks still pending when it unmounts are
 * dropped, so a "Copied" or a closing menu never updates a component that's gone.
 */
export function useLater(): (fn: () => void, ms: number) => void {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);
  return useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const later = useLater();
  const push = useCallback(
    (text: string, tone: Toast['tone'] = 'info') => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-2), { id, text, tone }]);
      later(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
    },
    [later]
  );
  return { toasts, push };
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

// ── Domain rules ──────────────────────────────────────────────────────────
/** What you can tell glogg about a site: always on top, higher, lower, or never. */
export type DomainRule = 'pin' | 'raise' | 'lower' | 'hide';

export const DOMAIN_RULES: { id: DomainRule; label: string; verb: string; hint: string }[] = [
  { id: 'pin', label: 'Pinned', verb: 'Pin', hint: 'On top whenever they match your search' },
  { id: 'raise', label: 'Raised', verb: 'Raise', hint: 'Ranked higher' },
  { id: 'lower', label: 'Lowered', verb: 'Lower', hint: 'Still shown, ranked lower' },
  { id: 'hide', label: 'Hidden', verb: 'Hide', hint: 'Never shown' },
];

/** A domain from whatever was typed or pasted: "https://www.Example.com/x" → "example.com". */
export function cleanDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s]/)[0];
}

/** Gives `domain` one rule, taking it off the other lists. */
export function withDomainRule(lists: Record<DomainRule, string[]>, domain: string, rule: DomainRule | null): Record<DomainRule, string[]> {
  const out = Object.fromEntries(DOMAIN_RULES.map((r) => [r.id, lists[r.id].filter((d) => d !== domain)])) as Record<DomainRule, string[]>;
  if (rule) out[rule] = [domain, ...out[rule]];
  return out;
}

/** Context: whether result rows show site icons (fetched through glogg) or only their letters. */
export const SiteIconsContext = createContext(true);

// ── Your settings, as a file ──────────────────────────────────────────────
/**
 * The browser-side settings that make up "your settings": what export, import
 * and saving to this glogg carry. 18+ mode stays out (it only turns on after
 * its own confirmation), and so do search history and keys (keys live on the server).
 */
export const PROFILE_KEYS = [
  'glogg.prefs',
  'glogg.theme',
  'glogg.blocked',
  'glogg.boosted',
  'glogg.lowered',
  'glogg.pinned',
  'glogg.phrases',
  'glogg.bangs',
  'glogg.mode',
  'glogg.research.auto',
  'glogg.research.depth',
] as const;

export interface SettingsProfile {
  glogg: 'settings';
  version: 1;
  savedAt: string;
  settings: Partial<Record<(typeof PROFILE_KEYS)[number], unknown>>;
}

export function readProfile(storage: Storage = localStorage): SettingsProfile {
  const settings: SettingsProfile['settings'] = {};
  for (const key of PROFILE_KEYS) {
    try {
      const raw = storage.getItem(key);
      if (raw !== null) settings[key] = JSON.parse(raw);
    } catch {
      // unreadable: left out
    }
  }
  return { glogg: 'settings', version: 1, savedAt: new Date().toISOString(), settings };
}

const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const PROFILE_SHAPES: Record<(typeof PROFILE_KEYS)[number], (v: unknown) => boolean> = {
  'glogg.prefs': (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  'glogg.theme': (v) => v === 'system' || v === 'light' || v === 'dark',
  'glogg.blocked': isStringList,
  'glogg.boosted': isStringList,
  'glogg.lowered': isStringList,
  'glogg.pinned': isStringList,
  'glogg.phrases': isStringList,
  'glogg.bangs': (v) => Array.isArray(v) && v.every((b) => typeof b === 'object' && b !== null && typeof (b as { trigger?: unknown }).trigger === 'string' && typeof (b as { url?: unknown }).url === 'string'),
  'glogg.mode': (v) => v === 'simple' || v === 'advanced',
  'glogg.research.auto': (v) => typeof v === 'boolean',
  'glogg.research.depth': (v) => v === 'quick' || v === 'deep',
};

/**
 * Writes a profile's settings into storage and returns how many it applied.
 * Throws on something that isn't a glogg settings file; skips values of the wrong shape.
 */
export function applyProfile(input: unknown, storage: Storage = localStorage): number {
  const p = input as Partial<SettingsProfile> | null;
  if (!p || p.glogg !== 'settings' || typeof p.settings !== 'object' || p.settings === null) {
    throw new Error("That isn't a glogg settings file.");
  }
  let applied = 0;
  for (const key of PROFILE_KEYS) {
    const value = (p.settings as Record<string, unknown>)[key];
    if (value === undefined || !PROFILE_SHAPES[key](value)) continue;
    storage.setItem(key, JSON.stringify(value));
    applied += 1;
  }
  return applied;
}
