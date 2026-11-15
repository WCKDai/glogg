import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomEndpointsConfig } from '../src/core/index.js';
import type { PluginContext, PluginDefinition } from '../server/plugins/sdk.js';
import sabnzbd from '../plugins/sabnzbd/index.js';
import pcloud from '../plugins/pcloud/index.js';
import nextcloud from '../plugins/nextcloud/index.js';
import offcloud from '../plugins/offcloud/index.js';
import realdebrid from '../plugins/realdebrid/index.js';
import torbox from '../plugins/torbox/index.js';
import osint, { USERNAME_SITES } from '../plugins/osint/index.js';
import webtest, { fingerprintTech, gradeSecurityHeaders } from '../plugins/webtest/index.js';
import { distribution, loadOptions } from '../scripts/load-test.js';
import {
  describeError,
  getPlugin,
  listPlugins,
  maskPluginSettings,
  registerPlugin,
  savePluginSettings,
  unregisterPlugin,
  validateDefinition,
} from '../server/plugins/runtime.js';

type RouteResponder = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function makeCtx(
  responder: RouteResponder,
  settings: Record<string, string> = {},
  integrations: CustomEndpointsConfig = {}
): PluginContext {
  const fetchFn: PluginContext['fetch'] = async (urlStr, init) => responder(new URL(urlStr), init);
  return {
    settings,
    integrations,
    signal: new AbortController().signal,
    fetch: fetchFn,
    async fetchJson<T = unknown>(urlStr: string, init?: RequestInit): Promise<T> {
      const res = await fetchFn(urlStr, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    },
    saveSetting(k, v) {
      settings[k] = v;
    },
  };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const toolOf = (plugin: PluginDefinition, id: string) => {
  const found = plugin.tools.find((t) => t.id === id);
  if (!found) throw new Error(`Missing tool ${plugin.id}/${id}`);
  return found;
};

describe('built-in storage, Usenet, and debrid plugins (sabnzbd, pcloud, nextcloud, offcloud, realdebrid, torbox)', () => {
  it('exercises SABnzbd queue, add, history, sendDownload, pollDownload, and API errors', async () => {
    let inQueue = true;
    const ctx = makeCtx(
      (u) => {
        const mode = u.searchParams.get('mode');
        if (u.searchParams.get('apikey') === 'bad') return jsonRes({ status: false, error: 'API Key Incorrect' });
        if (mode === 'queue') {
          return jsonRes({
            queue: {
              speed: '42M',
              sizeleft: '1.2 GB',
              timeleft: '0:00:30',
              slots: inQueue
                ? [{ nzo_id: 'nzo_1', filename: 'Linux.ISO', percentage: '55', mb: '700', status: 'Downloading', timeleft: '0:00:30' }]
                : [],
            },
          });
        }
        if (mode === 'addurl') return jsonRes({ status: true, nzo_ids: ['nzo_1'] });
        if (mode === 'history') {
          return jsonRes({
            history: {
              slots: [
                { nzo_id: 'nzo_1', name: 'Linux.ISO', status: 'Completed', size: '700 MB', completed: 1_700_000_000 },
                { nzo_id: 'nzo_fail', name: 'Broken.NZB', status: 'Failed', size: '10 MB', completed: 1_700_000_100, fail_message: 'CRC error' },
              ],
            },
          });
        }
        return jsonRes({});
      },
      { url: 'http://sab.local:8085/', apiKey: 'sab-secret' }
    );

    const q = await toolOf(sabnzbd, 'queue').run({}, ctx);
    expect(q.summary).toContain('1 in queue');
    const added = await toolOf(sabnzbd, 'add').run({ url: 'https://idx.example/test.nzb' }, ctx);
    expect(added.blocks[0]).toMatchObject({ type: 'notice', tone: 'ok' });
    const hist = await toolOf(sabnzbd, 'history').run({}, ctx);
    expect(hist.blocks[0].type).toBe('list');

    const sent = await sabnzbd.sendDownload!({ url: 'https://idx.example/a.nzb', title: 'Arch', kind: 'nzb' }, ctx);
    expect(sent).toMatchObject({ remoteId: 'nzo_1', status: 'downloading' });
    expect(await sabnzbd.pollDownload!('nzo_1', ctx)).toMatchObject({ status: 'downloading', progressPercent: 55 });
    inQueue = false;
    expect(await sabnzbd.pollDownload!('nzo_1', ctx)).toMatchObject({ status: 'completed', progressPercent: 100 });
    expect(await sabnzbd.pollDownload!('nzo_fail', ctx)).toMatchObject({ status: 'failed', detail: 'SABnzbd: CRC error' });
    expect(await sabnzbd.pollDownload!('nzo_unknown', ctx)).toBeNull();

    const badCtx = makeCtx(() => jsonRes({ status: false, error: 'API Key Incorrect' }), { apiKey: 'bad' });
    await expect(toolOf(sabnzbd, 'queue').run({}, badCtx)).rejects.toThrow(/API Key Incorrect/);
  });

  it('exercises pCloud US/EU regions, account, browse, direct link, remote upload, and sendDownload', async () => {
    const seenHosts: string[] = [];
    const ctx = makeCtx(
      (u) => {
        seenHosts.push(u.hostname);
        if (u.pathname === '/userinfo') {
          return jsonRes({ result: 0, email: 'ada@example.com', quota: 1000, usedquota: 800, premium: true });
        }
        if (u.pathname === '/listfolder') {
          return jsonRes({
            result: 0,
            metadata: {
              name: '/',
              isfolder: true,
              contents: [
                { name: 'docs', isfolder: true, folderid: 10 },
                { name: 'notes.txt', isfolder: false, fileid: 99, size: 2048, modified: 'Mon, 01 Jan 2026 12:00:00 +0000' },
              ],
            },
          });
        }
        if (u.pathname === '/getfilelink') {
          return jsonRes({ result: 0, hosts: ['cdn.pcloud.example'], path: '/dl/notes.txt' });
        }
        if (u.pathname === '/createfolderifnotexists') {
          return jsonRes({ result: 0, metadata: { name: 'glogg', isfolder: true, folderid: 42 } });
        }
        if (u.pathname === '/downloadfile') {
          return jsonRes({ result: 0, metadata: [{ name: 'iso.img', isfolder: false, size: 4096 }] });
        }
        return jsonRes({ result: 2000, error: 'Log in required' });
      },
      { token: 'pc-tok', region: 'eu', folder: '/glogg' }
    );

    const acc = await toolOf(pcloud, 'account').run({}, ctx);
    expect(seenHosts[0]).toBe('eapi.pcloud.com');
    expect(acc.summary).toContain('800 B');

    const browse = await toolOf(pcloud, 'browse').run({ path: '/' }, ctx);
    expect(browse.summary).toContain('2 items');

    const link = await toolOf(pcloud, 'link').run({ fileid: '99' }, ctx);
    expect(JSON.stringify(link.blocks)).toContain('https://cdn.pcloud.example/dl/notes.txt');

    const up = await toolOf(pcloud, 'upload').run({ url: 'https://example.com/iso.img', path: '/' }, ctx);
    expect(up.summary).toBe('Uploaded 1 file(s)');

    const dl = await pcloud.sendDownload!({ url: 'https://example.com/iso.img', title: 'iso.img', kind: 'direct-file' }, ctx);
    expect(dl.status).toBe('completed');

    const errCtx = makeCtx(() => jsonRes({ result: 2000, error: 'Invalid token' }), { token: 'bad' });
    await expect(toolOf(pcloud, 'account').run({}, errCtx)).rejects.toThrow(/Invalid token/);
  });

  it('exercises Nextcloud WebDAV browse, quota, OCS share link, and credential validation', async () => {
    const davXml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
        <d:response><d:href>/remote.php/dav/files/ada/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:quota-used-bytes>1048576</d:quota-used-bytes><d:quota-available-bytes>536870912</d:quota-available-bytes></d:prop></d:propstat></d:response>
        <d:response><d:href>/remote.php/dav/files/ada/Photos/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><oc:size>4096</oc:size></d:prop></d:propstat></d:response>
        <d:response><d:href>/remote.php/dav/files/ada/readme.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>512</d:getcontentlength><d:getlastmodified>Wed, 15 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
      </d:multistatus>`;

    const ctx = makeCtx(
      (u, init) => {
        if (init?.method === 'PROPFIND') {
          return new Response(davXml, { status: 207, headers: { 'Content-Type': 'application/xml' } });
        }
        if (u.pathname.includes('/shares')) {
          return jsonRes({ ocs: { data: { url: 'https://nc.example/s/abc123' } } });
        }
        return new Response('Not found', { status: 404 });
      },
      {},
      { nextcloudUrl: 'https://nc.example/', nextcloudUser: 'ada', nextcloudAppPassword: 'app-pass' }
    );

    expect(nextcloud.isConfigured!(ctx)).toBe(true);
    const browsed = await toolOf(nextcloud, 'browse').run({ path: '/' }, ctx);
    expect(browsed.summary).toBe('2 items');

    const quota = await toolOf(nextcloud, 'quota').run({}, ctx);
    expect(JSON.stringify(quota.blocks)).toContain('warn');

    const shared = await toolOf(nextcloud, 'share').run({ path: '/readme.md', password: 'secret' }, ctx);
    expect(shared.summary).toBe('https://nc.example/s/abc123');

    const unauthCtx = makeCtx(
      () => new Response('Unauthorized', { status: 401 }),
      {},
      { nextcloudUrl: 'https://nc.example', nextcloudUser: 'ada', nextcloudAppPassword: 'wrong' }
    );
    await expect(toolOf(nextcloud, 'quota').run({}, unauthCtx)).rejects.toThrow(/rejected the credentials/);
  });

  it('exercises Offcloud cloud add, instant cache check, and history', async () => {
    const hash = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
    const ctx = makeCtx(
      (u) => {
        if (u.pathname === '/api/cloud') {
          return jsonRes({ requestId: 'req1', status: 'downloaded', fileName: 'debian.iso', url: 'https://offcloud.example/dl/debian.iso' });
        }
        if (u.pathname === '/api/cache') {
          return jsonRes({ cachedItems: [hash] });
        }
        if (u.pathname === '/api/cloud/history') {
          return jsonRes([{ requestId: 'req1', fileName: 'debian.iso', status: 'downloaded', fileSize: 1024, createdOn: '2026-11-15T00:00:00Z' }]);
        }
        return jsonRes({});
      },
      {},
      { offcloudApiKey: 'oc-key' }
    );

    expect(offcloud.isConfigured!(ctx)).toBe(true);
    const added = await toolOf(offcloud, 'add').run({ url: `magnet:?xt=urn:btih:${hash}` }, ctx);
    expect(added.summary).toBe('Offcloud: downloaded');

    const cache = await toolOf(offcloud, 'cache').run({ hashes: `magnet:?xt=urn:btih:${hash}\n1111111111111111111111111111111111111111` }, ctx);
    expect(cache.summary).toBe('1/2 cached');

    const hist = await toolOf(offcloud, 'history').run({}, ctx);
    expect(hist.summary).toBe('1 items');

    await expect(toolOf(offcloud, 'cache').run({ hashes: 'not-a-hash' }, ctx)).rejects.toThrow(/No valid info hashes/);
  });

  it('exercises Real-Debrid account, magnet/hoster add, torrents, downloads, sendDownload, and pollDownload', async () => {
    let torrentStatus = 'downloading';
    const ctx = makeCtx(
      (u, init) => {
        const p = u.pathname.replace('/rest/1.0', '');
        if (p === '/user') {
          return jsonRes({ username: 'ada', email: 'ada@example.com', type: 'premium', expiration: '2027-01-01T00:00:00Z', points: 420, premium: 86400 * 30 });
        }
        if (p === '/torrents/addMagnet' || p === '/torrents/addTorrent') return jsonRes({ id: 'rd_1' });
        if (p.startsWith('/torrents/selectFiles/')) return new Response(null, { status: 204 });
        if (p === '/torrents/info/rd_1') {
          return jsonRes({ id: 'rd_1', filename: 'Ubuntu.iso', bytes: 2048, progress: 80, status: torrentStatus, added: '2026-11-15T00:00:00Z', links: ['https://hoster/1'], hash: 'abc' });
        }
        if (p === '/unrestrict/link') {
          return jsonRes({ filename: 'Ubuntu.iso', filesize: 2048, download: 'https://rd-cdn.example/Ubuntu.iso' });
        }
        if (p === '/torrents') {
          return jsonRes([{ id: 'rd_1', filename: 'Ubuntu.iso', bytes: 2048, progress: 80, status: 'downloading', added: '2026-11-15T00:00:00Z', links: ['https://hoster/1'], hash: 'abc' }]);
        }
        if (p === '/downloads') {
          return jsonRes([{ filename: 'Ubuntu.iso', filesize: 2048, download: 'https://rd-cdn.example/Ubuntu.iso', generated: '2026-11-15T00:00:00Z', host: 'rd' }]);
        }
        if (u.hostname === 'torrents.example') {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        return jsonRes({ error: `Unexpected ${p} ${init?.method}` }, 400);
      },
      { apiToken: 'rd-tok' }
    );

    expect((await toolOf(realdebrid, 'account').run({}, ctx)).summary).toContain('ada · premium');
    expect((await toolOf(realdebrid, 'add').run({ link: 'magnet:?xt=urn:btih:abc https://hoster.example/f' }, ctx)).summary).toBe('Added 2');
    expect((await toolOf(realdebrid, 'torrents').run({}, ctx)).summary).toBe('1 torrents');
    expect((await toolOf(realdebrid, 'downloads').run({}, ctx)).blocks[0].type).toBe('list');

    expect(await realdebrid.sendDownload!({ url: 'magnet:?xt=urn:btih:abc', title: 'Ubuntu', kind: 'magnet' }, ctx)).toMatchObject({ remoteId: 'rd_1', status: 'downloading' });
    expect(await realdebrid.sendDownload!({ url: 'https://torrents.example/u.torrent', title: 'Ubuntu', kind: 'torrent' }, ctx)).toMatchObject({ remoteId: 'rd_1' });
    expect(await realdebrid.sendDownload!({ url: 'https://hoster.example/u.zip', title: 'Ubuntu', kind: 'direct-file' }, ctx)).toMatchObject({ status: 'completed' });

    expect(await realdebrid.pollDownload!('rd_1', ctx)).toMatchObject({ status: 'downloading', progressPercent: 80 });
    torrentStatus = 'downloaded';
    expect(await realdebrid.pollDownload!('rd_1', ctx)).toMatchObject({ status: 'completed', progressPercent: 100 });
    torrentStatus = 'dead';
    expect(await realdebrid.pollDownload!('rd_1', ctx)).toMatchObject({ status: 'failed' });
  });

  it('exercises TorBox account, add, cache check, list, download link, sendDownload, and pollDownload', async () => {
    let finished = false;
    let state = 'downloading';
    const ctx = makeCtx(
      (u) => {
        const p = u.pathname.replace('/v1/api', '');
        if (p === '/user/me') return jsonRes({ success: true, data: { email: 'ada@example.com', plan: 2, premium_expires_at: '2027-01-01T00:00:00Z', total_downloaded: 12 } });
        if (p === '/torrents/createtorrent') return jsonRes({ success: true, data: { torrent_id: 11, hash: 'abc' } });
        if (p === '/usenet/createusenetdownload') return jsonRes({ success: true, data: { usenetdownload_id: 22 } });
        if (p === '/webdl/createwebdownload') return jsonRes({ success: true, data: { webdownload_id: 33 } });
        if (p === '/torrents/checkcached') {
          const h = u.searchParams.get('hash') || '';
          return jsonRes({ success: true, data: h.startsWith('c12f') ? [{ name: 'Debian.iso', size: 1024, hash: h }] : [] });
        }
        if (p.endsWith('/mylist')) {
          if (u.searchParams.get('id')) {
            return jsonRes({ success: true, data: { id: 11, name: 'Debian.iso', size: 1024, progress: 0.5, download_state: state, download_finished: finished, created_at: '2026-11-15T00:00:00Z' } });
          }
          return jsonRes({
            success: true,
            data: [{ id: 11, name: 'Debian.iso', size: 1024, progress: 1, download_state: 'completed', download_finished: true, created_at: '2026-11-15T00:00:00Z' }],
          });
        }
        if (p.endsWith('/requestdl')) return jsonRes({ success: true, data: 'https://tb-cdn.example/dl.zip' });
        if (u.hostname === 'files.example') return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
        return jsonRes({ success: false, detail: 'bad request' }, 400);
      },
      { apiKey: 'tb-key' }
    );

    expect((await toolOf(torbox, 'account').run({}, ctx)).blocks[0].type).toBe('stat');
    expect((await toolOf(torbox, 'add').run({ link: 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a' }, ctx)).summary).toBe('TorBox: torrent added');
    expect((await toolOf(torbox, 'cached').run({ hash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a' }, ctx)).blocks[0]).toMatchObject({ tone: 'ok' });
    expect((await toolOf(torbox, 'cached').run({ hash: '0000000000000000000000000000000000000000' }, ctx)).blocks[0]).toMatchObject({ tone: 'warn' });
    expect((await toolOf(torbox, 'list').run({}, ctx)).summary).toBe('3 items');
    expect(JSON.stringify((await toolOf(torbox, 'link').run({ id: '11', kind: 'torrent' }, ctx)).blocks)).toContain('https://tb-cdn.example/dl.zip');

    expect(await torbox.sendDownload!({ url: 'https://files.example/a.torrent', title: 'A', kind: 'torrent' }, ctx)).toMatchObject({ remoteId: 'torrent:11' });
    expect(await torbox.sendDownload!({ url: 'https://files.example/a.nzb', title: 'A', kind: 'nzb' }, ctx)).toMatchObject({ remoteId: 'usenet:22' });
    expect(await torbox.sendDownload!({ url: 'https://files.example/a.iso', title: 'A', kind: 'direct-file' }, ctx)).toMatchObject({ remoteId: 'webdl:33' });

    expect(await torbox.pollDownload!('torrent:11', ctx)).toMatchObject({ status: 'downloading', progressPercent: 50 });
    state = 'error';
    expect(await torbox.pollDownload!('torrent:11', ctx)).toMatchObject({ status: 'failed' });
    finished = true;
    expect(await torbox.pollDownload!('torrent:11', ctx)).toMatchObject({ status: 'completed', progressPercent: 100 });
  });
});

describe('built-in OSINT and website testing plugins (osint, webtest)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exercises OSINT dns, whois (domain & IP), subdomains, ip intel, username footprint, wayback, reverse image, and dorks', async () => {
    vi.spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns, 'resolve6').mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']);
    vi.spyOn(dns, 'resolveCname').mockResolvedValue(['cdn.example.com']);
    vi.spyOn(dns, 'resolveMx').mockResolvedValue([
      { exchange: 'mx2.example.com', priority: 20 },
      { exchange: 'mx1.example.com', priority: 10 },
    ]);
    vi.spyOn(dns, 'resolveNs').mockResolvedValue(['ns1.example.com']);
    vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['v=spf1 -all']]);
    vi.spyOn(dns, 'resolveSoa').mockResolvedValue({
      nsname: 'ns1.example.com',
      hostmaster: 'admin.example.com',
      serial: 2026111501,
      refresh: 7200,
      retry: 3600,
      expire: 1209600,
      minttl: 300,
    });
    vi.spyOn(dns, 'resolveCaa').mockResolvedValue([{ critical: 0, issue: 'letsencrypt.org' }]);
    vi.spyOn(dns, 'reverse').mockResolvedValue(['edge.example.com']);

    let waybackEmpty = false;
    const ctx = makeCtx((u) => {
      if (u.hostname === 'rdap.org') {
        if (u.pathname.startsWith('/ip/')) {
          return jsonRes({
            name: 'EXAMPLE-NET',
            startAddress: '93.184.216.0',
            endAddress: '93.184.216.255',
            country: 'US',
            entities: [
              { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Org']]] },
              { roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Abuse Desk']]] },
            ],
          });
        }
        return jsonRes({
          ldhName: 'EXAMPLE.COM',
          status: ['active'],
          events: [
            { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
            { eventAction: 'last changed', eventDate: '2026-08-14T04:00:00Z' },
            { eventAction: 'expiration', eventDate: new Date(Date.now() + 10 * 86_400_000).toISOString() },
          ],
          nameservers: [{ ldhName: 'NS1.EXAMPLE.COM' }],
          entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'IANA']]] }],
        });
      }
      if (u.hostname === 'crt.sh') {
        return jsonRes([
          { name_value: '*.example.com\napi.example.com', not_before: '2026-01-01T00:00:00' },
          { name_value: 'api.example.com\nunrelated.other.org', not_before: '2026-06-01T00:00:00' },
        ]);
      }
      if (u.hostname === 'ipwho.is') {
        if (u.pathname.includes('192.0.2.1')) return jsonRes({ success: false, message: 'Reserved range' });
        return jsonRes({
          success: true,
          country: 'United States',
          region: 'Massachusetts',
          city: 'Norwell',
          connection: { asn: 15133, org: 'Edgecast', isp: 'Edgecast Inc.' },
          timezone: { id: 'America/New_York' },
        });
      }
      if (u.hostname === 'web.archive.org') {
        if (waybackEmpty) return jsonRes([['timestamp', 'original', 'statuscode']]);
        return jsonRes([
          ['timestamp', 'original', 'statuscode'],
          ['20200101000000', 'https://example.com/', '200'],
          ['20261101000000', 'https://example.com/', '200'],
        ]);
      }
      if (u.hostname === 't.me') return new Response('<div class="tgme_page_title">Ada</div>', { status: 200 });
      if (u.hostname === 'public.api.bsky.app') return new Response('Not Found', { status: 400 });
      if (u.hostname.includes('reddit.com')) return new Response('{"data":{"name":"ada"}}', { status: 200 });
      if (u.hostname.includes('gitlab.com')) return new Response('[{"username":"ada"}]', { status: 200 });
      if (u.hostname.includes('firebaseio.com')) return new Response('{"id":"ada"}', { status: 200 });
      if (u.hostname.includes('keybase.io')) return new Response('{"them":[{"id":"1"}]}', { status: 200 });
      if (u.hostname.includes('steamcommunity.com')) return new Response('<html>Profile</html>', { status: 200 });
      if (u.hostname === 'lobste.rs') return new Response('gone', { status: 404 });
      if (u.hostname === 'pastebin.com') throw new Error('network timeout');
      return new Response('{}', { status: 200 });
    });

    expect(USERNAME_SITES.length).toBeGreaterThanOrEqual(20);

    const dnsRes = await toolOf(osint, 'dns').run({ domain: 'example.com' }, ctx);
    expect(dnsRes.summary).toBe('9 records');

    const whoisDomain = await toolOf(osint, 'whois').run({ target: 'https://sub.example.com/path' }, ctx);
    expect(whoisDomain.summary).toBe('example.com · IANA');

    const whoisIp = await toolOf(osint, 'whois').run({ target: '93.184.216.34' }, ctx);
    expect(JSON.stringify(whoisIp.blocks)).toContain('EXAMPLE-NET');

    const subs = await toolOf(osint, 'subdomains').run({ domain: 'example.com' }, ctx);
    expect(subs.summary).toBe('2 subdomains');

    const ipIntel = await toolOf(osint, 'ip').run({ target: 'example.com' }, ctx);
    expect(ipIntel.summary).toContain('93.184.216.34 · Edgecast');
    await expect(toolOf(osint, 'ip').run({ target: '192.0.2.1' }, ctx)).rejects.toThrow(/Reserved range/);

    const users = await toolOf(osint, 'username').run({ username: '@ada_lovelace' }, ctx);
    expect(users.summary).toContain(`of ${USERNAME_SITES.length} sites`);
    await expect(toolOf(osint, 'username').run({ username: 'bad user!' }, ctx)).rejects.toThrow(/Usernames may contain/);

    const wb = await toolOf(osint, 'wayback').run({ url: 'example.com' }, ctx);
    expect(wb.summary).toBe('2 monthly snapshots');
    waybackEmpty = true;
    const wbEmpty = await toolOf(osint, 'wayback').run({ url: 'example.com' }, ctx);
    expect(wbEmpty.blocks[0]).toMatchObject({ type: 'notice', tone: 'warn' });

    const img = await toolOf(osint, 'image').run({ url: 'https://example.com/photo.png' }, ctx);
    expect(img.blocks[0].type).toBe('actions');

    const dorks = await toolOf(osint, 'dorks').run({ domain: 'example.com' }, ctx);
    expect(dorks.blocks).toHaveLength(2);
  });

  it('exercises webtest security headers, pagespeed, seo, broken links, tech stack, email security, and latency', async () => {
    vi.spyOn(dns, 'resolveMx').mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }]);
    vi.spyOn(dns, 'resolveTxt').mockImplementation(async (host: string) => {
      if (host === 'example.com') return [['v=spf1 include:_spf.example.com -all']];
      if (host === '_dmarc.example.com') return [['v=DMARC1; p=reject; rua=mailto:dmarc@example.com']];
      if (host === 'google._domainkey.example.com') return [['v=DKIM1; k=rsa; p=MIIB...']];
      return [];
    });

    const htmlPage = `<!doctype html><html lang="en"><head>
      <title>Example Engineering Portal — Fast &amp; Independent</title>
      <meta name="description" content="Independent technical documentation, benchmarks, and self-hosted tools with zero telemetry or ad trackers.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="generator" content="Hugo 0.138">
      <meta property="og:title" content="Example Portal">
      <meta property="og:description" content="Docs">
      <meta property="og:image" content="https://example.com/og.png">
      <link rel="canonical" href="https://example.com/">
      <script src="https://plausible.io/js/script.js"></script>
    </head><body>
      <h1 class="flex px-4">Welcome</h1>
      <img src="/logo.svg" alt="Logo"><img src="/decor.png">
      <a href="/ok">OK</a><a href="/head-405">Method Fallback</a><a href="/missing">Broken</a><a href="/boom">Timeout</a>
    </body></html>`;

    const ctx = makeCtx(
      (u, init) => {
        if (u.hostname === 'www.googleapis.com') {
          return jsonRes({
            lighthouseResult: {
              categories: {
                performance: { title: 'Performance', score: 0.96 },
                accessibility: { title: 'Accessibility', score: 0.92 },
                'best-practices': { title: 'Best Practices', score: 0.78 },
                seo: { title: 'SEO', score: 0.45 },
              },
              audits: {
                'largest-contentful-paint': { title: 'LCP', displayValue: '1.1 s', score: 0.95 },
                'cumulative-layout-shift': { title: 'CLS', displayValue: '0.01', score: null },
                'unused-javascript': { title: 'Reduce unused JS', details: { overallSavingsMs: 320 }, score: 0.4 },
              },
            },
          });
        }
        if (u.pathname === '/start') {
          return new Response(null, { status: 301, headers: { location: 'https://example.com/' } });
        }
        if (u.pathname === '/robots.txt') {
          return new Response('User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n', { status: 200 });
        }
        if (u.pathname === '/sitemap.xml') return new Response('', { status: 404 });
        if (u.pathname === '/ok') return new Response('ok', { status: 200 });
        if (u.pathname === '/head-405') {
          return new Response('', { status: init?.method === 'HEAD' ? 405 : 200 });
        }
        if (u.pathname === '/missing') return new Response('not found', { status: 404 });
        if (u.pathname === '/boom') throw new Error('ECONNRESET');
        return new Response(htmlPage, {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'strict-transport-security': 'max-age=31536000; includeSubDomains',
            'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'strict-origin-when-cross-origin',
            'permissions-policy': 'geolocation=()',
            'cross-origin-opener-policy': 'same-origin',
            server: 'cloudflare',
            'set-cookie': 'sid=abc; Secure; HttpOnly; SameSite=Strict',
          },
        });
      },
      { psiKey: 'psi-test-key' }
    );

    const hdrs = await toolOf(webtest, 'headers').run({ url: 'https://example.com/start' }, ctx);
    expect(hdrs.summary).toContain('Grade A');

    const psi = await toolOf(webtest, 'pagespeed').run({ url: 'https://example.com', strategy: 'desktop' }, ctx);
    expect(psi.summary).toBe('Performance 96');

    const seo = await toolOf(webtest, 'seo').run({ url: 'https://example.com' }, ctx);
    expect(seo.summary).toContain('Example Engineering Portal');

    const links = await toolOf(webtest, 'links').run({ url: 'https://example.com' }, ctx);
    expect(links.summary).toBe('2 broken of 4');

    const tech = await toolOf(webtest, 'tech').run({ url: 'https://example.com' }, ctx);
    expect(tech.summary).toContain('Hugo 0.138');
    expect(tech.summary).toContain('Cloudflare');
    expect(tech.summary).toContain('Plausible');

    const email = await toolOf(webtest, 'email').run({ domain: 'example.com' }, ctx);
    expect(email.summary).toBe('SPF ✓ · DMARC reject');

    const ping = await toolOf(webtest, 'latency').run({ url: 'https://example.com/ok' }, ctx);
    expect(ping.summary).toMatch(/^median \d+ ms$/);
  });

  it('covers security grading tiers, tech fingerprinting rules, OSINT/email fallback branches, runtime validation, and loadOptions', async () => {
    expect(gradeSecurityHeaders({}, false).grade).toBe('F');
    expect(
      gradeSecurityHeaders(
        {
          'content-security-policy': "default-src 'self' 'unsafe-inline'",
          'x-frame-options': 'DENY',
          server: 'nginx/1.25.0',
          'x-powered-by': 'Express 4',
        },
        true
      ).grade
    ).toMatch(/^[CDEF]$/);
    expect(
      gradeSecurityHeaders(
        {
          'strict-transport-security': 'max-age=31536000',
          'content-security-policy': "default-src 'self'",
          'x-content-type-options': 'nosniff',
        },
        true
      ).grade
    ).toBe('C');
    expect(
      gradeSecurityHeaders(
        {
          'strict-transport-security': 'max-age=31536000',
          'content-security-policy': "default-src 'self'",
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
        },
        true
      ).grade
    ).toBe('B');

    const detected = fingerprintTech(
      `<html><head><meta name="generator" content="WordPress 6.6"></head><body>
        /wp-content/ cdn.shopify.com content="Ghost __NEXT_DATA__ __NUXT__ astro-island
        data-reactroot data-v-abcdef svelte-12345 jquery-3.7.js bootstrap.min.css
        googletagmanager.com/gtag googletagmanager.com/gtm.js matomo.js
        connect.facebook.net/en_US/fbevents.js static.hotjar.com recaptcha hcaptcha.com
      </body></html>`,
      {
        'x-served-by': 'cache-fastly',
        'x-vercel-id': 'iad1::1',
        'x-nf-request-id': 'nf-1',
        server: 'Apache',
        'x-powered-by': 'Express',
        'set-cookie': 'PHPSESSID=123',
      }
    );
    expect(detected.length).toBeGreaterThanOrEqual(20);

    // OSINT negative & IPv6 fallback paths + site-specific exists predicates
    vi.spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENODATA'));
    vi.spyOn(dns, 'resolve6').mockResolvedValueOnce(['2001:db8::1']).mockRejectedValue(new Error('ENOTFOUND'));
    vi.spyOn(dns, 'resolveCname').mockRejectedValue(new Error('ENODATA'));
    vi.spyOn(dns, 'resolveMx').mockRejectedValue(new Error('ENODATA'));
    vi.spyOn(dns, 'resolveNs').mockRejectedValue(new Error('ENODATA'));
    vi.spyOn(dns, 'resolveTxt').mockRejectedValue(new Error('ENODATA'));
    vi.spyOn(dns, 'resolveSoa').mockRejectedValue(new Error('ENODATA'));
    vi.spyOn(dns, 'resolveCaa').mockRejectedValue(new Error('ENODATA'));
    vi.spyOn(dns, 'reverse').mockRejectedValue(new Error('ENOTFOUND'));

    const sparseCtx = makeCtx((u) => {
      if (u.hostname === 'ipwho.is') return jsonRes({ success: true });
      if (u.hostname === 'rdap.org') return jsonRes({});
      if (u.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (u.pathname === '/sitemap.xml') return new Response('', { status: 200 });
      return new Response('<html><head><meta name="robots" content="noindex"></head><body></body></html>', {
        status: 200,
        headers: { 'x-robots-tag': 'noindex', 'set-cookie': 'bad=1' },
      });
    });

    const v6Intel = await toolOf(osint, 'ip').run({ target: 'v6only.example.com' }, sparseCtx);
    expect(v6Intel.summary).toContain('2001:db8::1');
    await expect(toolOf(osint, 'ip').run({ target: 'dead.example.com' }, sparseCtx)).rejects.toThrow(/Couldn't resolve/);
    await expect(toolOf(osint, 'dns').run({ domain: 'dead.example.com' }, sparseCtx)).rejects.toThrow(/No DNS records/);
    expect((await toolOf(osint, 'whois').run({ target: 'sparse.example.com' }, sparseCtx)).summary).toContain('unknown registrar');
    expect(await toolOf(osint, 'whois').run({ target: '2001:db8::1' }, sparseCtx)).toBeTruthy();

    for (const site of USERNAME_SITES) {
      site.exists(200, '[]');
      site.exists(200, 'null');
      site.exists(200, '{"is_suspended": true, "them":[null]} The specified profile could not be found');
      site.exists(410, '');
      site.exists(429, '');
    }

    const sparseSeo = await toolOf(webtest, 'seo').run({ url: 'http://plain.example.com' }, sparseCtx);
    expect(JSON.stringify(sparseSeo.blocks)).toContain('noindex');
    const sparseHeaders = await toolOf(webtest, 'headers').run({ url: 'http://plain.example.com' }, sparseCtx);
    expect(sparseHeaders.summary).toContain('Grade F');
    const missingEmail = await toolOf(webtest, 'email').run({ domain: 'dead.example.com' }, sparseCtx);
    expect(missingEmail.summary).toBe('SPF ✗ · DMARC ✗');

    // Runtime & load-test validation branches
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError({ message: 'obj-msg' })).toBe('obj-msg');
    expect(describeError({ code: 42 })).toContain('42');
    expect(describeError(circ)).toBe('[object Object]');
    expect(describeError('raw')).toBe('raw');

    expect(validateDefinition(null)).toMatch(/not an object/);
    expect(validateDefinition({ id: 'BAD!' })).toMatch(/invalid id/);
    expect(validateDefinition({ id: 'ok' })).toMatch(/missing name/);
    expect(validateDefinition({ id: 'ok', name: 'OK' })).toMatch(/missing category/);
    expect(validateDefinition({ id: 'ok', name: 'OK', category: 'utility' })).toMatch(/tools must be an array/);
    expect(validateDefinition({ id: 'ok', name: 'OK', category: 'utility', tools: [{ id: 'BAD' }] })).toMatch(/invalid id/);
    expect(validateDefinition({ id: 'ok', name: 'OK', category: 'utility', tools: [{ id: 't1', run: () => ({ blocks: [] }), inputs: [] }, { id: 't1', run: () => ({ blocks: [] }), inputs: [] }] })).toMatch(/duplicate/);
    expect(validateDefinition({ id: 'ok', name: 'OK', category: 'utility', tools: [{ id: 't1', inputs: [] }] })).toMatch(/no run/);
    expect(validateDefinition({ id: 'ok', name: 'OK', category: 'utility', tools: [{ id: 't1', run: () => ({ blocks: [] }) }] })).toMatch(/inputs must be an array/);
    expect(validateDefinition({ id: 'ok', name: 'OK', category: 'utility', tools: [], downloadTarget: { label: 'X', kinds: ['magnet'] } })).toMatch(/without sendDownload/);

    expect(distribution([])).toEqual({ count: 0, median: null, p95: null, p99: null, min: null, max: null });
    expect(distribution([10, 20, 30]).median).toBe(20);
    expect(loadOptions(['--scenario=warm', '--samples=2', '--seconds=1', '--rps=10', '--max-searches=8'])).toMatchObject({ scenario: 'warm', samples: 2 });
    expect(() => loadOptions(['bad'])).toThrow(/Use --name=value/);
    expect(() => loadOptions(['--nope=1'])).toThrow(/Unknown option/);
    expect(() => loadOptions(['--samples=0'])).toThrow(/samples must be an integer/);
    expect(() => loadOptions(['--scenario=bogus'])).toThrow(/scenario must be/);

    // SPF ~all and +all branches
    vi.spyOn(dns, 'resolveTxt').mockResolvedValueOnce([['v=spf1 ~all']]).mockResolvedValue([]);
    expect((await toolOf(webtest, 'email').run({ domain: 'soft.example.com' }, sparseCtx)).summary).toContain('SPF ✓');
    vi.spyOn(dns, 'resolveTxt').mockResolvedValueOnce([['v=spf1 +all']]).mockResolvedValue([]);
    expect((await toolOf(webtest, 'email').run({ domain: 'open.example.com' }, sparseCtx)).summary).toContain('SPF ✓');

    // Plugin runtime registration & secret masking (isolated GLOGG_HOME so sequential runs stay clean)
    const prevHome = process.env.GLOGG_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-plugin-cov-'));
    process.env.GLOGG_HOME = tmpHome;
    expect(() => registerPlugin({ id: 'BAD' } as unknown as PluginDefinition)).toThrow();
    expect(() => savePluginSettings('missing-plugin', {})).toThrow(/Unknown plugin/);
    registerPlugin({
      id: 'cov-dummy',
      name: 'Cov Dummy',
      description: 'test',
      category: 'utility',
      settings: [
        { key: 'secret', label: 'Secret', secret: true, required: true },
        { key: 'count', label: 'Count', default: '3' },
        { key: 'flag', label: 'Flag' },
      ],
      tools: [],
    });
    try {
      expect(getPlugin('cov-dummy')?.name).toBe('Cov Dummy');
      expect(listPlugins().some((p) => p.id === 'cov-dummy' && !p.configured)).toBe(true);
      const saved = savePluginSettings('cov-dummy', { secret: 'abcdef1234', count: 5, flag: true, ignored: 'x' });
      expect(saved).toMatchObject({ secret: 'abcdef1234', count: '5', flag: 'true' });
      const masked = maskPluginSettings('cov-dummy', saved);
      expect(masked.secret).toBe('••••1234');
      // Masked values keep existing secret; empty string clears
      expect(savePluginSettings('cov-dummy', { secret: '••••1234', flag: '   ' })).toMatchObject({ secret: 'abcdef1234' });
      expect(listPlugins().some((p) => p.id === 'cov-dummy' && p.configured)).toBe(true);
    } finally {
      unregisterPlugin('cov-dummy');
      if (prevHome === undefined) delete process.env.GLOGG_HOME;
      else process.env.GLOGG_HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
