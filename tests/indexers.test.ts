/**
 * The P2P, Fediverse and wild-west indexers, and the instant-answer lookups,
 * against canned answers in each upstream's own format: Bitmagnet GraphQL,
 * apibay, the Internet Archive, NZBIndex, Torznab and Newznab XML, Bluesky,
 * Mastodon and Matrix JSON, 4chan and FoolFuuka archives, Lobsters and
 * DuckDuckGo HTML, Wikipedia, DuckDuckGo and Stack Exchange. fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diversifyAndRankResults } from '../src/core/index.js';
import type { RawSearchResult } from '../src/core/index.js';
import * as answers from '../server/answerEngine.js';
import * as fedi from '../server/fediverseIndexer.js';
import * as p2p from '../server/p2pIndexer.js';
import * as wild from '../server/wildWestIndexer.js';
import { anyString, BASE_SEED, html, int, pick, rng, RUNS, text, TIMEOUT } from './fuzz.js';
import type { Rng } from './fuzz.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const routes = new Map<string, Handler>();
const requests: { url: URL; init: RequestInit }[] = [];
const waiting: [number, () => void][] = [];

/** Answers requests whose address starts with `prefix` (the longest prefix wins); anything else gets a 404. */
const upstream = (prefix: string, handler: Handler) => routes.set(prefix, handler);
/** Resolves once `n` requests have gone out. */
const reached = (n: number) => new Promise<void>((resolve) => (requests.length >= n ? resolve() : waiting.push([n, resolve])));
/** The addresses asked that start with `prefix`. */
const asked = (prefix: string) => requests.filter((r) => r.url.href.startsWith(prefix)).map((r) => r.url);
/** An upstream that never answers, until the request is aborted. */
const silent: Handler = (_url, init) =>
  new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const page = (body: string, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'Content-Type': type } });

