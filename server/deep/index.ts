/**
 * Deep index — glogg's own index of the obscure web: small-web blogs,
 * imageboards and forums, crawled politely and searched locally.
 * Stored in $GLOGG_HOME/deep.db. Crawling only starts when you ask for it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeQueryIntent } from '../../src/core/index.js';
import type { RawSearchResult, SourceConnectorId } from '../../src/core/index.js';
import { CRAWLER_UA, DeepCrawler } from './crawler.js';
import { discoverFeeds, isDiscourse, parseChanCatalog } from './parse.js';
import type { DeepKind } from './parse.js';
import {
  builtinSources,
  hostOf,
  INTERVAL_MIN,
  SEED_LISTS,
  sourcesFrom4chan,
  sourcesFrom512kb,
  sourcesFromSmallWeb,
} from './sources.js';
import { DeepStore, openDeepStore } from './store.js';
import type { SourceInput, SourceRow } from './store.js';

const RESEED_MS = 7 * 24 * 60 * 60_000;
const glogHome = () => process.env.GLOGG_HOME || path.join(os.homedir(), '.glogg');
export const deepDbPath = () => path.join(glogHome(), 'deep.db');

export const DEEP_SOURCE_IDS: Record<Exclude<DeepKind, 'site'>, SourceConnectorId> = {
  blog: 'deep-blogs',
  board: 'deep-boards',
  forum: 'deep-forums',
};

let store: DeepStore | null = null;
let opening: Promise<DeepStore | null> | null = null;
let unavailable = '';
let crawler: DeepCrawler | null = null;
let seeding: Promise<{ added: number; errors: string[] }> | null = null;

export async function getDeepStore(): Promise<DeepStore | null> {
  if (store) return store;
  opening ??= openDeepStore(deepDbPath())
    .then((s) => (store = s))
    .catch((e: unknown) => {
      unavailable = `The deep index needs Node 22.13+ with SQLite FTS5 (${e instanceof Error ? e.message : String(e)}).`;
      return null;
    });
  return opening;
}

/** Closes everything; tests use it between temp homes. */
export function resetDeepIndex(): void {
  crawler?.pause();
  crawler = null;
  store?.close();
  store = null;
  opening = null;
  seeding = null;
  unavailable = '';
}

export async function getCrawler(opts?: ConstructorParameters<typeof DeepCrawler>[1]): Promise<DeepCrawler | null> {
  const s = await getDeepStore();
  if (!s) return null;
  crawler ??= new DeepCrawler(s, opts);
  return crawler;
}

async function fetchText(url: string, fetchImpl: typeof fetch, timeoutMs = 30_000): Promise<string> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': CRAWLER_UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Loads the open directories into the index (sources only, nothing is crawled):
 * verified boards and forums, Kagi Small Web, 512KB Club and the 4chan board list.
 * Refreshed weekly; failures are reported and retried next time.
 */
