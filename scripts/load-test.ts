/** Offline HTTP capacity experiment: real server/ranking, deterministic upstream fixtures, separate load driver. */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';

type Scenario = 'warm' | 'cold' | 'slow' | 'overload';
export function loadOptions(args: string[]) {
  const values = Object.fromEntries(args.map((arg) => {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Use --name=value, received ${arg}`);
    return [match[1], match[2]];
  }));
  for (const key of Object.keys(values)) if (!['root', 'scenario', 'samples', 'seconds', 'rps', 'max-searches', 'output'].includes(key)) throw new Error(`Unknown option: ${key}`);
  const positive = (key: string, fallback: number, max: number) => {
    const n = Number(values[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${key} must be an integer from 1 to ${max}`);
    return n;
  };
  const scenario = values.scenario ?? 'cold';
  if (!['warm', 'cold', 'slow', 'overload'].includes(scenario)) throw new Error('scenario must be warm, cold, slow or overload');
  return { root: path.resolve(values.root ?? '.'), scenario: scenario as Scenario, samples: positive('samples', 5, 100), seconds: positive('seconds', 5, 3600), rps: positive('rps', 58, 1000), maxSearches: positive('max-searches', 32, 1000), output: values.output };
}

export function distribution(values: number[]) {
  if (!values.length) return { count: 0, median: null, p95: null, p99: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => Math.round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] * 100) / 100;
  return { count: values.length, median: quantile(.5), p95: quantile(.95), p99: quantile(.99), min: quantile(0), max: quantile(1) };
}

async function worker() {
  const root = process.env.GLOGG_LOAD_ROOT!;
  const scenario = process.env.GLOGG_LOAD_SCENARIO as Scenario;
  let upstreamCalls = 0;
  // Every fetch is intercepted, including localhost services. No production endpoints or credentials.
  globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    upstreamCalls++;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'hn.algolia.com') return new Response('', { status: 404 });
    await delay(scenario === 'slow' ? 1500 : scenario === 'overload' ? 500 : 100, undefined, { signal: init.signal ?? undefined });
    const query = url.searchParams.get('query') || 'rust borrow checker';
    return Response.json({ hits: Array.from({ length: 8 }, (_, i) => ({ objectID: `${query}-${i}`, title: `${query}: lifetimes and references ${i}`, url: `https://notes${i}.example.org/${encodeURIComponent(query)}`, points: 30, num_comments: 4, created_at: '2020-04-01T00:00:00Z' })) });
  };
  const { createGloggServer } = await import(pathToFileURL(path.join(root, 'server/index.ts')).href);
  const server = http.createServer(await createGloggServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let peakRss = process.memoryUsage().rss;
  const sampleMemory = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  let cpu = process.cpuUsage();
  process.on('message', (message) => {
    if (message === 'measure') { lag.reset(); peakRss = process.memoryUsage().rss; cpu = process.cpuUsage(); upstreamCalls = 0; process.send?.({ measuring: true }); }
    if (message === 'stop') {
      const used = process.cpuUsage(cpu);
      process.send?.({ metrics: { peakRssBytes: peakRss, eventLoopP95Ms: lag.percentile(95) / 1e6, cpuMs: (used.user + used.system) / 1000, upstreamCalls } });
      clearInterval(sampleMemory); lag.disable();
      server.closeAllConnections(); server.close(() => process.exit(0));
    }
  });
  process.send?.({ port: (server.address() as AddressInfo).port });
}

