import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchMetadataSource, resetMetadataSources } from '../server/metadataSources.js';
import { SourceUnavailable } from '../server/sourceStatus.js';

beforeEach(() => resetMetadataSources());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bibliographic connectors', () => {
  it('maps Crossref DOI records without copying copyrighted abstracts', async () => {
    const fetch = vi.fn(async (_input: unknown) => Response.json({ message: { items: [{ DOI: '10.1000/test', title: ['<i>Open science</i>'], author: [{ given: 'Ada', family: 'Lovelace' }], published: { 'date-parts': [[2020, 4, 3]] }, 'container-title': ['Research Journal'], 'is-referenced-by-count': 12, abstract: 'Must not be copied' }] } }));
    vi.stubGlobal('fetch', fetch);
    const results = await searchMetadataSource('crossref', 'open science');
    expect(results[0]).toMatchObject({ source: 'crossref', title: 'Open science', url: 'https://doi.org/10.1000/test', publishedAt: '2020-04-03', points: 12 });
    expect(results[0].snippet).toContain('Ada Lovelace');
    expect(results[0].snippet).not.toContain('Must not');
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('query.bibliographic')).toBe('open science');
  });

  it('maps Europe PMC records to canonical DOI links or article links', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ resultList: { result: [{ id: '123', source: 'MED', title: 'Cell biology', authorString: 'A. Researcher', pubYear: '2022', doi: '10.1000/cells', citedByCount: 3 }, { id: '456', source: 'PMC', title: 'Cell methods', firstPublicationDate: '2021-03-02' }] } }));
    const results = await searchMetadataSource('europepmc', 'cell biology');
    expect(results.map((r) => r.url)).toEqual(['https://doi.org/10.1000/cells', 'https://europepmc.org/article/PMC/456']);
    expect(results[0].publishedAt).toBe('2022');
    expect(results[1].publishedAt).toBe('2021-03-02');
  });

  it('maps Open Library works and drops malformed or unsafe records', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ docs: [{ key: '/works/OL123W', title: 'A book', author_name: ['One', 'Two'], first_publish_year: 1960, edition_count: 4 }, { key: 'OL456W', title: 'Another book' }, { key: 'https://evil.example', title: 'Bad link' }, null, { key: '/works/OL789W', title: {} }] }));
    const results = await searchMetadataSource('openlibrary', 'a book');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ url: 'https://openlibrary.org/works/OL123W', publishedAt: '1960', source: 'openlibrary' });
    expect(results[0].snippet).toContain('One, Two');
  });

  it('never queues above the per-source concurrency or request rate', async () => {
    let resolve!: (res: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((r) => { resolve = r; }));
    const first = searchMetadataSource('crossref', 'one');
    await expect(searchMetadataSource('crossref', 'two')).rejects.toBeInstanceOf(SourceUnavailable);
    resolve(Response.json({ message: { items: [] } })); await first;
    await expect(searchMetadataSource('crossref', 'three')).rejects.toBeInstanceOf(SourceUnavailable);
  });

  it('respects Retry-After without making another upstream request', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(searchMetadataSource('europepmc', 'one')).rejects.toThrow(/rate limit/);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(searchMetadataSource('europepmc', 'two')).rejects.toBeInstanceOf(SourceUnavailable);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
