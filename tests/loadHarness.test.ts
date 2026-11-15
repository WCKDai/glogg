import { describe, expect, it } from 'vitest';
import { distribution, loadOptions } from '../scripts/load-test.js';

describe('capacity experiment configuration', () => {
  it('defaults to five samples of the provisional 58 searches/second peak', () => {
    expect(loadOptions([])).toMatchObject({ samples: 5, seconds: 5, rps: 58, scenario: 'cold', maxSearches: 32 });
    expect(loadOptions(['--scenario=warm', '--samples=1', '--seconds=2', '--rps=3', '--max-searches=4', '--output=.tmp/example.json'])).toMatchObject({ scenario: 'warm', samples: 1, seconds: 2, rps: 3, maxSearches: 4, output: '.tmp/example.json' });
  });
  it.each(['--rps=0', '--rps=1001', '--seconds=NaN', '--samples=1.5', '--scenario=live', '--url=https://production', '--rps', '--max-searches=-1'])('rejects unsafe or ambiguous arguments: %s', (arg) => {
    expect(() => loadOptions([arg])).toThrow();
  });
  it('reports empty samples without claiming zero latency, and uses nearest-rank percentiles', () => {
    expect(distribution([])).toMatchObject({ count: 0, median: null, p95: null });
    expect(distribution([5, 1, 3, 2, 4])).toEqual({ count: 5, median: 3, p95: 5, p99: 5, min: 1, max: 5 });
  });
});
