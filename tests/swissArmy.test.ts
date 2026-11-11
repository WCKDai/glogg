import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_BANGS,
  compileSearchQuery,
  diversifyAndRankResults,
  RawSearchResult,
  resolveBang,
  suggestBangs,
} from '../src/core/index.js';

describe('!bangs — escape to any engine', () => {
  it('resolves a leading or trailing bang and strips it from the query', () => {
    const lead = resolveBang('!w alan turing');
    expect(lead?.bang.trigger).toBe('w');
    expect(lead?.query).toBe('alan turing');
    expect(lead?.url).toBe('https://en.wikipedia.org/w/index.php?search=alan%20turing');

    const trail = resolveBang('thinkpad x220 bios !vogons');
    expect(trail?.bang.trigger).toBe('vogons');
    expect(trail?.query).toBe('thinkpad x220 bios');
  });

  it('ignores unknown bangs and exclamation marks inside words', () => {
    expect(resolveBang('wow!nice')).toBeNull();
    expect(resolveBang('hello !notabang')).toBeNull();
    expect(resolveBang('plain query')).toBeNull();
  });

  it('lets custom bangs override built-ins and rejects templates without {q}', () => {
    const custom = [
      { trigger: 'w', name: 'German Wikipedia', url: 'https://de.wikipedia.org/w/index.php?search={q}', category: 'reference' as const },
      { trigger: 'bad', name: 'Broken', url: 'https://example.com/', category: 'web' as const },
    ];
    expect(resolveBang('!w berlin', custom)?.url).toContain('de.wikipedia.org');
    expect(resolveBang('!bad thing', custom)).toBeNull();
  });

  it('suggests bangs while typing and ranks exact prefixes first', () => {
    const s = suggestBangs('retro sound card !4');
    expect(s[0].trigger).toBe('4c');
    expect(suggestBangs('no bang here')).toEqual([]);
    expect(suggestBangs('!').length).toBeGreaterThan(0);
  });

  it('ships unique triggers that all contain a {q} placeholder', () => {
    const triggers = BUILTIN_BANGS.map((b) => b.trigger);
    expect(new Set(triggers).size).toBe(triggers.length);
    expect(BUILTIN_BANGS.every((b) => b.url.includes('{q}'))).toBe(true);
  });
});

describe('wild-west lens', () => {
  it('compiles forum/board operators and adds chan archive escape links', () => {
    const plan = compileSearchQuery('sound blaster awe32 drivers', { lens: 'wild-west' });
    expect(plan.positiveOperators.join(' ')).toContain('inurl:forum');
    const ids = plan.escapeUrls.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['desuarchive', '4plebs', 'warosu', 'textfiles']));
  });

  it('ranks chanboard threads and obscure forums above monoculture sites', () => {
    const raw: RawSearchResult[] = [
      {
        title: 'Sound Blaster AWE32 drivers for DOS - setup guide',
        url: 'https://www.cnet.com/tech/awe32-drivers-best-guide',
        snippet: 'The best AWE32 drivers sound blaster guide for 2026.',
        source: 'web',
      },
      {
        title: '[Desuarchive /vr/] Sound Blaster AWE32 drivers thread',
        url: 'https://desuarchive.org/vr/thread/123456/',
        snippet: 'anyone got the original sound blaster AWE32 drivers disk images? AWE32 setup on DOS 6.22',
        source: 'chanboards',
      },
      {
        title: 'AWE32 drivers and Sound Blaster DOS setup',
        url: 'https://www.vogons.org/viewtopic.php?t=4242',
        snippet: 'Sound Blaster AWE32 drivers, SET BLASTER variables, DOS setup on a 486.',
        source: 'wild-west',
      },
    ];
    const ranked = diversifyAndRankResults(raw, { lens: 'wild-west', maxPerDomain: 2 }, 'sound blaster awe32 drivers');
    const order = ranked.surfaced.map((r) => r.source);
    expect(order.indexOf('web') === -1 || order.indexOf('web') > order.indexOf('wild-west')).toBe(true);
    expect(order).toContain('chanboards');
  });
});