export async function ensureSeeded(opts: { force?: boolean; fetch?: typeof fetch } = {}): Promise<{ added: number; errors: string[] }> {
  const s = await getDeepStore();
  if (!s) return { added: 0, errors: [unavailable] };
  const last = Number(s.getMeta('seeded_at') || 0);
  if (!opts.force && Date.now() - last < RESEED_MS) return { added: 0, errors: [] };
  seeding ??= (async () => {
    const fetchImpl = opts.fetch ?? fetch;
    const errors: string[] = [];
    let added = s.addSources(builtinSources());
    const lists: [string, (text: string) => SourceInput[]][] = [
      [SEED_LISTS.smallweb.url, sourcesFromSmallWeb],
      [SEED_LISTS.club512.url, sourcesFrom512kb],
      [SEED_LISTS.fourchan.url, (t) => sourcesFrom4chan(JSON.parse(t))],
    ];
    await Promise.all(
      lists.map(async ([url, parse]) => {
        try {
          // Await first: `added += …await…` would read `added` before the await and lose updates.
          const fresh = s.addSources(parse(await fetchText(url, fetchImpl)));
          added += fresh;
        } catch (e) {
          errors.push(`${hostOf(url)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
    if (errors.length === 0) s.setMeta('seeded_at', String(Date.now()));
    return { added, errors };
  })().finally(() => {
    seeding = null;
  });
  return seeding;
}

export async function deepStatus() {
  const s = await getDeepStore();
  if (!s) return { available: false as const, reason: unavailable };
  return {
    available: true as const,
    crawling: Boolean(crawler?.isRunning),
    active: crawler?.active ?? 0,
    counts: crawler?.counts ?? { visited: 0, unchanged: 0, failed: 0, posts: 0 },
    startedAt: crawler?.startedAt || null,
    lastError: crawler?.lastError || null,
    seededAt: Number(s.getMeta('seeded_at') || 0) || null,
    nextDueAt: s.nextDueAt(),
    ...s.stats(),
  };
}

export async function startCrawl(): Promise<void> {
  const c = await getCrawler();
  if (!c) throw new Error(unavailable);
  await ensureSeeded();
  c.start();
}

export async function pauseCrawl(): Promise<void> {
  (await getCrawler())?.pause();
}

/** Restarts a crawl the user had running before glogg was restarted. Never creates the database. */
export async function resumeDeepCrawl(): Promise<void> {
  if (!fs.existsSync(deepDbPath())) return;
  const s = await getDeepStore();
  if (s?.getMeta('crawl') === 'on') await startCrawl();
}

function words(query: string): string[] {
  const analysis = analyzeQueryIntent(query);
  return analysis.coreKeywords.length ? analysis.coreKeywords : query.split(/\s+/);
}

export async function searchDeep(query: string, opts: { nsfw?: boolean; kinds?: DeepKind[]; limit?: number } = {}): Promise<RawSearchResult[]> {
  if (!store && !fs.existsSync(deepDbPath())) return [];
  const s = await getDeepStore();
  if (!s) return [];
  return s.search(words(query), opts).map((h) => ({
    id: `deep-${h.url}`,
    title: h.title,
    url: h.url,
    snippet: h.snippet,
    source: DEEP_SOURCE_IDS[h.kind as Exclude<DeepKind, 'site'>] ?? 'deep-blogs',
    publishedAt: h.published ? new Date(h.published).toISOString() : undefined,
    isNsfw: h.nsfw,
    tags: [h.site],
  }));
}

export async function randomDeep(opts: { nsfw?: boolean; kinds?: DeepKind[] } = {}) {
  const s = await getDeepStore();
  if (!s) return null;
  const post = s.randomPost(opts);
  if (post) return { kind: 'post' as const, url: post.url, title: post.title, site: post.site };
  const site = s.listSources({ kind: opts.kinds?.[0] ?? 'all', order: 'random', limit: 1, nsfw: opts.nsfw }).items[0] as { url: string; site: string; title: string | null } | undefined;
  return site ? { kind: 'site' as const, url: `https://${site.site}/`, title: site.title || site.site, site: site.site } : null;
}

/**
 * Adds any URL: a feed, a Discourse forum, an imageboard catalog, or a page
 * whose feed can be discovered. Returns the stored source.
 */
export async function addUserSource(raw: string, fetchImpl: typeof fetch = fetch): Promise<SourceRow> {
  const s = await getDeepStore();
  if (!s) throw new Error(unavailable);
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new Error('That is not a valid address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) addresses can be added.');

  const res = await fetchImpl(url.toString(), { headers: { 'User-Agent': CRAWLER_UA }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url.host} answered HTTP ${res.status}.`);
  const text = (await res.text()).slice(0, 1_500_000);
  const page = res.url || url.toString();
  const site = hostOf(page);
  let input: SourceInput | null = null;

  if (/^\s*\[/.test(text)) {
    try {
      if (parseChanCatalog(JSON.parse(text), (n) => String(n)).length > 0) {
        const base = page.replace(/\/catalog\.json(\?.*)?$/, '');
        const threadUrl = site === 'a.4cdn.org' ? `${base.replace('a.4cdn.org', 'boards.4chan.org')}/thread/{no}` : `${base}/res/{no}.html`;
        input = { url: page, kind: 'board', site, origin: 'user', intervalMin: INTERVAL_MIN.board, threadUrl };
      }
    } catch {
      // not JSON after all
    }
  } else if (/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4000)) || (/^\s*\{/.test(text) && text.includes('jsonfeed.org'))) {
    const kind = /xmlns:discourse=/.test(text) ? 'forum' : 'blog';
    input = { url: page, kind, site, origin: 'user', intervalMin: INTERVAL_MIN[kind] };
  } else if (isDiscourse(text)) {
    input = { url: `${new URL(page).origin}/latest.rss`, kind: 'forum', site, origin: 'user', intervalMin: INTERVAL_MIN.forum };
  } else {
    const feed = discoverFeeds(text, page)[0];
    if (feed) input = { url: feed, kind: 'blog', site, origin: 'user', intervalMin: INTERVAL_MIN.blog };
  }

  if (!input) throw new Error(`No feed, forum or board found at ${url.host}. Try the page's RSS link or a board's catalog.json.`);
  s.addSources([input]);
  const row = s.getSourceByUrl(input.url)!;
  s.updateSource(row.id, { next_at: 0 });
  return { ...row, next_at: 0 };
}
