import { analyzeQueryIntent } from './queryIntelligence.js';
import { scoreSearchResult } from './slopScorer.js';
import {
  RawSearchResult,
  ScoredSearchResult,
  SearchFilterConfig,
  SearchLensId,
} from './types.js';

export const DEFAULT_FILTER_CONFIG: SearchFilterConfig = {
  lens: 'all',
  maxPerDomain: 1,
  slopThreshold: 50,
  preLlmOnly: false,
  obscureWebOnly: false,
  stripSponsored: true,
  uncensoredMode: false,
  blockedDomains: [],
  boostedDomains: [],
  blockedPhrases: [],
};

function normalizeTitleFingerprint(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8)
    .join(' ');
}

function computeLensBonus(item: ScoredSearchResult, lens: SearchLensId): number {
  switch (lens) {
    case 'p2p-magnet':
      if (item.p2p?.protocol === 'bittorrent-dht') return 65;
      if (item.source === 'bitmagnet-dht' || item.source === 'archive-bt' || item.source === 'academic-torrents') {
        return 60;
      }
      return -25;
    case 'usenet-nzb':
      if (item.p2p?.protocol === 'usenet-nzb' || item.source === 'usenet-nzb') return 65;
      return -25;
    case 'fediverse':
      if (
        item.fediverse ||
        item.source === 'atproto' ||
        item.source === 'activitypub' ||
        item.source === 'matrix' ||
        item.source === 'stoat' ||
        item.source === 'lemmy'
      ) {
        return 60;
      }
      return -20;
    case 'deep-archives':
      if (
        item.source === 'archive-deep' ||
        item.source === 'archive' ||
        item.source === 'archive-bt' ||
        item.source === 'academic-torrents' ||
        item.signals.some((s) => s.id === 'deep-archive-osint')
      ) {
        return 55;
      }
      return -15;
    case 'raw-news':
      if (
        item.source === 'gdelt-news' ||
        item.source === 'atproto' ||
        item.source === 'activitypub' ||
        item.source === 'hn' ||
        item.source === 'lemmy' ||
        item.signals.some((s) => s.id === 'deep-archive-osint')
      ) {
        return 50;
      }
      return -15;
    case 'primary':
      if (
        item.isPrimarySource ||
        item.verdict === 'primary-source' ||
        item.source === 'arxiv' ||
        item.source === 'openalex' ||
        item.source === 'wikipedia' ||
        item.source === 'github' ||
        item.source === 'codeberg'
      ) {
        return 38;
      }
      return -12;
    case 'small-web':
      if (
        item.isIndieWeb ||
        item.verdict === 'indie-gem' ||
        item.source === 'marginalia' ||
        item.source === 'wiby' ||
        item.source === 'indie-index' ||
        item.source === 'deep-blogs'
      ) {
        return 40;
      }
      if (!item.isBigTechMonoculture) return 14;
      return -18;
    case 'forums':
      if (
        item.source === 'hn' ||
        item.source === 'lobsters' ||
        item.source === 'lemmy' ||
        item.source === 'stackexchange' ||
        item.source === 'deep-forums' ||
        item.source === 'discourse' ||
        item.signals.some((s) => s.id === 'human-community-thread')
      ) {
        return 38;
      }
      return -10;
    case 'pre-llm':
      if (item.isPreLlm) return 40;
      return -25;
    case 'wild-west':
      if (item.source === 'chanboards' || item.source === 'wild-west' || item.source === 'deep-boards') return 62;
      if (item.source === 'marginalia' || item.source === 'wiby' || item.source === 'lemmy' || item.source === 'deep-forums') return 30;
      if (item.isPreLlm || item.isIndieWeb) return 18;
      if (item.isBigTechMonoculture) return -30;
      return -12;
    case 'all':
    default:
      if (
        item.relevanceScore >= 55 &&
        (item.source === 'wikipedia' ||
          item.source === 'stackexchange' ||
          item.source === 'web' ||
          item.source === 'github' ||
          item.source === 'hn' ||
          item.source === 'deep-forums' ||
          item.source === 'discourse' ||
          item.source === 'mwmbl')
      ) {
        return 22;
      }
      return 0;
  }
}

