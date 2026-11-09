import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginInfo, RankedSearchResponse, ResearchEvent, ScoredSearchResult, ToolResult } from '../src/core/index.js';
import {
  defaultInputs,
  indexTools,
  inputsFromTrigger,
  mergeLateResults,
  mergeTargets,
  reduceResearch,
  streamEvents,
  suggestTools,
  targetLabel,
  urlCrumb,
} from '../src/client/lib.js';
import type { ResearchState } from '../src/client/lib.js';
import { Markdown } from '../src/client/components/Markdown.js';
import { ToolOutput } from '../src/client/components/ToolKit.js';
import { AnswerCard } from '../src/client/components/Results.js';
import { Favicon } from '../src/client/components/Favicon.js';

const plugin = (p: Partial<PluginInfo> & { id: string }): PluginInfo => ({
  name: p.id,
  description: 'test plugin',
  category: 'utility',
  tools: [],
  source: 'builtin',
  configured: true,
  hasRunner: true,
  ...p,
});

const PLUGINS: PluginInfo[] = [
  plugin({
    id: 'osint',
    category: 'osint',
    tools: [
      { id: 'dns', name: 'DNS records', description: 'd', trigger: 'dns', inputs: [{ key: 'domain', label: 'Domain', required: true }] },
      { id: 'dorks', name: 'Dorks', description: 'd', trigger: 'dork', inputs: [{ key: 'domain', label: 'Domain' }] },
    ],
  }),
  plugin({
    id: 'utils',
    tools: [
      {
        id: 'encode',
        name: 'Encode',
        description: 'e',
        trigger: 'b64',
        inputs: [
          { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'auto', label: 'All' }] },
          { key: 'text', label: 'Text', type: 'textarea' },
          { key: 'strict', label: 'Strict', type: 'toggle' },
        ],
      },
      { id: 'uuid', name: 'UUIDs', description: 'u', trigger: 'uuid', inputs: [{ key: 'count', label: 'Count', type: 'number', default: 5 }] },
    ],
  }),
  plugin({ id: 'broken', error: 'Syntax error' }),
];

describe('tool helpers', () => {
  const tools = indexTools(PLUGINS);

  it('indexes tools from working plugins only', () => {
    expect(tools.map((t) => t.key)).toEqual(['osint/dns', 'osint/dorks', 'utils/encode', 'utils/uuid']);
  });

  it('suggests tools by trigger prefix, shortest first, until a space is typed', () => {
    expect(suggestTools(tools, '>d').map((t) => t.tool.trigger)).toEqual(['dns', 'dork']);
    expect(suggestTools(tools, '>').length).toBe(4);
    expect(suggestTools(tools, '>dns example.com')).toEqual([]);
    expect(suggestTools(tools, 'dns')).toEqual([]);
  });

  it('fills the first text input from the text after the trigger', () => {
    expect(inputsFromTrigger(tools[0].tool, 'example.com')).toEqual({ domain: 'example.com' });
    expect(inputsFromTrigger(tools[2].tool, 'aGk=')).toEqual({ mode: 'auto', text: 'aGk=', strict: false });
  });

  it('applies defaults, the first select option and off toggles', () => {
    expect(defaultInputs(tools[2].tool.inputs)).toEqual({ mode: 'auto', strict: false });
    expect(defaultInputs(tools[3].tool.inputs)).toEqual({ count: 5 });
  });
});

describe('download destinations', () => {
  it('adds configured plugins before local downloads and skips the rest', () => {
    const targets = mergeTargets([
      { id: 'plugin:realdebrid', pluginId: 'realdebrid', label: 'Real-Debrid', accepts: ['magnet', 'link'], configured: true },
      { id: 'plugin:torbox', pluginId: 'torbox', label: 'TorBox', accepts: ['magnet'], configured: false },
    ]);
    expect(targets.map((t) => t.id)).toEqual(['auto', 'offcloud', 'aria2-rpc', 'nextcloud', 'plugin:realdebrid', 'local-vault']);
    expect(targetLabel('plugin:realdebrid', targets)).toBe('Real-Debrid');
    expect(targetLabel('plugin:unknown', targets)).toBe('unknown');
  });
});

