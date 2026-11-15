/** The installed shell works offline without retaining searches or API responses. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { Browser, findChrome } from './browser.js';

const dist = path.resolve(import.meta.dirname, '../../dist');
const ready = Boolean(findChrome() && fs.existsSync(path.join(dist, 'sw.js')));
if (process.env.CI && !ready) throw new Error('Build the PWA and install Chrome before browser QA.');

describe.skipIf(!ready)('installed app shell', () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;
  let version = 1;
  let unavailable = false;
  beforeAll(async () => {
    vi.stubEnv('GLOGG_HOME', fs.mkdtempSync(path.join(inject('tmpRoot'), 'pwa-home-')));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GLOGG_MODE', 'public');
    vi.stubEnv('GLOGG_ALLOW_PRIVATE_FETCH', '');
    vi.stubEnv('GLOGG_CONTAINER_RUNTIME', 'none');
    const local = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return url.hostname === '127.0.0.1' ? local(input, init) : Promise.resolve(new Response('', { status: 404 }));
    });
    const { createGloggServer } = await import('../../server/index.js');
    const app = await createGloggServer();
    server = http.createServer((req, res) => {
      if (unavailable) return req.socket.destroy();
      if (req.url === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        return res.end(`${fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')}\n// test revision ${version}\n`);
      }
      app(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await Browser.launch(inject('tmpRoot'));
    await browser.viewport(390, 844);
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });

  it('installs, opens Saved offline, bypasses API caching and applies an update on request', async () => {
    await browser.goto(base);
    await browser.waitFor('navigator.serviceWorker.controller');
    const manifest = await browser.eval(`fetch('/site.webmanifest').then(r => r.json())`);
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' });
    await browser.eval(`localStorage.setItem('glogg.library.v1', JSON.stringify([{url:'https://example.org/notes',title:'Saved offline notes',snippet:'A bookmark kept in this browser.',source:'web',savedAt:'2026-01-01T00:00:00.000Z'}]))`);
    await browser.goto(`${base}/saved`);
    await browser.waitFor('document.querySelector(".saved-card")');
    expect(await browser.eval(`fetch('/api/health').then(r => r.ok)`)).toBe(true);
    await browser.eval(`fetch('/api/search', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'private-query-never-cache',config:{lens:'all'}})}).then(r=>r.text())`);
    const cached = await browser.eval(`caches.keys().then(async names => (await Promise.all(names.filter(n=>n.startsWith('glogg-shell-')).map(async n => (await (await caches.open(n)).keys()).map(r=>new URL(r.url).pathname + new URL(r.url).search)))).flat())`) as string[];
    expect(cached).toContain('/index.html');
    expect(cached.some((url) => url.startsWith('/assets/'))).toBe(true);
    expect(cached.some((url) => url.startsWith('/api/') || url.includes('?') || url.includes('private-query'))).toBe(false);
    unavailable = true;
    await browser.send('Network.enable');
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await browser.reload();
    await browser.waitFor('document.querySelector(".saved-card")');
    expect(await browser.eval('document.querySelector(".saved-card").textContent')).toContain('Saved offline notes');
    await browser.waitFor('document.querySelector(".pwa-status")?.textContent.includes("Offline.")');
    expect(await browser.eval(`fetch('/api/health').then(()=>false,()=>true)`)).toBe(true);
    unavailable = false;
    await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await browser.waitFor('navigator.onLine');
    version = 2;
    await browser.eval('navigator.serviceWorker.getRegistration().then(r=>r.update())');
    await browser.waitFor('document.querySelector(".pwa-status button")?.textContent === "Reload"');
    expect(await browser.eval('location.pathname')).toBe('/saved');
    await browser.click('.pwa-status button');
    await browser.waitFor('document.querySelector(".saved-card") && !document.querySelector(".pwa-status")');
    expect(await browser.eval('document.querySelector(".saved-card").textContent')).toContain('Saved offline notes');
    expect(await browser.eval('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    expect(browser.errors).toEqual([]);
  });
});
