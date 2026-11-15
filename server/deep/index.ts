/**
 * Deep index — glogg's own index of the obscure web: small-web blogs,
 * imageboards and forums, crawled politely and searched locally.
 * Stored in $GLOGG_HOME/deep.db. Crawling only starts when you ask for it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeQueryIntent, parseQueryOperators } from '../../src/core/index.js';
import type { RawSearchResult, SourceConnectorId } from '../../src/core/index.js';
import { isBlockedSource } from './blocklist.js';
import { CRAWLER_UA, DeepCrawler } from './crawler.js';
import {
  discoverFeeds,
  exportOpml,
  isDiscourse,
  parseChanCatalog,
  parseDiscourseDirectory,
  parseFeed,
  parseJsonFeed,
  parseOpml,
} from './parse.js';
import type { DeepKind, DeepPost } from './parse.js';
import {
  builtinSources,
  hostOf,
  INTERVAL_MIN,
  SEED_LISTS,
  sourcesFrom4chan,
  sourcesFrom512kb,
  sourcesFromDiscourseDirectory,
  sourcesFromLemmyverse,
  sourcesFromSmallWeb,
  sourcesFromWebring,
} from './sources.js';
import { DeepStore, openDeepStore } from './store.js';
import { publicFetch } from '../publicFetch.js';
import type { SourceInput, SourceRow } from './store.js';

const RESEED_MS = 7 * 24 * 60 * 60_000;
/** A directory that failed is tried again after this, not on every page load. */
const RETRY_MS = 10 * 60_000;
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
let seeding: Promise<number> | null = null;
let background: Promise<number> | null = null;

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
  background = null;
  unavailable = '';
}

