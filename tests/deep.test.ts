/**
 * The deep index: parsers, store, crawler and search integration. Offline:
 * every feed, catalog and page is a fixture, the database lives in memory or
 * in a temp GLOGG_HOME.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempGloggHome } from './helpers.js';

useTempGloggHome();
const parse = await import('../server/deep/parse.js');
const { openDeepStore, ftsQuery, KEEP_POSTS } = await import('../server/deep/store.js');
const { DeepCrawler } = await import('../server/deep/crawler.js');
const deep = await import('../server/deep/index.js');
const sources = await import('../server/deep/sources.js');

type Route = { status?: number; body?: string; headers?: Record<string, string>; delayMs?: number };

/** A fetch that answers from a route table and records every request. */
function fakeFetch(routes: Record<string, Route | ((init: RequestInit) => Route)>) {
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
  const impl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, headers: (init.headers || {}) as Record<string, string>, at: Date.now() });
    const entry = routes[url];
    const r: Route = typeof entry === 'function' ? entry(init) : entry || { status: 404, body: 'not found' };
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    return new Response(r.status === 304 ? null : r.body ?? '', { status: r.status ?? 200, headers: r.headers });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Tiny Blog</title><link>https://tiny.example/</link>
  <item><title>Borrowing in Rust, explained slowly</title><link>/posts/borrowing</link>
    <description><![CDATA[<p>The <b>borrow checker</b> makes sure references never outlive data.</p>]]></description>
    <pubDate>Tue, 03 Sep 2024 10:00:00 GMT</pubDate></item>
  <item><title>Borrowing in Rust, explained slowly</title><link>/posts/borrowing</link></item>
  <item><title>No link here</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Garden</title>
  <link href="https://garden.example/" rel="alternate"/>
  <entry><title>Soldering a Game Boy backlight</title><link rel="alternate" href="https://garden.example/gb"/>
    <summary>Notes on the IPS kit.</summary><updated>2023-02-01T12:00:00Z</updated></entry>
</feed>`;

const RDF = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example/"><title>Old Site</title><link>https://old.example/</link></channel>
  <item rdf:about="https://old.example/1"><title>BBS door games</title><link>https://old.example/1</link><dc:date>2004-05-06</dc:date></item>
</rdf:RDF>`;

const CATALOG = JSON.stringify([
  {
    page: 1,
    threads: [
      { no: 1, sticky: 1, sub: 'Rules', com: 'Read the rules' },
      { no: 4242, sub: 'Vintage ThinkPad thread', com: 'Post your X200s<br>&gt;tfw no 7-row keyboard', time: 1_700_000_000, replies: 88 },
      { no: 4243, com: 'Anyone else restoring old Sound Blaster cards? Mine has a dead DAC and I need the driver disk images.' },
    ],
  },
]);