describe('chan archives', () => {
  it("searches b4k and Palanq too, and marks posts from 4chan's adult boards 18+", async () => {
    const post = (board: string, num: number) => ({
      num: String(num),
      thread_num: String(num),
      board: { shortname: board },
      title: null,
      comment: `sound blaster thread on /${board}/`,
      timestamp: 1_700_000_000,
    });
    const answer = (posts: unknown[]) => new Response(JSON.stringify({ 0: { posts } }), { headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://arch.b4k.dev/')) return answer([post('v', 11)]);
      if (url.startsWith('https://archive.palanq.win/')) return answer([post('vt', 21), post('bant', 22)]);
      if (url.startsWith('https://desuarchive.org/')) return answer([post('r9k', 31), post('g', 32)]);
      return new Response('', { status: 404 });
    });
    try {
      const { searchChanArchives } = await import('../server/wildWestIndexer.js');
      const byUrl = Object.fromEntries((await searchChanArchives('sound blaster')).map((r) => [r.url, r]));
      expect(byUrl['https://arch.b4k.dev/v/thread/11/#11']).toMatchObject({ source: 'chanboards', isNsfw: false, title: '[b4k /v/] sound blaster thread on /v/' });
      expect(byUrl['https://archive.palanq.win/vt/thread/21/#21'].isNsfw).toBe(false);
      expect(byUrl['https://archive.palanq.win/bant/thread/22/#22'].isNsfw).toBe(true);
      expect(byUrl['https://desuarchive.org/r9k/thread/31/#31'].isNsfw).toBe(true);
      expect(byUrl['https://desuarchive.org/g/thread/32/#32'].isNsfw).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('download manager', () => {
  let dm: typeof import('../server/downloadManager.js');

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-home-'));
    process.env.GLOGG_HOME = home;
    process.env.GLOGG_DOWNLOADS_DIR = path.join(home, 'downloads');
    dm = await import('../server/downloadManager.js');
  });

  it('classifies magnets, NZBs, torrents, files and pages', () => {
    expect(dm.detectKind('magnet:?xt=urn:btih:abc')).toBe('magnet');
    expect(dm.detectKind('https://api.nzb.life/api?t=get&id=1')).toBe('nzb');
    expect(dm.detectKind('https://x.org/a.torrent')).toBe('torrent');
    expect(dm.detectKind('https://x.org/debian.iso')).toBe('direct-file');
    expect(dm.detectKind('https://x.org/blog/post')).toBe('web-archive');
  });

  it('keeps a Brave Search API key, masked like the other secrets', () => {
    dm.saveIntegrationConfig({ braveApiKey: 'BSA-abcdef7890' });
    expect(dm.loadIntegrationConfig().braveApiKey).toBe('BSA-abcdef7890');
    expect(dm.maskConfig(dm.loadIntegrationConfig()).braveApiKey).toBe('••••7890');
    dm.saveIntegrationConfig({ braveApiKey: '' });
  });

  it('persists secrets server-side, masks them in responses, and keeps masked values unchanged on save', () => {
    dm.saveIntegrationConfig({ offcloudApiKey: 'sk-offcloud-123456', nextcloudUrl: 'https://cloud.example' });
    const masked = dm.maskConfig(dm.loadIntegrationConfig());
    expect(masked.offcloudApiKey).toBe('••••3456');
    expect(masked.nextcloudUrl).toBe('https://cloud.example');

    dm.saveIntegrationConfig({ offcloudApiKey: masked.offcloudApiKey });
    expect(dm.loadIntegrationConfig().offcloudApiKey).toBe('sk-offcloud-123456');

    dm.saveIntegrationConfig({ offcloudApiKey: '' });
    expect(dm.loadIntegrationConfig().offcloudApiKey).toBeUndefined();
  });

  it('rejects non-http(s)/magnet URLs', async () => {
    await expect(dm.enqueueDownload({ url: 'file:///etc/passwd' })).rejects.toThrow();
  });
});

describe('adaptive source gathering', () => {
  const fake = (n: number, delay: number, fail = false) => () =>
    new Promise<RawSearchResult[]>((resolve, reject) =>
      setTimeout(
        () =>
          fail
            ? reject(new Error('upstream down'))
            : resolve(
                Array.from({ length: n }, (_, i) => ({
                  id: `r${delay}-${i}`,
                  title: `t${i}`,
                  url: `https://e${delay}.example/${i}`,
                  snippet: '',
                  source: 'web' as const,
                }))
              ),
        delay
      )
    );

  it('returns early once core sources have enough results after the soft deadline', async () => {
    const { gatherSources } = await import('../server/federatedSearch.js');
    const t = Date.now();
    const out = await gatherSources(
      [
        { key: 'fast', core: true, run: fake(8, 10) },
        { key: 'slow', core: false, run: fake(5, 2000) },
      ],
      { softMs: 60, hardMs: 1500, minCore: 6 }
    );
    expect(Date.now() - t).toBeLessThan(400);
    expect(out.fast).toHaveLength(8);
    expect(out.slow).toHaveLength(0);
  });

  it('keeps waiting past the soft deadline when core sources are still empty, up to the hard cap', async () => {
    const { gatherSources } = await import('../server/federatedSearch.js');
    const out = await gatherSources(
      [
        { key: 'core', core: true, run: fake(7, 150) },
        { key: 'broken', core: true, run: fake(0, 5, true) },
      ],
      { softMs: 20, hardMs: 1000, minCore: 6 }
    );
    expect(out.core).toHaveLength(7);
    expect(out.broken).toEqual([]);
  });
});
