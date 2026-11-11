import * as cheerio from 'cheerio';
import {
  analyzeQueryIntent,
  computeQueryRelevance,
  evaluateInstantComputation,
  InstantAnswerPayload,
  InstantCitation,
  QueryAnalysis,
  ScoredSearchResult,
} from '../src/core/index.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchJsonFast<T>(url: string, timeoutMs = 3400): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface WikiExtractCandidate {
  title: string;
  extract: string;
  url: string;
  relevance: number;
}

/**
 * Fetches rich multi-sentence plain-text extracts from Wikipedia for the query's core keywords & entity.
 */
async function fetchWikipediaDirectExtract(
  analysis: QueryAnalysis
): Promise<WikiExtractCandidate | null> {
  const searchTerms = Array.from(
    new Set([analysis.keywordQuery, analysis.entitySubject, analysis.rawQuery].filter(Boolean))
  ).slice(0, 2);

  const candidates: WikiExtractCandidate[] = [];

  await Promise.all(
    searchTerms.map(async (term) => {
      const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
        term
      )}&gsrlimit=3&prop=extracts&exintro=1&explaintext=1&exsentences=5&utf8=1&format=json`;
      const data = await fetchJsonFast<{
        query?: {
          pages?: Record<
            string,
            {
              pageid: number;
              title: string;
              index?: number;
              extract?: string;
            }
          >;
        };
      }>(apiUrl, 3200);

      const pages = Object.values(data?.query?.pages ?? {});
      for (const page of pages) {
        if (!page.title || !page.extract || page.extract.length < 40) continue;
        if (/may refer to:/i.test(page.extract)) continue;
        const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(
          page.title.replace(/\s+/g, '_')
        )}`;
        const rel = computeQueryRelevance(
          analysis.rawQuery,
          page.title,
          page.extract,
          pageUrl
        );
        if (rel.matchedAnchor && rel.relevanceScore >= 46) {
          candidates.push({
            title: page.title,
            extract: page.extract.replace(/\s+/g, ' ').trim(),
            url: pageUrl,
            relevance: rel.relevanceScore + (page.index === 1 ? 8 : 0),
          });
        }
      }
    })
  );

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.relevance - a.relevance);

  const best = candidates[0];

  // If the user asked a specific attribute question (e.g. "what is the capital of kazakhstan"),
  // prioritize the exact sentence that contains the attribute + subject!
  if (analysis.questionAttribute) {
    const attr = analysis.questionAttribute.toLowerCase();
    const sentences = best.extract.split(/(?<=[.!?])\s+/);
    const matchingSentences = sentences.filter((s) => s.toLowerCase().includes(attr));
    if (matchingSentences.length > 0) {
      const remaining = sentences.filter((s) => !matchingSentences.includes(s)).slice(0, 2);
      best.extract = [...matchingSentences, ...remaining].join(' ');
    }
  }

  return best;
}

interface DdgZeroClickResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  Answer?: string;
  AnswerType?: string;
  Definition?: string;
  DefinitionURL?: string;
  Infobox?: {
    content?: Array<{
      data_type?: string;
      label?: string;
      value?: unknown;
    }>;
  };
}

