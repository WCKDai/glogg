import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSearchCase, rankingMetrics, runSearchBenchmark, validateCorpus, type SearchCase } from '../scripts/benchmark-search.js';

describe('judged search metrics', () => {
  const pool = [{ id: 'direct', grade: 3 }, { id: 'support', grade: 2 }, { id: 'noise', grade: 0 }];
  it('gives ideal order full nDCG but counts irrelevant returned results in precision', () => {
    expect(rankingMetrics(pool, ['direct', 'support', 'noise'])).toMatchObject({ nDCGAt5: 1, usefulRecall: 1, usefulPrecisionAt5: 2 / 3, firstUsefulRank: 1 });
  });
  it('penalizes weak order and missing useful candidates independently', () => {
    const wrongOrder = rankingMetrics(pool, ['noise', 'support', 'direct']);
    expect(wrongOrder.nDCGAt5).toBeLessThan(1);
    expect(wrongOrder.usefulRecall).toBe(1);
    expect(wrongOrder.firstUsefulRank).toBe(2);
    expect(rankingMetrics(pool, ['support'])).toMatchObject({ usefulRecall: .5, usefulPrecisionAt5: 1, missingUsefulIds: ['direct'] });
  });
  it('does not silently drop crashes or empty result pages from graded denominators', () => {
    expect(rankingMetrics(pool, [])).toMatchObject({ nDCGAt5: 0, usefulRecall: 0, usefulPrecisionAt5: 0, firstUsefulRank: null });
  });
  it('reports missing retrieval coverage without inventing a ranking success', () => {
    expect(rankingMetrics([{ id: 'noise', grade: 0 }], ['noise'])).toMatchObject({ nDCGAt5: null, usefulRecall: null, usefulCandidates: 0, firstUsefulRank: null });
  });
  it('rejects invalid judgments and invented or duplicated ranked IDs', () => {
    expect(() => rankingMetrics([{ id: 'a', grade: 4 }], [])).toThrow();
    expect(() => rankingMetrics([{ id: 'a', grade: 2 }, { id: 'a', grade: 1 }], [])).toThrow();
    expect(() => rankingMetrics(pool, ['missing'])).toThrow();
    expect(() => rankingMetrics(pool, ['direct', 'direct'])).toThrow();
    expect(() => rankingMetrics(pool, [], 0)).toThrow();
  });
  it('requires a reproducible clock and explicit judging context', () => {
    expect(() => validateCorpus({ schemaVersion: 1, asOf: 'invalid', judging: '', cases: [] })).toThrow();
  });
});

describe('quality report workflow', () => {
  it('runs every frozen case and writes inspectable evidence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glogg-quality-report-'));
    try {
      const output = path.join(directory, 'report.json');
      const report = runSearchBenchmark([`--output=${output}`]);
      expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(report);
      expect(report.summary.cases).toBe(31);
      expect(report.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.sourceHashes['src/core/ranker.ts']).toMatch(/^[a-f0-9]{64}$/);
      expect(report.summary.rankingCases).toBe(21);
      expect(report.results.find((r) => r.id === 'site-constraint')?.metrics?.usefulCandidates).toBe(2);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('records crashes without aborting the rest of an experiment', () => {
    const broken: SearchCase = { id: 'broken', query: 'cat care', expectedFreshness: 'none', rationale: 'Malformed provider field', candidates: [{ id: 'a', title: null as unknown as string, url: 'https://notes.example/cat', snippet: 'cat care', source: 'web', grade: 3, judgment: 'Useful if well formed' }] };
    const report = evaluateSearchCase(broken, Date.parse('2026-11-15T12:00:00Z'));
    expect(report.failures.join()).toContain('TypeError');
    expect(report.metrics?.nDCGAt5).toBe(0);
    expect(report.metrics?.missingUsefulIds).toEqual(['a']);
  });
  it('rejects misspelled CLI options and duplicate report destinations', () => {
    expect(() => runSearchBenchmark(['--asert'])).toThrow('Usage');
    expect(() => runSearchBenchmark(['--output=a', '--output=b'])).toThrow('Usage');
  });
  it('rejects ambiguous labels and references before evaluating production code', () => {
    const test: SearchCase = { id: 'case', query: 'cat care', expectedFreshness: 'none', rationale: 'Boundary check', candidates: [{ id: 'cat', title: 'Cat care', url: 'https://notes.example/', snippet: 'Daily routine', source: 'web', grade: 3, judgment: 'Direct answer' }] };
    const corpus = { schemaVersion: 1, asOf: '2026-11-15T12:00:00Z', judging: 'provisional', cases: [test] };
    expect(() => validateCorpus(corpus)).not.toThrow();
    expect(() => validateCorpus({ ...corpus, cases: [test, test] })).toThrow();
    expect(() => validateCorpus({ ...corpus, cases: [{ ...test, expect: { first: 'unknown' } }] })).toThrow();
    expect(() => validateCorpus({ ...corpus, cases: [{ ...test, candidates: [{ ...test.candidates![0], judgment: '' }] }] })).toThrow();
  });
});