beforeEach(() => {
  routes.clear();
  requests.length = 0;
  waiting.length = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    for (const [n, resolve] of waiting) if (requests.length >= n) resolve();
    const prefix = [...routes.keys()].filter((p) => url.href.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return prefix === undefined ? new Response('Not Found', { status: 404 }) : routes.get(prefix)!(url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Runs `fn` with these environment variables set (undefined: unset), then puts them back. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, value] of Object.entries(v)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

/** A fresh copy of the Fediverse indexer, whose Matrix room directory is cached per module. */
async function freshFediverse() {
  vi.resetModules();
  return import('../server/fediverseIndexer.js');
}

const SINTEL = '08ada5a7a6183aae1e09d831df6748d566095a10';
const BUNNY = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
const DEBIAN = '6a9759bffd5c0af65319979fb7832189f4f3c35d';
const TEARS = '209c8226b299b308beaf2b9cd3fb49212dbd13ec';

// ── Canned answers, in each upstream's format ───────────────────────────────

const bitmagnet = (
  items: unknown[] = [
    {
      infoHash: SINTEL.toUpperCase(),
      title: 'Sintel (2010) 1080p',
      seeders: 210,
      leechers: 12,
      publishedAt: '2024-03-01T12:00:00Z',
      contentType: 'movie',
      torrent: { name: 'Sintel.2010.1080p.mkv', size: 1_288_490_189, filesCount: 3 },
    },
    { infoHash: BUNNY, title: '', seeders: 1, torrent: { name: 'big_buck_bunny_720p.mp4', size: 276_134_947 } },
    { infoHash: 'not-a-hash', title: 'Broken', seeders: 99 },
  ]
) => ({ data: { torrentContent: { search: { items } } } });

const swarm = (over: Record<string, string>) => ({
  id: '1',
  name: 'x',
  info_hash: DEBIAN,
  leechers: '0',
  seeders: '0',
  num_files: '1',
  size: '0',
  username: 'anon',
  added: '0',
  status: 'member',
  category: '303',
  imdb: '',
  ...over,
});

const apibay = () => [
  swarm({ id: '71', name: 'debian-12.5.0-amd64-DVD-1.iso', info_hash: DEBIAN.toUpperCase(), seeders: '250', leechers: '9', size: '3992977408', username: 'debian-cd', added: '1707566400', category: '303' }),
  swarm({ id: '72', name: 'Free Software Song (FLAC)', info_hash: SINTEL, seeders: '7', leechers: '1', size: '52428800', username: '', category: '101' }),
  swarm({ id: '73', name: 'The Cathedral and the Bazaar (epub)', info_hash: BUNNY, seeders: '1', size: '1048576', num_files: '0', category: '601' }),
  swarm({ id: '74', name: 'Mystery bundle', info_hash: TEARS, seeders: '3', size: '1000', category: '499' }),
];

const archive = () => ({
  responseHeader: { status: 0, QTime: 12 },
  response: {
    numFound: 3,
    start: 0,
    docs: [
      {
        identifier: 'debian-12.5.0-dvd',
        title: 'Debian 12.5 DVD',
        description: ['<p>The <b>Debian</b> 12.5 install DVD.</p>', 'A second description'],
        item_size: 3992977408,
        btih: DEBIAN.toUpperCase(),
        publicdate: '2024-02-11T08:00:00Z',
        downloads: 2500,
        mediatype: 'software',
      },
      { identifier: 'debian-handbook', title: "The Debian Administrator's Handbook", item_size: 52428800, btih: 'not-a-hash', downloads: 40, mediatype: 'texts' },
      { identifier: 'no-title-here' },
    ],
  },
});

const nzbindex = (content: unknown[]) => ({ data: { content } });

const torznabItem = (o: { title: string; link: string; size?: number; seeders?: number; peers?: number; infohash?: string; pubDate?: string }) => `
  <item>
    <title>${o.title}</title>
    <guid>${o.link}</guid>
    <link>${o.link}</link>
    <pubDate>${o.pubDate ?? 'Sat, 10 Feb 2024 12:00:00 +0000'}</pubDate>
    ${o.size === undefined ? '' : `<size>${o.size}</size>`}
    <enclosure url="${o.link}" length="${o.size ?? 0}" type="application/x-bittorrent" />
    ${o.seeders === undefined ? '' : `<torznab:attr name="seeders" value="${o.seeders}" />`}
    ${o.peers === undefined ? '' : `<torznab:attr name="peers" value="${o.peers}" />`}
    ${o.infohash === undefined ? '' : `<torznab:attr name="infohash" value="${o.infohash}" />`}
  </item>`;

const torznab = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel><title>Prowlarr</title><description>Prowlarr Feed</description>${items}</channel>
</rss>`;

const newznab = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
  <channel><title>NZBHydra2</title>${items}</channel>
</rss>`;

const newznabItem = (title: string, link: string, size = 734_003_200) => `
  <item>
    <title>${title}</title>
    <guid isPermaLink="true">${link}</guid>
    <link>${link}</link>
    <pubDate>Sun, 11 Feb 2024 09:30:00 +0000</pubDate>
    <size>${size}</size>
    <enclosure url="${link}" length="${size}" type="application/x-nzb" />
    <newznab:attr name="category" value="2040" />
    <newznab:attr name="size" value="${size}" />
  </item>`;

const bskyPost = (over: Record<string, unknown>) => ({
  uri: 'at://did:plc:ferris/app.bsky.feed.post/3kx1abc',
  cid: 'bafyreia1',
  author: { did: 'did:plc:ferris', handle: 'ferris.bsky.social', displayName: 'Ferris' },
  record: { $type: 'app.bsky.feed.post', text: '', createdAt: '2026-11-01T10:00:00.000Z' },
  likeCount: 0,
  repostCount: 0,
  replyCount: 0,
  indexedAt: '2026-11-01T10:00:01.000Z',
  ...over,
});

const status = (over: Record<string, unknown>) => ({
  id: '1',
  created_at: '2026-11-02T09:00:00.000Z',
  sensitive: false,
  spoiler_text: '',
  visibility: 'public',
  uri: 'https://mastodon.social/users/alice/statuses/1',
  url: 'https://mastodon.social/@alice/1',
  content: '<p></p>',
  favourites_count: 0,
  reblogs_count: 0,
  replies_count: 0,
  account: { id: '9', acct: 'alice', display_name: 'Alice' },
  card: null,
  ...over,
});

const room = (over: Record<string, unknown>) => ({ room_id: '!x:matrix.org', name: '', topic: '', num_joined_members: 0, world_readable: true, guest_can_join: false, ...over });

const catalog = (threads: unknown[]) => [
  { page: 1, threads },
  { page: 2, threads: [] },
];

const fuuka = (posts: unknown[]) => ({ 0: { posts }, meta: { total_found: posts.length, max_results: '5000', search_title: 'Searching' } });

const story = (o: { id: string; title: string; href: string; score: number; tags: string[]; comments?: string }) => `
  <li id="story_${o.id}" data-shortid="${o.id}" class="story">
    <div class="story_liner h-entry">
      <div class="voters"><a class="upvoter" href="/login"></a><div class="score">${o.score}</div></div>
      <div class="details">
        <span role="heading" aria-level="1" class="link h-cite u-repost-of"><a class="u-url" href="${o.href}" rel="ugc noreferrer">${o.title}</a></span>
        <span class="tags">${o.tags.map((t) => `<a class="tag tag_${t}" title="${t}" href="/t/${t}">${t}</a>`).join('')}</span>
        <div class="byline">${o.comments ? `<span class="comments_label"><a role="heading" aria-level="2" href="${o.comments}">12 comments</a></span>` : ''}</div>
      </div>
    </div>
  </li>`;

const lobsters = (stories: string) => `<!DOCTYPE html><html><head><title>Search | Lobsters</title></head><body><ol class="stories list">${stories}</ol></body></html>`;

const ddgResult = (o: { href: string; title: string; snippet: string }) => `
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="${o.href}">${o.title}</a></h2>
      <a class="result__snippet" href="${o.href}">${o.snippet}</a>
    </div>
  </div>`;

const ddgPage = (results: string) => `<!DOCTYPE html><html><body><div class="serp__results"><div id="links" class="results">${results}</div></div></body></html>`;

// ── P2P ─────────────────────────────────────────────────────────────────────

describe('Bitmagnet', () => {
  it('asks /graphql when it is given the address of Bitmagnet itself, as .env.example shows it', async () => {
    upstream('http://bitmagnet.lan:3333/graphql', () => json(bitmagnet()));
    expect(await p2p.searchBitmagnetGraphQL('sintel', 'http://bitmagnet.lan:3333')).toHaveLength(2);
    expect(await p2p.searchBitmagnetGraphQL('sintel', 'http://bitmagnet.lan:3333/')).toHaveLength(2);
    expect(requests.map((r) => r.url.href)).toEqual(['http://bitmagnet.lan:3333/graphql', 'http://bitmagnet.lan:3333/graphql']);
  });

  it("asks its GraphQL API for the query, and returns each torrent's magnet, size, swarm and health", async () => {
    upstream('http://bitmagnet.lan:3333/graphql', () => json(bitmagnet()));
    const results = await p2p.searchBitmagnetGraphQL('sintel', 'http://bitmagnet.lan:3333/graphql');

    const [req] = requests;
    expect(req.init.method).toBe('POST');
    expect(new Headers(req.init.headers).get('content-type')).toBe('application/json');
    const body = JSON.parse(String(req.init.body)) as { query: string; variables: unknown };
    expect(body.variables).toEqual({ queryString: 'sintel' });
    expect(body.query).toMatch(/torrentContent\s*{\s*search\(/);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: `bitmagnet-${SINTEL.toUpperCase()}`,
      title: 'Sintel (2010) 1080p',
      source: 'bitmagnet-dht',
      publishedAt: '2024-03-01T12:00:00Z',
      snippet: `Bitmagnet DHT Swarm · Hash: ${SINTEL.slice(0, 12).toUpperCase()}… · Size: 1.20 GB · Type: movie`,
      p2p: {
        protocol: 'bittorrent-dht',
        infoHash: SINTEL,
        sizeBytes: 1_288_490_189,
        sizeFormatted: '1.20 GB',
        seeders: 210,
        leechers: 12,
        filesCount: 3,
        indexerName: 'Bitmagnet DHT Node',
        categoryLabel: 'movie',
        healthVerdict: 'verified-swarm',
      },
    });
    expect(results[0].url).toMatch(new RegExp(`^magnet:\\?xt=urn:btih:${SINTEL}&dn=Sintel%20\\(2010\\)%201080p&tr=udp%3A%2F%2F`));
    expect(results[0].p2p?.magnetUri).toBe(results[0].url);
    expect(results[1]).toMatchObject({
      title: 'big_buck_bunny_720p.mp4',
      snippet: expect.stringContaining('· Type: DHT'),
      p2p: { infoHash: BUNNY, seeders: 1, leechers: 0, sizeFormatted: '263 MB', categoryLabel: 'DHT Swarm', healthVerdict: 'low-seed' },
    });
  });

  it('asks BITMAGNET_URL, or localhost, when no endpoint is configured', async () => {
    upstream('http://', () => json(bitmagnet([])));
    await withEnv({ BITMAGNET_URL: 'http://bitmagnet.internal:3333/graphql' }, () => p2p.searchBitmagnetGraphQL('sintel'));
    await withEnv({ BITMAGNET_URL: undefined }, () => p2p.searchBitmagnetGraphQL('sintel'));
    expect(requests.map((r) => r.url.href)).toEqual(['http://bitmagnet.internal:3333/graphql', 'http://localhost:3333/graphql']);
  });

  it.each([
    ['a GraphQL error', () => json({ errors: [{ message: 'Cannot query field "torrentContent" on type "Query".' }] })],
    ['an HTTP error', () => json(bitmagnet(), 502)],
    ['a page that is not JSON', () => page('<html><body>Sign in</body></html>')],
    ['an empty answer', () => json({})],
  ])('returns nothing for %s', async (_case, answer) => {
    upstream('http://bitmagnet.lan:3333/graphql', answer);
    expect(await p2p.searchBitmagnetGraphQL('sintel', 'http://bitmagnet.lan:3333/graphql')).toEqual([]);
  });
});

describe('the public DHT index', () => {
  it('turns swarms into magnets with seeders, size, uploader, category and health', async () => {
    upstream('https://apibay.org/q.php', () => json(apibay()));
    const results = await p2p.searchPublicDhtSwarms('debian dvd');
    expect(asked('https://apibay.org/q.php')[0].searchParams.get('q')).toBe('debian dvd');
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({
      id: `dht-${DEBIAN}`,
      title: 'debian-12.5.0-amd64-DVD-1.iso',
      source: 'bitmagnet-dht',
      publishedAt: '2024-02-10T12:00:00.000Z',
      author: 'debian-cd',
      points: 250,
      isNsfw: false,
      snippet: `BitTorrent DHT Swarm (btih:${DEBIAN.slice(0, 16)}…) · 3.72 GB · 250 seeders / 9 leechers · Uploader: debian-cd`,
      p2p: {
        protocol: 'bittorrent-dht',
        infoHash: DEBIAN,
        sizeBytes: 3992977408,
        sizeFormatted: '3.72 GB',
        seeders: 250,
        leechers: 9,
        filesCount: 1,
        indexerName: 'DHT Public Swarm',
        categoryLabel: 'Software / ISO',
        isAdultNsfw: false,
        healthVerdict: 'verified-swarm',
      },
    });
    expect(results[0].url).toMatch(new RegExp(`^magnet:\\?xt=urn:btih:${DEBIAN}&dn=debian-12\\.5\\.0-amd64-DVD-1\\.iso&tr=`));
    expect(results.slice(1).map((r) => [r.p2p?.categoryLabel, r.p2p?.healthVerdict, r.p2p?.filesCount])).toEqual([
      ['Audio / FLAC', 'active', 1],
      ['Books / Zines', 'low-seed', undefined],
      ['DHT Swarm', 'active', 1],
    ]);
    expect(results[1].snippet).toMatch(/Uploader: anon$/);
  });

  it('searches with the keywords of a question', async () => {
    upstream('https://apibay.org/q.php', () => json([]));
    await p2p.executeP2PAndUsenetSearch('where can I download the debian 12 dvd?');
    expect(asked('https://apibay.org/q.php')[0].searchParams.get('q')).toBe('download debian 12 dvd');
  });

  it('drops the no-results marker, bad hashes and swarms that look fake or like malware', async () => {
    upstream('https://apibay.org/q.php', () =>
      json([
        swarm({ id: '0', name: 'No results returned', info_hash: '0000000000000000000000000000000000000000' }),
        swarm({ name: 'bad hash', info_hash: 'xyz' }),
        swarm({ name: 'Blender 4.2 Setup.exe', info_hash: SINTEL, seeders: '500', size: '300000000' }),
        swarm({ name: 'Sintel 2160p HEVC', info_hash: BUNNY, seeders: '40', size: '2097152' }),
        swarm({ name: 'Sintel 2160p HEVC', info_hash: TEARS, seeders: '40', size: '4294967296' }),
      ])
    );
    expect((await p2p.searchPublicDhtSwarms('sintel')).map((r) => r.p2p?.infoHash)).toEqual([TEARS]);
  });

  it('leaves adult swarms out unless 18+ mode is on, and marks them when it is', async () => {
    upstream('https://apibay.org/q.php', () =>
      json([
        swarm({ name: 'Adult clip', info_hash: SINTEL, seeders: '30', size: '700000000', category: '501' }),
        swarm({ name: 'Linux ISO', info_hash: DEBIAN, seeders: '30', size: '700000000', category: '303' }),
      ])
    );
    expect((await p2p.searchPublicDhtSwarms('clip')).map((r) => r.title)).toEqual(['Linux ISO']);
    const all = await p2p.searchPublicDhtSwarms('clip', true);
    expect(all.map((r) => r.title)).toEqual(['Adult clip', 'Linux ISO']);
    expect(all[0]).toMatchObject({ isNsfw: true, p2p: { isAdultNsfw: true, categoryLabel: '18+ / Adult XXX' } });
  });

  it('reads at most 16 swarms', async () => {
    const hash = (i: number) => i.toString(16).padStart(40, 'a');
    upstream('https://apibay.org/q.php', () => json(Array.from({ length: 20 }, (_, i) => swarm({ name: `Swarm ${i}`, info_hash: hash(i), seeders: '10' }))));
    expect(await p2p.searchPublicDhtSwarms('swarm')).toHaveLength(16);
  });

  it.each([
    ['an error status', () => json(apibay(), 503)],
    ['an answer that is not a list', () => json({ error: 'rate limited' })],
  ])('returns nothing for %s', async (_case, answer) => {
    upstream('https://apibay.org/q.php', answer);
    expect(await p2p.searchPublicDhtSwarms('debian')).toEqual([]);
  });
});

describe('Internet Archive torrents', () => {
  it("searches titles in BitTorrent format, linking each item, its torrent and a magnet with the archive's trackers", async () => {
    upstream('https://archive.org/advancedsearch.php', () => json(archive()));
    const results = await p2p.searchInternetArchiveTorrents('debian 12 (dvd)!');

    const url = asked('https://archive.org/advancedsearch.php')[0];
    expect(url.searchParams.get('q')).toBe('title:(debian) AND title:(12) AND title:(dvd) AND format:BitTorrent');
    expect(url.searchParams.get('fl[]')).toBe('identifier,title,description,item_size,btih,publicdate,downloads,mediatype');
    expect([url.searchParams.get('rows'), url.searchParams.get('output')]).toEqual(['8', 'json']);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: 'archive-bt-debian-12.5.0-dvd',
      title: '[Archive BT] Debian 12.5 DVD',
      url: 'https://archive.org/details/debian-12.5.0-dvd',
      snippet: 'The Debian 12.5 install DVD.',
      source: 'archive-bt',
      publishedAt: '2024-02-11T08:00:00Z',
      points: 2500,
      p2p: {
        protocol: 'bittorrent-dht',
        infoHash: DEBIAN,
        torrentUrl: 'https://archive.org/download/debian-12.5.0-dvd/debian-12.5.0-dvd_archive.torrent',
        sizeBytes: 3992977408,
        sizeFormatted: '3.72 GB',
        seeders: 100,
        leechers: 1,
        indexerName: 'Archive.org Seedbox',
        categoryLabel: 'Archive (software)',
        healthVerdict: 'archival-seedbox',
      },
    });
    expect(results[0].p2p?.magnetUri).toMatch(
      new RegExp(`^magnet:\\?xt=urn:btih:${DEBIAN}&dn=Debian%2012\\.5%20DVD&tr=http%3A%2F%2Fbt1\\.archive\\.org%3A6969%2Fannounce&tr=http%3A%2F%2Fbt2\\.archive\\.org`)
    );
    expect(results[1]).toMatchObject({
      title: "[Archive BT] The Debian Administrator's Handbook",
      snippet: 'Verified Internet Archive BitTorrent Swarm (texts) · 50.00 MB · 40 archival downloads.',
      p2p: { infoHash: undefined, magnetUri: undefined, seeders: 5, categoryLabel: 'Archive (texts)' },
    });
  });

  it('asks nothing for a query with no searchable words', async () => {
    expect(await p2p.searchInternetArchiveTorrents('!!! ???')).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('returns nothing for an error status', async () => {
    upstream('https://archive.org/advancedsearch.php', () => json(archive(), 500));
    expect(await p2p.searchInternetArchiveTorrents('debian')).toEqual([]);
  });
});

describe('NZBIndex', () => {
  it('returns Usenet releases with their group, age, PAR2 state and NZB link', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'));
    upstream('https://nzbindex.com/api/search', () =>
      json(
        nzbindex([
          {
            id: '1a2b3c',
            name: 'ubuntu-24.04.1-desktop-amd64.iso yEnc',
            poster: 'linux@example.org',
            posted: Date.parse('2026-10-31T00:00:00Z') / 1000,
            size: 6203355136,
            fileCount: 78,
            complete: true,
            groups: ['alt.binaries.linux', 'alt.binaries.iso'],
          },
          { id: '4d5e6f', name: 'ubuntu-24.04.1-live-server-amd64.iso', size: 2754981888, complete: false, groups: [] },
          { id: '', name: 'no id' },
          { id: '7a8b9c', name: 'ubuntu codec pack required.exe', size: 1000, complete: true, groups: ['alt.binaries.misc'] },
        ])
      )
    );
    const results = await p2p.searchUsenetNzbIndex('ubuntu 24.04');
    expect(Object.fromEntries(asked('https://nzbindex.com/api/search')[0].searchParams)).toEqual({ q: 'ubuntu 24.04', max: '12' });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: 'nzb-1a2b3c',
      title: '[NZB] ubuntu-24.04.1-desktop-amd64.iso',
      url: 'https://nzbindex.com/collection/1a2b3c',
      snippet: 'Usenet Binary Release in alt.binaries.linux · 5.78 GB (78 files) · Retention: 10d · Poster: linux@example.org',
      source: 'usenet-nzb',
      publishedAt: '2026-10-31T00:00:00.000Z',
      author: 'linux@example.org',
      isNsfw: false,
      p2p: {
        protocol: 'usenet-nzb',
        nzbUrl: 'https://nzbindex.com/download/1a2b3c/ubuntu-24.04.1-desktop-amd64.iso.nzb',
        sizeBytes: 6203355136,
        sizeFormatted: '5.78 GB',
        filesCount: 78,
        newsgroup: 'alt.binaries.linux',
        usenetAgeDays: 10,
        par2Status: 'complete',
        indexerName: 'NZBIndex Usenet',
        categoryLabel: 'a.b.linux',
        isAdultNsfw: false,
        healthVerdict: 'verified-swarm',
      },
    });
    expect(results[1]).toMatchObject({
      snippet: 'Usenet Binary Release in alt.binaries.misc · 2.57 GB (1 files) · Retention: ?d · Poster: anon',
      publishedAt: undefined,
      p2p: { newsgroup: 'alt.binaries.misc', usenetAgeDays: undefined, par2Status: 'unverified', healthVerdict: 'active', categoryLabel: 'a.b.misc' },
    });
  });

  it('leaves releases in adult groups out unless 18+ mode is on', async () => {
    upstream('https://nzbindex.com/api/search', () =>
      json(
        nzbindex([
          { id: 'x1', name: 'Clip collection', size: 700000000, complete: true, groups: ['alt.binaries.erotica'] },
          { id: 'x2', name: 'Debian DVD', size: 700000000, complete: true, groups: ['alt.binaries.linux'] },
        ])
      )
    );
    expect((await p2p.searchUsenetNzbIndex('collection')).map((r) => r.id)).toEqual(['nzb-x2']);
    const all = await p2p.searchUsenetNzbIndex('collection', true);
    expect(all.map((r) => r.id)).toEqual(['nzb-x1', 'nzb-x2']);
    expect(all[0]).toMatchObject({ isNsfw: true, p2p: { isAdultNsfw: true, categoryLabel: '18+ Usenet Binary' } });
  });

  it.each([
    ['an error status', () => json(nzbindex([]), 429)],
    ['an answer without content', () => json({ data: null })],
  ])('returns nothing for %s', async (_case, answer) => {
    upstream('https://nzbindex.com/api/search', answer);
    expect(await p2p.searchUsenetNzbIndex('ubuntu')).toEqual([]);
  });
});

