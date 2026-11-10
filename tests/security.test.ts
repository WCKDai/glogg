import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowedHost, isAllowedOrigin, isPublicPath, rejectReason } from '../server/security.js';
import { rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';

describe('request guard: decisions', () => {
  it.each([
    ['localhost:4173', true],
    ['127.0.0.1:4173', true],
    ['[::1]:4173', true],
    ['192.168.1.20:4173', true],
    ['glogg.localhost', true],
    ['my-mac.local:4173', true],
    ['evil.example:4173', false],
    ['localhost.evil.example', false],
  ])('host %s allowed: %s', (host, ok) => {
    expect(isAllowedHost(host, {})).toBe(ok);
  });

  it('allows extra hosts, or every host, from the environment', () => {
    expect(isAllowedHost('glogg.example.com', { GLOGG_ALLOWED_HOSTS: 'glogg.example.com' })).toBe(true);
    expect(isAllowedHost('glogg.example.com:8443', { GLOGG_ALLOWED_HOSTS: 'glogg.example.com' })).toBe(true);
    expect(isAllowedHost('anything.example', { GLOGG_ALLOWED_HOSTS: '*' })).toBe(true);
    expect(isAllowedHost('other.example', { GLOGG_ALLOWED_HOSTS: 'glogg.example.com' })).toBe(false);
  });

  it("takes URLs too, as Coolify's SERVICE_FQDN_* gives them, without loosening the match", () => {
    const env = { GLOGG_ALLOWED_HOSTS: 'https://glogg.example.com,https://alt.example.org/' };
    expect(isAllowedHost('glogg.example.com', env)).toBe(true);
    expect(isAllowedHost('alt.example.org', env)).toBe(true);
    expect(isAllowedHost('example.com', env)).toBe(false);
    expect(isAllowedHost('glogg.example.com.evil.example', env)).toBe(false);
  });

  it.each([
    [undefined, true],
    ['http://localhost:4173', true],
    // Any installed extension could otherwise use your keys; list your own in GLOGG_ALLOWED_ORIGINS.
    ['chrome-extension://abcdefghijklmnop', false],
    ['moz-extension://1234-5678', false],
    ['http://localhost:9999', false],
    ['https://evil.example', false],
    ['null', false],
    ['not a url', false],
  ])('origin %s allowed: %s', (origin, ok) => {
    expect(isAllowedOrigin(origin, 'localhost:4173', {})).toBe(ok);
  });

  it('allows extra origins from the environment, extensions included', () => {
    expect(isAllowedOrigin('https://glogg.example.com', 'localhost:4173', { GLOGG_ALLOWED_ORIGINS: 'https://glogg.example.com' })).toBe(true);
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnop', 'localhost:4173', { GLOGG_ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnop' })).toBe(true);
    expect(isAllowedOrigin('chrome-extension://otherextension', 'localhost:4173', { GLOGG_ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnop' })).toBe(false);
  });

  it('refuses cross-site requests that carry no Origin', () => {
    expect(rejectReason({ headers: { host: 'localhost:4173', 'sec-fetch-site': 'cross-site' } }, {})).toMatch(/Cross-site/);
    expect(rejectReason({ headers: { host: 'localhost:4173', 'sec-fetch-site': 'same-origin' } }, {})).toBeNull();
  });

  it('explains how to allow a blocked host', () => {
    expect(rejectReason({ headers: { host: 'glogg.example.com' } }, {})).toContain('GLOGG_ALLOWED_HOSTS=glogg.example.com');
  });

  it('keeps OpenSearch, suggestions, the Atlas and health public', () => {
    for (const p of ['/api/health', '/api/search', '/api/opensearch/suggest', '/api/directory', '/api/ipfs/bafy', '/opensearch.xml']) {
      expect(isPublicPath(p)).toBe(true);
    }
    for (const p of ['/api/plugins', '/api/plugins/utils/tools/hash', '/api/research', '/api/integrations', '/api/downloads', '/api/containers/action', '/api/inspect']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});

describe('request guard: enforced by the server', () => {
  let port = 0;
  let close: () => Promise<void>;
  const json = { 'Content-Type': 'application/json' };

  beforeAll(async () => {
    useTempGloggHome();
    ({ port, close } = await startGloggServer());
  });
  afterAll(() => close());

  it('serves public routes to any site', async () => {
    const r = await rawRequest(port, { path: '/api/health', headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('refuses a private route called from another site, without CORS headers', async () => {
    const r = await rawRequest(port, {
      method: 'POST',
      path: '/api/plugins/utils/tools/hash',
      headers: { ...json, Origin: 'https://evil.example' },
      body: JSON.stringify({ input: { text: 'x' } }),
    });
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses the preflight from another site', async () => {
    const r = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/api/integrations',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' },
    });
    expect(r.status).toBe(403);
  });

  it('refuses a DNS-rebinding host even with a matching origin', async () => {
    const r = await rawRequest(port, {
      path: '/api/plugins',
      headers: { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` },
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toContain('GLOGG_ALLOWED_HOSTS');
  });

  it('routes only exact lower-case API paths, so "/API/…" can\'t slip past the guard', async () => {
    for (const p of ['/API/plugins', '/Api/plugins', '/api/PLUGINS', '/API/integrations']) {
      const r = await rawRequest(port, { path: p, headers: { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` } });
      expect(r.body).not.toMatch(/"plugins"|"config"/);
    }
  });

  it('serves glogg itself and the CLI, and an extension only when you list it', async () => {
    const same = await rawRequest(port, { path: '/api/plugins', headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(same.status).toBe(200);
    const cli = await rawRequest(port, { path: '/api/plugins' });
    expect(cli.status).toBe(200);
    const stranger = await rawRequest(port, { path: '/api/plugins', headers: { Origin: 'chrome-extension://abcdefghijklmnop' } });
    expect(stranger.status).toBe(403);
    process.env.GLOGG_ALLOWED_ORIGINS = 'chrome-extension://abcdefghijklmnop';
    try {
      const listed = await rawRequest(port, { path: '/api/plugins', headers: { Origin: 'chrome-extension://abcdefghijklmnop' } });
      expect(listed.status).toBe(200);
      expect(listed.headers['access-control-allow-origin']).toBe('chrome-extension://abcdefghijklmnop');
    } finally {
      delete process.env.GLOGG_ALLOWED_ORIGINS;
    }
  });

  it('never returns stored secrets to the browser', async () => {
    const put = await rawRequest(port, {
      method: 'PUT',
      path: '/api/plugins/realdebrid/settings',
      headers: json,
      body: JSON.stringify({ values: { apiToken: 'SECRET-TOKEN-1234567890' } }),
    });
    expect(put.status).toBe(200);
    expect(put.body).not.toContain('SECRET-TOKEN');
    const list = await rawRequest(port, { path: '/api/plugins' });
    expect(list.body).not.toContain('SECRET-TOKEN');
    expect(list.body).toContain('••••7890');
  });
});
