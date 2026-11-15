/** Six author queries, paced sequentially. This collects observations, not relevance judgments. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIVE_QUERIES = [
  { id: 'cat-care', query: 'cat care', lens: 'all' },
  { id: 'japanese-cat-care', query: '猫の飼い方', lens: 'all' },
  { id: 'git-undo', query: 'undo last git commit keep changes', lens: 'all' },
  { id: 'science-news', query: 'latest science news', lens: 'raw-news' },
  { id: 'ocean-images', query: 'ocean waves', lens: 'images' },
  { id: 'bicycle-videos', query: 'bicycle tyre repair', lens: 'videos' },
] as const;
const MIN_START_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const round = (value: number) => Math.round(value * 100) / 100;

export function liveOptions(args: string[]) {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--(url|output)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1]) || match[2].trim() !== match[2] || /[\u0000-\u001f\u007f]/.test(match[2])) throw new Error(`Unknown, duplicate or malformed option: ${arg.split('=')[0]}`);
    values[match[1]] = match[2];
  }
  if (!values.url || !values.output) throw new Error('Explicit --url=https://host and --output=report.json are required');
  let target: URL;
  try { target = new URL(values.url); } catch { throw new Error('url must be an absolute HTTPS origin (HTTP is allowed only for loopback tests)'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) throw new Error('url requires HTTPS, except HTTP on localhost/loopback');
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('url must be an origin without credentials, a path, query parameters or fragments');
  return { url: target.origin, output: path.resolve(values.output) };
}

/** Both the previous request finishing and this interval must permit the next start. */
export function liveStartDelay(lastStart: number | null, now: number): number {
  return lastStart === null ? 0 : Math.max(0, MIN_START_INTERVAL_MS - (now - lastStart));
}

class ResponseReadError extends Error {
  constructor(readonly kind: 'body-limit' | 'invalid-json', message: string, readonly bytesRead: number) { super(message); }
}

