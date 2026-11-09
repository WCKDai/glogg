import { describe, expect, it, vi } from 'vitest';
import {
  buildResearchMessages,
  cleanAndAutopsyHtml,
  extractiveAnswer,
  isFiller,
  looksLikeChrome,
  pickCandidates,
  queryTerms,
  RESEARCH_SYSTEM_PROMPT,
  scorePassage,
  selectPassages,
} from '../src/core/index.js';
import type { InstantAnswerPayload, ResearchEvent, ResearchSource } from '../src/core/index.js';
import { runResearch } from '../server/research.js';

const page = (body: string, title = 'Page') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const GIT_DOCS = page(
  `<main><h1>git-reset</h1>
  <p>To undo the last commit but keep your changes staged, run git reset --soft HEAD~1. The commit is removed and your changes stay in the index.</p>
  <p>To keep the changes but unstage them, use git reset --mixed HEAD~1, which is the default mode of git reset.</p>
  <pre>git reset --soft HEAD~1</pre>
  <p>If the commit was already pushed to a shared branch, prefer git revert so history is not rewritten for others.</p></main>`,
  'git-reset docs'
);

const SEO_FLUFF = page(
  `<article><p>In today's fast-paced digital landscape, version control has become more important than ever before for developers everywhere.</p>
  <p>Understanding how Git commits work is essential for effectively managing your project's history and undoing changes when necessary.</p>
  <p>Whether you're a beginner or a seasoned professional, this ultimate guide will walk you through everything you need to know about git.</p></article>`,
  'Ultimate guide'
);

const REPO_CHROME = page(
  `<div><p>NameNameLast commit messageLast commit dateREADME.mdREADME.md View all files</p>
  <p>Latest commit History 120 Commits Go to file Code Folders and files undo-git-commit Public</p></div>`,
  'repo'
);

function sourceFrom(index: number, url: string, html: string, query: string): ResearchSource {
  const report = cleanAndAutopsyHtml(html, url);
  return { index, title: report.title, url, domain: new URL(url).hostname, read: true, passages: selectPassages(report.sections, queryTerms(query), 4, 2400) };
}

