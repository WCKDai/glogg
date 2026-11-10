import {
  AFFILIATE_MARKERS,
  AI_SLOP_PHRASES,
  DEFAULT_BOOSTED_DOMAINS,
  DEFAULT_SLOP_DOMAINS,
  FORUM_HUMAN_DOMAINS,
  INDIE_HOST_PATTERNS,
  MONOCULTURE_MEGA_DOMAINS,
  PRIMARY_SOURCE_DOMAINS,
  SEO_LISTICLE_PATTERNS,
  TRACKING_QUERY_PARAMS,
} from './curatedLists.js';
import { computeQueryRelevance } from './queryIntelligence.js';
import { normalizeQuotes } from './text.js';
import {
  RawSearchResult,
  ScoredSearchResult,
  SearchFilterConfig,
  SignalHit,
  SlopVerdict,
} from './types.js';

const PRE_LLM_CUTOFF_TIMESTAMP = Date.parse('2022-11-30T00:00:00Z');

const SPONSORED_PATTERNS: { pattern: RegExp; label: string; weight: number }[] = [
  {
    pattern:
      /\b(?:sponsored\s+(?:post|content|by)|paid\s+partnership|partner\s+content|presented\s+by|promoted\s+story|advertorial)\b/i,
    label: 'Sponsored / Native Ad Content',
    weight: 60,
  },
  {
    pattern: /(?:googleadservices\.com|doubleclick\.net|bing\.com\/aclick|duckduckgo\.com\/y\.js)/i,
    label: 'Ad-Network Redirect URL',
    weight: 85,
  },
  {
    pattern:
      /\b(?:we may earn a commission|affiliate disclosure|our top picks for 202[4-9]|best budget pick|best overall pick)\b/i,
    label: 'Affiliate Commerce / Review Mill',
    weight: 42,
  },
  {
    pattern: /\b(?:buy now on amazon|check price on|view at walmart|save \d+% with code)\b/i,
    label: 'Commercial Purchase Funnel',
    weight: 48,
  },
];

export function extractDomainInfo(rawUrl: string): {
  domain: string;
  rootDomain: string;
  tld: string;
  pathname: string;
  search: string;
} {
  try {
    if (rawUrl.startsWith('magnet:')) {
      return {
        domain: 'dht.bittorrent',
        rootDomain: 'dht.bittorrent',
        tld: 'dht',
        pathname: '',
        search: '',
      };
    }
    const parsed = new URL(rawUrl);
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const parts = domain.split('.');
    const tld = parts.length >= 2 ? `.${parts[parts.length - 1]}` : '.web';
    let rootDomain = domain;
    if (parts.length > 2) {
      const lastTwo = parts.slice(-2).join('.');
      const preserveSubdomainHosts = [
        'github.io',
        'gitlab.io',
        'codeberg.page',
        'bearblog.dev',
        'neocities.org',
        'pages.dev',
        'netlify.app',
        'vercel.app',
        'stackexchange.com',
        'substack.com',
        'dreamwidth.org',
        'tilde.club',
        'tilde.town',
      ];
      if (preserveSubdomainHosts.includes(lastTwo)) {
        rootDomain = parts.slice(-3).join('.');
      } else if (
        ['co.uk', 'ac.uk', 'org.uk', 'gov.uk', 'edu.au', 'com.au'].includes(lastTwo) &&
        parts.length >= 3
      ) {
        rootDomain = parts.slice(-3).join('.');
      } else {
        rootDomain = lastTwo;
      }
    }
    return {
      domain,
      rootDomain,
      tld,
      pathname: parsed.pathname,
      search: parsed.search,
    };
  } catch {
    return {
      domain: 'unknown',
      rootDomain: 'unknown',
      tld: '.web',
      pathname: '',
      search: '',
    };
  }
}

/** Each list's entries, normalised once (a request's lists and the curated ones are reused for every result). */
const normalisedLists = new WeakMap<string[], Set<string>>();

function domainSet(list: string[]): Set<string> {
  let set = normalisedLists.get(list);
  if (!set) {
    set = new Set(list.map((e) => e.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean));
    normalisedLists.set(list, set);
  }
  return set;
}

