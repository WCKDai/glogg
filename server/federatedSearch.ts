import * as cheerio from 'cheerio';
import {
  analyzeQueryIntent,
  compileSearchQuery,
  computeQueryRelevance,
  CURATED_INDIE_INDEX,
  diversifyAndRankResults,
  GENERIC_ATTRIBUTE_WORDS,
  RankedSearchResponse,
  RawSearchResult,
  SearchFilterConfig,
  SearchLensId,
  SourceConnectorId,
} from '../src/core/index.js';
import { createHash } from 'node:crypto';
import { buildInstantAnswer, prefetchInstantAnswer, stackExchangeKeyParam } from './answerEngine.js';
import { searchDeep } from './deep/index.js';
import type { DeepKind } from './deep/parse.js';
import { LIVE_DISCOURSE } from './deep/sources.js';
import { executeFediverseSearch } from './fediverseIndexer.js';
import { executeP2PAndUsenetSearch } from './p2pIndexer.js';
import {
  searchChanArchives,
  searchFourChanCatalogs,
  searchObscureForumsAndWildWest,
} from './wildWestIndexer.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchWithTimeout(
  url: string,
  timeoutMs = 4200,
  headers: Record<string, string> = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/html, application/xml;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1. Curated Real-Web Atlas (strictly gated by specific non-stopword, non-generic topic/tag tokens)
 */
export function searchCuratedIndieIndex(query: string): RawSearchResult[] {
  const analysis = analyzeQueryIntent(query);
  const specificTokens = analysis.coreKeywords.filter(
    (t) => t.length >= 3 && !GENERIC_ATTRIBUTE_WORDS.has(t)
  );
  if (specificTokens.length === 0) return [];

  const scored: { entry: (typeof CURATED_INDIE_INDEX)[number]; hits: number }[] = [];

  for (const entry of CURATED_INDIE_INDEX) {
    const titleAndDomain = `${entry.title} ${entry.domain}`.toLowerCase();
    const descLower = entry.description.toLowerCase();
    let hits = 0;

    for (const token of specificTokens) {
      if (
        entry.tags.some(
          (t) => t.toLowerCase() === token || token.includes(t.toLowerCase()) || t.toLowerCase().includes(token)
        )
      ) {
        hits += 4;
      } else if (titleAndDomain.includes(token)) {
        hits += 3;
      } else if (token.length >= 5 && descLower.includes(token)) {
        hits += 2;
      }
    }

    if (hits >= 3) {
      scored.push({ entry, hits });
    }
  }

  scored.sort((a, b) => b.hits - a.hits);

  return scored.slice(0, 6).map(({ entry }) => ({
    id: `indie-${entry.domain}`,
    title: entry.title,
    url: entry.url,
    snippet: entry.description,
    source: 'indie-index' as const,
    publishedAt: entry.era === 'pre-llm' || entry.era === 'classic-web' ? '2021-06-15' : '2024-01-15',
    tags: entry.tags,
    isNsfw: entry.is18Plus,
  }));
}

/**
 * 2. Marginalia Search Public API (Real Non-Commercial Small-Web Engine)
 */
async function searchMarginalia(rawQuery: string, kwQuery: string, apiKey?: string): Promise<RawSearchResult[]> {
  try {
    // api.marginalia.nu stopped answering; the API moved to api2.marginalia-search.com.
    // "public" is a shared, rate-limited key: a free personal key goes in Settings → Integrations.
    const key = apiKey || process.env.MARGINALIA_API_KEY || 'public';
    const url = `https://api2.marginalia-search.com/search?query=${encodeURIComponent(kwQuery || rawQuery)}&count=10`;
    const res = await fetchWithTimeout(url, 3800, { 'API-Key': key });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        url: string;
        title?: string;
        description?: string;
        quality?: number;
      }>;
    };

    return (data.results ?? [])
      .slice(0, 10)
      .map((item, idx) => ({
        id: `marginalia-${idx}-${item.url}`,
        title: item.title || item.url,
        url: item.url,
        snippet:
          item.description ||
          'Indexed by Marginalia Small-Web Search (non-commercial text-dense web).',
        source: 'marginalia' as const,
      }))
      .filter((r) => {
        const rel = computeQueryRelevance(rawQuery, r.title, r.snippet, r.url);
        return rel.matchedAnchor && rel.relevanceScore >= 46;
      });
  } catch {
    return [];
  }
}

/**
 * Mwmbl: a non-profit, open-source search engine with its own community-built index.
 */
