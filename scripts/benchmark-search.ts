/** Offline, provisionally judged search cases. No provider requests or visitor queries. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diversifyAndRankResults } from '../src/core/ranker.js';
import { inferFreshness } from '../src/core/freshness.js';
import { parseQueryOperators } from '../src/core/queryCompiler.js';
import type { RawSearchResult, SearchFilterConfig, SearchLensId } from '../src/core/types.js';

export interface JudgedCandidate extends RawSearchResult { id: string; grade: number; judgment: string }
export interface SearchCase {
  id: string; query: string; lens?: SearchLensId; expectedFreshness: 'none' | 'news' | 'current';
  rationale: string; config?: Partial<SearchFilterConfig>; candidates?: JudgedCandidate[];
  expect?: { first?: string; include?: string[]; exclude?: string[] };
}
interface Corpus { schemaVersion: number; asOf: string; judging: string; cases: SearchCase[] }
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Missing useful candidates count against recall and nDCG. Empty/irrelevant pools are not successes. */
export function rankingMetrics(candidates: { id: string; grade: number }[], surfaced: string[], k = 5) {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('k must be a positive integer');
  const grades = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.id || grades.has(candidate.id) || !Number.isInteger(candidate.grade) || candidate.grade < 0 || candidate.grade > 3) throw new Error('Candidate IDs must be unique and grades must be integers from 0 to 3');
    grades.set(candidate.id, candidate.grade);
  }
  if (new Set(surfaced).size !== surfaced.length || surfaced.some((id) => !grades.has(id))) throw new Error('Ranked IDs must be unique judged candidates');
  const dcg = (values: number[]) => values.slice(0, k).reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
  const usefulIds = candidates.filter((r) => r.grade >= 2).map((r) => r.id);
  const top = surfaced.slice(0, k);
  const first = surfaced.findIndex((id) => grades.get(id)! >= 2);
  const ideal = dcg([...grades.values()].sort((a, b) => b - a));
  return {
    judgedCandidates: candidates.length, usefulCandidates: usefulIds.length,
    surfacedResults: surfaced.length, usefulSurfaced: surfaced.filter((id) => grades.get(id)! >= 2).length,
    // Precision uses the actual returned slots (up to k); short pages are exposed by recall/counts.
    usefulPrecisionAt5: top.length ? top.filter((id) => grades.get(id)! >= 2).length / top.length : 0,
    usefulRecall: usefulIds.length ? usefulIds.filter((id) => surfaced.includes(id)).length / usefulIds.length : null,
    nDCGAt5: ideal ? dcg(surfaced.map((id) => grades.get(id)!)) / ideal : null,
    firstUsefulRank: first < 0 ? null : first + 1,
    missingUsefulIds: usefulIds.filter((id) => !surfaced.includes(id)),
  };
}

