/** Offline HTTP/NDJSON experiment. All upstream fetches are fixtures in an isolated child. */
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LATENCY_PROFILES = ['cold-fast', 'warm-cache', 'slow-answer', 'slow-noncore'] as const;
type Profile = typeof LATENCY_PROFILES[number];
const QUERY = 'rust borrow checker';
const TOPICS = ['lifetimes', 'graphs', 'async', 'closures', 'references', 'mutability', 'types', 'memory'];
const FIXTURE = {
  query: QUERY,
  hits: TOPICS.map((topic, i) => ({ objectID: `latency-${i}`, title: `Rust borrow checker: ${topic}`, url: `https://notes${i}.example/rust-borrow-checker`, points: 10, num_comments: 2, created_at: '2020-01-01T00:00:00Z' })),
  hnDelayMs: 80, answerDelayMs: 900, noncoreDelayMs: 1200,
  otherResponses: '404, including local services; every fetch is intercepted',
};
const USEFUL_URLS = new Set(FIXTURE.hits.map((hit) => hit.url));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const round = (value: number) => Math.round(value * 100) / 100;

export function latencyOptions(args: string[]) {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--(root|samples|profile|output)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1])) throw new Error(`Unknown, duplicate or malformed option: ${arg}`);
    values[match[1]] = match[2];
  }
  const samples = Number(values.samples ?? 5);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) throw new Error('samples must be an integer from 1 to 100');
  const profile = values.profile ?? 'all';
  if (profile !== 'all' && !LATENCY_PROFILES.includes(profile as Profile)) throw new Error('profile must be all, cold-fast, warm-cache, slow-answer or slow-noncore');
  return { root: path.resolve(values.root ?? '.'), samples, profiles: profile === 'all' ? [...LATENCY_PROFILES] : [profile as Profile], output: values.output };
}

/** Nearest-rank percentiles; missing observations are never recorded as zero. */
export function latencyDistribution(values: number[]) {
  if (values.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('Latency observations must be finite and nonnegative');
  if (!values.length) return { count: 0, median: null, p95: null, min: null, max: null, medianAbsoluteDeviation: null };
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (rows: number[], p: number) => rows[Math.max(0, Math.ceil(p * rows.length) - 1)];
  const median = quantile(sorted, .5);
  const deviations = sorted.map((n) => Math.abs(n - median)).sort((a, b) => a - b);
  return { count: sorted.length, median: round(median), p95: round(quantile(sorted, .95)), min: round(sorted[0]), max: round(sorted.at(-1)!), medianAbsoluteDeviation: round(quantile(deviations, .5)) };
}

export interface StreamEvent { type: 'partial' | 'final' | 'error'; response?: { results: { url?: string }[] }; error?: string }
/** Decodes byte chunks, including split UTF-8 and multiple events per chunk. */
export function ndjsonDecoder(onEvent: (event: StreamEvent) => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', bytes = 0;
  const parse = () => {
    for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 2_000_000) throw new Error('NDJSON line exceeds 2 MB');
      const value = JSON.parse(line) as StreamEvent;
      if (!value || !['partial', 'final', 'error'].includes(value.type) || (value.type !== 'error' && !Array.isArray(value.response?.results))) throw new Error('Invalid search stream event');
      onEvent(value);
    }
    if (Buffer.byteLength(pending) > 2_000_000) throw new Error('NDJSON line exceeds 2 MB');
  };
  return {
    push(chunk: Uint8Array) {
      bytes += chunk.byteLength;
      if (bytes > 20_000_000) throw new Error('Search stream exceeds 20 MB');
      pending += decoder.decode(chunk, { stream: true }); parse();
    },
    finish() {
      pending += decoder.decode(); parse();
      if (pending.trim()) throw new Error('Search stream ended without a complete newline-delimited event');
      return bytes;
    },
  };
}

export function resultTimings(events: { event: StreamEvent; atMs: number }[], usefulUrls: ReadonlySet<string>) {
  let firstNonemptyMs: number | null = null, firstUsefulMs: number | null = null;
  let firstPartialMs: number | null = null, firstUsefulPartialMs: number | null = null, finalMs: number | null = null;
  let firstUsefulEvent: 'partial' | 'final' | null = null, finalResults = 0, finalUsefulResults = 0;
  for (const { event, atMs } of events) {
    if (finalMs !== null) throw new Error('Received an event after the final response');
    if (event.type === 'error') throw new Error(`Search stream error: ${event.error ?? 'unspecified'}`);
    const rows = event.response!.results;
    const useful = rows.filter((r) => typeof r.url === 'string' && usefulUrls.has(r.url)).length;
    if (rows.length) firstNonemptyMs ??= atMs;
    if (useful && firstUsefulMs === null) { firstUsefulMs = atMs; firstUsefulEvent = event.type; }
    if (event.type === 'partial') {
      firstPartialMs ??= atMs;
      if (useful) firstUsefulPartialMs ??= atMs;
    } else { finalMs = atMs; finalResults = rows.length; finalUsefulResults = useful; }
  }
  if (finalMs === null) throw new Error('Search stream has no final event');
  return { firstNonemptyMs, firstUsefulMs, firstUsefulEvent, firstPartialMs, firstUsefulPartialMs, finalMs, finalResults, finalUsefulResults };
}

