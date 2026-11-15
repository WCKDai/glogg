import { htmlToText } from '../src/core/text.js';
import type { RawSearchResult } from '../src/core/types.js';
import { fetchUpstream, readUpstreamJson } from './upstream.js';
import { SourceUnavailable } from './sourceStatus.js';

type MetadataSource = 'crossref' | 'europepmc' | 'openlibrary';
const state = new Map<MetadataSource, { active: boolean; next: number }>();
export function resetMetadataSources(): void { state.clear(); }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown): string => typeof v === 'string' ? htmlToText(v).replace(/\s+/g, ' ').trim() : '';
const number = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const doiUrl = (v: unknown): string | undefined => typeof v === 'string' && /^10\.\d{4,9}\/\S+$/i.test(v) ? `https://doi.org/${v.split('/').map(encodeURIComponent).join('/')}` : undefined;
const year = (v: unknown): string | undefined => /^(?:1\d{3}|20\d{2})$/.test(String(v)) ? String(v) : undefined;
const join = (values: unknown[]): string => values.map((v) => typeof v === 'number' ? String(v) : text(v)).filter(Boolean).join(' · ').slice(0, 1200);

function crossref(v: unknown): RawSearchResult | null {
  const row = object(v);
  const title = text(list(row.title)[0]);
  const url = doiUrl(row.DOI);
  if (!title || !url) return null;
  const parts = list(list(object(row.published)['date-parts'])[0]);
  const date = year(parts[0]);
  const month = typeof parts[1] === 'number' && parts[1] >= 1 && parts[1] <= 12 ? String(parts[1]).padStart(2, '0') : undefined;
  const day = typeof parts[2] === 'number' && parts[2] >= 1 && parts[2] <= 31 ? String(parts[2]).padStart(2, '0') : undefined;
  const authors = list(row.author).slice(0, 4).map((a) => join([object(a).given, object(a).family]).replace(' · ', ' ')).filter(Boolean).join(', ');
  return { id: `crossref-${row.DOI}`, source: 'crossref', url, title: title.slice(0, 300), snippet: join([authors, list(row['container-title'])[0], date, row.type]), publishedAt: date && month && day ? `${date}-${month}-${day}` : date, points: number(row['is-referenced-by-count']) };
}

function europepmc(v: unknown): RawSearchResult | null {
  const row = object(v);
  const title = text(row.title);
  const source = text(row.source);
  const id = text(row.id);
  if (!title || !/^[A-Z]+$/.test(source) || !/^[A-Za-z0-9.-]+$/.test(id)) return null;
  const date = text(row.firstPublicationDate);
  return { id: `europepmc-${source}-${id}`, source: 'europepmc', title: title.slice(0, 300), url: doiUrl(row.doi) ?? `https://europepmc.org/article/${source}/${id}`, snippet: join([row.authorString, row.journalTitle, row.pubYear, row.isOpenAccess === 'Y' ? 'Open access' : '']), publishedAt: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : year(row.pubYear), points: number(row.citedByCount) };
}

function openlibrary(v: unknown): RawSearchResult | null {
  const row = object(v);
  const title = text(row.title);
  const id = typeof row.key === 'string' ? /^(?:\/works\/)?(OL\d+W)$/.exec(row.key)?.[1] : undefined;
  if (!title || !id) return null;
  const editions = number(row.edition_count);
  return { id: `openlibrary-${id}`, source: 'openlibrary', title: title.slice(0, 300), url: `https://openlibrary.org/works/${id}`, snippet: join([list(row.author_name).slice(0, 4).map(text).filter(Boolean).join(', '), year(row.first_publish_year), editions === undefined ? '' : `${editions} edition${editions === 1 ? '' : 's'}`]), publishedAt: year(row.first_publish_year) };
}

/** Scoped metadata lookups: bounded bodies, no queue, and conservative upstream budgets. */
export async function searchMetadataSource(source: MetadataSource, query: string): Promise<RawSearchResult[]> {
  const current = state.get(source) ?? { active: false, next: 0 };
  if (current.active || Date.now() < current.next) throw new SourceUnavailable('refused', 'This source is at its request limit. Try again shortly.');
  current.active = true;
  current.next = Date.now() + (source === 'europepmc' ? 250 : 1000);
  state.set(source, current);
  const url = new URL(source === 'crossref' ? 'https://api.crossref.org/works' : source === 'europepmc' ? 'https://www.ebi.ac.uk/europepmc/webservices/rest/search' : 'https://openlibrary.org/search.json');
  const params = source === 'crossref'
    ? { 'query.bibliographic': query, rows: '6', select: 'DOI,title,author,published,container-title,is-referenced-by-count,type' }
    : source === 'europepmc' ? { query, format: 'json', pageSize: '6', resultType: 'lite' }
    : { q: query, limit: '6', fields: 'key,title,author_name,first_publish_year,edition_count' };
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  try {
    const res = await fetchUpstream(url, { headers: { Accept: 'application/json', 'User-Agent': 'glogg/0.4 (+https://github.com/WCKDai/glogg)' } }, 3000);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if ([403, 429, 503].includes(res.status)) {
        const after = res.headers.get('retry-after') || '';
        const ms = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
        current.next = Date.now() + Math.max(1000, Math.min(30 * 60_000, Number.isFinite(ms) ? ms : 60_000));
        throw new SourceUnavailable('refused', 'Upstream rate limit or temporary refusal. This source is resting.');
      }
      throw new Error(`${source} returned HTTP ${res.status}`);
    }
    const body = object(await readUpstreamJson(res));
    const rows = source === 'crossref' ? object(body.message).items : source === 'europepmc' ? object(body.resultList).result : body.docs;
    const parse = source === 'crossref' ? crossref : source === 'europepmc' ? europepmc : openlibrary;
    return list(rows).slice(0, 6).map(parse).filter((r): r is RawSearchResult => r !== null);
  } finally { current.active = false; }
}