/** True when `domain` is on the list or under a listed domain: a lookup per label, not a scan of the list. */
function matchesDomainList(domain: string, rootDomain: string, list: string[]): boolean {
  if (list.length === 0) return false;
  const set = domainSet(list);
  if (set.has(rootDomain)) return true;
  for (let d = domain; d; d = d.slice(d.indexOf('.') + 1 || d.length)) {
    if (set.has(d)) return true;
  }
  return false;
}

export function isPreLlmDate(publishedAt?: string): boolean {
  if (!publishedAt) return false;
  const trimmed = publishedAt.trim();
  if (/^(19\d\d|200\d|201\d|202[01])$/.test(trimmed)) {
    return true;
  }
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return ts < PRE_LLM_CUTOFF_TIMESTAMP;
  }
  return false;
}

export function stripTrackingFromUrl(rawUrl: string): { cleanUrl: string; strippedParams: string[] } {
  if (rawUrl.startsWith('magnet:')) {
    return { cleanUrl: rawUrl, strippedParams: [] };
  }
  try {
    const parsed = new URL(rawUrl);
    const strippedParams: string[] = [];
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (TRACKING_QUERY_PARAMS.includes(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        strippedParams.push(key);
        parsed.searchParams.delete(key);
      }
    }
    return { cleanUrl: parsed.toString(), strippedParams };
  } catch {
    return { cleanUrl: rawUrl, strippedParams: [] };
  }
}

