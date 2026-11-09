import { definePlugin, fail, form, formatBytes, need, str } from '../../server/plugins/sdk.js';
import type { PluginContext } from '../../server/plugins/sdk.js';

const API = 'https://api.real-debrid.com/rest/1.0';

const auth = (ctx: PluginContext) => ({ Authorization: `Bearer ${need(ctx, 'apiToken', 'API token')}` });

async function rd<T>(ctx: PluginContext, pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await ctx.fetch(`${API}${pathname}`, { ...init, headers: { ...auth(ctx), ...(init.headers || {}) } });
  if (res.status === 204) return {} as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (!res.ok) fail(`Real-Debrid: ${data.error || `HTTP ${res.status}`}`);
  return data;
}

interface RdTorrent {
  id: string;
  filename: string;
  bytes: number;
  progress: number;
  status: string;
  added: string;
  links: string[];
  hash: string;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = {
  downloaded: 'ok',
  downloading: 'info',
  queued: 'info',
  magnet_conversion: 'info',
  waiting_files_selection: 'warn',
  error: 'bad',
  magnet_error: 'bad',
  virus: 'bad',
  dead: 'bad',
};

async function addMagnet(ctx: PluginContext, magnet: string): Promise<string> {
  const r = await rd<{ id: string }>(ctx, '/torrents/addMagnet', form({ magnet }));
  await rd(ctx, `/torrents/selectFiles/${r.id}`, form({ files: 'all' })).catch(() => undefined);
  return r.id;
}

export default definePlugin({
  id: 'realdebrid',
  name: 'Real-Debrid',
  description: 'Cache torrents and unrestrict hoster links through your Real-Debrid account.',
  category: 'debrid',
  icon: 'Zap',
  homepage: 'https://real-debrid.com',
  settings: [
    {
      key: 'apiToken',
      label: 'API token',
      secret: true,
      required: true,
      help: 'real-debrid.com/apitoken',
    },
  ],
  downloadTarget: { label: 'Real-Debrid', accepts: ['magnet', 'torrent', 'link'] },
  tools: [
    {
      id: 'account',
      name: 'Account',
      description: 'Plan, expiry and fidelity points.',
      inputs: [],
      requiresSettings: true,
      async run(_input, ctx) {
        const u = await rd<{ username: string; email: string; type: string; expiration: string; points: number; premium: number }>(ctx, '/user');
        const days = Math.round(u.premium / 86400);
        return {
          summary: `${u.username} · ${u.type} · ${days}d left`,
          blocks: [
            {
              type: 'stat',
              items: [
                { label: 'Plan', value: u.type, tone: u.type === 'premium' ? 'ok' : 'warn' },
                { label: 'Premium left', value: `${days} days`, tone: days < 7 ? 'warn' : 'ok' },
                { label: 'Points', value: String(u.points) },
              ],
            },
            { type: 'kv', items: [{ label: 'User', value: u.username }, { label: 'Email', value: u.email }, { label: 'Expires', value: u.expiration?.slice(0, 10) }] },
          ],
        };
      },
    },
    {
      id: 'add',
      name: 'Add magnet or link',
      description: 'Magnets are cached to your torrents; hoster links are unrestricted to a direct download.',
      trigger: 'rd',
      requiresSettings: true,
      inputs: [{ key: 'link', label: 'Magnet or link', type: 'textarea', required: true, placeholder: 'magnet:?xt=urn:btih:… or https://hoster/file' }],
      async run(input, ctx) {
        const links = str(input, 'link').split(/\s+/).filter(Boolean);
        const items = [];
        for (const link of links.slice(0, 20)) {
          if (link.startsWith('magnet:')) {
            const id = await addMagnet(ctx, link);
            const info = await rd<RdTorrent>(ctx, `/torrents/info/${id}`);
            items.push({ title: info.filename || link.slice(0, 60), subtitle: `${info.status} · ${info.progress}%`, badge: 'torrent', tone: STATUS_TONE[info.status] });
          } else {
            const u = await rd<{ filename: string; filesize: number; download: string }>(ctx, '/unrestrict/link', form({ link }));
            items.push({
              title: u.filename,
              subtitle: formatBytes(u.filesize),
              href: u.download,
              badge: 'direct',
              tone: 'ok' as const,
              actions: [{ label: 'Download', href: u.download }, { label: 'Send', send: { url: u.download, title: u.filename } }, { label: 'Copy', copy: u.download }],
            });
          }
        }
        return { summary: `Added ${items.length}`, blocks: [{ type: 'list', items }] };
      },
    },
    {
      id: 'torrents',
      name: 'Torrents',
      description: 'Your Real-Debrid torrent list.',
      requiresSettings: true,
      inputs: [],
      async run(_input, ctx) {
        const list = await rd<RdTorrent[]>(ctx, '/torrents?limit=50');
        return {
          summary: `${list.length} torrents`,
          blocks: [
            {
              type: 'list',
              items: list.map((t) => ({
                title: t.filename,
                subtitle: `${formatBytes(t.bytes)} · ${t.status.replace(/_/g, ' ')}${t.status === 'downloading' ? ` · ${t.progress}%` : ''} · ${t.added.slice(0, 10)}`,
                tone: STATUS_TONE[t.status],
                badge: `${t.links.length} file${t.links.length === 1 ? '' : 's'}`,
                actions: t.links.slice(0, 1).map((l) => ({ label: 'Unrestrict', run: { tool: 'realdebrid/add', inputs: { link: l } } })),
              })),
            },
          ],
        };
      },
    },
    {
      id: 'downloads',
      name: 'Download history',
      description: 'Recently unrestricted links.',
      requiresSettings: true,
      inputs: [],
      async run(_input, ctx) {
        const list = await rd<{ filename: string; filesize: number; download: string; generated: string; host: string }[]>(ctx, '/downloads?limit=40');
        return {
          blocks: [
            {
              type: 'list',
              items: list.map((d) => ({
                title: d.filename,
                subtitle: `${formatBytes(d.filesize)} · ${d.host} · ${d.generated.slice(0, 10)}`,
                href: d.download,
                actions: [{ label: 'Send', send: { url: d.download, title: d.filename } }, { label: 'Copy', copy: d.download }],
              })),
            },
          ],
        };
      },
    },
  ],
  async sendDownload(item, ctx) {
    if (item.kind === 'magnet') {
      const id = await addMagnet(ctx, item.url);
      return { remoteId: id, status: 'downloading', detail: 'Real-Debrid: caching', destinationUrl: 'https://real-debrid.com/torrents' };
    }
    if (item.kind === 'torrent') {
      const bytes = await (await ctx.fetch(item.url, {}, 20_000)).arrayBuffer();
      const r = await rd<{ id: string }>(ctx, '/torrents/addTorrent', { method: 'PUT', body: new Uint8Array(bytes) });
      await rd(ctx, `/torrents/selectFiles/${r.id}`, form({ files: 'all' })).catch(() => undefined);
      return { remoteId: r.id, status: 'downloading', detail: 'Real-Debrid: caching', destinationUrl: 'https://real-debrid.com/torrents' };
    }
    const u = await rd<{ filename: string; download: string }>(ctx, '/unrestrict/link', form({ link: item.url }));
    return { status: 'completed', detail: `Unrestricted: ${u.filename}`, destinationUrl: u.download, progressPercent: 100 };
  },
  async pollDownload(id, ctx) {
    const t = await rd<RdTorrent>(ctx, `/torrents/info/${id}`);
    if (t.status === 'downloaded') return { status: 'completed', progressPercent: 100, detail: 'Ready on Real-Debrid' };
    if (STATUS_TONE[t.status] === 'bad') return { status: 'failed', detail: `Real-Debrid: ${t.status}` };
    return { status: 'downloading', progressPercent: t.progress, detail: `Real-Debrid: ${t.status.replace(/_/g, ' ')}` };
  },
});
