/**
 * Quality goldens: what a good result page looks like for realistic inputs.
 * These pin behaviour users notice (junk hidden, primary sources up, variety
 * kept, instant answers exact), not implementation details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diversifyAndRankResults, evaluateInstantComputation, resolveBang } from '../src/core/index.js';
import type { RawSearchResult } from '../src/core/index.js';

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
