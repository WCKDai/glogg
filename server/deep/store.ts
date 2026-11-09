/**
 * Deep index — storage. One SQLite file (~/.glogg/deep.db) using Node's
 * built-in driver and FTS5, so there is nothing extra to install.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as Db } from 'node:sqlite';
import { isBlockedPost, isBlockedSource } from './blocklist.js';
import type { DeepKind, DeepPost } from './parse.js';

export interface SourceInput {
  url: string;
  kind: DeepKind;
  site: string;
  origin: string;
  title?: string;
  nsfw?: boolean;
  intervalMin: number;
  /** Pattern for thread links on boards: `{no}` is replaced by the thread number. */
  threadUrl?: string;
}

export interface SourceRow {
  id: number;
  url: string;
  kind: DeepKind;
  site: string;
  origin: string;
  title: string | null;
  nsfw: number;
  interval_min: number;
  thread_url: string | null;
  etag: string | null;
  last_modified: string | null;
  next_at: number;
  fetched_at: number | null;
  status: string | null;
  error: string | null;
  fails: number;
  posts: number;
}

export interface DeepHit {
  url: string;
  title: string;
  site: string;
  kind: DeepKind;
  snippet: string;
  published: number | null;
  nsfw: boolean;
  rank: number;
}

/** Posts kept per source; the newest win. */
export const KEEP_POSTS: Record<DeepKind, number> = { blog: 40, forum: 120, board: 300, site: 0 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  site TEXT NOT NULL,
  origin TEXT NOT NULL,
  title TEXT,
  nsfw INTEGER NOT NULL DEFAULT 0,
  interval_min INTEGER NOT NULL,
  thread_url TEXT,
  etag TEXT,
  last_modified TEXT,
  next_at INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER,
  status TEXT,
  error TEXT,
  fails INTEGER NOT NULL DEFAULT 0,
  posts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sources_due ON sources(next_at);
CREATE INDEX IF NOT EXISTS sources_kind ON sources(kind, site);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  source_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  site TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  published INTEGER,
  nsfw INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_source ON posts(source_id, published);
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title, summary, site, content='posts', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, summary, site) VALUES (new.id, new.title, new.summary, new.site);
END;
CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, summary, site) VALUES ('delete', old.id, old.title, old.summary, old.site);
END;
CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE OF title, summary, site ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, summary, site) VALUES ('delete', old.id, old.title, old.summary, old.site);
  INSERT INTO posts_fts(rowid, title, summary, site) VALUES (new.id, new.title, new.summary, new.site);
END;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const KIND_PRIORITY = `CASE kind WHEN 'board' THEN 0 WHEN 'forum' THEN 1 WHEN 'site' THEN 2 ELSE 3 END`;