async function worker() {
  const root = process.env.GLOGG_LATENCY_ROOT!;
  const profile = process.env.GLOGG_LATENCY_PROFILE as Profile;
  const active = new Set<Promise<Response>>();
  let calls: Record<string, number> = {};
  // No delegation to the real fetch, even for localhost. Reader/research routes are never exercised.
  globalThis.fetch = (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls[url.hostname] = (calls[url.hostname] ?? 0) + 1;
    const request = (async () => {
      const ms = url.hostname === 'hn.algolia.com' ? FIXTURE.hnDelayMs
        : profile === 'slow-answer' && url.hostname === 'api.duckduckgo.com' ? FIXTURE.answerDelayMs
        : profile === 'slow-noncore' && url.hostname === 'export.arxiv.org' ? FIXTURE.noncoreDelayMs : 0;
      if (ms) await delay(ms, undefined, { signal: init.signal ?? (input instanceof Request ? input.signal : undefined) });
      return url.hostname === 'hn.algolia.com' ? Response.json({ hits: FIXTURE.hits }) : new Response('', { status: 404 });
    })();
    active.add(request);
    void request.then(() => active.delete(request), () => active.delete(request));
    return request;
  };
  const search = await import(pathToFileURL(path.join(root, 'server/federatedSearch.ts')).href);
  const answers = await import(pathToFileURL(path.join(root, 'server/answerEngine.ts')).href);
  const { createGloggServer } = await import(pathToFileURL(path.join(root, 'server/index.ts')).href);
  const server = http.createServer(await createGloggServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let peakRssBytes = process.memoryUsage().rss, cpu = process.cpuUsage();
  const monitor = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 20);
  process.on('message', (message) => {
    if (message === 'prepare') void (async () => {
      await Promise.allSettled([...active]);
      if (profile !== 'warm-cache') { search.clearSearchCache(); search.resetSourceHealth(); answers.clearInstantAnswerCache(); }
      lag.reset(); peakRssBytes = process.memoryUsage().rss; cpu = process.cpuUsage(); calls = {};
      process.send?.({ ready: true });
    })().catch((error) => { console.error(error); process.exit(1); });
    if (message === 'stop') {
      const used = process.cpuUsage(cpu);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      process.send?.({ metrics: { peakRssBytes, cpuMs: (used.user + used.system) / 1000, eventLoopSamples: lag.count, eventLoopP95Ms: lag.count ? lag.percentile(95) / 1e6 : null, upstreamCalls: calls, outstandingFixtureRequestsAtFinal: active.size } });
      clearInterval(monitor); lag.disable(); server.closeAllConnections(); server.close(() => process.exit(0));
    }
  });
  process.send?.({ port: (server.address() as AddressInfo).port });
}

async function streamRequest(base: string) {
  const start = performance.now();
  const response = await fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ query: QUERY, compact: true, config: { lens: 'all', disabledSources: ['p2p', 'openlibrary'] } }), signal: AbortSignal.timeout(20_000) });
  const headersMs = performance.now() - start;
  if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/x-ndjson') || !response.body) {
    await response.body?.cancel();
    throw new Error(`Expected HTTP 200 NDJSON; received ${response.status} ${response.headers.get('content-type')}`);
  }
  const events: { event: StreamEvent; atMs: number }[] = [];
  const decoder = ndjsonDecoder((event) => events.push({ event, atMs: performance.now() - start }));
  const reader = response.body.getReader();
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; decoder.push(next.value); }
    const responseBytes = decoder.finish();
    const timings = resultTimings(events, USEFUL_URLS);
    if (!timings.finalUsefulResults) throw new Error('Final response contains none of the explicitly useful fixture URLs');
    return { headersMs, ...timings, responseBytes, events: events.map(({ event, atMs }) => ({ type: event.type, atMs, results: event.response?.results.length ?? 0 })) };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
    const deadline = setTimeout(() => { cleanup(); resolve(); }, 7000);
    const cleanup = () => { clearTimeout(hard); clearTimeout(deadline); child.off('exit', done); };
    const done = () => { cleanup(); resolve(); };
    child.once('exit', done); child.kill('SIGTERM');
  });
  if (child.exitCode === null && child.signalCode === null) throw new Error('Worker did not exit after SIGKILL');
}