async function fetchDuckDuckGoZeroClick(
  analysis: QueryAnalysis
): Promise<{
  heading: string;
  answerText: string;
  sourceUrl?: string;
  sourceName?: string;
  keyFacts: { label: string; value: string }[];
} | null> {
  const queries = Array.from(new Set([analysis.rawQuery, analysis.entitySubject].filter(Boolean)));
  for (const q of queries) {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
      q
    )}&format=json&no_html=1&skip_disambig=1`;
    const data = await fetchJsonFast<DdgZeroClickResponse>(url, 2800);
    if (!data) continue;

    const answerText = (
      data.Answer ||
      data.AbstractText ||
      data.Definition ||
      ''
    )
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const keyFacts: { label: string; value: string }[] = [];
    for (const item of data.Infobox?.content ?? []) {
      if (
        item.label &&
        typeof item.value === 'string' &&
        item.value.length > 0 &&
        item.value.length < 90 &&
        item.data_type === 'string'
      ) {
        keyFacts.push({ label: item.label, value: item.value });
      }
      if (keyFacts.length >= 6) break;
    }

    if (answerText.length >= 20) {
      const rel = computeQueryRelevance(
        analysis.rawQuery,
        data.Heading || q,
        answerText,
        data.AbstractURL || ''
      );
      if (rel.matchedAnchor || Boolean(data.Answer)) {
        return {
          heading: data.Heading || analysis.entitySubject || analysis.rawQuery,
          answerText,
          sourceUrl: data.AbstractURL || data.DefinitionURL || undefined,
          sourceName: data.AbstractSource || 'Instant Answer',
          keyFacts,
        };
      }
    }
  }
  return null;
}

interface TechnicalAnswerCandidate {
  questionTitle: string;
  questionUrl: string;
  siteName: string;
  answerText: string;
  codeBlock?: string;
  score: number;
}

/**
 * Fetches the top-voted/accepted practitioner answer body from StackExchange (StackOverflow / Unix / SuperUser)
 * when the query is a technical or how-to question.
 */
async function fetchStackExchangeTopAnswer(
  analysis: QueryAnalysis,
  keyParam = ''
): Promise<TechnicalAnswerCandidate | null> {
  if (!analysis.isTechnical && !analysis.isQuestion) return null;

  const isSysAdminOrLinux =
    /\b(?:btrfs|zfs|ext4|xfs|linux|kernel|systemd|bash|zsh|ssh|grep|awk|sed|mount|fstab|chmod|chown|iptables|nftables|pacman|apt|dnf|arch|ubuntu|debian|filesystem|copy\s+on\s+write)\b/i.test(
      analysis.normalizedQuery
    );

  const primarySite = isSysAdminOrLinux ? 'unix' : 'stackoverflow';
  const searchUrl = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&accepted=True&q=${encodeURIComponent(
    analysis.keywordQuery
  )}&site=${primarySite}&pagesize=3${keyParam}`;

  const qData = await fetchJsonFast<{
    items?: Array<{
      question_id: number;
      title: string;
      link: string;
      accepted_answer_id?: number;
      score?: number;
      answer_count?: number;
    }>;
  }>(searchUrl, 3200);

  const topQuestion = (qData?.items ?? []).find((q) => {
    const rel = computeQueryRelevance(analysis.rawQuery, q.title, '', q.link);
    return rel.matchedAnchor && rel.relevanceScore >= 62 && (q.score ?? 0) >= 3;
  });

  if (!topQuestion) return null;

  const answersUrl = `https://api.stackexchange.com/2.3/questions/${topQuestion.question_id}/answers?order=desc&sort=votes&site=${primarySite}&filter=withbody&pagesize=1${keyParam}`;
  const aData = await fetchJsonFast<{
    items?: Array<{
      answer_id: number;
      score: number;
      is_accepted: boolean;
      body: string;
    }>;
  }>(answersUrl, 3000);

  const bestAns = aData?.items?.[0];
  if (!bestAns?.body) return null;

  const $ = cheerio.load(bestAns.body);
  const firstCode = $('pre code').first().text().trim() || $('pre').first().text().trim();
  $('pre').remove();

  const paragraphs: string[] = [];
  $('p, li').each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, ' ').trim();
    if (txt.length >= 30 && paragraphs.length < 3) {
      paragraphs.push(txt);
    }
  });

  const answerText = paragraphs.join(' ').slice(0, 620);
  if (answerText.length < 35) return null;

  return {
    questionTitle: topQuestion.title
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
    questionUrl: topQuestion.link,
    siteName: primarySite === 'unix' ? 'Unix & Linux StackExchange' : 'Stack Overflow',
    answerText,
    codeBlock: firstCode ? firstCode.slice(0, 500) : undefined,
    score: bestAns.score,
  };
}

/**
 * Extracts multi-source key takeaways & citations from the top-ranked surfaced results.
 */
