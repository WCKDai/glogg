import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LIVE_QUERIES, liveCoverage, liveOptions, liveStartDelay, observeLiveQuery, readLiveJson, runLiveBenchmark } from '../scripts/benchmark-live.js';

describe('opt-in public live observations', () => {
  it('requires an explicit HTTPS target and output file, allowing HTTP only for loopback tests', () => {
    expect(liveOptions(['--url=https://glogg.app/', '--output=report.json'])).toMatchObject({ url: 'https://glogg.app' });
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) expect(liveOptions([`--url=http://${host}`, '--output=report.json']).url).toBe(`http://${host}`);
    expect(() => liveOptions([])).toThrow(/Explicit/);
    expect(() => liveOptions(['--url=https://glogg.app'])).toThrow(/Explicit/);
    expect(() => liveOptions(['--output=report.json'])).toThrow(/Explicit/);
  });
  it.each([
    'http://glogg.app', 'http://localhost.evil.example', 'file:///tmp/server', 'glogg.app',
    'https://person:password@glogg.app', 'https://glogg.app/api/search', 'https://glogg.app?key=secret', 'https://glogg.app#token',
  ])('rejects unsafe or ambiguous target %s', (url) => {
    expect(() => liveOptions([`--url=${url}`, '--output=report.json'])).toThrow();
  });
  it.each(['--url=', '--output=', '--output= report.json', '--output=report.json\n', '--samples=2', '--queries=private', '--timeout=60000', '--headers=Authorization'])('rejects configuration that changes the bounded protocol: %s', (arg) => {
    expect(() => liveOptions(['--url=https://glogg.app', '--output=report.json', arg])).toThrow();
  });
  it('limits the catalog to six fixed author queries and never accepts visitor query arguments', () => {
    expect(LIVE_QUERIES).toHaveLength(6);
    expect(LIVE_QUERIES.map((query) => [query.query, query.lens])).toEqual([
      ['cat care', 'all'], ['猫の飼い方', 'all'], ['undo last git commit keep changes', 'all'],
      ['latest science news', 'raw-news'], ['ocean waves', 'images'], ['bicycle tyre repair', 'videos'],
    ]);
    expect(() => liveOptions(['--url=https://glogg.app', '--url=https://other.example', '--output=report.json'])).toThrow(/duplicate/);
  });
  it('paces starts five seconds apart while allowing a completed slow request to proceed', () => {
    expect(liveStartDelay(null, 0)).toBe(0);
    expect(liveStartDelay(100, 1100)).toBe(4000);
    expect(liveStartDelay(100, 5099.5)).toBe(.5);
    expect(liveStartDelay(100, 5100)).toBe(0);
    expect(liveStartDelay(100, 20_100)).toBe(0);
  });
  it('retains raw JSON and UTF-8 split across network chunks', async () => {
    const bytes = new TextEncoder().encode('{"results":[{"title":"猫"}]}');
    const split = bytes.indexOf(0xe7) + 1;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } }));
    expect(await readLiveJson(response)).toEqual({ json: { results: [{ title: '猫' }] }, bytes: bytes.length });
  });
  it('rejects oversized declared bodies before reading and cancels streamed overflow', async () => {
    const declaredCancel = vi.fn();
    const declared = new Response(new ReadableStream({ cancel: declaredCancel }), { headers: { 'Content-Length': '5000001' } });
    await expect(readLiveJson(declared)).rejects.toThrow(/Declared response exceeds/);
    expect(declaredCancel).toHaveBeenCalledOnce();
    const overflowCancel = vi.fn();
    const overflow = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"results":[]}')); }, cancel: overflowCancel }));
    await expect(readLiveJson(overflow, 5)).rejects.toThrow(/Response exceeds/);
    expect(overflowCancel).toHaveBeenCalledOnce();
  });
  it('rejects non-JSON and invalid UTF-8 instead of storing an HTML error page', async () => {
    await expect(readLiveJson(new Response('<html>error</html>'))).rejects.toThrow(/valid UTF-8 JSON/);
    await expect(readLiveJson(new Response(new Uint8Array([0xff])))).rejects.toThrow(/valid UTF-8 JSON/);
  });
  it('makes empty results, incomplete providers and missing coverage explicit', () => {
    expect(liveCoverage({ results: [], partial: true, metrics: { sourceTimings: { hn: { status: 'empty' }, ddg: { status: 'refused' }, arxiv: { status: 'late' } } } })).toEqual({
      resultCount: 0, emptyResults: true, partialResponse: true, providerStatusReported: true, reportedProviderCount: 3,
      statusCounts: { empty: 1, refused: 1, late: 1 }, unavailableOrLate: [{ source: 'ddg', status: 'refused' }, { source: 'arxiv', status: 'late' }],
    });
    expect(liveCoverage({ results: [{ title: 'A result' }] })).toMatchObject({ resultCount: 1, emptyResults: false, providerStatusReported: false, reportedProviderCount: 0 });
    expect(liveCoverage(null)).toMatchObject({ resultCount: null, emptyResults: null, providerStatusReported: false });
  });
  it('requests only public JSON, without auth, cookies, redirects or retries', async () => {
    const raw = { results: [{ title: 'Author fixture' }], metrics: { sourceTimings: { hn: { status: 'ok', count: 1 } } } };
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(raw));
    const observation = await observeLiveQuery('https://example.test', LIVE_QUERIES[0], request);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0][0])).toBe('https://example.test/api/search');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'manual', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    expect(Object.keys(request.mock.calls[0][1]!.headers!)).toHaveLength(2);
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ query: 'cat care', compact: true, config: { lens: 'all' } });
    expect(observation).toMatchObject({ outcome: 'observed', rawResponse: raw, http: { status: 200, ok: true }, measurement: { kind: 'unjudged-live-wall-clock' } });
    expect(observation).not.toHaveProperty('relevanceScore');
  });
  it('records HTTP and network failures as observations without retrying', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'busy' }, { status: 429 }));
    expect(await observeLiveQuery('https://example.test', LIVE_QUERIES[0], limited)).toMatchObject({ outcome: 'http-error', http: { status: 429 }, rawResponse: { error: 'busy' } });
    expect(limited).toHaveBeenCalledOnce();
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    expect(await observeLiveQuery('https://example.test', LIVE_QUERIES[0], failed)).toMatchObject({ outcome: 'request-error', http: null, rawResponse: null, error: 'offline' });
    expect(failed).toHaveBeenCalledOnce();
  });

  it('checkpoints six sequential observations with paced starts despite early timer wakeups and a slow response', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-live-test-'));
    const output = path.join(directory, 'nested', 'observations.json');
    let clock = 0, active = 0, peakActive = 0, earlyWakeups = 0;
    const starts: number[] = [];
    const queries: string[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const checkpoint = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(checkpoint.complete).toBe(false);
      expect(checkpoint.observations).toHaveLength(starts.length);
      starts.push(clock); queries.push(JSON.parse(init!.body as string).query);
      active++; peakActive = Math.max(peakActive, active);
      // A pending body is still an in-flight request, even after HTTP headers have arrived.
      return new Response(new ReadableStream({ async start(controller) {
        await Promise.resolve();
        clock += starts.length === 3 ? 7000 : 250;
        const json = JSON.stringify({ results: [], metrics: { sourceTimings: { hn: { status: 'empty' } } } });
        controller.enqueue(new TextEncoder().encode(json)); controller.close(); active--;
      } }), { headers: { 'Content-Type': 'application/json' } });
    });
    const wait = vi.fn(async (ms: number) => {
      expect(active).toBe(0);
      if (!earlyWakeups++) clock += ms - 1; // The orchestrator must wait the remaining millisecond.
      else clock += ms;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runLiveBenchmark(['--url=https://example.test', `--output=${output}`], { request, now: () => clock, wait });
      expect(peakActive).toBe(1);
      expect(request).toHaveBeenCalledTimes(6);
      expect(queries).toEqual(LIVE_QUERIES.map((query) => query.query));
      expect(starts).toEqual([0, 5000, 10_000, 17_000, 22_000, 27_000]);
      expect(wait).toHaveBeenCalledWith(1);
      expect(result.summary).toEqual({ output, observations: 6, requestErrors: 0, emptyResponses: 6 });
      const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(saved).toEqual(result.report);
      expect(saved).toMatchObject({ complete: true, finishedAt: expect.any(String), runnerSha256: expect.stringMatching(/^[a-f0-9]{64}$/), querySetSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    } finally { log.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves errors and partial coverage in a completed report without retrying or following redirects', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-live-test-'));
    const output = path.join(directory, 'observations.json');
    let clock = 0;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'busy' }, { status: 429 }))
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ results: [], partial: true, metrics: { sourceTimings: { ddg: { status: 'late' } } } }))
      .mockResolvedValueOnce(Response.json({ moved: true }, { status: 302, headers: { Location: 'https://must-not-follow.example' } }))
      .mockResolvedValueOnce(Response.json({ unexpected: 'schema' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { report, summary } = await runLiveBenchmark(['--url=https://example.test', `--output=${output}`], { request, now: () => clock, wait: async (ms) => { clock += ms; } });
      expect(request).toHaveBeenCalledTimes(6);
      expect(report.observations.map((observation) => observation.outcome)).toEqual(['http-error', 'request-error', 'invalid-json', 'observed', 'http-error', 'unexpected-response']);
      expect(report.observations[3].coverage).toMatchObject({ emptyResults: true, partialResponse: true, unavailableOrLate: [{ source: 'ddg', status: 'late' }] });
      expect(summary).toMatchObject({ observations: 6, requestErrors: 5, emptyResponses: 1 });
      expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ complete: true, observations: report.observations });
      expect(request.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
    } finally { log.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('leaves completed checkpoints readable after interruption and protects an existing report before networking', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-live-test-'));
    const output = path.join(directory, 'observations.json');
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ results: [] }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runLiveBenchmark(['--url=https://example.test', `--output=${output}`], { request, now: () => 0, wait: async () => { throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
      const checkpoint = fs.readFileSync(output, 'utf8');
      expect(JSON.parse(checkpoint)).toMatchObject({ complete: false, finishedAt: null, observations: [{ outcome: 'observed', rawResponse: { results: [] } }] });
      expect(request).toHaveBeenCalledOnce();
      await expect(runLiveBenchmark(['--url=https://example.test', `--output=${output}`], { request })).rejects.toThrow(/EEXIST/);
      expect(fs.readFileSync(output, 'utf8')).toBe(checkpoint);
      expect(request).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
