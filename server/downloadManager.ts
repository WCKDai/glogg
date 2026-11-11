import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import {
  CustomEndpointsConfig,
  DownloadJob,
  DownloadManagerReport,
  DownloadTargetId,
} from '../src/core/types.js';

const execFileAsync = promisify(execFile);

const GLOGG_HOME = process.env.GLOGG_HOME || path.join(os.homedir(), '.glogg');
const CONFIG_PATH = path.join(GLOGG_HOME, 'integrations.json');
const JOBS_PATH = path.join(GLOGG_HOME, 'downloads.json');
export const LOCAL_DOWNLOADS_DIR =
  process.env.GLOGG_DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads', 'glogg');

const SECRET_KEYS: (keyof CustomEndpointsConfig)[] = [
  'offcloudApiKey',
  'nzbLifeApiKey',
  'marginaliaApiKey',
  'stackexchangeKey',
  'braveApiKey',
  'nextcloudAppPassword',
  'aria2RpcSecret',
  'torznabApiKey',
  'newznabApiKey',
];

const DEFAULT_CONFIG: CustomEndpointsConfig = {
  aria2RpcUrl: 'http://localhost:6800/jsonrpc',
  nzbLifeUrl: 'https://api.nzb.life/api',
  nextcloudFolder: 'glogg',
};

function ensureHome(): void {
  fs.mkdirSync(GLOGG_HOME, { recursive: true, mode: 0o700 });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureHome();
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function loadIntegrationConfig(): CustomEndpointsConfig {
  return { ...DEFAULT_CONFIG, ...readJson<CustomEndpointsConfig>(CONFIG_PATH, {}) };
}

/**
 * The secret for the aria2 that glogg's services stack runs, made once per
 * install. A fixed one would let any web page you visit drive aria2 on
 * localhost:6800, since aria2 answers whoever knows it.
 */
export function aria2Secret(): string {
  const saved = loadIntegrationConfig().aria2RpcSecret;
  if (saved) return saved;
  const secret = randomBytes(24).toString('base64url');
  saveIntegrationConfig({ aria2RpcSecret: secret });
  return secret;
}

/** Never ship secrets back to the browser. */
export function maskConfig(cfg: CustomEndpointsConfig): CustomEndpointsConfig {
  const out: CustomEndpointsConfig = { ...cfg };
  for (const k of SECRET_KEYS) {
    const v = out[k];
    if (typeof v === 'string' && v.length > 0) {
      (out as Record<string, string>)[k] = `••••${v.slice(-4)}`;
    }
  }
  return out;
}

/** Every setting an integration config may hold; anything else in a patch is ignored. */
const INTEGRATION_KEYS = new Set<keyof CustomEndpointsConfig>([
  'bitmagnetUrl', 'searxngUrl', 'ipfsGatewayUrl', 'torznabUrl', 'torznabApiKey', 'newznabUrl', 'newznabApiKey',
  'nzbLifeUrl', 'nzbLifeApiKey', 'marginaliaApiKey', 'stackexchangeKey', 'braveApiKey', 'offcloudApiKey', 'offcloudRemoteOptionId',
  'nextcloudUrl', 'nextcloudUser', 'nextcloudAppPassword', 'nextcloudFolder', 'aria2RpcUrl', 'aria2RpcSecret',
  'matrixHomeserverUrl', 'atprotoAppViewUrl',
]);

/** Merge a patch; masked values (••••xxxx) mean "unchanged", empty string clears. */
export function saveIntegrationConfig(patch: CustomEndpointsConfig): CustomEndpointsConfig {
  const current = loadIntegrationConfig();
  const next: CustomEndpointsConfig = { ...current };
  for (const [k, v] of Object.entries(patch) as [keyof CustomEndpointsConfig, string | undefined][]) {
    if (!INTEGRATION_KEYS.has(k) || typeof v !== 'string') continue;
    if (v.startsWith('••••')) continue;
    if (v.trim() === '') delete next[k];
    else (next as Record<string, string>)[k] = v.trim();
  }
  writeJson(CONFIG_PATH, next);
  return next;
}

function loadJobs(): DownloadJob[] {
  return readJson<DownloadJob[]>(JOBS_PATH, []);
}

function saveJobs(jobs: DownloadJob[]): void {
  writeJson(JOBS_PATH, jobs.slice(0, 200));
}

function upsertJob(job: DownloadJob): DownloadJob {
  const jobs = loadJobs().filter((j) => j.id !== job.id);
  saveJobs([job, ...jobs]);
  return job;
}

export function detectKind(url: string): DownloadJob['kind'] {
  const lower = url.toLowerCase();
  if (lower.startsWith('magnet:')) return 'magnet';
  if (/\.nzb(\?|$)/.test(lower) || lower.includes('t=get') || lower.includes('/getnzb')) return 'nzb';
  if (/\.torrent(\?|$)/.test(lower)) return 'torrent';
  if (/\.(zip|rar|7z|iso|img|tar|gz|xz|mkv|mp4|mp3|flac|pdf|epub|exe|dmg)(\?|$)/.test(lower)) {
    return 'direct-file';
  }
  return 'web-archive';
}

/** A name that stays a name: no folders, control characters or leading dots. */
export function safeFileName(name: string): string {
  const base = name.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() ?? '';
  return base.replace(/^[.\s]+/, '').slice(0, 160).trim();
}

export function filenameFor(url: string, title: string, kind: DownloadJob['kind']): string {
  const safeTitle = safeFileName(title.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 120)) || 'download';
  if (kind === 'nzb') return safeTitle.endsWith('.nzb') ? safeTitle : `${safeTitle}.nzb`;
  if (kind === 'torrent') return safeTitle.endsWith('.torrent') ? safeTitle : `${safeTitle}.torrent`;
  if (kind === 'magnet') return `${safeTitle}.magnet`;
  try {
    // Decoded before it's cleaned, so "..%2F" in an address can't climb out of the folder.
    const base = safeFileName(decodeURIComponent(new URL(url).pathname.split('/').pop() || ''));
    if (base.includes('.')) return base;
  } catch {
    // fall through
  }
  return `${safeTitle}.html`;
}