describe('research state', () => {
  const start: ResearchState = { id: 1, query: 'q', stage: 'reading', detail: 'Reading', sources: [], answer: '' };
  const events: ResearchEvent[] = [
    { type: 'status', stage: 'reading', detail: 'Reading 2 sources' },
    { type: 'sources', sources: [{ index: 1, title: 'A', url: 'https://a.example', domain: 'a.example', read: true, passages: [] }] },
    { type: 'status', stage: 'writing', detail: 'Writing with m' },
    { type: 'delta', text: 'Hello ' },
    { type: 'delta', text: 'world [1].' },
    { type: 'done', mode: 'ai', model: 'm', durationMs: 1234 },
  ];

  it('folds the event stream into the panel state', () => {
    const end = events.reduce(reduceResearch, start);
    expect(end).toMatchObject({ stage: 'done', answer: 'Hello world [1].', mode: 'ai', model: 'm', durationMs: 1234 });
    expect(end.sources).toHaveLength(1);
  });

  it('keeps notices and errors', () => {
    expect(reduceResearch(start, { type: 'notice', message: 'fallback' }).notice).toBe('fallback');
    expect(reduceResearch(start, { type: 'error', message: 'down' })).toMatchObject({ stage: 'error', error: 'down' });
  });
});

describe('late results', () => {
  const r = (url: string): ScoredSearchResult => ({ url, title: url } as ScoredSearchResult);
  const base = {
    query: 'q',
    results: [r('https://a'), r('https://b')],
    p2pResults: [],
    instantAnswer: undefined,
    metrics: { surfacedCount: 2, sourceTimings: { lemmy: { ms: 900, count: 0, status: 'late' } } },
  } as unknown as RankedSearchResponse;

  it('appends only new results and never reorders what is on screen', () => {
    const later = { ...base, results: [r('https://c'), r('https://a'), r('https://b')], metrics: { ...base.metrics, sourceTimings: {} } } as RankedSearchResponse;
    const merged = mergeLateResults(base, later)!;
    expect(merged.results.map((x) => x.url)).toEqual(['https://a', 'https://b', 'https://c']);
    expect(merged.metrics.surfacedCount).toBe(3);
  });

  it('fills in an instant answer that missed the first response', () => {
    const answer = { title: 'A', directAnswer: 'x', kind: 'direct-fact', confidence: 'verified', citations: [] } as RankedSearchResponse['instantAnswer'];
    expect(mergeLateResults(base, { ...base, instantAnswer: answer })!.instantAnswer).toBe(answer);
  });

  it('returns the same object when nothing changed, and ignores other queries', () => {
    expect(mergeLateResults(base, { ...base })).toBe(base);
    expect(mergeLateResults(base, { ...base, query: 'other', results: [r('https://z')] })).toBe(base);
    expect(mergeLateResults(null, base)).toBeNull();
  });
});

describe('streaming responses', () => {
  afterEach(() => vi.unstubAllGlobals());

  const streamOf = (chunks: string[], status = 200) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    return new Response(body, { status, headers: { 'Content-Type': 'application/x-ndjson' } });
  };

  it('parses events split across chunk boundaries, including a final line without newline', async () => {
    vi.stubGlobal('fetch', async () => streamOf(['{"type":"sta', 'tus","stage":"reading","detail":"x"}\n{"type":"delta",', '"text":"é"}\n', '{"type":"done","mode":"extractive","durationMs":1}']));
    const seen: ResearchEvent[] = [];
    await streamEvents<ResearchEvent>('/api/research', {}, new AbortController().signal, (e) => seen.push(e));
    expect(seen.map((e) => e.type)).toEqual(['status', 'delta', 'done']);
    expect((seen[1] as { text: string }).text).toBe('é');
  });

  it('surfaces the server error message', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'query is required' }), { status: 400 }));
    await expect(streamEvents('/api/research', {}, new AbortController().signal, () => undefined)).rejects.toThrow('query is required');
  });
});

describe('Markdown renderer', () => {
  const html = (text: string, sources = [{ index: 1, title: 'Docs', url: 'https://docs.example/a' }]) =>
    renderToStaticMarkup(<Markdown text={text} sources={sources} />);

  it('turns known citations into links and leaves unknown ones as text', () => {
    const out = html('Use reset [1]. See also [7].');
    expect(out).toContain('<a class="cite-ref" href="https://docs.example/a"');
    expect(out).toContain('[7]');
  });

  it('expands citation ranges and lists', () => {
    const sources = [1, 2, 3].map((i) => ({ index: i, title: `S${i}`, url: `https://s${i}.example` }));
    const out = html('Claim [1-3]. Other [1, 3].', sources);
    expect(out.match(/class="cite-ref"/g)).toHaveLength(5);
  });

  it('never renders raw HTML from the model or a page', () => {
    const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script> **bold**');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('only links http(s) URLs', () => {
    expect(html('[x](javascript:alert(1)) [ok](https://ok.example)')).not.toContain('href="javascript');
    expect(html('[ok](https://ok.example)')).toContain('href="https://ok.example"');
  });

  it('renders code fences, including an unfinished one mid-stream', () => {
    expect(html('Run:\n```\ngit reset --soft HEAD~1\n```')).toContain('<pre><code>git reset --soft HEAD~1</code></pre>');
    expect(html('Run:\n```\ngit reset')).toContain('<pre><code>git reset</code></pre>');
  });

  it('renders headings, lists and inline code', () => {
    const out = html('## Steps\n- first `a`\n- second\n\n1. one\n2. two');
    expect(out).toContain('<h4>Steps</h4>');
    expect(out).toContain('<ul><li>first <code>a</code></li><li>second</li></ul>');
    expect(out).toContain('<ol><li>one</li><li>two</li></ol>');
  });
});

