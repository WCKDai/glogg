/**
 * Deep index — the crawler. Opt-in, resumable and polite:
 *  - one request at a time per host, at least HOST_GAP_MS apart (4chan's API rule is 1 s);
 *    sites that share a backend (all of Stack Exchange) are paced as one host
 *  - conditional requests (ETag / Last-Modified), so unchanged feeds cost a 304
 *  - Retry-After honoured; failing sources back off exponentially, up to a week
 *  - responses capped in size and time; text only, nothing else is downloaded
 */
import { discoverFeeds, isDiscourse, parseChanCatalog, parseFeed, parseJsonFeed } from './parse.js';
import type { DeepPost } from './parse.js';
import { hostOf, INTERVAL_MIN } from './sources.js';
import type { DeepStore, SourceRow } from './store.js';

export const CRAWLER_UA = 'glogg-deep/0.4 (+https://github.com/WCKDai/glogg; self-hosted feed reader)';
const MINUTE = 60_000;
const MAX_BACKOFF_MS = 7 * 24 * 60 * MINUTE;
const LEASE_MS = 10 * MINUTE;

export interface CrawlerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  concurrency?: number;
  hostGapMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Board catalogs are one big JSON document (leftypol's is over 1.5 MB), so they get more room. */
  maxBoardBytes?: number;
}

/** Hosts that share one backend, paced as one: Stack Exchange throttles bursts across all its sites. */
const SHARED_BACKENDS: { pattern: RegExp; slot: string; gapMs: number }[] = [
  {
    pattern: /(^|\.)(stackexchange\.com|stackoverflow\.com|superuser\.com|serverfault\.com|askubuntu\.com|mathoverflow\.net)$/,
    slot: 'stackexchange',
    gapMs: 2500,
  },
];

/** The politeness slot a request counts against: its host, or its shared backend. */
export function politenessSlot(url: string): string {
  const host = hostOf(url);
  return SHARED_BACKENDS.find((b) => b.pattern.test(host))?.slot ?? host;
}

export type VisitResult = 'ok' | 'unchanged' | 'moved' | 'error';

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Network failures worth retrying soon, rather than backing off for a day. */
const TRANSIENT = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE']);
const TRANSIENT_RETRY_MS = 20 * MINUTE;

const READABLE: Record<string, string> = {
  ENOTFOUND: 'domain no longer exists',
  ECONNREFUSED: 'connection refused',
  CERT_HAS_EXPIRED: 'certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificate is for another domain',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate not trusted',
  UND_ERR_CONNECT_TIMEOUT: "couldn't connect in time",
};

/** The underlying reason for a failed fetch: "fetch failed" alone says nothing. */
export function describeFetchError(e: unknown): { message: string; transient: boolean } {
  if (e instanceof Error && e.name === 'TimeoutError') return { message: 'timed out', transient: true };
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  if (code) return { message: READABLE[code] ? `${READABLE[code]} (${code})` : code, transient: TRANSIENT.has(code) };
  return { message: e instanceof Error ? e.message : String(e), transient: false };
}

