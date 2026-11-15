/**
 * The HTTP API, route by route (docs/api.md): what each answers, what it
 * refuses, and who may call it, on an open glogg, a password-protected one and
 * from another site. Upstreams are local fixtures; anything else fails at once
 * (setup.ts), and container management is off.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURATED_INDIE_INDEX } from '../src/core/index.js';
import type {
  ContainerStackReport,
  DownloadJob,
  DownloadManagerReport,
  IndieSiteEntry,
  PageAutopsyReport,
  PluginInfo,
  RankedSearchResponse,
  ResearchEvent,
  ToolResult,
} from '../src/core/index.js';
import { anyString, BASE_SEED, html, int, list, pick, rng, RUNS, text, urlish } from './fuzz.js';
import type { Rng } from './fuzz.js';
import { fixtureServer, rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';
import type { Fixture } from './helpers.js';

type Reply = Awaited<ReturnType<typeof rawRequest>>;

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** A local server for upstreams that need more than a route table: request bodies, streams, hangs. */
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** An upstream that takes requests and never answers, counting the ones that arrive and the ones dropped. */
async function hangingUpstream() {
  const counts = { opened: 0, closed: 0 };
  const server = await serve((_req, res) => {
    counts.opened += 1;
    res.on('close', () => (counts.closed += 1));
  });
  return Object.assign(counts, server);
}

const bodyOf = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (b += c));
    req.on('end', () => resolve(b));
  });

