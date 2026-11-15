import { afterEach, describe, expect, it, vi } from 'vitest';
import { rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';

useTempGloggHome();
const execute = vi.hoisted(() => vi.fn(async (query: string, config: unknown) => ({ query, config })));
vi.mock('../server/federatedSearch.js', () => ({ executeFederatedSearch: execute, compactResponse: (r: unknown) => r }));
process.env.GLOGG_CONTAINER_RUNTIME = 'none';
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.unstubAllEnvs(); execute.mockClear(); });

async function publicServer() {
  vi.stubEnv('GLOGG_MODE', 'public');
  vi.stubEnv('GLOGG_ALLOW_PRIVATE_FETCH', '');
  const server = await startGloggServer(); close = server.close;
  return server;
}

describe('public service authority', () => {
  it('advertises public capabilities and an actual source catalog', async () => {
    const { baseUrl } = await publicServer();
    const caps = await fetch(`${baseUrl}/api/capabilities`).then((r) => r.json());
    expect(caps).toEqual({ mode: 'public', features: { tools: false, research: false, downloads: false, administration: false, savedProfiles: false } });
    const catalog = await fetch(`${baseUrl}/api/sources`).then((r) => r.json());
    expect(catalog.sources.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['wiki', 'crossref', 'europepmc', 'openlibrary']));
  });

  it('denies privileged routes, all write methods, and route variants before parsing', async () => {
    const { port } = await publicServer();
    const routes = ['/api/profile', '/api/integrations', '/api/downloads', '/api/downloads/1', '/api/plugins', '/api/plugins/reload', '/api/plugins/ai/settings', '/api/plugins/ai/tools/chat', '/api/plugins/ai/container', '/api/containers', '/api/containers/action', '/api/nodes', '/api/research', '/api/deep/crawl', '/api/deep/sources', '/api/ipfs/test', '/api/unknown'];
    for (const path of routes) for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await rawRequest(port, { method, path, headers: { 'Content-Type': 'application/json', 'Content-Length': '8' }, body: '{invalid' });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    for (const path of ['/API/profile', '/api/profile/', '/api/%70rofile', '/api/plugins/ai%2ftools/chat']) {
      expect((await rawRequest(port, { path })).status, path).toBe(403);
    }
  });

  it('uses only operator-selected public endpoints and safe preferences', async () => {
    vi.stubEnv('SEARXNG_URL', 'https://search.example.org');
    vi.stubEnv('BRAVE_API_KEY', 'fixture-private-key');
    const { port } = await publicServer();
    const response = await rawRequest(port, { method: 'POST', path: '/api/search', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'a search', config: { lens: 'primary', blockedDomains: ['example.com'], endpoints: { searxngUrl: 'http://127.0.0.1:1', braveApiKey: 'visitor-key' }, unknownOption: 'drop me', disabledSources: [] } }) });
    expect(response.status).toBe(200);
    expect(execute.mock.calls[0][1]).toMatchObject({ lens: 'primary', blockedDomains: ['example.com'], endpoints: { searxngUrl: 'https://search.example.org' }, disabledSources: expect.arrayContaining(['p2p']) });
    expect(JSON.stringify(execute.mock.calls[0][1])).not.toMatch(/fixture-private-key|visitor-key|127\.0\.0\.1|unknownOption/);
  });

  it('refuses unsafe mode configuration instead of exposing the workbench', async () => {
    const { createGloggServer } = await import('../server/index.js');
    vi.stubEnv('GLOGG_MODE', 'pubic');
    await expect(createGloggServer()).rejects.toThrow(/GLOGG_MODE/);
    vi.stubEnv('GLOGG_MODE', 'public'); vi.stubEnv('GLOGG_ALLOW_PRIVATE_FETCH', '1');
    await expect(createGloggServer()).rejects.toThrow(/GLOGG_ALLOW_PRIVATE_FETCH/);
  });

  it('keeps private mode as the default and checks auth before malformed JSON', async () => {
    vi.stubEnv('GLOGG_MODE', ''); vi.stubEnv('GLOGG_PASSWORD', 'fixture-password');
    const server = await startGloggServer(); close = server.close;
    const { port } = server;
    expect((await rawRequest(port, { method: 'PUT', path: '/api/profile', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status).toBe(401);
  });
});
