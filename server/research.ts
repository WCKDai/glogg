/**
 * Research mode — the I/O half: search (unless the client already did), read
 * the top pages, then stream a cited answer from the user's own model, or
 * quote the best passages when no model is configured.
 */
import {
  botWall,
  buildResearchMessages,
  cleanAndAutopsyHtml,
  extractiveAnswer,
  hostOf,
  instantAnswerPassages,
  pickCandidates,
  queryTerms,
  RESEARCH_LIMITS,
  selectPassages,
} from '../src/core/index.js';
import type {
  RankedSearchResponse,
  ResearchCandidate,
  ResearchEvent,
  ResearchRequest,
  ResearchSource,
  SearchFilterConfig,
} from '../src/core/index.js';
import { AI_PROVIDERS, streamChat } from './ai.js';
import type { AiConfig, ChatMessage } from './ai.js';
import { executeFederatedSearch } from './federatedSearch.js';
import { publicFetch, readTextCapped } from './publicFetch.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 glogg-research/0.4';
const MAX_PAGE_BYTES = 2_000_000;

export interface ResearchDeps {
  ai: AiConfig | null;
  signal?: AbortSignal;
  search?: (query: string, config?: Partial<SearchFilterConfig>) => Promise<RankedSearchResponse>;
  fetchPage?: (url: string, signal: AbortSignal, timeoutMs: number) => Promise<string>;
  chat?: (cfg: AiConfig, messages: ChatMessage[], opts: { signal?: AbortSignal; maxTokens?: number }) => AsyncIterable<string>;
}

/** Fetches a page as text, capped in size and time. Throws on non-HTML responses. */
export async function fetchPageHtml(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  try {
    // Result pages are addresses from search results: public ones only.
    const res = await publicFetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml|text\/plain/i.test(type)) throw new Error(`not a web page (${type.split(';')[0]})`);
    const html = await readTextCapped(res, MAX_PAGE_BYTES);
    // A bot check's words aren't the page's: better unread than quoted.
    const wall = botWall(html);
    if (wall) throw new Error(`${wall} check`);
    return html;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function readSource(
  c: ResearchCandidate,
  index: number,
  terms: string[],
  limits: (typeof RESEARCH_LIMITS)['quick'],
  signal: AbortSignal,
  fetchPage: NonNullable<ResearchDeps['fetchPage']>
): Promise<ResearchSource> {
  const base = { index, title: c.title, url: c.url, domain: hostOf(c.url) };
  try {
    const html = await fetchPage(c.url, signal, limits.fetchTimeoutMs);
    const report = cleanAndAutopsyHtml(html, c.url);
    const passages = selectPassages(report.sections, terms, limits.passagesPerSource, limits.charsPerSource);
    if (passages.length > 0) return { ...base, title: c.title || report.title, read: true, passages };
  } catch {
    // Unreadable page: fall back to the search snippet below.
  }
  return { ...base, read: false, passages: c.snippet ? [c.snippet] : [] };
}

export async function* runResearch(req: ResearchRequest, deps: ResearchDeps): AsyncGenerator<ResearchEvent> {
  const started = Date.now();
  const depth = req.depth === 'deep' ? 'deep' : 'quick';
  const limits = RESEARCH_LIMITS[depth];
  const signal = deps.signal ?? new AbortController().signal;
  let candidates = req.candidates;
  let instant = req.instantAnswer;

  try {
    if (!candidates) {
      yield { type: 'status', stage: 'searching', detail: 'Searching' };
      const response = await (deps.search ?? executeFederatedSearch)(req.query, req.config);
      yield { type: 'search', response };
      candidates = response.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, source: r.source }));
      instant ??= response.instantAnswer;
    }

    const picked = pickCandidates(candidates, limits.sources);
    const instantUrl = instant?.primarySourceUrl;
    // The instant answer's own source goes first; its API text beats a scraped copy.
    if (instant && instantUrl && !picked.some((c) => c.url === instantUrl)) {
      picked.unshift({ title: instant.primarySourceTitle || instant.title, url: instantUrl, snippet: instant.directAnswer });
      if (picked.length > limits.sources) picked.pop();
    } else if (instant && instantUrl) {
      const i = picked.findIndex((c) => c.url === instantUrl);
      picked.unshift(...picked.splice(i, 1));
    }

    if (picked.length === 0) {
      yield { type: 'delta', text: instant ? extractiveAnswer(req.query, [], instant) : 'No readable pages in these results to research.' };
      yield { type: 'done', mode: 'extractive', durationMs: Date.now() - started };
      return;
    }

    yield { type: 'status', stage: 'reading', detail: `Reading ${picked.length} source${picked.length === 1 ? '' : 's'}` };
    const terms = queryTerms(req.query);
    const fetchPage = deps.fetchPage ?? fetchPageHtml;
    const sources = await Promise.all(
      picked.map((c, i) =>
        instant && c.url === instantUrl
          ? Promise.resolve<ResearchSource>({
              index: i + 1,
              title: c.title,
              url: c.url,
              domain: hostOf(c.url),
              read: true,
              passages: instantAnswerPassages(instant),
            })
          : readSource(c, i + 1, terms, limits, signal, fetchPage)
      )
    );
    if (signal.aborted) return;
    yield { type: 'sources', sources };

    if (deps.ai) {
      const label = AI_PROVIDERS[deps.ai.provider]?.label ?? deps.ai.provider;
      yield { type: 'status', stage: 'writing', detail: `Writing with ${deps.ai.model}` };
      let wrote = false;
      try {
        const messages = buildResearchMessages(req.query, sources, req.history);
        for await (const piece of (deps.chat ?? streamChat)(deps.ai, messages, { signal, maxTokens: limits.maxTokens })) {
          wrote = true;
          yield { type: 'delta', text: piece };
        }
        // Nothing to show is no answer: the quotes are better than a blank.
        if (!wrote) throw new Error('the answer was empty');
        yield { type: 'done', mode: 'ai', model: deps.ai.model, durationMs: Date.now() - started };
        return;
      } catch (e) {
        if (signal.aborted) return;
        const message = e instanceof Error ? e.message : String(e);
        if (wrote) {
          yield { type: 'error', message: `${label} stopped mid-answer: ${message}` };
          return;
        }
        yield { type: 'notice', message: `${label} didn't answer (${message}). Showing quoted passages instead.` };
      }
    }

    yield { type: 'delta', text: extractiveAnswer(req.query, sources, instant) };
    yield { type: 'done', mode: 'extractive', durationMs: Date.now() - started };
  } catch (e) {
    if (signal.aborted) return;
    yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
