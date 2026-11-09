import { definePlugin, fail, formatBytes, need, str } from '../../server/plugins/sdk.js';
import type { PluginContext } from '../../server/plugins/sdk.js';

async function sab<T>(ctx: PluginContext, params: Record<string, string>): Promise<T> {
  const base = (ctx.settings.url || 'http://localhost:8085').replace(/\/+$/, '');
  const q = new URLSearchParams({ output: 'json', apikey: need(ctx, 'apiKey', 'API key'), ...params });
  const r = await ctx.fetchJson<T & { status?: boolean; error?: string }>(`${base}/api?${q}`);
  if (r.status === false || r.error) fail(`SABnzbd: ${r.error || 'request failed'}`);
  return r;
}

export default definePlugin({
  id: 'sabnzbd',
  name: 'SABnzbd',
  description: 'Self-hosted Usenet downloader. Run it as a container, then send NZBs straight to its queue.',
  category: 'usenet',
  icon: 'HardDriveDownload',
  homepage: 'https://sabnzbd.org',
  settings: [
    { key: 'url', label: 'URL', default: 'http://localhost:8085', placeholder: 'http://localhost:8085' },
    { key: 'apiKey', label: 'API key', secret: true, required: true, help: 'SABnzbd → Config → General → API Key' },
  ],
  container: {
    image: 'lscr.io/linuxserver/sabnzbd:latest',
    ports: ['8085:8080'],
    env: { PUID: '1000', PGID: '1000', TZ: 'Etc/UTC' },
    volumes: ['$DATA/config:/config', '$DATA/downloads:/downloads'],
    webUrl: 'http://localhost:8085',
  },
  downloadTarget: { label: 'SABnzbd', accepts: ['nzb'] },
  tools: [
    {
      id: 'queue',
      name: 'Queue',
      description: 'What is downloading right now.',
      requiresSettings: true,
      inputs: [],
      async run(_i, ctx) {
        const r = await sab<{ queue: { speed: string; sizeleft: string; timeleft: string; slots: { nzo_id: string; filename: string; percentage: string; mb: string; status: string; timeleft: string }[] } }>(ctx, { mode: 'queue' });
        const q = r.queue;
        return {
          summary: `${q.slots.length} in queue · ${q.speed}B/s`,
          blocks: [
            { type: 'stat', items: [{ label: 'Speed', value: `${q.speed}B/s` }, { label: 'Left', value: q.sizeleft }, { label: 'ETA', value: q.timeleft }] },
            {
              type: 'list',
              items: q.slots.map((s) => ({
                title: s.filename,
                subtitle: `${s.percentage}% · ${formatBytes(Number(s.mb) * 1024 * 1024)} · ${s.timeleft}`,
                badge: s.status,
                tone: s.status === 'Downloading' ? 'info' : 'warn',
              })),
            },
          ],
        };
      },
    },
    {
      id: 'add',
      name: 'Add NZB',
      description: 'Queue an NZB by URL.',
      trigger: 'sab',
      requiresSettings: true,
      inputs: [{ key: 'url', label: 'NZB URL', required: true }],
      async run(input, ctx) {
        const r = await sab<{ nzo_ids?: string[] }>(ctx, { mode: 'addurl', name: str(input, 'url') });
        return { blocks: [{ type: 'notice', tone: 'ok', content: `Queued (${r.nzo_ids?.join(', ') || 'ok'})` }] };
      },
    },
    {
      id: 'history',
      name: 'History',
      description: 'Finished and failed jobs.',
      requiresSettings: true,
      inputs: [],
      async run(_i, ctx) {
        const r = await sab<{ history: { slots: { name: string; status: string; size: string; completed: number; fail_message?: string }[] } }>(ctx, { mode: 'history', limit: '40' });
        return {
          blocks: [
            {
              type: 'list',
              items: r.history.slots.map((s) => ({
                title: s.name,
                subtitle: `${s.size} · ${new Date(s.completed * 1000).toISOString().slice(0, 10)}${s.fail_message ? ` · ${s.fail_message}` : ''}`,
                badge: s.status,
                tone: s.status === 'Completed' ? 'ok' : s.status === 'Failed' ? 'bad' : 'info',
              })),
            },
          ],
        };
      },
    },
  ],
  async sendDownload(item, ctx) {
    const r = await sab<{ nzo_ids?: string[] }>(ctx, { mode: 'addurl', name: item.url, nzbname: item.title });
    return { remoteId: r.nzo_ids?.[0], status: 'downloading', detail: 'Queued in SABnzbd', destinationUrl: ctx.settings.url || 'http://localhost:8085' };
  },
  async pollDownload(id, ctx) {
    const q = await sab<{ queue: { slots: { nzo_id: string; percentage: string; status: string }[] } }>(ctx, { mode: 'queue' });
    const s = q.queue.slots.find((x) => x.nzo_id === id);
    if (s) return { status: 'downloading', progressPercent: Number(s.percentage), detail: `SABnzbd: ${s.status}` };
    const h = await sab<{ history: { slots: { nzo_id: string; status: string; fail_message?: string }[] } }>(ctx, { mode: 'history', limit: '60' });
    const d = h.history.slots.find((x) => x.nzo_id === id);
    if (!d) return null;
    if (d.status === 'Completed') return { status: 'completed', progressPercent: 100, detail: 'SABnzbd: done' };
    if (d.status === 'Failed') return { status: 'failed', detail: `SABnzbd: ${d.fail_message || 'failed'}` };
    return { detail: `SABnzbd: ${d.status}` };
  },
});
