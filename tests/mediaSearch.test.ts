import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCommonsMedia, resetCommonsMedia } from '../server/mediaSearch.js';

const image = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Ocean.jpg';
const thumb = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Ocean.jpg/480px-Ocean.jpg';
const page = { pageid: 4, title: 'File:Ocean.jpg', index: 1, imageinfo: [{ url: image, thumburl: thumb, mime: 'image/jpeg', width: 1920, height: 1080, extmetadata: {
  Artist: { value: '<a href="/User:Ada">Ada</a>' }, ImageDescription: { value: '<p>Ocean waves.</p>' }, LicenseShortName: { value: 'CC BY 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' },
} }] };
beforeEach(() => resetCommonsMedia());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Commons media search', () => {
  it('returns genuine raster assets, source pages and plain-text attribution', async () => {
    const fetch = vi.fn(async (_url: unknown) => Response.json({ query: { pages: { 4: page } } })); vi.stubGlobal('fetch', fetch);
    const result = await searchCommonsMedia('ocean', 'image');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: 'wikimedia', title: 'Ocean', url: 'https://commons.wikimedia.org/wiki/File%3AOcean.jpg', media: { kind: 'image', url: image, previewUrl: thumb, attribution: 'Ada', license: 'CC BY 4.0' } });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get('gsrnamespace')).toBe('6');
    expect(url.searchParams.get('gsrsearch')).toContain('filetype:bitmap');
    expect(Number(url.searchParams.get('gsrlimit'))).toBeLessThanOrEqual(12);
  });
  it('selects a bounded video rendition, never HTML embeds or unrelated hosts', async () => {
    const video = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/Ocean.webm/Ocean.webm.480p.vp9.webm';
    vi.stubGlobal('fetch', async () => Response.json({ query: { pages: { 4: { ...page, title: 'File:Ocean.webm', imageinfo: undefined, videoinfo: [{ ...page.imageinfo[0], url: image.replace('.jpg', '.webm'), mime: 'video/webm', duration: 30, derivatives: [
      { src: 'https://evil.example/embed.html', type: 'video/mp4', height: 480 },
      { src: video.replace('480p', '1080p'), type: 'video/webm', height: 1080 },
      { src: video, type: 'video/webm; codecs="vp9, opus"', height: 480, width: 854 },
    ] }] } } } }));
    const result = await searchCommonsMedia('ocean', 'video');
    expect(result[0].media).toMatchObject({ kind: 'video', url: video, durationSeconds: 30, mimeType: 'video/webm' });
  });
  it('drops malformed, mixed-type and unsafe records instead of fake viewer buttons', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ query: { pages: { a: null, b: { title: {} }, c: { ...page, imageinfo: [{ ...page.imageinfo[0], url: 'https://evil.example/a.jpg' }] }, d: { ...page, imageinfo: [{ ...page.imageinfo[0], mime: 'image/svg+xml' }] }, e: { ...page, title: 'File:' + 'x'.repeat(1000) }, f: { ...page, pageid: 'bad-id' } } } }));
    expect(await searchCommonsMedia('ocean', 'image')).toEqual([]);
  });
  it('marks explicit metadata for the existing adult-content preference without guessing from substrings', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ query: { pages: {
      4: { ...page, imageinfo: [{ ...page.imageinfo[0], extmetadata: { Categories: { value: 'Nude people|Studio photographs' } } }] },
      5: { ...page, pageid: 5, title: 'File:Nudibranch.jpg', imageinfo: [{ ...page.imageinfo[0], extmetadata: { ImageDescription: { value: 'Nudibranch swimming near Pornic, France.' } } }] },
    } } }));
    const results = await searchCommonsMedia('photographs', 'image');
    expect(results[0].isNsfw).toBe(true);
    expect(results[1].isNsfw).toBe(false);
  });
  it('respects request pacing and upstream Retry-After without queueing', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } })); vi.stubGlobal('fetch', fetch);
    await expect(searchCommonsMedia('ocean', 'image')).rejects.toThrow(/resting/);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(searchCommonsMedia('ocean', 'video')).rejects.toThrow(/limit/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('surfaces Commons files whose subject lives in topical Categories while stripping housekeeping categories', async () => {
    const { diversifyAndRankResults } = await import('../src/core/ranker.js');
    vi.stubGlobal('fetch', async () => Response.json({ query: { pages: {
      4: {
        ...page,
        title: 'File:Porto Covo July 2011-6.jpg',
        imageinfo: [{
          ...page.imageinfo[0],
          extmetadata: {
            Artist: { value: 'Alvesgaspar' },
            ImageDescription: { value: 'Playing with the breaking waves. Porto Covo, Portugal' },
            LicenseShortName: { value: 'CC BY-SA 3.0' },
            Categories: {
              value: 'Personality rights warning|Self-published work|Taken with Nikon D810|Files with no machine-readable source|Featured pictures of Porto Covo|Featured pictures of the Atlantic Ocean|Breaking ocean waves',
            },
          },
        }],
      },
    } } }));
    const raw = await searchCommonsMedia('ocean waves', 'image');
    expect(raw[0].tags).toEqual(['Porto Covo', 'the Atlantic Ocean', 'Breaking ocean waves']);
    const ranked = diversifyAndRankResults(raw, { lens: 'images' }, 'ocean waves');
    expect(ranked.surfaced).toHaveLength(1);
    expect(ranked.surfaced[0].title).toBe('Porto Covo July 2011-6');
  });
  it('expands UK/US spelling twins in Commons search queries and ranks US-titled media for UK queries', async () => {
    const { diversifyAndRankResults } = await import('../src/core/ranker.js');
    const video = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/Tire.webm/Tire.webm.480p.vp9.webm';
    const fetch = vi.fn(async (_url: unknown) => Response.json({ query: { pages: {
      4: {
        pageid: 9,
        title: 'File:Automotive Help - Introduction to Tires including Tools Needed for a Repair.webm',
        index: 1,
        videoinfo: [{
          url: image.replace('Ocean.jpg', 'Tire.webm'),
          thumburl: thumb,
          mime: 'video/webm',
          duration: 95,
          derivatives: [{ src: video, type: 'video/webm', height: 480, width: 854 }],
          extmetadata: { ImageDescription: { value: 'How to inspect and repair a punctured tire.' }, Categories: { value: 'Tires|Videos from YouTube' } },
        }],
      },
    } } }));
    vi.stubGlobal('fetch', fetch);
    const raw = await searchCommonsMedia('tyre repair', 'video');
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get('gsrsearch')).toBe('(tyre OR tire) repair filetype:video');
    const ranked = diversifyAndRankResults(raw, { lens: 'videos' }, 'tyre repair');
    expect(ranked.surfaced).toHaveLength(1);
  });
});