export async function readLiveJson(response: Response, limit = MAX_RESPONSE_BYTES): Promise<{ json: unknown; bytes: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Response byte limit must be a positive integer');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new ResponseReadError('body-limit', `Declared response exceeds ${limit} bytes`, 0);
  }
  if (!response.body) throw new ResponseReadError('invalid-json', 'Response has no JSON body', 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new ResponseReadError('body-limit', `Response exceeds ${limit} bytes`, bytes);
      chunks.push(next.value);
    }
    try { return { json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), bytes }; }
    catch { throw new ResponseReadError('invalid-json', 'Response is not valid UTF-8 JSON', bytes); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reports server-supplied coverage only. Missing status information is not inferred to be healthy. */
export function liveCoverage(response: unknown) {
  const body = isRecord(response) ? response : {};
  const metrics = isRecord(body.metrics) ? body.metrics : {};
  const timings = isRecord(metrics.sourceTimings) ? metrics.sourceTimings : null;
  const statusCounts: Record<string, number> = Object.create(null);
  const unavailableOrLate: { source: string; status: string }[] = [];
  for (const [source, timing] of Object.entries(timings ?? {})) {
    const status = isRecord(timing) && typeof timing.status === 'string' ? timing.status : 'unknown';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (['late', 'error', 'refused', 'unset', 'resting', 'unknown'].includes(status)) unavailableOrLate.push({ source, status });
  }
  return {
    resultCount: Array.isArray(body.results) ? body.results.length : null,
    emptyResults: Array.isArray(body.results) ? body.results.length === 0 : null,
    partialResponse: typeof body.partial === 'boolean' ? body.partial : null,
    providerStatusReported: timings !== null && Object.keys(timings).length > 0,
    reportedProviderCount: Object.keys(timings ?? {}).length,
    statusCounts,
    unavailableOrLate,
  };
}

/** One request only: no redirects, credentials, cookies, retry or derived follow-up query. */
export async function observeLiveQuery(target: string, query: typeof LIVE_QUERIES[number], request: typeof fetch = fetch) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let headersMs: number | null = null, bodyBytes: number | null = null;
  let http: { status: number; ok: boolean; contentType: string | null } | null = null;
  let rawResponse: unknown = null;
  let outcome = 'observed';
  let error: string | null = null;
  try {
    const response = await request(new URL('/api/search', target), {
      method: 'POST', redirect: 'manual', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: query.query, compact: true, config: { lens: query.lens } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    headersMs = round(performance.now() - start);
    http = { status: response.status, ok: response.ok, contentType: response.headers.get('content-type') };
    const read = await readLiveJson(response);
    rawResponse = read.json; bodyBytes = read.bytes;
    if (!response.ok) { outcome = 'http-error'; error = `HTTP ${response.status}`; }
    else if (!isRecord(rawResponse) || !Array.isArray(rawResponse.results)) { outcome = 'unexpected-response'; error = 'JSON response does not contain a results array'; }
  } catch (caught) {
    outcome = caught instanceof ResponseReadError ? caught.kind : 'request-error';
    if (caught instanceof ResponseReadError) bodyBytes = caught.bytesRead;
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    query, outcome, http, error,
    measurement: { kind: 'unjudged-live-wall-clock', startedAt, finishedAt: new Date().toISOString(), headersMs, totalMs: round(performance.now() - start), bodyBytes },
    coverage: liveCoverage(rawResponse),
    rawResponse,
  };
}

export async function runLiveBenchmark(args: string[], io: { request?: typeof fetch; now?: () => number; wait?: (ms: number) => Promise<void> } = {}) {
  const options = liveOptions(args);
  const now = io.now ?? performance.now.bind(performance);
  const pause = io.wait ?? delay;
  if (LIVE_QUERIES.length > 6) throw new Error('Live observations are limited to six author queries');
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  // Refuse to overwrite a prior observation; establish a writable destination before any request.
  fs.closeSync(fs.openSync(options.output, 'wx', 0o600));
  const report = {
    schema: 1, startedAt: new Date().toISOString(), finishedAt: null as string | null, complete: false,
    target: options.url, runnerSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    querySetSha256: sha(JSON.stringify(LIVE_QUERIES)), queries: LIVE_QUERIES,
    protocol: { maxRequests: 6, maxInFlight: 1, minimumStartIntervalMs: MIN_START_INTERVAL_MS, timeoutMs: REQUEST_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES, retries: 0, redirects: 'manual', credentials: 'omit' },
    interpretation: 'Unjudged observations of six fixed author-selected synthetic queries, never visitor queries. Raw public JSON is retained. Wall-clock latency, empty results and reported provider failures are observations, not relevance scores, throughput estimates or release gates. A completed report can contain failed requests.',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    observations: [] as Awaited<ReturnType<typeof observeLiveQuery>>[],
  };
  const save = () => fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save();
  let lastStart: number | null = null;
  for (const query of LIVE_QUERIES) {
    // Recheck after waking so a timer firing slightly early cannot breach the five-second minimum.
    for (let wait = liveStartDelay(lastStart, now()); wait > 0; wait = liveStartDelay(lastStart, now())) await pause(Math.ceil(wait));
    lastStart = now();
    const observation = await observeLiveQuery(options.url, query, io.request);
    report.observations.push(observation); save();
    console.error(`${query.id}: ${observation.outcome}, HTTP ${observation.http?.status ?? 'unavailable'}, results ${observation.coverage.resultCount ?? 'unreported'}`);
  }
  report.complete = true; report.finishedAt = new Date().toISOString(); save();
  const requestErrors = report.observations.filter((item) => item.outcome !== 'observed').length;
  return { report, summary: { output: options.output, observations: report.observations.length, requestErrors, emptyResponses: report.observations.filter((item) => item.coverage.emptyResults === true).length } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void runLiveBenchmark(process.argv.slice(2)).then(({ summary }) => {
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (summary.requestErrors) process.exitCode = 1;
}).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
