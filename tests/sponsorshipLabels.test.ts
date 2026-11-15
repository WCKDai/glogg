import { describe, expect, it } from 'vitest';
import { scoreSearchResult } from '../src/core/slopScorer.js';
import { diversifyAndRankResults } from '../src/core/ranker.js';

describe('explicit sponsorship and commission disclosures', () => {
  it.each(['Sponsored affiliate recommendations for balcony tomato kits.', 'We may earn commissions on every purchase.', 'We may earn commission from purchases.'])('hides disclosed advertising: %s', (snippet) => {
    const row = { title: 'Growing tomatoes on a balcony', url: 'https://offers.example/tomatoes', snippet, source: 'web' as const };
    expect(scoreSearchResult(row).isSponsored).toBe(true);
    expect(diversifyAndRankResults([row], {}, 'tomatoes balcony').surfaced).toHaveLength(0);
  });
  it.each(['How affiliate links work in browser extensions.', 'A parliamentary commission published its findings.', 'A guide to sponsorship disclosure rules.'])('does not infer sponsorship from a general topic: %s', (snippet) => {
    expect(scoreSearchResult({ title: 'Research notes', url: 'https://notes.example/article', snippet, source: 'web' }).isSponsored).toBe(false);
  });
});
