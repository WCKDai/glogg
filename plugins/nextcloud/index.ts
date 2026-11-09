import * as cheerio from 'cheerio';
import { definePlugin, fail, formatBytes, str } from '../../server/plugins/sdk.js';
import type { PluginContext } from '../../server/plugins/sdk.js';

// Uses the Nextcloud credentials from Settings → Integrations (also the built-in Send target).
function cfg(ctx: PluginContext) {
  const { nextcloudUrl, nextcloudUser, nextcloudAppPassword } = ctx.integrations;
  if (!nextcloudUrl || !nextcloudUser || !nextcloudAppPassword) fail('Add your Nextcloud URL, user and app password in Settings → Integrations.');
  return {
    base: nextcloudUrl.replace(/\/+$/, ''),
    user: nextcloudUser,
    auth: `Basic ${Buffer.from(`${nextcloudUser}:${nextcloudAppPassword}`).toString('base64')}`,
  };
}

const davPath = (user: string, p: string) =>
  `/remote.php/dav/files/${encodeURIComponent(user)}/${p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;

async function propfind(ctx: PluginContext, p: string, depth: '0' | '1', props: string) {
  const c = cfg(ctx);
  const res = await ctx.fetch(`${c.base}${davPath(c.user, p)}`, {
    method: 'PROPFIND',
    headers: { Authorization: c.auth, Depth: depth, 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>${props}</d:prop></d:propfind>`,
  });
  if (res.status === 401) fail('Nextcloud rejected the credentials (use an app password).');
  if (res.status === 404) fail(`Folder not found: ${p}`);
  if (!res.ok && res.status !== 207) fail(`Nextcloud: HTTP ${res.status}`);
  return cheerio.load(await res.text(), { xmlMode: true });
}

export default definePlugin({
  id: 'nextcloud',
  name: 'Nextcloud',
  description: 'Browse your Nextcloud, check quota and create public share links.',
  category: 'storage',
  icon: 'Server',
  homepage: 'https://nextcloud.com',
  isConfigured: ({ integrations: i }) => Boolean(i.nextcloudUrl && i.nextcloudUser && i.nextcloudAppPassword),
  tools: [
    {
      id: 'browse',
      name: 'Browse',
      description: 'List a folder.',
      trigger: 'nc',
      requiresSettings: true,
      inputs: [{ key: 'path', label: 'Folder', default: '/', placeholder: '/' }],
      async run(input, ctx) {
        const p = str(input, 'path', '/') || '/';
        const $ = await propfind(ctx, p, '1', '<d:getcontentlength/><d:getlastmodified/><d:resourcetype/><oc:size/>');
        const c = cfg(ctx);
        const rows = $('d\\:response, response')
          .toArray()
          .slice(1)
          .map((el) => {
            const href = decodeURIComponent($(el).find('d\\:href, href').first().text());
            const isDir = $(el).find('d\\:collection, collection').length > 0;
            const name = href.replace(/\/$/, '').split('/').pop() || href;
            const size = Number($(el).find('oc\\:size, size').first().text() || $(el).find('d\\:getcontentlength, getcontentlength').first().text());
            return { name, isDir, size, modified: $(el).find('d\\:getlastmodified, getlastmodified').first().text() };
          })
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        const cur = p.replace(/\/$/, '');
        return {
          summary: `${rows.length} items`,
          blocks: [
            {
              type: 'list',
              title: p,
              items: rows.map((r) => ({
                title: r.isDir ? `${r.name}/` : r.name,
                subtitle: `${formatBytes(r.size)}${r.modified ? ` · ${new Date(r.modified).toISOString().slice(0, 10)}` : ''}`,
                badge: r.isDir ? 'dir' : undefined,
                href: r.isDir ? undefined : `${c.base}/apps/files/?dir=${encodeURIComponent(cur || '/')}`,
                actions: r.isDir
                  ? [{ label: 'Open', run: { tool: 'nextcloud/browse', inputs: { path: `${cur}/${r.name}` } } }]
                  : [{ label: 'Share', run: { tool: 'nextcloud/share', inputs: { path: `${cur}/${r.name}` } } }],
              })),
            },
          ],
        };
      },
    },
    {
      id: 'quota',
      name: 'Quota',
      description: 'Used and available space.',
      requiresSettings: true,
      inputs: [],
      async run(_i, ctx) {
        const $ = await propfind(ctx, '/', '0', '<d:quota-used-bytes/><d:quota-available-bytes/>');
        const used = Number($('d\\:quota-used-bytes, quota-used-bytes').first().text());
        const avail = Number($('d\\:quota-available-bytes, quota-available-bytes').first().text());
        return {
          blocks: [
            {
              type: 'stat',
              items: [
                { label: 'Used', value: formatBytes(used) },
                { label: 'Free', value: avail >= 0 ? formatBytes(avail) : 'Unlimited', tone: avail >= 0 && avail < 2 ** 30 ? 'warn' : 'ok' },
              ],
            },
          ],
        };
      },
    },
    {
      id: 'share',
      name: 'Share link',
      description: 'Create a public link for a file or folder.',
      requiresSettings: true,
      inputs: [
        { key: 'path', label: 'Path', required: true, placeholder: '/glogg/file.zip' },
        { key: 'password', label: 'Password (optional)', type: 'password' },
      ],
      async run(input, ctx) {
        const c = cfg(ctx);
        const body = new URLSearchParams({ path: str(input, 'path'), shareType: '3' });
        if (str(input, 'password')) body.set('password', str(input, 'password'));
        const res = await ctx.fetch(`${c.base}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
          method: 'POST',
          headers: { Authorization: c.auth, 'OCS-APIRequest': 'true', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: body.toString(),
        });
        const data = (await res.json().catch(() => ({}))) as { ocs?: { meta?: { message?: string }; data?: { url?: string } } };
        const url = data.ocs?.data?.url;
        if (!url) fail(`Nextcloud: ${data.ocs?.meta?.message || `HTTP ${res.status}`}`);
        return { summary: url, blocks: [{ type: 'actions', items: [{ label: 'Open', href: url }, { label: 'Copy link', copy: url }] }] };
      },
    },
  ],
});
