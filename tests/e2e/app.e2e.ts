/**
 * The built app in a real browser: headless Chrome against a production glogg
 * whose upstreams are canned, so a run never touches the internet. The browser
 * is boxed in too: every request that isn't to this glogg is refused and listed.
 *
 *   npm run build && npm run test:e2e
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { Browser, findChrome } from './browser.js';

const DIST = path.resolve(import.meta.dirname, '../../dist/index.html');
const chrome = findChrome();
// On CI a missing browser or build fails the run; elsewhere the suite is reported as skipped.
if (process.env.CI && !chrome) throw new Error('The browser tests need Chrome on CI; none was found (set CHROME_PATH).');
if (process.env.CI && !fs.existsSync(DIST)) throw new Error('Run `npm run build` before the browser tests.');
const ready = Boolean(chrome && fs.existsSync(DIST));

const QUERY = 'rust borrow checker';
const ARTICLE = `<!doctype html><html><head><title>The Rust borrow checker, explained slowly</title><meta name="author" content="Ada"></head>
<body><nav>Home · About · Subscribe</nav><article><h1>The Rust borrow checker, explained slowly</h1>
<p>The borrow checker makes sure every reference in a Rust program points at something that is still alive.</p>
<p>It does this at compile time, by tracking which part of the code owns each value and how long each borrow lasts.</p>
<h2>Lifetimes</h2><p>A lifetime is the span of code during which a reference is valid. Most of the time the compiler infers it.</p>
<p>Read <a href="https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html">the chapter in the book</a> for more.</p>
</article><footer>© Ada</footer></body></html>`;

/** Upstream answers, by host. Anything else gets an empty 404, as if the service had nothing. */
function upstream(url: URL): Response {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  if (url.hostname === 'hn.algolia.com') {
    return json({
      hits: [
        { objectID: '101', title: 'The Rust borrow checker, explained slowly', url: 'https://tiny.example/borrow-checker', author: 'ada', points: 219, num_comments: 83, created_at: '2019-03-12T10:00:00Z' },
        { objectID: '102', title: 'Why the borrow checker rejects my Rust graph', url: 'https://graphs.example/rust-borrow-checker-graphs', author: 'bob', points: 54, num_comments: 3, created_at: '2021-06-01T10:00:00Z' },
      ],
    });
  }
  if (url.hostname === 'api.stackexchange.com' && url.pathname.endsWith('/search/advanced') && url.searchParams.get('site') === 'stackoverflow') {
    return json({ items: [{ question_id: 1, title: 'How does the Rust borrow checker decide how long a borrow lasts?', link: 'https://stackoverflow.com/questions/1/rust-borrow-checker-borrow-length', score: 42, answer_count: 3, creation_date: 1_500_000_000, tags: ['rust', 'borrow-checker'] }] });
  }
  if (url.hostname === 'tiny.example') return new Response(ARTICLE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  return new Response('', { status: 404 });
}

interface Glogg {
  url: string;
  close: () => Promise<void>;
}

async function startGlogg(env: Record<string, string> = {}): Promise<Glogg> {
  const home = fs.mkdtempSync(path.join(inject('tmpRoot'), 'e2e-home-'));
  Object.assign(process.env, { GLOGG_HOME: home, NODE_ENV: 'production', GLOGG_CONTAINER_RUNTIME: 'none', ...env });
  vi.resetModules();
  const { createGloggServer } = await import('../../server/index.js');
  const server = http.createServer(await createGloggServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  for (const k of Object.keys(env)) delete process.env[k];
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!ready)('in a real browser', () => {
  let glogg: Glogg;
  let browser: Browser;
  const thirdParty: string[] = [];

  beforeAll(async () => {
    const local = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' ? local(input, init) : upstream(url);
    });
    glogg = await startGlogg();
    browser = await Browser.launch(inject('tmpRoot'));
    // Only this glogg may answer the browser; everything else is refused and noted.
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    browser.on('Fetch.requestPaused', (p) => {
      const url = String((p.request as { url: string }).url);
      if (url.startsWith(glogg.url) || url.startsWith('data:')) void browser.send('Fetch.continueRequest', { requestId: p.requestId });
      else {
        thirdParty.push(url);
        void browser.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
      }
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await glogg?.close();
    vi.unstubAllGlobals();
  });

  afterEach(async (ctx) => {
    if (ctx.task.result?.state === 'fail') await browser.screenshot(path.join(inject('tmpRoot'), '..', 'e2e-failures', `${ctx.task.name.replace(/\W+/g, '-')}.png`)).catch(() => undefined);
    browser.errors.length = 0;
  });

  const search = async (q: string) => {
    await browser.goto(`${glogg.url}/`);
    await browser.click('input[aria-label="Search"]');
    await browser.type(q);
    await browser.press('Enter');
    return browser.waitFor<number>(`document.querySelectorAll('a.result-title').length`, 'results to show');
  };

  it('opens on the search box, with no errors', async () => {
    await browser.goto(`${glogg.url}/`);
    expect(await browser.eval('document.title')).toBe('glogg');
    expect(await browser.waitFor('document.activeElement?.getAttribute("aria-label") === "Search"', 'the search box to have focus')).toBe(true);
    expect(browser.errors).toEqual([]);
  });

  it('searches, shows results that open in a new tab, and puts the query in the address', async () => {
    const count = await search(QUERY);
    expect(count).toBeGreaterThanOrEqual(2);
    const titles = await browser.eval<string[]>(`[...document.querySelectorAll('a.result-title')].map((a) => a.textContent.trim())`);
    expect(titles).toEqual(expect.arrayContaining(['The Rust borrow checker, explained slowly']));
    const links = await browser.eval<{ target: string; rel: string; href: string }[]>(`[...document.querySelectorAll('a.result-title')].map((a) => ({ target: a.target, rel: a.rel, href: a.href }))`);
    for (const l of links) {
      expect(l.target).toBe('_blank');
      expect(l.rel).toContain('noreferrer');
      expect(l.href).toMatch(/^https:\/\//);
    }
    expect(await browser.eval(`new URLSearchParams(location.search).get('q')`)).toBe(QUERY);
    expect(browser.errors).toEqual([]);
  });

  it('reloading a results address searches again', async () => {
    await browser.goto(`${glogg.url}/?q=${encodeURIComponent(QUERY)}`);
    expect(await browser.waitFor<number>(`document.querySelectorAll('a.result-title').length`, 'results after a reload')).toBeGreaterThanOrEqual(2);
    expect(await browser.eval('document.querySelector(\'input[aria-label="Search"]\').value')).toBe(QUERY);
  });

  it('opens a result in the reader, cleaned, and closes it with Escape', async () => {
    await search(QUERY);
    await browser.click('article.result:has(a.result-title[href^="https://tiny.example/"]) button[title^="Read clean"]');
    await browser.waitFor(`document.querySelector('[role="dialog"][aria-label="Reader"]')?.innerText.includes('makes sure every reference')`, 'the cleaned article in the reader');
    const reader = await browser.eval<string>(`document.querySelector('[role="dialog"][aria-label="Reader"]').innerText`);
    expect(reader).toContain('A lifetime is the span of code');
    expect(reader).not.toContain('Subscribe');
    await browser.press('Escape');
    await browser.waitFor(`!document.querySelector('[role="dialog"][aria-label="Reader"]')`, 'the reader to close');
  });

  it('⌘K finds a section, goes there, and Back comes home', async () => {
    await browser.goto(`${glogg.url}/`);
    await browser.press('k', 2);
    await browser.waitFor(`document.querySelector('[role="dialog"][aria-label="Command palette"] input') === document.activeElement`, 'the palette input to have focus');
    await browser.type('atlas');
    // The first row searches for what you typed; the section is next.
    await browser.waitFor(`document.querySelector('[role="dialog"][aria-label="Command palette"]').innerText.includes('Atlas: blogs')`, 'the Atlas command');
    await browser.press('ArrowDown');
    await browser.press('Enter');
    await browser.waitFor(`location.pathname === '/atlas'`, 'the Atlas address');
    expect(await browser.eval('document.title')).toBe('Atlas — glogg');
    await browser.eval('history.back()');
    await browser.waitFor(`location.pathname === '/' && !!document.querySelector('input[aria-label="Search"]')`, 'home after Back');
  });

  it('? lists the shortcuts and Escape closes them', async () => {
    await browser.goto(`${glogg.url}/`);
    // The page focuses the search box once it loads; shortcuts work from outside a text field.
    await browser.waitFor('document.activeElement?.getAttribute("aria-label") === "Search"', 'the search box to have focus');
    await browser.eval('document.activeElement.blur()');
    await browser.waitFor('document.activeElement === document.body', 'focus to leave the search box');
    await browser.press('?', 8);
    await browser.waitFor(`document.querySelector('.shortcuts[role="dialog"]')`, 'the shortcuts sheet');
    expect(await browser.eval(`document.querySelector('.shortcuts').innerText`)).toMatch(/Command palette/i);
    await browser.press('Escape');
    await browser.waitFor(`!document.querySelector('.shortcuts[role="dialog"]')`, 'the sheet to close');
  });

  it('keeps the dark theme you choose across a reload, browser colour bar included', async () => {
    await browser.colorScheme('light');
    await browser.goto(`${glogg.url}/`);
    await browser.click('button[aria-label="Toggle theme"]');
    await browser.waitFor(`document.documentElement.classList.contains('dark')`, 'the dark class');
    await browser.reload();
    await browser.waitFor(`document.documentElement.classList.contains('dark')`, 'dark after reload');
    expect(await browser.eval(`[...document.querySelectorAll('meta[name="theme-color"]')].every((m) => m.content === '#0f0f10')`)).toBe(true);
    await browser.click('button[aria-label="Toggle theme"]');
    await browser.waitFor(`!document.documentElement.classList.contains('dark')`, 'light again');
  });

  it('fits a phone: no sideways scrolling, and inputs big enough not to zoom', async () => {
    await browser.viewport(390, 844);
    try {
      for (const page of ['/', `/?q=${encodeURIComponent(QUERY)}`, '/settings', '/tools', '/atlas']) {
        await browser.goto(`${glogg.url}${page}`);
        await browser.waitFor('document.querySelector("main")', `${page} to render`);
        if (page.includes('?q=')) await browser.waitFor(`document.querySelectorAll('a.result-title').length`, 'results on a phone');
        const overflow = await browser.eval<number>('document.documentElement.scrollWidth - window.innerWidth');
        expect(overflow, `${page} scrolls sideways`).toBeLessThanOrEqual(0);
      }
      await browser.goto(`${glogg.url}/`);
      expect(await browser.eval<number>(`parseFloat(getComputedStyle(document.querySelector('input[aria-label="Search"]')).fontSize)`)).toBeGreaterThanOrEqual(16);
    } finally {
      await browser.send('Emulation.clearDeviceMetricsOverride');
    }
  });

  it('every control has a name, ids are unique, and the page has one main landmark', async () => {
    for (const page of ['/', `/?q=${encodeURIComponent(QUERY)}`, '/settings', '/tools', '/atlas', '/downloads', '/services']) {
      await browser.goto(`${glogg.url}${page}`);
      await browser.waitFor('document.querySelector("main")', `${page} to render`);
      if (page.includes('?q=')) await browser.waitFor(`document.querySelectorAll('a.result-title').length`, 'results');
      const report = await browser.eval<{ unnamed: string[]; dupes: string[]; mains: number; lang: string; noAlt: number }>(`(() => {
        const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.getAttribute('title') || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || '').trim();
        const visible = (el) => el.getClientRects().length > 0;
        const unnamed = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=switch], [role=tab]')]
          .filter((el) => visible(el) && !name(el)).map((el) => el.outerHTML.slice(0, 120));
        const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        return { unnamed, dupes, mains: document.querySelectorAll('main').length, lang: document.documentElement.lang, noAlt: document.querySelectorAll('img:not([alt])').length };
      })()`);
      expect(report.unnamed, `${page}: controls without a name`).toEqual([]);
      expect(report.dupes, `${page}: duplicate ids`).toEqual([]);
      expect(report.mains, `${page}: main landmarks`).toBe(1);
      expect(report.lang).toBe('en');
      expect(report.noAlt, `${page}: images without alt`).toBe(0);
      expect(browser.errors, `${page}: page errors`).toEqual([]);
    }
  });

  it('nothing but favicons is fetched from anywhere but this glogg', async () => {
    thirdParty.length = 0;
    await search(QUERY);
    await browser.goto(`${glogg.url}/atlas`);
    await browser.waitFor('document.querySelector("main")');
    const others = thirdParty.filter((u) => !u.startsWith('https://icons.duckduckgo.com/'));
    expect(others).toEqual([]);
  });
});

describe.skipIf(!ready)('in a real browser, with a password', () => {
  let glogg: Glogg;
  let browser: Browser;

  beforeAll(async () => {
    glogg = await startGlogg({ GLOGG_PASSWORD: 'correct horse battery staple' });
    browser = await Browser.launch(inject('tmpRoot'));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await glogg?.close();
  });

  it('asks for the password, refuses a wrong one, and stays signed in after a reload', async () => {
    await browser.goto(`${glogg.url}/`);
    await browser.click('input[aria-label="Password"]');
    await browser.type('wrong password');
    await browser.press('Enter');
    await browser.waitFor(`document.querySelector('.signin')?.innerText.includes('Wrong password')`, 'the wrong-password message');
    await browser.eval(`(() => { const i = document.querySelector('input[aria-label="Password"]'); i.select(); })()`);
    await browser.type('correct horse battery staple');
    await browser.press('Enter');
    await browser.waitFor(`!document.querySelector('.signin') && !!document.querySelector('input[aria-label="Search"]')`, 'the app after signing in');
    await browser.reload();
    await browser.waitFor(`!document.querySelector('.signin') && !!document.querySelector('input[aria-label="Search"]')`, 'still signed in after a reload');
    const cookie = await browser.send<{ cookies: { name: string; httpOnly: boolean; sameSite: string }[] }>('Network.getCookies', { urls: [glogg.url] });
    expect(cookie.cookies.find((c) => c.name === 'glogg_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  });
});
