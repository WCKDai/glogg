/**
 * The download manager against fixture services on 127.0.0.1: aria2's JSON-RPC,
 * Offcloud, Nextcloud's WebDAV, the local vault and plugin targets, with their
 * progress, errors and timeouts. Nothing leaves this machine, and no magnet is
 * ever handed to the operating system.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadJob } from '../src/core/index.js';
import type { AutoTargetPlugin } from '../server/downloadManager.js';
import type { DownloadHandoff, DownloadHandoffResult } from '../server/plugins/sdk.js';
import { fixtureServer, useTempGloggHome } from './helpers.js';

const savedEnv = { GLOGG_HOME: process.env.GLOGG_HOME, GLOGG_DOWNLOADS_DIR: process.env.GLOGG_DOWNLOADS_DIR };
const home = useTempGloggHome();
const vault = path.join(home, 'downloads');
const jobsFile = path.join(home, 'downloads.json');
process.env.GLOGG_DOWNLOADS_DIR = vault;

const dm = await import('../server/downloadManager.js');
const plugins = await import('../server/plugins/runtime.js');

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A service on 127.0.0.1 that records every request, body included, before it answers. */
async function service(answer: (req: Seen) => { status?: number; type?: string; body?: string }) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url || '/', 'http://x');
    const entry = { method: req.method || 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body };
    seen.push(entry);
    const a = answer(entry);
    res.writeHead(a.status ?? 200, { 'Content-Type': a.type ?? 'application/json' });
    res.end(a.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface RpcCall {
  jsonrpc: string;
  id: string;
  method: string;
  params: unknown[];
}

/** aria2's JSON-RPC: `reply` gives a method's result, or an Error that aria2 refuses the call with. */
async function aria2(reply: (method: string, params: unknown[]) => unknown) {
  const svc = await service((req) => {
    const call = JSON.parse(req.body) as RpcCall;
    const result = reply(call.method, call.params);
    return result instanceof Error
      ? { status: 400, body: JSON.stringify({ id: call.id, jsonrpc: '2.0', error: { code: 1, message: result.message } }) }
      : { body: JSON.stringify({ id: call.id, jsonrpc: '2.0', result }) };
  });
  dm.saveIntegrationConfig({ aria2RpcUrl: `${svc.url}/jsonrpc` });
  return { ...svc, calls: () => svc.seen.map((s) => JSON.parse(s.body) as RpcCall) };
}

const version = { version: '1.37.0', enabledFeatures: ['BitTorrent', 'Metalink'] };

/** Offcloud's API has a fixed address; this sends its calls to a fixture instead. */
function routeOffcloudTo(base: string) {
  const guarded = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    return guarded(url.hostname === 'offcloud.com' ? `${base}${url.pathname}${url.search}` : input, init);
  });
}

async function offcloud(answer: (req: Seen) => { status?: number; type?: string; body?: string }) {
  const svc = await service(answer);
  routeOffcloudTo(svc.url);
  return svc;
}

/** A plugin download target that lives only in these tests. */
const seedbox = {
  configured: true,
  handoffs: [] as DownloadHandoff[],
  reply: { status: 'downloading', detail: 'Queued on the seedbox' } as DownloadHandoffResult,
  polled: [] as string[],
  poll: async (_remoteId: string): Promise<Partial<DownloadHandoffResult> | null> => null,
};

let deadAria2 = '';
let savedPath: string | undefined;

beforeAll(async () => {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  deadAria2 = `http://127.0.0.1:${(s.address() as AddressInfo).port}/jsonrpc`;
  await new Promise<void>((resolve) => s.close(() => resolve()));

  await plugins.loadPlugins();
  plugins.registerPlugin({
    id: 'seedbox',
    name: 'Fixture Seedbox',
    description: 'A download target that only exists in these tests.',
    category: 'debrid',
    tools: [],
    downloadTarget: { label: 'Fixture Seedbox', accepts: ['magnet', 'nzb'] },
    isConfigured: () => seedbox.configured,
    async sendDownload(item) {
      seedbox.handoffs.push(item);
      return seedbox.reply;
    },
    pollDownload(remoteId) {
      seedbox.polled.push(remoteId);
      return seedbox.poll(remoteId);
    },
  });
});

