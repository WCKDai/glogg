import { definePlugin, fail, formatBytes, multipart, need, str } from '../../server/plugins/sdk.js';
import type { PluginContext } from '../../server/plugins/sdk.js';

const API = 'https://api.torbox.app/v1/api';

interface TbEnvelope<T> {
  success: boolean;
  detail?: string;
  error?: string | null;
  data: T;
}

async function tb<T>(ctx: PluginContext, pathname: string, init: RequestInit = {}): Promise<T> {
  const token = need(ctx, 'apiKey', 'API key');
  const res = await ctx.fetch(`${API}${pathname}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } }, 20_000);
  const data = (await res.json().catch(() => ({}))) as TbEnvelope<T>;
  if (!res.ok || data.success === false) fail(`TorBox: ${data.detail || data.error || `HTTP ${res.status}`}`);
  return data.data;
}

interface TbItem {
  id: number;
  name: string;
  size: number;
  progress: number;
  download_state: string;
  download_finished: boolean;
  created_at: string;
  hash?: string;
}

function itemRow(t: TbItem, kind: 'torrent' | 'usenet' | 'webdl') {
  const pct = Math.round((t.progress || 0) * 100);
  return {
    title: t.name || `#${t.id}`,
    subtitle: `${formatBytes(t.size)} · ${t.download_state}${t.download_finished ? '' : ` · ${pct}%`} · ${t.created_at?.slice(0, 10) ?? ''}`,
    badge: kind,
    tone: (t.download_finished ? 'ok' : /error|failed|stalled/i.test(t.download_state) ? 'bad' : 'info') as 'ok' | 'bad' | 'info',
    actions: t.download_finished ? [{ label: 'Get link', run: { tool: 'torbox/link', inputs: { id: String(t.id), kind } } }] : [],
  };
}