const DOCS_PATH = /\/(?:docs?|documentation|manual|reference|man|book|handbook|api)(?:\/|$|\.)/i;
const QA_DOMAINS = /(?:^|\.)(?:stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|askubuntu\.com|mathoverflow\.net)$/;

/**
 * A project's own documentation: the site is named after the query's subject
 * (git → git-scm.com, rust → doc.rust-lang.org, postgres → postgresql.org) and
 * the page lives under a docs-like path.
 */
export function isOfficialDocs(url: string, subjectTokens: string[]): boolean {
  let host = '';
  let pathname = '';
  try {
    ({ hostname: host, pathname } = new URL(url));
  } catch {
    return false;
  }
  const labels = host.toLowerCase().replace(/^www\./, '').split('.').slice(0, -1).join('.');
  const named = subjectTokens.some((t) => t.length >= 3 && labels.split(/[.-]/).some((l) => l === t || l.startsWith(t)));
  return named && (DOCS_PATH.test(pathname) || /^docs?\./.test(host));
}

/** How-to questions: accepted Q&A answers and the project's own docs answer best. */
function computeAnswerBonus(item: ScoredSearchResult, analysis: ReturnType<typeof analyzeQueryIntent>): number {
  if (analysis.intent !== 'technical-howto' || item.relevanceScore < 45) return 0;
  let bonus = 0;
  if (item.source === 'stackexchange' || QA_DOMAINS.test(item.domain)) bonus += 18;
  if (isOfficialDocs(item.url, analysis.anchorTokens)) bonus += 30;
  return bonus;
}

export interface RankOutput {
  surfaced: ScoredSearchResult[];
  p2pResults: ScoredSearchResult[];
  filteredSlop: ScoredSearchResult[];
  sponsoredRemovedCount: number;
  primarySourcesCount: number;
  fediverseCount: number;
  demotedDuplicateDomainsCount: number;
  uniqueDomainsCount: number;
  tldDistribution: Record<string, number>;
  sourceDistribution: Record<string, number>;
  domainDiversityRatio: number;
  avgAuthenticityScore: number;
  avgSlopScore: number;
}

const SPECIALIZED_CONNECTORS = new Set([
  'indie-index',
  'wiby',
  'marginalia',
  'atproto',
  'activitypub',
  'matrix',
  'stoat',
  'archive-deep',
  'arxiv',
  'openalex',
  'lemmy',
  'gdelt-news',
  'chanboards',
  'deep-blogs',
  'deep-boards',
]);

