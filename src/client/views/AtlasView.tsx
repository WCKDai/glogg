import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dices, ExternalLink, Pause, Play, Plus, RefreshCw, Shuffle } from 'lucide-react';
import { CURATED_INDIE_INDEX, IndieSiteEntry } from '../../core/browser.js';
import { api, faviconUrl, relativeDate } from '../lib.js';

const CATEGORIES: { id: IndieSiteEntry['category'] | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'niche-forums', label: 'Forums & boards' },
  { id: 'meta-indexers', label: 'Search engines' },
  { id: 'p2p-dht-usenet', label: 'P2P & Usenet' },
  { id: 'deep-archives-osint', label: 'Archives & OSINT' },
  { id: 'fediverse-protocols', label: 'Fediverse' },
  { id: 'systems-code', label: 'Systems & code' },
  { id: 'science-hardware', label: 'Science & hardware' },
  { id: 'practical-nobs', label: 'Practical' },
  { id: 'archives-reference', label: 'Reference' },
  { id: 'essays-culture', label: 'Essays & culture' },
];

type Tab = 'picked' | 'blog' | 'site' | 'board' | 'forum' | 'index';
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'picked', label: 'Hand-picked', hint: 'Sites we chose and described' },
  { id: 'blog', label: 'Blogs', hint: 'Personal blogs from the Kagi Small Web list' },
  { id: 'site', label: 'Small sites', hint: 'Tiny, fast personal sites from the 512KB Club' },
  { id: 'board', label: 'Boards', hint: 'Imageboards: 4chan, lainchan, wizchan' },
  { id: 'forum', label: 'Forums', hint: 'Discourse communities and old-school forums' },
  { id: 'index', label: 'Deep index', hint: 'Crawl status, and add your own sources' },
];

interface DirItem {
  id: number;
  url: string;
  kind: string;
  site: string;
  origin: string;
  title: string | null;
  nsfw: number;
  posts: number;
  status: string | null;
  fetched_at: number | null;
}

interface DirPage {
  available: boolean;
  total: number;
  items: DirItem[];
  counts: Partial<Record<'blog' | 'site' | 'board' | 'forum', number>>;
  errors?: string[];
}

interface DeepStatus {
  available: boolean;
  reason?: string;
  crawling?: boolean;
  active?: number;
  counts?: { visited: number; unchanged: number; failed: number; posts: number };
  lastError?: string | null;
  seededAt?: number | null;
  posts?: number;
  bytes?: number;
  byKind?: { kind: string; sources: number; visited: number; failing: number; posts: number }[];
}

const PAGE = 60;
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString();
const ORIGIN_LABEL: Record<string, string> = {
  smallweb: 'Kagi Small Web',
  '512kb': '512KB Club',
  '4chan': '4chan',
  lainchan: 'lainchan',
  wizchan: 'wizchan',
  discourse: 'Discourse',
  forums: 'forum',
  user: 'yours',
};

/** The page a directory row should open: boards and feeds open their site, not the API. */
function siteUrl(item: DirItem): string {
  if (item.kind === 'board') {
    const m = item.url.match(/a\.4cdn\.org\/([^/]+)\/catalog\.json/);
    if (m) return `https://boards.4chan.org/${m[1]}/catalog`;
    return item.url.replace(/catalog\.json$/, 'catalog.html');
  }
  return `https://${item.site}/`;
}

