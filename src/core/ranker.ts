import { analyzeQueryIntent } from './queryIntelligence.js';
import { scoreSearchResult } from './slopScorer.js';
import {
  RawSearchResult,
  ScoredSearchResult,
  SearchFilterConfig,
  SearchLensId,
  SearchFreshnessIntent,
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

function hasNavigableResultUrl(item: RawSearchResult): boolean {
  try {
    const url = new URL(item.url);
    if (url.protocol === 'http:' || url.protocol === 'https:') return Boolean(url.hostname);
    return url.protocol === 'magnet:' && item.p2p?.protocol === 'bittorrent-dht' &&
      !url.host && !url.pathname && Boolean(url.searchParams.get('xt'));
  } catch {
    return false;
  }
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
        item.source === 'openlibrary' ||
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
        item.source === 'crossref' ||
        item.source === 'europepmc' ||
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
  query?: string,
  freshness?: { intent: SearchFreshnessIntent; now: number }
): RankOutput {
  const config: SearchFilterConfig = {
    ...DEFAULT_FILTER_CONFIG,
    ...partialConfig,
  };
  const hasQuery = Boolean(query && query.trim().length > 0);

  const analysis = hasQuery ? analyzeQueryIntent(query!) : undefined;
  const onlySites = config.onlySites ?? [];
  const excludeSites = config.excludeSites ?? [];
  const excludeWords = config.excludeWords ?? [];
  const phrases = (config.phrases ?? []).map((p) => p.toLowerCase());
  const textOf = (r: RawSearchResult) => `${r.title} ${r.snippet}`.toLowerCase();
  const onSite = (r: ScoredSearchResult, sites: string[]) => sites.some((s) => r.domain === s || r.domain.endsWith(`.${s}`) || r.rootDomain === s);
  // Both visible and hidden results contain clickable links; omit unusable schemes before scoring.
  const scored: ScoredSearchResult[] = rawItems.filter(hasNavigableResultUrl).map((raw) => {
    const item = scoreSearchResult(raw, config, query);
    const lensBonus = computeLensBonus(item, config.lens);
    const answerBonus = analysis ? computeAnswerBonus(item, analysis) : 0;
    // "Exact phrases" you quoted: results that contain them all come first.
    const phraseBonus = phrases.length > 0 && phrases.every((p) => textOf(item).includes(p)) ? 25 : 0;
    const age = freshness && item.publishedAt ? freshness.now - Date.parse(item.publishedAt) : NaN;
    const window = freshness?.intent === 'news' ? 86_400_000 : 30 * 86_400_000;
    // Never let an invalid/future timestamp buy rank. Relevance and all existing filters still apply.
    const recencyBonus = age >= 0 && age < window ? 24 * (1 - age / window) : 0;
    return {
      ...item,
      netScore: item.netScore + lensBonus + answerBonus + phraseBonus + recencyBonus,
    };
  });

  scored.sort((a, b) => b.netScore - a.netScore);

  const surfaced: ScoredSearchResult[] = [];
  const eligible: ScoredSearchResult[] = [];
  const p2pResults: ScoredSearchResult[] = [];
  const filteredSlop: ScoredSearchResult[] = [];
  const seenIds = new Set<string>();
  const seenTitleFingerprints = new Set<string>();
  const domainCounts = new Map<string, number>();
  let demotedDuplicateDomainsCount = 0;
  let sponsoredRemovedCount = 0;

  const isP2PLens = config.lens === 'p2p-magnet' || config.lens === 'usenet-nzb';
  const mediaKind = config.lens === 'images' ? 'image' : config.lens === 'videos' ? 'video' : undefined;

  for (const item of scored) {
    if (mediaKind && item.media?.kind !== mediaKind) continue;
    const dedupKey = mediaKind && item.media
      ? `media:${item.media.url}`
      : item.p2p?.infoHash
      ? `btih:${item.p2p.infoHash.toLowerCase()}`
      // scoreSearchResult already canonicalizes the host; paths and queries can be case-sensitive.
      : item.url.replace(/\/+$/, '');

    if (seenIds.has(dedupKey)) {
      continue;
    }
    seenIds.add(dedupKey);

    // The query's own operators come first: site:, -site: and -word.
    if (onlySites.length > 0 && !onSite(item, onlySites)) {
      filteredSlop.push({ ...item, demotedReason: `Not on ${onlySites.join(' or ')}` });
      continue;
    }
    if (excludeSites.length > 0 && onSite(item, excludeSites)) {
      filteredSlop.push({ ...item, demotedReason: `On ${item.rootDomain}, which your search leaves out` });
      continue;
    }
    const excludedWord = excludeWords.find((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(textOf(item)));
    if (excludedWord) {
      filteredSlop.push({ ...item, demotedReason: `Mentions “${excludedWord}”, which your search leaves out` });
      continue;
    }

    // Check user explicit block
    if (item.signals.some((s) => s.id === 'user-blocked-domain')) {
      filteredSlop.push({
        ...item,
        demotedReason: `You hid ${item.rootDomain}`,
      });
      continue;
    }
    // A phrase you hid hides the result, however good it looks otherwise.
    const phrase = item.signals.find((s) => s.id.startsWith('user-phrase-'));
    if (phrase) {
      filteredSlop.push({ ...item, demotedReason: `Mentions “${phrase.id.slice('user-phrase-'.length)}”` });
      continue;
    }

    // Check Sponsored / Affiliate Strip
    if (config.stripSponsored && (item.isSponsored || item.verdict === 'sponsored-ad')) {
      sponsoredRemovedCount += 1;
      filteredSlop.push({
        ...item,
        demotedReason: 'Sponsored or affiliate',
      });
      continue;
    }

    // Check Slop Threshold
    if (item.slopScore > config.slopThreshold || item.verdict === 'slop-farm') {
      filteredSlop.push({
        ...item,
        demotedReason: `Reads like an SEO or AI content farm (junk score ${item.slopScore})`,
      });
      continue;
    }

    // Check 18+ / NSFW gate when uncensoredMode is OFF
    if (!config.uncensoredMode && item.isNsfw) {
      filteredSlop.push({
        ...item,
        demotedReason: '18+ (turn on 18+ mode in Settings to see it)',
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
          demotedReason: "Doesn't seem to be about your search",
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
        demotedReason: `A big platform (${item.rootDomain}); you chose independent sites only`,
      });
      continue;
    }

    // Check Pre-LLM Era strict filter
    if (mediaKind && config.preLlmOnly && (!item.publishedAt || !Number.isFinite(Date.parse(item.publishedAt)) || item.dateKind === 'indexed')) {
      filteredSlop.push({ ...item, demotedReason: 'Creation date is unknown; cannot confirm this file predates Nov 2022' });
      continue;
    }
    if ((config.preLlmOnly || config.lens === 'pre-llm') && item.publishedAt && !item.isPreLlm) {
      filteredSlop.push({
        ...item,
        demotedReason: `Published after Nov 2022 (${item.publishedAt.slice(0, 10)})`,
      });
      continue;
    }

    eligible.push(item);
  }

  let candidates = eligible;
  if (freshness && !mediaKind) {
    const groups = new Map<string, ScoredSearchResult[]>();
    const recent = new Set<ScoredSearchResult>();
    const window = freshness.intent === 'news' ? 86_400_000 : 30 * 86_400_000;
    for (const item of eligible) {
      if (item.p2p || item.fediverse) continue;
      const fingerprint = normalizeTitleFingerprint(item.title);
      if (fingerprint.split(' ').length < 4) continue;
      const copies = groups.get(fingerprint) ?? [];
      copies.push(item);
      groups.set(fingerprint, copies);
      const age = item.publishedAt ? freshness.now - Date.parse(item.publishedAt) : NaN;
      // Discovery time cannot prove that a copy is current reporting.
      if (item.dateKind !== 'indexed' && age >= 0 && age < window) recent.add(item);
    }

    const preferredCopies = new Map<ScoredSearchResult, ScoredSearchResult[]>();
    for (const copies of groups.values()) {
      if (!copies.some((item) => recent.has(item)) || copies.every((item) => recent.has(item))) continue;
      copies.sort((a, b) => Number(recent.has(b)) - Number(recent.has(a)) || b.netScore - a.netScore);
      for (const item of copies) preferredCopies.set(item, copies);
    }
    // Try current eligible reporting first within a duplicate group, without changing its score.
    // Keep fallbacks together: if the current copy hits a domain cap, an older copy can still fit.
    const visited = new Set<ScoredSearchResult[]>();
    candidates = [];
    for (const item of eligible) {
      const copies = preferredCopies.get(item);
      if (!copies) candidates.push(item);
      else if (!visited.has(copies)) {
        candidates.push(...copies);
        visited.add(copies);
      }
    }
  }

  for (const item of candidates) {
    // Check Syndicated / Scraper Title Deduplication
    const titleFp = normalizeTitleFingerprint(item.title);
    if (!mediaKind && !item.p2p && !item.fediverse && titleFp.split(' ').length >= 4 && seenTitleFingerprints.has(titleFp)) {
      filteredSlop.push({
        ...item,
        demotedReason: 'A copy of a result shown above',
      });
      continue;
    }

    // Check Domain Diversity Cap for web sites
    const currentDomainCount = domainCounts.get(item.rootDomain) ?? 0;
    // A media scope diversifies by asset; a site: search wants that site's pages.
    const effectiveCap = mediaKind || onlySites.length > 0
      ? 0
      : item.p2p
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
        demotedReason: `More from ${item.rootDomain} (${effectiveCap} per site)`,
      });
      continue;
    }

    domainCounts.set(item.rootDomain, currentDomainCount + 1);
    if (titleFp.split(' ').length >= 4) {
      seenTitleFingerprints.add(titleFp);
    }

    const diversityPenalty = !mediaKind && currentDomainCount > 0 ? currentDomainCount * 16 : 0;
    surfaced.push({
      ...item,
      domainOccurrenceRank: currentDomainCount + 1,
      netScore: item.netScore - diversityPenalty,
    });
  }

  // Final sort after diversity adjustments; domains you pinned go first.
  const pinned = (r: ScoredSearchResult) => (r.signals.some((s) => s.id === 'user-pinned-domain') ? 1 : 0);
  surfaced.sort((a, b) => pinned(b) - pinned(a) || b.netScore - a.netScore);
  filteredSlop.sort((a, b) => b.netScore - a.netScore);

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
