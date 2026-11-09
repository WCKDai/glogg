import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutputBlock, ToolResult } from '../src/core/index.js';
import { fixtureServer, useTempGloggHome } from './helpers.js';
import type { Fixture } from './helpers.js';

useTempGloggHome();
const rt = await import('../server/plugins/runtime.js');
const { parseMagnet } = await import('../plugins/utils/index.js');
const { gradeSecurityHeaders, fingerprintTech } = await import('../plugins/webtest/index.js');
const { parseNewznabXml } = await import('../plugins/nzblife/index.js');
const { USERNAME_SITES } = await import('../plugins/osint/index.js');

beforeAll(() => rt.loadPlugins({ force: true }));

const block = <T extends OutputBlock['type']>(r: ToolResult, type: T) => r.blocks.find((b) => b.type === type) as Extract<OutputBlock, { type: T }>;
const kv = (r: ToolResult) => Object.fromEntries(block(r, 'kv').items.map((i) => [i.label, i.value]));
const checks = (r: ToolResult) => Object.fromEntries(block(r, 'checks').items.map((i) => [i.label, i.pass]));
const stat = (r: ToolResult) => Object.fromEntries(block(r, 'stat').items.map((i) => [i.label, i.value]));
const notices = (r: ToolResult) => r.blocks.filter((b) => b.type === 'notice');