describe('Torznab and Newznab indexers', () => {
  it('asks with t=search, the query and the key, keeping the parameters already in the address', async () => {
    upstream('http://prowlarr.lan:9696/', () => page(torznab(''), 'application/rss+xml'));
    await p2p.searchTorznabOrNewznab('debian 12', 'http://prowlarr.lan:9696/1/api?cat=2000', 'pk-123');
    const url = requests[0].url;
    expect(url.pathname).toBe('/1/api');
    expect(Object.fromEntries(url.searchParams)).toEqual({ cat: '2000', t: 'search', q: 'debian 12', apikey: 'pk-123' });
  });

  it('reads Torznab items: a magnet when there is an info hash, the torrent link otherwise', async () => {
    upstream('http://prowlarr.lan:9696/', () =>
      page(
        torznab(
          torznabItem({ title: 'Debian 12.5 DVD', link: 'http://prowlarr.lan:9696/1/download?apikey=pk&amp;file=Debian', size: 3992977408, seeders: 120, peers: 135, infohash: DEBIAN.toUpperCase() }) +
            torznabItem({ title: 'Debian 12.5 netinst', link: 'http://prowlarr.lan:9696/1/download?apikey=pk&amp;file=netinst', size: 658505728, seeders: 4, infohash: 'not-a-hash' })
        ),
        'application/rss+xml'
      )
    );
    const results = await p2p.searchTorznabOrNewznab('debian', 'http://prowlarr.lan:9696/1/api', 'pk');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: 'znab-bittorrent-dht-0-Debian 12.5 DVD',
      title: 'Debian 12.5 DVD',
      snippet: 'Indexed via Torznab · 3.72 GB',
      source: 'bitmagnet-dht',
      publishedAt: 'Sat, 10 Feb 2024 12:00:00 +0000',
      p2p: { protocol: 'bittorrent-dht', infoHash: DEBIAN, torrentUrl: undefined, nzbUrl: undefined, sizeBytes: 3992977408, seeders: 120, indexerName: 'Torznab Node', healthVerdict: 'active' },
    });
    expect(results[0].url).toMatch(new RegExp(`^magnet:\\?xt=urn:btih:${DEBIAN}&dn=Debian%2012\\.5%20DVD`));
    expect(results[0].p2p?.magnetUri).toBe(results[0].url);
    expect(results[1]).toMatchObject({
      url: 'http://prowlarr.lan:9696/1/download?apikey=pk&file=netinst',
      p2p: { infoHash: undefined, magnetUri: undefined, torrentUrl: 'http://prowlarr.lan:9696/1/download?apikey=pk&file=netinst', seeders: 4 },
    });
  });

  it('reads Newznab items as NZB links', async () => {
    upstream('http://nzbhydra.lan:5076/api', () => page(newznab(newznabItem('Sintel.2010.1080p.BluRay', 'http://nzbhydra.lan:5076/getnzb/api/4711?apikey=nk')), 'application/rss+xml'));
    const [result] = await p2p.searchTorznabOrNewznab('sintel', 'http://nzbhydra.lan:5076/api', 'nk', 'usenet-nzb');
    expect(result).toMatchObject({
      id: 'znab-usenet-nzb-0-Sintel.2010.1080p.BluRay',
      title: 'Sintel.2010.1080p.BluRay',
      url: 'http://nzbhydra.lan:5076/getnzb/api/4711?apikey=nk',
      snippet: 'Indexed via Newznab · 700 MB',
      source: 'usenet-nzb',
      publishedAt: 'Sun, 11 Feb 2024 09:30:00 +0000',
      p2p: { protocol: 'usenet-nzb', nzbUrl: 'http://nzbhydra.lan:5076/getnzb/api/4711?apikey=nk', torrentUrl: undefined, sizeBytes: 734003200, indexerName: 'Newznab Node' },
    });
  });

  it('reads at most 12 items', async () => {
    const items = Array.from({ length: 15 }, (_, i) => newznabItem(`Release ${i}`, `http://nzbhydra.lan:5076/getnzb/${i}`)).join('');
    upstream('http://nzbhydra.lan:5076/api', () => page(newznab(items), 'application/rss+xml'));
    expect(await p2p.searchTorznabOrNewznab('release', 'http://nzbhydra.lan:5076/api', 'nk', 'usenet-nzb')).toHaveLength(12);
  });

  it('asks nothing without an address, or with one it cannot read', async () => {
    expect(await p2p.searchTorznabOrNewznab('debian', undefined)).toEqual([]);
    expect(await p2p.searchTorznabOrNewznab('debian', 'prowlarr without a scheme')).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each([
    ['refuses the key', () => page('<?xml version="1.0"?><error code="100" description="Incorrect user credentials"/>', 'application/xml', 401)],
    ['answers with a page that is not a feed', () => page('<html><body><form>Sign in</form></body></html>')],
  ])('returns nothing when the indexer %s', async (_case, answer) => {
    upstream('http://prowlarr.lan:9696/', answer);
    expect(await p2p.searchTorznabOrNewznab('debian', 'http://prowlarr.lan:9696/1/api', 'pk')).toEqual([]);
  });
});

describe('the P2P and Usenet search', () => {
  const env = { BITMAGNET_URL: undefined, NZBLIFE_API_KEY: undefined, NZBLIFE_URL: undefined };

  function everyIndexAnswers() {
    upstream('http://bitmagnet.lan:3333/graphql', () => json(bitmagnet([{ infoHash: SINTEL, title: 'Sintel from Bitmagnet', seeders: 30, torrent: { size: 700_000_000 } }])));
    upstream('https://apibay.org/q.php', () => json([swarm({ name: 'Sintel from the DHT', info_hash: BUNNY, seeders: '30', size: '700000000' })]));
    upstream('https://archive.org/advancedsearch.php', () => json({ response: { docs: [{ identifier: 'sintel', title: 'Sintel from the Archive', btih: TEARS, downloads: 100 }] } }));
    upstream('https://nzbindex.com/api/search', () => json(nzbindex([{ id: 'n1', name: 'Sintel from NZBIndex', size: 700000000, complete: true, groups: ['alt.binaries.movies'] }])));
    upstream('http://prowlarr.lan:9696/torznab', () => page(torznab(torznabItem({ title: 'Sintel from Torznab', link: 'http://prowlarr.lan:9696/dl/1', infohash: DEBIAN })), 'application/rss+xml'));
    upstream('http://nzbhydra.lan:5076/api', () => page(newznab(newznabItem('Sintel from Newznab', 'http://nzbhydra.lan:5076/getnzb/1')), 'application/rss+xml'));
    upstream('https://api.nzb.life/api', () => page(newznab(newznabItem('Sintel from NZB.life', 'https://api.nzb.life/getnzb/1')), 'application/rss+xml'));
  }

  it('asks every index, listing Bitmagnet and Torznab first', async () => {
    everyIndexAnswers();
    const results = await withEnv(env, () =>
      p2p.executeP2PAndUsenetSearch('sintel', {
        bitmagnetUrl: 'http://bitmagnet.lan:3333/graphql',
        torznabUrl: 'http://prowlarr.lan:9696/torznab',
        torznabApiKey: 'tk',
        newznabUrl: 'http://nzbhydra.lan:5076/api',
        newznabApiKey: 'nk',
        nzbLifeApiKey: 'lk',
      })
    );
    expect(results.map((r) => r.title)).toEqual([
      'Sintel from Bitmagnet',
      'Sintel from Torznab',
      'Sintel from the DHT',
      '[Archive BT] Sintel from the Archive',
      'Sintel from NZB.life',
      'Sintel from Newznab',
      '[NZB] Sintel from NZBIndex',
    ]);
    expect(results.find((r) => r.title === 'Sintel from NZB.life')).toMatchObject({
      source: 'nzb-life',
      snippet: 'Indexed via NZB.life · 700 MB',
      p2p: { protocol: 'usenet-nzb', indexerName: 'NZB.life', nzbUrl: 'https://api.nzb.life/getnzb/1' },
    });
    expect(asked('https://api.nzb.life/api')[0].searchParams.get('apikey')).toBe('lk');
    expect(asked('http://prowlarr.lan:9696/torznab')[0].searchParams.get('apikey')).toBe('tk');
    expect(asked('http://nzbhydra.lan:5076/api')[0].searchParams.get('apikey')).toBe('nk');
  });

  it('asks NZB.life only with a key, from the settings or from NZBLIFE_API_KEY', async () => {
    everyIndexAnswers();
    upstream('https://nzb.life.example/api', () => page(newznab(''), 'application/rss+xml'));
    await withEnv(env, () => p2p.executeP2PAndUsenetSearch('sintel', {}));
    expect(asked('https://api.nzb.life/')).toEqual([]);
    await withEnv({ ...env, NZBLIFE_API_KEY: 'env-key', NZBLIFE_URL: 'https://nzb.life.example/api' }, () => p2p.executeP2PAndUsenetSearch('sintel'));
    expect(asked('https://nzb.life.example/api')[0].searchParams.get('apikey')).toBe('env-key');
  });

  it('passes 18+ mode on to the DHT and Usenet indexes', async () => {
    upstream('https://apibay.org/q.php', () => json([swarm({ name: 'Adult clip', info_hash: SINTEL, seeders: '30', size: '700000000', category: '501' })]));
    upstream('https://nzbindex.com/api/search', () => json(nzbindex([{ id: 'x1', name: 'Clip collection', size: 700000000, complete: true, groups: ['alt.binaries.erotica'] }])));
    const sources = async (uncensored: boolean) =>
      (await withEnv(env, () => p2p.executeP2PAndUsenetSearch('clip', {}, uncensored))).map((r) => r.source);
    expect(await sources(false)).toEqual([]);
    expect(await sources(true)).toEqual(['bitmagnet-dht', 'usenet-nzb']);
  });

  it('searches nothing for an empty query', async () => {
    expect(await p2p.executeP2PAndUsenetSearch('   ')).toEqual([]);
    expect(requests).toEqual([]);
  });
});

// ── The Fediverse ───────────────────────────────────────────────────────────