describe('parsers', () => {
  it('reads RSS 2.0: HTML stripped, relative links resolved, duplicates and linkless items dropped', () => {
    const f = parse.parseFeed(RSS, 'https://tiny.example/feed.xml');
    expect(f.title).toBe('Tiny Blog');
    expect(f.posts).toEqual([
      {
        url: 'https://tiny.example/posts/borrowing',
        title: 'Borrowing in Rust, explained slowly',
        summary: 'The borrow checker makes sure references never outlive data.',
        published: Date.parse('2024-09-03T10:00:00Z'),
      },
    ]);
  });

  it('reads Atom and RSS 1.0 (RDF)', () => {
    expect(parse.parseFeed(ATOM, 'https://garden.example/atom.xml').posts[0]).toMatchObject({
      url: 'https://garden.example/gb',
      title: 'Soldering a Game Boy backlight',
      summary: 'Notes on the IPS kit.',
    });
    expect(parse.parseFeed(RDF, 'https://old.example/rss').posts[0]).toMatchObject({ url: 'https://old.example/1', title: 'BBS door games' });
  });

  it('reads JSON Feed', () => {
    const f = parse.parseJsonFeed(
      { version: 'https://jsonfeed.org/version/1.1', title: 'J', home_page_url: 'https://j.example/', items: [{ url: '/a', title: 'A', content_text: 'Body' }] },
      'https://j.example/feed.json'
    );
    expect(f.posts).toEqual([{ url: 'https://j.example/a', title: 'A', summary: 'Body', published: undefined }]);
  });

  it('reads imageboard catalogs: text only, rules threads skipped, quotes decoded', () => {
    const posts = parse.parseChanCatalog(JSON.parse(CATALOG), (no) => `https://boards.example/g/thread/${no}`);
    expect(posts.map((p) => p.url)).toEqual(['https://boards.example/g/thread/4242', 'https://boards.example/g/thread/4243']);
    expect(posts[0]).toMatchObject({ title: 'Vintage ThinkPad thread', published: 1_700_000_000_000 });
    expect(posts[0].summary).toBe('Post your X200s >tfw no 7-row keyboard · 88 replies');
    expect(posts[1].title).toMatch(/^Anyone else restoring old Sound Blaster cards\? .*…$/);
    expect(parse.parseChanCatalog({ not: 'a catalog' }, String)).toEqual([]);
  });

  it('discovers feeds and recognises Discourse', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://cdn.example/atom">
      <link rel="alternate" type="application/rss+xml" href="/comments/feed">
      <meta name="generator" content="Discourse 3.4.0 - https://github.com/discourse/discourse"></head></html>`;
    expect(parse.discoverFeeds(html, 'https://site.example/blog/')).toEqual(['https://site.example/feed.xml', 'https://cdn.example/atom']);
    expect(parse.isDiscourse(html)).toBe(true);
    expect(parse.isDiscourse('<meta name="generator" content="WordPress 6">')).toBe(false);
  });

  it('reads the 512KB Club and Kagi Small Web lists', () => {
    expect(parse.parse512kbSites('- domain: tiny.example\n  url: https://tiny.example/\n  size: 12\n- domain: x.example\n')).toEqual([
      { domain: 'tiny.example', url: 'https://tiny.example/' },
    ]);
    expect(parse.parseFeedList('https://a.example/feed\n\n# comment\nhttp://b.example/rss.xml\n')).toEqual(['https://a.example/feed', 'http://b.example/rss.xml']);
  });
});

describe('store', () => {
  async function seeded() {
    const store = await openDeepStore(':memory:');
    store.addSources([
      { url: 'https://tiny.example/feed.xml', kind: 'blog', site: 'tiny.example', origin: 'test', intervalMin: 1440 },
      { url: 'https://boards.example/g/catalog.json', kind: 'board', site: 'boards.example', origin: 'test', intervalMin: 60, threadUrl: 'https://boards.example/g/thread/{no}' },
      { url: 'https://boards.example/h/catalog.json', kind: 'board', site: 'boards.example', origin: 'test', intervalMin: 60, nsfw: true },
      { url: 'https://forum.example/latest.rss', kind: 'forum', site: 'forum.example', origin: 'test', intervalMin: 180 },
    ]);
    const src = (url: string) => store.getSourceByUrl(url)!;
    store.savePosts(src('https://tiny.example/feed.xml'), [
      { url: 'https://tiny.example/borrow', title: 'Borrowing in Rust, explained slowly', summary: 'The borrow checker and lifetimes.' },
      { url: 'https://tiny.example/gb', title: 'Game Boy backlight mod', summary: 'IPS kit soldering.' },
    ]);
    store.savePosts(src('https://boards.example/g/catalog.json'), [{ url: 'https://boards.example/g/thread/1', title: 'Rust borrow checker rant', summary: 'it hates me' }]);
    store.savePosts(src('https://boards.example/h/catalog.json'), [{ url: 'https://boards.example/h/thread/2', title: 'borrow checker but lewd', summary: 'nsfw' }]);
    store.savePosts(src('https://forum.example/latest.rss'), [{ url: 'https://forum.example/t/1', title: 'Help with lifetimes', summary: 'borrowed value does not live long enough' }]);
    return store;
  }

  it('adds each source once and returns boards and forums before blogs', async () => {
    const store = await seeded();
    expect(store.addSources([{ url: 'https://tiny.example/feed.xml', kind: 'blog', site: 'tiny.example', origin: 'x', intervalMin: 1 }])).toBe(0);
    expect(store.dueSources(Date.now(), 10).map((s) => s.kind)).toEqual(['board', 'board', 'forum', 'blog']);
  });

  it('finds posts with stemming, highlights a snippet, and ranks title matches first', async () => {
    const store = await seeded();
    const hits = store.search(['borrowing'], { nsfw: false });
    expect(hits.map((h) => h.url)).toEqual(expect.arrayContaining(['https://tiny.example/borrow', 'https://boards.example/g/thread/1', 'https://forum.example/t/1']));
    expect(hits[0].title).toMatch(/borrow/i);
    expect(hits.find((h) => h.url === 'https://forum.example/t/1')?.snippet).toContain('borrowed value');
  });

  it('keeps 18+ boards out unless asked, and filters by kind', async () => {
    const store = await seeded();
    expect(store.search(['borrow'], { nsfw: false }).some((h) => h.nsfw)).toBe(false);
    expect(store.search(['borrow'], { nsfw: true }).some((h) => h.url.includes('/h/'))).toBe(true);
    expect(store.search(['borrow'], { kinds: ['forum'] }).map((h) => h.kind)).toEqual(['forum']);
  });

  it('falls back to any-word matches, and survives query syntax in user input', async () => {
    const store = await seeded();
    expect(store.search(['backlight', 'zeppelin']).map((h) => h.url)).toEqual(['https://tiny.example/gb']);
    expect(() => store.search(['"NEAR(', 'OR', '*', 'col:'])).not.toThrow();
    expect(ftsQuery(['a"b', 'cd*', 'x'], 'or')).toBe('"a b" OR "cd"');
  });

  it('updates posts in place and keeps only the newest per source', async () => {
    const store = await openDeepStore(':memory:');
    store.addSources([{ url: 'https://f.example/rss', kind: 'blog', site: 'f.example', origin: 't', intervalMin: 1 }]);
    const s = store.getSourceByUrl('https://f.example/rss')!;
    const many = Array.from({ length: KEEP_POSTS.blog + 10 }, (_, i) => ({ url: `https://f.example/${i}`, title: `Post ${i}`, summary: 'x', published: i * 1000 }));
    expect(store.savePosts(s, many)).toBe(KEEP_POSTS.blog);
    expect(store.search(['Post']).length).toBeGreaterThan(0);
    store.savePosts(s, [{ url: `https://f.example/${KEEP_POSTS.blog + 9}`, title: 'Renamed newest', summary: 'y', published: 1e12 }]);
    expect(store.search(['Renamed'])).toHaveLength(1);
    expect(store.getSourceByUrl('https://f.example/rss')!.posts).toBe(KEEP_POSTS.blog);
  });

  it('lists the directory with filters, paging and per-kind stats', async () => {
    const store = await seeded();
    expect(store.listSources({ kind: 'board' }).total).toBe(1);
    expect(store.listSources({ kind: 'board', nsfw: true }).total).toBe(2);
    expect(store.listSources({ q: 'forum' }).items).toHaveLength(1);
    expect(store.listSources({ limit: 2, offset: 2 }).items).toHaveLength(1);
    const kinds = Object.fromEntries(store.stats().byKind.map((k) => [k.kind, k.posts]));
    expect(kinds).toMatchObject({ blog: 2, board: 2, forum: 1 });
  });

  it('picks a random post that respects the 18+ gate', async () => {
    const store = await seeded();
    for (let i = 0; i < 20; i++) expect(store.randomPost({ nsfw: false })?.nsfw).toBe(false);
  });
});

