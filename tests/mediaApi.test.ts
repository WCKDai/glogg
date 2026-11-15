import { afterEach, describe, expect, it, vi } from 'vitest';
import { rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';
import { mediaImages } from '../server/mediaProxy.js';
import { BusyError } from '../server/workLimits.js';

useTempGloggHome();
process.env.GLOGG_CONTAINER_RUNTIME = 'none';
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const asset = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Ocean.png';
const route = `/api/media/image?url=${encodeURIComponent(asset)}`;
async function server() {
  vi.stubEnv('GLOGG_MODE', 'public'); vi.stubEnv('GLOGG_ALLOW_PRIVATE_FETCH', '');
  const value = await startGloggServer(); close = value.close; return value;
}

describe('media image HTTP contract', () => {
  it('serves only validated same-origin images with caching and nosniff', async () => {
    const get = vi.spyOn(mediaImages, 'get').mockResolvedValue({ type: 'image/png', body: Buffer.from('fixture') });
    const { port } = await server();
    const response = await rawRequest(port, { path: route });
    expect(response.status).toBe(200); expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['cache-control']).toBe('private, max-age=3600');
    expect(get).toHaveBeenCalledWith(asset);
    get.mockClear();
    expect((await rawRequest(port, { path: '/api/media/image?url=https%3A%2F%2Fevil.example%2Fa.png' })).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
    expect((await rawRequest(port, { path: route, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await rawRequest(port, { method: 'POST', path: route })).status).toBe(403);
  });
  it('returns truthful failure and retryable overload statuses', async () => {
    const get = vi.spyOn(mediaImages, 'get').mockResolvedValue(null);
    const { port } = await server();
    expect((await rawRequest(port, { path: route })).status).toBe(404);
    get.mockRejectedValue(new BusyError());
    const response = await rawRequest(port, { path: route });
    expect(response.status).toBe(503); expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('preserves password protection for images', async () => {
    vi.stubEnv('GLOGG_PASSWORD', 'media-fixture-password');
    const get = vi.spyOn(mediaImages, 'get'); const { port } = await server();
    expect((await rawRequest(port, { path: route })).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });
});