describe('Bluesky', () => {
  // The public AppView answers searchPosts with 403; api.bsky.app still answers it without signing in.
  const POSTS = 'https://api.bsky.app/xrpc/app.bsky.feed.searchPosts';
  const ACTORS = 'https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors';
  const long = 'How the Rust borrow checker reasons about lifetimes,   with three small examples that each fail to compile at first';

  it('finds posts, linking to them on bsky.app or to the page they share', async () => {
    upstream(POSTS, () =>
      json({
        posts: [
          bskyPost({ uri: 'at://did:plc:ferris/app.bsky.feed.post/3kx1abc', cid: 'bafy-a', record: { text: long, createdAt: '2026-11-01T10:00:00.000Z' }, likeCount: 40, repostCount: 5, replyCount: 7 }),
          bskyPost({
            uri: 'at://did:plc:ferris/app.bsky.feed.post/3kx2def',
            cid: 'bafy-b',
            record: { text: 'Good read on borrow checking in Rust' },
            embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://blog.example/rust-borrow-checker', title: 'The Rust borrow checker, explained', description: 'A tour' } },
          }),
          bskyPost({ cid: 'bafy-c', record: { text: 'What I had for lunch today' } }),
          bskyPost({ cid: 'bafy-d', record: { text: '' } }),
        ],
        cursor: '1',
      })
    );
    upstream(ACTORS, () => json({ actors: [] }));
    const results = await fedi.searchAtProtocol('rust borrow checker');

    expect(Object.fromEntries(asked(POSTS)[0].searchParams)).toEqual({ q: 'rust borrow checker', limit: '6' });
    expect(Object.fromEntries(asked(ACTORS)[0].searchParams)).toEqual({ q: 'rust borrow checker', limit: '4' });
    expect(results).toHaveLength(2);
    const clean = long.replace(/\s+/g, ' ');
    expect(results[0]).toEqual({
      id: 'atproto-post-bafy-a',
      title: `[ATProto · @ferris.bsky.social] ${clean.slice(0, 82)}…`,
      url: 'https://bsky.app/profile/ferris.bsky.social/post/3kx1abc',
      snippet: `${clean} · AT-URI: at://did:plc:ferris/app.bsky.feed.post/3kx1abc`,
      source: 'atproto',
      publishedAt: '2026-11-01T10:00:00.000Z',
      author: '@ferris.bsky.social',
      points: 45,
      commentsCount: 7,
      fediverse: {
        protocol: 'atproto',
        handleOrRoom: '@ferris.bsky.social',
        uri: 'at://did:plc:ferris/app.bsky.feed.post/3kx1abc',
        cidOrId: 'bafy-a',
        instanceDomain: 'bsky.app',
        membersOrInteractions: 45,
      },
    });
    expect(results[1]).toMatchObject({ id: 'atproto-post-bafy-b', title: 'The Rust borrow checker, explained', url: 'https://blog.example/rust-borrow-checker' });
  });

  it('adds at most two accounts whose name, handle or bio match the query', async () => {
    upstream(POSTS, () => json({ posts: [] }));
    upstream(ACTORS, () =>
      json({
        actors: [
          { did: 'did:plc:rustlang', handle: 'rust-lang.org', displayName: 'Rust Language', description: 'Official account of the Rust programming   language.', indexedAt: '2024-01-01T00:00:00.000Z' },
          { did: 'did:plc:rustconf', handle: 'rustconf.com', displayName: 'RustConf', description: 'The Rust programming language conference.' },
          { did: 'did:plc:rustfdn', handle: 'rustfoundation.org', displayName: 'Rust Foundation', description: 'Stewards of the Rust programming language.' },
          { did: 'did:plc:baker', handle: 'baker.bsky.social', displayName: 'Bread Baker', description: 'Sourdough every day.' },
        ],
      })
    );
    const results = await fedi.searchAtProtocol('rust programming language');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: 'atproto-actor-did:plc:rustlang',
      title: '[ATProto @rust-lang.org] Rust Language',
      url: 'https://bsky.app/profile/rust-lang.org',
      snippet: 'Official account of the Rust programming language. · DID: did:plc:rustlang',
      source: 'atproto',
      publishedAt: '2024-01-01T00:00:00.000Z',
      author: '@rust-lang.org',
      fediverse: { protocol: 'atproto', handleOrRoom: '@rust-lang.org', uri: 'at://did:plc:rustlang', cidOrId: 'did:plc:rustlang', instanceDomain: 'bsky.app' },
    });
    expect(results.map((r) => r.author)).not.toContain('@baker.bsky.social');
  });

  it('searches posts on api.bsky.app, since the public AppView answers searchPosts with 403', async () => {
    upstream('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts', () => page('<html><head><title>403 Forbidden</title></head></html>', 'text/html', 403));
    upstream(POSTS, () => json({ posts: [bskyPost({ cid: 'bafy-a', record: { text: 'How the Rust borrow checker reasons about lifetimes' } })] }));
    upstream(ACTORS, () => json({ actors: [] }));
    expect((await fedi.searchAtProtocol('rust borrow checker')).map((r) => r.id)).toEqual(['atproto-post-bafy-a']);
    expect(asked('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts')).toEqual([]);
    // Set to the public AppView by hand, it's the same.
    requests.length = 0;
    await fedi.searchAtProtocol('rust borrow checker', 'https://public.api.bsky.app');
    expect(asked(POSTS)).toHaveLength(1);
  });

  it('asks a custom AppView when one is set', async () => {
    upstream('https://appview.example/', () => json({ posts: [], actors: [] }));
    await fedi.searchAtProtocol('rust borrow checker', 'https://appview.example');
    expect(requests.map((r) => r.url.pathname)).toEqual(['/xrpc/app.bsky.feed.searchPosts', '/xrpc/app.bsky.actor.searchActors']);
  });

  it('still looks for accounts when the post search fails', async () => {
    upstream(POSTS, () => json({ error: 'InternalServerError' }, 500));
    upstream(ACTORS, () => json({ actors: [{ did: 'did:plc:rustlang', handle: 'rust-lang.org', displayName: 'Rust Language', description: 'The Rust programming language.' }] }));
    expect((await fedi.searchAtProtocol('rust programming language')).map((r) => r.id)).toEqual(['atproto-actor-did:plc:rustlang']);
  });

  it('returns nothing when both searches fail', async () => {
    upstream('https://public.api.bsky.app/', () => json({ error: 'RateLimitExceeded' }, 429));
    upstream('https://api.bsky.app/', () => json({ error: 'RateLimitExceeded' }, 429));
    expect(await fedi.searchAtProtocol('rust borrow checker')).toEqual([]);
  });

  it('gives up on posts, then accounts, each at its own deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    upstream('https://public.api.bsky.app/', silent);
    upstream('https://api.bsky.app/', silent);
    let settled = false;
    const pending = fedi.searchAtProtocol('rust borrow checker').then((r) => {
      settled = true;
      return r;
    });
    await reached(1);
    await vi.advanceTimersByTimeAsync(3199);
    expect(requests[0].init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await reached(2);
    expect(requests[0].init.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([]);
    expect(requests[1].init.signal?.aborted).toBe(true);
  });
});