/** Quoted FTS5 terms joined by AND (space) or OR. Quotes stop query-syntax injection. */
export function ftsQuery(words: string[], mode: 'and' | 'or' = 'and'): string {
  const terms = words
    .map((w) => w.replace(/["*^:(){}]/g, ' ').trim())
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`);
  return terms.join(mode === 'and' ? ' ' : ' OR ');
}

export class DeepStore {
  readonly db: Db;
  readonly file: string;

  constructor(db: Db, file: string) {
    this.db = db;
    this.file = file;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /**
   * Adds sources that aren't known yet; existing ones keep their crawl state. Returns how many were new.
   * Blocklisted sources are never stored, whoever adds them (see blocklist.ts).
   */
  addSources(list: SourceInput[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO sources(url, kind, site, origin, title, nsfw, interval_min, thread_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO NOTHING`
    );
    return this.tx(() => {
      let added = 0;
      for (const s of list) {
        if (isBlockedSource(s)) continue;
        const r = stmt.run(s.url, s.kind, s.site, s.origin, s.title ?? null, s.nsfw ? 1 : 0, s.intervalMin, s.threadUrl ?? null);
        added += Number(r.changes);
      }
      return added;
    });
  }

  getSource(id: number): SourceRow | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
  }

  getSourceByUrl(url: string): SourceRow | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE url = ?').get(url) as SourceRow | undefined;
  }

  /**
   * Sources due for a visit, boards and forums first. `skipSites` are sites the crawler
   * can't contact right now, so one big site (thousands of Lemmy communities on one
   * instance) can't fill the whole batch and stall everything else.
   */
  dueSources(now: number, limit: number, skipSites: string[] = []): SourceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sources WHERE next_at <= ? AND site NOT IN (SELECT value FROM json_each(?))
         ORDER BY ${KIND_PRIORITY}, next_at LIMIT ?`
      )
      .all(now, JSON.stringify(skipSites), limit) as unknown as SourceRow[];
  }

  nextDueAt(): number | null {
    const row = this.db.prepare('SELECT MIN(next_at) AS t FROM sources').get() as { t: number | null };
    return row.t;
  }

  updateSource(
    id: number,
    patch: Partial<Pick<SourceRow, 'etag' | 'last_modified' | 'next_at' | 'fetched_at' | 'status' | 'error' | 'fails' | 'title' | 'url' | 'kind'>>
  ): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE sources SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id);
  }

  /** Inserts or refreshes posts, then keeps only the newest KEEP_POSTS for the source. */
  savePosts(source: SourceRow, posts: DeepPost[], now = Date.now()): number {
    const upsert = this.db.prepare(
      `INSERT INTO posts(url, source_id, kind, site, title, summary, published, nsfw, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET title = excluded.title, summary = excluded.summary,
         published = COALESCE(excluded.published, posts.published), seen_at = excluded.seen_at`
    );
    const keep = KEEP_POSTS[source.kind] || 40;
    return this.tx(() => {
      for (const p of posts) {
        if (isBlockedPost(p)) continue;
        upsert.run(p.url, source.id, source.kind, source.site, p.title, p.summary, p.published ?? null, source.nsfw, now);
      }
      this.db
        .prepare(
          `DELETE FROM posts WHERE source_id = ? AND id NOT IN (
             SELECT id FROM posts WHERE source_id = ? ORDER BY COALESCE(published, seen_at) DESC LIMIT ?)`
        )
        .run(source.id, source.id, keep);
      const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE source_id = ?').get(source.id) as { n: number };
      this.db.prepare('UPDATE sources SET posts = ? WHERE id = ?').run(n, source.id);
      return n;
    });
  }

  search(words: string[], opts: { limit?: number; nsfw?: boolean; kinds?: DeepKind[] } = {}): DeepHit[] {
    const limit = opts.limit ?? 12;
    const kinds = opts.kinds?.length ? opts.kinds : null;
    const run = (mode: 'and' | 'or') => {
      const match = ftsQuery(words, mode);
      if (!match) return [];
      const rows = this.db
        .prepare(
          `SELECT p.url, p.title, p.site, p.kind, p.published, p.nsfw,
                  snippet(posts_fts, 1, '', '', '…', 28) AS snippet,
                  bm25(posts_fts, 8.0, 1.0, 2.0) AS rank
           FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid
           WHERE posts_fts MATCH ? AND (? = 1 OR p.nsfw = 0)
             ${kinds ? `AND p.kind IN (${kinds.map(() => '?').join(', ')})` : ''}
           ORDER BY rank LIMIT ?`
        )
        .all(match, opts.nsfw ? 1 : 0, ...(kinds || []), limit) as (Omit<DeepHit, 'nsfw'> & { nsfw: number })[];
      return rows.map((r) => ({ ...r, nsfw: Boolean(r.nsfw) }));
    };
    try {
      const all = run('and');
      // Every word missing from every post: fall back to any-word matches.
      return all.length > 0 || words.length < 2 ? all : run('or');
    } catch {
      return [];
    }
  }

  randomPost(opts: { nsfw?: boolean; kinds?: DeepKind[] } = {}): DeepHit | undefined {
    const kinds = opts.kinds?.length ? opts.kinds : null;
    const bounds = this.db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM posts').get() as { lo: number | null; hi: number | null };
    if (bounds.lo === null || bounds.hi === null) return undefined;
    const pick = Math.floor(bounds.lo + Math.random() * (bounds.hi - bounds.lo + 1));
    const row = this.db
      .prepare(
        `SELECT url, title, site, kind, published, nsfw, summary AS snippet, 0 AS rank FROM posts
         WHERE id >= ? AND (? = 1 OR nsfw = 0) ${kinds ? `AND kind IN (${kinds.map(() => '?').join(', ')})` : ''}
         ORDER BY id LIMIT 1`
      )
      .get(pick, opts.nsfw ? 1 : 0, ...(kinds || [])) as (Omit<DeepHit, 'nsfw'> & { nsfw: number }) | undefined;
    return row ? { ...row, nsfw: Boolean(row.nsfw) } : undefined;
  }

  listSources(opts: {
    kind?: DeepKind | 'all';
    origin?: string;
    q?: string;
    offset?: number;
    limit?: number;
    order?: 'random' | 'posts' | 'name';
    nsfw?: boolean;
  }) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.kind && opts.kind !== 'all') {
      where.push('kind = ?');
      args.push(opts.kind);
    }
    if (opts.origin) {
      where.push('origin = ?');
      args.push(opts.origin);
    }
    if (!opts.nsfw) where.push('nsfw = 0');
    if (opts.q?.trim()) {
      where.push('(site LIKE ? OR title LIKE ?)');
      const like = `%${opts.q.trim().replace(/[%_]/g, '')}%`;
      args.push(like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = opts.order === 'random' ? 'random()' : opts.order === 'name' ? 'site' : 'posts DESC, site';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM sources ${clause}`).get(...args) as { n: number }).n;
    const items = this.db
      .prepare(
        `SELECT id, url, kind, site, origin, title, nsfw, posts, status, fetched_at FROM sources ${clause}
         ORDER BY ${order} LIMIT ? OFFSET ?`
      )
      .all(...args, opts.limit ?? 60, opts.offset ?? 0);
    return { total, items };
  }

  /** How many sources of a kind each directory contributed, largest first. */
  originCounts(kind: DeepKind, nsfw = false): { origin: string; sources: number }[] {
    return this.db
      .prepare(`SELECT origin, COUNT(*) AS sources FROM sources WHERE kind = ? AND (? = 1 OR nsfw = 0) GROUP BY origin ORDER BY sources DESC, origin`)
      .all(kind, nsfw ? 1 : 0) as { origin: string; sources: number }[];
  }

  stats() {
    const byKind = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS sources, SUM(fetched_at IS NOT NULL) AS visited, SUM(fails > 0) AS failing, SUM(posts) AS posts
         FROM sources GROUP BY kind`
      )
      .all() as { kind: DeepKind; sources: number; visited: number; failing: number; posts: number }[];
    const { n: posts } = this.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number };
    let bytes = 0;
    try {
      bytes = fs.statSync(this.file).size;
    } catch {
      // in-memory database
    }
    return { posts, bytes, byKind };
  }
}

/** Opens (or creates) the deep index. Throws when this Node has no SQLite FTS5. */
export async function openDeepStore(file: string): Promise<DeepStore> {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  return new DeepStore(new DatabaseSync(file), file);
}
