import * as cheerio from 'cheerio';
import { definePlugin, fail, formatBytes, str } from '../../server/plugins/sdk.js';
import type { PluginContext } from '../../server/plugins/sdk.js';

// Any Newznab-compatible indexer works; NZB.life is the default.
function endpoint(ctx: PluginContext) {
  const url = (ctx.settings.url || ctx.integrations.nzbLifeUrl || 'https://api.nzb.life/api').replace(/\/+$/, '');
  const key = ctx.settings.apiKey || ctx.integrations.nzbLifeApiKey;
  if (!key) fail('Add your NZB.life API key here or in Settings → Integrations.');
  return { url, key };
}

export interface NewznabItem {
  title: string;
  link: string;
  size: number;
  pubDate?: string;
  category?: string;
  grabs?: number;
  guid?: string;
}

export function parseNewznabXml(xml: string): NewznabItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const err = $('error').attr('description');
  if (err) fail(`Indexer: ${err}`);
  return $('item')
    .toArray()
    .map((el) => {
      const it = $(el);
      const attr = (name: string) => it.find('newznab\\:attr, attr').filter((_, a) => $(a).attr('name') === name).attr('value');
      return {
        title: it.find('title').first().text(),
        link: it.find('enclosure').attr('url') || it.find('link').first().text(),
        size: Number(attr('size') || it.find('enclosure').attr('length') || 0),
        pubDate: it.find('pubDate').first().text() || undefined,
        category: it.find('category').first().text() || undefined,
        grabs: attr('grabs') ? Number(attr('grabs')) : undefined,
        guid: it.find('guid').first().text() || undefined,
      };
    })
    .filter((i) => i.title && i.link);
}

const CATS = [
  { value: '', label: 'All' },
  { value: '2000', label: 'Movies' },
  { value: '5000', label: 'TV' },
  { value: '3000', label: 'Audio' },
  { value: '4000', label: 'Software' },
  { value: '7000', label: 'Books' },
  { value: '1000', label: 'Console' },
  { value: '6000', label: 'XXX' },
];

export default definePlugin({
  id: 'nzblife',
  name: 'NZB.life',
  description: 'Search NZB.life (or any Newznab indexer) and send NZBs to TorBox, SABnzbd, Nextcloud or disk.',
  category: 'usenet',
  icon: 'Newspaper',
  homepage: 'https://nzb.life',
  settings: [
    { key: 'apiKey', label: 'API key', secret: true, help: 'Falls back to the key in Settings → Integrations.' },
    { key: 'url', label: 'API URL', placeholder: 'https://api.nzb.life/api' },
  ],
  isConfigured: ({ settings, integrations }) => Boolean(settings.apiKey || integrations.nzbLifeApiKey),
  tools: [
    {
      id: 'search',
      name: 'Search',
      description: 'Newznab search, newest first.',
      trigger: 'nzb',
      requiresSettings: true,
      inputs: [
        { key: 'q', label: 'Query', required: true, placeholder: 'ubuntu 24.04' },
        { key: 'cat', label: 'Category', type: 'select', options: CATS, default: '' },
      ],
      async run(input, ctx) {
        const { url, key } = endpoint(ctx);
        const params = new URLSearchParams({ t: 'search', q: str(input, 'q'), apikey: key, limit: '100', extended: '1' });
        if (str(input, 'cat')) params.set('cat', str(input, 'cat'));
        const res = await ctx.fetch(`${url}?${params}`, {}, 20_000);
        if (res.status === 401 || res.status === 403) fail('Indexer rejected the API key.');
        const items = parseNewznabXml(await res.text());
        return {
          summary: `${items.length} NZBs`,
          blocks: [
            {
              type: 'list',
              items: items.map((i) => ({
                title: i.title,
                subtitle: [formatBytes(i.size), i.category, i.pubDate ? new Date(i.pubDate).toISOString().slice(0, 10) : '', i.grabs !== undefined ? `${i.grabs} grabs` : '']
                  .filter(Boolean)
                  .join(' · '),
                badge: 'nzb',
                actions: [{ label: 'Send', send: { url: i.link, title: i.title } }, { label: 'NZB', href: i.link }],
              })),
            },
          ],
        };
      },
    },
    {
      id: 'caps',
      name: 'Test key',
      description: 'Checks the API key and lists categories.',
      requiresSettings: true,
      inputs: [],
      async run(_i, ctx) {
        const { url, key } = endpoint(ctx);
        const xml = await (await ctx.fetch(`${url}?t=caps&apikey=${encodeURIComponent(key)}`)).text();
        const $ = cheerio.load(xml, { xmlMode: true });
        const err = $('error').attr('description');
        if (err) fail(err);
        return {
          blocks: [
            { type: 'notice', tone: 'ok', content: `Connected to ${$('server').attr('title') || new URL(url).host}` },
            { type: 'table', columns: ['ID', 'Category'], rows: $('categories > category').toArray().map((c) => [$(c).attr('id') || '', $(c).attr('name') || '']) },
          ],
        };
      },
    },
  ],
});
