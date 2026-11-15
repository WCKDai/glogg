import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { buildPwa } from '../scripts/build-pwa.js';

const ORIGIN = 'https://glogg.example';
let dist: string;
beforeEach(() => {
  dist = fs.mkdtempSync(path.join(inject('tmpRoot'), 'pwa-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script>');
  fs.writeFileSync(path.join(dist, 'assets/app.js'), 'console.log("app")');
  fs.writeFileSync(path.join(dist, 'assets/app.css'), 'body { color: black }');
  fs.writeFileSync(path.join(dist, 'apple-touch-icon.png'), 'apple icon');
  fs.writeFileSync(path.join(dist, 'icon-192.png'), 'app icon');
  fs.writeFileSync(path.join(dist, 'site.webmanifest'), JSON.stringify({ icons: [{ src: '/icon-192.png' }] }));
});

type Event = {
  request?: { method: string; url: string; mode: string };
  data?: unknown;
  waitUntil: (promise: Promise<unknown>) => void;
  respondWith: (promise: Promise<Response> | Response) => void;
};

/** Executes the emitted JavaScript, including its cache lifecycle, without touching the network. */
function worker(directory = dist) {
  const handlers = new Map<string, (event: Event) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const absolute = (input: string | URL | Request) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, ORIGIN).href;
  const network = vi.fn(async (input: string | URL | Request) => new Response(`network:${absolute(input)}`));
  const caches = {
    keys: async () => [...stores.keys()],
    delete: vi.fn(async (name: string) => stores.delete(name)),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        match: async (input: string | URL | Request) => store.get(absolute(input))?.clone(),
        addAll: async (inputs: Request[]) => {
          // Like Cache.addAll, reject the whole batch if one response fails.
          const responses = await Promise.all(inputs.map(async (input) => {
            const response = await network(input);
            if (!response.ok) throw new Error('Precache request failed');
            return [absolute(input), response] as const;
          }));
          for (const [key, response] of responses) store.set(key, response);
        },
      };
    },
  };
  const claim = vi.fn(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined);
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'sw.js'), 'utf8'), {
    self: { location: { origin: ORIGIN }, addEventListener: (type: string, handler: (event: Event) => void) => handlers.set(type, handler), clients: { claim }, skipWaiting },
    caches, fetch: network, Request, Response, URL,
  });
  const dispatch = (type: string, values: Partial<Event> = {}) => {
    const work: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(type)?.({ ...values, waitUntil: (promise) => { work.push(promise); }, respondWith: (promise) => { response = Promise.resolve(promise); } });
    return { complete: Promise.all(work), response };
  };
  const request = (url: string, mode = 'cors', method = 'GET') => dispatch('fetch', { request: { method, url: new URL(url, ORIGIN).href, mode } });
  return { dispatch, request, network, stores, caches, claim, skipWaiting };
}

