import { useFeatures } from '../capabilities.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Dices, Download, Pause, Play, Plus, RefreshCw, Shuffle, Trash2, Upload } from 'lucide-react';
import type { IndieSiteEntry } from '../../core/browser.js';
import { Favicon } from '../components/Favicon.js';
import { api, plural, relativeDate } from '../lib.js';

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
  { id: 'blog', label: 'Blogs', hint: 'Personal blogs from Kagi Small Web and the XXIIVV webring' },
  { id: 'site', label: 'Small sites', hint: 'Tiny personal sites from the 512KB Club and the XXIIVV webring' },
  { id: 'board', label: 'Boards', hint: 'Imageboards: 4chan, 2ch, lainchan, wizchan, leftypol, uboachan, sushigirl, kissu' },
  { id: 'forum', label: 'Forums', hint: 'Lemmy communities, Discourse forums, Stack Exchange and old-school boards' },
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
  /** Where this tab's sources came from, largest first. */
  origins?: { origin: string; sources: number }[];
  errors?: string[];
  /** The big directories (Lemmy, Discourse) are still loading in the background. */
  loading?: boolean;
}

interface DeepStatus {
  available: boolean;
  reason?: string;
  crawling?: boolean;
  active?: number;
  counts?: { visited: number; unchanged: number; failed: number; posts: number };
  lastError?: string | null;
  seededAt?: number | null;
  seeding?: boolean;
  posts?: number;
  bytes?: number;
  byKind?: { kind: string; sources: number; visited: number; failing: number; posts: number }[];
}

const PAGE = 60;
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString();
const ORIGIN_LABEL: Record<string, string> = {
  smallweb: 'Kagi Small Web',
  '512kb': '512KB Club',
  xxiivv: 'XXIIVV webring',
  '4chan': '4chan',
  '2ch': '2ch',
  lainchan: 'lainchan',
  wizchan: 'wizchan',
  leftypol: 'leftypol',
  uboachan: 'uboachan',
  sushigirl: 'sushigirl',
  kissu: 'kissu',
  lemmy: 'Lemmy',
  discourse: 'Discourse',
  stackexchange: 'Stack Exchange',
  forums: 'Classic forums',
  user: 'Yours',
};

/** "Matrix.org — Open standard for …" → "Matrix.org"; "Stoat (stoat.chat)" → "Stoat". The full title stays in the tooltip. */
function shortTitle(title: string): string {
  return title.split(' — ')[0].replace(/\s*\([^)]*\)\s*$/, '').trim() || title;
}

/** A feed's own title, without the boilerplate some engines add ("Recent Questions - …", "… - Latest topics"). */
function dirTitle(item: DirItem): string | null {
  return item.title?.replace(/^Recent Questions - /, '').replace(/ - Latest (topics|posts)$/, '') || null;
}

