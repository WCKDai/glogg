import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RankedSearchResponse } from '../src/core/types.js';
import { FreshnessStatus, StatusBar } from '../src/client/components/StatusBar.js';

const data = (metrics: object) => ({ metrics: { durationMs: 10, sourceTimings: {}, ...metrics } }) as RankedSearchResponse;

describe('honest search freshness', () => {
  it('does not label a fast network result as cached', () => {
    const html = renderToStaticMarkup(<StatusBar data={data({})} loading={false} research={null} mode="simple" toolCount={0} onToggleMode={() => {}} onOpenPalette={() => {}} />);
    expect(html).toContain('0.01 s');
    expect(html).not.toContain('cached');
  });

  it('shows the check time and actual cache age for a timely search, with a way to check again', () => {
    const html = renderToStaticMarkup(<FreshnessStatus data={data({ freshness: { intent: 'news', checkedAt: '2026-11-15T10:20:30Z', maxCacheAgeMs: 12_000 } })} onRefresh={() => {}} />);
    expect(html).toContain('dateTime="2026-11-15T10:20:30Z"');
    expect(html).toContain('fetched up to 12s ago');
    expect(html).toContain('Check again');
    expect(html).not.toMatch(/real.time|verified|live news/i);
  });

  it('keeps evergreen search unchanged and does not invent a cache age', () => {
    expect(renderToStaticMarkup(<FreshnessStatus data={data({})} onRefresh={() => {}} />)).toBe('');
    const html = renderToStaticMarkup(<FreshnessStatus data={data({ freshness: { intent: 'current', checkedAt: '2026-11-15T10:20:30Z', maxCacheAgeMs: 0 } })} onRefresh={() => {}} />);
    expect(html).toContain('Checked');
    expect(html).not.toContain('cached');
  });
});