describe('utilities plugin (runs locally)', () => {
  it('hashes with the standard test vectors', async () => {
    const r = await rt.runPluginTool('utils', 'hash', { text: 'abc' });
    expect(kv(r)).toMatchObject({
      MD5: '900150983cd24fb0d6963f7d28e17f72',
      SHA1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      SHA256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });

  it('encodes and decodes base64, URL and hex', async () => {
    const enc = kv(await rt.runPluginTool('utils', 'encode', { text: 'glögg & co', mode: 'auto' }));
    expect(enc.Base64).toBe(Buffer.from('glögg & co').toString('base64'));
    expect(enc.URL).toBe('gl%C3%B6gg%20%26%20co');
    const dec = kv(await rt.runPluginTool('utils', 'encode', { text: enc.Base64, mode: 'decode' }));
    expect(dec['Base64 →']).toBe('glögg & co');
  });

  it('decodes a JWT and flags expiry', async () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const expired = `${part({ alg: 'HS256' })}.${part({ sub: '42', exp: 1_000_000 })}.sig`;
    const r = await rt.runPluginTool('utils', 'jwt', { token: expired });
    expect(notices(r)[0]).toMatchObject({ tone: 'bad' });
    expect(r.blocks.some((b) => b.type === 'code' && b.content.includes('"sub": "42"'))).toBe(true);
    const bad = await rt.runPluginTool('utils', 'jwt', { token: 'not-a-token' });
    expect(notices(bad)[0]).toMatchObject({ content: 'Not a JWT.' });
  });

  it('converts unix seconds, milliseconds and dates', async () => {
    expect(kv(await rt.runPluginTool('utils', 'time', { value: '0' }))['ISO (UTC)']).toBe('1970-01-01T00:00:00.000Z');
    expect(kv(await rt.runPluginTool('utils', 'time', { value: '1700000000000' }))['Unix (s)']).toBe('1700000000');
    expect(notices(await rt.runPluginTool('utils', 'time', { value: 'not a date' }))[0]).toMatchObject({ content: 'Unrecognised date.' });
  });

  it('generates the requested number of v4 UUIDs, capped at 100', async () => {
    const ids = (await rt.runPluginTool('utils', 'uuid', { count: 3 })).blocks[0] as { content: string };
    expect(ids.content.split('\n')).toHaveLength(3);
    for (const id of ids.content.split('\n')) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const many = (await rt.runPluginTool('utils', 'uuid', { count: 5000 })).blocks[0] as { content: string };
    expect(many.content.split('\n')).toHaveLength(100);
  });

  it('inspects magnets, including base32 info hashes', () => {
    const hex = parseMagnet('magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A&dn=Debian&tr=udp%3A%2F%2Ftracker.example%3A80');
    expect(hex).toMatchObject({ hash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a', name: 'Debian', trackers: ['udp://tracker.example:80'] });
    const b32 = parseMagnet('magnet:?xt=urn:btih:YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK');
    expect(b32.hash).toBe('c12fe1c06bba254a9dc9f519b335aa7c1367a88a');
    expect(() => parseMagnet('https://example.com')).toThrow(/Not a magnet/);
  });

  it('offers to send a magnet and to check debrid caches', async () => {
    const r = await rt.runPluginTool('utils', 'magnet', { uri: 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Debian' });
    const actions = block(r, 'actions').items;
    expect(actions[0].send?.url).toContain('magnet:?xt=');
    expect(actions.some((a) => a.run?.tool === 'torbox/cached')).toBe(true);
  });
});

describe('OSINT plugin (offline parts)', () => {
  it('builds search dorks for a domain from any input form', async () => {
    const r = await rt.runPluginTool('osint', 'dorks', { domain: 'https://www.example.com/path' });
    const items = block(r, 'list').items;
    expect(items.length).toBeGreaterThanOrEqual(8);
    expect(items[0].subtitle).toContain('site:www.example.com');
    expect(items.every((i) => i.href?.startsWith('https://www.google.com/search?q='))).toBe(true);
  });

  it('ships a username site list with unique names and https profile links', () => {
    const names = USERNAME_SITES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of USERNAME_SITES) expect(s.profile('someone')).toMatch(/^https:\/\/.*someone/);
  });
});

describe('Usenet plugin (offline parts)', () => {
  it('parses Newznab results and reports indexer errors', () => {
    const xml = `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>
      <item><title>Debian.12.iso</title><guid>abc</guid><link>https://idx.example/get/abc</link><pubDate>Sat, 01 Jun 2024 10:00:00 +0000</pubDate>
        <enclosure url="https://idx.example/get/abc.nzb" length="123" type="application/x-nzb"/>
        <newznab:attr name="size" value="3900000000"/><newznab:attr name="grabs" value="17"/></item>
      <item><title></title><link>https://idx.example/get/empty</link></item>
    </channel></rss>`;
    expect(parseNewznabXml(xml)).toEqual([
      expect.objectContaining({ title: 'Debian.12.iso', link: 'https://idx.example/get/abc.nzb', size: 3_900_000_000, grabs: 17 }),
    ]);
    expect(() => parseNewznabXml('<error code="100" description="Incorrect user credentials"/>')).toThrow(/Incorrect user credentials/);
  });
});

describe('website testing plugin', () => {
  it('grades strong security headers A and missing ones F', () => {
    const strong = gradeSecurityHeaders({
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=()',
      'cross-origin-opener-policy': 'same-origin',
      server: 'nginx',
    });
    expect(strong.grade).toBe('A');
    const none = gradeSecurityHeaders({}, false);
    expect(none.grade).toBe('F');
    const inline = gradeSecurityHeaders({ 'content-security-policy': "script-src 'unsafe-inline'" });
    expect(inline.checks.find((c) => c.label === 'Content-Security-Policy')?.pass).toBeNull();
    expect(gradeSecurityHeaders({ server: 'Apache/2.4.1' }).checks.find((c) => c.label === 'No version disclosure')?.pass).toBe(false);
  });

  it('fingerprints the stack and trackers from HTML and headers', () => {
    const tech = fingerprintTech(
      '<meta name="generator" content="Hugo 0.120"><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script><link href="/wp-content/x.css">',
      { server: 'nginx/1.25', 'cf-ray': 'abc' }
    );
    expect(tech[0]).toBe('Hugo 0.120');
    expect(tech).toEqual(expect.arrayContaining(['Cloudflare', 'nginx', 'WordPress', 'Google Analytics']));
  });

  describe('against a local site', () => {
    let site: Fixture;
    beforeAll(async () => {
      site = await fixtureServer({
        '/': {
          headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Powered-By': 'Express' },
          body: `<!doctype html><html lang="en"><head><title>glogg fixture page for tests</title>
            <meta name="description" content="A small local page used by the glogg test-suite to exercise the website tools offline.">
            <meta name="viewport" content="width=device-width"><link rel="canonical" href="/">
            <meta property="og:title" content="Fixture"><meta property="og:image" content="/og.png"></head>
            <body><h1>Fixture</h1><img src="/a.png" alt="a"><img src="/b.png">
            <a href="/ok">ok</a> <a href="/missing">missing</a></body></html>`,
        },
        '/old': { status: 301, headers: { Location: '/' } },
        '/ok': { body: 'fine' },
        '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nSitemap: /sitemap.xml' },
      });
    });
    afterAll(() => site.close());

    it('checks headers and follows the redirect chain', async () => {
      const r = await rt.runPluginTool('webtest', 'headers', { url: `${site.baseUrl}/old` });
      expect(stat(r)).toMatchObject({ Status: '200', Redirects: '1' });
      expect(checks(r)).toMatchObject({ HTTPS: false, 'X-Content-Type-Options': true, 'Content-Security-Policy': false });
    });

    it('audits SEO basics', async () => {
      const c = checks(await rt.runPluginTool('webtest', 'seo', { url: site.baseUrl }));
      expect(c).toMatchObject({
        Title: true,
        'Meta description': true,
        'Single H1': true,
        Canonical: true,
        'lang attribute': true,
        Viewport: true,
        'Open Graph': true,
        'Image alt text': false,
        'robots.txt': true,
        'sitemap.xml': true,
      });
    });

    it('finds broken links', async () => {
      const r = await rt.runPluginTool('webtest', 'links', { url: site.baseUrl });
      expect(stat(r)).toMatchObject({ Broken: '1' });
      expect(block(r, 'table').rows).toEqual([[404, `${site.baseUrl}/missing`]]);
    });

    it('detects the server stack', async () => {
      const list = block(await rt.runPluginTool('webtest', 'tech', { url: site.baseUrl }), 'list');
      expect(list.items.map((i) => i.title)).toContain('Express');
    });
  });
});
