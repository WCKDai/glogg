import { describe, expect, it } from 'vitest';
import { envNumber } from '../server/env';

describe('envNumber', () => {
  const warn = () => {};

  it('uses the default when unset or empty, as Docker Compose passes unset settings', () => {
    expect(envNumber('X', 7000, { env: {}, warn })).toBe(7000);
    expect(envNumber('X', 7000, { env: { X: '' }, warn })).toBe(7000);
    expect(envNumber('X', 7000, { env: { X: '   ' }, warn })).toBe(7000);
  });

  it('reads numbers, including zero (which turns a cache off)', () => {
    expect(envNumber('X', 600000, { env: { X: '0' }, warn })).toBe(0);
    expect(envNumber('X', 1, { env: { X: ' 2500 ' }, warn })).toBe(2500);
    expect(envNumber('X', 1, { env: { X: '1e3' }, warn })).toBe(1000);
  });

  it('falls back with a warning on junk, negatives, or values under the minimum', () => {
    const msgs: string[] = [];
    const w = (m: string) => msgs.push(m);
    expect(envNumber('DEADLINE', 7000, { env: { DEADLINE: '7s' }, warn: w })).toBe(7000);
    expect(envNumber('DEADLINE', 7000, { env: { DEADLINE: '-5' }, warn: w })).toBe(7000);
    expect(envNumber('DEADLINE', 7000, { env: { DEADLINE: 'Infinity' }, warn: w })).toBe(7000);
    expect(envNumber('TIMEOUT', 45000, { env: { TIMEOUT: '0' }, min: 1, warn: w })).toBe(45000);
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toContain('DEADLINE="7s"');
    expect(msgs[0]).toContain('7000');
  });
});
