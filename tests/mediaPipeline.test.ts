import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempGloggHome } from './helpers.js';
import { diversifyAndRankResults } from '../src/core/ranker.js';
import type { RawSearchResult } from '../src/core/types.js';
import { resetCommonsMedia } from '../server/mediaSearch.js';

useTempGloggHome();
const { executeFederatedSearch, clearSearchCache, resetSourceHealth } = await import('../server/federatedSearch.js');
const asked: URL[] = [];
const asset = (id: number, kind: 'image' | 'video') => `https://upload.wikimedia.org/wikipedia/commons/a/ab/Ocean_${id}.${kind === 'image' ? 'jpg' : 'webm'}`;
const row = (id: number, kind: 'image' | 'video'): RawSearchResult => ({
  id: `ocean-${id}`, title: 'Ocean waves on the beach', snippet: 'Ocean waves near the coast.', source: 'wikimedia',
  url: `https://commons.wikimedia.org/wiki/File:Ocean_${id}`, media: { kind, url: asset(id, kind), previewUrl: asset(id, 'image'), mimeType: kind === 'image' ? 'image/jpeg' : 'video/webm' },
});
beforeEach(() => {
  clearSearchCache(); resetSourceHealth(); resetCommonsMedia(); asked.length = 0;
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = new URL(String(input)); asked.push(url);
    if (url.hostname !== 'commons.wikimedia.org') return new Response('', { status: 404 });
    const kind = url.searchParams.get('prop') === 'videoinfo' ? 'video' : 'image';
    return Response.json({ query: { pages: Object.fromEntries([1, 2, 3].map((id) => [id, {
      pageid: id, title: `File:Ocean_${id}.${kind === 'image' ? 'jpg' : 'webm'}`, index: id,
      [kind === 'image' ? 'imageinfo' : 'videoinfo']: [{ url: asset(id, kind), thumburl: asset(id, 'image'), mime: kind === 'image' ? 'image/jpeg' : 'video/webm', width: 640, height: 480, size: 1000, duration: 12, extmetadata: { ImageDescription: { value: 'Ocean waves on the beach.' } } }],
    }])) } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded media search orchestration', () => {
  it.each([['images', 'image'], ['videos', 'video']] as const)('uses one Commons request and no text/answer providers for %s', async (lens, kind) => {
    const response = await executeFederatedSearch('ocean', { lens });
    expect(asked.map((u) => u.hostname)).toEqual(['commons.wikimedia.org']);
    expect(response.results).toHaveLength(3);
    expect(response.results.every((r) => r.media?.kind === kind)).toBe(true);
    expect(response.metrics.sourcesQueried).toEqual(['wikimedia']);
    expect(Object.keys(response.metrics.sourceTimings ?? {})).toEqual(['wikimedia']);
    expect(response.instantAnswer).toBeUndefined();
    expect(Number(asked[0].searchParams.get('gsrlimit'))).toBeLessThanOrEqual(8);
  });
  it('separates image/video caches and coalesces identical in-flight requests', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const [first, second] = await Promise.all([
      executeFederatedSearch('ocean', { lens: 'images' }), executeFederatedSearch('ocean', { lens: 'images' }),
    ]);
    expect(first.results).toEqual(second.results);
    expect(asked).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1001);
    const video = await executeFederatedSearch('ocean', { lens: 'videos' });
    expect(video.results.every((r) => r.media?.kind === 'video')).toBe(true);
    expect(asked.map((u) => u.searchParams.get('prop'))).toEqual(['imageinfo', 'videoinfo']);
  });
  it('honors a disabled media source without fetching anything', async () => {
    const response = await executeFederatedSearch('ocean', { lens: 'images', disabledSources: ['wikimedia'] });
    expect(asked).toEqual([]);
    expect(response.results).toEqual([]);
    expect(response.metrics.sourceTimings?.wikimedia.status).toBe('off');
    expect(response.instantAnswer).toBeUndefined();
  });
  it('keeps 18+ media requests isolated from text and imageboard sources', async () => {
    await executeFederatedSearch('ocean', { lens: 'images', uncensoredMode: true });
    expect(asked.map((u) => u.hostname)).toEqual(['commons.wikimedia.org']);
  });
  it('applies domain and phrase preferences to cached media results', async () => {
    await executeFederatedSearch('ocean', { lens: 'images' });
    const blocked = await executeFederatedSearch('ocean', { lens: 'images', blockedDomains: ['wikimedia.org'] });
    expect(blocked.results).toEqual([]);
    expect(blocked.filteredSlop).toHaveLength(3);
    const phrase = await executeFederatedSearch('ocean', { lens: 'images', blockedPhrases: ['ocean waves'] });
    expect(phrase.results).toEqual([]);
    expect(asked).toHaveLength(1);
  });
  it('does not quietly add media traffic to ordinary searches', async () => {
    await executeFederatedSearch('ocean', { lens: 'all' });
    expect(asked.some((u) => u.hostname === 'commons.wikimedia.org')).toBe(false);
  });
});

describe('media ranking preserves preferences and distinct files', () => {
  it('uses asset identity instead of title or publisher count, only in media scopes', () => {
    const images = [row(1, 'image'), row(2, 'image'), row(3, 'image')];
    const duplicate = { ...images[0], id: 'duplicate', title: 'Ocean second description', url: 'https://commons.wikimedia.org/wiki/File:Alias' };
    expect(diversifyAndRankResults([...images, duplicate], { lens: 'images', maxPerDomain: 1 }, 'ocean').surfaced).toHaveLength(3);
    expect(diversifyAndRankResults(images, { lens: 'all', maxPerDomain: 1 }, 'ocean').surfaced).toHaveLength(1);
  });
  it('does not show another media kind or text-only result in a media scope', () => {
    const text = { ...row(3, 'image'), media: undefined };
    const images = diversifyAndRankResults([row(2, 'video'), text, row(1, 'image')], { lens: 'images', maxPerDomain: 0 }, 'ocean');
    expect(images.surfaced.map((r) => r.id)).toEqual(['ocean-1']);
  });
  it('honors known adult flags, blocked domains and pinned rules', () => {
    const explicit = { ...row(1, 'image'), isNsfw: true };
    expect(diversifyAndRankResults([explicit], { lens: 'images' }, 'ocean').surfaced).toEqual([]);
    expect(diversifyAndRankResults([explicit], { lens: 'images', uncensoredMode: true }, 'ocean').surfaced).toHaveLength(1);
    expect(diversifyAndRankResults([row(2, 'image')], { lens: 'images', blockedDomains: ['wikimedia.org'] }, 'ocean').surfaced).toEqual([]);
    expect(diversifyAndRankResults([row(2, 'image')], { lens: 'images', pinnedDomains: ['wikimedia.org'] }, 'ocean').surfaced[0].signals.some((s) => s.id === 'user-pinned-domain')).toBe(true);
  });
  it('does not treat unknown media creation dates as pre-LLM evidence', () => {
    const raw = [row(1, 'image'), { ...row(2, 'image'), publishedAt: '2020-01-01' }, { ...row(3, 'image'), publishedAt: '2025-01-01' }, { ...row(4, 'image'), publishedAt: '2020-01-01', dateKind: 'indexed' as const }, { ...row(5, 'image'), publishedAt: 'not-a-date' }];
    const ranked = diversifyAndRankResults(raw, { lens: 'images', preLlmOnly: true }, 'ocean');
    expect(ranked.surfaced.map((r) => r.id)).toEqual(['ocean-2']);
    expect(ranked.filteredSlop.find((r) => r.id === 'ocean-1')?.demotedReason).toMatch(/date.*unknown/i);
  });
});