describe('PWA build', () => {
  it('uses actual build files and versions the worker deterministically by their contents', () => {
    fs.writeFileSync(path.join(dist, 'private-notes.json'), '{"secret":"not an asset"}');
    buildPwa(dist);
    const first = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
    expect(first).not.toContain('private-notes');
    buildPwa(dist);
    expect(fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')).toBe(first);
    fs.appendFileSync(path.join(dist, 'assets/app.js'), ';console.log("updated")');
    buildPwa(dist);
    expect(fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')).not.toBe(first);
  });

  it('fails on a missing build or missing referenced app file', () => {
    expect(() => buildPwa(path.join(dist, 'absent'))).toThrow();
    fs.unlinkSync(path.join(dist, 'assets/app.js'));
    expect(() => buildPwa(dist)).toThrow();
    expect(fs.existsSync(path.join(dist, 'sw.js'))).toBe(false);
  });

  it('fails instead of silently omitting a declared home-screen icon', () => {
    fs.unlinkSync(path.join(dist, 'icon-192.png'));
    expect(() => buildPwa(dist)).toThrow();
  });

  it.each(['https://foreign.example/icon.png', '/api/reader.png', '/icon-192.png?query=private'])('rejects a manifest icon outside the static allowlist: %s', (src) => {
    fs.writeFileSync(path.join(dist, 'site.webmanifest'), JSON.stringify({ icons: [{ src }] }));
    expect(() => buildPwa(dist)).toThrow('Cannot precache a non-static app file');
  });

  it('runs as a build command with an explicit output directory', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/build-pwa.ts', import.meta.url)), dist], { encoding: 'utf8', timeout: 5000 });
    expect(output).toContain('Built offline shell glogg-shell-');
    expect(fs.existsSync(path.join(dist, 'sw.js'))).toBe(true);
  });
});

describe('generated PWA worker', () => {
  beforeEach(() => buildPwa(dist));

  it('precaches the complete static shell without forcing activation', async () => {
    const w = worker();
    await w.dispatch('install').complete;
    expect(w.skipWaiting).not.toHaveBeenCalled();
    const entries = [...w.stores.values()][0];
    expect([...entries.keys()].sort()).toEqual(['/apple-touch-icon.png', '/assets/app.css', '/assets/app.js', '/icon-192.png', '/index.html', '/site.webmanifest'].map((p) => ORIGIN + p).sort());
    expect(w.network.mock.calls.every(([request]) => request instanceof Request && request.cache === 'reload')).toBe(true);
  });

  it('rejects installation and removes the incomplete cache if one asset cannot load', async () => {
    const w = worker();
    w.network.mockImplementation(async (request) => new Response('', { status: String((request as Request).url).endsWith('app.css') ? 503 : 200 }));
    await expect(w.dispatch('install').complete).rejects.toThrow('Precache request failed');
    expect(w.stores.size).toBe(0);
    expect(w.skipWaiting).not.toHaveBeenCalled();
  });

  it('serves known static files from the versioned cache', async () => {
    const w = worker();
    await w.dispatch('install').complete;
    w.network.mockClear();
    const response = await w.request('/assets/app.js').response;
    expect(await response!.text()).toBe(`network:${ORIGIN}/assets/app.js`);
    expect(w.network).not.toHaveBeenCalled();
  });

  it.each(['/', '/saved', '/sources', '/atlas', '/settings', '/tools', '/downloads', '/services', '/?q=private+search'])('opens %s offline using the canonical shell without persisting the navigation', async (route) => {
    const w = worker();
    await w.dispatch('install').complete;
    const before = [...w.stores.values()][0].size;
    w.network.mockRejectedValue(new TypeError('Offline'));
    const response = await w.request(route, 'navigate').response;
    expect(await response!.text()).toBe(`network:${ORIGIN}/index.html`);
    expect([...w.stores.values()][0].size).toBe(before);
    expect([...w.stores.values()][0].has(`${ORIGIN}/?q=private+search`)).toBe(false);
  });

  it('uses live navigation responses, including server errors, without caching them', async () => {
    const w = worker();
    await w.dispatch('install').complete;
    w.network.mockImplementation(async () => new Response('Service unavailable', { status: 503 }));
    const response = await w.request('/saved', 'navigate').response;
    expect(response!.status).toBe(503);
    expect(await response!.text()).toBe('Service unavailable');
    expect([...w.stores.values()][0].has(`${ORIGIN}/saved`)).toBe(false);
  });

  it('returns an honest unavailable response when storage was evicted while offline', async () => {
    const w = worker();
    w.network.mockRejectedValue(new TypeError('Offline'));
    const response = await w.request('/saved', 'navigate').response;
    expect(response!.status).toBe(503);
  });

  it.each([
    ['/api/search?q=private', 'cors', 'GET'],
    ['/api/inspect?url=https://private.example', 'navigate', 'GET'],
    ['/api/profile', 'navigate', 'GET'],
    ['/api/search', 'cors', 'POST'],
    ['/assets/app.js', 'cors', 'POST'],
    ['/assets/app.js?q=private', 'cors', 'GET'],
    ['/unknown', 'navigate', 'GET'],
    ['/downloads/private-file.txt', 'navigate', 'GET'],
    ['https://third-party.example/assets/app.js', 'cors', 'GET'],
  ])('does not intercept %s (%s, %s)', async (url, mode, method) => {
    const w = worker();
    const event = w.request(url, mode, method);
    expect(event.response).toBeUndefined();
    expect(w.network).not.toHaveBeenCalled();
    expect(w.stores.size).toBe(0);
  });

  it('only removes obsolete caches owned by this app, then claims clients', async () => {
    const w = worker();
    await w.dispatch('install').complete;
    const current = [...w.stores.keys()][0];
    w.stores.set('glogg-shell-old', new Map());
    w.stores.set('another-app', new Map());
    await w.dispatch('activate').complete;
    expect([...w.stores.keys()].sort()).toEqual([current, 'another-app'].sort());
    expect(w.claim).toHaveBeenCalledOnce();
  });

  it('activates a waiting update only on the explicit update message', async () => {
    const w = worker();
    await w.dispatch('message', { data: { type: 'UNKNOWN' } }).complete;
    expect(w.skipWaiting).not.toHaveBeenCalled();
    await w.dispatch('message', { data: { type: 'SKIP_WAITING' } }).complete;
    expect(w.skipWaiting).toHaveBeenCalledOnce();
  });
});