async function sample(options: ReturnType<typeof loadOptions>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-load-'));
  const child = fork(fileURLToPath(import.meta.url), [], {
    execArgv: ['--import', 'tsx'], cwd: options.root,
    env: { PATH: process.env.PATH, NODE_ENV: 'production', GLOGG_HOME: home, GLOGG_CONTAINER_RUNTIME: 'none', GLOGG_LOAD_WORKER: '1', GLOGG_LOAD_ROOT: options.root, GLOGG_LOAD_SCENARIO: options.scenario, GLOGG_MAX_SEARCHES: String(options.maxSearches), GLOGG_MODE: 'public', GLOGG_MAX_API_REQUESTS: '64' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const receive = <T>(key: string) => new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
    const onMessage = (m: unknown) => { if (m && typeof m === 'object' && key in m) { cleanup(); resolve((m as Record<string, T>)[key]); } };
    const onExit = () => { cleanup(); reject(new Error(`Load server exited: ${stderr}`)); };
    const onError = (e: Error) => { cleanup(); reject(e); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Load server did not send ${key}: ${stderr}`)); }, 30_000);
    child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
  });
  try {
    const port = await receive<number>('port');
    const base = `http://127.0.0.1:${port}`;
    const capsResponse = await fetch(`${base}/api/capabilities`);
    const mode = capsResponse.headers.get('content-type')?.includes('application/json') ? (await capsResponse.json() as { mode: string }).mode : 'legacy-private';
    const query = (i: number) => `rust borrow checker topic${options.scenario === 'warm' ? i % 5 : i}`;
    const request = async (i: number) => {
      const res = await fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query(i), compact: true, config: { disabledSources: ['p2p', 'openlibrary'] } }), signal: AbortSignal.timeout(20_000) });
      const body = await res.json() as { results?: unknown[] };
      return { status: res.status, hasResults: Boolean(body.results?.length) };
    };
    for (let i = 0; i < 5; i++) await request(options.scenario === 'warm' ? i : -i - 1);
    const measuring = receive<boolean>('measuring'); child.send('measure'); await measuring;
    const latencies: number[] = [], health: number[] = [], schedulingLag: number[] = [];
    const statuses: Record<string, number> = {};
    let empty = 0, dropped = 0;
    const active = new Set<Promise<void>>();
    const start = performance.now();
    const count = options.rps * options.seconds;
    for (let i = 0; i < count; i++) {
      const scheduled = start + i * 1000 / options.rps;
      const wait = scheduled - performance.now();
      if (wait > 0) await delay(wait);
      schedulingLag.push(Math.max(0, performance.now() - scheduled));
      if (active.size >= 1024) { dropped++; continue; }
      const pending = request(i).then((r) => {
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        if (r.status === 200) { latencies.push(performance.now() - scheduled); if (!r.hasResults) empty++; }
      }, () => { statuses.networkError = (statuses.networkError ?? 0) + 1; }).finally(() => { active.delete(pending); });
      active.add(pending);
      if (i % options.rps === 0) {
        const at = performance.now();
        const probe = fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }).then(async (r) => { await r.text(); health.push(r.ok ? performance.now() - at : 2000); }, () => { health.push(2000); }).finally(() => { active.delete(probe); });
        active.add(probe);
      }
    }
    await Promise.all(active);
    await delay(Math.max(0, options.seconds * 1000 - (performance.now() - start)));
    const elapsed = (performance.now() - start) / 1000;
    const metrics = receive<Record<string, number>>('metrics'); child.send('stop');
    return { mode, offeredRequests: count, elapsedSeconds: elapsed, successfulRps: latencies.length / elapsed, statuses, emptySuccessfulResponses: empty, generatorDropped: dropped, successfulLatencyMs: distribution(latencies), schedulingLagMs: distribution(schedulingLag), healthLatencyMs: distribution(health), server: await metrics };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited; }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const options = loadOptions(process.argv.slice(2));
  const samples = [];
  for (let i = 0; i < options.samples; i++) {
    samples.push(await sample(options));
    console.error(`Finished ${options.scenario} sample ${i + 1}/${options.samples}`);
  }
  const safeOptions = { ...options, root: path.relative(process.cwd(), options.root) || '.' };
  const report = { schema: 1, date: new Date().toISOString(), fixtureOnly: true, workload: 'Real HTTP search and ranking; eight HN fixture results; all other upstreams return 404; no live network', environment: { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() }, options: safeOptions, samples, successfulRps: distribution(samples.map((s) => s.successfulRps)) };
  const json = JSON.stringify(report, null, 2);
  if (options.output) { fs.mkdirSync(path.dirname(options.output), { recursive: true }); fs.writeFileSync(options.output, json + '\n'); }
  console.log(json);
  if (samples.some((s) => s.generatorDropped || s.statuses.networkError || !s.statuses['200'] || s.emptySuccessfulResponses || (['warm', 'cold'].includes(options.scenario) && s.statuses['503']) || Object.keys(s.statuses).some((code) => !['200', '503'].includes(code)) || s.healthLatencyMs.max === 2000)) process.exitCode = 1;
}

if (process.env.GLOGG_LOAD_WORKER === '1') void worker().catch((e) => { console.error(e); process.exit(1); });
else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main().catch((e) => { console.error(e); process.exitCode = 1; });
