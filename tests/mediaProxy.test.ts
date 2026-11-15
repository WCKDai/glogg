import { describe, expect, it, vi } from 'vitest';
import { createMediaImageStore } from '../server/mediaProxy.js';
import { BusyError } from '../server/workLimits.js';

const asset = (name: string) => `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}.png`;
const png = (size = 12) => { const bytes = Buffer.alloc(size); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); return new Response(bytes, { headers: { 'Content-Type': 'image/png' } }); };

describe('bounded same-origin media images', () => {
  it('rejects arbitrary hosts and executable image types before fetching', async () => {
    const fetchImage = vi.fn(async () => png()); const store = createMediaImageStore({ fetchImage });
    for (const url of ['https://localhost/a.png', 'https://evil.example/a.png', asset('a').replace('.png', '.svg')]) {
      await expect(store.get(url)).rejects.toThrow('Unsupported media image');
    }
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it('pins the fetch policy, shares in-flight work and caches the raster', async () => {
    let resolve!: (r: Response) => void;
    const fetchImage = vi.fn((_url: string, _options?: RequestInit) => new Promise<Response>(r => { resolve = r; }));
    const store = createMediaImageStore({ fetchImage });
    const first = store.get(asset('one')); const second = store.get(asset('one'));
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(fetchImage.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(fetchImage.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    resolve(png());
    expect(await first).toEqual(await second);
    expect((await store.get(asset('one')))?.type).toBe('image/png');
    expect(fetchImage).toHaveBeenCalledOnce();
  });
  it('rejects MIME lies, SVG, HTML, redirects and oversized streams', async () => {
    for (const response of [
      new Response('<script>x</script>', { headers: { 'Content-Type': 'image/png' } }),
      new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
      new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }),
      new Response('', { status: 302, headers: { Location: asset('other') } }),
      png(33),
    ]) {
      const store = createMediaImageStore({ fetchImage: async () => response, maxBytes: 32 });
      expect(await store.get(asset('bad'))).toBeNull();
    }
  });
  it('evicts by total bytes and by entry count, not only per-file size', async () => {
    const fetchImage = vi.fn(async () => png(12));
    const store = createMediaImageStore({ fetchImage, maxBytes: 20, maxCacheBytes: 24, maxEntries: 100 });
    for (const name of ['one', 'two', 'three']) await store.get(asset(name));
    await store.get(asset('three')); expect(fetchImage).toHaveBeenCalledTimes(3);
    await store.get(asset('one')); expect(fetchImage).toHaveBeenCalledTimes(4);
    const countBound = createMediaImageStore({ fetchImage, maxBytes: 20, maxCacheBytes: 128, maxEntries: 1 });
    for (const name of ['one', 'two', 'one']) await countBound.get(asset(name));
    expect(fetchImage).toHaveBeenCalledTimes(7);
  });
  it('refuses extra producers without queueing but shares a pending image', async () => {
    let resolve!: (r: Response) => void;
    const fetchImage = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
    const store = createMediaImageStore({ fetchImage, concurrency: 1 });
    const first = store.get(asset('one')); const same = store.get(asset('one'));
    await expect(store.get(asset('two'))).rejects.toBeInstanceOf(BusyError);
    expect(fetchImage).toHaveBeenCalledOnce(); resolve(png()); await Promise.all([first, same]);
  });
  it('holds the producer permit through body completion and aborts a stalled body', async () => {
    const fetchImage = vi.fn(async (_url: string, init?: RequestInit) => new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(new Error('deadline')), { once: true });
    } }), { headers: { 'Content-Type': 'image/png' } }));
    const store = createMediaImageStore({ fetchImage, concurrency: 1, timeoutMs: 20 });
    const first = store.get(asset('one'));
    await expect(store.get(asset('two'))).rejects.toBeInstanceOf(BusyError);
    expect(await first).toBeNull();
    expect(await store.get(asset('two'))).toBeNull();
  });
});