export function evaluateSearchCase(test: SearchCase, now: number) {
  const lens = test.lens ?? 'all';
  const freshness = inferFreshness(test.query, lens, now) ?? 'none';
  const failures: string[] = [];
  if (freshness !== test.expectedFreshness) failures.push(`freshness: expected ${test.expectedFreshness}, received ${freshness}`);
  if (!test.candidates) return { id: test.id, query: test.query, lens, freshness, failures, metrics: null };
  const ops = parseQueryOperators(test.query);
  const config = { ...test.config, lens, onlySites: ops.sites, excludeSites: ops.notSites, excludeWords: ops.without, phrases: ops.phrases };
  try {
    const raw = test.candidates.map(({ grade: _grade, judgment: _judgment, ...item }) => item);
    const ranked = diversifyAndRankResults(raw, config, ops.text, freshness === 'none' ? undefined : { intent: freshness, now });
    const ids = ranked.surfaced.map((r) => r.id);
    if (test.expect?.first && ids[0] !== test.expect.first) failures.push(`first: expected ${test.expect.first}, received ${ids[0] ?? 'empty'}`);
    for (const id of test.expect?.include ?? []) if (!ids.includes(id)) failures.push(`missing: ${id}`);
    for (const id of test.expect?.exclude ?? []) if (ids.includes(id)) failures.push(`unexpected: ${id}`);
    return {
      id: test.id, query: test.query, lens, freshness, failures,
      metrics: rankingMetrics(test.candidates, ids), surfaced: ids,
      filtered: ranked.filteredSlop.map((r) => ({ id: r.id, reason: r.demotedReason })),
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { id: test.id, query: test.query, lens, freshness, failures: [...failures, message], error: message, metrics: rankingMetrics(test.candidates, []), surfaced: [] };
  }
}

export function validateCorpus(corpus: Corpus) {
  if (corpus.schemaVersion !== 1 || !Number.isFinite(Date.parse(corpus.asOf)) || !corpus.judging || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error('Invalid benchmark corpus');
  const ids = new Set<string>();
  for (const test of corpus.cases) {
    if (!test.id || ids.has(test.id) || !test.query || !test.rationale || !['none', 'news', 'current'].includes(test.expectedFreshness)) throw new Error(`Invalid or duplicate case: ${test.id}`);
    ids.add(test.id);
    if (test.candidates) {
      rankingMetrics(test.candidates, []);
      if (test.candidates.some((r) => !r.judgment || !r.url || !r.title || !r.source)) throw new Error(`Unjudged candidate: ${test.id}`);
      const expected = [test.expect?.first, ...test.expect?.include ?? [], ...test.expect?.exclude ?? []].filter(Boolean);
      if (expected.some((id) => !test.candidates!.some((r) => r.id === id))) throw new Error(`Unknown expected candidate: ${test.id}`);
    }
  }
}

export function runSearchBenchmark(args = process.argv.slice(2)) {
  if (args.some((a) => a !== '--assert' && !/^--output=.+/.test(a)) || args.filter((a) => a.startsWith('--output=')).length > 1) throw new Error('Usage: tsx scripts/benchmark-search.ts [--output=report.json] [--assert]');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = fs.readFileSync(path.join(root, 'benchmarks/search/cases.json'));
  const corpus = JSON.parse(fixture.toString()) as Corpus;
  validateCorpus(corpus);
  const results = corpus.cases.map((test) => evaluateSearchCase(test, Date.parse(corpus.asOf)));
  const ranking = results.flatMap((r) => r.metrics ? [r.metrics] : []);
  const coreDir = path.join(root, 'src/core');
  const sourceHashes = Object.fromEntries(fs.readdirSync(coreDir).filter((f) => f.endsWith('.ts')).sort().map((f) => [`src/core/${f}`, sha(fs.readFileSync(path.join(coreDir, f)))]));
  const report = {
    schemaVersion: 1, kind: 'offline-judged-ranking', recordedAt: new Date().toISOString(), asOf: corpus.asOf,
    judging: corpus.judging, fixtureSha256: sha(fixture), runnerSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirtyFiles: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    node: process.version, sourceHashes,
    summary: {
      cases: results.length, rankingCases: ranking.length, passingCases: results.filter((r) => !r.failures.length).length,
      errors: results.filter((r) => 'error' in r).length,
      meanNDCGAt5: mean(ranking.flatMap((r) => r.nDCGAt5 === null ? [] : [r.nDCGAt5])),
      meanUsefulPrecisionAt5: mean(ranking.map((r) => r.usefulPrecisionAt5)),
      meanUsefulRecall: mean(ranking.flatMap((r) => r.usefulRecall === null ? [] : [r.usefulRecall])),
      casesWithoutUsefulCandidates: ranking.filter((r) => !r.usefulCandidates).length,
      casesWithUsefulResults: ranking.filter((r) => r.firstUsefulRank !== null).length,
    }, results,
  };
  const output = args.find((a) => a.startsWith('--output='))?.slice(9);
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify({ summary: report.summary, failures: results.filter((r) => r.failures.length).map(({ id, failures }) => ({ id, failures })), output }, null, 2));
  if (args.includes('--assert') && results.some((r) => r.failures.length)) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSearchBenchmark();