describe('crawler: one visit', () => {
  async function storeWith(input: Parameters<Awaited<ReturnType<typeof openDeepStore>>['addSources']>[0][number]) {
    const store = await openDeepStore(':memory:');
    store.addSources([input]);
    return { store, row: () => store.getSourceByUrl(input.url)! };
  }

  it('indexes a feed, then sends conditional headers and accepts 304', async () => {
    const { store, row } = await storeWith({ url: 'https://tiny.example/feed.xml', kind: 'blog', site: 'tiny.example', origin: 't', intervalMin: 1440 });
    const { impl, calls } = fakeFetch({
      'https://tiny.example/feed.xml': (init) =>
        (init.headers as Record<string, string>)['If-None-Match'] === '"v1"' ? { status: 304 } : { body: RSS, headers: { ETag: '"v1"' } },
    });
    const crawler = new DeepCrawler(store, { fetch: impl });
    expect(await crawler.visit(row())).toBe('ok');
    expect(row()).toMatchObject({ status: 'ok', etag: '"v1"', posts: 1, title: 'Tiny Blog', fails: 0 });
    expect(calls[0].headers['User-Agent']).toMatch(/^glogg-deep\//);
    expect(await crawler.visit(row())).toBe('unchanged');
    expect(calls[1].headers['If-None-Match']).toBe('"v1"');
    expect(row().next_at - Date.now()).toBeGreaterThan(20 * 60 * 60_000);
  });

  it('indexes a board catalog with real thread links', async () => {
    const { store, row } = await storeWith({
      url: 'https://a.4cdn.org/g/catalog.json',
      kind: 'board',
      site: 'boards.4chan.org',
      origin: '4chan',
      intervalMin: 60,
      threadUrl: 'https://boards.4chan.org/g/thread/{no}',
    });
    const { impl } = fakeFetch({ 'https://a.4cdn.org/g/catalog.json': { body: CATALOG, headers: { 'Last-Modified': 'Sat, 01 Jun 2024 10:00:00 GMT' } } });
    expect(await new DeepCrawler(store, { fetch: impl }).visit(row())).toBe('ok');
    expect(store.search(['thinkpad'])[0].url).toBe('https://boards.4chan.org/g/thread/4242');
    expect(row().last_modified).toBe('Sat, 01 Jun 2024 10:00:00 GMT');
  });

  it('turns a plain site into its feed, and a Discourse page into its forum feed', async () => {
    const { store, row } = await storeWith({ url: 'https://tiny.example/', kind: 'site', site: 'tiny.example', origin: '512kb', intervalMin: 43200 });
    const { impl } = fakeFetch({ 'https://tiny.example/': { body: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">' } });
    expect(await new DeepCrawler(store, { fetch: impl }).visit(row())).toBe('moved');
    expect(row().status).toBe('feed-found');
    expect(store.getSourceByUrl('https://tiny.example/feed.xml')).toMatchObject({ kind: 'blog', origin: '512kb' });

    const d = await storeWith({ url: 'https://talk.example/', kind: 'site', site: 'talk.example', origin: 'user', intervalMin: 43200 });
    const df = fakeFetch({ 'https://talk.example/': { body: '<meta name="generator" content="Discourse 3.4">' } });
    await new DeepCrawler(d.store, { fetch: df.impl }).visit(d.row());
    expect(d.store.getSourceByUrl('https://talk.example/latest.rss')).toMatchObject({ kind: 'forum' });
  });

  it('retries network hiccups soon and explains failures in words', async () => {
    const { store, row } = await storeWith({ url: 'https://flaky.example/rss', kind: 'blog', site: 'flaky.example', origin: 't', intervalMin: 1440 });
    const err = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
    let code = 'UND_ERR_CONNECT_TIMEOUT';
    const crawler = new DeepCrawler(store, { fetch: (async () => { throw err(code); }) as unknown as typeof fetch });
    await crawler.visit(row());
    expect(row()).toMatchObject({ status: 'retry', fails: 0, error: "couldn't connect in time (UND_ERR_CONNECT_TIMEOUT)" });
    expect(row().next_at - Date.now()).toBeLessThan(21 * 60_000);
    code = 'ENOTFOUND';
    await crawler.visit(row());
    expect(row()).toMatchObject({ status: 'error', fails: 1, error: 'domain no longer exists (ENOTFOUND)' });
  });

  it('backs off exponentially on errors and honours Retry-After', async () => {
    const { store, row } = await storeWith({ url: 'https://down.example/rss', kind: 'blog', site: 'down.example', origin: 't', intervalMin: 60 });
    const { impl } = fakeFetch({ 'https://down.example/rss': { status: 500 } });
    const crawler = new DeepCrawler(store, { fetch: impl });
    await crawler.visit(row());
    const first = row().next_at - Date.now();
    await crawler.visit(row());
    const second = row().next_at - Date.now();
    expect(row()).toMatchObject({ fails: 2, status: 'error', error: 'HTTP 500' });
    expect(second).toBeGreaterThan(first * 1.8);

    const limited = await storeWith({ url: 'https://busy.example/rss', kind: 'blog', site: 'busy.example', origin: 't', intervalMin: 60 });
    const lf = fakeFetch({ 'https://busy.example/rss': { status: 429, headers: { 'Retry-After': '3600' } } });
    await new DeepCrawler(limited.store, { fetch: lf.impl }).visit(limited.row());
    expect(limited.row().status).toBe('rate-limited');
    expect(limited.row().next_at - Date.now()).toBeGreaterThan(59 * 60_000);
  });
});

describe('crawler: scheduling', () => {
  it('never hits one host twice at once, and spaces its requests', async () => {
    const store = await openDeepStore(':memory:');
    const urls = ['https://same.example/a', 'https://same.example/b', 'https://same.example/c', 'https://other.example/a', 'https://third.example/a'];
    store.addSources(urls.map((url) => ({ url, kind: 'blog' as const, site: new URL(url).host, origin: 't', intervalMin: 1440 })));
    let inFlightSame = 0;
    let maxInFlightSame = 0;
    const { impl, calls } = fakeFetch(
      Object.fromEntries(
        urls.map((u) => [
          u,
          () => {
            if (u.includes('same.')) {
              inFlightSame += 1;
              maxInFlightSame = Math.max(maxInFlightSame, inFlightSame);
              setTimeout(() => (inFlightSame -= 1), 15);
            }
            return { body: RSS, delayMs: 15 };
          },
        ])
      )
    );
    const crawler = new DeepCrawler(store, { fetch: impl, hostGapMs: 80, concurrency: 4 });
    crawler.start();
    const until = Date.now() + 3000;
    while (crawler.counts.visited < urls.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    crawler.pause();
    expect(crawler.counts.visited).toBe(urls.length);
    expect(maxInFlightSame).toBe(1);
    const same = calls.filter((c) => c.url.includes('same.')).map((c) => c.at);
    for (let i = 1; i < same.length; i++) expect(same[i] - same[i - 1]).toBeGreaterThanOrEqual(80);
    // Other hosts weren't held up behind the slow one.
    expect(calls.find((c) => c.url.includes('other.'))!.at - calls[0].at).toBeLessThan(60);
  });
});

describe('deep index service', () => {
  beforeEach(() => {
    deep.resetDeepIndex();
    useTempGloggHome();
  });
  afterAll(() => deep.resetDeepIndex());

  it('loads the open directories once a week and reports failures', async () => {
    const { impl } = fakeFetch({
      [sources.SEED_LISTS.smallweb.url]: { body: 'https://a.example/feed\nhttps://b.example/rss.xml\n' },
      [sources.SEED_LISTS.club512.url]: { body: '- domain: tiny.example\n  url: https://tiny.example/\n' },
      [sources.SEED_LISTS.fourchan.url]: { body: JSON.stringify({ boards: [{ board: 'g', title: 'Technology', ws_board: 1 }, { board: 'b', title: 'Random', ws_board: 0 }] }) },
    });
    const first = await deep.ensureSeeded({ fetch: impl });
    expect(first.errors).toEqual([]);
    expect(first.added).toBe(sources.builtinSources().length + 2 + 1 + 2);
    expect((await deep.ensureSeeded({ fetch: impl })).added).toBe(0);
    const store = (await deep.getDeepStore())!;
    expect(store.getSourceByUrl('https://a.4cdn.org/b/catalog.json')).toMatchObject({ nsfw: 1, thread_url: 'https://boards.4chan.org/b/thread/{no}' });

    deep.resetDeepIndex();
    useTempGloggHome();
    const broken = fakeFetch({});
    const partial = await deep.ensureSeeded({ fetch: broken.impl });
    expect(partial.errors).toHaveLength(3);
    expect((await deep.getDeepStore())!.getMeta('seeded_at')).toBeUndefined();
  });

  it.each([
    ['a feed', 'https://tiny.example/feed.xml', { body: RSS }, { kind: 'blog', url: 'https://tiny.example/feed.xml' }],
    ['a Discourse feed', 'https://talk.example/latest.rss', { body: '<rss xmlns:discourse="http://www.discourse.org/">' }, { kind: 'forum' }],
    ['a Discourse page', 'https://talk.example/', { body: '<meta name="generator" content="Discourse 3.4">' }, { kind: 'forum', url: 'https://talk.example/latest.rss' }],
    ['a page with a feed link', 'https://tiny.example/', { body: '<link rel="alternate" type="application/atom+xml" href="/atom.xml">' }, { kind: 'blog', url: 'https://tiny.example/atom.xml' }],
    ['a board catalog', 'https://chan.example/tech/catalog.json', { body: CATALOG }, { kind: 'board', thread_url: 'https://chan.example/tech/res/{no}.html' }],
  ])('adds %s', async (_label, url, route, expected) => {
    const { impl } = fakeFetch({ [url]: route as Route });
    expect(await deep.addUserSource(url, impl)).toMatchObject({ ...expected, origin: 'user', next_at: 0 });
  });

  it('says why a URL could not be added', async () => {
    const { impl } = fakeFetch({ 'https://plain.example/': { body: '<html>just a page</html>' }, 'https://gone.example/': { status: 410 } });
    await expect(deep.addUserSource('plain.example', impl)).rejects.toThrow(/No feed, forum or board found/);
    await expect(deep.addUserSource('https://gone.example/', impl)).rejects.toThrow(/HTTP 410/);
    await expect(deep.addUserSource('ftp://x.example/', impl)).rejects.toThrow(/Only http/);
  });

  it('feeds matching posts into search, mapped to their source type and 18+ gated', async () => {
    const store = (await deep.getDeepStore())!;
    store.addSources([
      { url: 'https://tiny.example/feed.xml', kind: 'blog', site: 'tiny.example', origin: 't', intervalMin: 1440 },
      { url: 'https://boards.example/b/catalog.json', kind: 'board', site: 'boards.example', origin: 't', intervalMin: 60, nsfw: true },
    ]);
    store.savePosts(store.getSourceByUrl('https://tiny.example/feed.xml')!, [{ url: 'https://tiny.example/sb16', title: 'Sound Blaster 16 driver disks', summary: 'Restoring a CT2230.', published: 1e12 }]);
    store.savePosts(store.getSourceByUrl('https://boards.example/b/catalog.json')!, [{ url: 'https://boards.example/b/thread/9', title: 'sound blaster nostalgia', summary: '18+ board' }]);
    const safe = await deep.searchDeep('vintage sound blaster drivers');
    expect(safe).toEqual([expect.objectContaining({ url: 'https://tiny.example/sb16', source: 'deep-blogs', isNsfw: false, tags: ['tiny.example'] })]);
    const all = await deep.searchDeep('sound blaster', { nsfw: true });
    expect(all.map((r) => r.source).sort()).toEqual(['deep-blogs', 'deep-boards']);
  });

  it('shows up in federated search results, without the network', async () => {
    const store = (await deep.getDeepStore())!;
    store.addSources([{ url: 'https://tiny.example/feed.xml', kind: 'blog', site: 'tiny.example', origin: 't', intervalMin: 1440 }]);
    store.savePosts(store.getSourceByUrl('https://tiny.example/feed.xml')!, [
      { url: 'https://tiny.example/sb16', title: 'Sound Blaster 16 driver disks archived', summary: 'Every Sound Blaster driver disk image, restored and checked.', published: 1e12 },
    ]);
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    try {
      const { executeFederatedSearch } = await import('../server/federatedSearch.js');
      const res = await executeFederatedSearch('sound blaster driver disks', { lens: 'small-web' });
      expect(res.results.some((r) => r.url === 'https://tiny.example/sb16' && r.source === 'deep-blogs')).toBe(true);
      expect(res.metrics.sourceTimings?.deep).toMatchObject({ status: 'ok', count: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never creates a database just to answer a search', async () => {
    expect(await deep.searchDeep('anything')).toEqual([]);
    const fs = await import('node:fs');
    expect(fs.existsSync(deep.deepDbPath())).toBe(false);
  });
});

describe('verified source lists', () => {
  it('ships unique, https sources with thread links for every board', () => {
    const list = sources.builtinSources();
    expect(new Set(list.map((s) => s.url)).size).toBe(list.length);
    for (const s of list) {
      expect(s.url).toMatch(/^https:\/\//);
      if (s.kind === 'board') expect(s.threadUrl).toContain('{no}');
    }
    expect(list.filter((s) => s.kind === 'forum').length).toBeGreaterThanOrEqual(30);
    expect(list.filter((s) => s.kind === 'board').length).toBeGreaterThanOrEqual(16);
  });
});

beforeAll(() => {
  // Some suites above build their own stores; make sure nothing leaks between them.
  deep.resetDeepIndex();
});
