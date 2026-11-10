/**
 * The UX review's server-side findings: answers cite the right sources, search
 * operators work, the reader tells an error page or a bot check from an
 * article, Hacker News stories are one row each, and hidden results say why in
 * plain words.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanAndAutopsyHtml, diversifyAndRankResults, parseQueryOperators, RawSearchResult, ScoredSearchResult } from '../src/core/index.js';
import { botWall } from '../src/core/pageCleaner.js';
import { fixtureServer, rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';

useTempGloggHome();
process.env.GLOGG_CONTAINER_RUNTIME = 'none';
const fsearch = await import('../server/federatedSearch.js');
const answers = await import('../server/answerEngine.js');

describe('answers cite the source each line comes from', () => {
  const scored = (i: number, url: string, snippet: string): ScoredSearchResult =>
    diversifyAndRankResults([{ title: `Undo the last git commit, way ${i}`, url, snippet, source: 'web' }], {}, 'how to undo the last git commit').surfaced[0];

  it('after the accepted answer takes [1], every takeaway still points at its own page', async () => {
    const results = [
      scored(1, 'https://one.example/undo', 'Use git reset with the soft flag to undo the last commit and keep the changes staged for a new commit.'),
      scored(2, 'https://two.example/undo', 'The git revert command makes a new commit that undoes an earlier one, which is safer on shared branches.'),
    ].filter(Boolean);
    expect(results).toHaveLength(2);
    const tech = { questionTitle: 'How do I undo the most recent local commits in Git?', questionUrl: 'https://stackoverflow.com/questions/927358', siteName: 'Stack Overflow', answerText: 'git reset HEAD~', score: 26000 };
    const answer = await answers.buildInstantAnswer('how to undo the last git commit', results, Promise.resolve([null, null, tech] as never));
    expect(answer?.kind).toBe('technical-answer');
    const byNumber = new Map(answer!.citations.map((c) => [c.index, c.url]));
    expect(byNumber.get(1)).toBe(tech.questionUrl);
    expect(answer!.takeaways!.length).toBeGreaterThan(0);
    for (const t of answer!.takeaways!) {
      const url = byNumber.get(t.citationIndex);
      expect(url, `takeaway [${t.citationIndex}] has a source`).toBeDefined();
      const quoted = results.find((r) => r.snippet.includes(t.text.slice(0, 30)));
      expect(url).toBe(quoted?.url);
    }
  });
});

describe('search operators', () => {
  it.each([
    ['site:sqlite.org wal', { text: 'wal', sites: ['sqlite.org'] }],
    ['site:www.docs.python.org/3/library asyncio', { text: 'asyncio', sites: ['docs.python.org'] }],
    ['recipes -site:pinterest.com', { text: 'recipes', notSites: ['pinterest.com'] }],
    ['"write-ahead log" -sqlite', { text: 'write-ahead log', phrases: ['write-ahead log'], without: ['sqlite'] }],
    ['-40f in c', { text: '-40f in c', without: [] }],
    ['x-ray -5 degrees', { text: 'x-ray -5 degrees', without: [] }],
    ['site:localhost x', { text: 'x', sites: [] }],
  ])('%s', (q, expected) => {
    expect(parseQueryOperators(q)).toMatchObject(expected);
  });

  const items: RawSearchResult[] = [
    { title: 'Write-Ahead Logging', url: 'https://sqlite.org/wal.html', snippet: 'The write-ahead log in SQLite', source: 'web' },
    { title: 'WAL file format', url: 'https://www.sqlite.org/walformat.html', snippet: 'How the WAL file is laid out', source: 'web' },
    { title: 'WAL notes', url: 'https://deepwiki.example/sqlite-wal', snippet: 'wal sqlite notes', source: 'web' },
  ];

  it('site: keeps only that site, every page of it, past the per-site limit', () => {
    const out = diversifyAndRankResults(items, { onlySites: ['sqlite.org'], maxPerDomain: 1 }, 'wal');
    expect(out.surfaced.map((r) => r.url).sort()).toEqual(['https://sqlite.org/wal.html', 'https://www.sqlite.org/walformat.html']);
    expect(out.filteredSlop.map((r) => r.demotedReason)).toEqual(['Not on sqlite.org']);
  });

  it('-site: and -word leave results out, and say so', () => {
    const out = diversifyAndRankResults(items, { excludeSites: ['deepwiki.example'], excludeWords: ['format'] }, 'wal');
    expect(out.surfaced.map((r) => r.url)).toEqual(['https://sqlite.org/wal.html']);
    expect(out.filteredSlop.map((r) => r.demotedReason).sort()).toEqual(['Mentions “format”, which your search leaves out', 'On deepwiki.example, which your search leaves out']);
  });

  describe('in a search', () => {
    const asked: string[] = [];
    beforeEach(() => {
      asked.length = 0;
      fsearch.clearSearchCache();
      fsearch.resetSourceHealth();
      answers.clearInstantAnswerCache();
      vi.stubGlobal('fetch', async (input: string | URL) => {
        asked.push(String(input));
        return new Response('', { status: 404 });
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('sources that don\'t know operators get the words; web engines get the query as typed; no answer is looked up', async () => {
      const res = await fsearch.executeFederatedSearch('site:sqlite.org wal mode', { lens: 'all' });
      expect(res.query).toBe('site:sqlite.org wal mode');
      const hn = asked.find((u) => u.startsWith('https://hn.algolia.com/'));
      expect(decodeURIComponent(hn!)).not.toContain('site:');
      const ddg = asked.find((u) => u.startsWith('https://html.duckduckgo.com/'));
      expect(decodeURIComponent(ddg!.replace(/\+/g, ' '))).toContain('site:sqlite.org wal mode');
      expect(asked.some((u) => u.startsWith('https://api.duckduckgo.com/'))).toBe(false);
    });
  });
});

describe('the reader', () => {
  let port = 0;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ port, close } = await startGloggServer());
  });
  afterAll(() => close());

  const inspect = (url: string) => rawRequest(port, { method: 'POST', path: '/api/inspect', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });

  it('says a page answered with an error instead of cleaning the error page', async () => {
    const site = await fixtureServer({ '/gone': { status: 404, body: '<html><title>Not Found</title><p>Sorry, nothing here at all, nothing.</p></html>' } });
    try {
      const r = await inspect(`${site.baseUrl}/gone`);
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body)).toMatchObject({ error: 'The page answered 404 Not Found. Open the original instead.', status: 404 });
    } finally {
      await site.close();
    }
  });

  it('names a bot check instead of presenting it as the article', async () => {
    const site = await fixtureServer({ '/cf': { body: '<html><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div></body></html>' } });
    try {
      const r = await inspect(`${site.baseUrl}/cf`);
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body).error).toBe('This site shows readers like glogg a Cloudflare check instead of the page. Open the original instead.');
    } finally {
      await site.close();
    }
  });

  it.each([
    ['<title>Just a moment...</title>', 'Cloudflare'],
    ['<title>Attention Required! | Cloudflare</title>', 'Cloudflare'],
    ['<script>window._cf_chl_opt={}</script>', 'Cloudflare'],
    ['<title>DDoS-Guard</title><p>Checking your browser before accessing</p>', 'DDoS-Guard'],
    ['<div id="px-captcha"></div>', 'PerimeterX'],
    ['<title>Verifying you are human</title>', 'a bot check'],
    ['<title>Just a moment of your time: a guide</title><p>An article.</p>', null],
    ['<title>Rust borrow checker</title><p>Checking your browser cache can help.</p>', null],
  ])('bot check in %s: %s', (html, wall) => {
    expect(botWall(`<html><head>${html}</head><body></body></html>`)).toBe(wall);
  });

  it('keeps short section headings', () => {
    const page = `<article><h1>The borrow checker</h1><p>${'Every reference points at something alive. '.repeat(6)}</p><h2>Lifetimes</h2><p>${'A lifetime is how long a reference is valid. '.repeat(5)}</p><h3>Usage</h3><p>${'Most of the time the compiler infers them for you. '.repeat(5)}</p></article>`;
    const headings = cleanAndAutopsyHtml(page, 'https://tiny.example/post').sections.filter((s) => s.tag !== 'p').map((s) => s.text);
    expect(headings).toEqual(['The borrow checker', 'Lifetimes', 'Usage']);
  });
});

describe('Hacker News stories', () => {
  beforeEach(() => {
    fsearch.clearSearchCache();
    fsearch.resetSourceHealth();
    vi.stubGlobal('fetch', async (input: string | URL) => {
      if (!String(input).startsWith('https://hn.algolia.com/')) return new Response('', { status: 404 });
      return Response.json({
        hits: [
          { objectID: '1', title: 'Rust borrow checker internals', url: 'https://blog.example/rust-borrow-checker', points: 300, num_comments: 120 },
          { objectID: '2', title: 'Ask HN: How do you teach the Rust borrow checker?', points: 80, num_comments: 64 },
        ],
      });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('are one row each: the page linked, with its discussion a click away', async () => {
    const res = await fsearch.executeFederatedSearch('rust borrow checker', { lens: 'all' });
    const rows = [...res.results, ...res.filteredSlop].filter((r) => r.source === 'hn');
    const linked = rows.filter((r) => r.title === 'Rust borrow checker internals');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ url: 'https://blog.example/rust-borrow-checker', discussionUrl: 'https://news.ycombinator.com/item?id=1', commentsCount: 120 });
    expect(rows.find((r) => r.url === 'https://news.ycombinator.com/item?id=2')?.title).toBe('Ask HN: How do you teach the Rust borrow checker?');
    expect(rows.some((r) => r.title.startsWith('Discussion:'))).toBe(false);
  });
});

describe('hidden results say why, in plain words', () => {
  it('no scores or thresholds in the reasons', () => {
    const out = diversifyAndRankResults(
      [
        { title: 'Totally unrelated gardening tips', url: 'https://garden.example/tips', snippet: 'Roses and tulips', source: 'web' },
        { title: 'Rust borrow checker', url: 'https://a.example/1', snippet: 'Rust borrow checker notes', source: 'web' },
        { title: 'Rust borrow checker again', url: 'https://a.example/2', snippet: 'More rust borrow checker notes', source: 'web' },
      ],
      { maxPerDomain: 1 },
      'rust borrow checker'
    );
    const reasons = out.filteredSlop.map((r) => r.demotedReason);
    expect(reasons).toContain("Doesn't seem to be about your search");
    expect(reasons).toContain('More from a.example (1 per site)');
    for (const r of reasons) expect(r).not.toMatch(/\d+\/100|threshold|noise/);
  });
});