beforeEach(() => {
  for (const f of ['integrations.json', 'downloads.json']) fs.rmSync(path.join(home, f), { force: true });
  // Every test starts with no aria2 listening, so nothing can reach a real one on this machine.
  dm.saveIntegrationConfig({ aria2RpcUrl: deadAria2, aria2RpcSecret: 'fixture-secret' });
  Object.assign(seedbox, { configured: true, handoffs: [], polled: [], reply: { status: 'downloading', detail: 'Queued on the seedbox' }, poll: async () => null });
  // A magnet that reached the local vault would run the OS's `open`; with nothing on PATH it can't.
  savedPath = process.env.PATH;
  process.env.PATH = path.join(home, 'no-bin');
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(() => {
  plugins.unregisterPlugin('seedbox');
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('choosing a target', () => {
  const withOffcloud = { offcloudApiKey: 'oc-key' };
  const withNextcloud = { nextcloudUrl: 'https://cloud.example', nextcloudUser: 'ana', nextcloudAppPassword: 'app-pass' };
  const plugin = (...accepts: AutoTargetPlugin['accepts']): AutoTargetPlugin[] => [{ id: 'plugin:seedbox', accepts }];

  it('sends magnets and torrents to Offcloud, then a plugin that takes them, then aria2, then the local vault', () => {
    for (const kind of ['magnet', 'torrent'] as const) {
      expect(dm.resolveAutoTarget(kind, withOffcloud, true, plugin(kind))).toBe('offcloud');
      expect(dm.resolveAutoTarget(kind, {}, true, plugin(kind))).toBe('plugin:seedbox');
      expect(dm.resolveAutoTarget(kind, {}, true, plugin('nzb', 'link'))).toBe('aria2-rpc');
      expect(dm.resolveAutoTarget(kind, {}, false, [])).toBe('local-vault');
    }
  });

  it('sends NZBs to a plugin that takes them, then Nextcloud, then the local vault', () => {
    expect(dm.resolveAutoTarget('nzb', { ...withNextcloud, ...withOffcloud }, true, plugin('nzb'))).toBe('plugin:seedbox');
    expect(dm.resolveAutoTarget('nzb', { ...withNextcloud, ...withOffcloud }, true, plugin('magnet'))).toBe('nextcloud');
    expect(dm.resolveAutoTarget('nzb', withOffcloud, true, [])).toBe('local-vault');
  });

  it('sends direct files to aria2, then Offcloud, then a plugin that takes links, then the local vault', () => {
    expect(dm.resolveAutoTarget('direct-file', withOffcloud, true, plugin('link'))).toBe('aria2-rpc');
    expect(dm.resolveAutoTarget('direct-file', withOffcloud, false, plugin('link'))).toBe('offcloud');
    expect(dm.resolveAutoTarget('direct-file', {}, false, plugin('link'))).toBe('plugin:seedbox');
    expect(dm.resolveAutoTarget('direct-file', withNextcloud, false, plugin('magnet'))).toBe('local-vault');
  });

  it('keeps pages on Nextcloud when it is set up, and in the local vault otherwise', () => {
    expect(dm.resolveAutoTarget('web-archive', { ...withNextcloud, ...withOffcloud }, true, plugin('link'))).toBe('nextcloud');
    expect(dm.resolveAutoTarget('web-archive', withOffcloud, true, plugin('link'))).toBe('local-vault');
  });

  it('counts Nextcloud as set up only with an address, a user and an app password', () => {
    for (const missing of ['nextcloudUrl', 'nextcloudUser', 'nextcloudAppPassword'] as const) {
      const cfg = { ...withNextcloud, [missing]: '' };
      expect(dm.resolveAutoTarget('nzb', cfg, false, [])).toBe('local-vault');
      expect(dm.resolveAutoTarget('web-archive', cfg, false, [])).toBe('local-vault');
    }
  });

  it('takes the first plugin that accepts the kind', () => {
    const two: AutoTargetPlugin[] = [
      { id: 'plugin:usenet', accepts: ['nzb'] },
      { id: 'plugin:debrid', accepts: ['nzb', 'magnet'] },
    ];
    expect(dm.resolveAutoTarget('nzb', {}, false, two)).toBe('plugin:usenet');
    expect(dm.resolveAutoTarget('magnet', {}, false, two)).toBe('plugin:debrid');
  });
});

describe('queueing to aria2', () => {
  it('checks that aria2 answers, then adds the link over JSON-RPC with the secret', async () => {
    const rpc = await aria2((method) => (method === 'aria2.addUri' ? '2089b05ecca3d829' : version));
    try {
      const url = 'https://mirror.example/debian-12.5.0-amd64-netinst.iso';
      const job = await dm.enqueueDownload({ url, title: ' Debian 12.5 netinst ', sizeFormatted: '628 MB' });
      expect(job).toEqual({
        id: expect.any(String),
        title: 'Debian 12.5 netinst',
        sourceUrl: url,
        kind: 'direct-file',
        target: 'aria2-rpc',
        status: 'downloading',
        progressPercent: 0,
        sizeFormatted: '628 MB',
        createdAt: expect.any(String),
        remoteId: '2089b05ecca3d829',
        destinationUrl: '/downloads',
        statusDetail: 'Sent to aria2',
      });
      expect(Date.now() - Date.parse(job.createdAt)).toBeLessThan(60_000);
      expect(rpc.calls().map((c) => [c.method, c.params])).toEqual([
        ['aria2.getVersion', ['token:fixture-secret']],
        ['aria2.addUri', ['token:fixture-secret', [url], {}]],
      ]);
      expect(rpc.seen.map((s) => [s.method, s.path, s.headers['content-type']])).toEqual([
        ['POST', '/jsonrpc', 'application/json'],
        ['POST', '/jsonrpc', 'application/json'],
      ]);
      const ids = rpc.calls().map((c) => c.id);
      expect(rpc.calls().every((c) => c.jsonrpc === '2.0')).toBe(true);
      expect(new Set(ids).size).toBe(2);
    } finally {
      await rpc.close();
    }
  });

  it('takes a magnet when there is no Offcloud key or plugin for it', async () => {
    seedbox.configured = false;
    const rpc = await aria2((method) => (method === 'aria2.addUri' ? 'b3a1c9d07e6f5a42' : version));
    try {
      const job = await dm.enqueueDownload({ url: MAGNET, title: 'Sintel' });
      expect(job).toMatchObject({ kind: 'magnet', target: 'aria2-rpc', status: 'downloading', remoteId: 'b3a1c9d07e6f5a42' });
      expect(rpc.calls()[1].params).toEqual(['token:fixture-secret', [MAGNET], {}]);
    } finally {
      await rpc.close();
    }
  });

  it("fails the job with aria2's own message when it refuses the call", async () => {
    const rpc = await aria2(() => new Error('Unauthorized'));
    try {
      const job = await dm.enqueueDownload({ url: 'https://mirror.example/refused.iso', target: 'aria2-rpc' });
      expect(job).toMatchObject({ target: 'aria2-rpc', status: 'failed', statusDetail: 'aria2: Unauthorized' });
      expect(job.remoteId).toBeUndefined();
    } finally {
      await rpc.close();
    }
  });

  it('fails the job when something in front of aria2 answers with an error page', async () => {
    const proxy = await service(() => ({ status: 502, type: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));
    try {
      dm.saveIntegrationConfig({ aria2RpcUrl: `${proxy.url}/jsonrpc` });
      const job = await dm.enqueueDownload({ url: 'https://mirror.example/proxied.iso', target: 'aria2-rpc' });
      expect(job).toMatchObject({ target: 'aria2-rpc', status: 'failed', progressPercent: 0 });
    } finally {
      await proxy.close();
    }
  });

  it('fails the job when aria2 is not running, and automatic routing goes around it', async () => {
    const files = await fixtureServer({ '/files/around-aria2.iso': { body: 'ISO' } });
    try {
      const refused = await dm.enqueueDownload({ url: `${files.baseUrl}/files/around-aria2.iso`, target: 'aria2-rpc' });
      expect(refused).toMatchObject({ target: 'aria2-rpc', status: 'failed', statusDetail: 'fetch failed' });
      const routed = await dm.enqueueDownload({ url: `${files.baseUrl}/files/around-aria2.iso` });
      expect(routed).toMatchObject({ target: 'local-vault', status: 'completed', destinationUrl: path.join(vault, 'around-aria2.iso') });
    } finally {
      await files.close();
    }
  });
});

describe('queueing to Offcloud', () => {
  it('submits the link as a form with the API key, and tracks the request', async () => {
    const oc = await offcloud(() => ({ body: JSON.stringify({ requestId: '6720a2b1e4b0c3d2', fileName: 'debian.torrent', site: 'BitTorrent', status: 'created' }) }));
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc/key+1234' });
      const job = await dm.enqueueDownload({ url: 'https://tracker.example/debian-12.torrent', title: 'Debian 12' });
      expect(job).toMatchObject({ kind: 'torrent', target: 'offcloud', status: 'downloading', progressPercent: 0, remoteId: '6720a2b1e4b0c3d2', statusDetail: 'Offcloud: created' });
      expect(oc.seen).toHaveLength(1);
      const [req] = oc.seen;
      expect([req.method, req.path, req.query.get('key'), req.headers['content-type']]).toEqual(['POST', '/api/cloud', 'oc/key+1234', 'application/x-www-form-urlencoded']);
      expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({ url: 'https://tracker.example/debian-12.torrent' });
    } finally {
      await oc.close();
    }
  });

  it('takes magnets first when it has a key, and marks what it already holds as cached', async () => {
    const rpc = await aria2((method) => (method === 'aria2.addUri' ? 'unused' : version));
    const oc = await offcloud(() => ({
      body: JSON.stringify({ requestId: '6720a2b1e4b0c3d3', status: 'downloaded', url: 'https://prx-1.offcloud.com/cloud/download/6720a2b1e4b0c3d3/Sintel.mkv' }),
    }));
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-1234' });
      const job = await dm.enqueueDownload({ url: MAGNET, title: 'Sintel' });
      expect(job).toMatchObject({
        kind: 'magnet',
        target: 'offcloud',
        status: 'cached-instant',
        progressPercent: 100,
        destinationUrl: 'https://prx-1.offcloud.com/cloud/download/6720a2b1e4b0c3d3/Sintel.mkv',
        statusDetail: 'Cached on Offcloud',
      });
      expect(new URLSearchParams(oc.seen[0].body).get('url')).toBe(MAGNET);
      expect(rpc.calls().map((c) => c.method)).toEqual(['aria2.getVersion']);
    } finally {
      await Promise.all([rpc.close(), oc.close()]);
    }
  });

  it('calls a request it has no status for "submitted"', async () => {
    const oc = await offcloud(() => ({ body: JSON.stringify({ requestId: '6720a2b1e4b0c3d4' }) }));
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-1234' });
      const job = await dm.enqueueDownload({ url: 'https://hoster.example/archive.zip', target: 'offcloud' });
      expect(job).toMatchObject({ status: 'downloading', progressPercent: 0, statusDetail: 'Offcloud: submitted' });
    } finally {
      await oc.close();
    }
  });

  it.each([
    ['refuses the key', 403, { error: 'Invalid API key' }, 'Offcloud: Invalid API key'],
    ['says the account cannot do it', 200, { error: 'Premium membership required' }, 'Offcloud: Premium membership required'],
    ['is overloaded', 503, {}, 'Offcloud: 503'],
  ])('fails the job, saying why, when Offcloud %s', async (_case, status, body, detail) => {
    const oc = await offcloud(() => ({ status, body: JSON.stringify(body) }));
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-1234' });
      const job = await dm.enqueueDownload({ url: MAGNET, target: 'offcloud' });
      expect(job).toMatchObject({ target: 'offcloud', status: 'failed', statusDetail: detail });
    } finally {
      await oc.close();
    }
  });

  it('fails the job when Offcloud answers with an error page', async () => {
    const oc = await offcloud(() => ({ status: 502, type: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-1234' });
      const job = await dm.enqueueDownload({ url: MAGNET, target: 'offcloud' });
      expect(job).toMatchObject({ target: 'offcloud', status: 'failed', progressPercent: 0 });
    } finally {
      await oc.close();
    }
  });
});

describe('saving to Nextcloud', () => {
  const user = 'ana@example.org';
  const dav = '/remote.php/dav/files/ana%40example.org/inbox';
  const basic = `Basic ${Buffer.from(`${user}:app-pass-0000`).toString('base64')}`;

  async function nextcloud(put: { status: number; body?: string } = { status: 201 }) {
    const svc = await service((req) => (req.method === 'PUT' ? put : { status: 201 }));
    dm.saveIntegrationConfig({ nextcloudUrl: `${svc.url}/`, nextcloudUser: user, nextcloudAppPassword: 'app-pass-0000', nextcloudFolder: 'inbox' });
    return svc;
  }

  it('fetches the file and uploads it over WebDAV into the folder, with the app password', async () => {
    const files = await fixtureServer({ '/pub/manual.pdf': { body: '%PDF-1.7 the manual', headers: { 'Content-Type': 'application/pdf' } } });
    const nc = await nextcloud();
    try {
      const job = await dm.enqueueDownload({ url: `${files.baseUrl}/pub/manual.pdf`, target: 'nextcloud' });
      expect(nc.seen.map((r) => [r.method, r.path, r.headers.authorization])).toEqual([
        ['MKCOL', dav, basic],
        ['PUT', `${dav}/manual.pdf`, basic],
      ]);
      expect(nc.seen[1].body).toBe('%PDF-1.7 the manual');
      expect(job).toMatchObject({
        kind: 'direct-file',
        target: 'nextcloud',
        status: 'completed',
        progressPercent: 100,
        destinationUrl: `${nc.url}${dav}/manual.pdf`,
        statusDetail: 'Saved to Nextcloud /inbox',
      });
    } finally {
      await Promise.all([files.close(), nc.close()]);
    }
  });

  it('writes a magnet into a .magnet file instead of fetching anything', async () => {
    const nc = await nextcloud();
    try {
      const job = await dm.enqueueDownload({ url: MAGNET, title: 'Sintel 2010', target: 'nextcloud' });
      expect(nc.seen[1]).toMatchObject({ method: 'PUT', path: `${dav}/Sintel%202010.magnet`, body: `${MAGNET}\n` });
      expect(job).toMatchObject({ kind: 'magnet', status: 'completed', destinationUrl: `${nc.url}${dav}/Sintel%202010.magnet` });
    } finally {
      await nc.close();
    }
  });

  it('takes NZBs when it is set up and no plugin wants them', async () => {
    seedbox.configured = false;
    const nzb = '<?xml version="1.0" encoding="utf-8"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"></nzb>';
    const files = await fixtureServer({ '/getnzb/4711': { body: nzb } });
    const nc = await nextcloud();
    try {
      const job = await dm.enqueueDownload({ url: `${files.baseUrl}/getnzb/4711`, title: 'Debian 12 DVD' });
      expect(job).toMatchObject({ kind: 'nzb', target: 'nextcloud', status: 'completed' });
      expect(nc.seen[1]).toMatchObject({ method: 'PUT', path: `${dav}/Debian%2012%20DVD.nzb`, body: nzb });
    } finally {
      await Promise.all([files.close(), nc.close()]);
    }
  });

  it.each([
    ['is full', 507],
    ['refuses the login', 401],
  ])('fails the job when Nextcloud %s', async (_case, status) => {
    const nc = await nextcloud({ status, body: '<d:error xmlns:d="DAV:"/>' });
    try {
      const job = await dm.enqueueDownload({ url: MAGNET, target: 'nextcloud' });
      expect(job).toMatchObject({ target: 'nextcloud', status: 'failed', statusDetail: `Nextcloud WebDAV PUT failed (${status})` });
    } finally {
      await nc.close();
    }
  });

  it('fails the job, uploading nothing, when the file cannot be fetched', async () => {
    const files = await fixtureServer({});
    const nc = await nextcloud();
    try {
      const job = await dm.enqueueDownload({ url: `${files.baseUrl}/pub/gone.pdf`, target: 'nextcloud' });
      expect(job).toMatchObject({ status: 'failed', statusDetail: 'Fetch failed (404)' });
      expect(nc.seen).toEqual([]);
    } finally {
      await Promise.all([files.close(), nc.close()]);
    }
  });

  it('fails the job when it is not set up', async () => {
    dm.saveIntegrationConfig({ nextcloudUrl: 'https://cloud.example', nextcloudUser: user });
    const job = await dm.enqueueDownload({ url: MAGNET, target: 'nextcloud' });
    expect(job).toMatchObject({ status: 'failed', statusDetail: 'Nextcloud URL / user / app password not configured' });
  });
});

describe('saving to the local vault', () => {
  it('downloads a file into the downloads folder', async () => {
    const files = await fixtureServer({ '/iso/freedos-1.4.iso': { body: 'FREEDOS IMAGE', headers: { 'Content-Type': 'application/octet-stream' } } });
    try {
      const job = await dm.enqueueDownload({ url: `${files.baseUrl}/iso/freedos-1.4.iso`, target: 'local-vault' });
      const dest = path.join(vault, 'freedos-1.4.iso');
      expect(job).toMatchObject({ kind: 'direct-file', target: 'local-vault', status: 'completed', progressPercent: 100, destinationUrl: dest, statusDetail: 'Saved locally' });
      expect(fs.readFileSync(dest, 'utf8')).toBe('FREEDOS IMAGE');
      expect(files.hits).toEqual(['GET /iso/freedos-1.4.iso']);
    } finally {
      await files.close();
    }
  });

  it('saves an NZB under its title, for a newsreader watching the folder', async () => {
    const files = await fixtureServer({ '/api': { body: '<nzb/>' } });
    try {
      const job = await dm.enqueueDownload({ url: `${files.baseUrl}/api?t=get&id=99`, title: 'FreeDOS 1.4 Live', target: 'local-vault' });
      expect(job).toMatchObject({
        kind: 'nzb',
        status: 'completed',
        destinationUrl: path.join(vault, 'FreeDOS 1.4 Live.nzb'),
        statusDetail: 'Saved .nzb — point SABnzbd/NZBGet watch folder here',
      });
      expect(fs.readFileSync(path.join(vault, 'FreeDOS 1.4 Live.nzb'), 'utf8')).toBe('<nzb/>');
    } finally {
      await files.close();
    }
  });

  it('keeps a page as HTML under its title when Nextcloud is not set up', async () => {
    const files = await fixtureServer({ '/blog/a-page-worth-keeping': { body: '<h1>Worth keeping</h1>' } });
    try {
      const job = await dm.enqueueDownload({ url: `${files.baseUrl}/blog/a-page-worth-keeping`, title: 'Worth keeping' });
      expect(job).toMatchObject({ kind: 'web-archive', target: 'local-vault', status: 'completed', destinationUrl: path.join(vault, 'Worth keeping.html') });
      expect(fs.readFileSync(path.join(vault, 'Worth keeping.html'), 'utf8')).toBe('<h1>Worth keeping</h1>');
    } finally {
      await files.close();
    }
  });

  it('fails the job, writing nothing, when the file cannot be fetched', async () => {
    const files = await fixtureServer({ '/iso/broken.iso': { status: 500, body: 'oops' } });
    try {
      const job = await dm.enqueueDownload({ url: `${files.baseUrl}/iso/broken.iso`, target: 'local-vault' });
      expect(job).toMatchObject({ target: 'local-vault', status: 'failed', statusDetail: 'Fetch failed (500)' });
      expect(fs.existsSync(path.join(vault, 'broken.iso'))).toBe(false);
    } finally {
      await files.close();
    }
  });
});

describe('plugin targets', () => {
  it('hands the link to the plugin and keeps what it answers', async () => {
    seedbox.reply = { remoteId: 'sb-42', status: 'downloading', detail: 'Fetching metadata', destinationUrl: 'https://seedbox.example/files/42', progressPercent: 12 };
    const job = await dm.enqueueDownload({ url: MAGNET, title: 'Sintel', target: 'plugin:seedbox' });
    expect(seedbox.handoffs).toEqual([{ url: MAGNET, title: 'Sintel', kind: 'magnet' }]);
    expect(job).toMatchObject({
      target: 'plugin:seedbox',
      remoteId: 'sb-42',
      status: 'downloading',
      statusDetail: 'Fetching metadata',
      destinationUrl: 'https://seedbox.example/files/42',
      progressPercent: 12,
    });
  });

  it.each([
    ['completed', 100],
    ['cached-instant', 100],
    ['downloading', 0],
  ] as const)('counts a %s hand-off that gives no progress as %i%%', async (status, percent) => {
    seedbox.reply = { status, detail: 'ok' };
    const job = await dm.enqueueDownload({ url: MAGNET, target: 'plugin:seedbox' });
    expect(job).toMatchObject({ status, progressPercent: percent });
  });

  it('gets magnets before aria2, and NZBs before Nextcloud, once it is set up', async () => {
    const rpc = await aria2(() => version);
    try {
      dm.saveIntegrationConfig({ nextcloudUrl: 'https://cloud.example', nextcloudUser: 'ana', nextcloudAppPassword: 'app-pass' });
      const magnet = await dm.enqueueDownload({ url: MAGNET });
      const nzb = await dm.enqueueDownload({ url: 'https://indexer.example/getnzb/1234.nzb', title: 'FreeDOS' });
      expect([magnet.target, nzb.target]).toEqual(['plugin:seedbox', 'plugin:seedbox']);
      expect(seedbox.handoffs.map((h) => h.kind)).toEqual(['magnet', 'nzb']);
    } finally {
      await rpc.close();
    }
  });

  it.each([
    ['a kind it does not take', 'plugin:seedbox', "Fixture Seedbox doesn't accept direct-file links"],
    ['a plugin that does not exist', 'plugin:nope', 'Plugin "nope" can\'t receive downloads'],
  ] as const)('fails the job when it goes to %s', async (_case, target, detail) => {
    const job = await dm.enqueueDownload({ url: 'https://mirror.example/freedos.iso', target });
    expect(job).toMatchObject({ target, status: 'failed', statusDetail: detail });
    expect(seedbox.handoffs).toEqual([]);
  });

  it('fails the job when the plugin is not set up', async () => {
    seedbox.configured = false;
    const job = await dm.enqueueDownload({ url: MAGNET, target: 'plugin:seedbox' });
    expect(job).toMatchObject({ status: 'failed', statusDetail: "Fixture Seedbox isn't set up yet" });
    expect(seedbox.handoffs).toEqual([]);
  });
});

describe('progress', () => {
  it("maps aria2's status onto each job: progress, speed, completion and errors", async () => {
    const status: Record<string, Record<string, unknown>> = {
      'gid-active': { status: 'active', totalLength: '2000', completedLength: '500', downloadSpeed: '204800' },
      'gid-waiting': { status: 'waiting', totalLength: '0', completedLength: '0', downloadSpeed: '0' },
      'gid-complete': { status: 'complete', totalLength: '1000', completedLength: '1000', downloadSpeed: '0' },
      'gid-error': { status: 'error', totalLength: '1000', completedLength: '10', downloadSpeed: '0', errorMessage: 'No space left on device' },
      'gid-removed': { status: 'removed', totalLength: '1000', completedLength: '0', downloadSpeed: '0' },
    };
    const rpc = await aria2((method, params) => {
      if (method === 'aria2.addUri') return `gid-${path.basename(new URL((params[1] as string[])[0]).pathname, '.iso')}`;
      if (method === 'aria2.tellStatus') return status[params[1] as string];
      return version;
    });
    try {
      for (const gid of Object.keys(status)) await dm.enqueueDownload({ url: `https://mirror.example/${gid.slice(4)}.iso`, target: 'aria2-rpc' });
      const jobs = await dm.refreshDownloads();
      const byGid = Object.fromEntries(jobs.map((j) => [j.remoteId, j]));
      expect(byGid['gid-active']).toMatchObject({ status: 'downloading', progressPercent: 25, statusDetail: 'active · 200 KB/s' });
      expect(byGid['gid-waiting']).toMatchObject({ status: 'downloading', progressPercent: 0, statusDetail: 'waiting · 0 KB/s' });
      expect(byGid['gid-complete']).toMatchObject({ status: 'completed', progressPercent: 100, statusDetail: 'Done' });
      expect(byGid['gid-error']).toMatchObject({ status: 'failed', progressPercent: 1, statusDetail: 'No space left on device' });
      expect(byGid['gid-removed']).toMatchObject({ status: 'failed', progressPercent: 0, statusDetail: 'removed' });

      const tell = rpc.calls().filter((c) => c.method === 'aria2.tellStatus');
      expect(tell.map((c) => c.params[1])).toEqual(['gid-removed', 'gid-error', 'gid-complete', 'gid-waiting', 'gid-active']);
      expect(tell[0].params).toEqual(['token:fixture-secret', 'gid-removed', ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'followedBy', 'errorMessage']]);
      expect(dm.removeDownload('no-such-job')).toEqual(jobs);
    } finally {
      await rpc.close();
    }
  });

  it('follows a magnet from its metadata download to the download it starts', async () => {
    const rpc = await aria2((method, params) => {
      if (method === 'aria2.addUri') return 'gid-metadata';
      if (method !== 'aria2.tellStatus') return version;
      return params[1] === 'gid-metadata'
        ? { status: 'complete', totalLength: '16384', completedLength: '16384', downloadSpeed: '0', followedBy: ['gid-content'] }
        : { status: 'active', totalLength: '4000', completedLength: '1000', downloadSpeed: '1048576' };
    });
    try {
      const job = await dm.enqueueDownload({ url: MAGNET, title: 'Sintel', target: 'aria2-rpc' });
      const [first] = await dm.refreshDownloads();
      // The metadata's 100% isn't the film's.
      expect(first).toMatchObject({ id: job.id, remoteId: 'gid-content', status: 'downloading', progressPercent: 0, statusDetail: 'Starting' });
      const [second] = await dm.refreshDownloads();
      expect(second).toMatchObject({ id: job.id, remoteId: 'gid-content', status: 'downloading', progressPercent: 25, statusDetail: 'active · 1024 KB/s' });
      expect(rpc.calls().filter((c) => c.method === 'aria2.tellStatus').map((c) => c.params[1])).toEqual(['gid-metadata', 'gid-content']);
    } finally {
      await rpc.close();
    }
  });

  it('keeps a job as it was while aria2 cannot be reached', async () => {
    const rpc = await aria2((method) => (method === 'aria2.addUri' ? 'gid-1' : version));
    const job = await dm.enqueueDownload({ url: 'https://mirror.example/later.iso', target: 'aria2-rpc' });
    await rpc.close();
    expect(await dm.refreshDownloads()).toEqual([job]);
  });

  it('asks Offcloud about all of its jobs in one call, and maps each answer', async () => {
    let n = 0;
    const oc = await offcloud((req) =>
      req.path === '/api/cloud'
        ? { body: JSON.stringify({ requestId: `req-${++n}`, status: 'created' }) }
        : {
            body: JSON.stringify({
              requests: [
                { requestId: 'req-1', status: 'downloaded', url: 'https://prx-1.offcloud.com/cloud/download/req-1/file-1.zip', fileSize: 1000 },
                { requestId: 'req-2', status: 'error' },
                { requestId: 'req-3', status: 'canceled' },
                { requestId: 'req-4', status: 'downloading' },
                { requestId: 'req-5' },
              ],
            }),
          }
    );
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-5678' });
      for (let i = 1; i <= 6; i++) await dm.enqueueDownload({ url: `https://hoster.example/file-${i}.zip`, target: 'offcloud' });
      const byRequest = Object.fromEntries((await dm.refreshDownloads()).map((j) => [j.remoteId, j]));
      expect(byRequest['req-1']).toMatchObject({ status: 'completed', progressPercent: 100, destinationUrl: 'https://prx-1.offcloud.com/cloud/download/req-1/file-1.zip', statusDetail: 'Ready on Offcloud' });
      expect(byRequest['req-2']).toMatchObject({ status: 'failed', statusDetail: 'Offcloud: error' });
      expect(byRequest['req-3']).toMatchObject({ status: 'failed', statusDetail: 'Offcloud: canceled' });
      expect(byRequest['req-4']).toMatchObject({ status: 'downloading', statusDetail: 'Offcloud: downloading' });
      expect(byRequest['req-5']).toMatchObject({ status: 'downloading', statusDetail: 'Offcloud: processing' });
      expect(byRequest['req-6']).toMatchObject({ status: 'downloading', statusDetail: 'Offcloud: created' });

      const polls = oc.seen.filter((r) => r.path === '/api/cloud/status');
      expect(polls).toHaveLength(1);
      expect([polls[0].method, polls[0].query.get('key'), polls[0].headers['content-type']]).toEqual(['POST', 'oc-key-5678', 'application/json']);
      expect(JSON.parse(polls[0].body)).toEqual({ requestIds: ['req-6', 'req-5', 'req-4', 'req-3', 'req-2', 'req-1'] });
    } finally {
      await oc.close();
    }
  });

  it('leaves Offcloud jobs as they were when its status call fails', async () => {
    const oc = await offcloud((req) =>
      req.path === '/api/cloud' ? { body: JSON.stringify({ requestId: 'req-1', status: 'created' }) } : { status: 500, type: 'text/html', body: '<h1>Internal Server Error</h1>' }
    );
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-5678' });
      const job = await dm.enqueueDownload({ url: MAGNET, target: 'offcloud' });
      expect(await dm.refreshDownloads()).toEqual([job]);
      expect(oc.seen.map((r) => r.path)).toEqual(['/api/cloud', '/api/cloud/status']);
    } finally {
      await oc.close();
    }
  });

  it('asks a plugin about its jobs, and keeps a job as it was when the plugin cannot say', async () => {
    seedbox.reply = { remoteId: 'sb-1', status: 'downloading', detail: 'Queued', progressPercent: 0 };
    const first = await dm.enqueueDownload({ url: MAGNET, target: 'plugin:seedbox' });
    seedbox.reply = { remoteId: 'sb-2', status: 'downloading', detail: 'Queued', progressPercent: 0 };
    const second = await dm.enqueueDownload({ url: `${MAGNET}2`, target: 'plugin:seedbox' });
    seedbox.poll = async (id) => {
      if (id === 'sb-2') throw new Error('seedbox offline');
      return { status: 'completed', detail: 'Seeding', progressPercent: 100, destinationUrl: 'https://seedbox.example/files/1' };
    };
    const jobs = await dm.refreshDownloads();
    expect(seedbox.polled).toEqual(['sb-2', 'sb-1']);
    expect(jobs.find((j) => j.id === first.id)).toMatchObject({ status: 'completed', statusDetail: 'Seeding', progressPercent: 100, destinationUrl: 'https://seedbox.example/files/1' });
    expect(jobs.find((j) => j.id === second.id)).toEqual(second);
  });

  it('asks nothing when no job is in flight', async () => {
    const oc = await offcloud(() => ({ body: '{}' }));
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-5678' });
      seedbox.reply = { remoteId: 'sb-1', status: 'completed', detail: 'Done' };
      const job = await dm.enqueueDownload({ url: MAGNET, target: 'plugin:seedbox' });
      expect(await dm.refreshDownloads()).toEqual([job]);
      expect(oc.seen).toEqual([]);
      expect(seedbox.polled).toEqual([]);
    } finally {
      await oc.close();
    }
  });
});

