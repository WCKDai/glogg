import { describe, expect, it } from 'vitest';
import { diversifyAndRankResults } from '../src/core/ranker.js';
import type { RawSearchResult, SearchFilterConfig } from '../src/core/types.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const freshness = { intent: 'news' as const, now };
const currentDate = '2026-11-15T11:30:00Z';

const result = (id: string, extra: Partial<RawSearchResult> = {}): RawSearchResult => ({
  id,
  title: 'Space launch mission report',
  snippet: 'Space launch mission report with launch details.',
  url: `https://${id}.example/report`,
  source: 'web',
  ...extra,
});

describe('case-sensitive result URL identity', () => {
  it.each([
    ['path', 'https://docs.example/Python', 'https://docs.example/python'],
    ['query value', 'https://docs.example/reference?name=Python', 'https://docs.example/reference?name=python'],
    ['query key', 'https://docs.example/reference?Name=python', 'https://docs.example/reference?name=python'],
  ])('keeps distinct %s values', (_, firstUrl, secondUrl) => {
    const rows = [
      result('first', { url: firstUrl, title: 'Python module reference' }),
      result('second', { url: secondUrl, title: 'Python package reference' }),
    ];
    const ranked = diversifyAndRankResults(rows, { maxPerDomain: 0 }, 'python reference');
    expect(ranked.surfaced.map((row) => row.id).sort()).toEqual(['first', 'second']);
  });

  it('still collapses host casing, tracking parameters and a trailing slash', () => {
    const rows = [
      result('first', { url: 'https://DOCS.example/Python/?utm_source=search', title: 'Python module reference' }),
      result('second', { url: 'https://docs.example/Python', title: 'Python package reference' }),
    ];
    expect(diversifyAndRankResults(rows, { maxPerDomain: 0 }, 'python reference').surfaced).toHaveLength(1);
  });
});

describe('navigable result URLs', () => {
  const magnet = 'magnet:?xt=urn:btih:2c6b6858d61da9543d4231a71db4b1c9264b0685';
  const torrent: NonNullable<RawSearchResult['p2p']> = {
    protocol: 'bittorrent-dht',
    magnetUri: magnet,
    sizeFormatted: 'Unknown',
    indexerName: 'Fixture',
    healthVerdict: 'active',
  };

  it.each([
    'https://',
    'https://bad host.example/report',
    '/relative/report',
    '//relative.example/report',
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<p>report</p>',
    'file:///tmp/report',
    'ftp://archive.example/report',
    'mailto:report@example.com',
    'at://did:plc:example/app.bsky.feed.post/123',
    'matrix:r/search:example.com',
    magnet,
  ])('omits unsupported or malformed ordinary result URL %s from every output', (url) => {
    const ranked = diversifyAndRankResults([
      result('unsafe', { url }),
      result('good', { title: 'Space launch' }),
    ], {}, 'space launch');
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['good']);
    expect(ranked.filteredSlop.map((row) => row.id)).not.toContain('unsafe');
    expect(ranked.p2pResults.map((row) => row.id)).not.toContain('unsafe');
  });

  it.each([
    'https://notes.example/100%natural',
    'http://notes.example/report',
    'https://notes.example/report',
    'http://localhost:8080/report',
    'https://127.0.0.1/report',
    'http://[::1]/report',
    'http://independent.onion/report',
  ])('preserves a valid HTTP result URL %s', (url) => {
    const ranked = diversifyAndRankResults([result('valid', { url })], {}, 'space launch');
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['valid']);
  });

  it('preserves explicit magnets from BitTorrent results', () => {
    const ranked = diversifyAndRankResults([result('torrent', { source: 'bitmagnet-dht', url: magnet, p2p: torrent })], { lens: 'p2p-magnet' });
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['torrent']);
    expect(ranked.p2pResults.map((row) => row.id)).toEqual(['torrent']);
  });

  it.each([
    ['arbitrary scheme with torrent metadata', 'javascript:alert(1)', torrent],
    ['magnet without a query', 'magnet:', torrent],
    ['magnet without an exact topic', 'magnet:?dn=Space%20launch', torrent],
    ['magnet with a path', `magnet:report?xt=urn:btih:2c6b6858d61da9543d4231a71db4b1c9264b0685`, torrent],
    ['magnet with non-BitTorrent metadata', magnet, { ...torrent, protocol: 'usenet-nzb' }],
  ] satisfies Array<[string, string, NonNullable<RawSearchResult['p2p']>]>)('does not admit %s', (_, url, p2p) => {
    const ranked = diversifyAndRankResults([result('unsafe', { url, p2p })], { lens: 'p2p-magnet' });
    expect(ranked.surfaced).toEqual([]);
    expect(ranked.filteredSlop).toEqual([]);
    expect(ranked.p2pResults).toEqual([]);
  });
});