async function sample(root: string, profile: Profile) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-latency-'));
  const child = fork(fileURLToPath(import.meta.url), [], {
    execArgv: ['--import', 'tsx'], cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: 'production', GLOGG_HOME: home, GLOGG_CONTAINER_RUNTIME: 'none', GLOGG_MODE: 'public', GLOGG_MAX_SEARCHES: '32', GLOGG_MAX_API_REQUESTS: '64', GLOGG_LATENCY_WORKER: '1', GLOGG_LATENCY_ROOT: root, GLOGG_LATENCY_PROFILE: profile },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const receive = <T>(key: string) => new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', error); };
    const message = (value: unknown) => { if (value && typeof value === 'object' && key in value) { cleanup(); resolve((value as Record<string, T>)[key]); } };
    const exited = () => { cleanup(); reject(new Error(`Latency worker exited waiting for ${key}: ${stderr}`)); };
    const error = (err: Error) => { cleanup(); reject(err); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Latency worker timed out waiting for ${key}: ${stderr}`)); }, 25_000);
    child.on('message', message); child.once('exit', exited); child.once('error', error);
  });
  try {
    const port = await receive<number>('port');
    const base = `http://127.0.0.1:${port}`;
    const capsResponse = await fetch(`${base}/api/capabilities`, { signal: AbortSignal.timeout(2000) });
    const caps = await capsResponse.json() as { mode?: string };
    if (!capsResponse.ok || caps.mode !== 'public') throw new Error('Latency worker must run in public mode');
    await streamRequest(base); // One full warmup per fresh child, never part of the measured sample.
    const ready = receive<boolean>('ready'); child.send('prepare'); await ready;
    const measured = await streamRequest(base);
    const metrics = receive<Record<string, unknown>>('metrics'); child.send('stop');
    return { ok: true as const, profile, ...measured, server: await metrics };
  } finally { await stopChild(child); fs.rmSync(home, { recursive: true, force: true }); }
}

function sourceIdentity(root: string) {
  const files: Record<string, string> = {};
  const walk = (relative: string) => {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && /\.(?:ts|tsx|json)$/.test(name)) files[name] = sha(fs.readFileSync(path.join(root, name)));
    }
  };
  for (const directory of ['server', 'src/core', 'plugins']) walk(directory);
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) files[name] = sha(fs.readFileSync(path.join(root, name)));
  const git = (args: string[]) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  return { gitHead: git(['rev-parse', 'HEAD']), gitStatus: git(['status', '--short']), manifestSha256: sha(JSON.stringify(files)), files };
}

export async function runLatencyBenchmark(args: string[]) {
  const options = latencyOptions(args);
  const identity = sourceIdentity(options.root);
  const samples: (Awaited<ReturnType<typeof sample>> | { ok: false; profile: Profile; error: string })[] = [];
  // Rotate profile order between repetitions to reduce systematic cache/order effects.
  for (let repetition = 0; repetition < options.samples; repetition++) {
    for (let i = 0; i < options.profiles.length; i++) {
      const profile = options.profiles[(i + repetition) % options.profiles.length];
      try { samples.push(await sample(options.root, profile)); }
      catch (error) { samples.push({ ok: false, profile, error: error instanceof Error ? error.message : String(error) }); }
      console.error(`Finished ${profile}, repetition ${repetition + 1}/${options.samples}`);
    }
  }
  const metrics = ['headersMs', 'firstNonemptyMs', 'firstUsefulMs', 'firstPartialMs', 'firstUsefulPartialMs', 'finalMs'] as const;
  const profiles = Object.fromEntries(options.profiles.map((profile) => {
    const passed = samples.filter((s): s is Awaited<ReturnType<typeof sample>> => s.ok && s.profile === profile);
    return [profile, { attempted: options.samples, passed: passed.length, failed: options.samples - passed.length, distributionsMs: Object.fromEntries(metrics.map((metric) => [metric, latencyDistribution(passed.flatMap((s) => typeof s[metric] === 'number' ? [s[metric] as number] : []))])) }];
  }));
  const after = sourceIdentity(options.root);
  const sourceUnchanged = identity.manifestSha256 === after.manifestSha256;
  const safeOptions = { ...options, root: path.relative(process.cwd(), options.root) || '.' };
  const report = {
    schema: 1, date: new Date().toISOString(), fixtureOnly: true, options: safeOptions,
    fixture: FIXTURE, fixtureSha256: sha(JSON.stringify(FIXTURE)), runnerSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    source: identity, sourceUnchanged, sourceManifestAfterSha256: after.manifestSha256,
    protocol: 'Fresh child per sample; one complete unmeasured HTTP warmup; pending fixture work drained; source/answer/health caches cleared except warm-cache; metrics reset; one measured HTTP NDJSON request. No live upstreams or visitor data.',
    interpretation: 'Known-useful means one of the eight explicit fixture URLs, not a relevance judgment of live results. Partial timings remain null when no partial exists. Startup, browser rendering, TLS, real providers and production concurrency are excluded; no capacity or general live-search claim.',
    environment: { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), loadAverageAtEnd: os.loadavg() },
    profiles, samples,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.output) { fs.mkdirSync(path.dirname(options.output), { recursive: true }); fs.writeFileSync(options.output, json); }
  return report;
}

if (process.env.GLOGG_LATENCY_WORKER === '1') void worker().catch((error) => { console.error(error); process.exit(1); });
else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void runLatencyBenchmark(process.argv.slice(2)).then((report) => {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.sourceUnchanged || report.samples.some((s) => !s.ok)) process.exitCode = 1;
}).catch((error) => { console.error(error); process.exitCode = 1; });