async function searchMwmbl(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  try {
    const res = await fetchWithTimeout(`https://api.mwmbl.org/search?s=${encodeURIComponent(kwQuery || rawQuery)}`, 3500);
    if (!res.ok) return [];
    const data = (await res.json()) as { url: string; title?: { value: string }[]; extract?: { value: string }[] }[];
    const join = (parts?: { value: string }[]) => (parts || []).map((p) => p.value).join('').trim();
    return (Array.isArray(data) ? data : [])
      .filter((r) => /^https?:\/\//.test(r.url))
      .slice(0, 10)
      .map((r, i) => ({ id: `mwmbl-${i}-${r.url}`, title: join(r.title) || r.url, url: r.url, snippet: join(r.extract), source: 'mwmbl' as const }));
  } catch {
    return [];
  }
}

/**
 * Live search across a set of Discourse forums (Forums scope): finds old
 * threads the deep index has never seen. Three hits per forum at most.
 */
async function searchDiscourseLive(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  const q = encodeURIComponent(kwQuery || rawQuery);
  const perForum = await Promise.all(
    LIVE_DISCOURSE.map(async (host) => {
      try {
        const res = await fetchWithTimeout(`https://${host}/search.json?q=${q}`, 3500, { Accept: 'application/json' });
        if (!res.ok) return [];
        const data = (await res.json()) as {
          posts?: { topic_id: number; blurb?: string; created_at?: string; post_number?: number }[];
          topics?: { id: number; title: string; slug: string }[];
        };
        const topics = new Map((data.topics || []).map((t) => [t.id, t]));
        const seen = new Set<number>();
        const out: RawSearchResult[] = [];
        for (const p of data.posts || []) {
          const t = topics.get(p.topic_id);
          if (!t || seen.has(t.id)) continue;
          seen.add(t.id);
          out.push({
            id: `discourse-${host}-${t.id}`,
            title: t.title,
            url: `https://${host}/t/${t.slug}/${t.id}${p.post_number && p.post_number > 1 ? `/${p.post_number}` : ''}`,
            snippet: (p.blurb || '').replace(/\s+/g, ' ').trim(),
            source: 'discourse',
            publishedAt: p.created_at,
            tags: [host],
          });
          if (out.length >= 3) break;
        }
        return out;
      } catch {
        return [];
      }
    })
  );
  return perForum.flat();
}

/**
 * 3. Wiby.me JSON API (Classic Handmade & Retro Web Search Engine)
 */
async function searchWiby(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  try {
    const url = `https://wiby.me/json/?q=${encodeURIComponent(kwQuery || rawQuery)}`;
    const res = await fetchWithTimeout(url, 3600);
    if (!res.ok) return [];
    const items = (await res.json()) as Array<{
      URL?: string;
      Title?: string;
      Snippet?: string;
    }>;

    if (!Array.isArray(items)) return [];

    return items
      .filter((item) => item.URL && item.Title)
      .slice(0, 8)
      .map((item, idx) => ({
        id: `wiby-${idx}-${item.URL}`,
        title: item.Title!.trim(),
        url: item.URL!.trim(),
        snippet: (item.Snippet || 'Indexed via Wiby classic handmade web directory.')
          .replace(/\s+/g, ' ')
          .trim(),
        source: 'wiby' as const,
      }))
      .filter((r) => {
        const rel = computeQueryRelevance(rawQuery, r.title, r.snippet, r.url);
        return rel.matchedAnchor && rel.relevanceScore >= 48;
      });
  } catch {
    return [];
  }
}

/**
 * 4. SearXNG Meta-Search Connector (Local SearXNG node or user-configured SearXNG instance)
 */
async function searchSearxngNode(
  query: string,
  baseUrl = process.env.SEARXNG_URL || 'http://localhost:8080',
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  try {
    const u = new URL('/search', baseUrl);
    u.searchParams.set('q', query);
    u.searchParams.set('format', 'json');
    u.searchParams.set('safesearch', uncensoredMode ? '0' : '1');
    const res = await fetchWithTimeout(u.toString(), 2400);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        url: string;
        title: string;
        content?: string;
        engine?: string;
        publishedDate?: string;
        magnetlink?: string;
      }>;
    };

    return (data.results ?? []).slice(0, 16).map((r, idx) => ({
      id: `searxng-${idx}-${r.url}`,
      title: r.title,
      url: r.magnetlink || r.url,
      snippet: `${r.content || r.title} [SearXNG via ${r.engine || 'federated'}]`,
      source: 'web' as const,
      publishedAt: r.publishedDate,
    }));
  } catch {
    return [];
  }
}

/**
 * 5. Lemmy / Fediverse Public Search API (extracts independent links & community threads)
 */
