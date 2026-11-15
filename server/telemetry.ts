import { createHash, timingSafeEqual } from 'node:crypto';
import type { SourceTiming } from './federatedSearch.js';

const RING_SIZE = 512;
const SLOW_SEARCH_MS = 1500;
const SAFE_SOURCE_KEY = /^[a-zA-Z0-9_-]{1,32}$/;
const MAX_SOURCE_KEYS = 64;

class LatencyRing {
  private readonly values = new Float64Array(RING_SIZE);
  private index = 0;
  private filled = 0;
  private totalCount = 0;

  push(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.values[this.index] = ms;
    this.index = (this.index + 1) % RING_SIZE;
    if (this.filled < RING_SIZE) this.filled += 1;
    this.totalCount += 1;
  }

  summary(): { count: number; p50: number | null; p95: number | null; max: number | null } {
    if (this.filled === 0) return { count: 0, p50: null, p95: null, max: null };
    const sample = Array.from(this.values.subarray(0, this.filled)).sort((a, b) => a - b);
    const pick = (q: number) => Math.round(sample[Math.min(sample.length - 1, Math.floor((sample.length - 1) * q))] * 100) / 100;
    return {
      count: this.totalCount,
      p50: pick(0.5),
      p95: pick(0.95),
      max: Math.round(sample[sample.length - 1] * 100) / 100,
    };
  }

  reset(): void {
    this.values.fill(0);
    this.index = 0;
    this.filled = 0;
    this.totalCount = 0;
  }
}

export interface SourceStatusCounts {
  ok: number;
  empty: number;
  refused: number;
  late: number;
  error: number;
  resting: number;
  off: number;
}

const emptySourceCounts = (): SourceStatusCounts => ({
  ok: 0,
  empty: 0,
  refused: 0,
  late: 0,
  error: 0,
  resting: 0,
  off: 0,
});

let startedAt = new Date().toISOString();
const searches = {
  admitted: 0,
  completed: 0,
  partialResponses: 0,
  slowSearches: 0,
  emptyResults: 0,
  rejectedBusy: 0,
  errors: 0,
};
const http = { rejectedBusy: 0 };
const cache = { hits: 0, misses: 0, coalesced: 0, entries: 0 };
const firstPartialRing = new LatencyRing();
const finalRing = new LatencyRing();
const sources = new Map<string, SourceStatusCounts>();

export function resetTelemetry(): void {
  startedAt = new Date().toISOString();
  searches.admitted = 0;
  searches.completed = 0;
  searches.partialResponses = 0;
  searches.slowSearches = 0;
  searches.emptyResults = 0;
  searches.rejectedBusy = 0;
  searches.errors = 0;
  http.rejectedBusy = 0;
  cache.hits = 0;
  cache.misses = 0;
  cache.coalesced = 0;
  cache.entries = 0;
  firstPartialRing.reset();
  finalRing.reset();
  sources.clear();
}

export function recordHttpBusy(): void {
  http.rejectedBusy += 1;
}

export function recordSearchAdmitted(): void {
  searches.admitted += 1;
}

export function recordSearchBusy(): void {
  searches.rejectedBusy += 1;
}

export function recordSearchError(): void {
  searches.errors += 1;
}

export function recordCacheLookup(kind: 'hit' | 'miss' | 'coalesced', entries: number): void {
  if (kind === 'hit') cache.hits += 1;
  else if (kind === 'miss') cache.misses += 1;
  else cache.coalesced += 1;
  cache.entries = Math.max(0, entries);
}

export function recordCacheEntries(entries: number): void {
  cache.entries = Math.max(0, entries);
}

export function recordSearchCompleted(outcome: {
  durationMs: number;
  firstPartialMs?: number;
  surfacedCount: number;
  timings?: Record<string, SourceTiming>;
}): void {
  searches.completed += 1;
  if (outcome.firstPartialMs !== undefined) {
    searches.partialResponses += 1;
    firstPartialRing.push(outcome.firstPartialMs);
  }
  finalRing.push(outcome.durationMs);
  if (outcome.durationMs >= SLOW_SEARCH_MS) searches.slowSearches += 1;
  if (outcome.surfacedCount === 0) searches.emptyResults += 1;

  for (const [key, timing] of Object.entries(outcome.timings ?? {})) {
    if (!SAFE_SOURCE_KEY.test(key)) continue;
    let bucket = sources.get(key);
    if (!bucket) {
      if (sources.size >= MAX_SOURCE_KEYS) continue;
      bucket = emptySourceCounts();
      sources.set(key, bucket);
    }
    if (timing.status === 'ok') bucket.ok += 1;
    else if (timing.status === 'empty') bucket.empty += 1;
    else if (timing.status === 'refused') bucket.refused += 1;
    else if (timing.status === 'late') bucket.late += 1;
    else if (timing.status === 'error') bucket.error += 1;
    else if (timing.status === 'resting') bucket.resting += 1;
    else if (timing.status === 'off') bucket.off += 1;
  }
}

export function getTelemetrySnapshot() {
  return {
    startedAt,
    searches: { ...searches },
    http: { ...http },
    cache: { ...cache },
    latencyMs: {
      firstPartial: firstPartialRing.summary(),
      final: finalRing.summary(),
    },
    sources: Object.fromEntries([...sources.entries()].map(([k, v]) => [k, { ...v }])),
  };
}

export function hasValidTelemetryToken(
  authorizationHeader: string | string[] | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  const configured = env.GLOGG_TELEMETRY_TOKEN?.trim() || '';
  if (configured.length < 16) return false;
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!match) return false;
  const actualDigest = createHash('sha256').update(match[1]).digest();
  const expectedDigest = createHash('sha256').update(configured).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