export default definePlugin({
  id: 'torbox',
  name: 'TorBox',
  description: 'Torrents, Usenet and web downloads cached in the cloud by TorBox.',
  category: 'debrid',
  icon: 'Box',
  homepage: 'https://torbox.app',
  settings: [{ key: 'apiKey', label: 'API key', secret: true, required: true, help: 'torbox.app/settings → API' }],
  downloadTarget: { label: 'TorBox', accepts: ['magnet', 'torrent', 'nzb', 'link'] },
  tools: [
    {
      id: 'account',
      name: 'Account',
      description: 'Plan and expiry.',
      inputs: [],
      requiresSettings: true,
      async run(_i, ctx) {
        const u = await tb<{ email: string; plan: number; premium_expires_at?: string; total_downloaded?: number }>(ctx, '/user/me');
        const plans = ['Free', 'Essential', 'Pro', 'Standard'];
        return {
          blocks: [
            {
              type: 'stat',
              items: [
                { label: 'Plan', value: plans[u.plan] ?? String(u.plan), tone: u.plan > 0 ? 'ok' : 'warn' },
                { label: 'Expires', value: u.premium_expires_at?.slice(0, 10) ?? '—' },
                { label: 'Downloads', value: String(u.total_downloaded ?? '—') },
              ],
            },
            { type: 'kv', items: [{ label: 'Email', value: u.email }] },
          ],
        };
      },
    },
    {
      id: 'add',
      name: 'Add',
      description: 'Add a magnet, .torrent URL, .nzb URL or any web link.',
      trigger: 'tb',
      requiresSettings: true,
      inputs: [{ key: 'link', label: 'Magnet, NZB or link', type: 'textarea', required: true }],
      async run(input, ctx) {
        const link = str(input, 'link');
        const r = await addAny(ctx, link);
        return { summary: r.detail, blocks: [{ type: 'notice', tone: 'ok', content: r.detail }] };
      },
    },
    {
      id: 'cached',
      name: 'Check cache',
      description: 'Is this torrent already cached (instant)?',
      requiresSettings: true,
      inputs: [{ key: 'hash', label: 'Info hash or magnet', required: true }],
      async run(input, ctx) {
        const raw = str(input, 'hash');
        const hash = (raw.match(/btih:([a-z0-9]{32,40})/i)?.[1] || raw).toLowerCase();
        const data = await tb<{ name: string; size: number; hash: string }[] | Record<string, unknown> | null>(
          ctx,
          `/torrents/checkcached?hash=${encodeURIComponent(hash)}&format=list`
        );
        const list = Array.isArray(data) ? data : [];
        return {
          blocks: list.length
            ? [{ type: 'notice', tone: 'ok', content: `Cached: ${list[0].name} (${formatBytes(list[0].size)})` }]
            : [{ type: 'notice', tone: 'warn', content: 'Not cached — adding it will download first.' }],
        };
      },
    },
    {
      id: 'list',
      name: 'My downloads',
      description: 'Torrents, Usenet and web downloads.',
      requiresSettings: true,
      inputs: [],
      async run(_i, ctx) {
        const [t, u, w] = await Promise.all([
          tb<TbItem[]>(ctx, '/torrents/mylist?bypass_cache=true').catch(() => []),
          tb<TbItem[]>(ctx, '/usenet/mylist?bypass_cache=true').catch(() => []),
          tb<TbItem[]>(ctx, '/webdl/mylist?bypass_cache=true').catch(() => []),
        ]);
        return {
          summary: `${t.length + u.length + w.length} items`,
          blocks: [
            { type: 'list', title: `Torrents (${t.length})`, items: t.slice(0, 40).map((x) => itemRow(x, 'torrent')) },
            { type: 'list', title: `Usenet (${u.length})`, items: u.slice(0, 40).map((x) => itemRow(x, 'usenet')) },
            { type: 'list', title: `Web (${w.length})`, items: w.slice(0, 40).map((x) => itemRow(x, 'webdl')) },
          ],
        };
      },
    },
    {
      id: 'link',
      name: 'Get download link',
      description: 'Zip link for a finished item.',
      requiresSettings: true,
      inputs: [
        { key: 'id', label: 'Item id', required: true },
        { key: 'kind', label: 'Type', type: 'select', default: 'torrent', options: [{ value: 'torrent', label: 'Torrent' }, { value: 'usenet', label: 'Usenet' }, { value: 'webdl', label: 'Web' }] },
      ],
      async run(input, ctx) {
        const kind = str(input, 'kind', 'torrent');
        const idParam = kind === 'torrent' ? 'torrent_id' : kind === 'usenet' ? 'usenet_id' : 'web_id';
        const base = kind === 'torrent' ? 'torrents' : kind;
        const url = await tb<string>(ctx, `/${base}/requestdl?token=${encodeURIComponent(ctx.settings.apiKey)}&${idParam}=${encodeURIComponent(str(input, 'id'))}&zip_link=true`);
        return { blocks: [{ type: 'actions', items: [{ label: 'Download', href: url }, { label: 'Send', send: { url, title: `torbox-${str(input, 'id')}.zip` } }, { label: 'Copy link', copy: url }] }] };
      },
    },
  ],
  async sendDownload(item, ctx) {
    return addAny(ctx, item.url);
  },
  async pollDownload(remoteId, ctx) {
    const [kind, id] = remoteId.split(':');
    const base = kind === 'usenet' ? 'usenet' : kind === 'webdl' ? 'webdl' : 'torrents';
    const t = await tb<TbItem>(ctx, `/${base}/mylist?bypass_cache=true&id=${id}`);
    if (!t) return null;
    if (t.download_finished) return { status: 'completed', progressPercent: 100, detail: 'Ready on TorBox' };
    if (/error|failed/i.test(t.download_state)) return { status: 'failed', detail: `TorBox: ${t.download_state}` };
    return { status: 'downloading', progressPercent: Math.round((t.progress || 0) * 100), detail: `TorBox: ${t.download_state}` };
  },
});

async function addAny(ctx: PluginContext, link: string) {
  if (link.startsWith('magnet:') || /\.torrent(\?|$)/i.test(link)) {
    const body: Record<string, string | Blob> = link.startsWith('magnet:')
      ? { magnet: link }
      : { file: new Blob([await (await ctx.fetch(link, {}, 20_000)).arrayBuffer()]) };
    const d = await tb<{ torrent_id: number; hash: string }>(ctx, '/torrents/createtorrent', multipart(body));
    return { remoteId: `torrent:${d.torrent_id}`, status: 'downloading' as const, detail: 'TorBox: torrent added', destinationUrl: 'https://torbox.app/dashboard' };
  }
  if (/\.nzb(\?|$)|t=get|getnzb/i.test(link)) {
    const d = await tb<{ usenetdownload_id: number }>(ctx, '/usenet/createusenetdownload', multipart({ link }));
    return { remoteId: `usenet:${d.usenetdownload_id}`, status: 'downloading' as const, detail: 'TorBox: NZB added', destinationUrl: 'https://torbox.app/dashboard' };
  }
  const d = await tb<{ webdownload_id: number }>(ctx, '/webdl/createwebdownload', multipart({ link }));
  return { remoteId: `webdl:${d.webdownload_id}`, status: 'downloading' as const, detail: 'TorBox: web download added', destinationUrl: 'https://torbox.app/dashboard' };
}
