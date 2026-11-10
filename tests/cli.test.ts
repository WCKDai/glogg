/**
 * The glogg command line (scripts/glogg-cli.ts). It calls the upstreams itself
 * rather than a glogg server, so those are local fixtures here. Commands run
 * in-process with their output captured, and as a real process for exit codes
 * and what reaches the terminal.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanAndAutopsyHtml, compileSearchQuery, CURATED_INDIE_INDEX, DEFAULT_SLOP_DOMAINS, exportUBlacklistRuleset } from '../src/core/index.js';
import type { ContainerStackReport, RankedSearchResponse } from '../src/core/index.js';
import { MANAGED_SERVICES } from '../server/containerManager.js';
import { fixtureServer, useTempGloggHome } from './helpers.js';
import type { Fixture } from './helpers.js';

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

const FILE_ENV = ['GLOGG_HOME', 'GLOGG_CONTAINER_RUNTIME', 'SEARXNG_URL', 'BITMAGNET_URL'];
const envBefore = Object.fromEntries(FILE_ENV.map((k) => [k, process.env[k]]));
const home = useTempGloggHome();
const unreachable = `http://127.0.0.1:${await closedPort()}`;
Object.assign(process.env, { GLOGG_CONTAINER_RUNTIME: 'none', SEARXNG_URL: unreachable, BITMAGNET_URL: unreachable });
const { runCli } = await import('../scripts/glogg-cli.js');
const search = await import('../server/federatedSearch.js');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ANSI = /\x1b\[[0-9;]*m/g;

/** Runs a command in-process; nothing it prints reaches the test output. */
async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(format(...a)));
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(format(...a)));
  try {
    const code = await runCli(['node', 'glogg', ...args]);
    return { code, raw: out.join('\n'), stdout: out.join('\n').replace(ANSI, ''), stderr: err.join('\n').replace(ANSI, '') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

/** Runs the CLI as its own process, as `glogg` would. Only for commands that stay on this machine. */
function glogg(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'scripts', 'glogg-cli.ts'), ...args], {
      cwd: REPO,
      // tsx keeps its cache in the temp dir: keep that inside this run's folder too.
      env: { ...process.env, GLOGG_HOME: home, GLOGG_CONTAINER_RUNTIME: 'none', TMPDIR: tmp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const PAGE = `<!doctype html><html><head><title>Ring buffers in io_uring</title>
  <script src="https://www.google-analytics.com/analytics.js"></script><script>track()</script></head>
  <body><nav>Home · Archive</nav><article><h1>Ring buffers in io_uring</h1>
  <p>Shared ring buffers between user space and the kernel avoid a system call per request, which is where the throughput comes from.</p>
  <p>Submission and completion queues are plain memory, so a busy server can batch thousands of requests before it enters the kernel at all.</p>
  <p>The design is in the <a href="https://kernel.dk/io_uring.pdf">io_uring paper</a> and the <a href="https://github.com/axboe/liburing">liburing repository</a>.</p>
  </article></body></html>`;
let site: Fixture;

beforeAll(async () => {
  site = await fixtureServer({ '/article': { body: PAGE } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await site.close();
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('glogg help', () => {
  it('prints usage and exits 0 with no command, --help, -h or help', async () => {
    for (const args of [[], ['--help'], ['-h'], ['help']]) {
      const r = await cli(...args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.stdout).toContain('glogg <command> [options]');
      for (const command of ['search', 'inspect', 'containers', 'atlas', 'rules', 'query-plan']) expect(r.stdout).toMatch(new RegExp(`^  ${command} `, 'm'));
      expect(r.stdout).toContain(`(${CURATED_INDIE_INDEX.length} verified sites & protocols)`);
      expect(r.stderr).toBe('');
    }
  });

  it('prints usage and exits 1 for a command it does not know', async () => {
    const r = await cli('serach', 'typo');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('USAGE');
  });
});

describe('glogg query-plan', () => {
  it('prints the compiled query as JSON', async () => {
    const r = await cli('query-plan', 'rust', 'async', 'runtimes', '--json');
    expect(r.code).toBe(0);
    expect(r.raw).not.toMatch(/\x1b\[/);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(compileSearchQuery('rust async runtimes', { lens: 'all' }))));
  });

  it('takes the scope from --lens', async () => {
    expect(JSON.parse((await cli('query-plan', 'rust', 'async', '--lens', 'small-web', '--json')).stdout).lens).toBe('small-web');
  });

  it('prints the synthesized query and its escape links', async () => {
    const plan = compileSearchQuery('rust async runtimes', { lens: 'all' });
    const r = await cli('query-plan', 'rust', 'async', 'runtimes');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('● glogg.app');
    expect(r.stdout).toContain(`Synthesized Query: ${plan.synthesizedQuery}`);
    expect(r.stdout).toContain('Escape Hatch Meta-Links:');
    expect(plan.escapeUrls.length).toBeGreaterThan(0);
    for (const e of plan.escapeUrls) expect(r.stdout).toContain(`  ${e.name.padEnd(32)} ${e.url}`);
  });

  it('asks for a query and exits 1 without one', async () => {
    for (const args of [[], ['--json'], ['--lens']]) {
      const r = await cli('query-plan', ...args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toBe('Error: Please provide a search query.');
      expect(r.stdout).toBe('');
    }
  });
});

describe('glogg search', () => {
  const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
  const asked: URLSearchParams[] = [];
  let searx: Fixture;
  let bitmagnet: Fixture;

  beforeAll(async () => {
    const json = { 'Content-Type': 'application/json' };
    searx = await fixtureServer({
      '/search': (req) => {
        asked.push(new URL(req.url || '/', 'http://x').searchParams);
        return {
          headers: json,
          body: JSON.stringify({ results: [{ url: 'https://gardens.example/tiny-web', title: 'Tiny web gardens: a field guide', content: 'Personal sites tended by hand, listed and reviewed.' }] }),
        };
      },
    });
    bitmagnet = await fixtureServer({
      '/graphql': {
        headers: json,
        body: JSON.stringify({
          data: {
            torrentContent: {
              search: {
                items: [{ infoHash: HASH, title: 'Tiny web gardens archive', seeders: 12, leechers: 3, contentType: 'ebook', torrent: { name: 'Tiny web gardens archive', size: 1048576, filesCount: 3 } }],
              },
            },
          },
        }),
      },
    });
  });
  beforeEach(() => {
    asked.length = 0;
    search.clearSearchCache();
    search.resetSourceHealth();
    vi.stubEnv('SEARXNG_URL', searx.baseUrl);
    vi.stubEnv('BITMAGNET_URL', `${bitmagnet.baseUrl}/graphql`);
  });
  afterAll(async () => {
    await searx.close();
    await bitmagnet.close();
  });

  it('prints the response as JSON', async () => {
    const r = await cli('search', 'tiny', 'web', 'gardens', '--json');
    expect(r.code).toBe(0);
    expect(r.raw).not.toMatch(/\x1b\[/);
    const res = JSON.parse(r.stdout) as RankedSearchResponse;
    expect(res).toMatchObject({ query: 'tiny web gardens', lens: 'all', uncensoredMode: false });
    expect(res.results.map((x) => x.url)).toContain('https://gardens.example/tiny-web');
    expect(res.p2pResults.map((x) => x.p2p?.infoHash)).toContain(HASH);
    expect(asked.map((p) => [p.get('q'), p.get('safesearch')])).toEqual([['tiny web gardens', '1']]);
  });

  it('takes --lens, --uncensored and --max-per-domain, and keeps their values out of the query', async () => {
    const res = JSON.parse((await cli('search', '--lens', 'p2p-magnet', 'tiny', 'web', 'gardens', '--max-per-domain', '3', '--uncensored', '--json')).stdout) as RankedSearchResponse;
    expect(res).toMatchObject({ query: 'tiny web gardens', lens: 'p2p-magnet', uncensoredMode: true });
    expect(asked[0].get('safesearch')).toBe('0');
    expect((JSON.parse((await cli('search', 'tiny', 'web', 'gardens', '--18+', '--json')).stdout) as RankedSearchResponse).uncensoredMode).toBe(true);
  });

  it('prints a readable summary, with P2P releases and the results', async () => {
    const r = await cli('search', 'tiny', 'web', 'gardens');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('● glogg.app');
    expect(r.stdout).toMatch(/^Query: "tiny web gardens" · Lens: all · 18\+ Uncensored: OFF · Time: \d+ms$/m);
    expect(r.stdout).toMatch(/^\d+ surfaced · \d+ P2P\/NZB · \d+ Fediverse · \d+ slop\/dupes stripped \(\d+% domain diversity\)$/m);
    expect(r.stdout).toContain('── P2P DHT / Bitmagnet & Usenet NZB Releases (Top 5) ──');
    expect(r.stdout).toMatch(/^ {2}\[BT-DHT\] Tiny web gardens archive \(1(\.0+)? MB · 12S\/3L\)$/m);
    expect(r.stdout).toContain(`magnet:?xt=urn:btih:${HASH}`);
    expect(r.stdout).toContain('── Surfaced Real-Web, Fediverse & Primary Results ──');
    expect(r.stdout).toMatch(/^ {2}\[[A-Z-]+\] Tiny web gardens: a field guide \(gardens\.example · Signal \d+% · Slop \d+%\)$/m);
    expect(r.stdout).toMatch(/^ {4}https:\/\/gardens\.example\/tiny-web$/m);
  });

  it('prints an instant answer when there is one', async () => {
    const r = await cli('search', '18%', 'of', '450');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('── Instant Direct Answer (VERIFIED) ──');
    expect(r.stdout).toMatch(/^ {2}81 · 18% of 450$/m);
    expect(r.stdout).toMatch(/^ {2}18% × 450 = 81$/m);
  });

  it('still answers, finding nothing, when every upstream is down', async () => {
    vi.stubEnv('SEARXNG_URL', unreachable);
    vi.stubEnv('BITMAGNET_URL', unreachable);
    const r = await cli('search', 'xyzzy', 'plugh', '--json');
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as RankedSearchResponse;
    expect(res.results).toEqual([]);
    expect(res.p2pResults).toEqual([]);
    expect(res.metrics.sourceTimings?.searxng).toMatchObject({ count: 0 });
  });

  it('asks for a query and exits 1 without one', async () => {
    for (const args of [[], ['--json'], ['--lens', 'small-web'], ['--max-per-domain', '2', '--uncensored']]) {
      const r = await cli('search', ...args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toBe('Error: Please provide a search query.');
    }
    expect(asked).toEqual([]);
  });
});

describe('glogg inspect', () => {
  const url = () => `${site.baseUrl}/article`;

  it('prints the cleaned page as JSON', async () => {
    const r = await cli('inspect', url(), '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(cleanAndAutopsyHtml(PAGE, url()))));
  });

  it('prints a readable report: the title, what was stripped, the sources and the takeaway', async () => {
    const report = cleanAndAutopsyHtml(PAGE, url());
    expect(report.primarySources.length).toBeGreaterThan(0);
    expect(report.coreTakeaway).not.toBe('');
    const r = await cli('inspect', url());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${report.title} (${report.domain})`);
    expect(r.stdout).toContain(
      `Bloat Reduced: ${report.stats.bloatReductionPercent}% · Trackers Killed: ${report.stats.totalScriptsRemoved} · Affiliates Disarmed: ${report.stats.affiliateLinksDisarmed} · Primary Citations: ${report.primarySources.length}`
    );
    expect(r.stdout).toContain('Primary Sources Cited:');
    for (const s of report.primarySources) expect(r.stdout).toContain(`  • [${s.sourceTypeLabel || 'Primary'}] ${s.text} → ${s.url}`);
    expect(r.stdout).toContain(`Core Takeaway:\n  ${report.coreTakeaway}`);
  });

  it('adds https:// to an address without a scheme', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      fetched.push(String(input));
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html' } });
    });
    const r = await cli('inspect', 'example.com/post', '--json');
    expect(r.code).toBe(0);
    expect(fetched).toEqual(['https://example.com/post']);
    expect(JSON.parse(r.stdout).url).toBe('https://example.com/post');
  });

  it('asks for a URL and exits 1 without one', async () => {
    for (const args of [[], ['--json']]) {
      const r = await cli('inspect', ...args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toBe('Error: Please provide a URL to inspect.');
    }
  });
});

describe('glogg containers, with container management off', () => {
  it('prints the runtime and every managed service', async () => {
    for (const args of [[], ['status']]) {
      const r = await cli('containers', ...args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.stdout).toContain('Container Runtime: NONE · Daemon: OFFLINE');
      const lines = r.stdout.split('\n').filter((l) => /^ {2}\[(RUNNING|NOT-CREATED|STOPPED) *\] /.test(l));
      expect(lines).toHaveLength(MANAGED_SERVICES.length);
      MANAGED_SERVICES.forEach((s, i) => expect(lines[i]).toContain(`${s.name.padEnd(28)} ${s.webUrl.padEnd(28)} (${s.image})`));
    }
  });

  it('prints the stack as JSON', async () => {
    const r = await cli('containers', 'status', '--json');
    expect(r.code).toBe(0);
    const stack = JSON.parse(r.stdout) as ContainerStackReport;
    expect(stack).toMatchObject({ activeRuntime: 'none', daemonRunning: false, runtimes: { docker: false, podman: false, colima: false } });
    expect(stack.services.map((s) => s.id)).toEqual(MANAGED_SERVICES.map((s) => s.id));
  });

  it('refuses to start or stop anything, exiting 1', async () => {
    for (const args of [['up'], ['up', 'searxng'], ['down'], ['start-daemon']]) {
      const r = await cli('containers', ...args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stdout).toBe('Container management is off here (GLOGG_CONTAINER_RUNTIME=none).');
    }
  });

  it('prints usage and exits 1 for a subcommand it does not know', async () => {
    const r = await cli('containers', 'restart');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('USAGE');
  });
});

describe('glogg atlas', () => {
  it('lists every curated site', async () => {
    const r = await cli('atlas');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Real-Web Atlas (${CURATED_INDIE_INDEX.length} entries):`);
    for (const i of CURATED_INDIE_INDEX) {
      expect(r.stdout).toContain(`  ${i.domain.padEnd(26)} [${i.category}] ${i.title}\n    ${i.description}`);
    }
  });

  it('filters to a category, as text or JSON', async () => {
    const fediverse = CURATED_INDIE_INDEX.filter((i) => i.category === 'fediverse-protocols');
    const json = await cli('atlas', 'fediverse-protocols', '--json');
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(fediverse);
    expect((await cli('atlas', 'fediverse-protocols')).stdout).toContain(`Real-Web Atlas (${fediverse.length} entries):`);
    expect(JSON.parse((await cli('atlas', 'all', '--json')).stdout)).toEqual(CURATED_INDIE_INDEX);
  });

  it('answers an unknown category with no entries', async () => {
    const r = await cli('atlas', 'no-such-category', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});

describe('glogg rules', () => {
  it('prints the uBlacklist ruleset, one rule per slop domain', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    try {
      const r = await cli('rules');
      expect(r.code).toBe(0);
      expect(r.raw).toBe(exportUBlacklistRuleset(DEFAULT_SLOP_DOMAINS));
      const lines = r.raw.split('\n');
      expect(lines.slice(0, 3)).toEqual(['# glogg Anti-Slop Ruleset (uBlacklist compatible)', '# Generated: 2026-01-02T03:04:05.000Z', '# Import into glogg or uBlacklist browser extension']);
      const rules = lines.filter((l) => l && !l.startsWith('#'));
      for (const rule of rules) expect(rule).toMatch(/^\*:\/\/\*\.[a-z0-9.-]+\/\*$/);
      for (const d of DEFAULT_SLOP_DOMAINS) expect(rules).toContain(`*://*.${d.toLowerCase().replace(/^www\./, '')}/*`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('glogg as a process', () => {
  it('prints the ruleset to stdout and exits 0', async () => {
    const r = await glogg('rules');
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('# glogg Anti-Slop Ruleset (uBlacklist compatible)');
    expect(r.stdout).toContain('*://*.pinterest.com/*\n');
    expect(r.stderr).toBe('');
  });

  it('exits 1, with usage for an unknown command and an error on stderr for a missing query', async () => {
    const unknown = await glogg('serach');
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toContain('USAGE');
    const missing = await glogg('search');
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Error: Please provide a search query.\n');
  });

  it('inspects a page and prints JSON', async () => {
    const r = await glogg('inspect', `${site.baseUrl}/article`, '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ url: `${site.baseUrl}/article`, title: 'Ring buffers in io_uring', domain: '127.0.0.1' });
  });

  it('exits non-zero, naming the refused connection, when the page is unreachable', async () => {
    const r = await glogg('inspect', `${unreachable}/article`);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('ECONNREFUSED');
  });

  it('reports the stack, with container management off', async () => {
    const r = await glogg('containers', 'status', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ activeRuntime: 'none', daemonRunning: false });
  });
}, 30_000);

describe('arguments and failures (bugs the first run of these tests found)', () => {
  it('atlas --json lists the whole Atlas: a flag is not a category', async () => {
    const r = await cli('atlas', '--json');
    expect(JSON.parse(r.stdout)).toHaveLength(CURATED_INDIE_INDEX.length);
  });

  it('containers --json reports the stack: a flag is not a subcommand', async () => {
    const r = await cli('containers', '--json');
    expect(r.code, r.stdout.slice(0, 80)).toBe(0);
  });

  it('keeps the --lens value out of the query', async () => {
    const plan = JSON.parse((await cli('query-plan', 'rust', 'async', '--lens', 'small-web', '--json')).stdout);
    expect(plan.rawQuery).toBe('rust async');
  });

  it('returns 1 with a one-line error when the page is unreachable', async () => {
    const r = await cli('inspect', `${unreachable}/article`);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Error: .*ECONNREFUSED/);
  });

  it('prints one line, not a stack trace, when the page is unreachable', async () => {
    const r = await glogg('inspect', `${unreachable}/article`);
    expect(r.code).toBe(1);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });
});