export function AtlasView({
  onRead,
  uncensored,
  onToast,
}: {
  onRead: (url: string) => void;
  uncensored: boolean;
  onToast?: (t: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [tab, setTab] = useState<Tab>('picked');
  const [status, setStatus] = useState<DeepStatus | null>(null);
  const [counts, setCounts] = useState<DirPage['counts']>({});

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<DeepStatus>('/api/deep'));
    } catch {
      setStatus({ available: false, reason: 'The deep index is unreachable.' });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!status?.crawling) return;
    const t = setInterval(() => void loadStatus(), 3000);
    return () => clearInterval(t);
  }, [status?.crawling, loadStatus]);

  const surprise = async (kind?: string) => {
    try {
      const pick = await api<{ url: string; title: string }>(`/api/deep/random?nsfw=${uncensored}${kind ? `&kind=${kind}` : ''}`);
      window.open(pick.url, '_blank', 'noopener,noreferrer');
    } catch {
      onToast?.('Nothing indexed yet. Start the deep index first.', 'info');
    }
  };

  const total = (counts.blog ?? 0) + (counts.site ?? 0) + (counts.board ?? 0) + (counts.forum ?? 0);
  return (
    <div className="page page-wide atlas-page">
      <header className="page-head">
        <div>
          <h1>Atlas</h1>
          <p>
            {CURATED_INDIE_INDEX.length} hand-picked
            {total > 0 && (
              <>
                {' '}
                · {fmt(counts.blog)} blogs · {fmt(counts.site)} small sites · {fmt(counts.board)} boards · {fmt(counts.forum)} forums
              </>
            )}
            {status?.posts ? <> · {fmt(status.posts)} posts in your deep index</> : null}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void surprise(tab === 'picked' || tab === 'index' ? undefined : tab)}
          title="Open a random post from the deep index (from this tab's kind)"
        >
          <Dices size={13} /> Surprise me
        </button>
      </header>

      <div className="tool-tabs atlas-tabs" role="tablist" aria-label="Atlas sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tool-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
            title={t.hint}
          >
            {t.label}
            {t.id !== 'picked' && t.id !== 'index' && counts[t.id] ? <span className="tab-count">{fmt(counts[t.id])}</span> : null}
            {t.id === 'index' && status?.crawling ? <span className="sb-dot busy" aria-label="crawling" /> : null}
          </button>
        ))}
      </div>

      {tab === 'picked' ? (
        <HandPicked onRead={onRead} uncensored={uncensored} />
      ) : tab === 'index' ? (
        <DeepIndexPanel status={status} reload={loadStatus} onToast={onToast} />
      ) : (
        <Directory key={tab} kind={tab} uncensored={uncensored} onCounts={setCounts} onRead={onRead} />
      )}
    </div>
  );
}

