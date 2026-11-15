/**
 * Site icons for result rows, fetched by glogg instead of the browser: the
 * icon service never sees your address or which sites are on your results
 * page (a shared glogg shows it only glogg's own address, and asks once a day
 * per site). Raster images only, small, kept in memory.
 */
import { readCapped } from './publicFetch.js';
import { configuredLimit, createWorkLimit } from './workLimits.js';

const ICON_SERVICE = 'https://icons.duckduckgo.com/ip3/';
const MAX_BYTES = 64 * 1024;
const TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 2000;
// No SVG: opened on its own, an SVG is a document that could run script under glogg's address.
const RASTER = /^image\/(x-icon|vnd\.microsoft\.icon|png|gif|jpeg|webp|avif)$/;

export type Icon = { body: Buffer; type: string; at: number } | { body?: undefined; at: number };

const cache = new Map<string, Icon>();
const pending = new Map<string, Promise<Icon>>();
const capacity = createWorkLimit(configuredLimit('GLOGG_MAX_FAVICONS', 32));

/** A plain host name: letters, digits, hyphens and dots, with at least one dot. */
export function isIconDomain(domain: string): boolean {
  return domain.length <= 253 && /^(?=.*[a-z])[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i.test(domain);
}

async function load(domain: string, fetchImpl: typeof fetch): Promise<Icon> {
  let icon: Icon = { at: Date.now() };
  try {
    const res = await fetchImpl(`${ICON_SERVICE}${encodeURIComponent(domain)}.ico`, { signal: AbortSignal.timeout(4000) });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (res.ok && RASTER.test(type)) {
      const body = await readCapped(res, MAX_BYTES + 1);
      if (body.length > 0 && body.length <= MAX_BYTES) icon = { body, type, at: Date.now() };
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
  } catch {
    // no icon; the row shows the site's letter
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(domain, icon);
  return icon;
}

/** The icon for `domain`, from memory when it was fetched in the last day. Concurrent asks share one fetch. */
export function siteIcon(domain: string, fetchImpl: typeof fetch = fetch): Promise<Icon> {
  const key = domain.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    const release = capacity.acquire();
    p = load(key, fetchImpl).finally(() => { pending.delete(key); release(); });
    pending.set(key, p);
  }
  return p;
}

export function clearIconCache(): void {
  cache.clear();
}