describe('tool output', () => {
  it('renders every block type', () => {
    const result: ToolResult = {
      blocks: [
        { type: 'notice', tone: 'warn', content: 'Heads up' },
        { type: 'kv', title: 'Facts', items: [{ label: 'IP', value: '192.0.2.1', tone: 'ok' }, { label: 'Site', value: 'example', href: 'https://example.com' }] },
        { type: 'table', columns: ['Type', 'Value'], rows: [['A', '192.0.2.1']] },
        { type: 'list', items: [{ title: 'Item', subtitle: 'sub', badge: 'new', tone: 'info', actions: [{ label: 'Open', href: 'https://x.example' }, { label: 'Send', send: { url: 'magnet:?xt=urn:btih:1' } }] }] },
        { type: 'text', content: '**Bold** text' },
        { type: 'code', content: 'echo hi' },
        { type: 'stat', items: [{ label: 'Grade', value: 'A', tone: 'ok' }] },
        { type: 'checks', items: [{ label: 'HTTPS', pass: true }, { label: 'CSP', pass: false, detail: 'missing' }, { label: 'N/A', pass: null }] },
        { type: 'actions', items: [{ label: 'Copy', copy: 'x' }] },
      ],
    };
    const out = renderToStaticMarkup(<ToolOutput result={result} handlers={{ onSend: () => undefined, onRunTool: () => undefined }} />);
    for (const text of ['Heads up', '192.0.2.1', '<table', 'Item', '<strong>Bold</strong>', 'echo hi', 'Grade', 'HTTPS', 'missing', 'Copy']) {
      expect(out).toContain(text);
    }
    expect(out).toContain('notice-warn');
    expect(out).toContain('href="https://example.com"');
  });

  it('shows a friendly line for empty lists and tables', () => {
    const out = renderToStaticMarkup(
      <ToolOutput
        result={{ blocks: [{ type: 'list', items: [] }, { type: 'table', columns: ['a'], rows: [] }] }}
        handlers={{ onSend: () => undefined, onRunTool: () => undefined }}
      />
    );
    expect(out).toContain('Nothing found.');
    expect(out).toContain('Nothing to show.');
  });
});

describe('honest copy', () => {
  const answer = (kind: string) =>
    ({
      kind,
      title: 'Page title',
      directAnswer: 'Lead text from the page.',
      confidence: 'synthesized',
      citations: [{ index: 1, title: 'A page', url: 'https://a.example/x', domain: 'a.example', source: 'web' }],
      primarySourceUrl: 'https://a.example/x',
      primarySourceDomain: 'a.example',
    }) as never;

  it('labels quotes from the top results as quotes, without a headline or claims of verification', () => {
    const html = renderToStaticMarkup(<AnswerCard answer={answer('knowledge-synthesis')} onRead={() => undefined} />);
    expect(html).toContain('From the top results');
    expect(html).not.toContain('<h2');
    expect(html).not.toMatch(/verified|synthesi[sz]ed/i);
  });

  it('gives a real answer its title and source', () => {
    const html = renderToStaticMarkup(<AnswerCard answer={answer('technical-answer')} onRead={() => undefined} />);
    expect(html).toContain('Accepted answer');
    expect(html).toContain('<h2 class="answer-title">Page title</h2>');
    expect(html).toContain('a.example');
  });
});

describe('favicons', () => {
  it("shows the site's initial under its icon, tinted the same way every time", () => {
    const a = renderToStaticMarkup(<Favicon domain="www.example.org" />);
    expect(a).toContain('<span class="favicon-letter">E</span>');
    expect(renderToStaticMarkup(<Favicon domain="www.example.org" />)).toBe(a);
    expect(renderToStaticMarkup(<Favicon domain="other.example" />)).not.toBe(a);
  });
});

describe('breadcrumbs', () => {
  it.each([
    ['https://stackoverflow.com/questions/927358/how-to-undo', 'questions › how-to-undo'],
    ['https://simonwillison.net/2024/Mar/26/llm-cmd/', '2024 › Mar › llm-cmd'],
    ['https://forum.example/a/4965655', ''],
    ['https://example.com/', ''],
  ])('%s → "%s"', (url, crumb) => {
    expect(urlCrumb(url)).toBe(crumb);
  });
});