/** The page a directory row should open: boards and feeds open their site, not the API. */
function siteUrl(item: DirItem): string {
  if (item.kind === 'board') {
    const m = item.url.match(/a\.4cdn\.org\/([^/]+)\/catalog\.json/);
    if (m) return `https://boards.4chan.org/${m[1]}/catalog`;
    return item.url.replace(/catalog\.json$/, 'catalog.html');
  }
  const lemmy = item.url.match(/^(https:\/\/[^/]+)\/feeds\/c\/([^/.]+)\.xml/);
  if (lemmy) return `${lemmy[1]}/c/${lemmy[2]}`;
  if (/\/latest\.rss$/.test(item.url)) return `${item.url.replace(/\/latest\.rss$/, '')}/`;
  if (item.origin === 'stackexchange') return item.url.replace(/\/feeds$/, '/questions');
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
  const features = useFeatures();
  const visibleTabs = features.administration ? TABS : TABS.filter((t) => t.id !== 'index');
  // The tab is part of the address (/atlas?tab=boards), so it can be linked and survives a refresh.
  const [tab, setTabState] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return TABS.some((x) => x.id === t) ? (t as Tab) : 'picked';
  });
  const activeTab: Tab = !features.administration && tab === 'index' ? 'picked' : tab;
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    window.history.replaceState(window.history.state, '', t === 'picked' ? window.location.pathname : `${window.location.pathname}?tab=${t}`);
  }, []);
  const [status, setStatus] = useState<DeepStatus | null>(null);
  const [counts, setCounts] = useState<DirPage['counts']>({});
  // The hand-picked sites come from the server, so the app doesn't carry them in every page load.
  const [picked, setPicked] = useState<IndieSiteEntry[] | null>(null);
  useEffect(() => {
    api<{ items: IndieSiteEntry[] }>('/api/directory')
      .then((r) => setPicked(r.items))
      .catch(() => setPicked([]));
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<DeepStatus>('/api/deep'));
    } catch {
      setStatus({ available: false, reason: 'The deep index is unreachable.' });
    }
  }, []);

  useEffect(() => {
    if (features.administration) void loadStatus();
  }, [features.administration, loadStatus]);

  useEffect(() => {
    if (!features.administration || !status?.crawling) return;
    const t = setInterval(() => void loadStatus(), 3000);
    return () => clearInterval(t);
  }, [features.administration, status?.crawling, loadStatus]);

  const surprise = async (kind?: string) => {
    if (!features.administration && !kind) {
      const pool = (picked ?? []).filter((s) => uncensored || !s.is18Plus);
      if (pool.length > 0) window.open(pool[Math.floor(Math.random() * pool.length)].url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      const pick = await api<{ url: string; title: string }>(`/api/deep/random?nsfw=${uncensored}${kind ? `&kind=${kind}` : ''}`);
      window.open(pick.url, '_blank', 'noopener,noreferrer');
    } catch {
      onToast?.(features.administration ? 'Nothing indexed yet. Start the deep index first.' : 'No indexed posts available yet.', 'info');
    }
  };

  const total = (counts.blog ?? 0) + (counts.site ?? 0) + (counts.board ?? 0) + (counts.forum ?? 0);
  return (
    <div className="page page-wide atlas-page">
      <header className="page-head">
        <div>
          <h1>Atlas</h1>
          <p>
            {picked ? `${picked.length} hand-picked` : 'Hand-picked'}
            {total > 0 && (
              <>
                {' '}
                · {fmt(counts.blog)} blogs · {fmt(counts.site)} small sites · {fmt(counts.board)} boards · {fmt(counts.forum)} forums
              </>
            )}
            {features.administration && status?.posts ? <> · {plural(status.posts, 'post')} in your deep index</> : null}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void surprise(activeTab === 'picked' || activeTab === 'index' ? undefined : activeTab)}
          title={features.administration || (activeTab !== 'picked' && activeTab !== 'index') ? "Open a random post from the deep index (from this tab's kind)" : 'Open a random hand-picked site'}
        >
          <Dices size={13} /> Surprise me
        </button>
      </header>

      <div className="tool-tabs atlas-tabs" role="tablist" aria-label="Atlas sections">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`tool-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
            title={t.hint}
          >
            {t.label}
            {t.id !== 'picked' && t.id !== 'index' && counts[t.id] ? <span className="tab-count">{fmt(counts[t.id])}</span> : null}
            {t.id === 'index' && status?.crawling ? <span className="sb-dot busy" aria-label="crawling" /> : null}
          </button>
        ))}
      </div>

      {/* First run: thousands of sources and nothing indexed yet. Say what that means, and offer the start here. */}
      {features.administration && activeTab !== 'picked' && activeTab !== 'index' && status?.available && !status.crawling && !status.posts && (
        <div className="notice atlas-first-run" role="note">
          <p>
            None of these are in your deep index yet. Build it to search their posts from glogg: it crawls politely in the background, about 3–4 hours and 1–1.5 GB for everything.
          </p>
          <div className="row-gap">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={async () => {
                try {
                  await api('/api/deep/crawl', { method: 'POST', json: { action: 'start' } });
                  onToast?.('Deep index crawling. It keeps going in the background.', 'ok');
                  await loadStatus();
                } catch (e) {
                  onToast?.((e as Error).message, 'error');
                }
              }}
            >
              Build the deep index
            </button>
            <button type="button" className="link-btn" onClick={() => setTab('index')}>
              More about it
            </button>
          </div>
        </div>
      )}

      {activeTab === 'picked' ? (
        <HandPicked sites={picked ?? []} onRead={onRead} uncensored={uncensored} />
      ) : activeTab === 'index' ? (
        <DeepIndexPanel status={status} reload={loadStatus} onToast={onToast} uncensored={uncensored} />
      ) : (
        <Directory key={activeTab} kind={activeTab} uncensored={uncensored} onCounts={setCounts} onRead={onRead} />
      )}
    </div>
  );
}

function HandPicked({ sites, onRead, uncensored }: { sites: IndieSiteEntry[]; onRead: (url: string) => void; uncensored: boolean }) {
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [seed, setSeed] = useState(0);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = sites.filter((s) => {
      if (!uncensored && s.is18Plus) return false;
      if (cat !== 'all' && s.category !== cat) return false;
      if (!needle) return true;
      return `${s.title} ${s.domain} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(needle);
    });
    if (seed === 0) return list;
    return [...list].sort(() => Math.random() - 0.5);
  }, [sites, cat, q, seed, uncensored]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sites) m[s.category] = (m[s.category] || 0) + 1;
    return m;
  }, [sites]);

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

      <ul className="dir-list">
        {items.map((s) => (
          <li key={s.domain} className="dir-row">
            <Favicon domain={s.domain} size={14} />
            <div className="dir-main">
              <a className="dir-title truncate" href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>
                {shortTitle(s.title)}
              </a>
              <span className="dir-sub truncate" title={s.description}>
                {s.domain} · {s.description}
              </span>
            </div>
            {s.era === 'pre-llm' && <span className="tag">pre-LLM</span>}
            {s.is18Plus && <span className="tag tag-danger">18+</span>}
            <button type="button" className="icon-btn ghost" title="Read clean" aria-label={`Read ${s.domain}`} onClick={() => onRead(s.url)}>
              <BookOpen size={13} />
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p className="empty">No sites match.</p>}
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
  const features = useFeatures();
  const [q, setQ] = useState('');
  const [order, setOrder] = useState<'posts' | 'random' | 'name'>('posts');
  const [origin, setOrigin] = useState('');
  const [origins, setOrigins] = useState<NonNullable<DirPage['origins']>>([]);
  const [items, setItems] = useState<DirItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [directoriesLoading, setDirectoriesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ kind, q, order, offset: String(offset), limit: String(PAGE), nsfw: String(uncensored) });
        if (origin) params.set('origin', origin);
        const page = await api<DirPage>(`/api/deep/sites?${params}`);
        if (id !== reqId.current) return;
        if (!page.available) setError(page.errors?.[0] || 'The deep index is not available on this system.');
        else setError(page.errors?.length ? `Some directories didn't load: ${page.errors.join('; ')}` : null);
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
        setOrigins(page.origins ?? []);
        setDirectoriesLoading(Boolean(page.loading));
        onCounts(page.counts);
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [kind, q, order, origin, uncensored, onCounts]
  );

  useEffect(() => {
    const t = setTimeout(() => void load(0), q ? 180 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // While Lemmy and Discourse load in the background, refresh the first page so they appear.
  useEffect(() => {
    if (!directoriesLoading || items.length > PAGE) return;
    const t = setTimeout(() => void load(0), 4000);
    return () => clearTimeout(t);
  }, [directoriesLoading, items.length, load]);

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

      {origins.length > 1 && (
        <div className="chips" role="group" aria-label="Where these come from">
          <button type="button" className={`chip ${origin === '' ? 'active' : ''}`} aria-pressed={origin === ''} onClick={() => setOrigin('')}>
            All
          </button>
          {origins.map((o) => (
            <button
              key={o.origin}
              type="button"
              className={`chip ${origin === o.origin ? 'active' : ''}`}
              aria-pressed={origin === o.origin}
              onClick={() => setOrigin(origin === o.origin ? '' : o.origin)}
            >
              {ORIGIN_LABEL[o.origin] || o.origin} <span className="count">{fmt(o.sources)}</span>
            </button>
          ))}
        </div>
      )}

      {error && <div className="notice notice-warn">{error}</div>}
      {directoriesLoading && !error && <div className="notice">Still loading the Lemmy and Discourse directories; they appear here as they arrive.</div>}

      <ul className="dir-list" aria-busy={loading}>
        {items.map((it) => (
          <li key={it.id} className="dir-row">
            <Favicon domain={it.site} size={14} />
            <div className="dir-main">
              <a className="dir-title truncate" href={siteUrl(it)} target="_blank" rel="noreferrer noopener">
                {dirTitle(it) || it.site}
              </a>
              <span className="dir-sub truncate">
                {dirTitle(it) ? it.site : ''}
                {dirTitle(it) && ' · '}
                {ORIGIN_LABEL[it.origin] || it.origin}
              </span>
            </div>
            {it.nsfw ? <span className="tag tag-danger">18+</span> : null}
            <span className="dir-meta">
              {it.posts > 0 ? plural(it.posts, 'post') : !features.administration ? '' : it.status === 'no-feed' ? 'no feed' : it.status === 'error' ? 'failing' : it.fetched_at ? '' : 'not crawled'}
              {it.fetched_at ? ` · ${relativeDate(new Date(it.fetched_at).toISOString())}` : ''}
            </span>
            <button type="button" className="icon-btn ghost" title="Read clean" aria-label={`Read ${it.site}`} onClick={() => onRead(siteUrl(it))}>
              <BookOpen size={13} />
            </button>
            {features.administration && it.origin === 'user' && (
              <button
                type="button"
                className="icon-btn ghost"
                title="Remove source"
                aria-label={`Remove ${it.site}`}
                onClick={async () => {
                  try {
                    await api(`/api/deep/sources/${it.id}`, { method: 'DELETE' });
                    setItems((prev) => prev.filter((x) => x.id !== it.id));
                    setTotal((n) => Math.max(0, n - 1));
                  } catch {
                    // ignore
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
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
  uncensored,
}: {
  status: DeepStatus | null;
  reload: () => Promise<void>;
  onToast?: (t: string, tone?: 'ok' | 'error' | 'info') => void;
  uncensored: boolean;
}) {
  const features = useFeatures();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [adult, setAdult] = useState(false);
  const opmlRef = useRef<HTMLInputElement>(null);

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

  const addSource = async (indexNow: boolean) => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const json: Record<string, unknown> = { url, nsfw: uncensored && adult };
      if (indexNow) json.indexNow = true;
      const { source, indexed } = await api<{ source: { kind: string; url: string }; indexed?: number }>('/api/deep/sources', {
        method: 'POST',
        json,
      });
      const kind = source.kind === 'board' ? 'a board' : source.kind === 'forum' ? 'a forum' : 'a blog';
      onToast?.(indexed ? `Added as ${kind} and indexed ${plural(indexed, 'post')}.` : `Added as ${kind}. It's crawled next.`, 'ok');
      setUrl('');
      await reload();
    } catch (err) {
      onToast?.((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const importOpml = async (file: File) => {
    setBusy(true);
    try {
      const res = await api<{ imported: number; total: number }>('/api/deep/opml', {
        method: 'POST',
        json: { xml: await file.text(), nsfw: uncensored && adult },
      });
      onToast?.(`Imported ${plural(res.imported, 'feed')} (${res.total} in OPML).`, 'ok');
      await reload();
    } catch (err) {
      onToast?.((err as Error).message, 'error');
    } finally {
      setBusy(false);
      if (opmlRef.current) opmlRef.current.value = '';
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
        {features.administration && <div className="row-gap">
          {status.seeding && <span className="muted">Loading the Lemmy and Discourse directories…</span>}
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
        </div>}
        {status.lastError && <p className="setting-hint">Last error: {status.lastError}</p>}
        <p className="setting-hint">
          Crawling stays off until you start it. glogg then reads each source's feed (one request per site at a time, at least a second apart, and only
          what changed) and keeps the text on this machine in ~/.glogg/deep.db. A first full pass over all ~56,000 sources takes roughly 3–4 hours and 1–1.5 GB; results
          appear as it goes, and searches answer from here in milliseconds.
        </p>
      </section>

      {features.administration && <section className="plugin-section">
        <h3 className="section-title">Add a source</h3>
        <form className="tool-form inline" onSubmit={(e) => { e.preventDefault(); void addSource(false); }}>
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
          <button type="button" className="btn" disabled={busy || !url.trim()} onClick={() => void addSource(true)}>
            Add &amp; index
          </button>
        </form>
        {uncensored && (
          <label className="check-row">
            <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
            18+ source: only shown in 18+ mode
          </label>
        )}
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => opmlRef.current?.click()}>
            <Upload size={13} /> Import OPML
          </button>
          <a className="btn btn-sm btn-ghost" href="/api/deep/opml" download="glogg-feeds.opml">
            <Download size={13} /> Export OPML
          </a>
          <input
            ref={opmlRef}
            type="file"
            accept=".opml,.xml"
            hidden
            aria-label="Import OPML file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importOpml(f);
            }}
          />
        </div>
        <p className="setting-hint">glogg works out what it is: an RSS/Atom/JSON feed, a Discourse forum, an imageboard catalog, or a page whose feed it can find.</p>
      </section>}

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
          <li>
            <a href="https://webring.xxiivv.com" target="_blank" rel="noreferrer">XXIIVV webring</a>: hand-made personal sites
          </li>
          <li>
            <a href="https://lemmyverse.net" target="_blank" rel="noreferrer">Lemmyverse</a>: Lemmy communities with 100+ subscribers; ones it flags are left out
          </li>
          <li>
            <a href="https://discover.discourse.org" target="_blank" rel="noreferrer">Discourse Discover</a>: Discourse forums, read a page a second
          </li>
          <li>
            Imageboards checked by hand: 2ch, lainchan, wizchan, leftypol, uboachan, sushigirl, kissu. 100 Stack Exchange sites, paced as one
            site. 28 more Discourse forums, VOGONS, VCFed, Raspberry Pi and Arch forums, Lobsters and Tildes.
          </li>
        </ul>
        <p className="setting-hint">Sources and posts that advertise sexual material involving minors are never indexed, in any mode.</p>
      </section>
    </div>
  );
}