describe('the report', () => {
  it('lists the jobs, every plugin target, masked settings and which services are up', async () => {
    const rpc = await aria2(() => version);
    try {
      dm.saveIntegrationConfig({
        offcloudApiKey: 'oc-key-9012',
        nzbLifeApiKey: 'nzb-key-3456',
        nextcloudUrl: 'https://cloud.example',
        nextcloudUser: 'ana',
        nextcloudAppPassword: 'app-pass-7890',
      });
      seedbox.reply = { remoteId: 'sb-1', status: 'completed', detail: 'Done' };
      const job = await dm.enqueueDownload({ url: MAGNET, target: 'plugin:seedbox' });
      const report = await dm.getDownloadManagerReport();
      expect(report.integrations).toEqual({ offcloudConfigured: true, nzbLifeConfigured: true, nextcloudConfigured: true, aria2Reachable: true, localDownloadsDir: vault });
      expect(report.config).toMatchObject({ offcloudApiKey: '••••9012', nzbLifeApiKey: '••••3456', nextcloudAppPassword: '••••7890', nextcloudUser: 'ana' });
      expect(JSON.stringify(report)).not.toMatch(/oc-key|nzb-key|app-pass|fixture-secret/);
      expect(Object.fromEntries((report.pluginTargets ?? []).map((t) => [t.id, t.configured]))).toEqual({
        'plugin:pcloud': false,
        'plugin:realdebrid': false,
        'plugin:sabnzbd': false,
        'plugin:seedbox': true,
        'plugin:torbox': false,
      });
      expect(report.pluginTargets?.find((t) => t.id === 'plugin:seedbox')).toEqual({ id: 'plugin:seedbox', pluginId: 'seedbox', label: 'Fixture Seedbox', accepts: ['magnet', 'nzb'], configured: true });
      expect(report.jobs).toEqual([job]);
    } finally {
      await rpc.close();
    }
  });

  it('says what is missing when nothing is set up', async () => {
    const report = await dm.getDownloadManagerReport();
    expect(report.integrations).toEqual({ offcloudConfigured: false, nzbLifeConfigured: false, nextcloudConfigured: false, aria2Reachable: false, localDownloadsDir: vault });
    expect(report.jobs).toEqual([]);
  });
});

