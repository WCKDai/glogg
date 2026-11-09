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
const { isBlockedPost, isBlockedSource } = await import('../server/deep/blocklist.js');
const { politenessSlot } = await import('../server/deep/crawler.js');

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

/** 2ch's catalog shape, trimmed from a live /pr/ response. */
const DVACH = JSON.stringify({
  board: { id: 'pr', name: 'Программирование' },
  threads: [
    { num: 1, sticky: 1, subject: 'Правила', comment: 'Rules' },
    { num: 3787886, subject: 'Rust thread', comment: 'Изучаем <b>Rust</b><br>borrow checker', timestamp: 1_793_420_054, posts_count: 36, sticky: 0 },
  ],
});

const WEBRING = `<ol id="icons">
  <li data-lang="en" id="a"><a href="https://wiki.example">wiki</a> <a href="https://wiki.example/links/img.xml" class="rss">rss</a> <img src="b.gif"></li>
  <li data-lang="en" id="b"><a href="https://tiny.example">tiny site</a></li>
  <li><span>no link</span></li>
</ol>`;

const LEMMY = [
  { baseurl: 'lemmy.example', name: 'retrocomputing', title: 'Retro  Computing', nsfw: false, isSuspicious: false, counts: { subscribers: 5000 } },
  { baseurl: 'lemmy.example', name: 'tiny', title: 'Tiny', counts: { subscribers: 12 } },
  { baseurl: 'spam.example', name: 'buy', title: 'Buy now', isSuspicious: true, counts: { subscribers: 9000 } },
  { baseurl: 'lemmy.example', name: 'figure_drawing', title: 'Figure drawing', nsfw: true, counts: { subscribers: 300 } },
  { baseurl: 'lemmynsfw.example', name: 'pics', title: 'Pics', nsfw: false, counts: { subscribers: 800 } },
  { baseurl: 'bad host/x', name: 'x', counts: { subscribers: 999 } },
];

const DISCOVER_1 = {
  topic_list: {
    topics: [
      { title: 'Retro Club', featured_link: 'https://forum.retro.example/' },
      { title: 'Sub Forum', featured_link: 'https://example.org/community/t/welcome/5' },
      { title: 'No link' },
      { title: 'After Dark', featured_link: 'https://late.example', tags: [{ name: 'nsfw' }] },
    ],
    more_topics_url: '/latest?no_definitions=true&page=1',
  },
};
const DISCOVER_2 = { topic_list: { topics: [{ title: 'Retro Club again', featured_link: 'https://forum.retro.example' }, { title: 'Last', featured_link: 'https://last.example' }] } };

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

  it("reads 2ch's catalog shape: its own field names, the opening post not counted as a reply", () => {
    const posts = parse.parseChanCatalog(JSON.parse(DVACH), (no) => `https://2ch.su/pr/res/${no}.html`);
    expect(posts).toEqual([
      { url: 'https://2ch.su/pr/res/3787886.html', title: 'Rust thread', summary: 'Изучаем Rust borrow checker · 35 replies', published: 1_793_420_054_000 },
    ]);
  });

  it('reads the XXIIVV webring, with each member\'s feed when listed', () => {
    expect(parse.parseWebring(WEBRING, 'https://webring.xxiivv.com/')).toEqual([
      { name: 'wiki', url: 'https://wiki.example/', feed: 'https://wiki.example/links/img.xml' },
      { name: 'tiny site', url: 'https://tiny.example/', feed: undefined },
    ]);
    expect(sources.sourcesFromWebring(WEBRING)).toEqual([
      expect.objectContaining({ url: 'https://wiki.example/links/img.xml', kind: 'blog', site: 'wiki.example', origin: 'xxiivv', title: 'wiki' }),
      expect.objectContaining({ url: 'https://tiny.example/', kind: 'site', site: 'tiny.example', origin: 'xxiivv', title: 'tiny site' }),
    ]);
  });

  it('takes Lemmy communities with an audience, biggest first, leaving out flagged ones and gating 18+', () => {
    const list = sources.sourcesFromLemmyverse(LEMMY);
    expect(list.map((s) => s.url)).toEqual([
      'https://lemmy.example/feeds/c/retrocomputing.xml?sort=New',
      'https://lemmynsfw.example/feeds/c/pics.xml?sort=New',
      'https://lemmy.example/feeds/c/figure_drawing.xml?sort=New',
    ]);
    expect(list[0]).toMatchObject({ kind: 'forum', site: 'lemmy.example', origin: 'lemmy', title: 'Retro Computing', nsfw: false });
    expect(list.slice(1).every((s) => s.nsfw)).toBe(true);
    expect(parse.parseLemmyverse({ not: 'a list' })).toEqual([]);
  });

  it('reads Discourse Discover pages: forum roots, 18+ tags and the next page', () => {
    const page = parse.parseDiscourseDirectory(DISCOVER_1, 'https://discover.discourse.org/latest.json');
    expect(page.forums).toEqual([
      { url: 'https://forum.retro.example', title: 'Retro Club', nsfw: false },
      { url: 'https://example.org/community', title: 'Sub Forum', nsfw: false },
      { url: 'https://late.example', title: 'After Dark', nsfw: true },
    ]);
    expect(page.next).toBe('https://discover.discourse.org/latest.json?no_definitions=true&page=1');
    expect(parse.parseDiscourseDirectory(DISCOVER_2, 'https://discover.discourse.org/latest.json').next).toBeUndefined();
    expect(sources.sourcesFromDiscourseDirectory(page.forums).map((s) => s.url)).toEqual([
      'https://forum.retro.example/latest.rss',
      'https://example.org/community/latest.rss',
      'https://late.example/latest.rss',
    ]);
  });
});