/**
 * Streams a response into `dir` under `name`, never outside it and never over
 * an existing file: a taken name becomes "name (1).ext". A failed transfer
 * leaves nothing behind.
 */
export async function saveNew(dir: string, name: string, res: Response): Promise<string> {
  const root = path.resolve(dir);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const dest = path.resolve(root, n ? `${stem} (${n})${ext}` : name);
    if (path.dirname(dest) !== root) throw new Error('Refusing a file name that leaves the downloads folder');
    const out = fs.createWriteStream(dest, { flags: 'wx' });
    try {
      await once(out, 'open');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    try {
      if (res.body) await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), out);
      else out.end();
    } catch (e) {
      out.destroy();
      fs.rmSync(dest, { force: true });
      throw e;
    }
    return dest;
  }
  throw new Error(`Too many files named ${name}`);
}

const BUILTIN_TARGETS = new Set(['auto', 'offcloud', 'nextcloud', 'aria2-rpc', 'local-vault']);

async function timedFetch(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

/** A service's JSON answer; an HTML error page (from a proxy in front of it, say) is an error naming the service and the status. */
async function jsonFrom<T>(res: Response, service: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${service}: ${res.ok ? 'the answer was not JSON' : res.status}`);
  }
}

// ── aria2 JSON-RPC ──────────────────────────────────────────────────────────
async function aria2Call<T>(cfg: CustomEndpointsConfig, method: string, params: unknown[]): Promise<T> {
  const url = cfg.aria2RpcUrl || 'http://localhost:6800/jsonrpc';
  const token = [`token:${cfg.aria2RpcSecret || aria2Secret()}`];
  const res = await timedFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: [...token, ...params] }),
    },
    3000
  );
  const data = await jsonFrom<{ result?: T; error?: { message: string } }>(res, 'aria2');
  if (data.error) throw new Error(`aria2: ${data.error.message}`);
  return data.result as T;
}

export async function isAria2Reachable(cfg: CustomEndpointsConfig): Promise<boolean> {
  try {
    await aria2Call(cfg, 'aria2.getVersion', []);
    return true;
  } catch {
    return false;
  }
}

// ── Offcloud ────────────────────────────────────────────────────────────────
async function offcloudAdd(cfg: CustomEndpointsConfig, url: string): Promise<{ requestId?: string; status?: string; url?: string }> {
  const res = await timedFetch(
    `https://offcloud.com/api/cloud?key=${encodeURIComponent(cfg.offcloudApiKey || '')}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url }).toString(),
    },
    12000
  );
  const data = await jsonFrom<{ requestId?: string; status?: string; url?: string; error?: string }>(res, 'Offcloud');
  if (!res.ok || data.error) throw new Error(`Offcloud: ${data.error || res.status}`);
  return data;
}