export function scoreSearchResult(
  raw: RawSearchResult,
  config?: Partial<SearchFilterConfig>,
  query?: string
): ScoredSearchResult {
  const { domain, rootDomain, tld, pathname, search } = extractDomainInfo(raw.url);
  const combinedText = normalizeQuotes(`${raw.title} ${raw.snippet}`);
  const signals: SignalHit[] = [];

  let slopPoints = 10;
  let humanPoints = 38;
  let isSponsored = false;

  const userBlocked = config?.blockedDomains ?? [];
  const userBoosted = config?.boostedDomains ?? [];
  const userLowered = config?.loweredDomains ?? [];
  const userPinned = config?.pinnedDomains ?? [];
  const userBlockedPhrases = config?.blockedPhrases ?? [];

  // 0. P2P / DHT / Bitmagnet / Usenet NZB scoring
  if (raw.p2p) {
    if (raw.p2p.healthVerdict === 'suspect-spam') {
      slopPoints += 75;
      humanPoints -= 30;
      signals.push({
        id: 'p2p-suspect-spam',
        label: 'Suspect P2P / Malware Pattern',
        delta: -75,
        category: 'p2p',
      });
    } else if (
      raw.p2p.healthVerdict === 'verified-swarm' ||
      raw.p2p.healthVerdict === 'archival-seedbox'
    ) {
      humanPoints += 42;
      slopPoints = Math.max(0, slopPoints - 10);
      signals.push({
        id: 'p2p-verified-swarm',
        label:
          raw.p2p.protocol === 'bittorrent-dht'
            ? `Verified DHT Swarm (${raw.p2p.seeders ?? 'Archival'} seeds)`
            : `Complete Usenet Release (${raw.p2p.newsgroup || 'NZB'})`,
        delta: 42,
        category: 'p2p',
      });
    } else if (raw.p2p.healthVerdict === 'active') {
      humanPoints += 26;
      signals.push({
        id: 'p2p-active',
        label: `Active ${raw.p2p.indexerName}`,
        delta: 26,
        category: 'p2p',
      });
    }
  }

  // 0b. Fediverse (ATProtocol, ActivityPub, Matrix, Stoat) scoring
  if (raw.fediverse) {
    humanPoints += 36;
    slopPoints = Math.max(0, slopPoints - 12);
    const protoLabels: Record<string, string> = {
      atproto: 'ATProtocol / Bluesky',
      activitypub: 'ActivityPub / Mastodon / Lemmy',
      matrix: 'Matrix Federated Room',
      stoat: 'Stoat / Revolt Federated Chat',
    };
    signals.push({
      id: `fediverse-${raw.fediverse.protocol}`,
      label: `${protoLabels[raw.fediverse.protocol] || 'Fediverse'} (${raw.fediverse.instanceDomain})`,
      delta: 36,
      category: 'fediverse',
    });
  }

  // 0c. Deep Archives & Raw Unfiltered News (GDELT, Cryptome, FOIA, DDoSecrets)
  if (
    raw.source === 'gdelt-news' ||
    raw.source === 'archive-deep' ||
    matchesDomainList(domain, rootDomain, [
      'cryptome.org',
      'ddosecrets.com',
      'theblackvault.com',
      'courtlistener.com',
      'wikileaks.org',
      'muckrock.com',
      'bellingcat.com',
      'propublica.org',
    ])
  ) {
    humanPoints += 32;
    slopPoints = Math.max(0, slopPoints - 10);
    signals.push({
      id: 'deep-archive-osint',
      label:
        raw.source === 'gdelt-news'
          ? 'GDELT Raw World News Wire'
          : 'Deep Archive / FOIA / OSINT Primary Record',
      delta: 32,
      category: 'primary',
    });
  }

  // 1. User explicit rules
  if (matchesDomainList(domain, rootDomain, userBlocked)) {
    slopPoints += 75;
    humanPoints -= 30;
    signals.push({
      id: 'user-blocked-domain',
      label: `Blocked domain (${rootDomain})`,
      delta: -75,
      category: 'user-rule',
    });
  }

  if (matchesDomainList(domain, rootDomain, userPinned)) {
    humanPoints += 60;
    slopPoints = Math.max(0, slopPoints - 20);
    signals.push({ id: 'user-pinned-domain', label: `Pinned (${rootDomain})`, delta: 60, category: 'user-rule' });
  } else if (matchesDomainList(domain, rootDomain, userBoosted)) {
    humanPoints += 40;
    slopPoints = Math.max(0, slopPoints - 20);
    signals.push({
      id: 'user-boosted-domain',
      label: `Raised (${rootDomain})`,
      delta: 40,
      category: 'user-rule',
    });
  } else if (matchesDomainList(domain, rootDomain, userLowered)) {
    humanPoints -= 30;
    signals.push({ id: 'user-lowered-domain', label: `Lowered (${rootDomain})`, delta: -30, category: 'user-rule' });
  }

  for (const phrase of userBlockedPhrases) {
    const cleanPhrase = phrase.trim();
    if (cleanPhrase && combinedText.toLowerCase().includes(cleanPhrase.toLowerCase())) {
      slopPoints += 45;
      signals.push({
        id: `user-phrase-${cleanPhrase}`,
        label: `Blocked phrase "${cleanPhrase}"`,
        delta: -45,
        category: 'user-rule',
      });
    }
  }

  // 2. Sponsored Content / Native Ad / Affiliate Funnel Detection
  for (const sp of SPONSORED_PATTERNS) {
    if (sp.pattern.test(combinedText) || sp.pattern.test(raw.url)) {
      isSponsored = true;
      slopPoints += sp.weight;
      humanPoints -= 25;
      signals.push({
        id: `sponsored-${sp.label}`,
        label: sp.label,
        delta: -sp.weight,
        category: 'sponsored',
      });
    }
  }

  if (AFFILIATE_MARKERS.some((rx) => rx.test(raw.url))) {
    isSponsored = true;
    slopPoints += 30;
    signals.push({
      id: 'affiliate-url-marker',
      label: 'Affiliate Tracking URL',
      delta: -30,
      category: 'sponsored',
    });
  }

  // 3. Known Slop / Content Farm domains
  if (matchesDomainList(domain, rootDomain, DEFAULT_SLOP_DOMAINS)) {
    slopPoints += 52;
    humanPoints -= 20;
    signals.push({
      id: 'known-slop-domain',
      label: 'SEO Content Mill Domain',
      delta: -52,
      category: 'seo-slop',
      detail: `${rootDomain} is indexed in Glogg's SEO content farm registry`,
    });
  }

  // 4. Monoculture mega-domains check
  const isBigTechMonoculture = matchesDomainList(domain, rootDomain, MONOCULTURE_MEGA_DOMAINS);
  if (isBigTechMonoculture) {
    slopPoints += 12;
    signals.push({
      id: 'mega-monoculture',
      label: 'Mega-Platform Monoculture',
      delta: -12,
      category: 'monoculture',
      detail: 'Top-50 commercial platform',
    });
  }

  // 5. IndieWeb / Small Web / Personal Domain detection
  let isIndieWeb = false;
  if (matchesDomainList(domain, rootDomain, DEFAULT_BOOSTED_DOMAINS)) {
    isIndieWeb = true;
    humanPoints += 34;
    slopPoints = Math.max(0, slopPoints - 14);
    signals.push({
      id: 'curated-indie-gem',
      label: 'Verified Indie / High-Signal Site',
      delta: 34,
      category: 'indie',
    });
  }

  if (INDIE_HOST_PATTERNS.some((rx) => rx.test(domain)) || /\/~[a-z0-9_-]+/i.test(pathname)) {
    isIndieWeb = true;
    humanPoints += 28;
    slopPoints = Math.max(0, slopPoints - 12);
    signals.push({
      id: 'indie-host-tilde',
      label: 'Small-Web / Indie Host',
      delta: 28,
      category: 'indie',
    });
  }

  if (
    raw.source === 'indie-index' ||
    raw.source === 'marginalia' ||
    raw.source === 'wiby' ||
    raw.source === 'deep-blogs'
  ) {
    isIndieWeb = true;
    humanPoints += 24;
    signals.push({
      id: 'small-web-index',
      label: `${raw.source === 'marginalia' ? 'Marginalia' : raw.source === 'wiby' ? 'Wiby Classic Web' : raw.source === 'deep-blogs' ? 'Small-Web Blog' : 'Small-Web'} Discovery`,
      delta: 24,
      category: 'indie',
    });
  }

  // 6. Primary Source / Academic / Archival / Source-of-Truth check
  const isPrimarySource =
    matchesDomainList(domain, rootDomain, PRIMARY_SOURCE_DOMAINS) ||
    /\.(edu|ac\.uk|gov|mil)$/i.test(domain) ||
    raw.source === 'arxiv' ||
    raw.source === 'openalex' ||
    raw.source === 'wikipedia' ||
    raw.source === 'github' ||
    raw.source === 'codeberg' ||
    raw.source === 'archive' ||
    raw.source === 'archive-bt' ||
    raw.source === 'archive-deep' ||
    raw.source === 'academic-torrents' ||
    /\/(rfc\d+|papers?|spec|standard|man\d|whitepaper|commits?|pull\/\d+|issues\/\d+)/i.test(pathname);

  if (isPrimarySource) {
    humanPoints += 32;
    slopPoints = Math.max(0, slopPoints - 16);
    signals.push({
      id: 'primary-reference',
      label: 'Primary Source / Spec / Archive',
      delta: 32,
      category: 'primary',
    });
  }

  // 7. Real Human Forum / Community Discussion check
  const isForumHuman =
    matchesDomainList(domain, rootDomain, FORUM_HUMAN_DOMAINS) ||
    raw.source === 'hn' ||
    raw.source === 'lobsters' ||
    raw.source === 'lemmy' ||
    raw.source === 'stackexchange' ||
    raw.source === 'deep-forums' ||
    raw.source === 'discourse';

  if (isForumHuman) {
    humanPoints += 22;
    slopPoints = Math.max(0, slopPoints - 8);
    signals.push({
      id: 'human-community-thread',
      label: 'Practitioner / Fediverse Discussion',
      delta: 22,
      category: 'density',
    });
  }

  // 8. SEO Listicle & Clickbait Title / Snippet Patterns
  for (const rule of SEO_LISTICLE_PATTERNS) {
    if (rule.pattern.test(raw.title) || rule.pattern.test(raw.snippet)) {
      slopPoints += rule.weight;
      humanPoints -= Math.round(rule.weight * 0.5);
      if (rule.label.toLowerCase().includes('affiliate')) {
        isSponsored = true;
      }
      signals.push({
        id: `seo-${rule.label}`,
        label: rule.label,
        delta: -rule.weight,
        category: 'seo-slop',
      });
    }
  }

  // 9. AI-Generated Slop Cliché Phrases
  for (const rule of AI_SLOP_PHRASES) {
    if (rule.pattern.test(combinedText)) {
      slopPoints += rule.weight;
      humanPoints -= Math.round(rule.weight * 0.6);
      signals.push({
        id: `ai-${rule.label}`,
        label: `AI Cliché: ${rule.label}`,
        delta: -rule.weight,
        category: 'ai-fluff',
      });
    }
  }

  // 10. URL Slug & Query Hygiene
  const slugHyphens = (pathname.match(/-/g) || []).length;
  if (slugHyphens >= 11 && /\b(best|top|guide|review|ultimate|how-to)\b/i.test(pathname)) {
    slopPoints += 18;
    signals.push({
      id: 'keyword-stuffed-slug',
      label: 'Keyword-Stuffed SEO Slug',
      delta: -18,
      category: 'seo-slop',
    });
  }

  if (search && TRACKING_QUERY_PARAMS.some((p) => search.toLowerCase().includes(`${p}=`))) {
    slopPoints += 10;
    signals.push({
      id: 'ad-tracking-params',
      label: 'Ad / Attribution Tracking Params',
      delta: -10,
      category: 'seo-slop',
    });
  }

  // 11. Information Density & Clean Path Signals
  if (
    /\b(rfc\s*\d+|cve-\d{4}-\d+|arxiv:\d+|\b0x[0-9a-f]{4,}|benchmark|postmortem|specification|disassembly|syscall|dataset|doi:|btih:)\b/i.test(
      combinedText
    )
  ) {
    humanPoints += 18;
    signals.push({
      id: 'high-technical-density',
      label: 'High Primary / Empirical Density',
      delta: 18,
      category: 'density',
    });
  }

  if (
    /^\/(posts|notes|essays|articles|archive|writing|log|wiki|doc|man)\//i.test(pathname) &&
    !isBigTechMonoculture
  ) {
    humanPoints += 10;
    signals.push({
      id: 'clean-writing-path',
      label: 'Clean Indie Essay/Doc Path',
      delta: 10,
      category: 'indie',
    });
  }

  // 12. Pre-LLM Era Check (< Nov 2022)
  const isPreLlm = isPreLlmDate(raw.publishedAt);
  if (isPreLlm) {
    humanPoints += 14;
    slopPoints = Math.max(0, slopPoints - 10);
    signals.push({
      id: 'pre-llm-era',
      label: 'Pre-LLM Era (< Nov 2022)',
      delta: 14,
      category: 'primary',
    });
  }

  // 13. Query Relevance Evaluation (when query is provided)
  const relevanceEval = computeQueryRelevance(
    query || '',
    raw.title,
    raw.snippet,
    raw.url,
    raw.tags
  );
  const relevanceScore = relevanceEval.relevanceScore;

  if (query && query.trim() && relevanceEval.isDirectAnswerCandidate) {
    signals.push({
      id: 'direct-query-match',
      label: 'Direct Query / Answer Match',
      delta: 24,
      category: 'primary',
    });
  }

  const slopScore = Math.max(0, Math.min(100, Math.round(slopPoints)));
  const authenticityScore = Math.max(0, Math.min(100, Math.round(humanPoints)));
  const netScore =
    query && query.trim()
      ? Math.round(relevanceScore * 1.45 + authenticityScore * 0.52 - slopScore * 1.15)
      : Math.round(authenticityScore * 1.15 - slopScore * 1.1);

  let verdict: SlopVerdict = 'neutral';
  if (isSponsored && slopScore >= 40) {
    verdict = 'sponsored-ad';
  } else if (slopScore >= 60) {
    verdict = 'slop-farm';
  } else if (slopScore >= 40 && authenticityScore < 55) {
    verdict = 'seo-suspect';
  } else if (raw.p2p && slopScore < 35) {
    verdict = 'verified-p2p';
  } else if (raw.fediverse && slopScore < 35) {
    verdict = 'fediverse-node';
  } else if (isPrimarySource && slopScore < 32) {
    verdict = 'primary-source';
  } else if (isIndieWeb && authenticityScore >= 60 && slopScore < 35) {
    verdict = 'indie-gem';
  } else if (authenticityScore >= 55 && slopScore < 35) {
    verdict = 'human-signal';
  }

  const { cleanUrl } = stripTrackingFromUrl(raw.url);

  return {
    ...raw,
    id: raw.id || `${raw.source}-${cleanUrl}`,
    url: cleanUrl,
    domain,
    rootDomain,
    tld,
    slopScore,
    authenticityScore,
    relevanceScore,
    netScore,
    verdict,
    signals,
    isPreLlm,
    isIndieWeb,
    isPrimarySource,
    isSponsored,
    isBigTechMonoculture,
    isNsfw: Boolean(raw.isNsfw),
  };
}