describe('removing jobs', () => {
  async function oneJobInEachState() {
    const jobs: DownloadJob[] = [];
    for (const status of ['queued', 'downloading', 'completed', 'cached-instant'] as const) {
      seedbox.reply = { remoteId: `sb-${status}`, status, detail: status };
      jobs.push(await dm.enqueueDownload({ url: `${MAGNET}-${status}`, title: status, target: 'plugin:seedbox' }));
    }
    jobs.push(await dm.enqueueDownload({ url: MAGNET, title: 'failed', target: 'nextcloud' }));
    return jobs.reverse();
  }

  it('removes one job by its id, keeping the rest in order', async () => {
    const [failed, cached, completed, downloading, queued] = await oneJobInEachState();
    expect(dm.removeDownload(completed.id)).toEqual([failed, cached, downloading, queued]);
    expect(dm.removeDownload('no-such-job')).toEqual([failed, cached, downloading, queued]);
  });

  it('clears finished and failed jobs, keeping those still in flight', async () => {
    const [, , , downloading, queued] = await oneJobInEachState();
    expect(dm.clearFinishedDownloads()).toEqual([downloading, queued]);
    expect(dm.removeDownload('no-such-job')).toEqual([downloading, queued]);
  });
});

describe('the job list on disk', () => {
  it('survives a restart, with the settings, and only this user can read it', async () => {
    dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-1111', nextcloudFolder: 'kept' });
    seedbox.reply = { remoteId: 'sb-9', status: 'completed', detail: 'Done' };
    const done = await dm.enqueueDownload({ url: MAGNET, title: 'Sintel', target: 'plugin:seedbox' });
    const failed = await dm.enqueueDownload({ url: 'https://mirror.example/x.iso', target: 'nextcloud' });

    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../server/downloadManager.ts')).href;
    const restarted = (await import(/* @vite-ignore */ `${moduleUrl}?restart=${Date.now()}`)) as typeof dm;
    expect(restarted).not.toBe(dm);
    expect(await restarted.refreshDownloads()).toEqual([failed, done]);
    expect(restarted.loadIntegrationConfig()).toMatchObject({ offcloudApiKey: 'oc-key-1111', nextcloudFolder: 'kept' });
    expect(fs.statSync(jobsFile).mode & 0o777).toBe(0o600);
  });

  it('puts the newest job first and keeps the latest 200', async () => {
    const older: DownloadJob[] = Array.from({ length: 200 }, (_, i) => ({
      id: `old-${i}`,
      title: `Old ${i}`,
      sourceUrl: `https://mirror.example/${i}.iso`,
      kind: 'direct-file',
      target: 'local-vault',
      status: 'completed',
      progressPercent: 100,
      createdAt: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
      statusDetail: 'Saved locally',
    }));
    fs.writeFileSync(jobsFile, JSON.stringify(older));
    seedbox.reply = { remoteId: 'sb-new', status: 'completed', detail: 'Done' };
    const job = await dm.enqueueDownload({ url: MAGNET, target: 'plugin:seedbox' });
    const jobs = dm.removeDownload('no-such-job');
    expect(jobs).toHaveLength(200);
    expect(jobs[0]).toEqual(job);
    expect(jobs.slice(1).map((j) => j.id)).toEqual(older.slice(0, 199).map((j) => j.id));
  });

  it('starts afresh when the saved list is unreadable', async () => {
    fs.writeFileSync(jobsFile, '[{"id": "half a job"');
    expect(await dm.refreshDownloads()).toEqual([]);
    seedbox.reply = { remoteId: 'sb-1', status: 'completed', detail: 'Done' };
    const job = await dm.enqueueDownload({ url: MAGNET, target: 'plugin:seedbox' });
    expect(JSON.parse(fs.readFileSync(jobsFile, 'utf8'))).toEqual([job]);
  });
});