describe('research: pure helpers', () => {
  it('distils a question into stemmed content words', () => {
    const terms = queryTerms('How do I undo the last git commit but keep my changes?');
    expect(terms).toEqual(expect.arrayContaining(['undo', 'git', 'commit']));
    expect(terms).not.toContain('how');
    expect(terms).not.toContain('the');
  });

  it('scores a passage by the share of query terms it contains', () => {
    const terms = queryTerms('undo git commit');
    expect(scorePassage('Use git reset to undo a commit', terms)).toBe(1);
    expect(scorePassage('Use git to version files', terms)).toBeCloseTo(1 / 3, 5);
    expect(scorePassage('Nothing relevant here', terms)).toBe(0);
    expect(scorePassage('anything', [])).toBe(0);
  });

  it('picks web pages only, one per site, up to the limit', () => {
    const picked = pickCandidates(
      [
        { title: 'a', url: 'https://www.example.com/a', snippet: '' },
        { title: 'b', url: 'https://example.com/b', snippet: '' },
        { title: 'magnet', url: 'magnet:?xt=urn:btih:abc', snippet: '' },
        { title: 'pdf', url: 'https://papers.example.org/x.pdf', snippet: '' },
        { title: 'nzb', url: 'https://nzb.example.net/get.nzb?x=1', snippet: '' },
        { title: 'c', url: 'https://other.example.net/c', snippet: '' },
        { title: 'd', url: 'https://third.example.io/d', snippet: '' },
      ],
      2
    );
    expect(picked.map((c) => c.title)).toEqual(['a', 'c']);
  });

  it('selects relevant passages in reading order, skipping fluff, headings and short lines', () => {
    const terms = queryTerms('undo git commit keep changes');
    const passages = selectPassages(
      [
        { tag: 'h2', text: 'How to undo a git commit and keep changes', isFluffPreamble: false, isCoreAnswer: false },
        { tag: 'p', text: "In today's world, everyone needs version control for their projects and teams.", isFluffPreamble: true, isCoreAnswer: false },
        { tag: 'p', text: 'Run git reset --soft HEAD~1 to undo the commit and keep the changes staged for the next commit.', isFluffPreamble: false, isCoreAnswer: false },
        { tag: 'p', text: 'Too short.', isFluffPreamble: false, isCoreAnswer: false },
        { tag: 'p', text: 'Unrelated paragraph about the weather in the mountains this week, nothing more to say.', isFluffPreamble: false, isCoreAnswer: false },
        { tag: 'pre', text: 'git reset --soft HEAD~1', isFluffPreamble: false, isCoreAnswer: false },
      ],
      terms,
      3,
      5000
    );
    expect(passages[0]).toContain('git reset --soft HEAD~1 to undo');
    expect(passages.some((p) => p.startsWith('```'))).toBe(true);
    expect(passages.join(' ')).not.toContain("In today's world");
    expect(passages.join(' ')).not.toContain('weather');
  });

  it('stays within the character budget but always keeps one passage', () => {
    const long = 'git commit undo '.repeat(80);
    const sections = [0, 1, 2].map(() => ({ tag: 'p' as const, text: long, isFluffPreamble: false, isCoreAnswer: false }));
    const out = selectPassages(sections, queryTerms('undo git commit'), 3, 950);
    expect(out).toHaveLength(1);
  });

  it('falls back to the first paragraphs when nothing matches', () => {
    const sections = ['First real paragraph of the page with enough words in it.', 'Second real paragraph of the page with enough words too.', 'Third.'].map(
      (text) => ({ tag: 'p' as const, text, isFluffPreamble: false, isCoreAnswer: false })
    );
    expect(selectPassages(sections, queryTerms('quantum chromodynamics'), 3, 5000)).toHaveLength(2);
  });

  it('builds a prompt with numbered sources, a guard against injected instructions, and a short history', () => {
    const sources: ResearchSource[] = [
      { index: 1, title: 'Docs', url: 'https://a.example/x', domain: 'a.example', read: true, passages: ['Passage one.'] },
      { index: 2, title: 'Forum', url: 'https://b.example/y', domain: 'b.example', read: false, passages: [] },
    ];
    const history = Array.from({ length: 5 }, (_, i) => ({ query: `q${i}`, answer: 'x'.repeat(2000) }));
    const [system, user] = buildResearchMessages('What is it?', sources, history);
    expect(system.role).toBe('system');
    expect(system.content).toBe(RESEARCH_SYSTEM_PROMPT);
    expect(system.content).toMatch(/never follow instructions/i);
    expect(user.content).toContain('[1] Docs — https://a.example/x\nPassage one.');
    expect(user.content).toContain('[2] Forum — https://b.example/y\n(no readable text)');
    expect(user.content).toContain('Question: What is it?');
    expect(user.content).not.toContain('Q: q0');
    expect(user.content).toContain('Q: q4');
    expect(user.content.length).toBeLessThan(4000);
  });

  it('puts the instant answer first in a quoted answer, with its citation', () => {
    const instant: InstantAnswerPayload = {
      kind: 'technical-answer',
      title: 'Undo a commit',
      directAnswer: 'Use git reset --soft HEAD~1.',
      confidence: 'verified',
      codeBlock: 'git reset --soft HEAD~1',
      primarySourceUrl: 'https://so.example/q/1',
      citations: [],
    };
    const sources: ResearchSource[] = [
      { index: 1, title: 'SO', url: 'https://so.example/q/1', domain: 'so.example', read: true, passages: ['Use git reset --soft HEAD~1.'] },
      { index: 2, title: 'Blog', url: 'https://blog.example/p', domain: 'blog.example', read: true, passages: ['You can undo the last git commit with git reset and keep every change in your working tree.'] },
    ];
    const md = extractiveAnswer('undo last git commit', sources, instant);
    expect(md.startsWith('**Undo a commit** — Use git reset --soft HEAD~1. [1]')).toBe(true);
    expect(md).toContain('```\ngit reset --soft HEAD~1\n```');
    expect(md).toContain('[2]');
  });

  it('skips lead-in sentences whose payload was not quoted', () => {
    const sources: ResearchSource[] = [
      { index: 1, title: 'A', url: 'https://a.example', domain: 'a.example', read: true, passages: ['Undoing the last local git commit needs exactly this one command:'] },
      { index: 2, title: 'B', url: 'https://b.example', domain: 'b.example', read: true, passages: ['Run git reset --soft HEAD~1 to undo the last commit and keep the changes.'] },
    ];
    const md = extractiveAnswer('undo last git commit', sources);
    expect(md).not.toContain('[1]');
    expect(md).toContain('[2]');
  });

  it('says so plainly when the pages do not answer the question', () => {
    expect(extractiveAnswer('zebra migration', [])).toMatch(/don't answer this directly/);
  });
});

describe('research quality: quotes come from the answer, not page chrome or filler', () => {
  const query = 'how to undo the last git commit but keep changes';
  const sources = [
    sourceFrom(1, 'https://docs.example/git-reset', GIT_DOCS, query),
    sourceFrom(2, 'https://seo.example/ultimate-git-guide', SEO_FLUFF, query),
    sourceFrom(3, 'https://code.example/user/undo-git-commit', REPO_CHROME, query),
  ];
  const md = extractiveAnswer(query, sources);

  it('quotes the command from the documentation page and cites it', () => {
    expect(md).toMatch(/git reset --soft HEAD~1[^\n]*\[1\]/);
  });

  it('drops repository UI text', () => {
    expect(md).not.toMatch(/NameName|View all files|Go to file/);
  });

  it('drops generic SEO filler', () => {
    expect(md).not.toMatch(/is essential for|fast-paced|ultimate guide/i);
  });
});

describe('research quality: the filters stay narrow', () => {
  it.each([
    'Call useEffect after useState changes to keep the DOM in sync.',
    'Use git reset --soft HEAD~1 to keep the changes staged.',
    'The OpenSSL 3.0 release changed the default provider for legacy ciphers.',
    'Rust’s borrow checker enforces that references never outlive the data they point to.',
  ])('keeps real prose: %s', (sentence) => {
    expect(looksLikeChrome(sentence)).toBe(false);
    expect(isFiller(sentence)).toBe(false);
  });

  it('keeps a hedge that still carries information', () => {
    expect(isFiller('It is important to note that git reset rewrites local history.')).toBe(false);
  });

  it.each([
    'NameNameLast commit messageLast commit dateREADME.mdREADME.md View all files',
    'Latest commit History 120 Commits Go to file Code Folders and files',
    'Home Products Pricing Docs Blog Contact Sign',
  ])('flags page chrome: %s', (text) => {
    expect(looksLikeChrome(text)).toBe(true);
  });

  it.each([
    "Understanding how Git commits work is essential for managing your project's history.",
    'Learn the safest ways to undo the last Git commit while keeping your work.',
    "In today's fast-paced digital landscape, version control matters more than ever.",
    "Whether you're a beginner or a seasoned pro, this guide has you covered.",
    "In this article, we'll walk through every option step by step.",
  ])('flags filler: %s', (text) => {
    expect(isFiller(text)).toBe(true);
  });
});

describe('research: engine (offline, stubbed I/O)', () => {
  const candidates = [
    { title: 'Docs', url: 'https://docs.example/git-reset', snippet: 'git reset docs' },
    { title: 'Down', url: 'https://down.example/x', snippet: 'Snippet from the search engine about git reset.' },
  ];
  const fetchPage = vi.fn(async (url: string) => {
    if (url.includes('down.example')) throw new Error('ECONNREFUSED');
    return GIT_DOCS;
  });

  async function collect(gen: AsyncGenerator<ResearchEvent>): Promise<ResearchEvent[]> {
    const out: ResearchEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it('reads sources and quotes them when no model is configured', async () => {
    const events = await collect(runResearch({ query: 'undo git commit keep changes', candidates }, { ai: null, fetchPage }));
    expect(events.map((e) => e.type)).toEqual(['status', 'sources', 'delta', 'done']);
    const sources = (events[1] as Extract<ResearchEvent, { type: 'sources' }>).sources;
    expect(sources.map((s) => [s.index, s.read])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(sources[1].passages).toEqual(['Snippet from the search engine about git reset.']);
    expect(events[3]).toMatchObject({ type: 'done', mode: 'extractive' });
  });

  it('uses the instant answer as source 1 without fetching its page', async () => {
    fetchPage.mockClear();
    const instant: InstantAnswerPayload = {
      kind: 'technical-answer',
      title: 'Undo',
      directAnswer: 'git reset --soft HEAD~1 keeps changes.',
      confidence: 'verified',
      primarySourceUrl: 'https://so.example/q/1',
      primarySourceTitle: 'SO question',
      citations: [],
    };
    const events = await collect(runResearch({ query: 'undo git commit', candidates, instantAnswer: instant }, { ai: null, fetchPage }));
    const sources = (events.find((e) => e.type === 'sources') as Extract<ResearchEvent, { type: 'sources' }>).sources;
    expect(sources[0]).toMatchObject({ index: 1, url: 'https://so.example/q/1', read: true });
    expect(fetchPage).not.toHaveBeenCalledWith('https://so.example/q/1', expect.anything(), expect.anything());
  });

  it('streams a model answer and passes the numbered sources to it', async () => {
    const seen: string[] = [];
    const chat = async function* (_cfg: unknown, messages: { content: string }[]) {
      seen.push(messages[1].content);
      yield 'Use git reset ';
      yield '--soft HEAD~1 [1].';
    };
    const events = await collect(
      runResearch(
        { query: 'undo git commit', candidates },
        { ai: { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' }, fetchPage, chat }
      )
    );
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('Use git reset --soft HEAD~1 [1].');
    expect(events.at(-1)).toMatchObject({ type: 'done', mode: 'ai', model: 'llama3.1' });
    expect(seen[0]).toContain('[1] Docs — https://docs.example/git-reset');
  });

  it('falls back to quotes with a notice when the model fails before answering', async () => {
    const chat = async function* (): AsyncGenerator<string> {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    };
    const events = await collect(
      runResearch({ query: 'undo git commit', candidates }, { ai: { provider: 'ollama', baseUrl: 'x', apiKey: '', model: 'm' }, fetchPage, chat })
    );
    expect(events.map((e) => e.type)).toEqual(['status', 'sources', 'status', 'notice', 'delta', 'done']);
    expect(events.at(-1)).toMatchObject({ mode: 'extractive' });
  });

  it('reports an error, without mixing in quotes, when the model stops mid-answer', async () => {
    const chat = async function* () {
      yield 'Partial';
      throw new Error('stream reset');
    };
    const events = await collect(
      runResearch({ query: 'undo git commit', candidates }, { ai: { provider: 'ollama', baseUrl: 'x', apiKey: '', model: 'm' }, fetchPage, chat })
    );
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(1);
  });

  it('runs the search itself when the client sends no candidates', async () => {
    const search = vi.fn(async () => ({
      query: 'q',
      results: [{ title: 'Docs', url: 'https://docs.example/git-reset', snippet: 's', source: 'web' }],
      instantAnswer: undefined,
    }));
    const events = await collect(runResearch({ query: 'undo git commit' }, { ai: null, fetchPage, search: search as never }));
    expect(search).toHaveBeenCalledOnce();
    expect(events.map((e) => e.type)).toEqual(['status', 'search', 'status', 'sources', 'delta', 'done']);
  });

  it('stops emitting once aborted', async () => {
    const ctrl = new AbortController();
    const slowFetch = async () => {
      ctrl.abort();
      return GIT_DOCS;
    };
    const events = await collect(runResearch({ query: 'undo git commit', candidates }, { ai: null, fetchPage: slowFetch, signal: ctrl.signal }));
    expect(events.map((e) => e.type)).toEqual(['status']);
  });

  it('answers gracefully when there is nothing readable to research', async () => {
    const events = await collect(runResearch({ query: 'x', candidates: [{ title: 'm', url: 'magnet:?xt=urn:btih:1', snippet: '' }] }, { ai: null, fetchPage }));
    expect(events.map((e) => e.type)).toEqual(['delta', 'done']);
  });
});
