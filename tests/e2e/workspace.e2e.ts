/** Client contract and layout QA against deterministic API fixtures, using the existing CDP browser. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Browser, findChrome } from './browser.js';

const dist = path.resolve(import.meta.dirname, '../../dist');
const ready = Boolean(findChrome() && fs.existsSync(path.join(dist, 'index.html')));
if (process.env.CI && !ready) throw new Error('Build the app and install Chrome before browser QA.');
const article = { id: 'one', title: 'A field guide to the independent web', url: 'https://example.org/guide', snippet: 'Thoughtful personal websites, open knowledge and useful discoveries from across the web.', source: 'web', domain: 'example.org', rootDomain: 'example.org', verdict: 'clean', signals: [], netScore: 80, authenticityScore: 90, slopScore: 4, relevanceScore: 88, isIndieWeb: true };
const sources = [
  { id: 'crossref', name: 'Crossref', category: 'Research', description: 'Scholarly publications, citations and research metadata.', homepage: 'https://crossref.org' },
  { id: 'wiki', name: 'Wikipedia', category: 'Reference', description: 'The free encyclopedia, written by people around the world.', homepage: 'https://wikipedia.org' },
  { id: 'marginalia', name: 'Marginalia', category: 'Independent web', description: 'An independent search engine for personal sites and the small web.', homepage: 'https://marginalia-search.com', requiresKey: true },
];
const utilityPlugin = {
  id: 'archive-utility', name: 'Archive utility', description: 'Look up useful records and retrieve files from the independent web.',
  category: 'utility', source: 'builtin', configured: true, hasRunner: true, homepage: 'https://example.org',
  container: { image: 'ghcr.io/example/archive-utility:latest' },
  tools: [
    { id: 'lookup', name: 'Look up a record', description: 'Find records in an archive.', inputs: [{ key: 'url', type: 'text', label: 'URL', required: true }] },
    { id: 'detail', name: 'Retrieve record detail', description: 'Read a record.', inputs: [] },
  ],
};
const runningServices = ['Bitmagnet', 'SearXNG'].map((name) => ({
  id: name.toLowerCase(), name, category: 'Search', state: 'running', statusText: 'Up 2 hours', ports: ['8080:8080'], webUrl: 'https://example.org',
}));

describe.skipIf(!ready)('search workspace in Chrome', () => {
  let server: http.Server;
  let browser: Browser;
  let base: string;
  let mode: 'public' | 'private' = 'public';
  let populatedPrivateViews = false;
  let requests: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        requests.push(url.pathname);
        res.setHeader('Content-Type', 'application/json');
        const json = (data: unknown) => res.end(JSON.stringify(data));
        if (url.pathname === '/api/capabilities') return json({ mode, features: { tools: mode === 'private', research: mode === 'private', downloads: mode === 'private', administration: mode === 'private', savedProfiles: mode === 'private' } });
        if (url.pathname === '/api/auth') return json({ required: false, authenticated: true });
        if (url.pathname === '/api/sources') return json({ sources });
        if (url.pathname === '/api/plugins') return json({ plugins: populatedPrivateViews ? [utilityPlugin] : [], userDir: '' });
        if (url.pathname === '/api/plugins/archive-utility/container') return json({ state: 'running' });
        if (url.pathname === '/api/containers') return json({ daemonRunning: true, activeRuntime: 'docker', services: runningServices });
        if (url.pathname === '/api/downloads') return json(populatedPrivateViews ? {
          jobs: [], pluginTargets: [], integrations: { offcloudConfigured: false, nzbLifeConfigured: false, nextcloudConfigured: false, aria2Reachable: false, localDownloadsDir: '/Users/example/Downloads/glogg' },
        } : { jobs: [] });
        if (url.pathname === '/api/search') return json({ query: 'independent web', results: [article, { ...article, id: 'two', url: 'https://notes.example.org', title: 'Notes from a smaller internet' }], filteredSlop: [], p2pResults: [], compiledQuery: { escapeUrls: [] }, metrics: { durationMs: 230, sourceTimings: { marginalia: { status: 'ok', count: 2, ms: 230 } } } });
        if (url.pathname === '/api/inspect') return json({ url: article.url, title: article.title, domain: article.domain, verdict: 'clean', slopScore: 0, authenticityScore: 90, signals: [], stats: {}, coreTakeaway: '', primarySources: [], sections: [{ id: 'one', tag: 'p', text: article.snippet }], links: [] });
        res.statusCode = 404; return json({ error: 'Not scripted' });
      }
      const file = url.pathname.startsWith('/assets/') ? path.join(dist, 'assets', path.basename(url.pathname)) : ['/logo.png', '/icon-192.png', '/apple-touch-icon.png', '/favicon-16.png', '/favicon-32.png', '/sw.js', '/site.webmanifest'].includes(url.pathname) ? path.join(dist, path.basename(url.pathname)) : path.join(dist, 'index.html');
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
      const type = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.html': 'text/html', '.webmanifest': 'application/manifest+json' }[path.extname(file)] ?? 'application/octet-stream';
      res.setHeader('Content-Type', type); res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await Browser.launch(inject('tmpRoot'));
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    browser.on('Fetch.requestPaused', (event) => {
      const url = String((event.request as { url: string }).url);
      void browser.send(url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:') ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: event.requestId, ...(url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:') ? {} : { errorReason: 'BlockedByClient' }) });
    });
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });
  const screenshot = async (name: string) => { await browser.eval('Promise.all(document.getAnimations().filter((a) => a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))'); if (process.env.GLOGG_UI_SCREENSHOTS) await browser.screenshot(path.join(process.env.GLOGG_UI_SCREENSHOTS, `${name}.png`)); };
  const noOverflow = async () => expect(await browser.eval('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

  it('keeps the desktop search and result list compact without obscuring actions', async () => {
    mode = 'public';
    await browser.viewport(1440, 1000);
    await browser.goto(base);
    await browser.waitFor('document.querySelector(".home-search input")');
    await browser.settle();
    expect(await browser.eval('document.querySelector(".home-search").getBoundingClientRect().top')).toBeLessThan(130);
    await browser.click('input[aria-label="Search"]'); await browser.type('independent web'); await browser.click('[aria-label="Submit search"]');
    await browser.waitFor('document.querySelectorAll("article.result").length === 2');
    const rows = await browser.eval<{ height: number; titleFirst: boolean; saveVisible: boolean }[]>(`[...document.querySelectorAll('article.result')].map(row => ({
      height: row.getBoundingClientRect().height,
      titleFirst: Boolean(row.querySelector('.result-h').compareDocumentPosition(row.querySelector('.result-meta')) & Node.DOCUMENT_POSITION_FOLLOWING),
      saveVisible: getComputedStyle(row.querySelector('.result-actions')).opacity === '1'
    }))`);
    for (const row of rows) { expect(row.height).toBeLessThan(125); expect(row.titleFirst).toBe(true); expect(row.saveVisible).toBe(true); }
    await browser.eval('localStorage.clear()');
  });

  it('keeps search focus inside one aligned field boundary', async () => {
    for (const width of [1440, 320]) {
      await browser.viewport(width, 844);
      await browser.send('Emulation.setTouchEmulationEnabled', { enabled: width === 320, maxTouchPoints: 1 });
      for (const route of ['/', '/sources']) {
        await browser.goto(`${base}${route}`);
        await browser.waitFor('document.querySelector(".searchbox-input")');
        await browser.click('.searchbox-input');
        const field = await browser.eval<{ outline: string; shadow: string; inputInside: boolean }>(`(() => {
          const input=document.querySelector('.searchbox-input'), form=input.closest('.searchbox');
          const i=input.getBoundingClientRect(), f=form.getBoundingClientRect();
          return {outline:getComputedStyle(input).outlineStyle,shadow:getComputedStyle(form).boxShadow,inputInside:i.left>=f.left && i.right<=f.right && i.top>=f.top && i.bottom<=f.bottom};
        })()`);
        expect.soft(field.outline, `${width}px ${route}: no second input ring`).toBe('none');
        expect.soft(field.shadow, `${width}px ${route}: group focus stays inside the border`).toContain('inset');
        expect(field.inputInside).toBe(true);
        await screenshot(`search-focus-${width}-${route === '/' ? 'home' : 'bar'}`);
        await browser.press('Tab');
        expect(await browser.eval('document.activeElement.className')).toBe('searchbox-submit');
        expect.soft(await browser.eval('parseFloat(getComputedStyle(document.activeElement).outlineOffset)'), 'button focus stays inside its own boundary').toBeLessThanOrEqual(0);
      }
    }
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  });

  it('desktop search, saved library, filtering, reload, reader, removal and source preferences', async () => {
    await browser.viewport(1440, 1000);
    await browser.goto(base);
    await browser.waitFor('document.querySelector(".home input[aria-label=Search]")');
    await browser.settle();
    await screenshot('desktop-home');
    await noOverflow();
    await browser.click('input[aria-label="Search"]'); await browser.type('independent web'); await browser.click('[aria-label="Submit search"]');
    await browser.waitFor('document.querySelectorAll("article.result").length === 2');
    await browser.click('[aria-label="Save A field guide to the independent web"]');
    await screenshot('desktop-results');
    await browser.click('a[href="/saved"]');
    await browser.waitFor('document.querySelector(".saved-card")');
    await screenshot('desktop-library');
    const downloadDir = path.join(inject('tmpRoot'), 'library-export');
    fs.mkdirSync(downloadDir, { recursive: true });
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await browser.click('.library-page .page-head button');
    let exportFile: string | undefined;
    for (let i = 0; i < 40 && !exportFile; i++) {
      exportFile = fs.readdirSync(downloadDir).find((file) => file.endsWith('.json'));
      if (!exportFile) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(exportFile).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(downloadDir, exportFile!), 'utf8'))).toMatchObject({ format: 'glogg-library', version: 1, items: [{ title: article.title, url: article.url, snippet: article.snippet }] });
    await browser.reload();
    await browser.waitFor('document.querySelector(".saved-card")');
    await browser.click('[aria-label="Search saved library"]'); await browser.type('unmatched phrase');
    await browser.waitFor('!document.querySelector(".saved-card")');
    await browser.click('.collection-empty button');
    await browser.waitFor('document.querySelector(".saved-card")');
    await browser.click('[aria-label="Read A field guide to the independent web"]');
    await browser.waitFor('document.querySelector(".reader-content")');
    expect(await browser.eval('document.querySelector(".reader-content").textContent')).toContain('Thoughtful personal websites');
    await browser.press('Escape');
    await browser.click('[aria-label="Remove A field guide to the independent web from saved library"]');
    await browser.waitFor('document.querySelector(".collection-empty h2")?.textContent === "No saved items yet"');
    expect(await browser.eval('document.querySelector(".collection-empty button").textContent')).toContain('Search the web');
    await browser.click('a[href="/sources"]');
    await browser.waitFor('document.querySelectorAll(".source-card").length === 3');
    await browser.click('[aria-label="Enable Crossref"]');
    await screenshot('desktop-sources');
    await browser.reload();
    await browser.waitFor(`document.querySelector('[aria-label="Enable Crossref"]')?.getAttribute('aria-checked') === 'false'`);
    expect(await browser.eval('JSON.parse(localStorage.getItem("glogg.prefs")).disabledSources')).toContain('crossref');
    expect(requests.filter((url) => /^\/api\/(plugins|downloads|profile|integrations|nodes|research)/.test(url))).toEqual([]);
    expect(browser.errors).toEqual([]);
  });

  it('mobile navigation, dark theme, focus and reduced motion stay usable', async () => {
    mode = 'private'; requests = [];
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await browser.viewport(390, 844);
    await browser.goto(base);
    await browser.waitFor(`document.querySelector('a[href="/tools"]')`);
    await browser.settle();
    await screenshot('mobile-home');
    await noOverflow();
    await browser.click('.mobile-more');
    await browser.waitFor('document.querySelector(".nav-secondary.open")');
    await browser.click('a[href="/settings"]');
    await browser.waitFor('document.querySelector(".settings-page")');
    expect(await browser.eval('document.querySelector(".mobile-more").getAttribute("aria-expanded")')).toBe('false');
    await browser.click('a[aria-label="Search home"]');
    await browser.click('[aria-label="Toggle theme"]');
    await browser.waitFor('document.documentElement.classList.contains("dark")');
    await screenshot('mobile-dark');
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(await browser.eval('getComputedStyle(document.querySelector(".appnav-btn")).transitionDuration')).toBe('0s');
    await browser.click('.mobile-more');
    await browser.press('Escape');
    expect(await browser.eval('document.activeElement.classList.contains("mobile-more")')).toBe(true);
    expect(await browser.eval('getComputedStyle(document.activeElement).outlineStyle')).not.toBe('none');
    await noOverflow();
    await browser.click('a[href="/sources"]');
    await browser.waitFor('document.querySelectorAll(".source-card").length === 3');
    expect(await browser.eval(`document.querySelector('.appnav-btn[aria-current="page"]').textContent`)).toBe('Sources');
    await screenshot('mobile-sources');
    await noOverflow();
    await browser.click('a[href="/saved"]');
    await browser.waitFor('document.querySelector(".library-page")');
    await screenshot('mobile-library');
    await noOverflow();
    await browser.click('button[aria-label="glogg home"]');
    await browser.viewport(320, 700);
    await noOverflow();
    await browser.viewport(900, 800);
    await browser.click('.mobile-more');
    await browser.waitFor('document.querySelector(".nav-secondary.open")');
    await browser.click('a[href="/tools"]');
    await browser.waitFor('location.pathname === "/tools"');
    await noOverflow();
    await browser.viewport(390, 844);
    await browser.goto(`${base}/?q=independent+web`);
    await browser.waitFor('document.querySelectorAll("article.result").length === 2');
    expect(await browser.eval(`[...document.querySelectorAll('.scopes .scope')].every(button => button.scrollWidth <= button.clientWidth)`)).toBe(true);
    const targets = await browser.eval<{ x:number; width:number; height:number }[]>(`[...document.querySelectorAll('.result:first-child .result-actions button')].map(button => { const r = button.getBoundingClientRect(); return { x:r.x,width:r.width,height:r.height }; })`);
    expect(targets.length).toBeGreaterThanOrEqual(3);
    for (const [i, target] of targets.entries()) {
      expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44);
      if (i) expect(target.x).toBeGreaterThanOrEqual(targets[i - 1].x + targets[i - 1].width);
    }
    await screenshot('mobile-results');
    await noOverflow();
    expect(browser.errors).toEqual([]);
  });

  const openPrivateView = async (view: string, width: number, readySelector: string) => {
    mode = 'private'; populatedPrivateViews = true;
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: width < 600, maxTouchPoints: 1 });
    await browser.viewport(width, 900);
    await browser.goto(`${base}/${view}`);
    await browser.waitFor(`document.querySelector(${JSON.stringify(readySelector)})`);
    await browser.settle();
    await screenshot(`private-${view}-${width}`);
    await noOverflow();
  };

  it.each([320, 390, 768, 1440])('populated private services separate names from actions at %ipx', async (width) => {
    try {
      await openPrivateView('services', width, '.service');
      const rows = await browser.eval<{ name: string; nameFits: boolean; textClearOfActions: boolean; actionsFit: boolean }[]>(`[...document.querySelectorAll('.service')].map(row => {
        const name = row.querySelector('.service-name');
        const actions = row.querySelector('.service-actions').getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        const text = document.createRange(); text.selectNodeContents(name);
        return {
          name: name.textContent,
          nameFits: name.scrollWidth <= name.clientWidth + 1,
          textClearOfActions: [...text.getClientRects()].every(r => r.right <= actions.left || r.left >= actions.right || r.bottom <= actions.top || r.top >= actions.bottom),
          actionsFit: actions.left >= bounds.left && actions.right <= bounds.right && actions.top >= bounds.top && actions.bottom <= bounds.bottom,
        };
      })`);
      expect(rows).toHaveLength(runningServices.length);
      for (const row of rows) {
        expect.soft(row.nameFits, `${row.name} must fit its text column`).toBe(true);
        expect.soft(row.textClearOfActions, `${row.name} must not overlap its controls`).toBe(true);
        expect.soft(row.actionsFit, `${row.name} controls must stay inside the row`).toBe(true);
      }
    } finally { populatedPrivateViews = false; }
  });

  it.each([320, 390, 768, 1440])('populated private tools reserve readable header space at %ipx', async (width) => {
    try {
      await openPrivateView('tools', width, '.tools-main');
      const header = await browser.eval<{ textHasMajority: boolean; textFits: boolean; badgesFit: boolean; badgesClearOfText: boolean }>(`(() => {
        const head = document.querySelector('.plugin-head').getBoundingClientRect();
        const text = document.querySelector('.plugin-head-text');
        const t = text.getBoundingClientRect();
        const b = document.querySelector('.plugin-badges').getBoundingClientRect();
        return {
          textHasMajority: t.width > head.width / 2,
          textFits: text.scrollWidth <= text.clientWidth + 1,
          badgesFit: b.left >= head.left && b.right <= head.right && b.top >= head.top && b.bottom <= head.bottom,
          badgesClearOfText: b.right <= t.left || b.left >= t.right || b.bottom <= t.top || b.top >= t.bottom,
        };
      })()`);
      expect.soft(header.textHasMajority, 'The plugin name and description need most of the header width').toBe(true);
      expect.soft(header.textFits, 'Plugin text must fit its column').toBe(true);
      expect.soft(header.badgesFit, 'Plugin badges must stay inside the header').toBe(true);
      expect.soft(header.badgesClearOfText, 'Plugin badges must not overlap the description').toBe(true);
    } finally { populatedPrivateViews = false; }
  });

  it.each([320, 390, 768, 1440])('populated private downloads give the URL room to edit at %ipx', async (width) => {
    try {
      await openPrivateView('downloads', width, '.destinations');
      const form = await browser.eval<{ inputWidth: number; selectWidth: number; rowWidth: number; controlsBelowInput: boolean; controlsFit: boolean }>(`(() => {
        const row = document.querySelector('.add-row');
        const r = row.getBoundingClientRect();
        const input = row.querySelector('input').getBoundingClientRect();
        const select = row.querySelector('select').getBoundingClientRect();
        const button = row.querySelector('button').getBoundingClientRect();
        return {
          inputWidth: input.width, selectWidth: select.width, rowWidth: r.width,
          controlsBelowInput: select.top >= input.bottom && button.top >= input.bottom,
          controlsFit: [...row.children].every(el => { const b = el.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom; }),
        };
      })()`);
      expect.soft(form.controlsFit, 'Download controls must stay inside the form').toBe(true);
      if (width < 600) {
        expect.soft(form.inputWidth, 'The URL input should span the phone form').toBeGreaterThanOrEqual(form.rowWidth - 1);
        expect.soft(form.controlsBelowInput, 'Destination and Send should follow the full-width URL').toBe(true);
      } else {
        expect.soft(form.inputWidth, 'The editable URL needs more room than the destination label').toBeGreaterThan(form.selectWidth);
      }
    } finally { populatedPrivateViews = false; }
  });
});