describe('blocklist', () => {
  it.each([
    [{ url: 'https://lemmy.example/feeds/c/jail_bait.xml?sort=New' }],
    [{ url: 'https://x.example/feed', title: 'Loli art dump' }],
    [{ url: 'https://pthc.example/' }],
    [{ url: 'https://chan.example/cp-links/catalog.json' }],
    [{ url: 'https://f.example/rss', site: 'f.example', title: 'Underage pics' }],
  ])('never stores %j', (source) => {
    expect(isBlockedSource(source)).toBe(true);
  });

  it.each([
    [{ url: 'https://books.example/feed', title: 'Lolita (Nabokov) reading group' }],
    [{ url: 'https://shota.dev/feed.xml', title: 'Shota Imanaga fan blog' }],
    [{ url: 'https://unix.example/feed', title: 'cp, mv and rsync tips' }],
    [{ url: 'https://run.example/rss', title: 'Pedometer reviews' }],
  ])('keeps ordinary names like %j', (source) => {
    expect(isBlockedSource(source)).toBe(false);
  });

  it('drops trading jargon from posts but keeps news about abuse searchable', () => {
    expect(isBlockedPost({ title: 'pthc links inside', summary: '' })).toBe(true);
    expect(isBlockedPost({ title: 'Man arrested over child abuse images', summary: 'Police said the investigation took two years.' })).toBe(false);
  });

  it('is enforced by the store, whatever adds the source or post', async () => {
    const store = await openDeepStore(':memory:');
    expect(
      store.addSources([
        { url: 'https://lemmy.example/feeds/c/jailbait.xml', kind: 'forum', site: 'lemmy.example', origin: 'lemmy', intervalMin: 720 },
        { url: 'https://ok.example/rss', kind: 'blog', site: 'ok.example', origin: 't', intervalMin: 1440 },
      ])
    ).toBe(1);
    const src = store.getSourceByUrl('https://ok.example/rss')!;
    expect(
      store.savePosts(src, [
        { url: 'https://ok.example/1', title: 'hussyfan pack', summary: '' },
        { url: 'https://ok.example/2', title: 'Restoring a Sound Blaster', summary: 'Recapping the board.' },
      ])
    ).toBe(1);
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

  it('skips sites the crawler is waiting on when picking due sources', async () => {
    const store = await seeded();
    expect(store.dueSources(Date.now(), 10, ['boards.example']).map((s) => s.site)).toEqual(['forum.example', 'tiny.example']);
  });

  it('filters the directory by where sources came from, and counts each origin', async () => {
    const store = await openDeepStore(':memory:');
    store.addSources([
      { url: 'https://a.example/latest.rss', kind: 'forum', site: 'a.example', origin: 'discourse', intervalMin: 180 },
      { url: 'https://l.example/feeds/c/x.xml', kind: 'forum', site: 'l.example', origin: 'lemmy', intervalMin: 720 },
      { url: 'https://l.example/feeds/c/y.xml', kind: 'forum', site: 'l.example', origin: 'lemmy', intervalMin: 720 },
      { url: 'https://l.example/feeds/c/z.xml', kind: 'forum', site: 'l.example', origin: 'lemmy', intervalMin: 720, nsfw: true },
    ]);
    expect(store.listSources({ kind: 'forum', origin: 'lemmy' }).total).toBe(2);
    expect(store.originCounts('forum')).toEqual([
      { origin: 'lemmy', sources: 2 },
      { origin: 'discourse', sources: 1 },
    ]);
    expect(store.originCounts('forum', true)[0]).toEqual({ origin: 'lemmy', sources: 3 });
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

  it('gives board catalogs more room than feeds: big catalogs still parse', async () => {
    const { store, row } = await storeWith({ url: 'https://chan.example/pol/catalog.json', kind: 'board', site: 'chan.example', origin: 't', intervalMin: 60 });
    const { impl } = fakeFetch({ 'https://chan.example/pol/catalog.json': { body: CATALOG } });
    expect(await new DeepCrawler(store, { fetch: impl, maxBytes: 100 }).visit(row())).toBe('ok');
    expect(row().posts).toBe(2);
  });

  it('keeps an 18+ source\'s discovered feed behind the 18+ switch', async () => {
    const { store, row } = await storeWith({ url: 'https://late.example/', kind: 'site', site: 'late.example', origin: 'user', intervalMin: 43200, nsfw: true });
    const { impl } = fakeFetch({ 'https://late.example/': { body: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">' } });
    await new DeepCrawler(store, { fetch: impl }).visit(row());
    expect(store.getSourceByUrl('https://late.example/feed.xml')).toMatchObject({ nsfw: 1 });
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

  it("doesn't let one big site (thousands of communities on one instance) stall the rest", async () => {
    const store = await openDeepStore(':memory:');
    const big = Array.from({ length: 320 }, (_, i) => `https://big.example/feeds/c/${i}.xml`);
    const others = ['https://one.example/rss', 'https://two.example/rss', 'https://three.example/rss'];
    store.addSources([...big, ...others].map((url) => ({ url, kind: 'forum' as const, site: new URL(url).host, origin: 't', intervalMin: 720 })));
    const { impl, calls } = fakeFetch(Object.fromEntries([...big, ...others].map((u) => [u, { body: RSS }])));
    const crawler = new DeepCrawler(store, { fetch: impl, hostGapMs: 200, concurrency: 4 });
    const t0 = Date.now();
    crawler.start();
    while (calls.filter((c) => !c.url.includes('big.')).length < others.length && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    crawler.pause();
    // Before the fix the batch held only big.example (one request per 200 ms), so the others waited behind 300 of them.
    expect(Date.now() - t0).toBeLessThan(400);
    expect(calls.filter((c) => c.url.includes('big.')).length).toBeLessThanOrEqual(3);
  });

  it('paces sites that share a backend as one host', () => {
    expect(politenessSlot('https://unix.stackexchange.com/feeds')).toBe('stackexchange');
    expect(politenessSlot('https://stackoverflow.com/feeds')).toBe('stackexchange');
    expect(politenessSlot('https://www.vogons.org/app.php/feed')).toBe('vogons.org');
  });
});

describe('deep index service', () => {
  beforeEach(() => {
    deep.resetDeepIndex();
    useTempGloggHome();
  });
  afterAll(() => deep.resetDeepIndex());

  const directoryRoutes = (): Record<string, Route> => ({
    [sources.SEED_LISTS.smallweb.url]: { body: 'https://a.example/feed\nhttps://b.example/rss.xml\n' },
    [sources.SEED_LISTS.club512.url]: { body: '- domain: tiny.example\n  url: https://tiny.example/\n' },
    [sources.SEED_LISTS.fourchan.url]: { body: JSON.stringify({ boards: [{ board: 'g', title: 'Technology', ws_board: 1 }, { board: 'b', title: 'Random', ws_board: 0 }] }) },
    [sources.SEED_LISTS.webring.url]: { body: WEBRING },
    [sources.SEED_LISTS.lemmy.url]: { body: JSON.stringify(LEMMY) },
    [sources.SEED_LISTS.discourse.url]: { body: JSON.stringify(DISCOVER_1) },
    'https://discover.discourse.org/latest.json?no_definitions=true&page=1': { body: JSON.stringify(DISCOVER_2) },
  });

  it('loads the open directories once a week, paging Discourse Discover', async () => {
    const { impl } = fakeFetch(directoryRoutes());
    const first = await deep.ensureSeeded({ fetch: impl, wait: true });
    expect(first.errors).toEqual([]);
    // builtins + small web 2 + 512KB 1 + 4chan 2 + webring 1 (tiny.example is in the 512KB Club too, stored once)
    // + Lemmy 3 + Discourse 4 (one forum is listed on both pages)
    expect(first.added).toBe(sources.builtinSources().length + 2 + 1 + 2 + 1 + 3 + 4);
    expect((await deep.ensureSeeded({ fetch: impl, wait: true })).added).toBe(0);
    const store = (await deep.getDeepStore())!;
    expect(store.getSourceByUrl('https://a.4cdn.org/b/catalog.json')).toMatchObject({ nsfw: 1, thread_url: 'https://boards.4chan.org/b/thread/{no}' });
    expect(store.getSourceByUrl('https://last.example/latest.rss')).toMatchObject({ kind: 'forum', origin: 'discourse', title: 'Last' });
    expect(store.getMeta('seeded_at')).toBeTruthy();
  });

  it("doesn't make the Atlas wait for the big directories", async () => {
    const routes = directoryRoutes();
    routes[sources.SEED_LISTS.lemmy.url] = { ...routes[sources.SEED_LISTS.lemmy.url], delayMs: 400 };
    const { impl } = fakeFetch(routes);
    const t0 = Date.now();
    const quick = await deep.ensureSeeded({ fetch: impl });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(quick.loading).toBe(true);
    const store = (await deep.getDeepStore())!;
    expect(store.getSourceByUrl('https://a.example/feed')).toBeTruthy();
    expect(store.getSourceByUrl('https://lemmy.example/feeds/c/retrocomputing.xml?sort=New')).toBeUndefined();
    const seeding = async () => {
      const st = await deep.deepStatus();
      return st.available && st.seeding;
    };
    while (await seeding()) await new Promise((r) => setTimeout(r, 25));
    expect(store.getSourceByUrl('https://lemmy.example/feeds/c/retrocomputing.xml?sort=New')).toBeTruthy();
  });

  it('reports each directory that failed, and retries it later rather than on every page load', async () => {
    const broken = fakeFetch({});
    const partial = await deep.ensureSeeded({ fetch: broken.impl, wait: true });
    expect(partial.errors).toHaveLength(6);
    expect(partial.errors.join(' ')).toContain('data.lemmyverse.net: HTTP 404');
    expect((await deep.getDeepStore())!.getMeta('seeded_at')).toBeUndefined();
    const before = broken.calls.length;
    expect((await deep.ensureSeeded({ fetch: broken.impl, wait: true })).errors).toHaveLength(6);
    expect(broken.calls.length).toBe(before);
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

  it("adds a 2ch-style catalog as a board, and keeps a source marked 18+ behind the switch", async () => {
    const { impl } = fakeFetch({ 'https://2ch.su/pr/catalog.json': { body: DVACH }, 'https://late.example/feed.xml': { body: RSS } });
    expect(await deep.addUserSource('https://2ch.su/pr/catalog.json', impl)).toMatchObject({ kind: 'board', thread_url: 'https://2ch.su/pr/res/{no}.html', nsfw: 0 });
    expect(await deep.addUserSource('https://late.example/feed.xml', impl, { nsfw: true })).toMatchObject({ kind: 'blog', nsfw: 1 });
  });

  it("refuses blocklisted sources before fetching them", async () => {
    const { impl, calls } = fakeFetch({});
    await expect(deep.addUserSource('https://lemmy.example/c/jailbait', impl)).rejects.toThrow(/doesn't index that/);
    expect(calls).toHaveLength(0);
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
    expect(list.filter((s) => s.kind === 'forum').length).toBeGreaterThanOrEqual(130);
    expect(list.filter((s) => s.kind === 'board').length).toBeGreaterThanOrEqual(75);
    expect(list.some((s) => isBlockedSource(s))).toBe(false);
  });

  it('keeps the original board addresses, so existing indexes gain boards instead of duplicates', () => {
    const urls = new Set(sources.OTHER_BOARDS.map((s) => s.url));
    for (const u of ['https://lainchan.org/λ/catalog.json', 'https://lainchan.org/Ω/catalog.json', 'https://wizchan.org/wiz/catalog.json']) expect(urls.has(u)).toBe(true);
  });

  it('uses each board\'s real thread links and flags its 18+ boards', () => {
    const board = (url: string) => sources.OTHER_BOARDS.find((s) => s.url === url)!;
    expect(board('https://kissu.moe/qa/catalog.json').threadUrl).toBe('https://kissu.moe/qa/thread/{no}');
    expect(board('https://2ch.su/pr/catalog.json').threadUrl).toBe('https://2ch.su/pr/res/{no}.html');
    expect(board('https://2ch.su/b/catalog.json').nsfw).toBe(true);
    expect(board('https://leftypol.org/siberia/catalog.json').nsfw).toBe(true);
    expect(board('https://leftypol.org/tech/catalog.json').nsfw).toBeUndefined();
  });

  it('lists 100 Stack Exchange sites once each', () => {
    const se = sources.STACK_EXCHANGE.map((s) => s.site);
    expect(se).toHaveLength(100);
    expect(new Set(se).size).toBe(100);
  });
});

beforeAll(() => {
  // Some suites above build their own stores; make sure nothing leaks between them.
  deep.resetDeepIndex();
});