async function searchLemmyFediverse(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  try {
    const url = `https://lemmy.world/api/v3/search?q=${encodeURIComponent(
      kwQuery || rawQuery
    )}&type_=Posts&sort=TopAll&limit=8`;
    const res = await fetchWithTimeout(url, 3800);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      posts?: Array<{
        post: {
          id: number;
          name: string;
          url?: string;
          body?: string;
          ap_id: string;
          published?: string;
        };
        community?: {
          name?: string;
          title?: string;
        };
        counts?: {
          score?: number;
          comments?: number;
        };
      }>;
    };

    const results: RawSearchResult[] = [];
    for (const entry of data.posts ?? []) {
      const p = entry.post;
      if (!p?.name) continue;
      if (
        p.url &&
        p.url.startsWith('http') &&
        !p.url.includes('lemmy.world/pictrs') &&
        !/\.(jpg|jpeg|png|gif|webp)$/i.test(p.url)
      ) {
        results.push({
          id: `lemmy-ext-${p.id}`,
          title: p.name,
          url: p.url,
          snippet: `Shared on Fediverse c/${entry.community?.name || 'lemmy'} (${
            entry.counts?.score ?? 0
          } pts, ${entry.counts?.comments ?? 0} comments). ${p.body?.slice(0, 180) || ''}`,
          source: 'lemmy',
          publishedAt: p.published,
          points: entry.counts?.score,
          commentsCount: entry.counts?.comments,
        });
      }
      results.push({
        id: `lemmy-post-${p.id}`,
        title: `[Fediverse c/${entry.community?.name || 'community'}] ${p.name}`,
        url: p.ap_id || `https://lemmy.world/post/${p.id}`,
        snippet:
          p.body?.slice(0, 240) ||
          `Fediverse discussion in ${entry.community?.title || 'Lemmy'} (${
            entry.counts?.comments ?? 0
          } comments).`,
        source: 'lemmy',
        publishedAt: p.published,
        points: entry.counts?.score,
        commentsCount: entry.counts?.comments,
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 6. OpenAlex Global Scholarly Works & Datasets API (250M+ Primary Research Works)
 */
async function searchOpenAlex(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(
      kwQuery || rawQuery
    )}&per-page=6`;
    const res = await fetchWithTimeout(url, 3800);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        id: string;
        doi?: string;
        title?: string;
        display_name?: string;
        publication_date?: string;
        cited_by_count?: number;
        primary_location?: {
          landing_page_url?: string;
          pdf_url?: string;
          source?: { display_name?: string };
        };
      }>;
    };

    return (data.results ?? [])
      .filter((w) => w.title || w.display_name)
      .map((w) => {
        const targetUrl =
          w.primary_location?.pdf_url ||
          w.primary_location?.landing_page_url ||
          w.doi ||
          w.id;
        const venue = w.primary_location?.source?.display_name || 'OpenAlex Scholarly Index';
        return {
          id: `openalex-${w.id}`,
          title: `[Research] ${w.title || w.display_name}`,
          url: targetUrl,
          snippet: `Published in ${venue} (${w.publication_date || 'n.d.'}) · Cited by ${
            w.cited_by_count ?? 0
          } peer-reviewed works.${w.doi ? ` DOI: ${w.doi}` : ''}`,
          source: 'openalex' as const,
          publishedAt: w.publication_date,
          points: w.cited_by_count,
        };
      });
  } catch {
    return [];
  }
}

/**
 * 7. Hacker News (Algolia API)
 */
async function searchHackerNews(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
      kwQuery || rawQuery
    )}&tags=story&hitsPerPage=14`;
    const res = await fetchWithTimeout(url, 3800);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      hits?: Array<{
        objectID: string;
        title?: string;
        url?: string;
        story_text?: string;
        author?: string;
        points?: number;
        num_comments?: number;
        created_at?: string;
      }>;
    };

    const results: RawSearchResult[] = [];
    for (const hit of data.hits ?? []) {
      if (!hit.title) continue;
      const hnThreadUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
      if (hit.url && hit.url.startsWith('http')) {
        results.push({
          id: `hn-ext-${hit.objectID}`,
          title: hit.title,
          url: hit.url,
          snippet: `Surfaced via Hacker News (${hit.points ?? 0} pts, ${hit.num_comments ?? 0} comments by @${hit.author ?? 'anon'}). Discussion: ${hnThreadUrl}`,
          source: 'web',
          publishedAt: hit.created_at,
          author: hit.author,
          points: hit.points,
          commentsCount: hit.num_comments,
        });
      }
      if ((hit.num_comments ?? 0) >= 15 || !hit.url) {
        results.push({
          id: `hn-disc-${hit.objectID}`,
          title: `[HN Discussion] ${hit.title}`,
          url: hnThreadUrl,
          snippet:
            hit.story_text?.replace(/<[^>]+>/g, ' ').slice(0, 260) ||
            `${hit.num_comments ?? 0} practitioner comments & ${hit.points ?? 0} points discussing "${hit.title}" on Hacker News.`,
          source: 'hn',
          publishedAt: hit.created_at,
          author: hit.author,
          points: hit.points,
          commentsCount: hit.num_comments,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 8. Wikipedia Reference (with entity extraction + relevance sorting)
 */
async function searchWikipedia(rawQuery: string, kwQuery: string, entitySubject: string): Promise<RawSearchResult[]> {
  try {
    const searchQ = kwQuery || entitySubject || rawQuery;
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      searchQ
    )}&utf8=1&format=json&srlimit=6`;
    const res = await fetchWithTimeout(url, 3500);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: {
        search?: Array<{
          pageid: number;
          title: string;
          snippet: string;
        }>;
      };
    };

    const mapped = (data.query?.search ?? []).map((item) => {
      const cleanSnippet = item.snippet
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
      const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(
        item.title.replace(/\s+/g, '_')
      )}`;
      const rel = computeQueryRelevance(rawQuery, item.title, cleanSnippet, wikiUrl);
      return {
        raw: {
          id: `wiki-${item.pageid}`,
          title: `${item.title} — Wikipedia Reference`,
          url: wikiUrl,
          snippet: cleanSnippet,
          source: 'wikipedia' as const,
          publishedAt: '2021-01-01',
        },
        score: rel.relevanceScore + (rel.isDirectAnswerCandidate ? 20 : 0),
      };
    });

    mapped.sort((a, b) => b.score - a.score);
    return mapped.map((m) => m.raw);
  } catch {
    return [];
  }
}

/**
 * 9. StackExchange Network (queries both StackOverflow and Unix/SuperUser for technical/OS queries)
 */
async function searchStackExchange(
  rawQuery: string,
  kwQuery: string,
  isTechnical: boolean,
  apiKey?: string
): Promise<RawSearchResult[]> {
  try {
    const searchQ = kwQuery || rawQuery;
    const sites = ['stackoverflow'];
    if (
      isTechnical ||
      /\b(?:btrfs|zfs|ext4|linux|ubuntu|arch|debian|systemd|ssh|bash|zsh|kernel|filesystem|mount|copy\s+on\s+write|cow|windows|macos|bios|disk)\b/i.test(
        rawQuery
      )
    ) {
      sites.push('unix', 'superuser');
    }

    const siteResponses = await Promise.all(
      sites.map(async (site) => {
        try {
          const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(
            searchQ
          )}&site=${site}&pagesize=4${stackExchangeKeyParam(apiKey)}`;
          const res = await fetchWithTimeout(url, 3600);
          if (!res.ok) return [];
          const data = (await res.json()) as {
            items?: Array<{
              question_id: number;
              title: string;
              link: string;
              score?: number;
              answer_count?: number;
              creation_date?: number;
              tags?: string[];
            }>;
          };

          return (data.items ?? []).map((item) => ({
            id: `se-${site}-${item.question_id}`,
            title: item.title
              .replace(/&#39;/g, "'")
              .replace(/&quot;/g, '"')
              .replace(/&amp;/g, '&'),
            url: item.link,
            snippet: `Verified practitioner Q&A thread on ${site} (${item.answer_count ?? 0} answers, score ${
              item.score ?? 0
            }). Tags: ${(item.tags ?? []).join(', ')}`,
            source: 'stackexchange' as const,
            publishedAt: item.creation_date
              ? new Date(item.creation_date * 1000).toISOString()
              : undefined,
            points: item.score,
            commentsCount: item.answer_count,
            tags: item.tags,
          }));
        } catch {
          return [];
        }
      })
    );

    return siteResponses.flat();
  } catch {
    return [];
  }
}

/**
 * 10. arXiv Preprints
 */
async function searchArxiv(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  try {
    const terms = (kwQuery || rawQuery)
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 5);
    if (terms.length === 0) return [];
    const arxivExpr = terms.map((t) => `all:${encodeURIComponent(t)}`).join('+AND+');
    const url = `https://export.arxiv.org/api/query?search_query=${arxivExpr}&start=0&max_results=5`;
    const res = await fetchWithTimeout(url, 4000);
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const results: RawSearchResult[] = [];

    $('entry').each((_, el) => {
      const idUrl = $(el).find('id').first().text().trim();
      const title = $(el).find('title').first().text().replace(/\s+/g, ' ').trim();
      const summary = $(el).find('summary').first().text().replace(/\s+/g, ' ').trim();
      const published = $(el).find('published').first().text().trim();
      const author = $(el).find('author > name').first().text().trim();
      if (idUrl && title) {
        results.push({
          id: `arxiv-${idUrl}`,
          title: `[arXiv Paper] ${title}`,
          url: idUrl.replace(/^http:\/\//i, 'https://'),
          snippet: summary.slice(0, 320),
          source: 'arxiv',
          publishedAt: published || undefined,
          author: author || undefined,
        });
      }
    });

    return results;
  } catch {
    return [];
  }
}

/**
 * 11. GitHub Open Source Repositories
 */
async function searchGitHub(
  rawQuery: string,
  kwQuery: string,
  isTechnical: boolean
): Promise<RawSearchResult[]> {
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
      kwQuery || rawQuery
    )}&sort=stars&order=desc&per_page=6`;
    const res = await fetchWithTimeout(url, 3800, {
      Accept: 'application/vnd.github+json',
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: Array<{
        id: number;
        full_name: string;
        html_url: string;
        description?: string;
        stargazers_count?: number;
        created_at?: string;
        topics?: string[];
      }>;
    };

    const minStars = isTechnical ? 5 : 25;
    const results: RawSearchResult[] = [];
    for (const repo of data.items ?? []) {
      if ((repo.stargazers_count ?? 0) < minStars) continue;
      results.push({
        id: `gh-${repo.id}`,
        title: `${repo.full_name} — Source Repository`,
        url: repo.html_url,
        snippet: `${repo.description || 'Primary source code repository'} (★ ${
          repo.stargazers_count ?? 0
        }). Topics: ${(repo.topics ?? []).slice(0, 6).join(', ')}`,
        source: 'github',
        publishedAt: repo.created_at,
        points: repo.stargazers_count,
        tags: repo.topics,
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 12a. DuckDuckGo Organic Web (with SafeSearch completely disabled kp=-2 when uncensoredMode is active)
 */
async function searchDuckDuckGoHtml(
  query: string,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  try {
    const safeParam = uncensoredMode ? '&kp=-2' : '';
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${safeParam}`;
    const res = await fetchWithTimeout(url, 4000);
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: RawSearchResult[] = [];

    $('.result').each((idx, el) => {
      if (results.length >= 22) return;
      const anchor = $(el).find('a.result__a').first();
      const title = anchor.text().replace(/\s+/g, ' ').trim();
      let href = anchor.attr('href') || '';
      const snippet = $(el).find('.result__snippet').first().text().replace(/\s+/g, ' ').trim();
      const isAdBadge = $(el).hasClass('result--ad') || $(el).find('.badge--ad').length > 0;

      if (href.includes('uddg=')) {
        try {
          const parsed = new URL(href, 'https://html.duckduckgo.com');
          const actual = parsed.searchParams.get('uddg');
          if (actual) href = actual;
        } catch {
          // ignore
        }
      }

      if (title && href.startsWith('http')) {
        results.push({
          id: `ddg-${idx}-${href}`,
          title: isAdBadge ? `[Sponsored] ${title}` : title,
          url: href,
          snippet: snippet || title,
          source: 'web',
        });
      }
    });

    return results;
  } catch {
    return [];
  }
}

/**
 * 12b. Brave Search Organic Web Index (independent web crawler index for broader organic coverage)
 */
async function searchBraveWebHtml(
  query: string,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  try {
    const safeParam = uncensoredMode ? '&safesearch=off' : '&safesearch=moderate';
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web${safeParam}`;
    const res = await fetchWithTimeout(url, 3800);
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: RawSearchResult[] = [];

    $('div.snippet[data-type="web"], div.snippet').each((idx, el) => {
      if (results.length >= 16) return;
      const anchor = $(el).find('a[href^="http"]').first();
      const href = anchor.attr('href') || '';
      if (!href || href.includes('brave.com')) return;

      const title =
        $(el).find('.title, .snippet-title').first().text().replace(/\s+/g, ' ').trim() ||
        anchor.text().replace(/\s+/g, ' ').trim();
      const snippet =
        $(el)
          .find('.snippet-description, . snippet-content, .generic-snippet .content')
          .first()
          .text()
          .replace(/\s+/g, ' ')
          .trim() || title;

      if (title && href.startsWith('http')) {
        results.push({
          id: `brave-${idx}-${href}`,
          title,
          url: href,
          snippet,
          source: 'web',
        });
      }
    });

    return results;
  } catch {
    return [];
  }
}

/**
 * 13. GDELT Project Global Unfiltered Real-World News Wire API (v2 DOC API)
 */
async function searchGdeltRawNews(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
      kwQuery || rawQuery
    )}&mode=artlist&maxrecords=7&format=json`;
    const res = await fetchWithTimeout(url, 3800);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      articles?: Array<{
        url: string;
        title?: string;
        seendate?: string;
        domain?: string;
        sourcecountry?: string;
        language?: string;
      }>;
    };

    return (data.articles ?? [])
      .filter((a) => a.url && a.title)
      .slice(0, 6)
      .map((a, idx) => {
        let isoDate: string | undefined;
        if (a.seendate && /^(\d{4})(\d{2})(\d{2})T/.test(a.seendate)) {
          const m = a.seendate.match(/^(\d{4})(\d{2})(\d{2})/);
          if (m) isoDate = `${m[1]}-${m[2]}-${m[3]}`;
        }
        return {
          id: `gdelt-${idx}-${a.url}`,
          title: `[Raw Wire · ${a.sourcecountry || a.domain || 'Global'}] ${a.title!.trim()}`,
          url: a.url,
          snippet: `GDELT Unfiltered Global News Wire · Source: ${a.domain || 'Wire'} (${
            a.sourcecountry || 'International'
          }${a.language ? `, ${a.language}` : ''}). Indexed without algorithmic editorializing.`,
          source: 'gdelt-news' as const,
          publishedAt: isoDate,
        };
      });
  } catch {
    return [];
  }
}

/**
 * 14. Internet Archive Deep Texts, FOIA & Historical Collections API
 */
async function searchArchiveDeepTexts(rawQuery: string, kwQuery: string): Promise<RawSearchResult[]> {
  try {
    const terms = (kwQuery || rawQuery)
      .split(/\s+/)
      .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter((t) => t.length >= 2)
      .slice(0, 5);
    if (terms.length === 0) return [];

    const q = `(${terms.map((t) => `title:(${t})`).join(' AND ')}) AND mediatype:(texts OR data OR collection)`;
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(
      q
    )}&fl[]=identifier,title,description,mediatype,downloads,publicdate&sort[]=downloads+desc&rows=5&page=1&output=json`;
    const res = await fetchWithTimeout(url, 3900);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      response?: {
        docs?: Array<{
          identifier: string;
          title?: string;
          description?: string | string[];
          mediatype?: string;
          downloads?: number;
          publicdate?: string;
        }>;
      };
    };

    return (data.response?.docs ?? [])
      .filter((d) => d.identifier && d.title)
      .map((d) => {
        const rawDesc = Array.isArray(d.description) ? d.description[0] : d.description || '';
        const cleanDesc = String(rawDesc).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return {
          id: `archive-deep-${d.identifier}`,
          title: `[Deep Archive] ${d.title}`,
          url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
          snippet:
            cleanDesc.slice(0, 260) ||
            `Internet Archive primary preservation record (${d.mediatype || 'texts'}, ${(
              d.downloads ?? 0
            ).toLocaleString()} downloads).`,
          source: 'archive-deep' as const,
          publishedAt: d.publicdate,
          points: d.downloads,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Waits for sources until:
 *  (a) everything has settled, or
 *  (b) every core source for this scope has answered with enough results and a
 *      short grace period has passed (so quick small-web sources still make it), or
 *  (c) the soft deadline has passed and core sources have enough results or are all done, or
 *  (d) the hard deadline hits.
 * Late sources are dropped, so one slow upstream never stalls the page; a cold
 * start with empty core sources still waits up to the hard deadline.
 */
const SOFT_DEADLINE_MS = Number(process.env.GLOGG_SOURCE_DEADLINE_MS || 2000);
const HARD_DEADLINE_MS = Number(process.env.GLOGG_HARD_DEADLINE_MS || 7000);
const CORE_GRACE_MS = Number(process.env.GLOGG_CORE_GRACE_MS || 500);
const MIN_WAIT_MS = Number(process.env.GLOGG_MIN_WAIT_MS || 1000);
const MIN_CORE_RESULTS = 6;

interface SourceTask {
  key: string;
  core: boolean;
  run: () => Promise<RawSearchResult[]>;
}

export interface SourceTiming {
  ms: number;
  count: number;
  status: 'ok' | 'empty' | 'error' | 'late' | 'resting';
}

export interface GatherOptions {
  softMs?: number;
  hardMs?: number;
  minCore?: number;
  graceMs?: number;
  minWaitMs?: number;
  timings?: Record<string, SourceTiming>;
  /** Called when each source settles, even after the gather has returned. */
  onSettle?: (key: string, ms: number, count: number, failed: boolean) => void;
}

export async function gatherSources(tasks: SourceTask[], opts: GatherOptions = {}): Promise<Record<string, RawSearchResult[]>> {
  const softMs = opts.softMs ?? SOFT_DEADLINE_MS;
  const hardMs = opts.hardMs ?? HARD_DEADLINE_MS;
  const minCore = opts.minCore ?? MIN_CORE_RESULTS;
  const graceMs = opts.graceMs ?? CORE_GRACE_MS;
  const minWaitMs = opts.minWaitMs ?? Math.min(MIN_WAIT_MS, softMs);
  const out: Record<string, RawSearchResult[]> = Object.fromEntries(tasks.map((t) => [t.key, []]));
  if (tasks.length === 0) return out;

  await new Promise<void>((resolve) => {
    const start = Date.now();
    const coreTotal = tasks.filter((t) => t.core).length;
    let settled = 0;
    let coreSettled = 0;
    let coreCount = 0;
    let coreDoneAt = coreTotal === 0 ? start : 0;
    let finished = false;
    const timers: NodeJS.Timeout[] = [];

    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      if (opts.timings) {
        for (const t of tasks) opts.timings[t.key] ??= { ms: Date.now() - start, count: 0, status: 'late' };
      }
      resolve();
    };
    const check = () => {
      const now = Date.now();
      const elapsed = now - start;
      const coreDone = coreSettled === coreTotal;
      if (
        settled === tasks.length ||
        elapsed >= hardMs ||
        (elapsed >= softMs && (coreCount >= minCore || coreDone)) ||
        (coreDone && coreCount >= minCore && now - coreDoneAt >= graceMs && elapsed >= minWaitMs)
      ) {
        finish();
      }
    };
    const at = (ms: number) => timers.push(setTimeout(check, Math.max(0, ms)));
    at(softMs);
    at(hardMs);
    at(minWaitMs);

    for (const t of tasks) {
      let p: Promise<RawSearchResult[]>;
      try {
        p = t.run();
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (v) => ({ v: Array.isArray(v) ? v : [], failed: false }),
        () => ({ v: [] as RawSearchResult[], failed: true })
      ).then(({ v, failed }) => {
        const ms = Date.now() - start;
        opts.onSettle?.(t.key, ms, v.length, failed);
        if (finished) return;
        out[t.key] = v;
        if (opts.timings) opts.timings[t.key] = { ms, count: v.length, status: failed ? 'error' : v.length ? 'ok' : 'empty' };
        settled += 1;
        if (t.core) {
          coreCount += v.length;
          coreSettled += 1;
          if (coreSettled === coreTotal) {
            coreDoneAt = Date.now();
            at(graceMs);
          }
        }
        check();
      });
    }
    check();
  });
  return out;
}

// ── Source health: upstreams that keep hanging rest for a while ─────────────
// A source "hangs" when it ends empty after 3s or more (its own timeout fired)
// or throws. Fast empties (no match, rate limit) cost nothing and don't count.
const HANG_MS = 3000;
const FAILS_TO_REST = 2;
const REST_MS = Number(process.env.GLOGG_SOURCE_REST_MS || 5 * 60_000);
const sourceHealth = new Map<string, { fails: number; restUntil: number }>();

export function resetSourceHealth(): void {
  sourceHealth.clear();
}

export function isSourceResting(key: string, now = Date.now()): boolean {
  return (sourceHealth.get(key)?.restUntil ?? 0) > now;
}

export function recordSourceOutcome(key: string, ms: number, count: number, failed: boolean): void {
  const h = sourceHealth.get(key) ?? { fails: 0, restUntil: 0 };
  if (failed || (count === 0 && ms >= HANG_MS)) {
    h.fails += 1;
    if (h.fails >= FAILS_TO_REST) h.restUntil = Date.now() + REST_MS;
  } else {
    h.fails = 0;
    h.restUntil = 0;
  }
  sourceHealth.set(key, h);
}

// ── Per-source result cache ─────────────────────────────────────────────────
// Scope switches, filter toggles, back/forward and research follow-ups repeat
// the same upstream calls; ranking still runs fresh with the current filters.
// A source that answers after the deadline still lands here for next time.
const CACHE_TTL_MS = Number(process.env.GLOGG_CACHE_TTL_MS ?? 10 * 60_000);
const CACHE_EMPTY_TTL_MS = Math.min(CACHE_TTL_MS, 60_000);
const CACHE_MAX = 600;
const sourceCache = new Map<string, { at: number; ttl: number; value: Promise<RawSearchResult[]> }>();

export function clearSearchCache(): void {
  sourceCache.clear();
}

/** Cached and de-duplicated: a repeat call joins the in-flight request. Errors are not cached. */
export function cachedSource(key: string, run: () => Promise<RawSearchResult[]>): Promise<RawSearchResult[]> {
  if (CACHE_TTL_MS <= 0) return run();
  const hit = sourceCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) {
    sourceCache.delete(key);
    sourceCache.set(key, hit);
    return hit.value;
  }
  const entry = { at: Date.now(), ttl: CACHE_TTL_MS, value: run() };
  sourceCache.set(key, entry);
  if (sourceCache.size > CACHE_MAX) sourceCache.delete(sourceCache.keys().next().value!);
  entry.value.then(
    (v) => {
      entry.at = Date.now();
      entry.ttl = v.length ? CACHE_TTL_MS : CACHE_EMPTY_TTL_MS;
    },
    () => {
      if (sourceCache.get(key) === entry) sourceCache.delete(key);
    }
  );
  return entry.value;
}

const CORE_BY_LENS: Partial<Record<SearchLensId, string[]>> = {
  'p2p-magnet': ['p2p'],
  'usenet-nzb': ['p2p'],
  fediverse: ['fediverse', 'lemmy'],
  'small-web': ['marginalia', 'wiby', 'deep', 'mwmbl'],
  'wild-west': ['chanLive', 'chanArchive', 'forums', 'hn', 'deep'],
  forums: ['forums', 'hn', 'se', 'lemmy', 'deep'],
  primary: ['openalex', 'arxiv', 'github', 'wiki'],
  'deep-archives': ['archive', 'openalex'],
  'raw-news': ['gdelt', 'searxng', 'ddg'],
};
const DEFAULT_CORE = ['searxng', 'ddg', 'brave', 'se', 'wiki', 'hn', 'github', 'deep'];
/** Which parts of the deep index each scope searches (scopes not listed skip it). */
const DEEP_KINDS_BY_LENS: Partial<Record<SearchLensId, DeepKind[] | 'all'>> = {
  all: 'all',
  'small-web': ['blog'],
  forums: ['forum'],
  'wild-west': ['board', 'forum'],
};
/** Time from the start of a search that the instant answer may take. */
const ANSWER_BUDGET_MS = Number(process.env.GLOGG_ANSWER_BUDGET_MS || 2200);

export async function executeFederatedSearch(
  rawQuery: string,
  partialConfig?: Partial<SearchFilterConfig>
): Promise<RankedSearchResponse> {
  const startTime = Date.now();
  const query = rawQuery.trim();
  const uncensoredMode = Boolean(partialConfig?.uncensoredMode);
  const lens = partialConfig?.lens ?? 'all';
  const compiledQuery = compileSearchQuery(query, partialConfig);
  // Answer lookups need only the query, so they run while the sources are searched.
  const answerLookups = prefetchInstantAnswer(query, { stackexchangeKey: partialConfig?.endpoints?.stackexchangeKey });
  const analysis = analyzeQueryIntent(query);
  const kwQuery = analysis.keywordQuery || query;
  const wantsWildWest = lens === 'wild-west' || lens === 'forums' || uncensoredMode;
  const core = new Set(CORE_BY_LENS[lens] ?? DEFAULT_CORE);

  const sourcesQueried: SourceConnectorId[] = [
    'marginalia',
    'wiby',
    'indie-index',
    'atproto',
    'activitypub',
    'matrix',
    'stoat',
    'lemmy',
    'gdelt-news',
    'archive-deep',
    'hn',
    'openalex',
    'arxiv',
    'github',
    'stackexchange',
    'wikipedia',
    'bitmagnet-dht',
    'archive-bt',
    'usenet-nzb',
    'web',
    'mwmbl',
    ...(DEEP_KINDS_BY_LENS[lens] ? (['deep-blogs', 'deep-boards', 'deep-forums'] as SourceConnectorId[]) : []),
    ...(lens === 'forums' ? (['discourse'] as SourceConnectorId[]) : []),
    ...(wantsWildWest ? (['chanboards', 'wild-west'] as SourceConnectorId[]) : []),
  ];

  const tasks: Omit<SourceTask, 'core'>[] = [
    { key: 'marginalia', run: () => searchMarginalia(query, kwQuery, partialConfig?.endpoints?.marginaliaApiKey) },
    { key: 'wiby', run: () => searchWiby(query, kwQuery) },
    { key: 'searxng', run: () => searchSearxngNode(query, partialConfig?.endpoints?.searxngUrl, uncensoredMode) },
    { key: 'lemmy', run: () => searchLemmyFediverse(query, kwQuery) },
    { key: 'fediverse', run: () => executeFediverseSearch(query, uncensoredMode) },
    { key: 'gdelt', run: () => searchGdeltRawNews(query, kwQuery) },
    { key: 'archive', run: () => searchArchiveDeepTexts(query, kwQuery) },
    { key: 'openalex', run: () => searchOpenAlex(query, kwQuery) },
    { key: 'hn', run: () => searchHackerNews(query, kwQuery) },
    { key: 'wiki', run: () => searchWikipedia(query, kwQuery, analysis.entitySubject) },
    { key: 'se', run: () => searchStackExchange(query, kwQuery, analysis.isTechnical, partialConfig?.endpoints?.stackexchangeKey) },
    { key: 'arxiv', run: () => searchArxiv(query, kwQuery) },
    { key: 'github', run: () => searchGitHub(query, kwQuery, analysis.isTechnical) },
    { key: 'ddg', run: () => searchDuckDuckGoHtml(query, uncensoredMode) },
    { key: 'brave', run: () => searchBraveWebHtml(query, uncensoredMode) },
    { key: 'p2p', run: () => executeP2PAndUsenetSearch(query, partialConfig?.endpoints, uncensoredMode) },
    { key: 'mwmbl', run: () => searchMwmbl(query, kwQuery) },
  ];
  const deepKinds = DEEP_KINDS_BY_LENS[lens];
  if (deepKinds) {
    tasks.push({
      key: 'deep',
      run: () => searchDeep(query, { nsfw: uncensoredMode, kinds: deepKinds === 'all' ? undefined : deepKinds, limit: 12 }),
    });
  }
  if (lens === 'forums') tasks.push({ key: 'discourse', run: () => searchDiscourseLive(query, kwQuery) });
  if (wantsWildWest) {
    tasks.push(
      { key: 'chanLive', run: () => searchFourChanCatalogs(query, uncensoredMode) },
      { key: 'chanArchive', run: () => searchChanArchives(query, uncensoredMode) },
      { key: 'forums', run: () => searchObscureForumsAndWildWest(query) }
    );
  }

  const sourceTimings: Record<string, SourceTiming> = {};
  const endpointsSig = createHash('sha1').update(JSON.stringify(partialConfig?.endpoints || {})).digest('hex').slice(0, 12);
  const cacheKey = (key: string) => `${key}|${uncensoredMode ? 1 : 0}|${endpointsSig}|${query.toLowerCase()}`;
  const runnable = tasks.filter((t) => {
    if (!isSourceResting(t.key)) return true;
    sourceTimings[t.key] = { ms: 0, count: 0, status: 'resting' };
    return false;
  });
  const got = await gatherSources(
    // The deep index is local and grows while it crawls, so it is never cached.
    runnable.map((t) => ({ key: t.key, core: core.has(t.key), run: t.key === 'deep' ? t.run : () => cachedSource(cacheKey(t.key), t.run) })),
    { timings: sourceTimings, onSettle: recordSourceOutcome }
  );
  const pick = (k: string) => got[k] ?? [];
  const indieResults = searchCuratedIndieIndex(query);

  const allRaw: RawSearchResult[] = [
    ...pick('wiki'),
    ...pick('se'),
    ...pick('ddg'),
    ...pick('brave'),
    ...pick('searxng'),
    ...pick('hn'),
    ...pick('github'),
    ...pick('forums'),
    ...pick('discourse'),
    ...pick('deep'),
    ...pick('chanArchive'),
    ...pick('chanLive'),
    ...indieResults,
    ...pick('marginalia'),
    ...pick('wiby'),
    ...pick('mwmbl'),
    ...pick('fediverse'),
    ...pick('lemmy'),
    ...pick('gdelt'),
    ...pick('archive'),
    ...pick('openalex'),
    ...pick('arxiv'),
    ...pick('p2p'),
  ];

  const ranked = diversifyAndRankResults(allRaw, partialConfig, query);
  // The answer started with the search; give it what's left of its budget.
  const answerWaitMs = Math.max(50, ANSWER_BUDGET_MS - (Date.now() - startTime));
  let answerTimer: NodeJS.Timeout | undefined;
  const instantAnswer = await Promise.race([
    buildInstantAnswer(query, ranked.surfaced, answerLookups),
    new Promise<undefined>((resolve) => {
      answerTimer = setTimeout(() => resolve(undefined), answerWaitMs);
    }),
  ])
    .catch(() => undefined)
    .finally(() => clearTimeout(answerTimer));
  const durationMs = Date.now() - startTime;

  return {
    query,
    lens: partialConfig?.lens ?? 'all',
    uncensoredMode,
    compiledQuery,
    instantAnswer,
    results: ranked.surfaced,
    p2pResults: ranked.p2pResults,
    filteredSlop: ranked.filteredSlop,
    metrics: {
      totalRawResults: allRaw.length,
      surfacedCount: ranked.surfaced.length,
      p2pCount: ranked.p2pResults.length,
      fediverseCount: ranked.fediverseCount,
      filteredSlopCount: ranked.filteredSlop.length,
      sponsoredRemovedCount: ranked.sponsoredRemovedCount,
      primarySourcesCount: ranked.primarySourcesCount,
      demotedDuplicateDomainsCount: ranked.demotedDuplicateDomainsCount,
      uniqueDomainsCount: ranked.uniqueDomainsCount,
      tldDistribution: ranked.tldDistribution,
      sourceDistribution: ranked.sourceDistribution,
      domainDiversityRatio: ranked.domainDiversityRatio,
      avgAuthenticityScore: ranked.avgAuthenticityScore,
      avgSlopScore: ranked.avgSlopScore,
      sourcesQueried,
      sourceTimings,
      durationMs,
    },
  };
}