describe('Mastodon', () => {
  const TAG = '/api/v1/timelines/tag/sourdough';

  it('reads the tag timeline on mastodon.social, fosstodon.org and infosec.exchange', async () => {
    upstream(`https://mastodon.social${TAG}`, () =>
      json([
        status({
          id: '111',
          uri: 'https://mastodon.social/users/alice/statuses/111',
          url: 'https://mastodon.social/@alice/111',
          content: '<p>My <a href="https://mastodon.social/tags/sourdough" class="mention hashtag">#<span>sourdough</span></a> starter finally<br>doubled overnight</p>',
          favourites_count: 12,
          reblogs_count: 3,
          replies_count: 4,
        }),
      ])
    );
    upstream(`https://fosstodon.org${TAG}`, () =>
      json([
        status({
          id: '222',
          uri: 'https://hachyderm.io/users/bob/statuses/222',
          url: 'https://hachyderm.io/@bob/222',
          account: { acct: 'bob@hachyderm.io' },
          content: '<p>Feeding a sourdough starter, the short version</p>',
          card: { url: 'https://bread.example/sourdough-starter', title: 'How to keep a sourdough starter alive', description: '' },
        }),
      ])
    );
    upstream(`https://infosec.exchange${TAG}`, () => json([]));
    const results = await fedi.searchActivityPubMastodon('sourdough starter');

    expect(requests.map((r) => r.url.href).sort()).toEqual([
      'https://fosstodon.org/api/v1/timelines/tag/sourdough?limit=4',
      'https://infosec.exchange/api/v1/timelines/tag/sourdough?limit=4',
      'https://mastodon.social/api/v1/timelines/tag/sourdough?limit=4',
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: 'ap-mastodon.social-111',
      title: '[ActivityPub @alice@mastodon.social] My # sourdough starter finally doubled overnight',
      url: 'https://mastodon.social/@alice/111',
      snippet: 'My # sourdough starter finally doubled overnight · ActivityPub Actor: @alice@mastodon.social (15 boosts/favs)',
      source: 'activitypub',
      publishedAt: '2026-11-02T09:00:00.000Z',
      author: '@alice@mastodon.social',
      points: 15,
      commentsCount: 4,
      isNsfw: false,
      fediverse: {
        protocol: 'activitypub',
        handleOrRoom: '@alice@mastodon.social',
        uri: 'https://mastodon.social/users/alice/statuses/111',
        cidOrId: '111',
        instanceDomain: 'mastodon.social',
        membersOrInteractions: 15,
      },
    });
    expect(results[1]).toMatchObject({
      id: 'ap-fosstodon.org-222',
      title: 'How to keep a sourdough starter alive',
      url: 'https://bread.example/sourdough-starter',
      author: '@bob@hachyderm.io',
      fediverse: { instanceDomain: 'fosstodon.org' },
    });
  });

  it('hides sensitive posts unless 18+ mode is on', async () => {
    upstream(`https://mastodon.social${TAG}`, () =>
      json([status({ id: '333', sensitive: true, spoiler_text: 'food', content: '<p>Sourdough starter gone wrong, look away</p>' })])
    );
    expect(await fedi.searchActivityPubMastodon('sourdough starter')).toEqual([]);
    const [shown] = await fedi.searchActivityPubMastodon('sourdough starter', true);
    expect(shown).toMatchObject({ id: 'ap-mastodon.social-333', isNsfw: true });
  });

  it('drops posts that are off topic', async () => {
    upstream(`https://mastodon.social${TAG}`, () => json([status({ id: '444', content: '<p>Good morning everyone, coffee time</p>' })]));
    expect(await fedi.searchActivityPubMastodon('sourdough starter')).toEqual([]);
  });

  it('keeps what one instance found when the others fail', async () => {
    upstream(`https://mastodon.social${TAG}`, () => json([status({ id: '555', content: '<p>Sourdough starter tips</p>' })]));
    upstream(`https://fosstodon.org${TAG}`, () => json({ error: 'Service Unavailable' }, 503));
    upstream(`https://infosec.exchange${TAG}`, () => json({ error: 'Record not found' }));
    expect((await fedi.searchActivityPubMastodon('sourdough starter')).map((r) => r.id)).toEqual(['ap-mastodon.social-555']);
  });

  it('returns at most eight posts', async () => {
    upstream('https://', (url) =>
      json(Array.from({ length: 4 }, (_, i) => status({ id: `${url.hostname}-${i}`, content: `<p>Sourdough starter, day ${i}</p>` })))
    );
    expect(await fedi.searchActivityPubMastodon('sourdough starter')).toHaveLength(8);
  });

  it('asks nothing when the query has no word to use as a tag', async () => {
    expect(await fedi.searchActivityPubMastodon('is it ok')).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('Matrix', () => {
  const DIRECTORY = 'https://matrix.org/_matrix/client/v3/publicRooms';
  const rooms = () => ({
    chunk: [
      room({ room_id: '!small:matrix.org', canonical_alias: '#rust-beginners:matrix.org', name: 'Rust Beginners', topic: 'Questions about   Rust welcome', num_joined_members: 120 }),
      room({ room_id: '!big:mozilla.org', canonical_alias: '#rust:mozilla.org', name: 'Rust', topic: 'The Rust programming language', num_joined_members: 9000 }),
      room({ room_id: '!noalias:matrix.org', name: 'Rust Gamedev', num_joined_members: 300 }),
      room({ room_id: '!topic:matrix.org', canonical_alias: '#lang:matrix.org', name: 'Languages', topic: 'We talk about rust sometimes', num_joined_members: 5000 }),
      room({ room_id: '!python:matrix.org', canonical_alias: '#python:matrix.org', name: 'Python', num_joined_members: 7000 }),
    ],
    next_batch: 'p190q',
    total_room_count_estimate: 5,
  });

  it('lists rooms whose name or alias match, biggest first, linking through matrix.to', async () => {
    const matrix = await freshFediverse();
    upstream(DIRECTORY, () => json(rooms()));
    const results = await matrix.searchMatrixPublicRooms('rust');
    expect(asked(DIRECTORY)[0].searchParams.get('limit')).toBe('300');
    expect(results.map((r) => r.fediverse?.cidOrId)).toEqual(['!big:mozilla.org', '!noalias:matrix.org', '!small:matrix.org']);
    expect(results[0]).toEqual({
      id: 'matrix-!big:mozilla.org',
      title: '[Matrix Room #rust:mozilla.org] Rust',
      url: 'https://matrix.to/#/%23rust%3Amozilla.org',
      snippet: 'The Rust programming language · 9000 members · Room ID: !big:mozilla.org',
      source: 'matrix',
      points: 9000,
      fediverse: {
        protocol: 'matrix',
        handleOrRoom: '#rust:mozilla.org',
        uri: 'matrix:r/rust:mozilla.org',
        cidOrId: '!big:mozilla.org',
        instanceDomain: 'matrix.org',
        membersOrInteractions: 9000,
      },
    });
    expect(results[1]).toMatchObject({
      title: '[Matrix Room !noalias:matrix.org] Rust Gamedev',
      url: 'https://matrix.to/#/!noalias%3Amatrix.org',
      snippet: 'Public federated Matrix room · 300 members · Room ID: !noalias:matrix.org',
    });
    expect(results[2].snippet).toBe('Questions about Rust welcome · 120 members · Room ID: !small:matrix.org');
  });

  it('needs most words of the query, and the main one in the name or alias', async () => {
    const matrix = await freshFediverse();
    upstream(DIRECTORY, () => json(rooms()));
    expect((await matrix.searchMatrixPublicRooms('rust gamedev')).map((r) => r.fediverse?.cidOrId)).toEqual(['!noalias:matrix.org']);
    expect(await matrix.searchMatrixPublicRooms('a')).toEqual([]);
  });

  it('reads the room directory once every five minutes', async () => {
    const matrix = await freshFediverse();
    vi.useFakeTimers({ toFake: ['Date'] });
    upstream(DIRECTORY, () => json(rooms()));
    await matrix.searchMatrixPublicRooms('rust');
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await matrix.searchMatrixPublicRooms('python')).toHaveLength(1);
    expect(asked(DIRECTORY)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1);
    await matrix.searchMatrixPublicRooms('rust');
    expect(asked(DIRECTORY)).toHaveLength(2);
  });

  it('asks again on the next search when the directory fails or answers junk', async () => {
    const matrix = await freshFediverse();
    const answers = [json({ errcode: 'M_UNKNOWN' }, 502), json({ chunk: 'not a list' }), json(rooms())];
    upstream(DIRECTORY, () => answers.shift()!);
    expect(await matrix.searchMatrixPublicRooms('rust')).toEqual([]);
    expect(await matrix.searchMatrixPublicRooms('rust')).toEqual([]);
    expect(await matrix.searchMatrixPublicRooms('rust')).toHaveLength(3);
    expect(asked(DIRECTORY)).toHaveLength(3);
  });

  it('gives up on a silent directory after 3.6 seconds', async () => {
    const matrix = await freshFediverse();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    upstream(DIRECTORY, silent);
    let settled = false;
    const pending = matrix.searchMatrixPublicRooms('rust').then((r) => {
      settled = true;
      return r;
    });
    await reached(1);
    await vi.advanceTimersByTimeAsync(3599);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([]);
  });
});

describe('Stoat', () => {
  it('lists the Stoat projects a query is about, without asking the network', async () => {
    const results = await fedi.searchStoatEcosystem('self-hosted stoat server');
    expect(results.map((r) => r.id)).toEqual(['stoat-selfhost']);
    expect(results[0]).toMatchObject({
      title: '[Stoat] Stoat Self-Hosted Deployment Stack (Docker Compose & Federation Bridges)',
      url: 'https://github.com/revoltchat/self-hosted',
      source: 'stoat',
      publishedAt: '2024-06-01',
      fediverse: { protocol: 'stoat', handleOrRoom: 'stoat.chat/self-hosted', uri: 'https://github.com/revoltchat/self-hosted', instanceDomain: 'stoat.chat' },
    });
    expect((await fedi.searchStoatEcosystem('stoat chat')).map((r) => r.id)).toEqual(['stoat-core']);
    expect(await fedi.searchStoatEcosystem('sourdough starter')).toEqual([]);
    expect(await fedi.searchStoatEcosystem('a')).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('the Fediverse search', () => {
  it('asks Bluesky, Mastodon and Matrix with the custom endpoints and 18+ mode, listing Bluesky first', async () => {
    const f = await freshFediverse();
    upstream('https://appview.example/xrpc/app.bsky.feed.searchPosts', () =>
      json({ posts: [bskyPost({ cid: 'bafy-stoat', record: { text: 'Trying Stoat chat for our community' } })] })
    );
    upstream('https://appview.example/xrpc/app.bsky.actor.searchActors', () => json({ actors: [] }));
    upstream('https://mastodon.social/api/v1/timelines/tag/stoat', () =>
      json([status({ id: '777', sensitive: true, content: '<p>Stoat chat is our new home</p>' })])
    );
    upstream('https://matrix.example/_matrix/client/v3/publicRooms', () =>
      json({ chunk: [room({ room_id: '!stoat:matrix.example', canonical_alias: '#stoat-chat:matrix.example', name: 'Stoat chat', num_joined_members: 42 })] })
    );
    const results = await f.executeFediverseSearch('stoat chat', true, { atprotoAppViewUrl: 'https://appview.example', matrixHomeserverUrl: 'https://matrix.example' });
    expect(results.map((r) => r.source)).toEqual(['atproto', 'activitypub', 'matrix', ...results.slice(3).map(() => 'stoat')]);
    expect(results.slice(0, 3).map((r) => r.id)).toEqual(['atproto-post-bafy-stoat', 'ap-mastodon.social-777', 'matrix-!stoat:matrix.example']);
    expect(results.length).toBeGreaterThan(3);
    expect(asked('https://public.api.bsky.app/')).toEqual([]);
    expect(asked('https://api.bsky.app/')).toEqual([]);
    expect(asked('https://matrix.org/')).toEqual([]);
  });
});

// ── The wild west ───────────────────────────────────────────────────────────

describe('4chan catalogs', () => {
  const office = 'which mechanical switches for a quiet keyboard at the office? I type all day and my coworkers hate me';

  it('searches /g/, /sci/, /diy/ and /x/, keeping threads that match most of the query', async () => {
    upstream('https://a.4cdn.org/', () => json(catalog([])));
    upstream('https://a.4cdn.org/g/catalog.json', () =>
      json(
        catalog([
          { no: 101, sub: 'Mechanical keyboard &amp; switches general', com: 'Post your boards.<br>Linear &gt; tactile? &quot;clicky&quot; is &#039;fine&#039;', time: 1762700000, replies: 312, images: 140 },
          { no: 102, com: office, replies: 5 },
          { no: 103, sub: 'Keyboard only', com: 'membrane forever', replies: 1 },
          { no: 104, sub: 'Monitor general' },
        ])
      )
    );
    const results = await wild.searchFourChanCatalogs('mechanical keyboard switches');
    expect(requests.map((r) => r.url.href)).toEqual([
      'https://a.4cdn.org/g/catalog.json',
      'https://a.4cdn.org/sci/catalog.json',
      'https://a.4cdn.org/diy/catalog.json',
      'https://a.4cdn.org/x/catalog.json',
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: '[/g/ #101] Mechanical keyboard & switches general',
      url: 'https://boards.4chan.org/g/thread/101',
      snippet: 'Post your boards. Linear > tactile? "clicky" is \'fine\' · (312 replies, 140 images on /g/)',
      source: 'chanboards',
      publishedAt: new Date(1762700000 * 1000).toISOString(),
      points: 312,
      commentsCount: 312,
      isNsfw: false,
      tags: ['4chan', '/g/', 'imageboard', 'wild-west'],
    });
    expect(results[1]).toMatchObject({ title: `[/g/ #102] ${office.slice(0, 72)}...`, snippet: `${office} · (5 replies, 0 images on /g/)`, publishedAt: undefined });
  });

  it('puts /vr/, /lit/ or /biz/ first for retro, book or money questions, keeping four boards', async () => {
    upstream('https://a.4cdn.org/', () => json(catalog([])));
    await wild.searchFourChanCatalogs('retro thinkpad bios');
    await wild.searchFourChanCatalogs('kafka novel');
    await wild.searchFourChanCatalogs('bitcoin market');
    expect(requests.map((r) => r.url.pathname.split('/')[1])).toEqual(['vr', 'g', 'sci', 'diy', 'lit', 'g', 'sci', 'diy', 'biz', 'g', 'sci', 'diy']);
  });

  it('never asks /pol/ or /b/ outside 18+ mode', async () => {
    upstream('https://a.4cdn.org/', () => json(catalog([])));
    await wild.searchFourChanCatalogs('linux kernel');
    await wild.searchFourChanCatalogs('retro kafka bitcoin');
    const boards = requests.map((r) => r.url.pathname.split('/')[1]);
    expect(boards).not.toContain('pol');
    expect(boards).not.toContain('b');
  });

  it('reads at most five threads a board, and ten in all', async () => {
    upstream('https://a.4cdn.org/', (url) =>
      json(catalog(Array.from({ length: 8 }, (_, i) => ({ no: i + 1, sub: `Linux kernel thread ${i} on ${url.pathname}` }))))
    );
    const results = await wild.searchFourChanCatalogs('linux kernel');
    expect(results).toHaveLength(10);
    expect(results.map((r) => r.url.split('/')[3])).toEqual(['g', 'g', 'g', 'g', 'g', 'sci', 'sci', 'sci', 'sci', 'sci']);
  });

  it('skips boards that fail or answer junk', async () => {
    upstream('https://a.4cdn.org/g/', () => json({ error: 'Not Found' }, 404));
    upstream('https://a.4cdn.org/sci/', () => json({ not: 'a list of pages' }));
    upstream('https://a.4cdn.org/diy/', () => page('<html>Cloudflare</html>'));
    upstream('https://a.4cdn.org/x/', () => json(catalog([{ no: 7, sub: 'Linux kernel hauntings' }])));
    expect((await wild.searchFourChanCatalogs('linux kernel')).map((r) => r.url)).toEqual(['https://boards.4chan.org/x/thread/7']);
  });

  it('asks nothing for a query without a word of two letters or more', async () => {
    expect(await wild.searchFourChanCatalogs('a')).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('chan archives', () => {
  const noPosts = () => json(fuuka([]));
  const comment = 'sound blaster live drivers for windows 98, anyone still have the original disk? ';

  it('searches Desuarchive, 4plebs, Lainchan, b4k and Palanq for the query', async () => {
    upstream('https://', noPosts);
    upstream('https://lainchan.org/', () => json(catalog([])));
    await wild.searchChanArchives('sound blaster');
    expect(requests.map((r) => r.url.href).sort()).toEqual([
      'https://arch.b4k.dev/_/api/chan/search/?text=sound%20blaster',
      'https://archive.4plebs.org/_/api/chan/search/?text=sound%20blaster&boards=x.tg.tv.adv.trv.sp.o',
      'https://archive.palanq.win/_/api/chan/search/?text=sound%20blaster',
      'https://desuarchive.org/_/api/chan/search/?text=sound%20blaster',
      'https://lainchan.org/tech/catalog.json',
    ]);
  });

  it('lets 4plebs search every board only in 18+ mode', async () => {
    upstream('https://', noPosts);
    await wild.searchChanArchives('sound blaster', true);
    expect(asked('https://archive.4plebs.org/').map((u) => u.href)).toEqual(['https://archive.4plebs.org/_/api/chan/search/?text=sound%20blaster']);
  });

  it("reads Desuarchive and 4plebs posts: a title, a link to the post and the comment's text", async () => {
    upstream('https://', noPosts);
    upstream('https://desuarchive.org/', () =>
      json(
        fuuka([
          { num: '9001', thread_num: '9000', board: { shortname: 'vr', name: 'Retro Games' }, title: 'Sound Blaster  ', comment_processed: '<span class="greentext">&gt;AWE32</span><br>still the best', comment: 'raw', timestamp: 1700000000 },
          { num: '777', board: { shortname: 'g' }, title: null, comment: comment.repeat(2) },
          { num: '778' },
        ])
      )
    );
    upstream('https://archive.4plebs.org/', () => json(fuuka([{ num: '555', thread_num: '550', board: { shortname: 'pol' }, comment: 'sound blaster' }, { num: '556' }])));
    const results = await wild.searchChanArchives('sound blaster');
    const from = (site: string) => results.filter((r) => r.tags?.[0] === site);

    expect(from('desuarchive')).toEqual([
      {
        title: '[Desuarchive /vr/] Sound Blaster',
        url: 'https://desuarchive.org/vr/thread/9000/#9001',
        snippet: '>AWE32 still the best',
        source: 'chanboards',
        publishedAt: '2023-11-14T22:13:20.000Z',
        isNsfw: false,
        tags: ['desuarchive', '/vr/', 'chan-archive', 'wild-west'],
      },
      expect.objectContaining({ title: `[Desuarchive /g/] ${comment.repeat(2).trim().slice(0, 76)}`, url: 'https://desuarchive.org/g/thread/777/#777', publishedAt: undefined }),
      expect.objectContaining({ title: '[Desuarchive /g/] Archived /g/ Thread #778', url: 'https://desuarchive.org/g/thread/778/#778', snippet: 'Archived /g/ imageboard post #778' }),
    ]);
    expect(from('4plebs')).toEqual([
      expect.objectContaining({ title: '[4plebs /pol/] sound blaster', url: 'https://archive.4plebs.org/pol/thread/550/#555', isNsfw: true }),
      expect.objectContaining({ title: '[4plebs /x/] 4plebs /x/ Thread #556', snippet: 'Archived /x/ thread on 4plebs', isNsfw: false }),
    ]);
  });

  it('keeps at most six Desuarchive posts and five from 4plebs', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ num: String(i + 1), board: { shortname: 'g' }, comment: 'sound blaster' }));
    upstream('https://', noPosts);
    upstream('https://desuarchive.org/', () => json(fuuka(many)));
    upstream('https://archive.4plebs.org/', () => json(fuuka(many)));
    const results = await wild.searchChanArchives('sound blaster');
    expect(results.filter((r) => r.tags?.[0] === 'desuarchive')).toHaveLength(6);
    expect(results.filter((r) => r.tags?.[0] === '4plebs')).toHaveLength(5);
  });

  it("reads Lainchan's /tech/ catalog for threads that mention any word of the query", async () => {
    upstream('https://', noPosts);
    upstream('https://lainchan.org/tech/catalog.json', () =>
      json(
        catalog([
          { no: 42, sub: 'Sound cards', com: 'blaster or not', time: 1700000000, replies: 3 },
          { no: 43, com: 'Blaster beam' },
          { no: 44, sub: 'Nothing to see' },
          ...Array.from({ length: 5 }, (_, i) => ({ no: 50 + i, sub: `sound thread ${i}` })),
        ])
      )
    );
    const lain = (await wild.searchChanArchives('sound blaster')).filter((r) => r.tags?.[0] === 'lainchan');
    expect(lain).toHaveLength(4);
    expect(lain[0]).toEqual({
      title: '[Lainchan /tech/] Sound cards',
      url: 'https://lainchan.org/tech/res/42.html',
      snippet: 'blaster or not · (3 replies on lainchan.org/tech/)',
      source: 'chanboards',
      publishedAt: '2023-11-14T22:13:20.000Z',
      tags: ['lainchan', 'cyberpunk', 'imageboard', 'wild-west'],
    });
    expect(lain[1]).toMatchObject({ title: '[Lainchan /tech/] Blaster beam', url: 'https://lainchan.org/tech/res/43.html' });
  });

  it('skips b4k and Palanq posts with no board or thread', async () => {
    upstream('https://', noPosts);
    upstream('https://arch.b4k.dev/', () => json(fuuka([{ num: '1', thread_num: '1', comment: 'no board' }, { board: { shortname: 'v' }, comment: 'no number' }, { num: '3', board: { shortname: 'v' }, title: 'Sound Blaster on PC' }])));
    const results = await wild.searchChanArchives('sound blaster');
    expect(results.map((r) => r.url)).toEqual(['https://arch.b4k.dev/v/thread/3/#3']);
    expect(results[0]).toMatchObject({ title: '[b4k /v/] Sound Blaster on PC', snippet: 'Archived /v/ thread on b4k', tags: ['b4k', '/v/', 'chan-archive', 'wild-west'] });
  });

  it('keeps what the other archives found when one fails, finds nothing or answers junk', async () => {
    upstream('https://desuarchive.org/', () => json({ error: 'Internal error' }, 500));
    upstream('https://archive.4plebs.org/', () => json({ error: 'No results found.' }));
    upstream('https://lainchan.org/', () => Promise.reject(new TypeError('fetch failed')));
    upstream('https://arch.b4k.dev/', () => page('<html>Just a moment...</html>'));
    upstream('https://archive.palanq.win/', () => json(fuuka([{ num: '8', thread_num: '8', board: { shortname: 'vt' }, comment: 'sound blaster' }])));
    expect((await wild.searchChanArchives('sound blaster')).map((r) => r.url)).toEqual(['https://archive.palanq.win/vt/thread/8/#8']);
  });

  it('asks nothing for an empty query', async () => {
    expect(await wild.searchChanArchives('  ')).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('forums and old-web communities', () => {
  const LOBSTERS = 'https://lobste.rs/search';
  const DDG = 'https://html.duckduckgo.com/html/';

  it('reads Lobsters stories: the link, score, tags and discussion', async () => {
    upstream(DDG, () => page(ddgPage('')));
    upstream(LOBSTERS, () =>
      page(
        lobsters(
          story({ id: 'abc123', title: 'Restoring a Sound Blaster AWE32', href: 'https://retro.example/awe32', score: 42, tags: ['hardware', 'retrocomputing'], comments: '/s/abc123/restoring_sound_blaster_awe32' }) +
            story({ id: 'def456', title: 'Sound Blaster drivers, 30 years on', href: 'https://drivers.example/sb', score: 7, tags: [] }) +
            story({ id: 'ghi789', title: 'Ask: Sound Blaster on Linux', href: '/s/ghi789/ask_sound_blaster', score: 3, tags: ['ask'] }) +
            story({ id: 'jkl012', title: '', href: 'https://empty.example/', score: 1, tags: [] })
        )
      )
    );
    const results = await wild.searchObscureForumsAndWildWest('sound blaster');
    expect(Object.fromEntries(asked(LOBSTERS)[0].searchParams)).toEqual({ q: 'sound blaster', what: 'stories', order: 'relevance' });
    expect(results).toEqual([
      {
        title: 'Restoring a Sound Blaster AWE32',
        url: 'https://retro.example/awe32',
        snippet: 'Lobste.rs discussion (42 points) · tags: hardware, retrocomputing · https://lobste.rs/s/abc123/restoring_sound_blaster_awe32',
        source: 'wild-west',
        points: 42,
        tags: ['lobsters', 'hardware', 'retrocomputing'],
      },
      { title: 'Sound Blaster drivers, 30 years on', url: 'https://drivers.example/sb', snippet: 'Lobste.rs discussion (7 points)', source: 'wild-west', points: 7, tags: ['lobsters'] },
    ]);
  });

  it('finds old forum threads through DuckDuckGo, unwrapping its redirect links', async () => {
    upstream(LOBSTERS, () => page(lobsters('')));
    upstream(DDG, () =>
      page(
        ddgPage(
          ddgResult({ href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.vogons.org%2Fviewtopic.php%3Ft%3D4242&amp;rut=abc123', title: 'AWE32 drivers - VOGONS', snippet: 'Getting the <b>AWE32</b> to work in DOS 6.22 with the right drivers.' }) +
            ddgResult({ href: 'https://www.eevblog.com/forum/repair/sound-blaster/', title: 'Sound Blaster repair', snippet: '' }) +
            ddgResult({ href: '/y.js?ad_provider=bing', title: 'Buy sound cards', snippet: 'Ad' }) +
            ddgResult({ href: '//duckduckgo.com/l/?uddg=%25E0%25A4%25A&amp;rut=def456', title: 'A redirect that does not decode', snippet: 'Broken' })
        )
      )
    );
    const results = await wild.searchObscureForumsAndWildWest('sound blaster');
    const q = asked(DDG)[0].searchParams;
    expect(q.get('q')).toBe('sound blaster (site:vogons.org OR site:eevblog.com OR site:doom9.org OR site:lowendtalk.com OR site:servethehome.com OR site:level1techs.com OR site:textfiles.com OR site:phrack.org OR site:audiokarma.org OR site:overclock.net)');
    // SafeSearch stays at DuckDuckGo's default unless 18+ is on.
    expect(q.get('kp')).toBeNull();
    expect(results).toEqual([
      { title: 'AWE32 drivers - VOGONS', url: 'https://www.vogons.org/viewtopic.php?t=4242', snippet: 'Getting the AWE32 to work in DOS 6.22 with the right drivers.', source: 'wild-west', tags: ['obscure-forum', 'wild-west'] },
      { title: 'Sound Blaster repair', url: 'https://www.eevblog.com/forum/repair/sound-blaster/', snippet: 'Independent practitioner forum / early-web archive thread.', source: 'wild-west', tags: ['obscure-forum', 'wild-west'] },
    ]);
  });

  it('keeps the Lobsters stories when DuckDuckGo fails, and the other way round', async () => {
    const lobstersPage = () => page(lobsters(story({ id: 'a1', title: 'Sound Blaster history', href: 'https://history.example/sb', score: 5, tags: [] })));
    const ddg = () => page(ddgPage(ddgResult({ href: 'https://www.vogons.org/viewtopic.php?t=1', title: 'SB16 IRQ', snippet: 'IRQ 5' })));
    upstream(LOBSTERS, lobstersPage);
    upstream(DDG, () => page('', 'text/html', 503));
    expect((await wild.searchObscureForumsAndWildWest('sound blaster')).map((r) => r.url)).toEqual(['https://history.example/sb']);
    upstream(LOBSTERS, () => Promise.reject(new TypeError('fetch failed')));
    upstream(DDG, ddg);
    expect((await wild.searchObscureForumsAndWildWest('sound blaster')).map((r) => r.url)).toEqual(['https://www.vogons.org/viewtopic.php?t=1']);
  });

  it('asks nothing for an empty query', async () => {
    expect(await wild.searchObscureForumsAndWildWest('')).toEqual([]);
    expect(requests).toEqual([]);
  });
});

// ── Upstreams that hang, fail or answer junk ────────────────────────────────

describe('upstreams that never answer', () => {
  it.each([
    ['Bitmagnet', () => p2p.searchBitmagnetGraphQL('sintel', 'http://bitmagnet.lan:3333/graphql'), 1, 2200],
    ['the public DHT index', () => p2p.searchPublicDhtSwarms('sintel'), 1, 3800],
    ['the Internet Archive', () => p2p.searchInternetArchiveTorrents('sintel'), 1, 3800],
    ['NZBIndex', () => p2p.searchUsenetNzbIndex('sintel'), 1, 3800],
    ['a Torznab indexer', () => p2p.searchTorznabOrNewznab('sintel', 'http://prowlarr.lan:9696/1/api', 'pk'), 1, 2800],
    ['Mastodon', () => fedi.searchActivityPubMastodon('sourdough starter'), 3, 3200],
    ['4chan', () => wild.searchFourChanCatalogs('linux kernel'), 4, 1600],
    ['the chan archives', () => wild.searchChanArchives('linux kernel'), 5, 2000],
    ['Lobsters and DuckDuckGo', () => wild.searchObscureForumsAndWildWest('linux kernel'), 2, 1900],
  ] as const)('gives up on %s at its deadline, with no results', async (_name, search, calls, deadline) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    upstream('', silent);
    let settled = false;
    const pending = (search() as Promise<RawSearchResult[]>).then((r) => {
      settled = true;
      return r;
    });
    await reached(calls);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([]);
    expect(requests).toHaveLength(calls);
    expect(requests.every((r) => r.init.signal?.aborted)).toBe(true);
  });
});

describe('upstreams that cannot be reached', () => {
  it.each([
    ['refused', () => Promise.reject(new TypeError('fetch failed'))],
    ['aborted', () => Promise.reject(new DOMException('This operation was aborted', 'AbortError'))],
  ])('returns no results, and never throws, when every request is %s', async (_how, fail) => {
    upstream('', fail);
    const matrix = await freshFediverse();
    const searches = [
      p2p.executeP2PAndUsenetSearch('sintel', { bitmagnetUrl: 'http://bitmagnet.lan/graphql', torznabUrl: 'http://prowlarr.lan/api', newznabUrl: 'http://hydra.lan/api', nzbLifeApiKey: 'k' }, true),
      matrix.executeFediverseSearch('rust borrow checker', true),
      wild.searchFourChanCatalogs('linux kernel', true),
      wild.searchChanArchives('linux kernel', true),
      wild.searchObscureForumsAndWildWest('linux kernel'),
    ];
    const [p2pResults, fediverse, ...rest] = await Promise.all(searches);
    expect(p2pResults).toEqual([]);
    expect(fediverse).toEqual([]);
    expect(rest).toEqual([[], [], []]);
  });
});

describe('junk from upstreams', () => {
  /** A canned answer with parts swapped for junk: wrong types, nasty text, missing fields. Fields in `keep` stay as they are. */
  function mangle(r: Rng, value: unknown, keep: ReadonlySet<string> = new Set()): unknown {
    const roll = r();
    if (roll < 0.06) return undefined;
    if (roll < 0.14) return pick(r, [null, 0, -1, 1e21, true, '', [], {}, 'NaN'] as unknown[]);
    if (roll < 0.2) return r() < 0.5 ? text(r, 6) : anyString(r, 24);
    if (Array.isArray(value)) return value.map((v) => mangle(r, v, keep));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keep.has(k) ? v : mangle(r, v, keep)]));
    return value;
  }

  /** A canned page cut short, or with junk spliced in. */
  function mangleMarkup(r: Rng, markup: string): string {
    const at = int(r, 0, markup.length);
    return pick(r, [markup.slice(0, at), `${markup.slice(0, at)}${html(r, 2)}${markup.slice(at)}`, html(r), anyString(r, 200)]);
  }

  const upstreams: { name: string; answer: (r: Rng) => string; search: (matrix: typeof fedi) => Promise<RawSearchResult[]> }[] = [
    { name: 'Bitmagnet', answer: (r) => JSON.stringify(mangle(r, bitmagnet())), search: () => p2p.searchBitmagnetGraphQL('sintel', 'http://bitmagnet.lan/graphql') },
    { name: 'apibay', answer: (r) => JSON.stringify(mangle(r, apibay())), search: () => p2p.searchPublicDhtSwarms('debian', true) },
    { name: 'the Internet Archive', answer: (r) => JSON.stringify(mangle(r, archive())), search: () => p2p.searchInternetArchiveTorrents('debian') },
    {
      name: 'NZBIndex',
      answer: (r) => JSON.stringify(mangle(r, nzbindex([{ id: 'a', name: 'ubuntu.iso yEnc', poster: 'p', posted: 1700000000, size: 6203355136, fileCount: 7, complete: true, groups: ['alt.binaries.linux'] }]))),
      search: () => p2p.searchUsenetNzbIndex('ubuntu', true),
    },
    {
      name: 'Torznab',
      answer: (r) => mangleMarkup(r, torznab(torznabItem({ title: 'Debian 12.5 DVD', link: 'http://prowlarr.lan/dl?a=1&amp;b=2', size: 3992977408, seeders: 120, peers: 135, infohash: DEBIAN }))),
      search: () => p2p.searchTorznabOrNewznab('debian', 'http://prowlarr.lan/api', 'pk'),
    },
    {
      name: 'Bluesky',
      answer: (r) =>
        JSON.stringify(
          mangle(r, {
            posts: [bskyPost({ record: { text: 'The rust borrow checker, explained' }, embed: { external: { uri: 'https://blog.example/b', title: 'Rust borrow checker' } } })],
            actors: [{ did: 'did:plc:r', handle: 'rust-lang.org', displayName: 'Rust borrow checker fans', description: 'rust borrow checker' }],
          })
        ),
      search: () => fedi.searchAtProtocol('rust borrow checker'),
    },
    {
      name: 'Mastodon',
      answer: (r) => JSON.stringify(mangle(r, [status({ content: '<p>sourdough starter</p>', card: { url: 'https://bread.example/', title: 'Sourdough starter' } })])),
      search: () => fedi.searchActivityPubMastodon('sourdough starter', true),
    },
    { name: 'Matrix', answer: (r) => JSON.stringify(mangle(r, { chunk: [room({ canonical_alias: '#rust:matrix.org', name: 'Rust', topic: 'rust' })] })), search: (matrix) => matrix.searchMatrixPublicRooms('rust') },
    {
      name: '4chan',
      answer: (r) => JSON.stringify(mangle(r, catalog([{ no: 1, sub: 'Linux kernel general', com: 'linux <br>kernel &gt; all', time: 1700000000, replies: 3, images: 1 }]))),
      search: () => wild.searchFourChanCatalogs('linux kernel', true),
    },
    {
      name: 'the chan archives',
      answer: (r) => JSON.stringify(mangle(r, fuuka([{ num: '2', thread_num: '1', board: { shortname: 'g' }, title: 'Linux kernel', comment: 'linux kernel', timestamp: 1700000000 }]))),
      search: () => wild.searchChanArchives('linux kernel', true),
    },
    {
      name: 'Lobsters and DuckDuckGo',
      answer: (r) =>
        mangleMarkup(
          r,
          lobsters(story({ id: 'a', title: 'Linux kernel news', href: 'https://lwn.example/k', score: 4, tags: ['linux'], comments: '/s/a/k' })) +
            ddgPage(ddgResult({ href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.vogons.org%2Ft%3D1', title: 'Linux kernel on a 486', snippet: 'kernel' }))
        ),
      search: () => wild.searchObscureForumsAndWildWest('linux kernel'),
    },
  ];

  it('never makes a search throw, and every result keeps the shape the ranker needs', async () => {
    const matrix = await freshFediverse();
    // The Matrix directory is cached for five minutes; each case is ten minutes later, so each one is read.
    vi.useFakeTimers({ toFake: ['Date'] });
    const failures = new Map<string, string>();
    for (let i = 0; i < RUNS; i++) {
      const seed = BASE_SEED + i;
      const r = rng(seed);
      const status = pick(r, [200, 200, 200, 200, 404, 500]);
      vi.setSystemTime(Date.UTC(2030, 0, 1) + i * 10 * 60_000);
      for (const u of upstreams) {
        const body = u.answer(r);
        if (failures.has(u.name)) continue;
        upstream('', () => new Response(body, { status }));
        try {
          const results = await u.search(matrix);
          expect(Array.isArray(results)).toBe(true);
          for (const x of results) {
            expect(typeof x.title, 'title').toBe('string');
            expect(typeof x.url, 'url').toBe('string');
            expect(typeof x.snippet, 'snippet').toBe('string');
            expect(typeof x.source, 'source').toBe('string');
          }
        } catch (e) {
          failures.set(
            u.name,
            `${u.name} failed for seed ${seed} (replay: GLOGG_FUZZ_SEED=${seed} GLOGG_FUZZ_RUNS=1)\nanswer (HTTP ${status}): ${body.slice(0, 600)}\n${e instanceof Error ? e.message : e}`
          );
        }
      }
    }
    expect([...failures.values()].join('\n\n')).toBe('');
  }, TIMEOUT);
});

// ── Instant answers ─────────────────────────────────────────────────────────

describe('instant answers', () => {
  const WIKI = 'https://en.wikipedia.org/w/api.php';
  const DDG = 'https://api.duckduckgo.com/';
  const SE_SEARCH = 'https://api.stackexchange.com/2.3/search/advanced';

  const wikipedia = (pages: Record<string, unknown>[]) =>
    json({ batchcomplete: '', query: { pages: Object.fromEntries(pages.map((p, i) => [String(1000 + i), { pageid: 1000 + i, ns: 0, ...p }])) } });
  const ddg = (o: Record<string, unknown> = {}) =>
    json({ Heading: '', AbstractText: '', AbstractURL: '', AbstractSource: '', Answer: '', AnswerType: '', Definition: '', DefinitionURL: '', Infobox: '', RelatedTopics: [], ...o });
  const stack = (items: unknown[]) => json({ items, has_more: false, quota_max: 300, quota_remaining: 297 });

  /** Every lookup answers "nothing" unless a test says otherwise. */
  function nothingFound() {
    upstream(WIKI, () => json({ batchcomplete: '' }));
    upstream(DDG, () => ddg());
    upstream('https://api.stackexchange.com/', () => stack([]));
  }

  beforeEach(() => answers.clearInstantAnswerCache());

  const KAZAKHSTAN =
    'Kazakhstan, officially the Republic of Kazakhstan, is a landlocked country mostly in Central Asia. It borders Russia to the north and west. Its capital is Astana, while the largest city is Almaty. Kazakhstan is the largest landlocked country in the world.';

  it("answers a fact from Wikipedia's extract, leading with the sentence that holds what was asked", async () => {
    nothingFound();
    upstream(WIKI, () =>
      wikipedia([
        { title: 'Kazakh', index: 2, extract: 'Kazakh or Qazaq may refer to: the Kazakh people, the Kazakh language, or the Kazakh Khanate.' },
        { title: 'Kazakhstan', index: 1, extract: KAZAKHSTAN },
        { title: 'Kaz', index: 3, extract: 'Too short to be an answer.' },
        { title: 'List of countries by area', index: 4, extract: "This is a list of the world's countries and their dependencies, ranked by total area." },
      ])
    );
    const surfaced = diversifyAndRankResults(
      [
        {
          title: 'Astana, the capital of Kazakhstan since 1997',
          url: 'https://travel.example/astana-capital-of-kazakhstan',
          snippet: 'Astana became the capital of Kazakhstan in 1997, when the government moved north from Almaty to the steppe city on the Ishim river.',
          source: 'web',
        },
      ],
      { lens: 'all' },
      'what is the capital of kazakhstan'
    ).surfaced;
    const answer = await answers.buildInstantAnswer('what is the capital of kazakhstan', surfaced);

    expect(asked(WIKI).map((u) => u.searchParams.get('gsrsearch'))).toEqual(['capital kazakhstan', 'kazakhstan']);
    expect(Object.fromEntries(asked(WIKI)[0].searchParams)).toMatchObject({ action: 'query', generator: 'search', prop: 'extracts', exintro: '1', explaintext: '1', format: 'json' });
    expect(answer).toMatchObject({
      kind: 'direct-fact',
      title: 'Kazakhstan',
      subtitle: 'capital of kazakhstan',
      directAnswer:
        'Its capital is Astana, while the largest city is Almaty. Kazakhstan, officially the Republic of Kazakhstan, is a landlocked country mostly in Central Asia. It borders Russia to the north and west.',
      confidence: 'verified',
      primarySourceUrl: 'https://en.wikipedia.org/wiki/Kazakhstan',
      primarySourceTitle: 'Kazakhstan',
      primarySourceDomain: 'en.wikipedia.org',
    });
    expect(answer?.keyFacts).toBeUndefined();
    expect(answer?.citations).toEqual([
      { index: 1, title: 'Kazakhstan', url: 'https://en.wikipedia.org/wiki/Kazakhstan', domain: 'en.wikipedia.org', source: 'wikipedia' },
      { index: 2, title: surfaced[0].title, url: surfaced[0].url, domain: 'travel.example', source: 'web' },
    ]);
    expect(answer?.takeaways?.map((t) => t.text)).toEqual([surfaced[0].snippet]);
  });

  it("falls back to DuckDuckGo's abstract and infobox when Wikipedia has nothing", async () => {
    nothingFound();
    upstream(DDG, () =>
      ddg({
        Heading: 'Rust (programming language)',
        AbstractText: 'Rust is a general-purpose <b>programming language</b> emphasizing performance, type safety, and concurrency.',
        AbstractURL: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
        AbstractSource: 'Wikipedia',
        Infobox: {
          content: [
            { data_type: 'string', label: 'Paradigms', value: 'Multi-paradigm: concurrent, functional, generic, imperative', wiki_order: 0 },
            { data_type: 'string', label: 'Designed by', value: 'Graydon Hoare', wiki_order: 1 },
            { data_type: 'twitter_profile', label: 'Twitter profile', value: 'rustlang' },
            { data_type: 'string', label: 'Description', value: 'x'.repeat(95) },
            { data_type: 'string', label: 'Empty', value: '' },
            { data_type: 'string', label: 'Typing discipline', value: { list: ['static', 'strong'] } },
            { data_type: 'string', label: 'First appeared', value: 'July 7, 2010' },
            { data_type: 'string', label: 'Stable release', value: '1.91.0' },
            { data_type: 'string', label: 'License', value: 'MIT and Apache 2.0' },
            { data_type: 'string', label: 'Filename extensions', value: '.rs, .rlib' },
            { data_type: 'string', label: 'Website', value: 'rust-lang.org' },
          ],
          meta: [],
        },
      })
    );
    const answer = await answers.buildInstantAnswer('rust programming language', []);
    expect(asked(DDG).map((u) => Object.fromEntries(u.searchParams))).toEqual([{ q: 'rust programming language', format: 'json', no_html: '1', skip_disambig: '1' }]);
    expect(answer).toMatchObject({
      kind: 'direct-fact',
      title: 'Rust (programming language)',
      directAnswer: 'Rust is a general-purpose programming language emphasizing performance, type safety, and concurrency.',
      primarySourceUrl: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
      primarySourceDomain: 'en.wikipedia.org',
      keyFacts: [
        { label: 'Paradigms', value: 'Multi-paradigm: concurrent, functional, generic, imperative' },
        { label: 'Designed by', value: 'Graydon Hoare' },
        { label: 'First appeared', value: 'July 7, 2010' },
        { label: 'Stable release', value: '1.91.0' },
        { label: 'License', value: 'MIT and Apache 2.0' },
        { label: 'Filename extensions', value: '.rs, .rlib' },
      ],
    });
  });

  it('asks DuckDuckGo about the subject when the whole question finds nothing, and links its definition', async () => {
    nothingFound();
    upstream(DDG, (url) =>
      url.searchParams.get('q') === 'serendipity'
        ? ddg({
            Heading: 'Serendipity',
            Definition: 'serendipity definition: The occurrence and development of events by chance in a happy way.',
            DefinitionURL: 'https://www.merriam-webster.com/dictionary/serendipity',
          })
        : ddg({ AbstractText: 'Too short.' })
    );
    const answer = await answers.buildInstantAnswer('define serendipity', []);
    expect(asked(DDG).map((u) => u.searchParams.get('q'))).toEqual(['define serendipity', 'serendipity']);
    expect(answer).toMatchObject({
      kind: 'direct-fact',
      title: 'Serendipity',
      directAnswer: 'serendipity definition: The occurrence and development of events by chance in a happy way.',
      primarySourceUrl: 'https://www.merriam-webster.com/dictionary/serendipity',
      primarySourceDomain: 'merriam-webster.com',
    });
  });

  it("trusts DuckDuckGo's direct answer even when it doesn't name the subject", async () => {
    nothingFound();
    upstream(DDG, () => ddg({ Answer: '299,792,458 metres per second', AnswerType: 'speed' }));
    const answer = await answers.buildInstantAnswer('what is the speed of light', []);
    expect(answer).toMatchObject({ kind: 'direct-fact', subtitle: 'speed of light', directAnswer: '299,792,458 metres per second' });
  });

  const GIT_QUESTION = {
    question_id: 927358,
    title: 'How do I undo the most recent local commits in Git?',
    link: 'https://stackoverflow.com/questions/927358/how-do-i-undo-the-most-recent-local-commits-in-git',
    score: 26843,
    accepted_answer_id: 927386,
    answer_count: 105,
  };
  const GIT_ANSWER = {
    answer_id: 927386,
    score: 30120,
    is_accepted: true,
    body: '<p>Undo the last commit but keep its changes staged, by moving HEAD back one commit:</p>\n<pre><code>git reset --soft HEAD~1\n</code></pre>\n<p>Use <code>--hard</code> instead to throw the changes away, which cannot be undone easily.</p>\n<ul><li>ok</li></ul>',
  };

  it('answers a how-to with the top Stack Overflow answer and its code, sending the key', async () => {
    nothingFound();
    upstream(SE_SEARCH, () => stack([{ ...GIT_QUESTION, question_id: 111, title: 'Undo git commit &quot;by accident&quot;', score: 1 }, GIT_QUESTION]));
    upstream('https://api.stackexchange.com/2.3/questions/927358/answers', () => stack([GIT_ANSWER]));
    const q = 'how to undo the last git commit';
    const answer = await answers.buildInstantAnswer(q, [], answers.prefetchInstantAnswer(q, { stackexchangeKey: 'se key' }));

    const [search, top] = asked('https://api.stackexchange.com/');
    expect(Object.fromEntries(search.searchParams)).toEqual({ order: 'desc', sort: 'relevance', accepted: 'True', q: 'undo last git commit', site: 'stackoverflow', pagesize: '3', key: 'se key' });
    expect(top.pathname).toBe('/2.3/questions/927358/answers');
    expect(Object.fromEntries(top.searchParams)).toEqual({ order: 'desc', sort: 'votes', site: 'stackoverflow', filter: 'withbody', pagesize: '1', key: 'se key' });
    expect(answer).toEqual({
      kind: 'technical-answer',
      title: GIT_QUESTION.title,
      subtitle: 'Stack Overflow · 30120 votes',
      directAnswer: 'Undo the last commit but keep its changes staged, by moving HEAD back one commit: Use --hard instead to throw the changes away, which cannot be undone easily.',
      confidence: 'verified',
      codeBlock: 'git reset --soft HEAD~1',
      takeaways: [],
      primarySourceUrl: GIT_QUESTION.link,
      primarySourceTitle: GIT_QUESTION.title,
      primarySourceDomain: 'stackoverflow.com',
      citations: [{ index: 1, title: GIT_QUESTION.title, url: GIT_QUESTION.link, domain: 'stackoverflow.com', source: 'stackexchange' }],
    });
  });

  it('asks Unix & Linux about system questions, and puts the Wikipedia summary before a how-to answer', async () => {
    nothingFound();
    upstream(WIKI, () =>
      wikipedia([
        {
          title: 'Btrfs',
          index: 1,
          extract: 'Btrfs is a copy-on-write file system for Linux. Each subvolume can be mounted on its own with the subvol mount option. It was created by Chris Mason in 2007.',
        },
      ])
    );
    upstream(SE_SEARCH, () =>
      stack([{ question_id: 2222, title: 'How to mount a btrfs subvolume at boot?', link: 'https://unix.stackexchange.com/questions/2222/how-to-mount-a-btrfs-subvolume', score: 12 }])
    );
    upstream('https://api.stackexchange.com/2.3/questions/2222/answers', () =>
      stack([{ answer_id: 3, score: 45, is_accepted: true, body: '<p>Pass the subvolume to mount with the subvol option, by name or by id:</p><pre>mount -o subvol=@home /dev/sda2 /home</pre>' }])
    );
    const surfaced = diversifyAndRankResults(
      [
        {
          title: 'Mounting btrfs subvolumes from fstab',
          url: 'https://wiki.example/btrfs-subvolumes',
          snippet: 'To mount a btrfs subvolume at boot, add an fstab entry with the subvol option naming the subvolume, then check it with mount.',
          source: 'web',
        },
      ],
      { lens: 'all' },
      'how to mount a btrfs subvolume'
    ).surfaced;
    const answer = await answers.buildInstantAnswer('how to mount a btrfs subvolume', surfaced);
    expect(asked(SE_SEARCH)[0].searchParams.get('site')).toBe('unix');
    expect(answer?.citations).toEqual([
      { index: 1, title: 'How to mount a btrfs subvolume at boot?', url: 'https://unix.stackexchange.com/questions/2222/how-to-mount-a-btrfs-subvolume', domain: 'unix.stackexchange.com', source: 'stackexchange' },
      { index: 2, title: surfaced[0].title, url: surfaced[0].url, domain: 'wiki.example', source: 'web' },
    ]);
    expect(answer?.takeaways?.map((t) => t.text)).toEqual([surfaced[0].snippet]);
    expect(answer).toMatchObject({
      kind: 'technical-answer',
      subtitle: 'Unix & Linux StackExchange · 45 votes',
      directAnswer:
        'Btrfs is a copy-on-write file system for Linux. Each subvolume can be mounted on its own with the subvol mount option. — Pass the subvolume to mount with the subvol option, by name or by id:',
      codeBlock: 'mount -o subvol=@home /dev/sda2 /home',
      primarySourceDomain: 'unix.stackexchange.com',
    });
  });

  it("answers a what-is question from Wikipedia, keeping Stack Overflow's code", async () => {
    nothingFound();
    upstream(WIKI, () =>
      wikipedia([{ title: 'Git rebase', index: 1, extract: 'Git rebase moves or combines a sequence of commits to a new base commit. It rewrites the project history by creating new commits.' }])
    );
    upstream(SE_SEARCH, () => stack([{ question_id: 333, title: 'What is git rebase and when should I use git rebase?', link: 'https://stackoverflow.com/questions/333/what-is-git-rebase', score: 50 }]));
    upstream('https://api.stackexchange.com/2.3/questions/333/answers', () =>
      stack([{ answer_id: 4, score: 80, is_accepted: true, body: '<p>Rebase replays the commits of your branch on top of another branch, for a linear history:</p><pre><code>git rebase main</code></pre>' }])
    );
    const answer = await answers.buildInstantAnswer('what is git rebase', []);
    expect(answer).toMatchObject({
      kind: 'direct-fact',
      title: 'Git rebase',
      directAnswer: 'Git rebase moves or combines a sequence of commits to a new base commit. It rewrites the project history by creating new commits.',
      codeBlock: 'git rebase main',
      primarySourceUrl: 'https://en.wikipedia.org/wiki/Git_rebase',
    });
    expect(answer?.citations.map((c) => c.source)).toEqual(['wikipedia']);
  });

  it('passes over Stack Exchange questions that are off topic or barely voted, and answers too short to help', async () => {
    nothingFound();
    upstream(SE_SEARCH, () => stack([{ ...GIT_QUESTION, title: 'Best pizza in Naples?', score: 500 }, { ...GIT_QUESTION, score: 2 }]));
    expect(await answers.buildInstantAnswer('how to undo the last git commit', [])).toBeUndefined();
    expect(asked('https://api.stackexchange.com/2.3/questions/')).toEqual([]);

    answers.clearInstantAnswerCache();
    upstream(SE_SEARCH, () => stack([GIT_QUESTION]));
    upstream('https://api.stackexchange.com/2.3/questions/927358/answers', () => stack([{ ...GIT_ANSWER, body: '<p>Use git reset.</p><pre><code>git reset HEAD~1</code></pre>' }]));
    expect(await answers.buildInstantAnswer('how to undo the last git commit', [])).toBeUndefined();
  });

  it('gives no answer when every lookup fails', async () => {
    upstream('', () => Promise.reject(new TypeError('fetch failed')));
    expect(await answers.buildInstantAnswer('what is the capital of kazakhstan', [])).toBeUndefined();
    expect(asked(WIKI)).toHaveLength(2);
    expect(asked(DDG)).toHaveLength(2);
  });

  it('works out a calculation itself, asking nothing', async () => {
    expect(answers.prefetchInstantAnswer('15% of 80')).toBeNull();
    expect(await answers.buildInstantAnswer('15% of 80', [])).toMatchObject({ kind: 'computation', title: '12' });
    expect(requests).toEqual([]);
  });
});

describe('found by these tests, and fixed', () => {
  it('gives a Mastodon post with no url of its own a link the ranker can take', async () => {
    upstream('https://mastodon.social/api/v1/timelines/tag/sourdough', () =>
      json([status({ url: null, uri: 'https://remote.example/objects/1', account: { acct: 'baker@remote.example' }, content: '<p>My sourdough starter finally doubled overnight</p>' })])
    );
    const results = await fedi.searchActivityPubMastodon('sourdough starter');
    for (const r of results) expect(typeof r.url).toBe('string');
    expect(() => diversifyAndRankResults(results, { lens: 'all' }, 'sourdough starter')).not.toThrow();
  });

  it('adds /pol/ and /b/ to the 4chan search in 18+ mode', async () => {
    upstream('https://a.4cdn.org/', () => json(catalog([])));
    await wild.searchFourChanCatalogs('linux kernel', true);
    expect(requests.map((r) => r.url.pathname.split('/')[1])).toEqual(expect.arrayContaining(['pol', 'b']));
  });

  it('keeps the Bluesky posts it found when the account search fails', async () => {
    upstream('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts', () =>
      json({ posts: [bskyPost({ cid: 'bafy-a', record: { text: 'How the Rust borrow checker reasons about lifetimes' } })] })
    );
    upstream('https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors', () => Promise.reject(new TypeError('fetch failed')));
    expect((await fedi.searchAtProtocol('rust borrow checker')).map((r) => r.id)).toEqual(['atproto-post-bafy-a']);
  });

  it('keeps the Bluesky posts it found when the account search times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    upstream('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts', () =>
      json({ posts: [bskyPost({ cid: 'bafy-a', record: { text: 'How the Rust borrow checker reasons about lifetimes' } })] })
    );
    upstream('https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors', silent);
    const pending = fedi.searchAtProtocol('rust borrow checker');
    await reached(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).map((r) => r.id)).toEqual(['atproto-post-bafy-a']);
  });

  it('strips the quotes around a Usenet subject along with yEnc', async () => {
    upstream('https://nzbindex.com/api/search', () =>
      json(nzbindex([{ id: 'q1', name: '"debian-12.5.0-amd64-netinst.iso" yEnc', size: 658505728, complete: true, groups: ['alt.binaries.linux'] }]))
    );
    const [r] = await p2p.searchUsenetNzbIndex('debian');
    expect(r.title).toBe('[NZB] debian-12.5.0-amd64-netinst.iso');
    expect(r.p2p?.nzbUrl).toBe('https://nzbindex.com/download/q1/debian-12.5.0-amd64-netinst.iso.nzb');
  });

  it("counts Torznab's peers as seeders plus leechers", async () => {
    upstream('http://prowlarr.lan:9696/', () =>
      page(torznab(torznabItem({ title: 'Debian 12.5 DVD', link: 'http://prowlarr.lan:9696/dl/1', size: 3992977408, seeders: 120, peers: 135, infohash: DEBIAN })), 'application/rss+xml')
    );
    const [r] = await p2p.searchTorznabOrNewznab('debian', 'http://prowlarr.lan:9696/1/api', 'pk');
    expect(r.p2p?.leechers).toBe(15);
  });

  it('turns DuckDuckGo SafeSearch off for the old-forum search only in 18+ mode', async () => {
    upstream('https://lobste.rs/search', () => page(lobsters('')));
    upstream('https://html.duckduckgo.com/html/', () => page(ddgPage('')));
    await wild.searchObscureForumsAndWildWest('sound blaster', true);
    expect(asked('https://html.duckduckgo.com/html/')[0].searchParams.get('kp')).toBe('-2');
  });

  it("reads each Matrix homeserver's own room directory", async () => {
    const matrix = await freshFediverse();
    upstream('https://matrix.org/_matrix/client/v3/publicRooms', () => json({ chunk: [room({ room_id: '!a:matrix.org', canonical_alias: '#rust:matrix.org', name: 'Rust' })] }));
    upstream('https://matrix.example/_matrix/client/v3/publicRooms', () => json({ chunk: [room({ room_id: '!b:matrix.example', canonical_alias: '#rust:matrix.example', name: 'Rust' })] }));
    await matrix.searchMatrixPublicRooms('rust');
    const other = await matrix.searchMatrixPublicRooms('rust', 'https://matrix.example');
    expect(other.map((r) => r.fediverse?.cidOrId)).toEqual(['!b:matrix.example']);
  });

  it('keeps the room directories of only the last few homeservers', async () => {
    const matrix = await freshFediverse();
    upstream('https://', (url) => json({ chunk: [room({ room_id: `!r:${url.hostname}`, canonical_alias: `#rust:${url.hostname}`, name: 'Rust' })] }));
    const servers = Array.from({ length: 9 }, (_, i) => `https://hs${i}.example`);
    for (const hs of servers) await matrix.searchMatrixPublicRooms('rust', hs);
    await matrix.searchMatrixPublicRooms('rust', servers[8]);
    await matrix.searchMatrixPublicRooms('rust', servers[0]);
    expect(asked('https://hs8.example/')).toHaveLength(1);
    expect(asked('https://hs0.example/')).toHaveLength(2);
  });
  it('numbers each takeaway of an instant answer by the citation it quotes', async () => {
    upstream('https://en.wikipedia.org/w/api.php', () =>
      json({
        query: {
          pages: {
            1: {
              pageid: 1,
              title: 'Kazakhstan',
              index: 1,
              extract:
                'Kazakhstan, officially the Republic of Kazakhstan, is a landlocked country mostly in Central Asia. It borders Russia to the north and west. Its capital is Astana, while the largest city is Almaty.',
            },
          },
        },
      })
    );
    upstream('https://api.duckduckgo.com/', () => json({}));
    upstream('https://api.stackexchange.com/', () => json({ items: [] }));
    const surfaced = diversifyAndRankResults(
      [
        {
          title: 'Astana, the capital of Kazakhstan since 1997',
          url: 'https://travel.example/astana-capital-of-kazakhstan',
          snippet: 'Astana became the capital of Kazakhstan in 1997, when the government moved north from Almaty to the steppe city on the Ishim river.',
          source: 'web',
        },
      ],
      { lens: 'all' },
      'what is the capital of kazakhstan'
    ).surfaced;
    const answer = await answers.buildInstantAnswer('what is the capital of kazakhstan', surfaced);
    const cited = answer?.citations.find((c) => c.index === answer.takeaways?.[0].citationIndex);
    expect(cited?.url).toBe('https://travel.example/astana-capital-of-kazakhstan');
  });
});
