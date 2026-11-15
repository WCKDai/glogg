import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { LATENCY_PROFILES, latencyDistribution, latencyOptions, ndjsonDecoder, resultTimings, runLatencyBenchmark, type StreamEvent } from '../scripts/benchmark-latency.js';

describe('offline HTTP latency experiment', () => {
  it('defaults to five repetitions of every profile, with no production URL option', () => {
    expect(latencyOptions([])).toMatchObject({ samples: 5, profiles: [...LATENCY_PROFILES] });
    expect(latencyOptions(['--profile=slow-answer', '--samples=7', '--root=.', '--output=.tmp/report.json'])).toMatchObject({ samples: 7, profiles: ['slow-answer'], output: '.tmp/report.json' });
  });
  it.each(['--url=https://glogg.app', '--samples=0', '--samples=101', '--samples=NaN', '--samples=1.5', '--profile=live', '--output=', '--samples'])('rejects unsafe or ambiguous configuration: %s', (arg) => {
    expect(() => latencyOptions([arg])).toThrow();
  });
  it('rejects duplicate options', () => {
    expect(() => latencyOptions(['--samples=5', '--samples=1'])).toThrow(/duplicate/);
  });
  it('reports missing observations as null and nearest-rank distributions with dispersion', () => {
    expect(latencyDistribution([])).toEqual({ count: 0, median: null, p95: null, min: null, max: null, medianAbsoluteDeviation: null });
    expect(latencyDistribution([8, 2, 4, 1, 3])).toEqual({ count: 5, median: 3, p95: 8, min: 1, max: 8, medianAbsoluteDeviation: 1 });
    expect(() => latencyDistribution([NaN])).toThrow();
    expect(() => latencyDistribution([-1])).toThrow();
  });
  it('decodes split UTF-8 and several events per chunk without duplicating or dropping events', () => {
    const expected: StreamEvent[] = [{ type: 'partial', response: { results: [{ url: 'https://例.example/猫' }] } }, { type: 'final', response: { results: [{ url: 'https://例.example/猫' }] } }];
    const bytes = new TextEncoder().encode(expected.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const got: StreamEvent[] = [];
    const decoder = ndjsonDecoder((event) => got.push(event));
    const split = bytes.indexOf(0xe4) + 1;
    decoder.push(bytes.slice(0, split)); decoder.push(bytes.slice(split, split + 1)); decoder.push(bytes.slice(split + 1));
    expect(decoder.finish()).toBe(bytes.length);
    expect(got).toEqual(expected);
  });
  it('rejects truncated, oversized and invalid event streams', () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    const truncated = ndjsonDecoder(() => {});
    truncated.push(encode('{"type":"final","response":{"results":[]}}'));
    expect(() => truncated.finish()).toThrow(/complete newline/);
    expect(() => ndjsonDecoder(() => {}).push(encode('{"type":"final"}\n'))).toThrow(/Invalid search/);
    expect(() => ndjsonDecoder(() => {}).push(encode('x'.repeat(2_000_001)))).toThrow(/2 MB/);
  });
  it('keeps an irrelevant early batch separate from the first known-useful result', () => {
    const timings = resultTimings([
      { atMs: 20, event: { type: 'partial', response: { results: [{ url: 'https://unrelated.example' }] } } },
      { atMs: 90, event: { type: 'final', response: { results: [{ url: 'https://useful.example' }] } } },
    ], new Set(['https://useful.example']));
    expect(timings).toEqual({ firstNonemptyMs: 20, firstUsefulMs: 90, firstUsefulEvent: 'final', firstPartialMs: 20, firstUsefulPartialMs: null, finalMs: 90, finalResults: 1, finalUsefulResults: 1 });
  });
  it('does not invent partial delivery when a final response is the first result', () => {
    expect(resultTimings([{ atMs: 12, event: { type: 'final', response: { results: [{ url: 'u' }] } } }], new Set(['u']))).toMatchObject({ firstUsefulEvent: 'final', firstUsefulMs: 12, firstPartialMs: null, firstUsefulPartialMs: null });
    expect(resultTimings([{ atMs: 12, event: { type: 'final', response: { results: [] } } }], new Set())).toMatchObject({ firstUsefulMs: null, firstNonemptyMs: null, finalResults: 0 });
  });
  it('rejects incomplete streams, errors and events arriving after final', () => {
    expect(() => resultTimings([], new Set())).toThrow(/no final/);
    expect(() => resultTimings([{ atMs: 1, event: { type: 'error', error: 'busy' } }], new Set())).toThrow(/busy/);
    expect(() => resultTimings([{ atMs: 1, event: { type: 'final', response: { results: [] } } }, { atMs: 2, event: { type: 'partial', response: { results: [] } } }], new Set())).toThrow(/after the final/);
  });

  it('runs isolated HTTP workers for every profile, records provenance and cleans up their homes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-benchmark-test-'));
    const output = path.join(directory, 'nested', 'report.json');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const homesBefore = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('glogg-latency-')).sort();
    const realFetch = globalThis.fetch;
    const requests: URL[] = [];
    const fetchGuard = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !['/api/capabilities', '/api/search'].includes(url.pathname)) throw new Error('The offline benchmark attempted a non-worker request');
      requests.push(url);
      return realFetch(input, init);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await runLatencyBenchmark([`--root=${root}`, '--samples=1', '--profile=all', `--output=${output}`]);
      expect(report.sourceUnchanged).toBe(true);
      expect(report.samples).toHaveLength(4);
      expect(fs.readFileSync(output, 'utf8')).toBe(JSON.stringify(report, null, 2) + '\n');
      expect(report.source.files['server/index.ts']).toMatch(/^[a-f0-9]{64}$/);
      expect(report.runnerSha256).toBe(createHash('sha256').update(fs.readFileSync(new URL('../scripts/benchmark-latency.ts', import.meta.url))).digest('hex'));
      for (const sample of report.samples) {
        expect(sample.ok).toBe(true);
        if (!sample.ok) throw new Error(sample.error);
        expect(sample.finalUsefulResults).toBe(8);
        expect(sample.responseBytes).toBeGreaterThan(0);
        expect(sample.headersMs).toBeLessThanOrEqual(sample.finalMs);
        expect(sample.server.peakRssBytes).toBeGreaterThan(0);
        if (sample.profile === 'warm-cache') expect(sample.server.upstreamCalls).toEqual({});
        else expect(sample.server.upstreamCalls).toMatchObject({ 'hn.algolia.com': 1, localhost: 1 });
        if (sample.profile.startsWith('slow-')) {
          expect(sample.firstUsefulEvent).toBe('partial');
          expect(sample.firstUsefulPartialMs).toBeLessThan(sample.finalMs);
        } else {
          expect(sample.firstUsefulEvent).toBe('final');
          expect(sample.firstUsefulPartialMs).toBeNull();
        }
        expect(report.profiles[sample.profile]).toMatchObject({ attempted: 1, passed: 1, failed: 0 });
      }
      // Each fresh worker receives one capability check, one unmeasured warmup, and one measured search.
      expect(requests.filter((url) => url.pathname === '/api/search')).toHaveLength(8);
      expect(new Set(requests.map((url) => url.port)).size).toBe(4);
      expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('glogg-latency-')).sort()).toEqual(homesBefore);
    } finally { fetchGuard.mockRestore(); log.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('records a worker validation failure without inventing latency observations or leaking its home', async () => {
    const homesBefore = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('glogg-latency-')).sort();
    const fetchGuard = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ mode: 'private' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await runLatencyBenchmark([`--root=${fileURLToPath(new URL('..', import.meta.url))}`, '--samples=1', '--profile=warm-cache']);
      expect(report.samples).toEqual([{ ok: false, profile: 'warm-cache', error: 'Latency worker must run in public mode' }]);
      expect(report.profiles['warm-cache']).toMatchObject({ attempted: 1, passed: 0, failed: 1, distributionsMs: { firstUsefulMs: { count: 0, median: null }, finalMs: { count: 0, median: null } } });
      expect(fetchGuard).toHaveBeenCalledOnce();
      expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('glogg-latency-')).sort()).toEqual(homesBefore);
    } finally { fetchGuard.mockRestore(); log.mockRestore(); }
  }, 10_000);
});