function buildExtractiveTakeaways(
  analysis: QueryAnalysis,
  surfacedResults: ScoredSearchResult[]
): {
  takeaways: { text: string; citationIndex: number }[];
  citations: InstantCitation[];
} {
  const topCandidates = surfacedResults
    .filter((r) => !r.p2p && r.slopScore < 35 && r.relevanceScore >= 42 && r.snippet.length >= 40)
    .slice(0, 5);

  const citations: InstantCitation[] = [];
  const takeaways: { text: string; citationIndex: number }[] = [];

  for (const res of topCandidates) {
    const cleanSnippet = res.snippet
      .replace(/^(?:Surfaced via Hacker News|Shared on Fediverse|GDELT Unfiltered Global News Wire)[^.]*\.\s*/i, '')
      .replace(/\bDiscussion: https?:\/\/\S+/gi, '')
      .replace(/\s*·\s*★\s*[\d,]+.*$/, '')
      .replace(/\s*\[SearXNG via [^\]]+\]\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // A link, a vote count or a block of code says nothing about the question.
    const letters = (cleanSnippet.match(/\p{L}/gu) || []).length;
    if (
      cleanSnippet.length < 35 ||
      (cleanSnippet.match(/\p{L}{3,}/gu) || []).length < 6 ||
      /^[\d,]+ (points?|answers?|comments?)\b/i.test(cleanSnippet) ||
      letters / cleanSnippet.replace(/\s/g, '').length < 0.6
    )
      continue;

    const citationIdx = citations.length + 1;
    citations.push({
      index: citationIdx,
      title: res.title,
      url: res.url,
      domain: res.rootDomain,
      source: res.source,
    });

    takeaways.push({
      text: cleanSnippet.slice(0, 260),
      citationIndex: citationIdx,
    });

    if (takeaways.length >= 4) break;
  }

  return { takeaways, citations };
}

/**
 * Builds the unified Instant Answer & Multi-Source Synthesis payload for any query.
 */
export type InstantAnswerLookups = [
  WikiExtractCandidate | null,
  Awaited<ReturnType<typeof fetchDuckDuckGoZeroClick>>,
  TechnicalAnswerCandidate | null,
];

// Lookups are cached per question: repeat searches, scope switches and research
// follow-ups reuse them. Misses expire sooner so a network blip isn't remembered.
const LOOKUP_TTL_MS = Number(process.env.GLOGG_CACHE_TTL_MS ?? 10 * 60_000);
const LOOKUP_MISS_TTL_MS = Math.min(LOOKUP_TTL_MS, 60_000);
const LOOKUP_CACHE_MAX = 300;
const lookupCache = new Map<string, { at: number; ttl: number; value: Promise<InstantAnswerLookups> }>();

export function clearInstantAnswerCache(): void {
  lookupCache.clear();
}

/**
 * Starts the network lookups behind an instant answer (Wikipedia, DuckDuckGo,
 * Stack Exchange). They depend only on the query, so the search starts them
 * while the sources are still being queried. Null when no lookup is needed.
 */
/** `&key=…` for the Stack Exchange API when a key is configured (300 → 10,000 requests a day). */
export function stackExchangeKeyParam(key?: string): string {
  return key ? `&key=${encodeURIComponent(key)}` : '';
}

export function prefetchInstantAnswer(rawQuery: string, opts: { stackexchangeKey?: string } = {}): Promise<InstantAnswerLookups> | null {
  if (evaluateInstantComputation(rawQuery)) return null;
  const analysis = analyzeQueryIntent(rawQuery);
  if (analysis.coreKeywords.length === 0) return null;

  const key = analysis.normalizedQuery;
  const hit = lookupCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const value = Promise.all([
    fetchWikipediaDirectExtract(analysis),
    fetchDuckDuckGoZeroClick(analysis),
    fetchStackExchangeTopAnswer(analysis, stackExchangeKeyParam(opts.stackexchangeKey)),
  ]);
  if (LOOKUP_TTL_MS > 0) {
    const entry = { at: Date.now(), ttl: LOOKUP_TTL_MS, value };
    lookupCache.set(key, entry);
    void value.then((v) => {
      if (v.every((x) => !x)) entry.ttl = LOOKUP_MISS_TTL_MS;
    });
    if (lookupCache.size > LOOKUP_CACHE_MAX) lookupCache.delete(lookupCache.keys().next().value!);
  }
  return value;
}

/**
 * Puts the answer's own source first as [1] and renumbers the others after
 * it, at most five in all. Each takeaway's number follows its source, and a
 * takeaway whose source didn't make the list goes with it, so every number
 * points at the source it quotes.
 */
function withPrimary(
  primary: InstantCitation,
  citations: InstantCitation[],
  takeaways: { text: string; citationIndex: number }[]
): { citations: InstantCitation[]; takeaways: { text: string; citationIndex: number }[] } {
  const merged: InstantCitation[] = [primary];
  const renumbered = new Map<number, number>();
  for (const c of citations) {
    if (c.url === primary.url) renumbered.set(c.index, 1);
    else if (merged.length < 5) {
      merged.push({ ...c, index: merged.length + 1 });
      renumbered.set(c.index, merged.length);
    }
  }
  return {
    citations: merged,
    takeaways: takeaways.flatMap((t) => (renumbered.has(t.citationIndex) ? [{ ...t, citationIndex: renumbered.get(t.citationIndex)! }] : [])),
  };
}

