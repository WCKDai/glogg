/**
 * Plugin runtime: discovery, settings, tool execution, download hand-off and
 * per-plugin containers.
 *
 * Discovery order (later wins on id clash):
 *   1. <repo>/plugins/<id>/index.ts          (built-in)
 *   2. $GLOGG_HOME/plugins/<id>/index.{ts,mjs,js}  (yours; survives updates)
 * Folders starting with "_" or "." are ignored (templates, drafts).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type {
  PluginContainerStatus,
  PluginField,
  PluginInfo,
  PluginManifest,
  ToolResult,
} from '../../src/core/index.js';
import { loadIntegrationConfig } from '../downloadManager.js';
import type {
  DownloadHandoff,
  DownloadHandoffResult,
  PluginContext,
  PluginDefinition,
} from './sdk.js';
import { PluginError } from './sdk.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GLOGG_HOME = () => process.env.GLOGG_HOME || path.join(os.homedir(), '.glogg');
const SETTINGS_PATH = () => path.join(GLOGG_HOME(), 'plugins.json');
export const BUILTIN_PLUGIN_DIR = path.resolve(__dirname, '../../plugins');
export const USER_PLUGIN_DIR = () => path.join(GLOGG_HOME(), 'plugins');

const TOOL_TIMEOUT_MS = Number(process.env.GLOGG_TOOL_TIMEOUT_MS || 45_000);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

interface Loaded {
  def: PluginDefinition;
  source: 'builtin' | 'user';
  dir: string;
}

const registry = new Map<string, Loaded>();
const loadErrors: PluginInfo[] = [];
let loaded = false;

// ── Discovery ───────────────────────────────────────────────────────────────
/** Module loaders don't always throw Error instances; never show "[object Object]". */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
    try {
      return JSON.stringify(e).slice(0, 300);
    } catch {
      // circular: fall through
    }
  }
  return String(e);
}

function entryFile(dir: string): string | null {
  for (const f of ['index.ts', 'index.mjs', 'index.js']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function validateDefinition(def: unknown): string | null {
  const d = def as Partial<PluginDefinition> | undefined;
  if (!d || typeof d !== 'object') return 'default export is not an object';
  if (!d.id || !ID_RE.test(d.id)) return `invalid id "${d?.id}" (lowercase letters, digits, dashes)`;
  if (!d.name) return 'missing name';
  if (!d.category) return 'missing category';
  if (!Array.isArray(d.tools)) return 'tools must be an array';
  const seen = new Set<string>();
  for (const t of d.tools) {
    if (!t.id || !ID_RE.test(t.id)) return `tool has invalid id "${t?.id}"`;
    if (seen.has(t.id)) return `duplicate tool id "${t.id}"`;
    seen.add(t.id);
    if (typeof t.run !== 'function') return `tool "${t.id}" has no run()`;
    if (!Array.isArray(t.inputs)) return `tool "${t.id}" inputs must be an array`;
  }
  if (d.downloadTarget && typeof d.sendDownload !== 'function') return 'downloadTarget declared without sendDownload()';
  return null;
}

export function registerPlugin(def: PluginDefinition, source: 'builtin' | 'user' = 'builtin', dir = ''): void {
  const err = validateDefinition(def);
  if (err) throw new Error(`Plugin ${def?.id ?? '?'}: ${err}`);
  registry.set(def.id, { def, source, dir });
}

export function unregisterPlugin(id: string): void {
  registry.delete(id);
}

async function loadFrom(dir: string, source: 'builtin' | 'user'): Promise<void> {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const pdir = path.join(dir, name);
    if (!fs.statSync(pdir).isDirectory()) continue;
    const file = entryFile(pdir);
    if (!file) continue;
    try {
      const mod = (await import(`${pathToFileURL(file).href}?v=${Math.trunc(fs.statSync(file).mtimeMs)}`)) as {
        default?: PluginDefinition;
      };
      const def = mod.default;
      const err = validateDefinition(def);
      if (err) throw new Error(err);
      registry.set(def!.id, { def: def!, source, dir: pdir });
    } catch (e) {
      loadErrors.push({
        id: name,
        name,
        description: '',
        category: 'utility',
        tools: [],
        source,
        configured: false,
        hasRunner: false,
        error: describeError(e),
      });
    }
  }
}

export async function loadPlugins(opts: { force?: boolean; dirs?: { dir: string; source: 'builtin' | 'user' }[] } = {}): Promise<void> {
  if (loaded && !opts.force) return;
  if (opts.force) {
    for (const [id, p] of registry) if (p.dir) registry.delete(id);
    loadErrors.length = 0;
  }
  const dirs = opts.dirs ?? [
    { dir: BUILTIN_PLUGIN_DIR, source: 'builtin' as const },
    { dir: USER_PLUGIN_DIR(), source: 'user' as const },
  ];
  for (const d of dirs) await loadFrom(d.dir, d.source);
  loaded = true;
}

// ── Settings ────────────────────────────────────────────────────────────────
type SettingsFile = Record<string, Record<string, string>>;

function readSettingsFile(): SettingsFile {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')) as SettingsFile;
  } catch {
    return {};
  }
}