describe('freshness when choosing a duplicate representative', () => {
  const archive = result('archive', { source: 'archive-deep', url: 'https://archive.org/details/old-launch', publishedAt: '2011-01-01', points: 500 });
  const hn = result('discussion', { source: 'hn', url: 'https://news.ycombinator.com/item?id=123', publishedAt: '2011-01-01', points: 500 });
  const current = result('current', { publishedAt: currentDate });
  const config: Partial<SearchFilterConfig> = { lens: 'raw-news' };

  it.each([archive, hn])('keeps current reporting instead of old $source material with the same title', (old) => {
    const ranked = diversifyAndRankResults([old, current], config, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['current']);
    expect(ranked.filteredSlop.find((row) => row.id === old.id)?.demotedReason).toBe('A copy of a result shown above');
    const alone = diversifyAndRankResults([current], config, 'space launch', freshness);
    expect(ranked.surfaced[0].netScore).toBe(alone.surfaced[0].netScore);
  });

  it('keeps archival context with a distinct title', () => {
    const context = { ...archive, title: 'Space launch historical engineering notes' };
    const ranked = diversifyAndRankResults([context, current], config, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id).sort()).toEqual(['archive', 'current']);
  });

  it('keeps hidden rows in score order after eligibility filtering and duplicate selection', () => {
    const blocked = result('blocked', { title: 'Space launch advertising campaign', publishedAt: currentDate });
    const ranked = diversifyAndRankResults([archive, current, blocked], { ...config, blockedDomains: ['blocked.example'] }, 'space launch', freshness);
    expect(ranked.filteredSlop.map((row) => row.id).sort()).toEqual(['archive', 'blocked']);
    const scores = ranked.filteredSlop.map((row) => row.netScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('preserves score-based duplicate selection for evergreen searches', () => {
    const ranked = diversifyAndRankResults([archive, current], config, 'space launch');
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['archive']);
  });

  it.each([
    ['unknown', undefined],
    ['invalid', 'not-a-date'],
    ['future', '2027-01-01'],
    ['outside the news window', '2026-11-13T11:30:00Z'],
  ])('does not give an %s date preference over the existing representative', (_, publishedAt) => {
    const uncertain = { ...current, publishedAt };
    const ranked = diversifyAndRankResults([archive, uncertain], config, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['archive']);
  });

  it('does not treat a recent indexing date as a publication date', () => {
    const indexed = { ...current, dateKind: 'indexed' as const };
    const ranked = diversifyAndRankResults([archive, indexed], config, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['archive']);
  });

  it.each([
    ['unknown', { publishedAt: undefined }],
    ['invalid', { publishedAt: 'not-a-date' }],
    ['future', { publishedAt: '2027-01-01' }],
    ['indexed', { publishedAt: currentDate, dateKind: 'indexed' }],
  ] satisfies Array<[string, Partial<RawSearchResult>]>)('prefers a confirmed current publication over a higher-scoring copy with an %s date', (_, changes) => {
    const ranked = diversifyAndRankResults([{ ...archive, ...changes }, current], config, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['current']);
  });

  it('uses the existing score when both copies were published within the freshness window', () => {
    const ranked = diversifyAndRankResults([{ ...archive, publishedAt: currentDate }, current], config, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['archive']);
  });

  it.each([
    ['blocked domain', { blockedDomains: ['current.example'] }, {}],
    ['excluded site', { excludeSites: ['current.example'] }, {}],
    ['excluded word', { excludeWords: ['advertisement'] }, { snippet: 'Space launch mission report advertisement.' }],
    ['sponsorship', {}, { snippet: 'Sponsored by Acme. Space launch mission report with launch details.' }],
    ['adult content', {}, { isNsfw: true }],
  ] satisfies Array<[string, Partial<SearchFilterConfig>, Partial<RawSearchResult>]>)('keeps eligible context when the current copy is filtered for %s', (_, filters, changes) => {
    const ranked = diversifyAndRankResults([archive, { ...current, ...changes }], { ...config, ...filters }, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['archive']);
    const hidden = ranked.filteredSlop.find((row) => row.id === 'current');
    expect(hidden?.demotedReason).toBeTruthy();
    expect(hidden?.demotedReason).not.toBe('A copy of a result shown above');
  });

  it('keeps the old fallback before another result consumes its domain slot', () => {
    const lead = result('lead', {
      title: 'Space launch',
      source: 'gdelt-news',
      url: 'https://current.example/live',
      publishedAt: currentDate,
      points: 500,
    });
    const otherArchive = result('other-archive', {
      title: 'Space launch museum equipment collection',
      url: 'https://archive.org/details/launch-equipment',
      publishedAt: '2011-01-01',
    });
    const ranked = diversifyAndRankResults([lead, archive, otherArchive, current], config, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id).sort()).toEqual(['archive', 'lead']);
    expect(ranked.filteredSlop.find((row) => row.id === 'current')?.demotedReason).toBe('More from current.example (1 per site)');
    expect(ranked.filteredSlop.find((row) => row.id === 'other-archive')?.demotedReason).toBe('More from archive.org (1 per site)');
  });

  it('uses the current-information window for changing queries', () => {
    const recentlyPublished = { ...current, publishedAt: '2026-11-01T12:00:00Z' };
    const ranked = diversifyAndRankResults([archive, recentlyPublished], config, 'space launch', { intent: 'current', now });
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['current']);
  });

  it('does not let a recent off-topic result replace the matching result through a truncated title fingerprint', () => {
    const commonTitle = 'Mission status report from the international scientific research group';
    const matching = result('matching', { title: `${commonTitle}: space launch`, snippet: 'Space launch mission report with launch details.', publishedAt: '2011-01-01' });
    const unrelated = result('unrelated', { title: `${commonTitle}: ocean wildlife`, snippet: 'Whales migrate through coastal waters.', publishedAt: currentDate });
    const ranked = diversifyAndRankResults([matching, unrelated], config, 'space launch', freshness);
    expect(ranked.surfaced.map((row) => row.id)).toEqual(['matching']);
    expect(ranked.filteredSlop.find((row) => row.id === 'unrelated')?.demotedReason).toBe("Doesn't seem to be about your search");
  });
});
