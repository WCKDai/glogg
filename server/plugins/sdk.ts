/**
 * glogg plugin SDK. Plugin authors import from here:
 *
 *   import { definePlugin } from '../../server/plugins/sdk.js';
 *   export default definePlugin({ id: 'hello', name: 'Hello', category: 'utility', ... });
 *
 * Plugins outside the repo (~/.glogg/plugins/<id>/index.mjs) can skip the import and
 * default-export a plain object of the same shape — definePlugin is only for types.
 */
import type {
  CustomEndpointsConfig,
  DownloadJob,
  PluginManifest,
  PluginToolDef,
  ToolResult,
} from '../../src/core/index.js';

export type { OutputBlock, OutputAction, ToolResult, Tone } from '../../src/core/index.js';

export interface PluginContext {
  /** This plugin's saved settings (unmasked; server-side only). */
  settings: Record<string, string>;
  /** Shared integration config (Offcloud, NZB.life, Nextcloud, aria2…). */
  integrations: CustomEndpointsConfig;
  /** Aborted when the tool times out or the client disconnects. */
  signal: AbortSignal;
  fetch(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response>;
  fetchJson<T = unknown>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T>;
  /** Persist a value into this plugin's settings (e.g. a refreshed token). */
  saveSetting(key: string, value: string): void;
}

export type ToolInput = Record<string, unknown>;

export interface PluginTool extends PluginToolDef {
  run(input: ToolInput, ctx: PluginContext): Promise<ToolResult>;
}

export interface DownloadHandoff {
  url: string;
  title: string;
  kind: DownloadJob['kind'];
}

export interface DownloadHandoffResult {
  remoteId?: string;
  status: DownloadJob['status'];
  detail: string;
  destinationUrl?: string;
  progressPercent?: number;
}

export interface PluginDefinition extends Omit<PluginManifest, 'tools'> {
  tools: PluginTool[];
  /** Defaults to "every required setting is filled in". */
  isConfigured?(ctx: Pick<PluginContext, 'settings' | 'integrations'>): boolean;
  /** Required when `downloadTarget` is declared. */
  sendDownload?(item: DownloadHandoff, ctx: PluginContext): Promise<DownloadHandoffResult>;
  /** Optional: refresh an in-flight job created by sendDownload. */
  pollDownload?(remoteId: string, ctx: PluginContext): Promise<Partial<DownloadHandoffResult> | null>;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

// ── Small helpers plugin authors keep re-writing ────────────────────────────
export class PluginError extends Error {}

export function fail(message: string): never {
  throw new PluginError(message);
}

export function str(input: ToolInput, key: string, fallback = ''): string {
  const v = input[key];
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : fallback;
}

export function bool(input: ToolInput, key: string): boolean {
  const v = input[key];
  return v === true || v === 'true' || v === 'on' || v === '1';
}

export function need(ctx: Pick<PluginContext, 'settings'>, key: string, label = key): string {
  const v = ctx.settings[key];
  if (!v) fail(`${label} is not set — open this plugin's settings.`);
  return v;
}

export function formatBytes(n: number | string | undefined): string {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Accepts "example.com", "https://example.com/x" or "user@example.com" → "example.com". */
export function toHostname(input: string): string {
  const s = input.trim();
  if (!s) fail('A domain or URL is required.');
  if (s.includes('@') && !s.includes('/')) return s.split('@').pop()!.toLowerCase();
  try {
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return fail(`"${s}" is not a valid domain or URL.`);
  }
}

export function toUrl(input: string): string {
  const s = input.trim();
  if (!s) fail('A URL is required.');
  try {
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).toString();
  } catch {
    return fail(`"${s}" is not a valid URL.`);
  }
}

export function form(data: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
  };
}

export function multipart(data: Record<string, string | Blob>): RequestInit {
  const fd = new FormData();
  for (const [k, v] of Object.entries(data)) fd.append(k, v);
  return { method: 'POST', body: fd };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
