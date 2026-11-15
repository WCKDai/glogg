import { commonsAssetUrl, type MediaKind, type SearchMedia } from '../src/core/media.js';
import type { RawSearchResult } from '../src/core/types.js';
import { htmlToText, wellFormed } from '../src/core/text.js';
import { fetchUpstream, readUpstreamJson } from './upstream.js';
import { SourceUnavailable } from './sourceStatus.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, max = 300): string => typeof value === 'string' ? htmlToText(value).replace(/\s+/g, ' ').trim().slice(0, max) : '';
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const state = { active: false, next: 0 };
// Conservative metadata flag for the existing adult preference, not a comprehensive SafeSearch guarantee.
const EXPLICIT = /\b(?:nsfw|nudes?|nudity|naked|porn(?:ography|ographic)?|sexual (?:intercourse|acts?)|genitals?|genitalia|penis|penises|vulvas?|masturbat(?:ion|ing)|fetish|gore|graphic violence)\b/i;
export function resetCommonsMedia(): void { state.active = false; state.next = 0; }

function parsePage(value: unknown, kind: MediaKind): (RawSearchResult & { media: SearchMedia }) | null {
  const page = object(value);
  const filename = typeof page.title === 'string' && page.title.length <= 512 && page.title.startsWith('File:') ? page.title : '';
  const info = object(list(page[kind === 'image' ? 'imageinfo' : 'videoinfo'])[0]);
  if (!filename || !Number.isSafeInteger(page.pageid) || Number(page.pageid) <= 0 || 'badfile' in info) return null;
  const meta = object(info.extmetadata);
  const field = (key: string, max?: number) => text(object(meta[key]).value, max);
  const original = commonsAssetUrl(info.url, kind);
  const previewUrl = commonsAssetUrl(info.thumburl, 'image') ?? (kind === 'image' ? original : null);
  if (!original || !previewUrl) return null;
  let url = original;
  let mimeType = text(info.mime).toLowerCase();
  if (kind === 'video') {
    const derivatives = list(info.derivatives).map(object).map(row => ({ url: commonsAssetUrl(row.src, 'video'), mime: text(row.type).split(';')[0], height: positive(row.height) ?? Infinity })).filter(row => row.url && /^(?:video\/webm|video\/mp4|video\/ogg)$/.test(row.mime));
    // A modest rendition avoids loading multi-gigabyte originals on a phone.
    const rendition = derivatives.filter(row => row.height <= 720).sort((a, b) => Math.abs(a.height - 480) - Math.abs(b.height - 480))[0];
    if (rendition) { url = rendition.url!; mimeType = rendition.mime; }
    else if (!(positive(info.size) && Number(info.size) <= 32 * 1024 * 1024)) return null;
  }
  if (!(kind === 'image' ? /^image\/(?:jpeg|png|gif|webp|avif)$/ : /^video\/(?:webm|mp4|ogg)$/).test(mimeType)) return null;
  let licenseUrl: string | undefined;
  try {
    const candidate = new URL(field('LicenseUrl'));
    if (candidate.protocol === 'https:' && !candidate.username && !candidate.password && !candidate.port) licenseUrl = candidate.href;
  } catch { /* Some files state the license without a URL. */ }
  const title = filename.slice(5).replace(/\.[^.]+$/, '').replace(/_/g, ' ').slice(0, 300);
  const attribution = field('Attribution') || field('Artist');
  const license = field('LicenseShortName');
  const description = field('ImageDescription', 800);
  return {
    id: `commons-${page.pageid}`, source: 'wikimedia', title,
    url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(wellFormed(filename))}`,
    snippet: description || [attribution, license].filter(Boolean).join(' · '),
    author: attribution || undefined,
    isNsfw: EXPLICIT.test(`${title} ${description} ${field('Categories', 4000)}`),
    media: { kind, url, previewUrl, mimeType, width: positive(info.width), height: positive(info.height), durationSeconds: kind === 'video' ? positive(info.duration) : undefined, attribution: attribution || undefined, license: license || undefined, licenseUrl },
  };
}

/** One metadata request, 8 results, 2 MB body cap. Shared pacing protects Commons at busy public instances. */
export async function searchCommonsMedia(query: string, kind: MediaKind): Promise<(RawSearchResult & { media: SearchMedia })[]> {
  if (!query.trim()) return [];
  if (state.active || Date.now() < state.next) throw new SourceUnavailable('refused', 'Wikimedia Commons is at its request limit. Try again shortly.');
  state.active = true; state.next = Date.now() + 1000;
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  const prefix = kind === 'image' ? 'ii' : 'vi';
  const params = { action: 'query', format: 'json', generator: 'search', gsrsearch: `${query.slice(0, 1024)} filetype:${kind === 'image' ? 'bitmap' : 'video'}`, gsrnamespace: '6', gsrlimit: '8', prop: kind === 'image' ? 'imageinfo' : 'videoinfo',
    [`${prefix}prop`]: `url|size|mime|extmetadata|badfile${kind === 'video' ? '|derivatives' : ''}`,
    [`${prefix}urlwidth`]: '480', [`${prefix}extmetadatafilter`]: 'Artist|Attribution|LicenseShortName|LicenseUrl|ImageDescription|Categories', [`${prefix}extmetadatalanguage`]: 'en' };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  try {
    const res = await fetchUpstream(url, { headers: { Accept: 'application/json', 'User-Agent': 'glogg/0.4 (+https://github.com/WCKDai/glogg)' } }, 4000);
    if (!res.ok) {
      if ([403, 429, 503].includes(res.status)) {
        const after = res.headers.get('retry-after') || '';
        const delay = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
        state.next = Date.now() + Math.max(1000, Math.min(30 * 60_000, Number.isFinite(delay) ? delay : 60_000));
        throw new SourceUnavailable('refused', 'Wikimedia Commons is resting after an upstream refusal.');
      }
      throw new Error(`Wikimedia Commons returned HTTP ${res.status}`);
    }
    const data = object(await readUpstreamJson(res));
    if (data.error) throw new SourceUnavailable('refused', 'Wikimedia Commons could not search right now.');
    return Object.values(object(object(data.query).pages)).sort((a, b) => Number(object(a).index ?? 0) - Number(object(b).index ?? 0)).slice(0, 8).map(row => parsePage(row, kind)).filter((row): row is RawSearchResult & { media: SearchMedia } => row !== null);
  } finally { state.active = false; }
}
