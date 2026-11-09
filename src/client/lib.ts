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

/** POSTs JSON and calls onEvent for each line of a newline-delimited JSON response. */
export async function streamEvents<T>(path: string, json: unknown, signal: AbortSignal, onEvent: (e: T) => void): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
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
      if (line) onEvent(JSON.parse(line) as T);
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as T);
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
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

export function urlCrumb(url: string): string {
  try {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    if (!p || p === '/') return '';
    const parts = p.split('/').filter(Boolean);
    const crumb = parts.slice(0, 3).join(' › ');
    return crumb.length > 56 ? `${crumb.slice(0, 56)}…` : crumb;
  } catch {
    return '';
  }
}

export function relativeDate(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return new Date(t).getFullYear().toString();
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init || {};
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
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

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);
  return { toasts, push };
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}