/** For shutdown: stops the crawler without recording it as paused, and closes the database. */
export function closeDeepIndex(): void {
  crawler?.stop();
  crawler = null;
  try {
    store?.close();
  } catch {
    // Already closed.
  }
  store = null;
  opening = null;
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

/** Discourse Discover, one page a second until the last (at most 60 pages). A page failing midway keeps what came before. */
async function loadDiscourseDirectory(fetchImpl: typeof fetch): Promise<SourceInput[]> {
  const forums = new Map<string, { url: string; title: string; nsfw: boolean }>();
  let url: string | undefined = SEED_LISTS.discourse.url;
  for (let page = 0; url && page < 60; page++) {
    if (page > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const parsed = parseDiscourseDirectory(JSON.parse(await fetchText(url, fetchImpl)), url);
      for (const f of parsed.forums) if (!forums.has(f.url)) forums.set(f.url, f);
      url = parsed.next;
    } catch (e) {
      if (forums.size === 0) throw e;
      break;
    }
  }
  return sourcesFromDiscourseDirectory([...forums.values()]);
}

interface SeedList {
  key: keyof typeof SEED_LISTS;
  /** Big or paged directories load in the background, so the Atlas and the crawler never wait on them. */
  background?: boolean;
  load: (fetchImpl: typeof fetch) => Promise<SourceInput[]>;
}

const LISTS: SeedList[] = [
  { key: 'smallweb', load: async (f) => sourcesFromSmallWeb(await fetchText(SEED_LISTS.smallweb.url, f)) },
  { key: 'club512', load: async (f) => sourcesFrom512kb(await fetchText(SEED_LISTS.club512.url, f)) },
  { key: 'fourchan', load: async (f) => sourcesFrom4chan(JSON.parse(await fetchText(SEED_LISTS.fourchan.url, f))) },
  { key: 'webring', load: async (f) => sourcesFromWebring(await fetchText(SEED_LISTS.webring.url, f)) },
  { key: 'lemmy', background: true, load: async (f) => sourcesFromLemmyverse(JSON.parse(await fetchText(SEED_LISTS.lemmy.url, f, 120_000))) },
  { key: 'discourse', background: true, load: loadDiscourseDirectory },
];

/** Loads directories in parallel; each one's success or failure is remembered on its own. Returns how many sources were new. */
async function loadLists(s: DeepStore, lists: SeedList[], fetchImpl: typeof fetch): Promise<number> {
  let added = 0;
  await Promise.all(
    lists.map(async (l) => {
      s.setMeta(`seed_tried:${l.key}`, String(Date.now()));
      try {
        // Await first: `added += …await…` would read `added` before the await and lose updates.
        const fresh = s.addSources(await l.load(fetchImpl));
        added += fresh;
        s.setMeta(`seeded:${l.key}`, String(Date.now()));
        s.setMeta(`seed_error:${l.key}`, '');
      } catch (e) {
        s.setMeta(`seed_error:${l.key}`, `${hostOf(SEED_LISTS[l.key].url)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );
  if (LISTS.every((l) => s.getMeta(`seeded:${l.key}`) && !s.getMeta(`seed_error:${l.key}`))) s.setMeta('seeded_at', String(Date.now()));
  return added;
}

function seedErrors(s: DeepStore): string[] {
  return LISTS.map((l) => s.getMeta(`seed_error:${l.key}`) || '').filter(Boolean);
}

/**
 * Loads the open directories into the index (sources only, nothing is crawled):
 * verified boards and forums, Kagi Small Web, 512KB Club, 4chan's board list and
 * the XXIIVV webring, then Lemmy and Discourse Discover in the background.
 * Each is refreshed weekly; one that fails is retried after ten minutes.
 * `wait` also waits for the background directories (tests, the CLI).
 */
export async function ensureSeeded(
  opts: { force?: boolean; fetch?: typeof fetch; wait?: boolean } = {}
): Promise<{ added: number; errors: string[]; loading: boolean }> {
  const s = await getDeepStore();
  if (!s) return { added: 0, errors: [unavailable], loading: false };
  const fetchImpl = opts.fetch ?? fetch;
  const now = Date.now();
  const due = (l: SeedList) =>
    opts.force ||
    (now - Number(s.getMeta(`seeded:${l.key}`) || 0) >= RESEED_MS && now - Number(s.getMeta(`seed_tried:${l.key}`) || 0) >= RETRY_MS);

  // Built-in sources every time: it's cheap, and ones added by an upgrade show up at once.
  let added = s.addSources(builtinSources());
  const slow = LISTS.filter((l) => l.background && due(l));
  if (slow.length && !background) {
    // .catch: the store can be closed underneath a slow download (tests reset it between cases).
    background = loadLists(s, slow, fetchImpl)
      .catch(() => 0)
      .finally(() => (background = null));
  }
  const pendingBackground = background;
  const fast = LISTS.filter((l) => !l.background && due(l));
  if (fast.length) {
    seeding ??= loadLists(s, fast, fetchImpl).finally(() => (seeding = null));
    added += await seeding;
  } else if (seeding) {
    await seeding;
  }
  if (opts.wait && pendingBackground) added += await pendingBackground;
  return { added, errors: seedErrors(s), loading: Boolean(background) };
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
    seeding: Boolean(seeding || background),
    seedErrors: seedErrors(s),
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
  return analysis.coreKeywords.length ? analysis.coreKeywords : query.split(/\s+/).filter(Boolean);
}

export async function searchDeep(
  query: string,
  opts: { nsfw?: boolean; kinds?: DeepKind[]; limit?: number; sinceMs?: number } = {}
): Promise<RawSearchResult[]> {
  if (!store && !fs.existsSync(deepDbPath())) return [];
  const s = await getDeepStore();
  if (!s) return [];
  const ops = parseQueryOperators(query);
  const terms = ops.text ? words(ops.text) : [];
  return s
    .search(terms, {
      ...opts,
      phrases: ops.phrases,
      without: ops.without,
      sites: ops.sites,
      notSites: ops.notSites,
    })
    .map((h) => ({
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

function parseImmediatePosts(row: SourceRow, text: string, json?: unknown): { title?: string; posts: DeepPost[] } {
  if (row.kind === 'board' && json !== undefined) {
    const pattern = row.thread_url || `${row.url.replace(/\/catalog\.json(\?.*)?$/, '')}/res/{no}.html`;
    return { posts: parseChanCatalog(json, (no) => pattern.replace('{no}', String(no))) };
  }
  if (/^\s*\{/.test(text) && text.includes('jsonfeed.org')) {
    try {
      const parsed = parseJsonFeed(JSON.parse(text), row.url);
      return { title: parsed.title, posts: parsed.posts };
    } catch {
      return { posts: [] };
    }
  }
  if (/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4000))) {
    const parsed = parseFeed(text, row.url);
    return { title: parsed.title, posts: parsed.posts };
  }
  return { posts: [] };
}

/**
 * Adds any URL: a feed, a Discourse forum, an imageboard catalog, or a page
 * whose feed can be discovered. `nsfw` keeps it behind the 18+ switch.
 * When `indexNow` is true, posts from the fetched feed or catalog are indexed immediately.
 */
export async function addUserSource(
  raw: string,
  fetchImpl: typeof fetch = (input, init) => publicFetch(input as string, init),
  opts: { nsfw?: boolean; indexNow?: boolean } = {}
): Promise<SourceRow> {
  const s = await getDeepStore();
  if (!s) throw new Error(unavailable);
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new Error('That is not a valid address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) addresses can be added.');
  const blocked = new Error("glogg doesn't index that.");
  if (isBlockedSource({ url: url.toString(), site: url.hostname })) throw blocked;

  const res = await fetchImpl(url.toString(), { headers: { 'User-Agent': CRAWLER_UA }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url.host} answered HTTP ${res.status}.`);
  const text = (await res.text()).slice(0, 1_500_000);
  const page = res.url || url.toString();
  const site = hostOf(page);
  const nsfw = Boolean(opts.nsfw);
  let input: SourceInput | null = null;
  let feedAlreadyFetched = false;

  let json: unknown;
  if (/^\s*[[{]/.test(text) && !text.includes('jsonfeed.org')) {
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON after all
    }
  }
  if (json !== undefined && parseChanCatalog(json, (n) => String(n)).length > 0) {
    const base = page.replace(/\/catalog\.json(\?.*)?$/, '');
    const threadUrl = site === 'a.4cdn.org' ? `${base.replace('a.4cdn.org', 'boards.4chan.org')}/thread/{no}` : `${base}/res/{no}.html`;
    input = { url: page, kind: 'board', site, origin: 'user', nsfw, intervalMin: INTERVAL_MIN.board, threadUrl };
    feedAlreadyFetched = true;
  } else if (/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4000)) || (/^\s*\{/.test(text) && text.includes('jsonfeed.org'))) {
    const kind = /xmlns:discourse=/.test(text) ? 'forum' : 'blog';
    input = { url: page, kind, site, origin: 'user', nsfw, intervalMin: INTERVAL_MIN[kind] };
    feedAlreadyFetched = true;
  } else if (isDiscourse(text)) {
    input = { url: `${new URL(page).origin}/latest.rss`, kind: 'forum', site, origin: 'user', nsfw, intervalMin: INTERVAL_MIN.forum };
  } else if (json === undefined) {
    const feed = discoverFeeds(text, page)[0];
    if (feed) input = { url: feed, kind: 'blog', site, origin: 'user', nsfw, intervalMin: INTERVAL_MIN.blog };
  }

  if (!input) throw new Error(`No feed, forum or board found at ${url.host}. Try the page's RSS link or a board's catalog.json.`);
  if (isBlockedSource(input)) throw blocked;
  s.addSources([input]);
  const row = s.getSourceByUrl(input.url)!;
  if (opts.indexNow) {
    let bodyText = feedAlreadyFetched ? text : '';
    let bodyJson = feedAlreadyFetched ? json : undefined;
    if (!feedAlreadyFetched) {
      try {
        const feedRes = await fetchImpl(input.url, { headers: { 'User-Agent': CRAWLER_UA }, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
        if (feedRes.ok) {
          bodyText = (await feedRes.text()).slice(0, 1_500_000);
          if (/^\s*[[{]/.test(bodyText) && !bodyText.includes('jsonfeed.org')) {
            try {
              bodyJson = JSON.parse(bodyText);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // leave queued for next crawl
      }
    }
    if (bodyText) {
      const parsed = parseImmediatePosts(row, bodyText, bodyJson);
      if (parsed.posts.length > 0) {
        const now = Date.now();
        s.savePosts(row, parsed.posts, now);
        s.updateSource(row.id, {
          fetched_at: now,
          next_at: now + row.interval_min * 60_000,
          status: 'ok',
          error: null,
          fails: 0,
          ...(parsed.title && !row.title ? { title: parsed.title } : {}),
        });
        return s.getSource(row.id)!;
      }
    }
  }
  s.updateSource(row.id, { next_at: 0 });
  return { ...row, next_at: 0 };
}

/** Removes a user-added source and all of its indexed posts. */
export async function removeUserSource(id: number): Promise<boolean> {
  const s = await getDeepStore();
  if (!s) throw new Error(unavailable);
  return s.removeSource(id, 'user');
}

/** Imports feed subscriptions from an OPML 1.x/2.0 document without contacting the network. */
export async function importUserOpml(xml: string, opts: { nsfw?: boolean } = {}): Promise<{ added: number; parsed: number }> {
  const s = await getDeepStore();
  if (!s) throw new Error(unavailable);
  const outlines = parseOpml(xml);
  if (outlines.length === 0) throw new Error('No valid RSS/Atom feed URLs found in OPML.');
  const inputs: SourceInput[] = [];
  for (const item of outlines.slice(0, 1000)) {
    const site = hostOf(item.htmlUrl || item.xmlUrl);
    if (!site) continue;
    const isForum = /forum|discourse|lemmy|reddit/i.test(`${item.category || ''} ${item.xmlUrl}`);
    const kind: DeepKind = isForum ? 'forum' : 'blog';
    inputs.push({
      url: item.xmlUrl,
      kind,
      site,
      origin: 'user',
      title: item.title,
      nsfw: Boolean(opts.nsfw),
      intervalMin: INTERVAL_MIN[kind],
    });
  }
  const added = s.addSources(inputs);
  return { added, parsed: outlines.length };
}

/** Exports deep-index feeds (`user` or `all`) as OPML 2.0 XML. */
export async function exportUserOpml(opts: { scope?: 'user' | 'all'; nsfw?: boolean } = {}): Promise<string> {
  const s = await getDeepStore();
  if (!s) throw new Error(unavailable);
  const rows = s.exportableSources({ origin: opts.scope === 'all' ? undefined : 'user', nsfw: opts.nsfw });
  return exportOpml(rows, opts.scope === 'all' ? 'glogg Deep Index — All Feeds' : 'glogg Deep Index — My Feeds');
}