function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export class DeepCrawler {
  private readonly store: DeepStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly hostGapMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxBoardBytes: number;
  private running = false;
  private inFlight = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly busyHosts = new Set<string>();
  /** Earliest time each host (politeness slot) may be contacted again. */
  private readonly hostFreeAt = new Map<string, number>();
  /** The same, by the sources' `site`, so the due query can skip sites that are waiting. */
  private readonly busySites = new Set<string>();
  private readonly siteFreeAt = new Map<string, number>();
  readonly counts = { visited: 0, unchanged: 0, failed: 0, posts: 0 };
  startedAt = 0;
  lastError = '';

  constructor(store: DeepStore, opts: CrawlerOptions = {}) {
    this.store = store;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.concurrency = opts.concurrency ?? 6;
    this.hostGapMs = opts.hostGapMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.maxBytes = opts.maxBytes ?? 1_500_000;
    this.maxBoardBytes = opts.maxBoardBytes ?? 8_000_000;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get active(): number {
    return this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.store.setMeta('crawl', 'on');
    this.pump();
  }

  pause(): void {
    this.running = false;
    this.store.setMeta('crawl', 'off');
    clearTimeout(this.timer);
  }

  private pump(): void {
    clearTimeout(this.timer);
    if (!this.running) return;
    const now = this.now();
    if (this.inFlight < this.concurrency) {
      for (const s of this.store.dueSources(now, 300, this.waitingSites(now))) {
        if (this.inFlight >= this.concurrency) break;
        const host = politenessSlot(s.url);
        if (this.busyHosts.has(host) || (this.hostFreeAt.get(host) ?? 0) > now) continue;
        this.store.updateSource(s.id, { next_at: now + LEASE_MS });
        void this.run(s, host);
      }
    }
    const next = this.store.nextDueAt();
    const wait = next === null ? 60_000 : Math.min(60_000, Math.max(this.hostGapMs / 4, next - now, 50));
    this.timer = setTimeout(() => this.pump(), wait);
  }

  /** Sites that are busy or still in their gap; expired entries are dropped as it goes. */
  private waitingSites(now: number): string[] {
    for (const [site, at] of this.siteFreeAt) if (at <= now) this.siteFreeAt.delete(site);
    return [...new Set([...this.busySites, ...this.siteFreeAt.keys()])];
  }

  private async run(s: SourceRow, host: string): Promise<void> {
    this.inFlight += 1;
    this.busyHosts.add(host);
    this.busySites.add(s.site);
    try {
      await this.visit(s);
    } finally {
      this.inFlight -= 1;
      this.busyHosts.delete(host);
      this.busySites.delete(s.site);
      const gap = SHARED_BACKENDS.find((b) => b.slot === host)?.gapMs ?? this.hostGapMs;
      const freeAt = Math.max(this.hostFreeAt.get(host) ?? 0, this.now() + Math.max(gap, this.hostGapMs));
      this.hostFreeAt.set(host, freeAt);
      this.siteFreeAt.set(s.site, freeAt);
      if (this.running) this.pump();
    }
  }

  private schedule(s: SourceRow, now: number, minutes = s.interval_min): number {
    // ±10% jitter so thousands of feeds don't come due in the same minute
    return now + minutes * MINUTE * (0.9 + Math.random() * 0.2);
  }

  private fail(s: SourceRow, now: number, error: string): VisitResult {
    const fails = s.fails + 1;
    const backoff = Math.min(MAX_BACKOFF_MS, s.interval_min * MINUTE * 2 ** (fails - 1));
    this.store.updateSource(s.id, { fails, status: 'error', error: error.slice(0, 200), fetched_at: now, next_at: now + backoff });
    this.counts.failed += 1;
    this.lastError = `${hostOf(s.url)}: ${error}`;
    return 'error';
  }

  /** One visit to one source. Public so it can be tested without the scheduler. */
  async visit(s: SourceRow): Promise<VisitResult> {
    const now = this.now();
    const headers: Record<string, string> = {
      'User-Agent': CRAWLER_UA,
      Accept:
        s.kind === 'board'
          ? 'application/json'
          : s.kind === 'site'
            ? 'text/html,application/xhtml+xml'
            : 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    };
    if (s.etag) headers['If-None-Match'] = s.etag;
    if (s.last_modified) headers['If-Modified-Since'] = s.last_modified;

    let res: Response;
    try {
      res = await this.fetchImpl(s.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const { message, transient } = describeFetchError(e);
      if (transient && s.fails < 3) {
        // A network hiccup, not a dead source: try again soon without counting it against the source.
        this.store.updateSource(s.id, { status: 'retry', error: message, fetched_at: now, next_at: now + TRANSIENT_RETRY_MS });
        this.counts.failed += 1;
        this.lastError = `${hostOf(s.url)}: ${message}`;
        return 'error';
      }
      return this.fail(s, now, message);
    }

    if (res.status === 304) {
      this.store.updateSource(s.id, { fetched_at: now, status: 'unchanged', fails: 0, error: null, next_at: this.schedule(s, now) });
      this.counts.unchanged += 1;
      return 'unchanged';
    }
    if (res.status === 429 || res.status === 503) {
      const wait = Math.max(retryAfterMs(res.headers.get('retry-after'), now), 15 * MINUTE);
      this.hostFreeAt.set(politenessSlot(s.url), now + wait);
      this.store.updateSource(s.id, { status: 'rate-limited', error: `HTTP ${res.status}`, fetched_at: now, next_at: now + wait });
      return 'error';
    }
    if (!res.ok) return this.fail(s, now, `HTTP ${res.status}`);

    let text: string;
    try {
      text = await readCapped(res, s.kind === 'board' ? this.maxBoardBytes : this.maxBytes);
    } catch (e) {
      return this.fail(s, now, e instanceof Error ? e.message : String(e));
    }

    const validators = { etag: res.headers.get('etag'), last_modified: res.headers.get('last-modified') };
    let posts: DeepPost[] = [];
    let title: string | undefined;

    if (s.kind === 'board') {
      try {
        posts = parseChanCatalog(JSON.parse(text), (no) => (s.thread_url || `${s.url.replace(/\/catalog\.json$/, '')}/res/{no}.html`).replace('{no}', String(no)));
      } catch {
        return this.fail(s, now, 'not a board catalog');
      }
    } else if (s.kind !== 'site' && /^\s*\{/.test(text) && text.includes('jsonfeed.org')) {
      try {
        const parsed = parseJsonFeed(JSON.parse(text), res.url || s.url);
        posts = parsed.posts;
        title = parsed.title;
      } catch {
        return this.fail(s, now, 'unreadable JSON feed');
      }
    } else if (s.kind === 'site' || !/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4000))) {
      // A page, not a feed: find its feed (or its Discourse forum) and index that instead.
      const page = res.url || s.url;
      const feed = isDiscourse(text) ? `${new URL(page).origin}/latest.rss` : discoverFeeds(text, page)[0];
      if (!feed) {
        this.store.updateSource(s.id, { status: 'no-feed', fetched_at: now, fails: 0, next_at: this.schedule(s, now, INTERVAL_MIN.site) });
        return 'moved';
      }
      const kind = isDiscourse(text) ? 'forum' : 'blog';
      this.store.addSources([
        { url: feed, kind, site: s.site, origin: s.origin, title: s.title ?? undefined, nsfw: Boolean(s.nsfw), intervalMin: INTERVAL_MIN[kind] },
      ]);
      this.store.updateSource(s.id, { status: 'feed-found', error: feed, fetched_at: now, fails: 0, next_at: this.schedule(s, now, INTERVAL_MIN.site) });
      return 'moved';
    } else {
      const parsed = parseFeed(text, res.url || s.url);
      posts = parsed.posts;
      title = parsed.title;
    }

    this.store.savePosts(s, posts, now);
    this.store.updateSource(s.id, {
      ...validators,
      title: s.title || title || null,
      fetched_at: now,
      status: 'ok',
      error: null,
      fails: 0,
      next_at: this.schedule(s, now),
    });
    this.counts.visited += 1;
    this.counts.posts += posts.length;
    return 'ok';
  }
}