describe('timeouts', () => {
  /** fetch that never answers until its request is aborted; `refuse` makes a request fail at once instead. */
  function silentNetwork(refuse: (url: URL) => boolean = () => false) {
    const requests: { url: URL; signal: AbortSignal }[] = [];
    const waiting: [number, () => void][] = [];
    vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}) => {
      const signal = init.signal as AbortSignal;
      requests.push({ url: new URL(String(input)), signal });
      for (const [n, resolve] of waiting) if (requests.length >= n) resolve();
      if (refuse(new URL(String(input)))) return Promise.reject(new TypeError('fetch failed'));
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    });
    return {
      requests,
      reached: (n: number) => new Promise<void>((resolve) => (requests.length >= n ? resolve() : waiting.push([n, resolve]))),
    };
  }

  it('gives aria2 three seconds a call, then fails the job', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const net = silentNetwork();
    const pending = dm.enqueueDownload({ url: 'https://mirror.example/slow.iso', target: 'aria2-rpc' });
    await net.reached(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(net.requests[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await net.reached(2);
    expect(net.requests[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ target: 'aria2-rpc', status: 'failed', statusDetail: 'This operation was aborted' });
    expect(net.requests.map((r) => r.url.href)).toEqual([deadAria2, deadAria2]);
  });

  it('gives Offcloud twelve seconds, then fails the job', async () => {
    dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-1234' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const net = silentNetwork((url) => url.hostname === '127.0.0.1');
    const pending = dm.enqueueDownload({ url: MAGNET, target: 'offcloud' });
    await net.reached(2);
    expect(net.requests[1].url.hostname).toBe('offcloud.com');
    await vi.advanceTimersByTimeAsync(11_999);
    expect(net.requests[1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ target: 'offcloud', status: 'failed', statusDetail: 'This operation was aborted' });
  });

  it('keeps a job as it was when its progress poll times out', async () => {
    const rpc = await aria2((method) => (method === 'aria2.addUri' ? 'gid-slow' : version));
    const job = await dm.enqueueDownload({ url: 'https://mirror.example/slow.iso', target: 'aria2-rpc' });
    await rpc.close();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const net = silentNetwork();
    const pending = dm.refreshDownloads();
    await net.reached(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual([job]);
    expect(net.requests[0].signal.aborted).toBe(true);
  });
});

describe('found by these tests, and fixed', () => {
  it('names the HTTP status when Offcloud answers with an error page', async () => {
    const oc = await offcloud(() => ({ status: 502, type: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));
    try {
      dm.saveIntegrationConfig({ offcloudApiKey: 'oc-key-1234' });
      const job = await dm.enqueueDownload({ url: MAGNET, target: 'offcloud' });
      expect(job.statusDetail).toBe('Offcloud: 502');
    } finally {
      await oc.close();
    }
  });

  it('says aria2 failed, with the status, when something in front of it answers with an error page', async () => {
    const proxy = await service(() => ({ status: 502, type: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));
    try {
      dm.saveIntegrationConfig({ aria2RpcUrl: `${proxy.url}/jsonrpc` });
      const job = await dm.enqueueDownload({ url: 'https://mirror.example/proxied.iso', target: 'aria2-rpc' });
      expect(job.statusDetail).toMatch(/^aria2: .*502/);
    } finally {
      await proxy.close();
    }
  });
});