function HandPicked({ onRead, uncensored }: { onRead: (url: string) => void; uncensored: boolean }) {
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [seed, setSeed] = useState(0);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = CURATED_INDIE_INDEX.filter((s) => {
      if (!uncensored && s.is18Plus) return false;
      if (cat !== 'all' && s.category !== cat) return false;
      if (!needle) return true;
      return `${s.title} ${s.domain} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(needle);
    });
    if (seed === 0) return list;
    return [...list].sort(() => Math.random() - 0.5);
  }, [cat, q, seed, uncensored]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of CURATED_INDIE_INDEX) m[s.category] = (m[s.category] || 0) + 1;
    return m;
  }, []);

  return (
    <>
      <div className="toolbar">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter sites…" aria-label="Filter hand-picked sites" style={{ maxWidth: 280 }} />
        <div className="toolbar-spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSeed((s) => s + 1)}>
          <Shuffle size={13} /> Shuffle
        </button>
      </div>

      <div className="chips">
        {CATEGORIES.filter((c) => c.id === 'all' || counts[c.id]).map((c) => (
          <button key={c.id} type="button" className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="atlas">
        {items.map((s) => (
          <article key={s.domain} className="site">
            <div className="site-head">
              <img src={faviconUrl(s.domain)} alt="" width={16} height={16} loading="lazy" />
              <span className="site-domain">{s.domain}</span>
              {s.era === 'pre-llm' && <span className="tag">pre-LLM</span>}
            </div>
            <h3 className="site-title">{s.title}</h3>
            <p className="site-desc">{s.description}</p>
            <div className="site-foot">
              <button type="button" className="link-btn" onClick={() => onRead(s.url)}>
                Read
              </button>
              <a className="link-btn" href={s.url} target="_blank" rel="noreferrer">
                Visit <ExternalLink size={11} />
              </a>
            </div>
          </article>
        ))}
        {items.length === 0 && <p className="empty">No sites match.</p>}
      </div>
    </>
  );
}

function Directory({
  kind,
  uncensored,
  onCounts,
  onRead,
}: {
  kind: Exclude<Tab, 'picked' | 'index'>;
  uncensored: boolean;
  onCounts: (c: DirPage['counts']) => void;
  onRead: (url: string) => void;
}) {
  const [q, setQ] = useState('');
  const [order, setOrder] = useState<'posts' | 'random' | 'name'>('posts');
  const [items, setItems] = useState<DirItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ kind, q, order, offset: String(offset), limit: String(PAGE), nsfw: String(uncensored) });
        const page = await api<DirPage>(`/api/deep/sites?${params}`);
        if (id !== reqId.current) return;
        if (!page.available) setError(page.errors?.[0] || 'The deep index is not available on this system.');
        else setError(page.errors?.length ? `Some directories didn't load: ${page.errors.join('; ')}` : null);
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
        onCounts(page.counts);
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [kind, q, order, uncensored, onCounts]
  );

  useEffect(() => {
    const t = setTimeout(() => void load(0), q ? 180 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <>
      <div className="toolbar">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Filter ${TABS.find((t) => t.id === kind)?.label.toLowerCase()}…`}
          aria-label="Filter the directory"
          style={{ maxWidth: 280 }}
        />
        <div className="segmented segmented-sm" role="radiogroup" aria-label="Order">
          {(['posts', 'random', 'name'] as const).map((o) => (
            <button key={o} type="button" role="radio" aria-checked={order === o} className={order === o ? 'active' : ''} onClick={() => setOrder(o)}>
              {o === 'posts' ? 'Most indexed' : o === 'random' ? 'Random' : 'A–Z'}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="notice notice-warn">{error}</div>}

      <ul className="dir-list" aria-busy={loading}>
        {items.map((it) => (
          <li key={it.id} className="dir-row">
            <img className="favicon" src={faviconUrl(it.site)} alt="" width={14} height={14} loading="lazy" />
            <div className="dir-main">
              <a className="dir-title truncate" href={siteUrl(it)} target="_blank" rel="noreferrer noopener">
                {it.title || it.site}
              </a>
              <span className="dir-sub truncate">
                {it.title ? it.site : ''}
                {it.title && ' · '}
                {ORIGIN_LABEL[it.origin] || it.origin}
              </span>
            </div>
            {it.nsfw ? <span className="tag tag-danger">18+</span> : null}
            <span className="dir-meta">
              {it.posts > 0 ? `${fmt(it.posts)} posts` : it.status === 'no-feed' ? 'no feed' : it.status === 'error' ? 'failing' : it.fetched_at ? '' : 'not crawled'}
              {it.fetched_at ? ` · ${relativeDate(new Date(it.fetched_at).toISOString())}` : ''}
            </span>
            <button type="button" className="icon-btn ghost" title="Read clean" aria-label={`Read ${it.site}`} onClick={() => onRead(siteUrl(it))}>
              <ExternalLink size={13} />
            </button>
          </li>
        ))}
      </ul>
      {loading && items.length === 0 && (
        <div className="skeleton-stack" aria-hidden>
          <div className="skeleton w-80" />
          <div className="skeleton w-70" />
          <div className="skeleton w-95" />
        </div>
      )}
      {!loading && items.length === 0 && !error && <p className="empty">Nothing matches.</p>}
      {items.length < total && (
        <button type="button" className="more-toggle" disabled={loading} onClick={() => void load(items.length)}>
          {loading ? 'Loading…' : `Show more · ${fmt(total - items.length)} left`}
        </button>
      )}
    </>
  );
}

function DeepIndexPanel({
  status,
  reload,
  onToast,
}: {
  status: DeepStatus | null;
  reload: () => Promise<void>;
  onToast?: (t: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');

  if (!status) return <div className="skeleton-stack" aria-busy="true"><div className="skeleton w-80" /></div>;
  if (!status.available) return <div className="notice notice-warn">{status.reason}</div>;

  const kinds = Object.fromEntries((status.byKind || []).map((k) => [k.kind, k]));
  const sources = (status.byKind || []).reduce((n, k) => n + k.sources, 0);
  const visited = (status.byKind || []).reduce((n, k) => n + k.visited, 0);
  const pct = sources ? Math.round((visited / sources) * 100) : 0;

  const act = async (action: 'start' | 'pause' | 'reseed') => {
    setBusy(true);
    try {
      await api('/api/deep/crawl', { method: 'POST', json: { action } });
      onToast?.(action === 'start' ? 'Deep index crawling. It keeps going in the background.' : action === 'pause' ? 'Crawling paused' : 'Directories refreshed', 'ok');
      await reload();
    } catch (e) {
      onToast?.((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const { source } = await api<{ source: { kind: string; url: string } }>('/api/deep/sources', { method: 'POST', json: { url } });
      onToast?.(`Added as ${source.kind === 'board' ? 'a board' : source.kind === 'forum' ? 'a forum' : 'a blog'}. It's crawled next.`, 'ok');
      setUrl('');
      await reload();
    } catch (err) {
      onToast?.((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="deep-panel">
      <section className="deep-status">
        <div className="stats">
          <div className="stat">
            <div className="stat-value">{fmt(status.posts)}</div>
            <div className="stat-label">posts indexed</div>
          </div>
          <div className="stat">
            <div className="stat-value">
              {fmt(visited)}
              <span className="stat-of"> / {fmt(sources)}</span>
            </div>
            <div className="stat-label">sources visited</div>
          </div>
          <div className="stat">
            <div className="stat-value">{((status.bytes ?? 0) / 1048576).toFixed(1)} MB</div>
            <div className="stat-label">on disk</div>
          </div>
          <div className="stat">
            <div className={`stat-value ${status.crawling ? 'tone-ok' : ''}`}>{status.crawling ? 'Crawling' : 'Paused'}</div>
            <div className="stat-label">{status.crawling ? `${status.active ?? 0} in flight` : 'nothing is fetched'}</div>
          </div>
        </div>
        <div className="deep-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Sources visited">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="deep-kinds">
          {(['blog', 'site', 'board', 'forum'] as const).map((k) => (
            <span key={k}>
              <strong>{fmt(kinds[k]?.posts)}</strong> {k === 'blog' ? 'blog posts' : k === 'site' ? 'small-site posts' : k === 'board' ? 'threads' : 'forum topics'}
              <span className="muted"> · {fmt(kinds[k]?.visited)}/{fmt(kinds[k]?.sources)}</span>
            </span>
          ))}
        </div>
        <div className="row-gap">
          {status.crawling ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void act('pause')}>
              <Pause size={13} /> Pause
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('start')}>
              <Play size={13} /> {visited ? 'Resume crawling' : 'Build the deep index'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act('reseed')}>
            <RefreshCw size={13} /> Refresh directories
          </button>
        </div>
        {status.lastError && <p className="setting-hint">Last error: {status.lastError}</p>}
        <p className="setting-hint">
          Crawling stays off until you start it. glogg then reads each source's feed (one request per site at a time, at least a second apart, and only
          what changed) and keeps the text on this machine in ~/.glogg/deep.db. A first full pass takes roughly 2–3 hours and about 1 GB; results
          appear as it goes, and searches answer from here in milliseconds.
        </p>
      </section>

      <section className="plugin-section">
        <h3 className="section-title">Add a source</h3>
        <form className="tool-form inline" onSubmit={add}>
          <div className="field">
            <label htmlFor="deep-add">Blog, forum, board or feed</label>
            <input
              id="deep-add"
              className="input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="example.com · forum.example.org · chan.example/tech/catalog.json"
              autoComplete="off"
            />
          </div>
          <button className="btn btn-primary" disabled={busy || !url.trim()}>
            <Plus size={13} /> Add
          </button>
        </form>
        <p className="setting-hint">glogg works out what it is: an RSS/Atom/JSON feed, a Discourse forum, an imageboard catalog, or a page whose feed it can find.</p>
      </section>

      <section className="plugin-section deep-credits">
        <h3 className="section-title">Where the directories come from</h3>
        <ul>
          <li>
            <a href="https://github.com/kagisearch/smallweb" target="_blank" rel="noreferrer">Kagi Small Web</a>: personal blogs (MIT)
          </li>
          <li>
            <a href="https://512kb.club" target="_blank" rel="noreferrer">512KB Club</a>: tiny, fast personal sites (MIT)
          </li>
          <li>
            <a href="https://github.com/4chan/4chan-API" target="_blank" rel="noreferrer">4chan API</a>: board catalogs, at most one request a second
          </li>
          <li>lainchan, wizchan, 28 Discourse forums, VOGONS, VCFed, Raspberry Pi and Arch forums, Lobsters and Tildes: checked by hand</li>
        </ul>
      </section>
    </div>
  );
}