function writeSettingsFile(data: SettingsFile): void {
  fs.mkdirSync(GLOGG_HOME(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETTINGS_PATH(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function defaultsFor(fields: PluginField[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) if (f.default !== undefined) out[f.key] = String(f.default);
  return out;
}

export function getPluginSettings(id: string): Record<string, string> {
  const def = registry.get(id)?.def;
  return { ...defaultsFor(def?.settings), ...(readSettingsFile()[id] || {}) };
}

export function maskPluginSettings(id: string, values = getPluginSettings(id)): Record<string, string> {
  const def = registry.get(id)?.def;
  const out = { ...values };
  for (const f of def?.settings || []) {
    if ((f.secret || f.type === 'password') && out[f.key]) out[f.key] = `••••${out[f.key].slice(-4)}`;
  }
  return out;
}

/** Masked values (••••xxxx) mean "unchanged"; empty string clears. */
export function savePluginSettings(id: string, patch: Record<string, unknown>): Record<string, string> {
  const def = registry.get(id)?.def;
  if (!def) throw new Error(`Unknown plugin ${id}`);
  const allowed = new Set((def.settings || []).map((f) => f.key));
  const file = readSettingsFile();
  const next = { ...(file[id] || {}) };
  for (const [k, raw] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    const v = typeof raw === 'boolean' ? String(raw) : typeof raw === 'number' ? String(raw) : raw;
    if (typeof v !== 'string' || v.startsWith('••••')) continue;
    if (v.trim() === '') delete next[k];
    else next[k] = v.trim();
  }
  file[id] = next;
  writeSettingsFile(file);
  return getPluginSettings(id);
}

function isConfigured(def: PluginDefinition, settings: Record<string, string>): boolean {
  const integrations = loadIntegrationConfig();
  if (def.isConfigured) {
    try {
      return def.isConfigured({ settings, integrations });
    } catch {
      return false;
    }
  }
  return (def.settings || []).filter((f) => f.required).every((f) => Boolean(settings[f.key]));
}

// ── Listing ─────────────────────────────────────────────────────────────────
function toManifest(def: PluginDefinition): PluginManifest {
  const { tools, isConfigured: _i, sendDownload: _s, pollDownload: _p, ...rest } = def;
  return { ...rest, tools: tools.map(({ run: _r, ...t }) => t) };
}

export function listPlugins(): PluginInfo[] {
  const out: PluginInfo[] = [];
  for (const { def, source } of registry.values()) {
    out.push({
      ...toManifest(def),
      source,
      hasRunner: true,
      configured: isConfigured(def, getPluginSettings(def.id)),
    });
  }
  out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return [...out, ...loadErrors];
}

export function getPlugin(id: string): PluginDefinition | undefined {
  return registry.get(id)?.def;
}

// ── Execution ───────────────────────────────────────────────────────────────
function makeContext(id: string, signal: AbortSignal): PluginContext {
  const settings = getPluginSettings(id);
  const ctxFetch = async (url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const onAbort = () => c.abort();
    signal.addEventListener('abort', onAbort);
    try {
      return await fetch(url, {
        ...init,
        signal: c.signal,
        headers: { 'User-Agent': 'glogg/0.4 (+https://github.com/WCKDai/glogg)', ...(init.headers || {}) },
      });
    } catch (e) {
      if (c.signal.aborted) throw new PluginError(`Timed out reaching ${new URL(url).host}`);
      throw new PluginError(`Couldn't reach ${new URL(url).host}: ${e instanceof Error ? e.message : e}`);
    } finally {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
    }
  };
  return {
    settings,
    integrations: loadIntegrationConfig(),
    signal,
    fetch: ctxFetch,
    async fetchJson<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
      const res = await ctxFetch(url, init, timeoutMs);
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new PluginError(`${new URL(url).host} returned non-JSON (HTTP ${res.status})`);
      }
      if (!res.ok) {
        const d = data as { error?: string; message?: string; detail?: string; error_code?: number };
        throw new PluginError(`${new URL(url).host}: ${d.error || d.message || d.detail || `HTTP ${res.status}`}`);
      }
      return data as T;
    },
    saveSetting(key, value) {
      const file = readSettingsFile();
      file[id] = { ...(file[id] || {}), [key]: value };
      writeSettingsFile(file);
      settings[key] = value;
    },
  };
}

export async function runPluginTool(
  pluginId: string,
  toolId: string,
  input: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ToolResult> {
  const def = registry.get(pluginId)?.def;
  if (!def) return errorResult(`Unknown plugin "${pluginId}"`);
  const tool = def.tools.find((t) => t.id === toolId);
  if (!tool) return errorResult(`Plugin "${def.name}" has no tool "${toolId}"`);

  for (const f of tool.inputs) {
    const v = input[f.key];
    if (f.required && (v === undefined || v === null || (typeof v === 'string' && !v.trim()))) {
      return errorResult(`${f.label} is required`);
    }
  }
  const settings = getPluginSettings(pluginId);
  if (tool.requiresSettings && !isConfigured(def, settings)) {
    return errorResult(`${def.name} isn't set up yet — add your keys in its settings.`, 'warn');
  }

  const ctrl = new AbortController();
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      tool.run(input, makeContext(pluginId, ctrl.signal)),
      new Promise<ToolResult>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort();
          reject(new PluginError(`Timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

function errorResult(message: string, tone: 'bad' | 'warn' = 'bad'): ToolResult {
  return { blocks: [{ type: 'notice', tone, content: message }], summary: message };
}

// ── Download hand-off ───────────────────────────────────────────────────────
export interface PluginDownloadTarget {
  id: `plugin:${string}`;
  pluginId: string;
  label: string;
  accepts: ('magnet' | 'torrent' | 'nzb' | 'link')[];
  configured: boolean;
}

export function listDownloadTargets(): PluginDownloadTarget[] {
  const out: PluginDownloadTarget[] = [];
  for (const { def } of registry.values()) {
    if (!def.downloadTarget || !def.sendDownload) continue;
    out.push({
      id: `plugin:${def.id}`,
      pluginId: def.id,
      label: def.downloadTarget.label,
      accepts: def.downloadTarget.accepts,
      configured: isConfigured(def, getPluginSettings(def.id)),
    });
  }
  return out;
}

export function kindToAccept(kind: DownloadHandoff['kind']): 'magnet' | 'torrent' | 'nzb' | 'link' {
  return kind === 'magnet' || kind === 'torrent' || kind === 'nzb' ? kind : 'link';
}

export async function sendToPluginTarget(pluginId: string, item: DownloadHandoff): Promise<DownloadHandoffResult> {
  const def = registry.get(pluginId)?.def;
  if (!def?.sendDownload) throw new Error(`Plugin "${pluginId}" can't receive downloads`);
  if (!isConfigured(def, getPluginSettings(pluginId))) throw new Error(`${def.name} isn't set up yet`);
  const accepts = def.downloadTarget?.accepts || [];
  if (!accepts.includes(kindToAccept(item.kind))) throw new Error(`${def.name} doesn't accept ${item.kind} links`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    return await def.sendDownload(item, makeContext(pluginId, ctrl.signal));
  } finally {
    clearTimeout(t);
  }
}

export async function pollPluginDownload(pluginId: string, remoteId: string): Promise<Partial<DownloadHandoffResult> | null> {
  const def = registry.get(pluginId)?.def;
  if (!def?.pollDownload) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    return await def.pollDownload(remoteId, makeContext(pluginId, ctrl.signal));
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Containers ──────────────────────────────────────────────────────────────
async function containerRuntime(): Promise<'docker' | 'podman' | 'none'> {
  for (const bin of ['docker', 'podman'] as const) {
    try {
      await execFileAsync(bin, ['info', '--format', '{{.ID}}'], { timeout: 4000 });
      return bin;
    } catch {
      // try next
    }
  }
  return 'none';
}

const containerName = (id: string) => `glogg-plugin-${id}`;

export async function pluginContainerStatus(id: string): Promise<PluginContainerStatus> {
  const def = registry.get(id)?.def;
  if (!def?.container) return { runtime: 'none', state: 'unavailable', detail: 'No container declared' };
  const runtime = await containerRuntime();
  if (runtime === 'none') return { runtime, state: 'unavailable', detail: 'Docker or Podman is not running' };
  try {
    const { stdout } = await execFileAsync(
      runtime,
      ['ps', '-a', '--filter', `name=^${containerName(id)}$`, '--format', '{{.State}}|{{.Status}}'],
      { timeout: 6000 }
    );
    const line = stdout.trim().split('\n')[0];
    if (!line) return { runtime, state: 'missing' };
    const [state, status] = line.split('|');
    return { runtime, state: state === 'running' ? 'running' : 'stopped', detail: status };
  } catch (e) {
    return { runtime, state: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function pluginContainerAction(id: string, action: 'up' | 'down' | 'remove'): Promise<PluginContainerStatus & { output: string }> {
  const def = registry.get(id)?.def;
  if (!def?.container) throw new Error('This plugin has no container');
  const status = await pluginContainerStatus(id);
  if (status.runtime === 'none') throw new Error('Docker or Podman is not running');
  const rt = status.runtime;
  const name = containerName(id);
  let output = '';
  const run = async (args: string[], timeout = 300_000) => {
    const { stdout, stderr } = await execFileAsync(rt, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    output += `${stdout}${stderr}`;
  };
  if (action === 'up') {
    if (status.state === 'stopped') await run(['start', name]);
    else if (status.state === 'missing') {
      const c = def.container;
      const dataDir = path.join(GLOGG_HOME(), 'containers', id);
      fs.mkdirSync(dataDir, { recursive: true });
      const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped', '--label', 'glogg.plugin=' + id];
      for (const p of c.ports || []) args.push('-p', p);
      for (const [k, v] of Object.entries(c.env || {})) args.push('-e', `${k}=${v}`);
      for (const v of c.volumes || []) args.push('-v', v.replace('$DATA', dataDir));
      args.push(c.image, ...(c.args || []));
      await run(args);
    }
  } else if (action === 'down') {
    if (status.state === 'running') await run(['stop', name], 60_000);
  } else if (action === 'remove') {
    if (status.state !== 'missing') await run(['rm', '-f', name], 60_000);
  }
  return { ...(await pluginContainerStatus(id)), output: output.trim() };
}
