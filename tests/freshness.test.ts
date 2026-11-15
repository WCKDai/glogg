import { describe, expect, it } from 'vitest';
import { freshnessQuery, inferFreshness } from '../src/core/freshness.js';
import { diversifyAndRankResults } from '../src/core/ranker.js';
import type { RawSearchResult } from '../src/core/types.js';

const now = Date.parse('2026-11-15T12:00:00Z');

describe('time-sensitive search intent', () => {
  it.each(['earthquake today', 'breaking election results', 'climate summit news', 'live updates from the summit'])('recognizes news intent: %s', (q) => {
    expect(inferFreshness(q, 'all', now)).toBe('news');
  });
  it.each(['latest Firefox version', 'up-to-date train prices', 'who is the president of France', 'who is the US president', "who is Apple's CEO", 'what is the weather in Copenhagen', 'weather Copenhagen', 'bitcoin stock price'])('recognizes changing information: %s', (q) => {
    expect(inferFreshness(q, 'all', now)).toBe('current');
  });
  it.each(['how the rust borrow checker works', 'Hacker News API', 'New York travel', 'history of breaking news', 'election news 2020', 'who was the president of France', 'electric current flow', '2 + 2', 'fake news definition', 'what is weather', 'how does weather forecasting work', 'how does weather form', 'forecast model design', 'breaking changes in an API', 'Breaking Bad cast'])('preserves evergreen or historical intent: %s', (q) => {
    expect(inferFreshness(q, 'all', now)).toBeUndefined();
  });
  it('keeps title words and technical terms when removing freshness modifiers', () => {
    expect(freshnessQuery('latest Breaking Bad season', 'current')).toBe('Breaking Bad season');
    expect(freshnessQuery('latest breaking changes in Node', 'current')).toBe('breaking changes in Node');
  });
  it.each(['latest security updates for Windows Server 2022', 'latest iPhone SE 2020 updates'])('does not mistake a product year for a historical query: %s', (query) => {
    expect(inferFreshness(query, 'all', now)).toBe('current');
  });
  it('lets explicit current updates win over a bare past year, but keeps historical constraints', () => {
    expect(inferFreshness('latest 2020 election news', 'all', now)).toBe('news');
    expect(inferFreshness('election news 2020', 'all', now)).toBeUndefined();
    expect(inferFreshness('latest election news before:2020', 'all', now)).toBeUndefined();
    expect(inferFreshness('latest history of elections 2020', 'all', now)).toBeUndefined();
    expect(inferFreshness('latest election news in 2020', 'all', now)).toBeUndefined();
  });
  it('uses the News scope while preserving explicit archive scopes', () => {
    expect(inferFreshness('space launch', 'raw-news', now)).toBe('news');
    expect(inferFreshness('latest space launch', 'pre-llm', now)).toBeUndefined();
    expect(inferFreshness('latest space launch', 'deep-archives', now)).toBeUndefined();
    expect(freshnessQuery('latest space launch news today')).toBe('space launch');
  });
});

describe('dated ranking without changing evergreen search', () => {
  const item = (id: string, publishedAt?: string): RawSearchResult => ({ id, title: 'Space launch', snippet: 'Space launch mission report from the launch team.', url: `https://${id}.example/report`, source: 'web', publishedAt });
  it('prefers a recent relevant page but gives invalid, unknown and future dates no bonus', () => {
    const raw = [item('old', '2020-01-01'), item('unknown'), item('invalid', 'nonsense'), item('future', '2030-01-01'), item('new', '2026-11-15T11:45:00Z')];
    const evergreen = diversifyAndRankResults(raw, {}, 'space launch');
    const fresh = diversifyAndRankResults(raw, {}, 'space launch', { intent: 'news', now });
    expect(fresh.surfaced[0].id).toBe('new');
    for (const id of ['old', 'unknown', 'invalid', 'future']) {
      expect(fresh.surfaced.find((r) => r.id === id)?.netScore).toBe(evergreen.surfaced.find((r) => r.id === id)?.netScore);
    }
    expect(evergreen.surfaced.find((r) => r.id === 'new')?.netScore).toBe(evergreen.surfaced.find((r) => r.id === 'unknown')?.netScore);
  });
  it('still rejects irrelevant results, even when just published', () => {
    const offTopic = { ...item('off', '2026-11-15T11:59:59Z'), title: 'Cupcake recipes', snippet: 'Chocolate buttercream frosting.', url: 'https://cake.example/baking' };
    const r = diversifyAndRankResults([offTopic, item('on', '2026-11-15T10:00:00Z')], {}, 'space launch', { intent: 'news', now });
    expect(r.surfaced.map((x) => x.id)).toEqual(['on']);
  });
});
