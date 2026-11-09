import { definePlugin, fail, formatBytes, need, str } from '../../server/plugins/sdk.js';
import type { PluginContext } from '../../server/plugins/sdk.js';

interface PcloudMeta {
  name: string;
  isfolder: boolean;
  folderid?: number;
  fileid?: number;
  size?: number;
  modified?: string;
  path?: string;
  contents?: PcloudMeta[];
}

const host = (ctx: PluginContext) => (ctx.settings.region === 'eu' ? 'https://eapi.pcloud.com' : 'https://api.pcloud.com');

async function pc<T>(ctx: PluginContext, method: string, params: Record<string, string | number> = {}): Promise<T> {
  const token = need(ctx, 'token', 'Access token');
  const q = new URLSearchParams({ access_token: token, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const r = await ctx.fetchJson<T & { result: number; error?: string }>(`${host(ctx)}/${method}?${q}`, {}, 25_000);
  if (r.result !== 0) fail(`pCloud: ${r.error || `error ${r.result}`}`);
  return r;
}

async function folderIdFor(ctx: PluginContext, folderPath: string): Promise<number> {
  if (!folderPath || folderPath === '/') return 0;
  const r = await pc<{ metadata: PcloudMeta }>(ctx, 'createfolderifnotexists', { path: folderPath.startsWith('/') ? folderPath : `/${folderPath}` });
  return r.metadata.folderid ?? 0;
}

export default definePlugin({
  id: 'pcloud',
  name: 'pCloud',
  description: 'Browse your pCloud drive, get direct links, and remote-upload URLs straight to the cloud.',
  category: 'storage',
  icon: 'Cloud',
  homepage: 'https://www.pcloud.com',
  settings: [
    { key: 'token', label: 'Access token', secret: true, required: true, help: 'OAuth token from an app at docs.pcloud.com (or any token from a pCloud client).' },
    { key: 'region', label: 'Region', type: 'select', default: 'us', options: [{ value: 'us', label: 'US (api.pcloud.com)' }, { value: 'eu', label: 'EU (eapi.pcloud.com)' }] },
    { key: 'folder', label: 'Upload folder', default: '/glogg', placeholder: '/glogg' },
  ],
  downloadTarget: { label: 'pCloud', accepts: ['link', 'nzb', 'torrent'] },
  tools: [
    {
      id: 'account',
      name: 'Account & quota',
      description: 'Used and free space.',
      inputs: [],
      requiresSettings: true,
      async run(_i, ctx) {
        const u = await pc<{ email: string; quota: number; usedquota: number; premium: boolean; plan?: number }>(ctx, 'userinfo');
        const pct = Math.round((u.usedquota / u.quota) * 100);
        return {
          summary: `${formatBytes(u.usedquota)} of ${formatBytes(u.quota)}`,
          blocks: [
            {
              type: 'stat',
              items: [
                { label: 'Used', value: `${formatBytes(u.usedquota)} (${pct}%)`, tone: pct > 90 ? 'bad' : pct > 75 ? 'warn' : 'ok' },
                { label: 'Total', value: formatBytes(u.quota) },
                { label: 'Plan', value: u.premium ? 'Premium' : 'Free' },
              ],
            },
            { type: 'kv', items: [{ label: 'Email', value: u.email }] },
          ],
        };
      },
    },
    {
      id: 'browse',
      name: 'Browse',
      description: 'List a folder.',
      trigger: 'pcloud',
      requiresSettings: true,
      inputs: [{ key: 'path', label: 'Folder', default: '/', placeholder: '/' }],
      async run(input, ctx) {
        const p = str(input, 'path', '/') || '/';
        const r = await pc<{ metadata: PcloudMeta }>(ctx, 'listfolder', { path: p });
        const items = (r.metadata.contents || []).sort((a, b) => Number(b.isfolder) - Number(a.isfolder) || a.name.localeCompare(b.name));
        return {
          summary: `${items.length} items in ${p}`,
          blocks: [
            {
              type: 'list',
              title: p,
              items: items.map((m) => ({
                title: m.isfolder ? `${m.name}/` : m.name,
                subtitle: m.isfolder ? 'folder' : `${formatBytes(m.size)} · ${m.modified?.slice(5, 16) ?? ''}`,
                badge: m.isfolder ? 'dir' : undefined,
                actions: m.isfolder
                  ? [{ label: 'Open', run: { tool: 'pcloud/browse', inputs: { path: `${p.replace(/\/$/, '')}/${m.name}` } } }]
                  : [{ label: 'Link', run: { tool: 'pcloud/link', inputs: { fileid: String(m.fileid) } } }],
              })),
            },
          ],
        };
      },
    },
    {
      id: 'link',
      name: 'Direct link',
      description: 'Temporary direct download link for a file id.',
      requiresSettings: true,
      inputs: [{ key: 'fileid', label: 'File id', required: true }],
      async run(input, ctx) {
        const r = await pc<{ hosts: string[]; path: string }>(ctx, 'getfilelink', { fileid: str(input, 'fileid') });
        const url = `https://${r.hosts[0]}${r.path}`;
        return { blocks: [{ type: 'actions', items: [{ label: 'Download', href: url }, { label: 'Send', send: { url } }, { label: 'Copy', copy: url }] }] };
      },
    },
    {
      id: 'upload',
      name: 'Remote upload',
      description: 'pCloud fetches the URL server-side — nothing touches your disk.',
      requiresSettings: true,
      inputs: [
        { key: 'url', label: 'URL(s)', type: 'textarea', required: true },
        { key: 'path', label: 'Folder', placeholder: '/glogg' },
      ],
      async run(input, ctx) {
        const folderid = await folderIdFor(ctx, str(input, 'path') || ctx.settings.folder || '/glogg');
        const urls = str(input, 'url').split(/\s+/).filter(Boolean).join(' ');
        const r = await pc<{ metadata?: PcloudMeta[] }>(ctx, 'downloadfile', { url: urls, folderid });
        return {
          summary: `Uploaded ${r.metadata?.length ?? 0} file(s)`,
          blocks: [{ type: 'list', items: (r.metadata || []).map((m) => ({ title: m.name, subtitle: formatBytes(m.size), tone: 'ok' as const })) }],
        };
      },
    },
  ],
  async sendDownload(item, ctx) {
    const folderid = await folderIdFor(ctx, ctx.settings.folder || '/glogg');
    const r = await pc<{ metadata?: PcloudMeta[] }>(ctx, 'downloadfile', { url: item.url, folderid });
    const name = r.metadata?.[0]?.name ?? item.title;
    return { status: 'completed', progressPercent: 100, detail: `Saved to pCloud ${ctx.settings.folder || '/glogg'}/${name}`, destinationUrl: 'https://my.pcloud.com' };
  },
});
