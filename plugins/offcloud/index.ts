import { definePlugin, fail, form, formatBytes, str } from '../../server/plugins/sdk.js';
import type { PluginContext } from '../../server/plugins/sdk.js';

// Offcloud is also a built-in Send destination (key lives in Settings → Integrations).
// This plugin adds browsing and cache checks on top of that key.
const key = (ctx: PluginContext) => ctx.integrations.offcloudApiKey || ctx.settings.apiKey || fail('Add your Offcloud API key in Settings → Integrations.');

export default definePlugin({
  id: 'offcloud',
  name: 'Offcloud',
  description: 'Cloud downloads, instant-cache checks and your Offcloud history.',
  category: 'debrid',
  icon: 'CloudDownload',
  homepage: 'https://offcloud.com',
  settings: [{ key: 'apiKey', label: 'API key (optional here)', secret: true, help: 'Uses the key from Settings → Integrations if empty.' }],
  isConfigured: ({ settings, integrations }) => Boolean(integrations.offcloudApiKey || settings.apiKey),
  tools: [
    {
      id: 'add',
      name: 'Add to cloud',
      description: 'Send a magnet or link to Offcloud.',
      trigger: 'oc',
      requiresSettings: true,
      inputs: [{ key: 'url', label: 'Magnet or link', type: 'textarea', required: true }],
      async run(input, ctx) {
        const r = await ctx.fetchJson<{ requestId?: string; status?: string; url?: string; fileName?: string; error?: string }>(
          `https://offcloud.com/api/cloud?key=${encodeURIComponent(key(ctx))}`,
          form({ url: str(input, 'url') }),
          20_000
        );
        if (r.error) fail(`Offcloud: ${r.error}`);
        return {
          summary: `Offcloud: ${r.status}`,
          blocks: [
            { type: 'kv', items: [{ label: 'File', value: r.fileName || '—' }, { label: 'Status', value: r.status || 'submitted', tone: r.status === 'downloaded' ? 'ok' : 'info' }] },
            ...(r.url ? [{ type: 'actions' as const, items: [{ label: 'Download', href: r.url }, { label: 'Copy link', copy: r.url }] }] : []),
          ],
        };
      },
    },
    {
      id: 'cache',
      name: 'Instant cache check',
      description: 'Check which info hashes Offcloud can deliver instantly.',
      requiresSettings: true,
      inputs: [{ key: 'hashes', label: 'Info hashes or magnets (one per line)', type: 'textarea', required: true }],
      async run(input, ctx) {
        const hashes = str(input, 'hashes')
          .split(/\s+/)
          .map((h) => (h.match(/btih:([a-z0-9]{32,40})/i)?.[1] || h).toLowerCase())
          .filter((h) => /^[a-z0-9]{32,40}$/.test(h));
        if (!hashes.length) fail('No valid info hashes found.');
        const r = await ctx.fetchJson<{ cachedItems?: string[] }>(
          `https://offcloud.com/api/cache?key=${encodeURIComponent(key(ctx))}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes }) }
        );
        const cached = new Set((r.cachedItems || []).map((h) => h.toLowerCase()));
        return {
          summary: `${cached.size}/${hashes.length} cached`,
          blocks: [{ type: 'checks', items: hashes.map((h) => ({ label: h, pass: cached.has(h), detail: cached.has(h) ? 'instant' : 'not cached' })) }],
        };
      },
    },
    {
      id: 'history',
      name: 'History',
      description: 'Your recent cloud downloads.',
      requiresSettings: true,
      inputs: [],
      async run(_i, ctx) {
        const list = await ctx.fetchJson<{ requestId: string; fileName: string; status: string; fileSize?: number; createdOn?: string; originalLink?: string }[]>(
          `https://offcloud.com/api/cloud/history?key=${encodeURIComponent(key(ctx))}`
        );
        return {
          summary: `${list.length} items`,
          blocks: [
            {
              type: 'list',
              items: (Array.isArray(list) ? list : []).slice(0, 60).map((x) => ({
                title: x.fileName,
                subtitle: `${formatBytes(x.fileSize)} · ${x.status}${x.createdOn ? ` · ${x.createdOn.slice(0, 10)}` : ''}`,
                tone: x.status === 'downloaded' ? 'ok' : x.status === 'error' ? 'bad' : 'info',
                actions: [{ label: 'Explore', href: `https://offcloud.com/#/cloud` }],
              })),
            },
          ],
        };
      },
    },
  ],
});