function caller(port: () => number) {
  return (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
    rawRequest(port(), {
      method,
      path: p,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const data = <T = any>(r: Reply): T => JSON.parse(r.body) as T;

/** NDJSON: every event on its own line, the last one newline-terminated too. */
function events(r: Reply): ResearchEvent[] {
  expect(r.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
  expect(r.body.endsWith('\n')).toBe(true);
  return r.body
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as ResearchEvent);
}

/** Express's default error handler logs what it answers; keep the test output clean. */
const quietly = () => vi.spyOn(console, 'error').mockImplementation(() => {});

// Env the server reads when its modules load, or on every request: set before importing it.
const FILE_ENV = ['GLOGG_HOME', 'NODE_ENV', 'GLOGG_DOWNLOADS_DIR', 'GLOGG_CONTAINER_RUNTIME', 'SEARXNG_URL', 'BITMAGNET_URL', 'IPFS_GATEWAY_URL', 'NEWZNAB_URL', 'TORZNAB_URL'];
const envBefore = Object.fromEntries(FILE_ENV.map((k) => [k, process.env[k]]));
const home = useTempGloggHome();
const unreachable = `http://127.0.0.1:${await closedPort()}`;
Object.assign(process.env, {
  NODE_ENV: 'production',
  GLOGG_DOWNLOADS_DIR: path.join(home, 'downloads'),
  GLOGG_CONTAINER_RUNTIME: 'none',
  SEARXNG_URL: unreachable,
  BITMAGNET_URL: unreachable,
  IPFS_GATEWAY_URL: unreachable,
  NEWZNAB_URL: unreachable,
  TORZNAB_URL: unreachable,
});
const { createGloggServer } = await import('../server/index.js');
const deep = await import('../server/deep/index.js');
const search = await import('../server/federatedSearch.js');

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const BUILTIN_IDS = ['ai', 'nextcloud', 'nzblife', 'offcloud', 'osint', 'pcloud', 'realdebrid', 'sabnzbd', 'torbox', 'utils', 'webtest'];

interface RouteCase {
  method: string;
  /** As registered, e.g. /api/plugins/:id/settings */
  route: string;
  /** What to request, when it differs from the route */
  path?: string;
  body?: unknown;
  /** Answers any site (security.ts) */
  public?: boolean;
}

/** Every route the server registers, with a harmless request for each. */
const ROUTES: RouteCase[] = [
  { method: 'GET', route: '/api/health', public: true },
  { method: 'GET', route: '/api/telemetry' },
  { method: 'GET', route: '/api/capabilities', public: true },
  { method: 'GET', route: '/api/sources', public: true },
  { method: 'GET', route: '/api/auth' },
  { method: 'POST', route: '/api/auth/login', body: { password: 'not it' } },
  { method: 'POST', route: '/api/auth/logout' },
  { method: 'GET', route: '/api/containers' },
  { method: 'POST', route: '/api/containers/action', body: { action: 'logs', serviceId: 'searxng' } },
  { method: 'GET', route: '/api/nodes' },
  { method: 'GET', route: '/api/directory', public: true },
  { method: 'GET', route: '/api/downloads' },
  { method: 'POST', route: '/api/downloads', body: { url: 'https://example.com/a.iso' } },
  { method: 'DELETE', route: '/api/downloads/:id', path: '/api/downloads/finished' },
  { method: 'GET', route: '/api/integrations' },
  { method: 'PUT', route: '/api/integrations', body: { config: {} } },
  // Only GET is public: a POST can name indexers, and would get your stored keys sent to them.
  { method: 'POST', route: '/api/search', body: { query: 'route table' } },
  { method: 'GET', route: '/api/search', path: '/api/search?q=route+table', public: true },
  { method: 'POST', route: '/api/research', body: { query: 'route table', candidates: [] } },
  { method: 'GET', route: '/api/deep' },
  { method: 'POST', route: '/api/deep/crawl', body: { action: 'pause' } },
  { method: 'GET', route: '/api/deep/sites' },
  { method: 'POST', route: '/api/deep/sources', body: { url: 'https://example.com/feed.xml' } },
  { method: 'DELETE', route: '/api/deep/sources/:id', path: '/api/deep/sources/999999' },
  { method: 'GET', route: '/api/deep/opml' },
  { method: 'POST', route: '/api/deep/opml', body: { xml: '<opml version="2.0"><body/></opml>' } },
  { method: 'GET', route: '/api/deep/random' },
  { method: 'GET', route: '/api/plugins' },
  { method: 'POST', route: '/api/plugins/reload' },
  { method: 'PUT', route: '/api/plugins/:id/settings', path: '/api/plugins/utils/settings', body: { values: {} } },
  { method: 'POST', route: '/api/plugins/:id/tools/:tool', path: '/api/plugins/utils/tools/uuid', body: { input: {} } },
  { method: 'GET', route: '/api/plugins/:id/container', path: '/api/plugins/utils/container' },
  { method: 'POST', route: '/api/plugins/:id/container', path: '/api/plugins/utils/container', body: { action: 'up' } },
  { method: 'GET', route: '/opensearch.xml', public: true },
  { method: 'GET', route: '/api/favicon/:domain', path: '/api/favicon/example.com' },
  { method: 'GET', route: '/api/media/image' },
  { method: 'GET', route: '/api/profile' },
  { method: 'PUT', route: '/api/profile', body: { settings: { 'glogg.pinned': ['route.example'] } } },
  { method: 'GET', route: '/api/opensearch/suggest', path: '/api/opensearch/suggest?q=wiki', public: true },
  { method: 'GET', route: '/api/ipfs/:cid', path: `/api/ipfs/${CID}`, public: true },
  { method: 'POST', route: '/api/inspect', body: { url: 'https://example.com/', rawHtml: '<p>x</p>' } },
];
const target = (r: RouteCase) => r.path ?? r.route;

let open: Awaited<ReturnType<typeof startGloggServer>>;
const api = caller(() => open.port);

beforeAll(async () => {
  open = await startGloggServer();
  // Nothing may probe a real aria2 on this machine.
  await api('PUT', '/api/integrations', { config: { aria2RpcUrl: `${unreachable}/jsonrpc` } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await open.close();
  deep.resetDeepIndex();
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the route table', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const served = async () => {
    const app = (await createGloggServer()) as unknown as { router: { stack: Layer[] } };
    return app.router.stack
      .flatMap((l) => (l.route && l.route.path !== '/{*splat}' ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`) : []))
      .sort();
  };

  it('documents every route glogg serves, with its methods', async () => {
    const doc = fs.readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8');
    const documented = [...doc.matchAll(/^\| `([^`]+)` \| ([^|]+) \|/gm)]
      .flatMap((m) => [...m[2].matchAll(/`([A-Z]+)`/g)].map((x) => `${x[1]} ${m[1]}`))
      .sort();
    expect(await served()).toEqual(documented);
  });

  it('is the table these tests walk through', async () => {
    expect(await served()).toEqual(ROUTES.map((r) => `${r.method} ${r.route}`).sort());
  });
});

describe('GET /api/health', () => {
  it('reports the engine as up, with the package version, to any site', async () => {
    const r = await api('GET', '/api/health', undefined, { Origin: 'https://evil.example' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(data(r)).toEqual({ status: 'ok', service: 'glogg-engine', version: PKG.version, connectors: 26 });
  });
});

describe('the services stack, with container management off', () => {
  it('lists the seven managed services, and no runtime', async () => {
    const r = await api('GET', '/api/containers');
    expect(r.status).toBe(200);
    const stack = data<ContainerStackReport>(r);
    expect(stack).toMatchObject({ runtimes: { docker: false, podman: false, colima: false }, activeRuntime: 'none', daemonRunning: false });
    expect(stack.composeFilePath).toMatch(/infra\/docker-compose\.services\.yml$/);
    expect(stack.services.map((s) => s.id)).toEqual(['searxng', 'bitmagnet', 'ipfs-kubo', 'aria2-rpc', 'nextcloud', 'prowlarr', 'nzbhydra2']);
    for (const s of stack.services) {
      expect(s.containerName).toMatch(/^glogg-/);
      expect(s.state).toBe(s.reachable ? 'running' : 'not-created');
      expect(s.statusText).toBe(s.reachable ? 'Online (Host/Port Active)' : 'Daemon offline');
    }
  });

  it('requires an action', async () => {
    const r = await api('POST', '/api/containers/action', {});
    expect(r.status).toBe(400);
    expect(data(r)).toEqual({ error: 'Action is required' });
  });

  it.each(['up', 'stop', 'restart', 'logs', 'stack-up', 'stack-down', 'start-daemon'])('refuses %s, and still answers the stack', async (action) => {
    const r = await api('POST', '/api/containers/action', { action, serviceId: 'searxng' });
    expect(r.status).toBe(200);
    expect(data(r)).toMatchObject({
      ok: false,
      command: '',
      output: 'Container management is off here (GLOGG_CONTAINER_RUNTIME=none).',
      stack: { activeRuntime: 'none', daemonRunning: false, services: expect.any(Array) },
    });
  });
});

describe('GET /api/nodes', () => {
  it('answers at once when nothing listens', async () => {
    const t = Date.now();
    const r = await api('GET', '/api/nodes');
    // Each probe gives up after a second; a refused connection must not wait for that.
    expect(Date.now() - t).toBeLessThan(900);
    expect(r.status).toBe(200);
    const { localDockerStack, activeUpstreamConnectors } = data(r);
    expect(Object.keys(localDockerStack)).toEqual(['searxng', 'bitmagnet', 'ipfs', 'nzbhydra2', 'prowlarr', 'torProxy']);
    // Each reports the address it probed: the configured one, or the local default.
    const probed: Record<string, string> = {
      searxng: process.env.SEARXNG_URL || 'http://localhost:8080',
      bitmagnet: process.env.BITMAGNET_URL || 'http://localhost:3333',
      ipfs: process.env.IPFS_GATEWAY_URL || 'http://localhost:8081',
      nzbhydra2: process.env.NEWZNAB_URL || 'http://localhost:5076',
      prowlarr: process.env.TORZNAB_URL || 'http://localhost:9696',
    };
    for (const [id, url] of Object.entries(probed)) expect(localDockerStack[id]).toEqual({ url, online: false });
    expect(localDockerStack.torProxy).toEqual({ url: 'http://localhost:8118', online: expect.any(Boolean) });
    expect(activeUpstreamConnectors).toHaveLength(18);
    for (const c of activeUpstreamConnectors) expect(c).toEqual({ id: expect.any(String), name: expect.any(String), protocol: expect.any(String), status: 'active' });
  });

  it('counts a service as online when it answers below 500', async () => {
    const node = await fixtureServer({ '/': { body: 'ok' }, '/down': { status: 503 } });
    vi.stubEnv('SEARXNG_URL', node.baseUrl);
    vi.stubEnv('BITMAGNET_URL', `${node.baseUrl}/down`);
    vi.stubEnv('TORZNAB_URL', `${node.baseUrl}/missing`);
    try {
      const { localDockerStack } = data(await api('GET', '/api/nodes'));
      expect(localDockerStack.searxng.online).toBe(true);
      expect(localDockerStack.bitmagnet.online).toBe(false);
      expect(localDockerStack.prowlarr.online).toBe(true);
      expect([...node.hits].sort()).toEqual(['GET /', 'GET /down', 'GET /missing']);
    } finally {
      await node.close();
    }
  });
});

describe('GET /api/directory', () => {
  const urls = (items: IndieSiteEntry[]) => items.map((i) => i.url);
  const items = async (qs: string) => data<{ items: IndieSiteEntry[] }>(await api('GET', `/api/directory${qs}`)).items;

  it('lists the whole curated Atlas in order, to any site', async () => {
    const r = await api('GET', '/api/directory', undefined, { Origin: 'https://evil.example' });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(data(r)).toEqual({ items: CURATED_INDIE_INDEX });
    expect(await items('?category=all')).toEqual(CURATED_INDIE_INDEX);
  });

  it.each([...new Set(CURATED_INDIE_INDEX.map((i) => i.category))])('filters to the %s category', async (category) => {
    expect(await items(`?category=${category}`)).toEqual(CURATED_INDIE_INDEX.filter((i) => i.category === category));
  });

  it('answers an unknown category with no sites', async () => {
    expect(await items('?category=no-such-category')).toEqual([]);
  });

  it('shuffles on request, keeping the same sites', async () => {
    vi.spyOn(Math, 'random').mockImplementation(rng(BASE_SEED));
    const shuffled = urls(await items('?shuffle=true'));
    expect(shuffled).not.toEqual(urls(CURATED_INDIE_INDEX));
    expect([...shuffled].sort()).toEqual(urls(CURATED_INDIE_INDEX).sort());
    const p2p = urls(await items('?category=p2p-dht-usenet&shuffle=true'));
    expect(p2p.sort()).toEqual(urls(CURATED_INDIE_INDEX.filter((i) => i.category === 'p2p-dht-usenet')).sort());
  });

  it('keeps the order unless shuffle is exactly true', async () => {
    vi.spyOn(Math, 'random').mockImplementation(rng(BASE_SEED));
    for (const v of ['1', 'yes', 'TRUE', '']) expect(urls(await items(`?shuffle=${v}`)), v).toEqual(urls(CURATED_INDIE_INDEX));
  });
});

describe('downloads', () => {
  const vault = path.join(home, 'downloads');
  const rpc: { method: string; params: unknown[] }[] = [];
  let aria2: Awaited<ReturnType<typeof serve>>;
  let files: Fixture;

  beforeAll(async () => {
    aria2 = await serve(async (req, res) => {
      const { id, method, params } = JSON.parse(await bodyOf(req)) as { id: string; method: string; params: unknown[] };
      rpc.push({ method, params });
      const result =
        method === 'aria2.addUri'
          ? 'gid-0001'
          : method === 'aria2.tellStatus'
            ? { status: 'active', totalLength: '1000', completedLength: '250', downloadSpeed: '51200' }
            : { version: '1.37.0' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
    files = await fixtureServer({ '/files/manual.pdf': { headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-1.4 glogg' } });
    await api('PUT', '/api/integrations', { config: { aria2RpcUrl: `${aria2.baseUrl}/jsonrpc`, aria2RpcSecret: 'aria2-secret-7781' } });
  });

  afterAll(async () => {
    await api('PUT', '/api/integrations', { config: { aria2RpcUrl: `${unreachable}/jsonrpc`, aria2RpcSecret: '' } });
    await aria2.close();
    await files.close();
  });

  const enqueue = async (body: unknown) => {
    const r = await api('POST', '/api/downloads', body);
    expect(r.status).toBe(200);
    return data<{ job: DownloadJob }>(r).job;
  };
  const ids = (r: Reply) => data<{ jobs: DownloadJob[] }>(r).jobs.map((j) => j.id);

  it('sends a file to aria2 when it is up, and reports its live progress', async () => {
    const url = `${files.baseUrl}/files/debian.iso`;
    const job = await enqueue({ url, title: '  Debian ISO  ', sizeFormatted: '3.7 GB' });
    expect(job).toMatchObject({
      title: 'Debian ISO',
      sourceUrl: url,
      kind: 'direct-file',
      target: 'aria2-rpc',
      status: 'downloading',
      remoteId: 'gid-0001',
      progressPercent: 0,
      sizeFormatted: '3.7 GB',
      statusDetail: 'Sent to aria2',
    });
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(job.createdAt))).toBe(false);
    expect(rpc.find((c) => c.method === 'aria2.addUri')?.params).toEqual(['token:aria2-secret-7781', [url], {}]);

    const r = await api('GET', '/api/downloads');
    expect(r.status).toBe(200);
    const report = data<DownloadManagerReport>(r);
    expect(report.jobs.find((j) => j.id === job.id)).toMatchObject({ status: 'downloading', progressPercent: 25, statusDetail: 'active · 50 KB/s' });
    expect(report.integrations).toEqual({ offcloudConfigured: false, nzbLifeConfigured: false, nextcloudConfigured: false, aria2Reachable: true, localDownloadsDir: vault });
    expect(report.config.aria2RpcSecret).toBe('••••7781');
    expect(r.body).not.toContain('aria2-secret');
    expect(report.pluginTargets?.map((t) => t.id)).toEqual(expect.arrayContaining(['plugin:realdebrid', 'plugin:sabnzbd', 'plugin:torbox']));
  });

  it('saves a file to the local vault', async () => {
    const job = await enqueue({ url: `${files.baseUrl}/files/manual.pdf`, target: 'local-vault' });
    expect(job).toMatchObject({
      kind: 'direct-file',
      target: 'local-vault',
      status: 'completed',
      progressPercent: 100,
      statusDetail: 'Saved locally',
      destinationUrl: path.join(vault, 'manual.pdf'),
    });
    expect(fs.readFileSync(path.join(vault, 'manual.pdf'), 'utf8')).toBe('%PDF-1.4 glogg');
  });

  it('keeps a job that could not start, saying why', async () => {
    const job = await enqueue({ url: 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=glogg', target: 'offcloud' });
    expect(job).toMatchObject({ kind: 'magnet', target: 'offcloud', status: 'failed', statusDetail: 'Offcloud API key not configured' });
  });

  it('refuses a missing URL, and anything but http(s) and magnet links', async () => {
    for (const body of [{}, { url: '' }, { url: 42 }]) {
      const r = await api('POST', '/api/downloads', body);
      expect(r.status).toBe(400);
      expect(data(r)).toEqual({ error: 'url is required' });
    }
    for (const url of ['ftp://example.com/a.iso', 'file:///etc/passwd', 'javascript:alert(1)', 'example.com/a.iso']) {
      const r = await api('POST', '/api/downloads', { url });
      expect(r.status, url).toBe(400);
      expect(data(r)).toEqual({ error: 'Only http(s) and magnet: URLs are supported' });
    }
  });

  it('removes one job, or every finished one', async () => {
    const active = await enqueue({ url: `${files.baseUrl}/files/arch.iso` });
    const done = await enqueue({ url: `${files.baseUrl}/files/manual.pdf`, target: 'local-vault' });
    const failed = await enqueue({ url: `${files.baseUrl}/files/x.torrent`, target: 'offcloud' });

    const cleared = await api('DELETE', '/api/downloads/finished');
    expect(cleared.status).toBe(200);
    expect(ids(cleared)).toContain(active.id);
    expect(ids(cleared)).not.toContain(done.id);
    expect(ids(cleared)).not.toContain(failed.id);
    expect(data<DownloadManagerReport>(await api('GET', '/api/downloads')).jobs.map((j) => j.id)).toEqual(ids(cleared));

    const unknown = await api('DELETE', '/api/downloads/no-such-job');
    expect(unknown.status).toBe(200);
    expect(ids(unknown)).toEqual(ids(cleared));

    const removed = await api('DELETE', `/api/downloads/${active.id}`);
    expect(removed.status).toBe(200);
    expect(ids(removed)).toEqual(ids(cleared).filter((id) => id !== active.id));
  });
});

describe('integration settings', () => {
  const file = path.join(home, 'integrations.json');
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;

  afterAll(async () => {
    await api('PUT', '/api/integrations', { config: { newznabUrl: '', newznabApiKey: '', torznabApiKey: '' } });
  });

  it('masks secrets to their last four characters, in every answer', async () => {
    const put = await api('PUT', '/api/integrations', {
      config: { newznabUrl: `${unreachable}/api`, newznabApiKey: 'NEWZNAB-KEY-8841', torznabApiKey: 'TORZNAB-KEY-1290' },
    });
    expect(put.status).toBe(200);
    expect(data(put).config).toMatchObject({ newznabUrl: `${unreachable}/api`, newznabApiKey: '••••8841', torznabApiKey: '••••1290' });
    const get = await api('GET', '/api/integrations');
    expect(get.status).toBe(200);
    expect(data(get)).toEqual(data(put));
    for (const r of [put, get]) expect(r.body).not.toMatch(/NEWZNAB-KEY|TORZNAB-KEY/);
  });

  it('keeps a stored secret when its mask comes back, trims values, and clears empty ones', async () => {
    await api('PUT', '/api/integrations', { config: { newznabApiKey: '••••8841', newznabUrl: `  ${unreachable}/v2  `, torznabApiKey: '' } });
    expect(stored()).toMatchObject({ newznabApiKey: 'NEWZNAB-KEY-8841', newznabUrl: `${unreachable}/v2` });
    expect(stored()).not.toHaveProperty('torznabApiKey');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('leaves settings alone for values that are not strings, or no config at all', async () => {
    const before = stored();
    for (const body of [{ config: { newznabUrl: 42, newznabApiKey: null, nzbLifeUrl: ['x'] } }, { config: {} }, {}]) {
      expect((await api('PUT', '/api/integrations', body)).status).toBe(200);
    }
    expect(stored()).toEqual(before);
  });
});

describe('search', () => {
  const asked: { from: string; params: URLSearchParams }[] = [];
  let searx: Fixture;
  let saved: Fixture;
  const searxng = (from: string) => (req: http.IncomingMessage) => {
    const params = new URL(req.url || '/', 'http://x').searchParams;
    asked.push({ from, params });
    const q = params.get('q') || '';
    const slug = q.replace(/\W+/g, '-');
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: [{ url: `https://${from}.example/${slug}`, title: `${q}: notes from ${from}`, content: `A hand-written page about ${q}.` }] }),
    };
  };

  beforeAll(async () => {
    searx = await fixtureServer({ '/search': searxng('searx') });
    saved = await fixtureServer({ '/search': searxng('saved') });
  });
  beforeEach(() => {
    asked.length = 0;
    search.clearSearchCache();
    search.resetSourceHealth();
    vi.stubEnv('SEARXNG_URL', searx.baseUrl);
  });
  afterAll(async () => {
    await searx.close();
    await saved.close();
  });

  it('searches with POST, answering ranked results and metrics', async () => {
    const r = await api('POST', '/api/search', { query: 'tiny web gardens' });
    expect(r.status).toBe(200);
    const res = data<RankedSearchResponse>(r);
    expect(res).toMatchObject({ query: 'tiny web gardens', lens: 'all', uncensoredMode: false, compiledQuery: { rawQuery: 'tiny web gardens' } });
    expect(res.results.map((x) => x.url)).toContain('https://searx.example/tiny-web-gardens');
    expect(res.metrics).toMatchObject({ surfacedCount: res.results.length, p2pCount: res.p2pResults.length, durationMs: expect.any(Number) });
    expect(res.metrics.sourcesQueried).toEqual(expect.arrayContaining(['marginalia', 'wikipedia', 'web']));
    expect(res.metrics.sourceTimings?.searxng).toMatchObject({ status: 'ok', count: 1 });
    expect(asked.map((a) => [a.from, a.params.get('q'), a.params.get('format'), a.params.get('safesearch')])).toEqual([['searx', 'tiny web gardens', 'json', '1']]);
  });

  it('takes the scope and 18+ mode from the POST config', async () => {
    const res = data<RankedSearchResponse>(await api('POST', '/api/search', { query: 'tiny web gardens', config: { lens: 'forums', uncensoredMode: true } }));
    expect(res).toMatchObject({ lens: 'forums', uncensoredMode: true });
    expect(res.metrics.sourcesQueried).toEqual(expect.arrayContaining(['discourse', 'deep-forums', 'chanboards', 'wild-west']));
    expect(asked[0].params.get('safesearch')).toBe('0');
  });

  it('searches with GET, taking the lens and uncensored from the query string, for any site', async () => {
    const r = await api('GET', '/api/search?q=tiny%20web%20gardens&lens=small-web&uncensored=true', undefined, { Origin: 'https://evil.example' });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(data(r)).toMatchObject({ query: 'tiny web gardens', lens: 'small-web', uncensoredMode: true });
    expect(data<RankedSearchResponse>(r).metrics.sourcesQueried).toContain('deep-blogs');
    expect(asked[0].params.get('safesearch')).toBe('0');
    expect(data(await api('GET', '/api/search?q=tiny%20web%20gardens&uncensored=1'))).toMatchObject({ lens: 'all', uncensoredMode: false });
  });

  it('requires a query', async () => {
    for (const body of [{}, { query: '' }, { query: '   ' }, { query: 42 }, { query: ['a'] }]) {
      const r = await api('POST', '/api/search', body);
      expect(r.status).toBe(400);
      expect(data(r)).toEqual({ error: 'Query string is required' });
    }
    for (const qs of ['', '?q=', '?q=%20%20', '?q=a&q=b', '?query=a']) {
      const r = await api('GET', `/api/search${qs}`);
      expect(r.status, qs).toBe(400);
      expect(data(r)).toEqual({ error: 'Query parameter q is required' });
    }
    expect(asked).toEqual([]);
  });

  it("prefers the caller's endpoints to saved ones, ignoring masked values", async () => {
    await api('PUT', '/api/integrations', { config: { searxngUrl: saved.baseUrl } });
    try {
      await api('POST', '/api/search', { query: 'saved endpoint' });
      await api('GET', '/api/search?q=saved+endpoint+by+get');
      await api('POST', '/api/search', { query: 'masked endpoint', config: { endpoints: { searxngUrl: '••••0000' } } });
      await api('POST', '/api/search', { query: 'caller endpoint', config: { endpoints: { searxngUrl: searx.baseUrl } } });
      expect(asked.map((a) => `${a.from}: ${a.params.get('q')}`)).toEqual([
        'saved: saved endpoint',
        'saved: saved endpoint by get',
        'saved: masked endpoint',
        'searx: caller endpoint',
      ]);
    } finally {
      await api('PUT', '/api/integrations', { config: { searxngUrl: '' } });
    }
  });
});

describe('research', () => {
  const ARTICLE = `<!doctype html><html><head><title>How async runtimes schedule tasks</title>
    <script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head><body><nav>Home · About</nav><article>
    <h1>How async runtimes schedule tasks</h1>
    <p>An async runtime keeps a queue of ready tasks and polls each future until it returns pending, then parks the worker thread until a waker fires.</p>
    <p>Work stealing lets idle worker threads take ready tasks from busy ones, which keeps every core busy without a global lock on the queue.</p>
    <p>The design is described in the <a href="https://tokio.rs/blog/2019-10-scheduler">Tokio scheduler write-up</a>.</p>
    </article></body></html>`;
  const QUERY = 'how do async runtimes schedule tasks';
  let pages: Fixture;
  let model: Awaited<ReturnType<typeof serve>>;
  let reply: 'answer' | 'fail' | 'cut' = 'answer';
  const asked: { url?: string; headers: http.IncomingHttpHeaders; body: { model: string; stream: boolean; max_tokens: number; messages: unknown[] } }[] = [];

  beforeAll(async () => {
    pages = await fixtureServer({ '/article': { body: ARTICLE } });
    model = await serve(async (req, res) => {
      asked.push({ url: req.url, headers: req.headers, body: JSON.parse(await bodyOf(req)) });
      if (reply === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model exploded' } }));
        return;
      }
      const piece = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (reply === 'cut') res.write(piece('Idle workers '), () => setTimeout(() => res.socket?.destroy(), 20));
      else res.end(`${piece('Idle workers steal ')}${piece('ready tasks [1].')}data: [DONE]\n\n`);
    });
  });
  beforeEach(() => {
    asked.length = 0;
  });
  afterAll(async () => {
    await pages.close();
    await model.close();
  });

  const candidates = () => [
    { title: 'How async runtimes schedule tasks', url: `${pages.baseUrl}/article`, snippet: 'Runtimes keep a queue of ready tasks.' },
    { title: 'A page that is down', url: `http://localhost:${new URL(unreachable).port}/gone`, snippet: 'The snippet stands in for the page.' },
  ];
  const research = (body?: unknown) => api('POST', '/api/research', body);
  const withModel = async (run: () => Promise<void>) => {
    await api('PUT', '/api/plugins/ai/settings', { values: { provider: 'custom', baseUrl: `${model.baseUrl}/v1/`, model: 'fixture-model' } });
    try {
      await run();
    } finally {
      await api('PUT', '/api/plugins/ai/settings', { values: { provider: '', baseUrl: '', model: '' } });
    }
  };

  it('streams newline-delimited events ending in done, quoting the pages when no model is set', async () => {
    const r = await research({ query: QUERY, candidates: candidates() });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-cache, no-transform');
    expect(r.headers['x-accel-buffering']).toBe('no');
    const evs = events(r);
    expect(evs.map((e) => e.type)).toEqual(['status', 'sources', 'delta', 'done']);
    expect(evs[0]).toEqual({ type: 'status', stage: 'reading', detail: 'Reading 2 sources' });
    const { sources } = evs[1] as Extract<ResearchEvent, { type: 'sources' }>;
    expect(sources.map((s) => [s.index, s.read])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(sources[0].passages.join(' ')).toContain('ready tasks');
    expect(sources[1].passages).toEqual(['The snippet stands in for the page.']);
    expect((evs[2] as Extract<ResearchEvent, { type: 'delta' }>).text).not.toBe('');
    expect(evs[3]).toMatchObject({ type: 'done', mode: 'extractive', durationMs: expect.any(Number) });
    expect(pages.hits).toContain('GET /article');
  });

  it('searches first when the client sends no candidates', async () => {
    const evs = events(await research({ query: 'xyzzy plugh frobnitz' }));
    expect(evs.map((e) => e.type)).toEqual(['status', 'search', 'delta', 'done']);
    expect(evs[0]).toEqual({ type: 'status', stage: 'searching', detail: 'Searching' });
    expect((evs[1] as Extract<ResearchEvent, { type: 'search' }>).response).toMatchObject({ query: 'xyzzy plugh frobnitz', results: [] });
    expect(evs[2]).toEqual({ type: 'delta', text: 'No readable pages in these results to research.' });
  });

  it('writes the answer with the configured model, streaming its words', async () => {
    reply = 'answer';
    await withModel(async () => {
      const evs = events(await research({ query: QUERY, candidates: candidates().slice(0, 1) }));
      expect(evs.map((e) => e.type)).toEqual(['status', 'sources', 'status', 'delta', 'delta', 'done']);
      expect(evs[2]).toEqual({ type: 'status', stage: 'writing', detail: 'Writing with fixture-model' });
      expect(evs.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')).toBe('Idle workers steal ready tasks [1].');
      expect(evs[5]).toMatchObject({ type: 'done', mode: 'ai', model: 'fixture-model' });
      expect(asked).toHaveLength(1);
      expect(asked[0].url).toBe('/v1/chat/completions');
      expect(asked[0].headers.authorization).toBeUndefined();
      expect(asked[0].body).toMatchObject({ model: 'fixture-model', stream: true, max_tokens: 900 });
      expect(JSON.stringify(asked[0].body.messages)).toContain('ready tasks');
    });
  });

  it("falls back to quoting the pages when the model doesn't answer", async () => {
    reply = 'fail';
    await withModel(async () => {
      const evs = events(await research({ query: QUERY, candidates: candidates().slice(0, 1) }));
      expect(evs.map((e) => e.type)).toEqual(['status', 'sources', 'status', 'notice', 'delta', 'done']);
      expect((evs[3] as Extract<ResearchEvent, { type: 'notice' }>).message).toMatch(/didn't answer \(.*model exploded\)\. Showing quoted passages instead\.$/);
      expect(evs[5]).toMatchObject({ type: 'done', mode: 'extractive' });
    });
  });

  it('ends with an error event when the model stops mid-answer', async () => {
    reply = 'cut';
    await withModel(async () => {
      const evs = events(await research({ query: QUERY, candidates: candidates().slice(0, 1) }));
      expect(evs.map((e) => e.type)).toEqual(['status', 'sources', 'status', 'delta', 'error']);
      expect((evs[4] as Extract<ResearchEvent, { type: 'error' }>).message).toMatch(/stopped mid-answer/);
    });
  });

  it('requires a query, and says so in plain JSON', async () => {
    for (const body of [undefined, {}, { query: '' }, { query: '   ' }, { query: 7 }, { candidates: [] }]) {
      const r = await research(body);
      expect(r.status).toBe(400);
      expect(r.headers['content-type']).toMatch(/^application\/json/);
      expect(data(r)).toEqual({ error: 'query is required' });
    }
  });

  it('stops reading pages when the client goes away', async () => {
    const slow = await hangingUpstream();
    try {
      let received = '';
      const req = http.request({ host: '127.0.0.1', port: open.port, method: 'POST', path: '/api/research', headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (received += chunk));
        res.on('error', () => {});
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ query: 'a page that never answers', candidates: [{ title: 'Slow', url: `${slow.baseUrl}/slow`, snippet: '' }] }));
      await vi.waitFor(() => expect(slow.opened).toBe(1), { timeout: 3000, interval: 10 });
      await vi.waitFor(() => expect(received).toBe(`${JSON.stringify({ type: 'status', stage: 'reading', detail: 'Reading 1 source' })}\n`), { timeout: 3000, interval: 10 });
      req.destroy();
      await vi.waitFor(() => expect(slow.closed).toBe(1), { timeout: 3000, interval: 10 });
      expect((await api('GET', '/api/health')).status).toBe(200);
    } finally {
      await slow.close();
    }
  });
});

describe('the deep index', () => {
  const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Tiny feed</title><link>http://127.0.0.1/</link>
    <item><title>First post</title><link>http://127.0.0.1/first</link><description>Hello from a tiny feed.</description></item></channel></rss>`;
  const feed = { headers: { 'Content-Type': 'application/rss+xml' }, body: RSS };
  let feeds: Fixture;
  let host = '';
  const sites = async (qs = '') => {
    const r = await api('GET', `/api/deep/sites${qs}`);
    expect(r.status, qs).toBe(200);
    return data(r);
  };
  const stopCrawl = async () => {
    await api('POST', '/api/deep/crawl', { action: 'pause' });
    await vi.waitFor(async () => expect(data(await api('GET', '/api/deep')).active).toBe(0), { timeout: 3000, interval: 20 });
  };

  beforeAll(async () => {
    // A fresh, empty index: nothing earlier in this file may have seeded it.
    deep.resetDeepIndex();
    for (const f of ['deep.db', 'deep.db-wal', 'deep.db-shm']) fs.rmSync(path.join(home, f), { force: true });
    feeds = await fixtureServer({
      '/feed.xml': feed,
      '/after-dark.xml': feed,
      '/blog': { body: '<html><head><link rel="alternate" type="application/rss+xml" href="/blog/feed.xml"></head><body><p>Hi</p></body></html>' },
      '/blog/feed.xml': feed,
      '/plain': { body: '<html><body><p>No feed here.</p></body></html>' },
      '/gone': { status: 404, body: 'gone' },
    });
    host = new URL(feeds.baseUrl).host;
  });
  afterAll(async () => {
    await stopCrawl();
    await feeds.close();
    deep.resetDeepIndex();
  });

  it('has nothing to pick at random before anything is indexed', async () => {
    for (const qs of ['', '?kind=blog', '?kind=board&nsfw=true']) {
      const r = await api('GET', `/api/deep/random${qs}`);
      expect(r.status, qs).toBe(404);
      expect(data(r)).toEqual({ error: 'Nothing indexed yet' });
    }
  });

  it('reports an idle, empty index', async () => {
    const r = await api('GET', '/api/deep');
    expect(r.status).toBe(200);
    expect(data(r)).toEqual({
      available: true,
      crawling: false,
      active: 0,
      counts: { visited: 0, unchanged: 0, failed: 0, posts: 0 },
      startedAt: null,
      lastError: null,
      seededAt: null,
      seeding: false,
      seedErrors: [],
      nextDueAt: null,
      posts: 0,
      bytes: expect.any(Number),
      byKind: [],
    });
  });

  it('lists the built-in sources on the first visit, without crawling', async () => {
    const page = await sites();
    expect(page).toMatchObject({ available: true, origins: [], loading: expect.any(Boolean) });
    expect(page.total).toBeGreaterThanOrEqual(200);
    expect(page.items).toHaveLength(60);
    expect(Object.keys(page.items[0]).sort()).toEqual(['fetched_at', 'id', 'kind', 'nsfw', 'origin', 'posts', 'site', 'status', 'title', 'url']);
    expect(page.counts.board).toBeGreaterThan(0);
    expect(page.counts.forum).toBeGreaterThan(0);
    // The open directories can't be downloaded offline; each failure is reported, none is fatal.
    expect(page.errors.length).toBeGreaterThanOrEqual(4);
    for (const e of page.errors) expect(e).toContain('Tests must not reach the network');
    expect(data(await api('GET', '/api/deep'))).toMatchObject({ crawling: false, counts: { visited: 0 } });
  });

  it('filters by kind, listing the directories each kind came from', async () => {
    const boards = await sites('?kind=board&limit=200');
    expect(boards.items.length).toBeGreaterThan(0);
    expect(boards.items.every((i: { kind: string }) => i.kind === 'board')).toBe(true);
    expect(boards.origins.length).toBeGreaterThan(0);
    for (const o of boards.origins) expect(o).toEqual({ origin: expect.any(String), sources: expect.any(Number) });
  });

  it('clamps limit and offset, and treats ones that are not numbers as unset', async () => {
    const names = (page: { items: { site: string }[] }) => page.items.map((i) => i.site);
    const all = await sites('?order=name&limit=200');
    expect(all.items).toHaveLength(200);
    expect((await sites('?order=name&limit=1000')).items).toHaveLength(200);
    expect((await sites('?order=name&limit=-5')).items).toHaveLength(1);
    for (const limit of ['abc', '0', '']) expect((await sites(`?order=name&limit=${limit}`)).items, limit).toHaveLength(60);
    expect(names(await sites('?order=name&limit=5&offset=3'))).toEqual(names(all).slice(3, 8));
    for (const offset of ['-4', 'abc', '']) expect(names(await sites(`?order=name&limit=5&offset=${offset}`)), offset).toEqual(names(all).slice(0, 5));
    const past = await sites(`?offset=${all.total}`);
    expect(past.items).toEqual([]);
    expect(past.total).toBe(all.total);
  });

  it('sorts by name and searches site names, ignoring unknown kinds and orders', async () => {
    const { total } = await sites();
    const byName = (await sites('?order=name&limit=200')).items.map((i: { site: string }) => i.site);
    expect(byName).toEqual([...byName].sort());
    const found = await sites(`?q=${encodeURIComponent(byName[0])}`);
    expect(found.total).toBeGreaterThan(0);
    expect(found.total).toBeLessThan(total);
    for (const i of found.items) expect(`${i.site} ${i.title}`.toLowerCase()).toContain(byName[0]);
    // LIKE wildcards in the search are dropped, not obeyed.
    expect((await sites('?q=%25%25_')).total).toBe(total);
    expect((await sites('?kind=bogus&order=bogus')).total).toBe(total);
  });

  it('keeps 18+ sources out unless asked', async () => {
    const safe = await sites('?kind=board&limit=200');
    const all = await sites('?kind=board&limit=200&nsfw=true');
    expect(all.total).toBeGreaterThan(safe.total);
    expect(safe.items.some((i: { nsfw: number }) => i.nsfw)).toBe(false);
    expect(all.items.some((i: { nsfw: number }) => i.nsfw)).toBe(true);
  });

  it('adds a feed, a page that links one, or an 18+ feed', async () => {
    const add = async (body: unknown) => {
      const r = await api('POST', '/api/deep/sources', body);
      expect(r.status).toBe(200);
      return data(r).source;
    };
    expect(await add({ url: `${feeds.baseUrl}/feed.xml` })).toMatchObject({ url: `${feeds.baseUrl}/feed.xml`, kind: 'blog', site: '127.0.0.1', origin: 'user', next_at: 0 });
    expect(await add({ url: `${feeds.baseUrl}/blog` })).toMatchObject({ url: `${feeds.baseUrl}/blog/feed.xml`, kind: 'blog', origin: 'user' });
    expect((await add({ url: `${feeds.baseUrl}/after-dark.xml`, nsfw: true })).nsfw).toBeTruthy();
    const mine = await sites('?origin=user&nsfw=true');
    expect(mine.items.map((i: { url: string }) => i.url).sort()).toEqual(['/after-dark.xml', '/blog/feed.xml', '/feed.xml'].map((p) => `${feeds.baseUrl}${p}`));
    expect((await sites('?origin=user')).total).toBe(2);
  });

  it('refuses an address it cannot use, saying why', async () => {
    const cases: [unknown, string][] = [
      [{}, 'url is required'],
      [{ url: '   ' }, 'url is required'],
      [{ url: 42 }, 'url is required'],
      [{ url: 'ftp://example.com/feed' }, 'Only http(s) addresses can be added.'],
      [{ url: 'http://exa mple.com/' }, 'That is not a valid address.'],
      [{ url: `${feeds.baseUrl}/plain` }, `No feed, forum or board found at ${host}. Try the page's RSS link or a board's catalog.json.`],
      [{ url: `${feeds.baseUrl}/gone` }, `${host} answered HTTP 404.`],
      [{ url: `${unreachable}/feed.xml` }, 'fetch failed'],
    ];
    for (const [body, error] of cases) {
      const r = await api('POST', '/api/deep/sources', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(data(r)).toEqual({ error });
    }
  });

  it('picks a random site, or a random post once it has one', async () => {
    const r = await api('GET', '/api/deep/random');
    expect(r.status).toBe(200);
    expect(data(r)).toEqual({ kind: 'site', url: expect.stringMatching(/^https:\/\/[^/]+\/$/), title: expect.any(String), site: expect.any(String) });
    expect(data(await api('GET', '/api/deep/random?kind=blog'))).toEqual({ kind: 'site', url: 'https://127.0.0.1/', title: '127.0.0.1', site: '127.0.0.1' });

    const store = (await deep.getDeepStore())!;
    store.savePosts(store.getSourceByUrl(`${feeds.baseUrl}/feed.xml`)!, [{ url: 'http://127.0.0.1/a-post', title: 'A post', summary: 'Hello.', published: 1e12 }]);
    expect(data(await api('GET', '/api/deep/random?kind=blog'))).toEqual({ kind: 'post', url: 'http://127.0.0.1/a-post', title: 'A post', site: '127.0.0.1' });
  });

  it('starts, pauses and reseeds the crawl, and refuses anything else', async () => {
    for (const body of [{}, { action: 'stop' }, { action: 'START' }, { action: ['start'] }]) {
      const r = await api('POST', '/api/deep/crawl', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(data(r)).toEqual({ error: 'action must be start, pause or reseed' });
    }
    const reseeded = await api('POST', '/api/deep/crawl', { action: 'reseed' });
    expect(reseeded.status).toBe(200);
    expect(data(reseeded)).toMatchObject({ available: true, crawling: false });
    expect(data(reseeded).seedErrors.length).toBeGreaterThanOrEqual(4);

    const started = await api('POST', '/api/deep/crawl', { action: 'start' });
    expect(started.status).toBe(200);
    expect(data(started)).toMatchObject({ available: true, crawling: true, startedAt: expect.any(Number) });

    const paused = await api('POST', '/api/deep/crawl', { action: 'pause' });
    expect(paused.status).toBe(200);
    expect(data(paused).crawling).toBe(false);
    await stopCrawl();
  });
});

describe('plugins', () => {
  const userDir = path.join(home, 'plugins');
  const settingsFile = path.join(home, 'plugins.json');
  const settings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, Record<string, string>>;
  const tool = async (plugin: string, id: string, body: unknown) => {
    const r = await api('POST', `/api/plugins/${plugin}/tools/${id}`, body);
    expect(r.status).toBe(200);
    return data<ToolResult>(r);
  };
  const plugins = async () => data<{ plugins: PluginInfo[] }>(await api('GET', '/api/plugins')).plugins;

  afterAll(async () => {
    fs.rmSync(userDir, { recursive: true, force: true });
    await api('POST', '/api/plugins/reload');
  });

  it('lists the built-in plugins with their tools and saved values', async () => {
    const r = await api('GET', '/api/plugins');
    expect(r.status).toBe(200);
    const body = data<{ plugins: PluginInfo[]; userDir: string }>(r);
    expect(body.userDir).toBe(userDir);
    expect(body.plugins.map((p) => p.id).sort()).toEqual(BUILTIN_IDS);
    for (const p of body.plugins) expect(p).toMatchObject({ source: 'builtin', hasRunner: true, configured: expect.any(Boolean), values: expect.any(Object), tools: expect.any(Array) });
    expect(body.plugins.find((p) => p.id === 'utils')?.tools.map((t) => t.id)).toEqual(['hash', 'encode', 'jwt', 'time', 'uuid', 'magnet']);
    expect(body.plugins.find((p) => p.id === 'ai')?.values).toEqual({ provider: 'none' });
  });

  it('loads plugins from the user folder on reload, reporting broken ones by folder name', async () => {
    for (const dir of ['hello', 'broken', '_draft']) fs.mkdirSync(path.join(userDir, dir), { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'hello', 'index.mjs'),
      `export default {
        id: 'hello', name: 'Hello', description: 'A plugin written outside the repo', category: 'utility',
        tools: [
          { id: 'greet', name: 'Greet', description: 'Says hello', inputs: [{ key: 'name', label: 'Name', required: true }],
            run: async (input) => ({ blocks: [{ type: 'text', content: 'Hello, ' + input.name }] }) },
          { id: 'wait', name: 'Wait', description: 'Fetches a page', inputs: [{ key: 'url', label: 'URL' }],
            run: async (input, ctx) => { await ctx.fetch(input.url); return { blocks: [] }; } },
        ],
      };`
    );
    fs.writeFileSync(path.join(userDir, 'broken', 'index.mjs'), 'export default { id: "broken", tools: [ }');
    fs.writeFileSync(path.join(userDir, '_draft', 'index.mjs'), 'throw new Error("drafts are ignored")');
    expect((await plugins()).some((p) => p.id === 'hello')).toBe(false);

    const r = await api('POST', '/api/plugins/reload');
    expect(r.status).toBe(200);
    const listed = data<{ plugins: PluginInfo[] }>(r).plugins;
    expect(listed.find((p) => p.id === 'hello')).toMatchObject({ source: 'user', name: 'Hello', configured: true, values: {} });
    const broken = listed.find((p) => p.id === 'broken');
    expect(broken).toMatchObject({ source: 'user', error: expect.any(String) });
    expect(broken).not.toHaveProperty('values');
    expect(listed.some((p) => p.id === '_draft')).toBe(false);
    expect(listed.filter((p) => p.source === 'builtin' && !p.error).map((p) => p.id).sort()).toEqual(BUILTIN_IDS);
  });

  it('runs a tool and answers its blocks', async () => {
    const sha256 = crypto.createHash('sha256').update('glogg').digest('hex');
    expect((await tool('utils', 'hash', { input: { text: 'glogg' } })).blocks).toEqual([{ type: 'kv', items: expect.arrayContaining([{ label: 'SHA256', value: sha256 }]) }]);
    expect(await tool('hello', 'greet', { input: { name: 'Ada' } })).toEqual({ blocks: [{ type: 'text', content: 'Hello, Ada' }] });
  });

  it('answers an unknown plugin or tool, or a missing input, with an error notice', async () => {
    expect(await tool('nope', 'hash', { input: { text: 'x' } })).toEqual({ blocks: [{ type: 'notice', tone: 'bad', content: 'Unknown plugin "nope"' }], summary: 'Unknown plugin "nope"' });
    expect(await tool('utils', 'nope', { input: {} })).toEqual({
      blocks: [{ type: 'notice', tone: 'bad', content: 'Plugin "Utilities" has no tool "nope"' }],
      summary: 'Plugin "Utilities" has no tool "nope"',
    });
    for (const body of [{ input: {} }, { input: { text: '   ' } }, {}]) expect((await tool('utils', 'hash', body)).summary).toBe('Text is required');
    expect((await tool('hello', 'greet', { input: { name: null } })).summary).toBe('Name is required');
  });

  it('asks for settings before running a tool that needs them', async () => {
    expect((await tool('torbox', 'account', { input: {} })).blocks).toEqual([{ type: 'notice', tone: 'warn', content: expect.stringContaining("isn't set up yet") }]);
  });

  it('stops a tool when the client goes away', async () => {
    const slow = await hangingUpstream();
    try {
      const req = http.request({ host: '127.0.0.1', port: open.port, method: 'POST', path: '/api/plugins/hello/tools/wait', headers: { 'Content-Type': 'application/json' } });
      req.on('error', () => {});
      req.end(JSON.stringify({ input: { url: `${slow.baseUrl}/slow` } }));
      await vi.waitFor(() => expect(slow.opened).toBe(1), { timeout: 3000, interval: 10 });
      req.destroy();
      await vi.waitFor(() => expect(slow.closed).toBe(1), { timeout: 3000, interval: 10 });
    } finally {
      await slow.close();
    }
  });

  it('saves settings, masking secrets, keeping them when the mask comes back, and clearing empty ones', async () => {
    const put = (values: unknown) => api('PUT', '/api/plugins/torbox/settings', { values });
    const saved = await put({ apiKey: '  TB-KEY-0000-6677  ', notASetting: 'x' });
    expect(saved.status).toBe(200);
    expect(data(saved)).toEqual({ values: { apiKey: '••••6677' }, configured: true });
    expect(settings().torbox).toEqual({ apiKey: 'TB-KEY-0000-6677' });
    expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o600);

    const listed = await api('GET', '/api/plugins');
    expect(data<{ plugins: PluginInfo[] }>(listed).plugins.find((p) => p.id === 'torbox')).toMatchObject({ configured: true, values: { apiKey: '••••6677' } });
    expect(listed.body).not.toContain('TB-KEY');

    expect(data(await put({ apiKey: '••••6677' }))).toEqual({ values: { apiKey: '••••6677' }, configured: true });
    expect(settings().torbox).toEqual({ apiKey: 'TB-KEY-0000-6677' });
    expect(data(await put({ apiKey: '' }))).toEqual({ values: {}, configured: false });
    expect(settings().torbox).toEqual({});
  });

  it('stores numbers and booleans as text, and ignores other values', async () => {
    const put = (body: unknown) => api('PUT', '/api/plugins/sabnzbd/settings', body);
    expect(data(await put({ values: { url: 8085, apiKey: true } })).values).toEqual({ url: '8085', apiKey: '••••true' });
    await put({ values: { url: { host: 'x' }, apiKey: ['y'] } });
    expect(settings().sabnzbd).toEqual({ url: '8085', apiKey: 'true' });
    for (const body of [{ values: 'junk' }, { values: null }, {}]) expect((await put(body)).status).toBe(200);
    expect(settings().sabnzbd).toEqual({ url: '8085', apiKey: 'true' });
    expect(data(await put({ values: { url: '', apiKey: '' } })).values).toEqual({ url: 'http://localhost:8085' });
  });

  it('refuses settings for a plugin that does not exist', async () => {
    const r = await api('PUT', '/api/plugins/nope/settings', { values: { a: 'b' } });
    expect(r.status).toBe(404);
    expect(data(r)).toEqual({ error: 'Unknown plugin nope' });
  });

  it('reports no container for a plugin that declares none, or does not exist', async () => {
    for (const id of ['utils', 'nope']) {
      const r = await api('GET', `/api/plugins/${id}/container`);
      expect(r.status).toBe(200);
      expect(data(r)).toEqual({ runtime: 'none', state: 'unavailable', detail: 'No container declared' });
    }
  });

  it('accepts only up, down and remove as container actions', async () => {
    for (const body of [{}, { action: 'restart' }, { action: 'UP' }, { action: ['up'] }]) {
      const r = await api('POST', '/api/plugins/sabnzbd/container', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(data(r)).toEqual({ error: 'action must be up, down or remove' });
    }
    for (const action of ['up', 'down', 'remove']) {
      const r = await api('POST', '/api/plugins/utils/container', { action });
      expect(r.status).toBe(400);
      expect(data(r)).toEqual({ error: 'This plugin has no container' });
    }
  });

  it('reports a declared container as unavailable when neither Docker nor Podman is installed', async () => {
    vi.stubEnv('PATH', fs.mkdtempSync(path.join(home, 'no-bin-')));
    expect(data(await api('GET', '/api/plugins/sabnzbd/container'))).toEqual({ runtime: 'none', state: 'unavailable', detail: 'Docker or Podman is not running' });
    const up = await api('POST', '/api/plugins/sabnzbd/container', { action: 'up' });
    expect(up.status).toBe(400);
    expect(data(up)).toEqual({ error: 'Docker or Podman is not running' });
  });
});

describe('OpenSearch', () => {
  it('describes glogg as a search engine at the address it was reached on', async () => {
    const local = await api('GET', '/opensearch.xml');
    expect(local.status).toBe(200);
    expect(local.headers['content-type']).toBe('application/opensearchdescription+xml; charset=utf-8');
    expect(local.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(local.body).toContain('<ShortName>glogg.app</ShortName>');
    expect(local.body).toContain('<InputEncoding>UTF-8</InputEncoding>');
    const base = `http://127.0.0.1:${open.port}`;
    expect(local.body).toContain(`<Url type="text/html" method="get" template="${base}/?q={searchTerms}"/>`);
    expect(local.body).toContain(`<Url type="application/json" rel="results" template="${base}/api/search?q={searchTerms}"/>`);
    expect(local.body).toContain(`<Url type="application/x-suggestions+json" rel="suggestions" template="${base}/api/opensearch/suggest?q={searchTerms}"/>`);

    const proxied = await api('GET', '/opensearch.xml', undefined, { Host: 'glogg.example.com', 'X-Forwarded-Proto': 'https' });
    expect(proxied.body).toContain('template="https://glogg.example.com/?q={searchTerms}"');
    expect(proxied.body).toContain('template="https://glogg.example.com/api/opensearch/suggest?q={searchTerms}"');
  });

  it('answers suggestions as [query, titles, descriptions, urls], to any site', async () => {
    const r = await api('GET', '/api/opensearch/suggest?q=%20MARGINALIA%20', undefined, { Origin: 'https://evil.example' });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const matches = CURATED_INDIE_INDEX.filter(
      (i) => i.title.toLowerCase().includes('marginalia') || i.domain.toLowerCase().includes('marginalia') || i.tags.some((t) => t.toLowerCase().includes('marginalia'))
    ).slice(0, 8);
    expect(matches.length).toBeGreaterThan(0);
    expect(data(r)).toEqual([
      'marginalia',
      matches.map((m) => m.title),
      matches.map((m) => m.description),
      matches.map((m) => m.url),
    ]);
  });

  it('suggests at most eight sites', async () => {
    const [, titles, descriptions, urls] = data<[string, string[], string[], string[]]>(await api('GET', '/api/opensearch/suggest?q=e'));
    expect(titles).toHaveLength(8);
    expect(descriptions).toHaveLength(8);
    expect(urls).toHaveLength(8);
  });

  it('answers an empty or unmatched query with empty lists', async () => {
    for (const [qs, q] of [['', ''], ['?q=', ''], ['?q=%20', ''], ['?q=zzqqxx', 'zzqqxx'], ['?q=a&q=b', '']]) {
      expect(data(await api('GET', `/api/opensearch/suggest${qs}`)), qs).toEqual([q, [], [], []]);
    }
  });
});

describe('GET /api/ipfs/:cid', () => {
  const PUBLIC = [`https://ipfs.io/ipfs/${CID}`, `https://dweb.link/ipfs/${CID}`];

  it('resolves through the local gateway when it answers', async () => {
    const gateway = await fixtureServer({ [`/ipfs/${CID}`]: { body: 'hello' } });
    vi.stubEnv('IPFS_GATEWAY_URL', gateway.baseUrl);
    try {
      const r = await api('GET', `/api/ipfs/${CID}`, undefined, { Origin: 'https://evil.example' });
      expect(r.status).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBe('*');
      const body = data(r);
      expect(body).toMatchObject({ cid: CID, localNodeActive: true, gatewayUrl: `${gateway.baseUrl}/ipfs/${CID}` });
      expect(body.fallbackGateways).toHaveLength(3);
      expect(body.fallbackGateways).toEqual(expect.arrayContaining(PUBLIC));
      expect(gateway.hits).toEqual([`GET /ipfs/${CID}`]);
    } finally {
      await gateway.close();
    }
  });

  it('falls back to a public gateway when the local one is down or failing', async () => {
    const failing = await fixtureServer({ [`/ipfs/${CID}`]: { status: 502 } });
    try {
      for (const url of [unreachable, failing.baseUrl]) {
        vi.stubEnv('IPFS_GATEWAY_URL', url);
        expect(data(await api('GET', `/api/ipfs/${CID}`))).toMatchObject({ cid: CID, localNodeActive: false, gatewayUrl: PUBLIC[0] });
      }
    } finally {
      await failing.close();
    }
  });

  it.each(['bafy-x', 'bafy.x', 'bafy%2Fx', '%20', 'caf%C3%A9', '%3Cscript%3E'])('refuses the CID %s', async (cid) => {
    const r = await api('GET', `/api/ipfs/${cid}`);
    expect(r.status).toBe(400);
    expect(data(r)).toEqual({ error: 'Valid IPFS CID is required' });
  });
});

describe('POST /api/inspect', () => {
  const ARTICLE = `<!doctype html><html><head><title>Ring buffers in io_uring</title>
    <script src="https://www.google-analytics.com/analytics.js"></script></head><body><article><h1>Ring buffers in io_uring</h1>
    <p>Shared ring buffers between user space and the kernel avoid a system call per request, which is where the throughput comes from.</p>
    <p>The design is in the <a href="https://kernel.dk/io_uring.pdf">io_uring paper</a> and the <a href="https://github.com/axboe/liburing">liburing repository</a>.</p>
    </article></body></html>`;
  let site: Fixture;
  let agent = '';

  beforeAll(async () => {
    site = await fixtureServer({
      '/article': (req) => {
        agent = String(req.headers['user-agent']);
        return { body: ARTICLE };
      },
    });
  });
  afterAll(() => site.close());

  const inspect = (body?: unknown) => api('POST', '/api/inspect', body);

  it('cleans raw HTML it is given, without fetching anything', async () => {
    const r = await inspect({ url: 'https://kernel.dk/io_uring.html', rawHtml: ARTICLE });
    expect(r.status).toBe(200);
    const report = data<PageAutopsyReport>(r);
    expect(report).toMatchObject({ url: 'https://kernel.dk/io_uring.html', domain: 'kernel.dk', title: 'Ring buffers in io_uring', stats: { totalScriptsRemoved: 1 } });
    expect(report.primarySources.map((s) => s.url)).toEqual(['https://github.com/axboe/liburing']);
    expect(report.sections.length).toBeGreaterThan(0);
  });

  it('fetches the page itself, as the reader', async () => {
    const r = await inspect({ url: `${site.baseUrl}/article` });
    expect(r.status).toBe(200);
    expect(data<PageAutopsyReport>(r)).toMatchObject({ url: `${site.baseUrl}/article`, domain: '127.0.0.1', title: 'Ring buffers in io_uring' });
    expect(agent).toContain('GloggReader');
  });

  it('adds https:// to an address without a scheme', async () => {
    const r = await inspect({ url: 'example.com/post' });
    expect(r.status).toBe(502);
    expect(data(r)).toEqual({ error: 'Tests must not reach the network: https://example.com/post' });
  });

  it('requires a URL, and a valid one', async () => {
    for (const body of [{}, { url: '' }, { url: 42 }, { rawHtml: '<p>x</p>' }]) {
      const r = await inspect(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(data(r)).toEqual({ error: 'Target URL is required' });
    }
    for (const url of ['http://', 'https://exa mple.com/']) {
      const r = await inspect({ url });
      expect(r.status, url).toBe(400);
      expect(data(r)).toEqual({ error: 'Invalid URL format' });
    }
  });

  it('answers 502 when the page cannot be fetched', async () => {
    const r = await inspect({ url: `${unreachable}/article` });
    expect(r.status).toBe(502);
    expect(data(r)).toEqual({ error: 'fetch failed' });
  });
});

describe('requests the API does not take', () => {
  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
  const allowed = new Map<string, Set<string>>();
  for (const r of ROUTES) {
    const p = target(r).split('?')[0];
    allowed.set(p, (allowed.get(p) ?? new Set()).add(r.method));
  }
  const wrong = [...allowed].flatMap(([p, methods]) => METHODS.filter((m) => !methods.has(m)).map((m) => [m, p] as const));

  it('answers 404 to a method a route does not have', async () => {
    for (const [method, p] of wrong.filter(([m]) => m !== 'GET')) {
      const r = await api(method, p);
      expect(r.status, `${method} ${p}`).toBe(404);
      expect(r.headers['content-type'], `${method} ${p}`).toMatch(/^text\/html/);
    }
  });

  it('leaves a GET to a route that has none to the web app', async () => {
    quietly();
    for (const [, p] of wrong.filter(([m]) => m === 'GET')) {
      const r = await api('GET', p);
      // The app's index.html when it has been built, a 404 page before.
      expect([200, 404], p).toContain(r.status);
      expect(r.headers['content-type'], p).toMatch(/^text\/html/);
    }
  });

  it('answers malformed JSON with 400', async () => {
    quietly();
    for (const p of ['/api/search', '/api/inspect', '/api/research', '/api/downloads']) {
      const r = await rawRequest(open.port, { method: 'POST', path: p, headers: { 'Content-Type': 'application/json' }, body: '{"query":' });
      expect(r.status, p).toBe(400);
    }
  });
});

describe('called from another site', () => {
  const evil = { Origin: 'https://evil.example' };
  const send = (r: RouteCase, headers: Record<string, string>) => api(r.method, target(r), r.body, headers);
  const privateRoutes = ROUTES.filter((r) => !r.public);

  it.each(privateRoutes)('refuses $method $route, without CORS headers', async (r) => {
    const res = await send(r, evil);
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(data(res)).toEqual({ error: "Requests from https://evil.example aren't allowed. Add it to GLOGG_ALLOWED_ORIGINS if you trust it." });
  });

  it.each(ROUTES.filter((r) => r.public))('answers $method $route, with CORS *', async (r) => {
    const res = await send(r, evil);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
  });

  it('refuses every private route on a rebinding host name, or a cross-site request without an Origin', async () => {
    for (const r of privateRoutes) {
      const rebound = await send(r, { Host: `evil.example:${open.port}`, Origin: `http://evil.example:${open.port}` });
      expect(rebound.status, `${r.method} ${r.route}`).toBe(403);
      expect(data(rebound).error).toContain('GLOGG_ALLOWED_HOSTS=evil.example');
      const crossSite = await send(r, { 'Sec-Fetch-Site': 'cross-site' });
      expect(crossSite.status, `${r.method} ${r.route}`).toBe(403);
      expect(data(crossSite)).toEqual({ error: "Cross-site requests aren't allowed." });
    }
  });

  it("refuses the 'null' origin of sandboxed frames and files", async () => {
    expect((await api('GET', '/api/plugins', undefined, { Origin: 'null' })).status).toBe(403);
  });

  it('serves glogg itself, without CORS headers', async () => {
    const r = await api('GET', '/api/plugins', undefined, { Origin: `http://127.0.0.1:${open.port}`, 'Sec-Fetch-Site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets in origins listed in GLOGG_ALLOWED_ORIGINS, echoing them back', async () => {
    vi.stubEnv('GLOGG_ALLOWED_ORIGINS', 'https://friend.example, https://other.example');
    const r = await api('GET', '/api/plugins', undefined, { Origin: 'https://friend.example' });
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ 'access-control-allow-origin': 'https://friend.example', vary: 'Origin' });
    expect((await api('GET', '/api/plugins', undefined, { Origin: 'https://stranger.example' })).status).toBe(403);
  });

  it('answers preflights: GET from any site for public routes, the rest from allowed origins only', async () => {
    const preflight = (p: string, origin: string, method = 'POST') =>
      api('OPTIONS', p, undefined, { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type' });
    const pub = await preflight('/api/search', 'https://evil.example', 'GET');
    expect(pub.status).toBe(204);
    expect(pub.headers).toMatchObject({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Content-Type' });
    expect((await preflight('/api/search', 'https://evil.example')).status).toBe(403);
    expect((await preflight('/api/research', 'https://evil.example')).status).toBe(403);
    // An extension is trusted only when you list it.
    expect((await preflight('/api/research', 'chrome-extension://abcdefghijklmnop')).status).toBe(403);
    vi.stubEnv('GLOGG_ALLOWED_ORIGINS', 'chrome-extension://abcdefghijklmnop');
    try {
      const ext = await preflight('/api/research', 'chrome-extension://abcdefghijklmnop');
      expect(ext.status).toBe(204);
      expect(ext.headers).toMatchObject({
        'access-control-allow-origin': 'chrome-extension://abcdefghijklmnop',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        vary: 'Origin',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('with a password', () => {
  const PASSWORD = 'a long and careful passphrase';
  let locked: Awaited<ReturnType<typeof startGloggServer>>;
  const call = caller(() => locked.port);
  let cookie = '';

  beforeAll(async () => {
    const before = process.env.GLOGG_PASSWORD;
    process.env.GLOGG_PASSWORD = PASSWORD;
    try {
      locked = await startGloggServer();
    } finally {
      if (before === undefined) delete process.env.GLOGG_PASSWORD;
      else process.env.GLOGG_PASSWORD = before;
    }
    const login = await call('POST', '/api/auth/login', { password: PASSWORD });
    expect(login.status).toBe(204);
    cookie = String(login.headers['set-cookie']).split(';')[0];
  });
  afterAll(() => locked.close());

  const SIGN_IN = { error: 'Sign in to use this glogg.', signIn: true };
  const send = (r: RouteCase, headers: Record<string, string> = {}) => call(r.method, target(r), r.body, headers);
  const lockedRoutes = ROUTES.filter((r) => r.route.startsWith('/api/') && r.route !== '/api/health' && !r.route.startsWith('/api/auth'));

  it.each(lockedRoutes)('refuses $method $route without a session', async (r) => {
    const res = await send(r);
    expect(res.status).toBe(401);
    expect(data(res)).toEqual(SIGN_IN);
  });

  it('refuses before anything else: another site gets 401 too, not 403', async () => {
    for (const r of lockedRoutes) expect((await send(r, { Origin: 'https://evil.example' })).status, `${r.method} ${r.route}`).toBe(401);
  });

  it('answers health and the sign-in routes without a session', async () => {
    expect(data(await call('GET', '/api/health'))).toMatchObject({ status: 'ok' });
    expect(data(await call('GET', '/api/auth'))).toEqual({ required: true, authenticated: false });
    const wrong = await call('POST', '/api/auth/login', { password: 'not it' });
    expect(wrong.status).toBe(401);
    expect(data(wrong)).toEqual({ error: 'Wrong password.' });
    expect((await call('POST', '/api/auth/logout')).status).toBe(204);
  });

  it('lets a session through, to public and private routes alike', async () => {
    for (const p of ['/api/plugins', '/api/integrations', '/api/directory', `/api/ipfs/${CID}`, '/api/opensearch/suggest?q=wiki', '/api/search?q=session+check']) {
      expect((await call('GET', p, undefined, { Cookie: cookie })).status, p).toBe(200);
    }
    expect(data(await call('GET', '/api/auth', undefined, { Cookie: cookie }))).toEqual({ required: true, authenticated: true });
  });

  it('refuses a forged, malformed or expired session cookie', async () => {
    const mac = cookie.split('.')[1];
    for (const c of [`glogg_session=4102444800.${'A'.repeat(43)}`, 'glogg_session=garbage', `glogg_session=1000.${mac}`, `other=${cookie.split('=')[1]}`]) {
      const r = await call('GET', '/api/plugins', undefined, { Cookie: c });
      expect(r.status, c).toBe(401);
      expect(data(r)).toEqual(SIGN_IN);
    }
  });

  it('still refuses another site that carries a session', async () => {
    expect((await call('GET', '/api/plugins', undefined, { Cookie: cookie, Origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('junk input', () => {
  const FUZZ_RUNS = Math.max(1, Math.round(RUNS / 10));
  const LENSES = ['all', 'small-web', 'fediverse', 'forums', 'wild-west', 'p2p-magnet', 'usenet-nzb', 'deep-archives', 'raw-news', 'primary', 'pre-llm'];
  const KEYS = ['query', 'url', 'title', 'text', 'action', 'input', 'values', 'token', 'uri', 'mode', 'value', 'count', 'nsfw', 'serviceId', 'snippet', 'name'];
  const lens = (r: Rng) => (r() < 0.5 ? pick(r, LENSES) : text(r, 3));
  const flag = (r: Rng) => pick(r, ['true', 'false', '1', '', text(r, 2)]);
  /** Percent-encodes every byte, so controls and wide characters reach the server intact. */
  const enc = (s: string) => Array.from(Buffer.from(s, 'utf8'), (b) => `%${b.toString(16).padStart(2, '0')}`).join('');
  /** Lone surrogates become U+FFFD, as they would on the way through UTF-8. */
  const wellFormed = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'utf8').toString('utf8') : v);
  const qs = (r: Rng, params: Record<string, (r: Rng) => string>) =>
    Object.entries(params)
      .flatMap(([k, gen]) => Array.from({ length: pick(r, [0, 1, 1, 1, 2]) }, () => `${k}=${enc(gen(r))}`))
      .join('&');

  function junk(r: Rng, depth = 0): unknown {
    const roll = r();
    if (roll < 0.3) return text(r);
    if (roll < 0.4) return anyString(r);
    if (roll < 0.5) return urlish(r);
    if (roll < 0.6) return pick(r, [0, -1, 1.5, 1e21, Number.MAX_SAFE_INTEGER]);
    if (roll < 0.7) return pick(r, [true, false, null]);
    if (depth >= 2) return text(r, 3);
    if (roll < 0.85) return list(r, 4, (x) => junk(x, depth + 1));
    return Object.fromEntries(list(r, 4, (x) => [pick(x, KEYS), junk(x, depth + 1)]));
  }

  type Case = { method: string; path: string; body?: unknown };
  const CASES: { name: string; gen: (r: Rng) => Case; check?: (res: Reply) => void }[] = [
    { name: 'GET /api/search', gen: (r) => ({ method: 'GET', path: `/api/search?${qs(r, { q: text, lens, uncensored: flag })}` }) },
    {
      name: 'POST /api/search',
      gen: (r) => ({
        method: 'POST',
        path: '/api/search',
        body: {
          // A lone surrogate in a JSON query still answers 500 (URIError in compileSearchQuery); kept out until that is fixed.
          query: wellFormed(junk(r)),
          config: { lens: lens(r), uncensoredMode: junk(r), maxPerDomain: junk(r), slopThreshold: junk(r), blockedDomains: list(r, 3, text), boostedDomains: list(r, 3, text), blockedPhrases: list(r, 3, text) },
        },
      }),
    },
    { name: 'GET /api/opensearch/suggest', gen: (r) => ({ method: 'GET', path: `/api/opensearch/suggest?${qs(r, { q: (x) => (x() < 0.5 ? text(x) : anyString(x)) })}` }) },
    { name: 'GET /api/directory', gen: (r) => ({ method: 'GET', path: `/api/directory?${qs(r, { category: text, shuffle: flag })}` }) },
    { name: 'GET /api/ipfs/:cid', gen: (r) => ({ method: 'GET', path: `/api/ipfs/${enc(`x${anyString(r)}`)}` }) },
    { name: 'GET /api/deep/sites', gen: (r) => ({ method: 'GET', path: `/api/deep/sites?${qs(r, { kind: text, origin: text, q: text, order: text, nsfw: flag })}` }) },
    { name: 'GET /api/deep/random', gen: (r) => ({ method: 'GET', path: `/api/deep/random?${qs(r, { kind: text, nsfw: flag })}` }) },
    { name: 'POST /api/deep/crawl', gen: (r) => ({ method: 'POST', path: '/api/deep/crawl', body: { action: junk(r) } }) },
    { name: 'POST /api/deep/sources', gen: (r) => ({ method: 'POST', path: '/api/deep/sources', body: { url: junk(r), nsfw: junk(r) } }) },
    {
      name: 'POST /api/research',
      gen: (r) => ({
        method: 'POST',
        path: '/api/research',
        body: {
          query: junk(r),
          candidates: r() < 0.5 ? list(r, 3, (x) => ({ title: text(x), url: urlish(x), snippet: text(x) })) : junk(r),
          depth: junk(r),
          history: junk(r),
          instantAnswer: r() < 0.2 ? junk(r) : undefined,
        },
      }),
      check: (res) => {
        if (res.status !== 200) return;
        expect(['done', 'error']).toContain(events(res).at(-1)?.type);
      },
    },
    { name: 'POST /api/inspect', gen: (r) => ({ method: 'POST', path: '/api/inspect', body: { url: r() < 0.5 ? urlish(r) : junk(r), rawHtml: r() < 0.7 ? html(r) : junk(r) } }) },
    { name: 'POST /api/containers/action', gen: (r) => ({ method: 'POST', path: '/api/containers/action', body: { action: junk(r), serviceId: junk(r) } }) },
    { name: 'PUT /api/plugins/:id/settings', gen: (r) => ({ method: 'PUT', path: `/api/plugins/${pick(r, ['utils', `nope-${int(r, 0, 99)}`])}/settings`, body: { values: junk(r) } }) },
    {
      name: 'POST /api/plugins/:id/tools/:tool',
      gen: (r) => ({ method: 'POST', path: `/api/plugins/${pick(r, ['utils', 'nope'])}/tools/${pick(r, ['hash', 'encode', 'jwt', 'time', 'uuid', 'magnet', 'nope'])}`, body: { input: junk(r) } }),
    },
    { name: 'POST /api/plugins/:id/container', gen: (r) => ({ method: 'POST', path: `/api/plugins/${pick(r, ['utils', 'nope'])}/container`, body: { action: junk(r) } }) },
    { name: 'DELETE /api/downloads/:id', gen: (r) => ({ method: 'DELETE', path: `/api/downloads/${enc(`x${anyString(r)}`)}` }) },
  ];

  it.each(CASES)('answers junk sent to $name without a server error', async ({ name, gen, check }) => {
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const seed = BASE_SEED + i;
      const req = gen(rng(seed));
      try {
        const res = await api(req.method, req.path, req.body);
        // 502 is the reader's answer for a page it couldn't fetch, not a fault of its own.
        if (res.status >= 500 && !(name === 'POST /api/inspect' && res.status === 502)) throw new Error(`answered ${res.status}: ${res.body.slice(0, 300)}`);
        check?.(res);
      } catch (e) {
        const shown = JSON.stringify(req);
        throw new Error(
          `${name} failed for seed ${seed} (replay: GLOGG_FUZZ_SEED=${seed} GLOGG_FUZZ_RUNS=1)\ninput: ${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}\n${e instanceof Error ? e.message : e}`
        );
      }
    }
  }, 30_000);
});


describe('bad input and edge cases (bugs the first run of these tests found)', () => {
  const PASSWORD = 'a long and careful passphrase';
  let locked: Awaited<ReturnType<typeof startGloggServer>>;
  const call = caller(() => locked.port);
  beforeAll(async () => {
    process.env.GLOGG_PASSWORD = PASSWORD;
    try {
      locked = await startGloggServer();
    } finally {
      delete process.env.GLOGG_PASSWORD;
    }
  });
  afterAll(() => locked.close());

  it('answers the newer filter lists with 400 too when they are not lists', async () => {
    for (const config of [{ loweredDomains: 'x.example' }, { pinnedDomains: [1] }, { disabledSources: 5 }]) {
      const r = await api('POST', '/api/search', { query: 'rust async', config });
      expect.soft(r.status, `${JSON.stringify(config)}: ${r.body}`).toBe(400);
    }
  });

  it('needs a session whatever the case of /api/', async () => {
    const cases: [string, string, unknown?][] = [
      ['GET', '/API/plugins'],
      ['GET', '/Api/integrations'],
      ['PUT', '/API/integrations', { config: { aria2RpcUrl: `${unreachable}/hijacked` } }],
      ['POST', '/API/inspect', { url: `${unreachable}/internal-only` }],
    ];
    try {
      for (const [m, p, b] of cases) expect.soft((await call(m, p, b)).status, `${m} ${p}`).toBe(401);
    } finally {
      await api('PUT', '/api/integrations', { config: { aria2RpcUrl: `${unreachable}/jsonrpc` } });
    }
  });

  it('refuses another site, or a rebinding host, whatever the case of /api/', async () => {
    for (const p of ['/API/integrations', '/Api/plugins']) {
      expect.soft((await api('GET', p, undefined, { Origin: 'https://evil.example' })).status, `${p} from evil.example`).toBe(403);
      expect.soft((await api('GET', p, undefined, { Host: `evil.example:${open.port}` })).status, `${p} on a rebinding host`).toBe(403);
    }
  });

  it('refuses a download target that does not exist', async () => {
    const r = await api('POST', '/api/downloads', { url: `${unreachable}/a.zip`, target: 'bogus' });
    expect(r.status, r.body).toBe(400);
  });

  it('answers a POST without a JSON body with 400', async () => {
    for (const p of ['/api/search', '/api/containers/action', '/api/inspect']) {
      const r = await rawRequest(open.port, { method: 'POST', path: p, headers: { 'Content-Type': 'text/plain' }, body: 'query=x' });
      expect.soft(r.status, `${p}: ${r.body}`).toBe(400);
    }
  });

  it('answers a lens named like an Object property without a 500', async () => {
    for (const lens of ['constructor', '__proto__', 'toString']) {
      const r = await api('GET', `/api/search?q=rust&lens=${lens}`);
      expect.soft(r.status, `lens=${lens}: ${r.body}`).toBeLessThan(500);
    }
  });

  it('answers filter lists that are not arrays with 400, not 500', async () => {
    for (const config of [{ boostedDomains: 5 }, { blockedPhrases: { a: 1 } }, { blockedDomains: 7 }]) {
      const r = await api('POST', '/api/search', { query: 'rust async', config });
      expect.soft(r.status, `${JSON.stringify(config)}: ${r.body}`).toBe(400);
    }
  });

  it('answers a query holding a lone surrogate without a 500', async () => {
    const r = await rawRequest(open.port, { method: 'POST', path: '/api/search', headers: { 'Content-Type': 'application/json' }, body: '{"query":"rust \\ud800 async"}' });
    expect(r.status, r.body).toBeLessThan(500);
  });

  it('answers fractional or huge paging values in /api/deep/sites without a 500', async () => {
    quietly();
    for (const qs of ['offset=1.5', 'limit=2.5', 'offset=1e400']) {
      const r = await api('GET', `/api/deep/sites?${qs}`);
      expect.soft(r.status, qs).toBe(200);
    }
  });

  it('needs a session for /opensearch.xml too, as docs/api.md says', async () => {
    expect((await call('GET', '/opensearch.xml')).status).toBe(401);
  });

  it('stores only known integration settings', async () => {
    await api('PUT', '/api/integrations', { config: 'junk' });
    await api('PUT', '/api/integrations', { config: { notASetting: 'x' } });
    const { config } = data(await api('GET', '/api/integrations'));
    expect.soft(config).not.toHaveProperty('0');
    expect.soft(config).not.toHaveProperty('notASetting');
  });

  it('reports the address it probed in /api/nodes', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://searxng:8080');
    const { localDockerStack } = data(await api('GET', '/api/nodes'));
    expect(localDockerStack.searxng.url).toBe('http://searxng:8080');
  });
});