export async function buildInstantAnswer(
  rawQuery: string,
  surfacedResults: ScoredSearchResult[],
  prefetched?: Promise<InstantAnswerLookups> | null
): Promise<InstantAnswerPayload | undefined> {
  // 1. Check Instant Math / Unit / Base / Percentage Evaluator first
  const computed = evaluateInstantComputation(rawQuery);
  if (computed) {
    return computed;
  }

  const analysis = analyzeQueryIntent(rawQuery);
  if (analysis.coreKeywords.length === 0) return undefined;

  const [wikiCandidate, ddgCandidate, techCandidate] = await (prefetched ?? prefetchInstantAnswer(rawQuery)!);

  const { takeaways, citations } = buildExtractiveTakeaways(analysis, surfacedResults);

  const isConceptualQuestion =
    /^(?:what|who|where|when|why|explain|define)\b/i.test(analysis.normalizedQuery) ||
    /^how\s+(?:does|do)\s+.+\s+work/i.test(analysis.normalizedQuery);

  // 2. If practical how-to/error technical query with a strong StackExchange answer
  if (techCandidate && (!wikiCandidate || !isConceptualQuestion)) {
    const primaryCitation: InstantCitation = {
      index: 1,
      title: techCandidate.questionTitle,
      url: techCandidate.questionUrl,
      domain: new URL(techCandidate.questionUrl).hostname.replace(/^www\./, ''),
      source: 'stackexchange',
    };
    const merged = withPrimary(primaryCitation, citations, takeaways);

    return {
      kind: 'technical-answer',
      title: techCandidate.questionTitle,
      subtitle: `${techCandidate.siteName} · ${techCandidate.score} votes`,
      directAnswer: wikiCandidate
        ? `${wikiCandidate.extract.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')} — ${techCandidate.answerText}`
        : techCandidate.answerText,
      confidence: 'verified',
      codeBlock: techCandidate.codeBlock,
      takeaways: merged.takeaways.slice(0, 3),
      primarySourceUrl: techCandidate.questionUrl,
      primarySourceTitle: techCandidate.questionTitle,
      primarySourceDomain: primaryCitation.domain,
      citations: merged.citations,
    };
  }

  // 3. If Wikipedia or DuckDuckGo Instant Answer resolved the entity/fact directly
  if (wikiCandidate || ddgCandidate) {
    const bestTitle = wikiCandidate?.title || ddgCandidate?.heading || analysis.entitySubject;
    const bestAnswer = wikiCandidate?.extract || ddgCandidate?.answerText || '';
    const bestUrl =
      wikiCandidate?.url ||
      ddgCandidate?.sourceUrl ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(bestTitle.replace(/\s+/g, '_'))}`;

    const primaryCitation: InstantCitation = {
      index: 1,
      title: bestTitle,
      url: bestUrl,
      domain: new URL(bestUrl).hostname.replace(/^www\./, ''),
      source: 'wikipedia',
    };

    const merged = withPrimary(primaryCitation, citations, takeaways);

    return {
      kind: 'direct-fact',
      title: bestTitle,
      subtitle: analysis.questionAttribute ? `${analysis.questionAttribute} of ${analysis.entitySubject}` : undefined,
      directAnswer: bestAnswer,
      confidence: 'verified',
      codeBlock: techCandidate?.codeBlock,
      keyFacts: ddgCandidate?.keyFacts?.length ? ddgCandidate.keyFacts : undefined,
      takeaways: merged.takeaways.slice(0, 3),
      primarySourceUrl: bestUrl,
      primarySourceTitle: bestTitle,
      primarySourceDomain: primaryCitation.domain,
      citations: merged.citations,
    };
  }

  // 4. Fallback: Synthesize directly from the top high-relevance, zero-slop web results
  if (takeaways.length > 0 && citations.length > 0) {
    const lead = takeaways[0];
    const leadCit = citations[0];
    return {
      kind: 'knowledge-synthesis',
      title: leadCit.title,
      subtitle: undefined,
      directAnswer: lead.text,
      confidence: 'Synthesized'.toLowerCase() as 'synthesized',
      takeaways: takeaways.slice(1, 4),
      primarySourceUrl: leadCit.url,
      primarySourceTitle: leadCit.title,
      primarySourceDomain: leadCit.domain,
      citations,
    };
  }

  return undefined;
}
