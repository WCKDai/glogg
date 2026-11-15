import { commonsAssetUrl } from '../src/core/media.js';
import { publicFetch } from './publicFetch.js';
import { createWorkLimit } from './workLimits.js';

export interface MediaImage { body: Buffer; type: string }
type Options = { fetchImage?: (url: string, options?: RequestInit) => Promise<Response>; maxBytes?: number; maxCacheBytes?: number; maxEntries?: number; concurrency?: number; timeoutMs?: number; ttlMs?: number };

function rasterSignature(body: Buffer, type: string): boolean {
  if (type === 'image/png') return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return body[0] === 255 && body[1] === 216 && body[2] === 255;
  if (type === 'image/gif') return /^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'));
  if (type === 'image/webp') return body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP';
  if (type === 'image/avif') return body.subarray(4, 8).toString() === 'ftyp' && /^(?:avif|avis)$/.test(body.subarray(8, 12).toString());
  return false;
}

/** Fixed-host raster fetches. Defaults cap retained bytes at 32 MiB and active bodies at 8 × 4 MiB. */
export function createMediaImageStore(options: Options = {}) {
  const { fetchImage = publicFetch, maxBytes = 4 * 1024 * 1024, maxCacheBytes = 32 * 1024 * 1024, maxEntries = 256, concurrency = 8, timeoutMs = 8000, ttlMs = 60 * 60_000 } = options;
  const capacity = createWorkLimit(concurrency);
  const cache = new Map<string, { image: MediaImage | null; until: number }>();
  const pending = new Map<string, Promise<MediaImage | null>>();
  let retainedBytes = 0;
  const remove = (url: string) => { retainedBytes -= cache.get(url)?.image?.body.length ?? 0; cache.delete(url); };
  const remember = (url: string, image: MediaImage | null) => {
    if (image && image.body.length > maxCacheBytes) return;
    while (cache.size >= maxEntries || retainedBytes + (image?.body.length ?? 0) > maxCacheBytes) remove(cache.keys().next().value!);
    cache.set(url, { image, until: Date.now() + (image ? ttlMs : 30_000) });
    retainedBytes += image?.body.length ?? 0;
  };
  const load = async (url: string): Promise<MediaImage | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await fetchImage(url, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent': 'glogg/0.4 (+https://github.com/WCKDai/glogg)' } });
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || !/^image\/(?:jpeg|png|gif|webp|avif)$/.test(type) || Number(response.headers.get('content-length')) > maxBytes || !response.body) return null;
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) return null;
        chunks.push(chunk.value);
      }
      const body = Buffer.concat(chunks, bytes);
      return rasterSignature(body, type) ? { body, type } : null;
    } catch { return null; }
    finally {
      if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => undefined);
      clearTimeout(timer);
    }
  };
  return {
    async get(value: string): Promise<MediaImage | null> {
      const url = commonsAssetUrl(value, 'image');
      if (!url) throw new Error('Unsupported media image');
      const hit = cache.get(url);
      if (hit && hit.until > Date.now()) { cache.delete(url); cache.set(url, hit); return hit.image; }
      if (hit) remove(url);
      let work = pending.get(url);
      if (!work) {
        const release = capacity.acquire();
        work = load(url).then(image => { remember(url, image); return image; }).finally(() => { pending.delete(url); release(); });
        pending.set(url, work);
      }
      return work;
    },
  };
}

export const mediaImages = createMediaImageStore();
