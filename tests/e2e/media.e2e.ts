/** Real image/video decoding and modal navigation, using only local fixtures. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { contentSecurityPolicy } from '../../server/security.js';
import { Browser, findChrome } from './browser.js';

const dist = path.resolve(import.meta.dirname, '../../dist');
const fixtures = path.resolve(import.meta.dirname, '../fixtures/media');
const ready = Boolean(findChrome() && fs.existsSync(path.join(dist, 'index.html')));
if (process.env.CI && !ready) throw new Error('Build the app and install Chrome before media QA.');
const imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Test_pattern.png';
const videoUrl = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/Test_pattern.webm/Test_pattern.webm.480p.webm';
const result = (kind: 'image' | 'video', index: number) => ({
  id: `media-${index}`, title: `Color test pattern ${index}`, url: `https://commons.wikimedia.org/wiki/File:Test_pattern_${index}`,
  snippet: 'A generated pattern for browser testing.', source: 'wikimedia', domain: 'commons.wikimedia.org', rootDomain: 'wikimedia.org',
  verdict: 'neutral', signals: [], netScore: 80, authenticityScore: 80, slopScore: 0, relevanceScore: 80,
  media: { kind, url: kind === 'image' ? imageUrl : videoUrl, previewUrl: imageUrl, mimeType: kind === 'image' ? 'image/png' : 'video/webm', width: 64, height: 48, durationSeconds: kind === 'video' ? 1 : undefined, attribution: 'Glogg test fixture', license: 'Test pattern' },
});

describe.skipIf(!ready)('image and video search in Chrome', () => {
  let browser: Browser, server: http.Server, base: string;
  const external: string[] = [];
  const searches: string[] = [];
  beforeAll(async () => {
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      res.setHeader('Content-Security-Policy', contentSecurityPolicy(html));
      res.setHeader('Referrer-Policy', 'no-referrer');
      const json = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
      if (url.pathname === '/api/auth') return json({ required: false, authenticated: true });
      if (url.pathname === '/api/capabilities') return json({ mode: 'public', features: { tools: false, research: false, downloads: false, administration: false, savedProfiles: false } });
      if (url.pathname === '/api/sources') return json({ sources: [{ id: 'wikimedia', name: 'Wikimedia Commons', category: 'Media', description: 'Images and videos with source credits.' }] });
      if (url.pathname === '/api/media/image') { res.setHeader('Content-Type', 'image/png'); return res.end(fs.readFileSync(path.join(fixtures, 'test-pattern.png'))); }
      if (url.pathname === '/api/search') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const lens = body.config?.lens ?? url.searchParams.get('lens') ?? 'images'; searches.push(lens);
        return json({ query: 'color pattern', lens, results: [result(lens === 'videos' ? 'video' : 'image', 1), result(lens === 'videos' ? 'video' : 'image', 2)], p2pResults: [], filteredSlop: [], compiledQuery: { escapeUrls: [] }, metrics: { durationMs: 90, sourceTimings: { wikimedia: { ms: 90, count: 2, status: 'ok' } } } });
      }
      if (url.pathname.startsWith('/api/')) { res.statusCode = 404; return json({ error: 'Not scripted' }); }
      const file = url.pathname.startsWith('/assets/') ? path.join(dist, 'assets', path.basename(url.pathname)) : /\.(?:png|js|webmanifest)$/.test(url.pathname) ? path.join(dist, path.basename(url.pathname)) : path.join(dist, 'index.html');
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html');
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await Browser.launch(inject('tmpRoot'));
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    browser.on('Fetch.requestPaused', event => {
      const url = String((event.request as { url: string }).url);
      if (url.startsWith(base)) { void browser.send('Fetch.continueRequest', { requestId: event.requestId }); return; }
      external.push(url);
      if (url === videoUrl) void browser.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'video/webm' }, { name: 'Access-Control-Allow-Origin', value: base }], body: fs.readFileSync(path.join(fixtures, 'test-pattern.webm')).toString('base64') });
      else void browser.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
  const capture = async (name: string) => { if (process.env.GLOGG_UI_SCREENSHOTS) await browser.screenshot(path.join(process.env.GLOGG_UI_SCREENSHOTS, `${name}.png`)); };

  it('searches both tabs, views and saves an image, and restores focus after Escape', async () => {
    await browser.viewport(1440, 1000); await browser.goto(base);
    await browser.waitFor('document.querySelector(".home-search input")');
    expect(await browser.eval(`!![...document.querySelectorAll('.scope')].find(el => el.textContent === 'Images') && !![...document.querySelectorAll('.scope')].find(el => el.textContent === 'Videos')`)).toBe(true);
    await browser.eval(`[...document.querySelectorAll('.scope')].find(el => el.textContent === 'Images').click()`);
    await browser.click('input[aria-label="Search"]'); await browser.type('color pattern'); await browser.press('Enter');
    await browser.waitFor('document.querySelectorAll(".media-card").length === 2');
    await browser.waitFor('[...document.querySelectorAll(".media-preview img")].every(img => img.complete && img.naturalWidth > 0)');
    expect(searches.at(-1)).toBe('images'); expect(external).toEqual([]);
    await capture('desktop-images');
    await browser.click('.media-links button'); expect(await browser.eval('document.querySelector(".media-links button").getAttribute("aria-pressed")')).toBe('true');
    await browser.click('.media-preview');
    await browser.waitFor('document.querySelector(".media-stage img")?.naturalWidth > 0');
    expect(await browser.eval('document.querySelector("[role=dialog]").getAttribute("aria-label")')).toBe('Image viewer');
    await browser.click('.media-viewer [aria-pressed]'); expect(await browser.eval('!!document.querySelector(".media-stage.zoomed")')).toBe(true);
    await browser.press('Escape');
    await browser.waitFor('!document.querySelector(".media-viewer")');
    expect(await browser.eval('document.activeElement.className')).toBe('media-preview');
    expect(external).toEqual([]); expect(browser.errors).toEqual([]);
  });

  it('fits a320px phone and plays a decoded video only after explicit Play', async () => {
    external.length = 0;
    await browser.viewport(320, 844); await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await browser.goto(base);
    await browser.waitFor('document.querySelector(".home-search input")');
    await browser.eval(`[...document.querySelectorAll('.scope')].find(el => el.textContent === 'Videos').click()`);
    await browser.click('input[aria-label="Search"]'); await browser.type('color pattern'); await browser.press('Enter');
    await browser.waitFor('document.querySelectorAll(".media-card").length === 2');
    expect(searches.at(-1)).toBe('videos');
    expect(await browser.eval('document.documentElement.scrollWidth')).toBe(320);
    await capture('mobile-videos');
    await browser.click('.media-preview');
    await browser.waitFor('document.querySelector(".media-start")');
    expect(await browser.eval('document.querySelector("video")')).toBeNull(); expect(external).toEqual([]);
    const bounds = await browser.eval<{ left: number; right: number; bottom: number }>('(() => {const r=document.querySelector(".media-viewer").getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}})()');
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(320); expect(bounds.bottom).toBeLessThanOrEqual(844);
    await capture('mobile-video-viewer');
    await browser.click('.media-start');
    await browser.waitFor('document.querySelector("video")?.currentTime > 0', 'video fixture to decode and play');
    expect(external.length).toBeGreaterThan(0); expect(external.every(url => url === videoUrl)).toBe(true);
    expect(await browser.eval('document.querySelector("video").playsInline')).toBe(true);
    await browser.eval('history.back()');
    await browser.waitFor('!document.querySelector(".media-viewer") && !!document.querySelector(".home")', 'Back to close the viewer and stop playback');
    expect(await browser.eval('document.body.style.overflow')).toBe('');
    expect(browser.errors).toEqual([]);
  });
});
