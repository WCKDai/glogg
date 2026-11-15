import { describe, expect, it } from 'vitest';
import { analyzeQueryIntent, computeQueryRelevance } from '../src/core/queryIntelligence.js';
import { diversifyAndRankResults } from '../src/core/ranker.js';

const relevance = (query: string, title: string) => computeQueryRelevance(query, title, '', 'https://notes.example/').relevanceScore;

describe('query matching at real word boundaries', () => {
  it.each([['cat', 'Education'], ['care', 'Career planning'], ['rust', 'Rustic furniture'], ['art', 'Articles about economics']])('%s does not match %s', (query, title) => {
    expect(relevance(query, title)).toBe(0);
  });
  it('prefers an actual answer over an authoritative unrelated substring match', () => {
    const ranked = diversifyAndRankResults([
      { id: 'wrong', title: 'Education career planning', url: 'https://www.nasa.gov/education/careers', snippet: 'Education careers in engineering and research.', source: 'web' },
      { id: 'answer', title: 'Keeping your cat healthy', url: 'https://mira.example/pets', snippet: 'Practical cat care: feeding, vaccinations and veterinary appointments.', source: 'web' },
    ], {}, 'cat care');
    expect(ranked.surfaced.map((r) => r.id)).toEqual(['answer']);
  });
  it.each([['cat', 'Cats'], ['cats', 'Cat'], ['undo', 'Undoing'], ['commit', 'Commits'], ['install', 'Installation'], ['C++', 'C++ reference'], ['C#', 'C# reference'], ['node.js', 'Node.js documentation'], ['HL-L2350DW', 'Brother HL-L2350DW manual']])('preserves intended word forms and technical terms: %s', (query, title) => {
    expect(relevance(query, title)).toBeGreaterThanOrEqual(34);
  });
  it.each(['猫の飼い方', 'الطقس', 'afkalkning', 'café'])('keeps relevant terms and rejects unrelated pages for %s', (query) => {
    expect(analyzeQueryIntent(query).coreKeywords).toContain(query);
    expect(relevance(query, query)).toBeGreaterThanOrEqual(34);
    expect(relevance(query, 'NASA Mars research')).toBe(0);
  });
  it('matches a Japanese sequence embedded in a title and normalizes combining accents', () => {
    expect(relevance('猫の飼い方', '初心者のための猫の飼い方ガイド')).toBeGreaterThanOrEqual(34);
    expect(relevance('café', 'Cafe\u0301 brewing notes')).toBeGreaterThanOrEqual(34);
  });
  it.each([['run', 'Running'], ['stop', 'Stopping'], ['fit', 'Fitting'], ['swim', 'Swimming'], ['plan', 'Planning'], ['dry', 'Drying'], ['git', 'Git+GitHub'], ['nutrition', 'Nutrition+ journal']])('keeps common inflections and punctuation: %s / %s', (query, title) => {
    expect(relevance(query, title)).toBeGreaterThanOrEqual(34);
  });
  it('keeps a single CJK character as a searchable term', () => {
    expect(analyzeQueryIntent('猫').coreKeywords).toEqual(['猫']);
    expect(relevance('猫', '猫の健康')).toBeGreaterThanOrEqual(34);
  });
  it.each([
    ['remove', 'Removing rust from cast iron'],
    ['preserving', 'Preserve herbs in oil'],
    ['renew', 'Passport renewal steps'],
    ['renewal', 'Renew a passport'],
    ['removal', 'Remove adhesive residue'],
  ])('matches silent-e and deverbal -al inflections symmetrically: %s / %s', (query, title) => {
    expect(relevance(query, title)).toBeGreaterThanOrEqual(34);
  });
  it.each([
    ['port', 'Customer portal login'],
    ['sign', 'Traffic signal timing'],
  ])('does not conflate unrelated -al words: %s / %s', (query, title) => {
    expect(relevance(query, title)).toBe(0);
  });
  it('does not treat negated terms in titles or snippets as positive topical matches unless queried', () => {
    expect(computeQueryRelevance('ocean waves', 'Domestic cat on a sunny windowsill', 'Indoor cat portrait with no ocean or wave content.', 'https://photos.example/cat').relevanceScore).toBe(0);
    expect(computeQueryRelevance('fix flat bicycle tyre', 'Sunday ride in the Cotswolds', 'Scenic cycling vlog without tyre repair instructions.', 'https://videos.example/ride').relevanceScore).toBeLessThan(20);
    expect(computeQueryRelevance('no knead bread', 'No-knead crusty bread', 'Simple overnight dough without a mixer.', 'https://baking.example/no-knead').relevanceScore).toBeGreaterThanOrEqual(60);
  });
  it('ranks primary topic pages ahead of auxiliary prerequisites on the same host', () => {
    const primary = computeQueryRelevance('passport renewal', 'Renew a passport: application steps', 'Eligibility, forms, fees and postal submission for standard adult passport renewal.', 'https://gov.example/passport-renewal');
    const auxiliary = computeQueryRelevance('passport renewal', 'Documents needed for passport renewal', 'Supporting identity documents and photo specifications.', 'https://gov.example/passport-renewal-documents');
    expect(primary.relevanceScore).toBeGreaterThan(auxiliary.relevanceScore);
  });
});

describe('malformed percent encoding in provider URLs', () => {
  it('does not lose the whole result set because one URL has a literal percent sign', () => {
    const ranked = diversifyAndRankResults([
      { id: 'good', title: 'Rust memory safety', url: 'https://rust-lang.org/learn', snippet: 'Rust memory safety explained.', source: 'web' },
      { id: 'percent', title: 'Rust memory safety notes', url: 'https://notes.example/100%natural', snippet: 'Notes on Rust memory safety.', source: 'web' },
    ], {}, 'rust memory safety');
    expect(ranked.surfaced.map((r) => r.id)).toContain('good');
    expect(ranked.surfaced.map((r) => r.id)).toContain('percent');
  });
});
