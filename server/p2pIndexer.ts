import * as cheerio from 'cheerio';
import {
  analyzeQueryIntent,
  assessP2PHealth,
  buildMagnetUri,
  clip,
  CustomEndpointsConfig,
  formatBytes,
  isValidInfoHash,
  RawSearchResult,
} from '../src/core/index.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GloggMetaIndexer/0.3 (+https://github.com/WCKDai/glogg)';

async function fetchFast(
  url: string,
  timeoutMs = 3800,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/html, application/xml;q=0.9, */*;q=0.8',
        ...(init?.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1. Native Bitmagnet GraphQL Client (connects to local/remote bitmagnet-io/bitmagnet instance)
 */
export async function searchBitmagnetGraphQL(
  query: string,
  endpointUrl = process.env.BITMAGNET_URL || 'http://localhost:3333/graphql'
): Promise<RawSearchResult[]> {
  try {
    const gqlQuery = `
      query SearchTorrents($queryString: String!) {
        torrentContent {
          search(query: { queryString: $queryString, limit: 15 }) {
            items {
              infoHash
              title
              seeders
              leechers
              publishedAt
              contentType
              torrent {
                name
                size
                filesCount
              }
            }
          }
        }
      }
    `;
    // Bitmagnet's own address works too (BITMAGNET_URL=http://localhost:3333): its GraphQL is at /graphql.
    const graphql = /^https?:\/\/[^/]+\/?$/i.test(endpointUrl) ? `${endpointUrl.replace(/\/$/, '')}/graphql` : endpointUrl;
    const res = await fetchFast(graphql, 2200, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: gqlQuery,
        variables: { queryString: query },
      }),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      data?: {
        torrentContent?: {
          search?: {
            items?: Array<{
              infoHash: string;
              title: string;
              seeders?: number;
              leechers?: number;
              publishedAt?: string;
              contentType?: string;
              torrent?: {
                name?: string;
                size?: number;
                filesCount?: number;
              };
            }>;
          };
        };
      };
    };

    const items = body.data?.torrentContent?.search?.items ?? [];
    return items
      .filter((item) => isValidInfoHash(item.infoHash))
      .map((item) => {
        const title = item.title || item.torrent?.name || item.infoHash;
        const sizeBytes = item.torrent?.size;
        const magnetUri = buildMagnetUri(item.infoHash, title);
        const healthVerdict = assessP2PHealth({
          title,
          sizeBytes,
          seeders: item.seeders,
          leechers: item.leechers,
          protocol: 'bittorrent-dht',
        });

        return {
          id: `bitmagnet-${item.infoHash}`,
          title,
          url: magnetUri,
          snippet: `Bitmagnet DHT Swarm · Hash: ${item.infoHash.slice(0, 12)}… · Size: ${formatBytes(
            sizeBytes
          )} · Type: ${item.contentType || 'DHT'}`,
          source: 'bitmagnet-dht' as const,
          publishedAt: item.publishedAt,
          p2p: {
            protocol: 'bittorrent-dht' as const,
            infoHash: item.infoHash.toLowerCase(),
            magnetUri,
            sizeBytes,
            sizeFormatted: formatBytes(sizeBytes),
            seeders: item.seeders ?? 0,
            leechers: item.leechers ?? 0,
            filesCount: item.torrent?.filesCount,
            indexerName: 'Bitmagnet DHT Node',
            categoryLabel: item.contentType || 'DHT Swarm',
            healthVerdict,
          },
        };
      });
  } catch {
    return [];
  }
}

/**
 * 2. Live Public DHT Swarm Index (APIBay / Public BitTorrent DHT Tracker Index)
 */
