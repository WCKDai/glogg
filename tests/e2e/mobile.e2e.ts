/** Mobile regressions from real screenshots, against local API fixtures only. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Browser, findChrome } from './browser.js';

const dist = path.resolve(import.meta.dirname, '../../dist');
const ready = Boolean(findChrome() && fs.existsSync(path.join(dist, 'index.html')));
if (process.env.CI && !ready) throw new Error('Build the app and install Chrome before mobile QA.');

describe.skipIf(!ready)('mobile search and public Atlas', () => {
  let browser: Browser, server: http.Server, base: string;
  const requests: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
      const json = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
      if (url.pathname.startsWith('/api/')) {
        requests.push(url.pathname);
        if (url.pathname === '/api/capabilities') return json({ mode: 'public', features: { tools: false, research: false, downloads: false, administration: false, savedProfiles: false } });
        if (url.pathname === '/api/auth') return json({ required: false, authenticated: true });
        if (url.pathname === '/api/directory') return json({ items: [{ title: 'Useful small site', url: 'https://small.example/', domain: 'small.example', description: 'Independent notes.', category: 'essays-culture', tags: [], era: 'pre-llm' }] });
        if (url.pathname === '/api/deep') return json({ available: true, crawling: false, posts: 0, bytes: 0, byKind: [] });
        if (url.pathname === '/api/search') return json({ query: 'independent web', results: [], filteredSlop: [], p2pResults: [], compiledQuery: { escapeUrls: [] }, metrics: { durationMs: 1, sourceTimings: {} } });
        if (url.pathname === '/api/sources') return json({ sources: [] });
        res.statusCode = 404; return json({ error: 'Not scripted' });
      }
      const file = url.pathname.startsWith('/assets/') ? path.join(dist, 'assets', path.basename(url.pathname)) : /\.(?:png|js|webmanifest)$/.test(url.pathname) ? path.join(dist, path.basename(url.pathname)) : path.join(dist, 'index.html');
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html');
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await Browser.launch(inject('tmpRoot'));
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
  const capture = async (name: string) => { if (process.env.GLOGG_UI_SCREENSHOTS) await browser.screenshot(path.join(process.env.GLOGG_UI_SCREENSHOTS, `${name}.png`)); };

  it.each([320, 390, 430])('keeps every search scope fully visible after horizontal scrolling at %ipx', async (width) => {
    await browser.viewport(width, 844);
    for (const route of ['/', '/?q=independent+web']) {
      await browser.goto(`${base}${route}`);
      await browser.waitFor('document.querySelector(".scopes .scope")');
      await browser.settle();
      const geometry = await browser.eval<{ scrollLeft: number; clientHeight: number; scrollHeight: number; clipped: string[] }>(`(() => {
        const bar = document.querySelector('.scopes');
        bar.scrollLeft = bar.scrollWidth;
        const boundary = bar.getBoundingClientRect();
        const clipped = [...bar.querySelectorAll('.scope')].filter(button => {
          const range = document.createRange(); range.selectNodeContents(button); const text = range.getBoundingClientRect();
          const target = button.getBoundingClientRect();
          return target.height < 44 || text.top < boundary.top || text.bottom > boundary.top + bar.clientHeight;
        }).map(button => button.textContent);
        return { scrollLeft: bar.scrollLeft, clientHeight: bar.clientHeight, scrollHeight: bar.scrollHeight, clipped };
      })()`);
      await capture(`scope-scroll-${width}-${route === '/' ? 'home' : 'results'}`);
      expect.soft(geometry.scrollLeft).toBeGreaterThan(0);
      expect.soft(geometry.clipped, JSON.stringify(geometry)).toEqual([]);
      expect.soft(geometry.scrollHeight, 'The horizontal scroller must not scroll vertically').toBe(geometry.clientHeight);
      expect(await browser.eval('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    }
  });

  it('opens the public Atlas deep link as a useful directory without index administration', async () => {
    requests.length = 0;
    await browser.viewport(390, 844); await browser.goto(`${base}/atlas?tab=index`);
    await browser.waitFor('document.querySelector(".atlas-tabs")'); await browser.settle();
    await capture('public-atlas-mobile');
    expect(await browser.eval(`document.querySelector('.atlas-page').textContent`)).not.toMatch(/Paused|on disk|deep\.db|Deep index|posts indexed/);
    expect(await browser.eval(`document.querySelector('.atlas-tabs [aria-selected="true"]').textContent`)).toBe('Hand-picked');
    expect(await browser.eval(`!!document.querySelector('.dir-title[href="https://small.example/"]')`)).toBe(true);
    expect(requests).not.toContain('/api/deep');
    expect(await browser.eval('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  });
});
