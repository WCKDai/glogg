import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CURATED_INDIE_INDEX,
  DEFAULT_BOOSTED_DOMAINS,
  DEFAULT_SLOP_DOMAINS,
} from '../src/core/index.js';
import { getContainerStackStatus, MANAGED_SERVICES, runContainerOrchestrationAction } from '../server/containerManager.js';
import { searchCuratedIndieIndex } from '../server/federatedSearch.js';
import { createGloggServer } from '../server/index.js';
import { runCli } from '../scripts/glogg-cli.js';

describe('glogg server API, container orchestrator, OpenSearch & CLI integration', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    const app = await createGloggServer();
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('validates CURATED_INDIE_INDEX integrity, unique domains, and valid URLs across all categories', () => {
    expect(CURATED_INDIE_INDEX.length).toBeGreaterThanOrEqual(35);
    const seenDomains = new Set<string>();
    const categories = new Set<string>();

    for (const site of CURATED_INDIE_INDEX) {
      expect(site.title.trim().length).toBeGreaterThan(2);
      expect(site.domain.trim().length).toBeGreaterThan(2);
      expect(site.url.startsWith('http')).toBe(true);
      expect(site.tags.length).toBeGreaterThanOrEqual(1);
      expect(seenDomains.has(site.domain)).toBe(false);
      seenDomains.add(site.domain);
      categories.add(site.category);
    }

    expect(categories.has('fediverse-protocols')).toBe(true);
    expect(categories.has('deep-archives-osint')).toBe(true);
    expect(categories.has('p2p-dht-usenet')).toBe(true);
    expect(categories.has('meta-indexers')).toBe(true);

    // Ensure no overlap between default boosted domains and default slop domains
    const slopSet = new Set(DEFAULT_SLOP_DOMAINS.map((d) => d.toLowerCase()));
    for (const boosted of DEFAULT_BOOSTED_DOMAINS) {
      expect(slopSet.has(boosted.toLowerCase())).toBe(false);
    }
  });

  it('searches the curated Real-Web Atlas accurately for Fediverse, OSINT, and P2P queries', () => {
    const fediHits = searchCuratedIndieIndex('atprotocol matrix stoat fediverse');
    expect(fediHits.length).toBeGreaterThanOrEqual(2);
    expect(fediHits.some((h) => h.url.includes('bsky.app') || h.url.includes('stoat.chat') || h.url.includes('matrix.org'))).toBe(true);

    const osintHits = searchCuratedIndieIndex('foia declassified leaks cryptome ddosecrets');
    expect(osintHits.length).toBeGreaterThanOrEqual(2);
  });

  it("serves /api/health with package.json's version and 20 active connectors", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      version: string;
      connectors: number;
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('glogg-engine');
    const { version } = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(body.version).toBe(version);
    expect(body.connectors).toBe(20);
  });

  it('serves /opensearch.xml and /api/opensearch/suggest for browser search bar integration', async () => {
    const xmlRes = await fetch(`${baseUrl}/opensearch.xml`);
    expect(xmlRes.status).toBe(200);
    expect(xmlRes.headers.get('content-type')).toContain('application/opensearchdescription+xml');
    const xmlText = await xmlRes.text();
    expect(xmlText).toContain('<ShortName>glogg.app</ShortName>');
    expect(xmlText).toContain('?q={searchTerms}');

    const suggestRes = await fetch(`${baseUrl}/api/opensearch/suggest?q=marginalia`);
    expect(suggestRes.status).toBe(200);
    const suggestJson = (await suggestRes.json()) as [string, string[], string[], string[]];
    expect(suggestJson[0]).toBe('marginalia');
    expect(suggestJson[1].some((title) => title.toLowerCase().includes('marginalia'))).toBe(true);
  });

  it('serves /api/directory with category filtering and /api/ipfs/:cid gateway resolution', async () => {
    const dirRes = await fetch(`${baseUrl}/api/directory?category=fediverse-protocols`);
    expect(dirRes.status).toBe(200);
    const dirBody = (await dirRes.json()) as { items: Array<{ category: string }> };
    expect(dirBody.items.length).toBeGreaterThanOrEqual(3);
    expect(dirBody.items.every((i) => i.category === 'fediverse-protocols')).toBe(true);

    const ipfsRes = await fetch(
      `${baseUrl}/api/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`
    );
    expect(ipfsRes.status).toBe(200);
    const ipfsBody = (await ipfsRes.json()) as {
      cid: string;
      gatewayUrl: string;
      fallbackGateways: string[];
    };
    expect(ipfsBody.cid).toBe('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    expect(ipfsBody.gatewayUrl).toContain('/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    expect(ipfsBody.fallbackGateways.length).toBeGreaterThanOrEqual(3);
  });

  it('inspects raw HTML via POST /api/inspect and returns clean sections and primary citations', async () => {
    const rawHtml = `
      <html>
        <head>
          <title>Linux Kernel io_uring Architecture</title>
          <script src="https://www.google-analytics.com/analytics.js"></script>
        </head>
        <body>
          <article>
            <h1>Linux Kernel io_uring Architecture</h1>
            <p>Ring buffers shared between user space and kernel space eliminate syscall copy overhead at 500k IOPS.</p>
            <p>Reference specification: <a href="https://kernel.dk/io_uring.pdf">io_uring Primary Paper</a> and <a href="https://github.com/axboe/liburing">liburing GitHub Repository</a>.</p>
          </article>
        </body>
      </html>
    `;

    const res = await fetch(`${baseUrl}/api/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://kernel.dk/io_uring.html',
        rawHtml,
      }),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      domain: string;
      stats: { totalScriptsRemoved: number };
      primarySources: Array<{ url: string }>;
    };
    expect(report.domain).toBe('kernel.dk');
    expect(report.stats.totalScriptsRemoved).toBe(1);
    expect(report.primarySources.length).toBeGreaterThanOrEqual(1);
  });

  it('lists the 7 managed services without touching docker or podman when told not to', async () => {
    // Hermetic: probing the host's real runtimes took seconds on CI and timed the test out.
    process.env.GLOGG_CONTAINER_RUNTIME = 'none';
    expect(MANAGED_SERVICES.map((s) => s.id)).toEqual([
      'searxng',
      'bitmagnet',
      'ipfs-kubo',
      'aria2-rpc',
      'nextcloud',
      'prowlarr',
      'nzbhydra2',
    ]);

    const t = Date.now();
    const stack = await getContainerStackStatus();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(stack.services.length).toBe(7);
    expect(stack.activeRuntime).toBe('none');
    expect(stack.runtimes).toEqual({ docker: false, podman: false, colima: false });
    expect(stack.composeFilePath).toMatch(/infra\/docker-compose\.services\.yml$/);
    expect((await runContainerOrchestrationAction({ action: 'stack-up' })).output).toContain('GLOGG_CONTAINER_RUNTIME=none');

    const apiRes = await fetch(`${baseUrl}/api/containers`);
    expect(apiRes.status).toBe(200);
    const apiStack = (await apiRes.json()) as { services: Array<{ id: string }> };
    expect(apiStack.services.length).toBe(7);
    delete process.env.GLOGG_CONTAINER_RUNTIME;
  });

  it('executes glogg CLI commands (query-plan, atlas, rules) cleanly', async () => {
    // Captured, not printed: the rules alone are a few hundred lines.
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    try {
      const planCode = await runCli(['node', 'glogg-cli.ts', 'query-plan', 'distributed', 'hash', 'table', '--lens', 'p2p-magnet', '--json']);
      expect(planCode).toBe(0);
      expect(JSON.parse(out.pop()!)).toMatchObject({ rawQuery: 'distributed hash table', lens: 'p2p-magnet' });

      const atlasCode = await runCli(['node', 'glogg-cli.ts', 'atlas', 'fediverse-protocols', '--json']);
      expect(atlasCode).toBe(0);
      const atlas = JSON.parse(out.pop()!) as { category: string }[];
      expect(atlas.length).toBeGreaterThan(0);
      expect(atlas.every((a) => a.category === 'fediverse-protocols')).toBe(true);

      const rulesCode = await runCli(['node', 'glogg-cli.ts', 'rules']);
      expect(rulesCode).toBe(0);
      expect(out.pop()).toMatch(/^\*:\/\/\*\./m);
    } finally {
      log.mockRestore();
    }
  });
});