export async function searchPublicDhtSwarms(
  query: string,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  try {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
    const res = await fetchFast(url, 3800);
    if (!res.ok) return [];
    const items = (await res.json()) as Array<{
      id: string;
      name: string;
      info_hash: string;
      leechers: string;
      seeders: string;
      num_files: string;
      size: string;
      username?: string;
      added: string;
      category: string;
    }>;

    if (!Array.isArray(items)) return [];

    const results: RawSearchResult[] = [];
    for (const item of items.slice(0, 16)) {
      if (
        !item.info_hash ||
        /^0+$/.test(item.info_hash) ||
        item.name === 'No results returned' ||
        !isValidInfoHash(item.info_hash)
      ) {
        continue;
      }

      const catCode = item.category || '';
      const isAdultCat = catCode.startsWith('5');
      if (isAdultCat && !uncensoredMode) {
        continue;
      }

      const sizeBytes = Number(item.size) || 0;
      const seeders = Number(item.seeders) || 0;
      const leechers = Number(item.leechers) || 0;
      const filesCount = Number(item.num_files) || undefined;
      const addedTs = Number(item.added);
      const publishedAt =
        addedTs > 0 ? new Date(addedTs * 1000).toISOString() : undefined;

      const infoHash = item.info_hash.toLowerCase();
      const magnetUri = buildMagnetUri(infoHash, item.name);
      const healthVerdict = assessP2PHealth({
        title: item.name,
        sizeBytes,
        seeders,
        leechers,
        protocol: 'bittorrent-dht',
      });

      if (healthVerdict === 'suspect-spam') continue;

      let categoryLabel = 'DHT Swarm';
      if (catCode.startsWith('1')) categoryLabel = 'Audio / FLAC';
      else if (catCode.startsWith('2')) categoryLabel = 'Video / Media';
      else if (catCode.startsWith('3')) categoryLabel = 'Software / ISO';
      else if (catCode.startsWith('5')) categoryLabel = '18+ / Adult XXX';
      else if (catCode.startsWith('6')) categoryLabel = 'Books / Zines';

      results.push({
        id: `dht-${infoHash}`,
        title: item.name,
        url: magnetUri,
        snippet: `BitTorrent DHT Swarm (btih:${infoHash.slice(0, 16)}…) · ${formatBytes(
          sizeBytes
        )} · ${seeders} seeders / ${leechers} leechers · Uploader: ${item.username || 'anon'}`,
        source: 'bitmagnet-dht',
        publishedAt,
        author: item.username,
        points: seeders,
        isNsfw: isAdultCat,
        p2p: {
          protocol: 'bittorrent-dht',
          infoHash,
          magnetUri,
          sizeBytes,
          sizeFormatted: formatBytes(sizeBytes),
          seeders,
          leechers,
          filesCount,
          indexerName: 'DHT Public Swarm',
          categoryLabel,
          isAdultNsfw: isAdultCat,
          healthVerdict,
        },
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 3. Internet Archive Verified BitTorrent Swarms
 */
export async function searchInternetArchiveTorrents(query: string): Promise<RawSearchResult[]> {
  try {
    const terms = query
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9._-]/g, ''))
      .filter(Boolean);
    if (terms.length === 0) return [];
    const qParam = `${terms.map((t) => `title:(${t})`).join(' AND ')} AND format:BitTorrent`;
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(
      qParam
    )}&fl[]=identifier,title,description,item_size,btih,publicdate,downloads,mediatype&sort[]=downloads+desc&rows=8&output=json`;
    const res = await fetchFast(url, 3800);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      response?: {
        docs?: Array<{
          identifier: string;
          title?: string;
          description?: string | string[];
          item_size?: number;
          btih?: string | string[];
          publicdate?: string;
          downloads?: number;
          mediatype?: string;
        }>;
      };
    };

    const results: RawSearchResult[] = [];
    for (const doc of data.response?.docs ?? []) {
      if (!doc.identifier || !doc.title) continue;
      const rawBtih = Array.isArray(doc.btih) ? doc.btih[0] : doc.btih;
      const infoHash = rawBtih && isValidInfoHash(rawBtih) ? rawBtih.toLowerCase() : undefined;
      const torrentUrl = `https://archive.org/download/${doc.identifier}/${doc.identifier}_archive.torrent`;
      const detailsUrl = `https://archive.org/details/${doc.identifier}`;
      const magnetUri = infoHash
        ? buildMagnetUri(infoHash, doc.title, [
            'http://bt1.archive.org:6969/announce',
            'http://bt2.archive.org:6969/announce',
          ])
        : undefined;

      const rawDesc = Array.isArray(doc.description)
        ? doc.description[0]
        : doc.description || '';
      const cleanDesc = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      results.push({
        id: `archive-bt-${doc.identifier}`,
        title: `[Archive BT] ${doc.title}`,
        url: detailsUrl,
        snippet:
          clip(cleanDesc, 240) ||
          `Verified Internet Archive BitTorrent Swarm (${doc.mediatype || 'archive'}) · ${formatBytes(
            doc.item_size
          )} · ${doc.downloads ?? 0} archival downloads.`,
        source: 'archive-bt',
        publishedAt: doc.publicdate,
        points: doc.downloads,
        p2p: {
          protocol: 'bittorrent-dht',
          infoHash,
          magnetUri,
          torrentUrl,
          sizeBytes: doc.item_size,
          sizeFormatted: formatBytes(doc.item_size),
          seeders: Math.max(5, Math.min(200, Math.round((doc.downloads ?? 50) / 25))),
          leechers: 1,
          indexerName: 'Archive.org Seedbox',
          categoryLabel: doc.mediatype ? `Archive (${doc.mediatype})` : 'Archival Swarm',
          healthVerdict: 'archival-seedbox',
        },
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 4. Usenet / NZB Live Indexer (NZBIndex JSON API + Uncensored 18+ binary group support)
 */
export async function searchUsenetNzbIndex(
  query: string,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  try {
    const url = `https://nzbindex.com/api/search?q=${encodeURIComponent(query)}&max=12`;
    const res = await fetchFast(url, 3800);
    if (!res.ok) return [];
    const payload = (await res.json()) as {
      data?: {
        content?: Array<{
          id: string;
          name: string;
          poster?: string;
          posted?: number;
          size?: number;
          fileCount?: number;
          complete?: boolean;
          groups?: string[];
        }>;
      };
    };

    const items = payload.data?.content ?? [];
    const results: RawSearchResult[] = [];
    const nowSec = Math.floor(Date.now() / 1000);

    for (const item of items) {
      if (!item.id || !item.name) continue;
      const primaryGroup = item.groups?.[0] || 'alt.binaries.misc';
      const isAdultGroup = /erotica|nsfw|xxx|fetish|adult/i.test((item.groups ?? []).join(' '));
      if (isAdultGroup && !uncensoredMode) {
        continue;
      }

      const cleanTitle = item.name
        .replace(/\s*yEnc\s*$/i, '')
        .trim()
        .replace(/^"\s*|\s*"$/g, '')
        .trim();

      const sizeBytes = Number(item.size) || 0;
      const postedSec = Number(item.posted) || 0;
      const ageDays =
        postedSec > 0 ? Math.max(0, Math.round((nowSec - postedSec) / 86400)) : undefined;
      const publishedAt =
        postedSec > 0 ? new Date(postedSec * 1000).toISOString() : undefined;
      const nzbUrl = `https://nzbindex.com/download/${item.id}/${encodeURIComponent(
        cleanTitle.slice(0, 60)
      )}.nzb`;
      const detailsUrl = `https://nzbindex.com/collection/${item.id}`;

      const par2Status = item.complete ? 'complete' : 'unverified';
      const healthVerdict = assessP2PHealth({
        title: cleanTitle,
        sizeBytes,
        protocol: 'usenet-nzb',
        par2Status,
      });

      if (healthVerdict === 'suspect-spam') continue;

      results.push({
        id: `nzb-${item.id}`,
        title: `[NZB] ${cleanTitle}`,
        url: detailsUrl,
        snippet: `Usenet Binary Release in ${primaryGroup} · ${formatBytes(sizeBytes)} (${
          item.fileCount ?? 1
        } files) · Retention: ${ageDays ?? '?'}d · Poster: ${item.poster || 'anon'}`,
        source: 'usenet-nzb',
        publishedAt,
        author: item.poster,
        isNsfw: isAdultGroup,
        p2p: {
          protocol: 'usenet-nzb',
          nzbUrl,
          sizeBytes,
          sizeFormatted: formatBytes(sizeBytes),
          filesCount: item.fileCount,
          newsgroup: primaryGroup,
          usenetAgeDays: ageDays,
          par2Status,
          indexerName: 'NZBIndex Usenet',
          categoryLabel: isAdultGroup
            ? '18+ Usenet Binary'
            : primaryGroup.replace(/^alt\.binaries\./, 'a.b.'),
          isAdultNsfw: isAdultGroup,
          healthVerdict,
        },
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 5. Torznab / Newznab Generic Connector
 */
export async function searchTorznabOrNewznab(
  query: string,
  baseUrl?: string,
  apiKey?: string,
  protocol: 'bittorrent-dht' | 'usenet-nzb' = 'bittorrent-dht'
): Promise<RawSearchResult[]> {
  if (!baseUrl) return [];
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('t', 'search');
    u.searchParams.set('q', query);
    if (apiKey) u.searchParams.set('apikey', apiKey);

    const res = await fetchFast(u.toString(), 2800);
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const results: RawSearchResult[] = [];

    $('item').each((idx, el) => {
      if (idx >= 12) return;
      const title = $(el).find('title').first().text().trim();
      const link = $(el).find('link').first().text().trim();
      const pubDate = $(el).find('pubDate').first().text().trim();
      const sizeText = $(el).find('size').first().text().trim();
      const sizeBytes = Number(sizeText) || undefined;

      let seeders: number | undefined;
      let leechers: number | undefined;
      let peers: number | undefined;
      let infoHash: string | undefined;

      $(el)
        .find('torznab\\:attr, newznab\\:attr, attr')
        .each((_, attrEl) => {
          const name = $(attrEl).attr('name');
          const val = $(attrEl).attr('value') || '';
          if (name === 'seeders') seeders = Number(val);
          if (name === 'leechers') leechers = Number(val);
          if (name === 'peers') peers = Number(val);
          if (name === 'infohash' && isValidInfoHash(val)) infoHash = val.toLowerCase();
        });
      // The spec's peers are seeders plus leechers; an indexer may also say leechers outright.
      if (leechers === undefined && peers !== undefined) leechers = Math.max(0, peers - (seeders || 0));

      const magnetUri = infoHash ? buildMagnetUri(infoHash, title) : undefined;
      results.push({
        id: `znab-${protocol}-${idx}-${title}`,
        title,
        url: magnetUri || link,
        snippet: `Indexed via ${protocol === 'bittorrent-dht' ? 'Torznab' : 'Newznab'} · ${formatBytes(
          sizeBytes
        )}`,
        source: protocol === 'bittorrent-dht' ? 'bitmagnet-dht' : 'usenet-nzb',
        publishedAt: pubDate || undefined,
        p2p: {
          protocol,
          infoHash,
          magnetUri,
          nzbUrl: protocol === 'usenet-nzb' ? link : undefined,
          torrentUrl: protocol === 'bittorrent-dht' && !magnetUri ? link : undefined,
          sizeBytes,
          sizeFormatted: formatBytes(sizeBytes),
          seeders,
          leechers,
          indexerName: protocol === 'bittorrent-dht' ? 'Torznab Node' : 'Newznab Node',
          healthVerdict: 'active',
        },
      });
    });

    return results;
  } catch {
    return [];
  }
}

export async function executeP2PAndUsenetSearch(
  query: string,
  endpoints?: CustomEndpointsConfig,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  const analysis = analyzeQueryIntent(query);
  const kwQuery = analysis.keywordQuery || query;
  if (!kwQuery.trim()) return [];

  // From Settings or NZBLIFE_API_KEY / NZBLIFE_URL, through the server, which pairs a key with its address.
  const nzbLifeKey = endpoints?.nzbLifeApiKey;
  const nzbLifeUrl = endpoints?.nzbLifeUrl || 'https://api.nzb.life/api';

  const [bitmagnetItems, dhtItems, archiveBtItems, nzbItems, torznabItems, newznabItems, nzbLifeItems] =
    await Promise.all([
      searchBitmagnetGraphQL(kwQuery, endpoints?.bitmagnetUrl),
      searchPublicDhtSwarms(kwQuery, uncensoredMode),
      searchInternetArchiveTorrents(kwQuery),
      searchUsenetNzbIndex(kwQuery, uncensoredMode),
      searchTorznabOrNewznab(kwQuery, endpoints?.torznabUrl, endpoints?.torznabApiKey, 'bittorrent-dht'),
      searchTorznabOrNewznab(kwQuery, endpoints?.newznabUrl, endpoints?.newznabApiKey, 'usenet-nzb'),
      nzbLifeKey
        ? searchTorznabOrNewznab(kwQuery, nzbLifeUrl, nzbLifeKey, 'usenet-nzb').then((items) =>
            items.map((it) => ({
              ...it,
              source: 'nzb-life' as const,
              snippet: it.snippet.replace('Newznab', 'NZB.life'),
              p2p: it.p2p ? { ...it.p2p, indexerName: 'NZB.life' } : it.p2p,
            }))
          )
        : Promise.resolve([] as RawSearchResult[]),
    ]);

  return [
    ...bitmagnetItems,
    ...torznabItems,
    ...dhtItems,
    ...archiveBtItems,
    ...nzbLifeItems,
    ...newznabItems,
    ...nzbItems,
  ];
}
