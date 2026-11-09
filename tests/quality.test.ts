/**
 * Quality goldens: what a good result page looks like for realistic inputs.
 * These pin behaviour users notice (junk hidden, primary sources up, variety
 * kept, instant answers exact), not implementation details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diversifyAndRankResults, evaluateInstantComputation, resolveBang } from '../src/core/index.js';
import type { RawSearchResult, ScoredSearchResult } from '../src/core/index.js';

const r = (title: string, url: string, snippet: string, extra: Partial<RawSearchResult> = {}): RawSearchResult => ({
  title,
  url,
  snippet,
  source: 'web',
  ...extra,
});

describe('ranking golden: "how to undo the last git commit"', () => {
  const query = 'how to undo the last git commit';
  const raw: RawSearchResult[] = [
    r('Sponsored: Best Git GUI Clients 2026 — Top 15 Picks (Ultimate Guide)', 'https://bestpicks.example/git-gui?tag=aff-20', 'Sponsored. We may earn a commission when you buy through our links. In today’s fast-paced world…'),
    r('15 Best Ways to Undo a Git Commit in 2026 (Ultimate Guide)', 'https://contentfarm.example/undo-git-commit-ultimate-guide', 'In today’s fast-paced digital landscape, undoing commits is essential. Whether you’re a beginner…'),
    r('Git - git-reset Documentation', 'https://git-scm.com/docs/git-reset', 'git reset [--soft | --mixed | --hard] <commit>. Reset current HEAD to the specified state.'),
    r('How do I undo the most recent local commits in Git?', 'https://stackoverflow.com/questions/927358/how-do-i-undo-the-most-recent-local-commits-in-git', 'Accepted answer: git reset HEAD~ keeps your changes; use --soft to keep them staged.', { source: 'stackexchange', points: 26000 }),
    r('Undoing things in Git, the boring and correct way', 'https://jvns.example/undo-git', 'A practical walkthrough of git reset, git revert and the reflog from a personal blog.', { publishedAt: '2019-03-01' }),
    r('Ask HN: How do you undo a bad git commit?', 'https://news.ycombinator.com/item?id=1', 'Practitioner discussion of reset vs revert on shared branches.', { source: 'hn', points: 210 }),
    r('Git undo commit - copy 1', 'https://mirror-a.example/git-undo', 'Undo the last git commit with git reset --soft HEAD~1 and keep changes.'),
    r('Git undo commit - copy 1', 'https://mirror-b.example/git-undo', 'Undo the last git commit with git reset --soft HEAD~1 and keep changes.'),
    r('git revert docs', 'https://git-scm.com/docs/git-revert', 'Revert some existing commits by recording new ones.'),
    r('git reflog docs', 'https://git-scm.com/docs/git-reflog', 'Manage reflog information and recover lost commits.'),
    r('git commit docs', 'https://git-scm.com/docs/git-commit', 'Record changes to the repository; --amend replaces the tip.'),
  ];
  const ranked = diversifyAndRankResults(raw, { lens: 'all', maxPerDomain: 2, stripSponsored: true }, query);
  const urls = ranked.surfaced.map((x) => x.url);

  it('hides sponsored and affiliate results', () => {
    expect(urls.some((u) => u.includes('bestpicks.example'))).toBe(false);
    expect(ranked.filteredSlop.some((x) => x.url.includes('bestpicks.example'))).toBe(true);
  });

  it('keeps the SEO listicle out of the top five', () => {
    const at = urls.findIndex((u) => u.includes('contentfarm.example'));
    expect(at === -1 || at >= 5).toBe(true);
  });

  it('puts the official docs and the accepted answer in the top three', () => {
    const top3 = urls.slice(0, 3).join(' ');
    expect(top3).toContain('git-scm.com/docs/git-reset');
    expect(top3).toContain('stackoverflow.com');
  });

  it('caps results per site', () => {
    const perSite = new Map<string, number>();
    for (const x of ranked.surfaced) perSite.set(x.rootDomain, (perSite.get(x.rootDomain) || 0) + 1);
    expect(Math.max(...perSite.values())).toBeLessThanOrEqual(2);
  });

  it('collapses syndicated copies of the same page', () => {
    expect(urls.filter((u) => u.includes('mirror-')).length).toBeLessThanOrEqual(1);
  });

  it('keeps the independent and community voices', () => {
    expect(urls).toContain('https://jvns.example/undo-git');
    expect(urls.some((u) => u.includes('news.ycombinator.com'))).toBe(true);
  });

  it('explains why each hidden result was hidden', () => {
    for (const x of ranked.filteredSlop) expect(x.isSponsored || x.demotedReason || x.verdict).toBeTruthy();
  });
});

describe('instant answers are exact', () => {
  it.each([
    ['256 * 1024', '262144'],
    ['2^32', '4294967296'],
    ['(3 + 4) * 5', '35'],
    ['15% of 200', '30'],
    ['255 in hex', 'FF'],
    ['0xff in decimal', '255'],
    ['10 in binary', '1010'],
    ['4096 mb in gb', '4'],
    ['100 km in miles', '62.1'],
    ['72f in c', '22.2'],
  ])('%s → %s', (q, expected) => {
    const a = evaluateInstantComputation(q);
    expect(a, q).toBeTruthy();
    expect(a!.directAnswer.replace(/,/g, '')).toContain(expected);
  });

  it('stays quiet for ordinary questions', () => {
    for (const q of ['rust borrow checker', 'best mechanical keyboard', 'capital of kazakhstan']) {
      expect(evaluateInstantComputation(q), q).toBeNull();
    }
  });
});

describe('escape hatches', () => {
  it.each([
    ['!g rust borrow checker', 'google.'],
    ['rust borrow checker !ddg', 'duckduckgo.com'],
    ['!w Glögg', 'wikipedia.org'],
  ])('%s', (q, host) => {
    expect(resolveBang(q)?.url).toContain(host);
  });
});

describe('overlay layering', () => {
  // The command palette once rendered in normal flow under its own scrim:
  // blurred, stuck bottom-left, and scrolling the page. Overlays must be fixed and above it.
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/client/styles.css'), 'utf8');
  const rule = (selector: string) => {
    const m = css.match(new RegExp(`(^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`));
    expect(m, selector).toBeTruthy();
    return m![2];
  };
  const z = (body: string) => Number(body.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);

  it.each(['.palette', '.sheet'])('%s is fixed and stacked above the scrim', (selector) => {
    const body = rule(selector);
    expect(body).toMatch(/position:\s*fixed/);
    expect(z(body)).toBeGreaterThan(z(rule('.scrim')));
  });

  it('keeps toasts above every overlay, and the status bar below them', () => {
    expect(z(rule('.toasts'))).toBeGreaterThan(z(rule('.palette')));
    expect(z(rule('.statusbar'))).toBeLessThan(z(rule('.scrim')));
  });
});

describe('answers quote prose, not plumbing', () => {
  it('skips vote counts, Q&A metadata and blocks of code when quoting the top results', async () => {
    const { buildInstantAnswer } = await import('../server/answerEngine.js');
    const hit = (n: number, snippet: string): ScoredSearchResult =>
      ({ id: `r${n}`, title: `Result ${n}`, url: `https://site${n}.example/page`, domain: `site${n}.example`, rootDomain: `site${n}.example`, snippet, source: 'web', slopScore: 5, relevanceScore: 80 }) as unknown as ScoredSearchResult;
    const answer = await buildInstantAnswer(
      'sourdough starter feeding schedule',
      [
        hit(1, '219 points · 83 comments on Hacker News · sourdough starter feeding'),
        hit(2, '2 answers · score 9 · sourdough, starter, feeding, schedule, baking'),
        hit(3, '("r: {}", r); // | | // | | // -+ | } // ------------------+ |'),
        hit(4, 'Feed a sourdough starter twice a day at room temperature, discarding half before each feeding.'),
        hit(5, 'A cold starter in the fridge needs feeding only once a week, then a day at room temperature before baking.'),
      ],
      Promise.resolve([null, null, null] as never)
    );
    expect(answer?.kind).toBe('knowledge-synthesis');
    const quoted = [answer!.directAnswer, ...(answer!.takeaways ?? []).map((t) => t.text)].join(' | ');
    expect(quoted).toContain('Feed a sourdough starter twice a day');
    expect(quoted).not.toMatch(/points|answers ·|\/\/ \|/);
  });
});

describe('interface details', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/client/styles.css'), 'utf8');
  const block = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? '';

  it("doesn't animate what you do hundreds of times a day: the palette, switching views", () => {
    expect(block('.palette')).not.toMatch(/(^|;)\s*animation\s*:/m);
    expect(block('.scrim-soft')).toMatch(/animation: none/);
    expect(css).not.toMatch(/\.main > \* \{[^}]*animation/);
  });

  it('shows hover-only actions on touch screens, and keeps phone inputs at 16px', () => {
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.result-actions \{\s*opacity: 1;/);
    expect(css).toMatch(/@media \(max-width: 720px\), \(pointer: coarse\) \{[^@]*font-size: 16px/);
  });

  it('keeps small grey text readable (WCAG AA, 4.5:1) on every surface, in both themes', () => {
    const tokens = (scope: string) =>
      Object.fromEntries([...(css.match(new RegExp(`${scope} \\{([^}]*)\\}`))?.[1] ?? '').matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
    const lum = (hex: string) => {
      const [r, g, b] = (hex.slice(1).match(/../g) ?? []).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const scope of [':root', 'html.dark']) {
      const t = tokens(scope);
      for (const surface of ['bg', 'surface', 'surface-2', 'surface-3']) {
        expect(contrast(t['ink-3'], t[surface]), `${scope} ink-3 on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('client bundle hygiene', () => {
  it('client code imports the browser core, never the server-side page cleaner', () => {
    const files: string[] = [];
    const walk = (d: string) =>
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(path.resolve(import.meta.dirname, '../src/client'));
    const offenders = files.filter((f) => /core\/(index|pageCleaner)\.js'/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