async function offcloudStatus(cfg: CustomEndpointsConfig, requestIds: string[]): Promise<Record<string, { status?: string; url?: string; fileSize?: number }>> {
  if (requestIds.length === 0) return {};
  const res = await timedFetch(
    `https://offcloud.com/api/cloud/status?key=${encodeURIComponent(cfg.offcloudApiKey || '')}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestIds }),
    },
    8000
  );
  const data = (await res.json()) as {
    requests?: { requestId: string; status?: string; url?: string; fileSize?: number }[];
  };
  const out: Record<string, { status?: string; url?: string; fileSize?: number }> = {};
  for (const r of data.requests || []) out[r.requestId] = r;
  return out;
}

// ── Nextcloud WebDAV ────────────────────────────────────────────────────────
function nextcloudDavBase(cfg: CustomEndpointsConfig): string {
  const base = (cfg.nextcloudUrl || '').replace(/\/+$/, '');
  const folder = (cfg.nextcloudFolder || 'glogg').replace(/^\/+|\/+$/g, '');
  return `${base}/remote.php/dav/files/${encodeURIComponent(cfg.nextcloudUser || '')}/${folder}`;
}

async function nextcloudPut(cfg: CustomEndpointsConfig, filename: string, body: Buffer | string): Promise<string> {
  const auth = `Basic ${Buffer.from(`${cfg.nextcloudUser}:${cfg.nextcloudAppPassword}`).toString('base64')}`;
  const dir = nextcloudDavBase(cfg);
  await timedFetch(dir, { method: 'MKCOL', headers: { Authorization: auth } }, 6000).catch(() => undefined);
  const target = `${dir}/${encodeURIComponent(filename)}`;
  const res = await timedFetch(
    target,
    { method: 'PUT', headers: { Authorization: auth }, body: typeof body === 'string' ? body : new Uint8Array(body) },
    60000
  );
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`Nextcloud WebDAV PUT failed (${res.status})`);
  }
  return target;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await timedFetch(url, { headers: { 'User-Agent': 'glogg/0.4' } }, 60000);
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Target selection ────────────────────────────────────────────────────────
export interface AutoTargetPlugin {
  id: `plugin:${string}`;
  accepts: ('magnet' | 'torrent' | 'nzb' | 'link')[];
}

/**
 * Auto routing: cloud/debrid first (fast, no local disk), then local engines.
 * Configured plugins slot in right after the built-in service for each kind.
 */
export function resolveAutoTarget(
  kind: DownloadJob['kind'],
  cfg: CustomEndpointsConfig,
  aria2Up: boolean,
  plugins: AutoTargetPlugin[] = []
): Exclude<DownloadTargetId, 'auto'> {
  const hasOffcloud = Boolean(cfg.offcloudApiKey);
  const hasNextcloud = Boolean(cfg.nextcloudUrl && cfg.nextcloudUser && cfg.nextcloudAppPassword);
  const plugin = (accept: AutoTargetPlugin['accepts'][number]) => plugins.find((p) => p.accepts.includes(accept))?.id;
  if (kind === 'magnet' || kind === 'torrent') {
    if (hasOffcloud) return 'offcloud';
    const p = plugin(kind);
    if (p) return p;
    if (aria2Up) return 'aria2-rpc';
    return 'local-vault';
  }
  if (kind === 'nzb') {
    const p = plugin('nzb');
    if (p) return p;
    if (hasNextcloud) return 'nextcloud';
    return 'local-vault';
  }
  if (kind === 'direct-file') {
    if (aria2Up) return 'aria2-rpc';
    if (hasOffcloud) return 'offcloud';
    const p = plugin('link');
    if (p) return p;
    return 'local-vault';
  }
  return hasNextcloud ? 'nextcloud' : 'local-vault';
}

export async function enqueueDownload(params: {
  url: string;
  title?: string;
  target?: DownloadTargetId;
  sizeFormatted?: string;
}): Promise<DownloadJob> {
  const cfg = loadIntegrationConfig();
  const url = params.url.trim();
  if (!/^(https?:|magnet:)/i.test(url)) {
    throw new Error('Only http(s) and magnet: URLs are supported');
  }
  if (params.target && !BUILTIN_TARGETS.has(params.target) && !/^plugin:[\w-]+$/.test(params.target)) {
    throw new Error(`Unknown download target "${String(params.target).slice(0, 40)}"`);
  }
  const kind = detectKind(url);
  const title = params.title?.trim() || url.slice(0, 80);
  const aria2Up = await isAria2Reachable(cfg);
  const plugins = await import('./plugins/runtime.js');
  await plugins.loadPlugins();
  const pluginTargets = plugins.listDownloadTargets().filter((t) => t.configured);
  const target =
    !params.target || params.target === 'auto'
      ? resolveAutoTarget(kind, cfg, aria2Up, pluginTargets)
      : params.target;

  const job: DownloadJob = {
    id: randomUUID(),
    title,
    sourceUrl: url,
    kind,
    target,
    status: 'queued',
    progressPercent: 0,
    sizeFormatted: params.sizeFormatted,
    createdAt: new Date().toISOString(),
    statusDetail: 'Queued',
  };

  try {
    if (target.startsWith('plugin:')) {
      const r = await plugins.sendToPluginTarget(target.slice('plugin:'.length), { url, title, kind });
      job.remoteId = r.remoteId;
      job.status = r.status;
      job.statusDetail = r.detail;
      job.destinationUrl = r.destinationUrl;
      job.progressPercent = r.progressPercent ?? (r.status === 'completed' || r.status === 'cached-instant' ? 100 : 0);
    } else if (target === 'offcloud') {
      if (!cfg.offcloudApiKey) throw new Error('Offcloud API key not configured');
      const r = await offcloudAdd(cfg, url);
      job.remoteId = r.requestId;
      job.status = r.status === 'downloaded' ? 'cached-instant' : 'downloading';
      job.progressPercent = r.status === 'downloaded' ? 100 : 0;
      job.destinationUrl = r.url;
      job.statusDetail = r.status === 'downloaded' ? 'Cached on Offcloud' : `Offcloud: ${r.status || 'submitted'}`;
    } else if (target === 'aria2-rpc') {
      const gid = await aria2Call<string>(cfg, 'aria2.addUri', [[url], {}]);
      job.remoteId = gid;
      job.status = 'downloading';
      job.statusDetail = 'Sent to aria2';
      job.destinationUrl = '/downloads';
    } else if (target === 'nextcloud') {
      if (!cfg.nextcloudUrl || !cfg.nextcloudUser || !cfg.nextcloudAppPassword) {
        throw new Error('Nextcloud URL / user / app password not configured');
      }
      const filename = filenameFor(url, title, kind);
      const body = kind === 'magnet' ? `${url}\n` : await fetchBytes(url);
      job.destinationUrl = await nextcloudPut(cfg, filename, body);
      job.status = 'completed';
      job.progressPercent = 100;
      job.statusDetail = `Saved to Nextcloud /${cfg.nextcloudFolder || 'glogg'}`;
    } else {
      // local-vault: magnets go to the OS-registered torrent client, everything else to ~/Downloads/glogg
      if (kind === 'magnet') {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        await execFileAsync(opener, [url], { timeout: 5000 });
        job.status = 'completed';
        job.progressPercent = 100;
        job.statusDetail = 'Handed to your default torrent client';
      } else {
        fs.mkdirSync(LOCAL_DOWNLOADS_DIR, { recursive: true });
        const res = await timedFetch(url, { headers: { 'User-Agent': 'glogg/0.4' } }, 60000);
        if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
        job.destinationUrl = await saveNew(LOCAL_DOWNLOADS_DIR, filenameFor(url, title, kind), res);
        job.status = 'completed';
        job.progressPercent = 100;
        job.statusDetail =
          kind === 'nzb' ? 'Saved .nzb — point SABnzbd/NZBGet watch folder here' : 'Saved locally';
      }
    }
  } catch (err) {
    job.status = 'failed';
    job.statusDetail = err instanceof Error ? err.message : String(err);
  }

  return upsertJob(job);
}

/** Refresh in-flight jobs from aria2 / Offcloud. */
export async function refreshDownloads(): Promise<DownloadJob[]> {
  const cfg = loadIntegrationConfig();
  const jobs = loadJobs();
  const active = jobs.filter((j) => j.status === 'downloading' || j.status === 'queued');
  if (active.length === 0) return jobs;

  const offcloudIds = active.filter((j) => j.target === 'offcloud' && j.remoteId).map((j) => j.remoteId!);
  const offStatus = cfg.offcloudApiKey ? await offcloudStatus(cfg, offcloudIds).catch(() => ({})) : {};

  for (const job of active) {
    try {
      if (job.target === 'aria2-rpc' && job.remoteId) {
        const s = await aria2Call<{
          status: string;
          totalLength: string;
          completedLength: string;
          downloadSpeed: string;
          followedBy?: string[];
          errorMessage?: string;
        }>(cfg, 'aria2.tellStatus', [job.remoteId, ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'followedBy', 'errorMessage']]);
        // Magnets resolve metadata first, then spawn the real download: follow it, and don't show the metadata's 100% as the file's.
        if (s.followedBy && s.followedBy.length > 0) {
          job.remoteId = s.followedBy[0];
          job.progressPercent = 0;
          job.statusDetail = 'Starting';
          continue;
        }
        const total = Number(s.totalLength) || 0;
        const done = Number(s.completedLength) || 0;
        job.progressPercent = total > 0 ? Math.round((done / total) * 100) : 0;
        if (s.status === 'complete') {
          job.status = 'completed';
          job.progressPercent = 100;
          job.statusDetail = 'Done';
        } else if (s.status === 'error' || s.status === 'removed') {
          job.status = 'failed';
          job.statusDetail = s.errorMessage || s.status;
        } else {
          const kbps = Math.round((Number(s.downloadSpeed) || 0) / 1024);
          job.statusDetail = `${s.status} · ${kbps} KB/s`;
        }
      } else if (job.target.startsWith('plugin:') && job.remoteId) {
        const { pollPluginDownload } = await import('./plugins/runtime.js');
        const s = await pollPluginDownload(job.target.slice('plugin:'.length), job.remoteId);
        if (s) {
          if (s.status) job.status = s.status;
          if (s.detail) job.statusDetail = s.detail;
          if (s.destinationUrl) job.destinationUrl = s.destinationUrl;
          if (typeof s.progressPercent === 'number') job.progressPercent = s.progressPercent;
        }
      } else if (job.target === 'offcloud' && job.remoteId) {
        const s = (offStatus as Record<string, { status?: string; url?: string }>)[job.remoteId];
        if (s) {
          if (s.status === 'downloaded') {
            job.status = 'completed';
            job.progressPercent = 100;
            job.destinationUrl = s.url || job.destinationUrl;
            job.statusDetail = 'Ready on Offcloud';
          } else if (s.status === 'error' || s.status === 'canceled') {
            job.status = 'failed';
            job.statusDetail = `Offcloud: ${s.status}`;
          } else {
            job.statusDetail = `Offcloud: ${s.status || 'processing'}`;
          }
        }
      }
    } catch {
      // keep previous state; next poll will retry
    }
  }
  saveJobs(jobs);
  return jobs;
}

export function removeDownload(id: string): DownloadJob[] {
  const jobs = loadJobs().filter((j) => j.id !== id);
  saveJobs(jobs);
  return jobs;
}

export function clearFinishedDownloads(): DownloadJob[] {
  const jobs = loadJobs().filter((j) => j.status === 'downloading' || j.status === 'queued');
  saveJobs(jobs);
  return jobs;
}

export async function getDownloadManagerReport(): Promise<DownloadManagerReport> {
  const cfg = loadIntegrationConfig();
  const jobs = await refreshDownloads();
  const plugins = await import('./plugins/runtime.js');
  await plugins.loadPlugins();
  return {
    pluginTargets: plugins.listDownloadTargets(),
    config: maskConfig(cfg),
    integrations: {
      offcloudConfigured: Boolean(cfg.offcloudApiKey),
      nzbLifeConfigured: Boolean(cfg.nzbLifeApiKey),
      nextcloudConfigured: Boolean(cfg.nextcloudUrl && cfg.nextcloudUser && cfg.nextcloudAppPassword),
      aria2Reachable: await isAria2Reachable(cfg),
      localDownloadsDir: LOCAL_DOWNLOADS_DIR,
    },
    jobs,
  };
}