export function diversifyAndRankResults(
  rawItems: RawSearchResult[],
  partialConfig?: Partial<SearchFilterConfig>,
  query?: string
): RankOutput {
  const config: SearchFilterConfig = {
    ...DEFAULT_FILTER_CONFIG,
    ...partialConfig,
  };
  const hasQuery = Boolean(query && query.trim().length > 0);

  const analysis = hasQuery ? analyzeQueryIntent(query!) : undefined;
  const scored: ScoredSearchResult[] = rawItems.map((raw) => {
    const item = scoreSearchResult(raw, config, query);
    const lensBonus = computeLensBonus(item, config.lens);
    const answerBonus = analysis ? computeAnswerBonus(item, analysis) : 0;
    return {
      ...item,
      netScore: item.netScore + lensBonus + answerBonus,
    };
  });

  scored.sort((a, b) => b.netScore - a.netScore);

  const surfaced: ScoredSearchResult[] = [];
  const p2pResults: ScoredSearchResult[] = [];
  const filteredSlop: ScoredSearchResult[] = [];
  const seenIds = new Set<string>();
  const seenTitleFingerprints = new Set<string>();
  const domainCounts = new Map<string, number>();
  let demotedDuplicateDomainsCount = 0;
  let sponsoredRemovedCount = 0;

  const isP2PLens = config.lens === 'p2p-magnet' || config.lens === 'usenet-nzb';

  for (const item of scored) {
    const dedupKey = item.p2p?.infoHash
      ? `btih:${item.p2p.infoHash.toLowerCase()}`
      : item.url.replace(/\/+$/, '').toLowerCase();

    if (seenIds.has(dedupKey)) {
      continue;
    }
    seenIds.add(dedupKey);

    // Check user explicit block
    if (item.signals.some((s) => s.id === 'user-blocked-domain')) {
      filteredSlop.push({
        ...item,
        demotedReason: `Blocked domain (${item.rootDomain})`,
      });
      continue;
    }

    // Check Sponsored / Affiliate Strip
    if (config.stripSponsored && (item.isSponsored || item.verdict === 'sponsored-ad')) {
      sponsoredRemovedCount += 1;
      filteredSlop.push({
        ...item,
        demotedReason: `Sponsored / affiliate funnel stripped (${item.rootDomain})`,
      });
      continue;
    }

    // Check Slop Threshold
    if (item.slopScore > config.slopThreshold || item.verdict === 'slop-farm') {
      filteredSlop.push({
        ...item,
        demotedReason: `SEO/Slop score ${item.slopScore}/100 exceeds threshold (${config.slopThreshold})`,
      });
      continue;
    }

    // Check 18+ / NSFW gate when uncensoredMode is OFF
    if (!config.uncensoredMode && item.isNsfw) {
      filteredSlop.push({
        ...item,
        demotedReason: `18+ / Uncensored content hidden (Enable 18+ Uncensored Mode to view)`,
      });
      continue;
    }

    // Strict Query Relevance Gate: eliminate off-topic / stopword-only bullcrap
    if (hasQuery) {
      const minRequiredRelevance =
        config.lens === 'all' && SPECIALIZED_CONNECTORS.has(item.source)
          ? 66
          : isP2PLens
          ? 28
          : 34;
      if (item.relevanceScore < minRequiredRelevance) {
        filteredSlop.push({
          ...item,
          demotedReason: `Off-topic noise removed (query relevance ${item.relevanceScore}/100 below ${minRequiredRelevance})`,
        });
        continue;
      }
    }

    // Collect verified P2P/NZB results into p2pResults array
    if (item.p2p) {
      p2pResults.push(item);
      if (isP2PLens) {
        if (
          (config.lens === 'p2p-magnet' && item.p2p.protocol === 'bittorrent-dht') ||
          (config.lens === 'usenet-nzb' && item.p2p.protocol === 'usenet-nzb')
        ) {
          surfaced.push(item);
        }
        continue;
      }
      if (hasQuery) {
        continue;
      }
    } else if (isP2PLens) {
      // Non-P2P item while in P2P/Usenet lens
      continue;
    }

    // Check Obscure / Independent Web Only mode
    if (config.obscureWebOnly && item.isBigTechMonoculture) {
      filteredSlop.push({
        ...item,
        demotedReason: `Mega-platform filtered by Independent Web Only mode (${item.rootDomain})`,
      });
      continue;
    }

    // Check Pre-LLM Era strict filter
    if ((config.preLlmOnly || config.lens === 'pre-llm') && item.publishedAt && !item.isPreLlm) {
      filteredSlop.push({
        ...item,
        demotedReason: `Published after Nov 2022 cutoff (${item.publishedAt.slice(0, 10)})`,
      });
      continue;
    }

    // Check Syndicated / Scraper Title Deduplication
    const titleFp = normalizeTitleFingerprint(item.title);
    if (!item.p2p && !item.fediverse && titleFp.split(' ').length >= 4 && seenTitleFingerprints.has(titleFp)) {
      filteredSlop.push({
        ...item,
        demotedReason: 'Near-duplicate / scraped title already surfaced from primary source',
      });
      continue;
    }

    // Check Domain Diversity Cap for web sites
    const currentDomainCount = domainCounts.get(item.rootDomain) ?? 0;
    const effectiveCap = item.p2p
      ? Math.max(config.maxPerDomain, 3)
      : item.rootDomain === 'wikipedia.org'
      ? Math.max(config.maxPerDomain, 2)
      : item.fediverse
      ? config.lens === 'fediverse'
        ? Math.max(config.maxPerDomain, 5)
        : Math.max(config.maxPerDomain, 2)
      : config.maxPerDomain;
    if (effectiveCap > 0 && currentDomainCount >= effectiveCap) {
      demotedDuplicateDomainsCount += 1;
      filteredSlop.push({
        ...item,
        domainOccurrenceRank: currentDomainCount + 1,
        demotedReason: `Domain diversity cap (${effectiveCap} max per site for ${item.rootDomain})`,
      });
      continue;
    }

    domainCounts.set(item.rootDomain, currentDomainCount + 1);
    if (titleFp.split(' ').length >= 4) {
      seenTitleFingerprints.add(titleFp);
    }

    const diversityPenalty = currentDomainCount > 0 ? currentDomainCount * 16 : 0;
    surfaced.push({
      ...item,
      domainOccurrenceRank: currentDomainCount + 1,
      netScore: item.netScore - diversityPenalty,
    });
  }

  // Final sort after diversity adjustments
  surfaced.sort((a, b) => b.netScore - a.netScore);

  // Interleave p2pResults across protocols/indexers so top rows show DHT Magnets, Archive BT, and Usenet NZB together
  const byIndexer = new Map<string, ScoredSearchResult[]>();
  for (const p of p2pResults) {
    const key = p.p2p?.indexerName || p.source;
    const list = byIndexer.get(key) ?? [];
    list.push(p);
    byIndexer.set(key, list);
  }
  const interleavedP2P: ScoredSearchResult[] = [];
  let round = 0;
  let addedInRound = true;
  while (addedInRound) {
    addedInRound = false;
    for (const list of byIndexer.values()) {
      if (round < list.length) {
        interleavedP2P.push(list[round]);
        addedInRound = true;
      }
    }
    round += 1;
  }

  const tldDistribution: Record<string, number> = {};
  const sourceDistribution: Record<string, number> = {};

  for (const r of surfaced) {
    tldDistribution[r.tld] = (tldDistribution[r.tld] ?? 0) + 1;
    sourceDistribution[r.source] = (sourceDistribution[r.source] ?? 0) + 1;
  }

  const uniqueDomainsCount = new Set(surfaced.map((r) => r.rootDomain)).size;
  const domainDiversityRatio =
    surfaced.length > 0 ? Number((uniqueDomainsCount / surfaced.length).toFixed(2)) : 1;

  const primarySourcesCount = surfaced.filter(
    (r) => r.isPrimarySource || r.verdict === 'primary-source'
  ).length;

  const fediverseCount = surfaced.filter(
    (r) => Boolean(r.fediverse) || r.verdict === 'fediverse-node' || r.source === 'lemmy'
  ).length;

  const avgAuthenticityScore =
    surfaced.length > 0
      ? Math.round(surfaced.reduce((acc, r) => acc + r.authenticityScore, 0) / surfaced.length)
      : 0;

  const avgSlopScore =
    surfaced.length > 0
      ? Math.round(surfaced.reduce((acc, r) => acc + r.slopScore, 0) / surfaced.length)
      : 0;

  return {
    surfaced,
    p2pResults: interleavedP2P,
    filteredSlop,
    sponsoredRemovedCount,
    primarySourcesCount,
    fediverseCount,
    demotedDuplicateDomainsCount,
    uniqueDomainsCount,
    tldDistribution,
    sourceDistribution,
    domainDiversityRatio,
    avgAuthenticityScore,
    avgSlopScore,
  };
}
