/**
 * Small property-testing kit: seeded random inputs, so a failure can be replayed.
 *
 *   GLOGG_FUZZ_SEED=<n>  replay a run (each failure prints its seed)
 *   GLOGG_FUZZ_RUNS=<n>  cases per property (default 300)
 */

export type Rng = () => number;

/** mulberry32: fast, and the same sequence on every machine. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BASE_SEED = Number(process.env.GLOGG_FUZZ_SEED) || 0x9106;
export const RUNS = Number(process.env.GLOGG_FUZZ_RUNS) || 300;
/** Test timeout that grows with RUNS, for the heavier properties. */
export const TIMEOUT = Math.max(5_000, RUNS * 25);

export const int = (r: Rng, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
export const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)];
export const list = <T>(r: Rng, max: number, gen: (r: Rng) => T): T[] => Array.from({ length: int(r, 0, max) }, () => gen(r));

/** Fragments that break naive parsers: markup, quotes, operators, control and wide characters. */
const NASTY = [
  '<', '>', '&', '"', "'", '`', '\\', '/', '\0', '\n', '\r\n', '\t', ' ', '​', '‮', '﻿',
  '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', 'data:text/html,<b>',
  '<!--', '-->', '<![CDATA[', ']]>', '&amp;', '&#x3c;', '&#0;', '%00', '%3Cscript%3E', '${x}', '{{x}}',
  '"quoted phrase"', 'site:', '-site:', 'filetype:pdf', 'before:2020', 'after:', 'OR', 'AND', 'NOT', '!g', '!!',
  '*', '(', ')', '[', ']', '{', '}', '|', '^', '$', '+', '?', '.', ':', ';', ',', '#', '@', '~',
  'é', 'ß', '日本語', 'العربية', 'עברית', '🙂', '👨‍👩‍👧', 'ﷺ', 'Ⅻ', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
  'http://', 'https://example.com/a?b=c#d', 'www.', '.com', 'xn--', '://', '//', '..', '../',
];

const WORDS = [
  'rust', 'async', 'runtime', 'linux', 'kernel', 'sourdough', 'git', 'undo', 'commit', 'best', 'review', 'how', 'to',
  'the', 'a', 'of', 'reddit', 'forum', 'blog', 'pdf', 'history', 'printing', 'press', 'keyboard', 'ai', 'slop',
];

/** Text mixing words, operators and nasty fragments. */
export function text(r: Rng, maxParts = 12): string {
  return list(r, maxParts, (x) => (x() < 0.55 ? pick(x, WORDS) : pick(x, NASTY))).join(pick(r, [' ', '', '  ', '\n', '-']));
}

/** Any string of UTF-16 code units, lone surrogates included. */
export function anyString(r: Rng, maxLen = 40): string {
  return Array.from({ length: int(r, 0, maxLen) }, () => String.fromCharCode(int(r, 0, r() < 0.8 ? 0x7f : 0xffff))).join('');
}

/** Random, often broken, HTML. */
export function html(r: Rng, depth = 0): string {
  const tags = ['div', 'p', 'a', 'span', 'script', 'style', 'article', 'main', 'nav', 'footer', 'h1', 'h2', 'li', 'ul', 'img', 'iframe', 'br', 'table', 'td'];
  return list(r, depth > 3 ? 2 : 6, (x) => {
    const roll = x();
    if (roll < 0.35) return text(x, 6);
    if (roll < 0.45) return pick(x, NASTY);
    const tag = pick(x, tags);
    const attrs = list(x, 3, (y) => `${pick(y, ['href', 'src', 'class', 'id', 'onclick', 'style', 'data-x'])}="${text(y, 3).replace(/"/g, '')}"`).join(' ');
    const close = x() < 0.85 ? `</${tag}>` : '';
    return `<${tag} ${attrs}>${depth < 4 ? html(x, depth + 1) : ''}${close}`;
  }).join('');
}

/** A URL-ish string: sometimes valid, often not. */
export function urlish(r: Rng): string {
  const scheme = pick(r, ['https://', 'http://', '', 'ftp://', 'javascript:', '//', 'HTTPS://']);
  const host = pick(r, ['example.com', 'sub.example.co.uk', 'localhost', '127.0.0.1', '[::1]', 'xn--bcher-kva.example', 'a', '']);
  const path = list(r, 4, (x) => pick(x, ['a', 'b c', '%20', '..', 'é', '?q=1', '#x', ''])).join('/');
  return `${scheme}${host}${path ? `/${path}` : ''}`;
}

/**
 * Runs `check` on RUNS generated cases. A failure names the seed and the input,
 * so `GLOGG_FUZZ_SEED=<seed>` replays exactly that case first.
 */
export function forAll<T>(name: string, gen: (r: Rng) => T, check: (input: T) => void): void {
  for (let i = 0; i < RUNS; i++) {
    const seed = BASE_SEED + i;
    const input = gen(rng(seed));
    try {
      check(input);
    } catch (e) {
      const shown = JSON.stringify(input);
      throw new Error(
        `${name} failed for seed ${seed} (replay: GLOGG_FUZZ_SEED=${seed} GLOGG_FUZZ_RUNS=1)\ninput: ${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}\n${e instanceof Error ? e.message : e}`
      );
    }
  }
}
