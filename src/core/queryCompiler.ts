import { DEFAULT_SLOP_DOMAINS } from './curatedLists.js';
import { wellFormed } from './text.js';
import { CompiledQueryPlan, SearchFilterConfig, SearchLensId } from './types.js';

const CORE_NEGATIVE_DOMAINS = [
  'pinterest.com',
  'quora.com',
  'forbes.com',
  'medium.com',
  'geeksforgeeks.org',
  'w3schools.com',
  'buzzfeed.com',
  'screenrant.com',
  'businessinsider.com',
  'hubspot.com',
];

export function compileSearchQuery(
  rawQuery: string,
  config?: Partial<SearchFilterConfig>
): CompiledQueryPlan {
  const trimmed = wellFormed(rawQuery).trim();
  const lens: SearchLensId = config?.lens ?? 'all';
  const preLlm = Boolean(config?.preLlmOnly || lens === 'pre-llm');

  const cleanedTokens = trimmed
    .replace(/[^\w\s+"'.:/-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const userBlocked = (config?.blockedDomains ?? []).slice(0, 8);
  const combinedNegativeDomains = Array.from(
    new Set([...userBlocked, ...CORE_NEGATIVE_DOMAINS])
  ).slice(0, 10);

  const negativeSiteOperators = combinedNegativeDomains.map((d) => `-site:${d}`);
  const positiveOperators: string[] = [];

  switch (lens) {
    case 'p2p-magnet':
      positiveOperators.push('("magnet:?xt=urn:btih" OR torrent OR infohash)');
      break;
    case 'usenet-nzb':
      positiveOperators.push('(nzb OR "alt.binaries" OR usenet)');
      break;
    case 'fediverse':
      positiveOperators.push(
        '(site:bsky.app OR site:mastodon.social OR site:fosstodon.org OR site:matrix.to OR site:stoat.chat OR site:lemmy.world)'
      );
      break;
    case 'deep-archives':
      positiveOperators.push(
        '(site:archive.org OR site:cryptome.org OR site:theblackvault.com OR site:courtlistener.com OR site:ddosecrets.com OR filetype:pdf)'
      );
      break;
    case 'raw-news':
      positiveOperators.push(
        '(site:reuters.com OR site:apnews.com OR site:bellingcat.com OR site:propublica.org OR site:gdeltproject.org)'
      );
      break;
    case 'small-web':
      positiveOperators.push('(inurl:blog OR inurl:posts OR inurl:notes OR inurl:essays)');
      negativeSiteOperators.push('-site:reddit.com', '-site:youtube.com', '-site:amazon.com');
      break;
    case 'forums':
      positiveOperators.push(
        '(site:news.ycombinator.com OR site:lobste.rs OR site:stackexchange.com OR site:stackoverflow.com OR inurl:forum)'
      );
      break;
    case 'primary':
      positiveOperators.push(
        '(site:arxiv.org OR site:*.edu OR site:ietf.org OR site:kernel.org OR site:wiki.archlinux.org OR filetype:pdf)'
      );
      break;
    case 'wild-west':
      positiveOperators.push(
        '(inurl:forum OR inurl:viewtopic OR inurl:thread OR inurl:board OR site:textfiles.com OR site:neocities.org)'
      );
      negativeSiteOperators.push('-site:reddit.com', '-site:youtube.com', '-site:facebook.com');
      break;
    case 'pre-llm':
    case 'all':
    default:
      break;
  }

  const dateConstraint = preLlm ? 'before:2022-11-30' : undefined;

  const queryParts = [
    trimmed,
    ...positiveOperators,
    ...(dateConstraint ? [dateConstraint] : []),
    ...negativeSiteOperators.slice(0, 8),
  ].filter(Boolean);

  const synthesizedQuery = queryParts.join(' ');
  const encodedSynthesized = encodeURIComponent(synthesizedQuery);
  const encodedRaw = encodeURIComponent(trimmed);

  // SafeSearch off only in 18+ mode, as in glogg's own search; the extension and plain links keep the engines' defaults.
  const safeOff = Boolean(config?.uncensoredMode);
  const escapeUrls: CompiledQueryPlan['escapeUrls'] = [
    {
      id: 'marginalia',
      name: 'Marginalia',
      category: 'web-meta',
      description: 'Independent non-commercial small-web index (text-first, zero ad-tech)',
      url: `https://search.marginalia.nu/search?query=${encodedRaw}`,
    },
    {
      id: 'ddg-uncensored',
      name: 'DuckDuckGo',
      category: 'web-meta',
      description: safeOff ? 'Direct HTML search with SafeSearch off (18+ mode) + anti-slop operators' : 'Direct HTML search + anti-slop operators',
      url: `https://html.duckduckgo.com/html/?q=${encodedSynthesized}${safeOff ? '&kp=-2' : ''}`,
    },
    {
      id: 'google-udm14',
      name: 'Google',
      category: 'web-meta',
      description: 'Forces pure Web mode (no AI Overview) + Glogg -site: exclusions',
      url: `https://www.google.com/search?udm=14&q=${encodedSynthesized}${safeOff ? '&safe=off' : ''}`,
    },
    {
      id: 'bsky-atproto',
      name: 'Bluesky',
      category: 'fediverse',
      description: 'Decentralized ATProtocol firehose & DID actor search',
      url: `https://bsky.app/search?q=${encodedRaw}`,
    },
    {
      id: 'matrix-rooms',
      name: 'Matrix rooms',
      category: 'fediverse',
      description: 'Decentralized E2EE Matrix homeserver room & space index',
      url: `https://matrixrooms.info/?s=${encodedRaw}`,
    },
    {
      id: 'stoat-chat',
      name: 'Stoat',
      category: 'fediverse',
      description: 'Open-source Stoat / Revolt community servers & rooms',
      url: `https://stoat.chat/discover/servers?search=${encodedRaw}`,
    },
    {
      id: 'btdigg-dht',
      name: 'BTDigg',
      category: 'p2p-dht',
      description: 'Direct BitTorrent DHT network infohash & magnet crawler (uncensored)',
      url: `https://btdig.com/search?q=${encodedRaw}`,
    },
    {
      id: 'academic-torrents',
      name: 'Academic Torrents',
      category: 'p2p-dht',
      description: '140TB+ scientific datasets, papers & courseware via BitTorrent',
      url: `https://academictorrents.com/browse.php?search=${encodedRaw}`,
    },
    {
      id: 'nzbindex',
      name: 'NZBIndex',
      category: 'usenet-nzb',
      description: 'Direct Usenet binary & alt.binaries.* .nzb search engine',
      url: `https://nzbindex.com/search?q=${encodedRaw}`,
    },
    {
      id: 'binsearch',
      name: 'Binsearch',
      category: 'usenet-nzb',
      description: 'Raw Usenet header & PAR2 collection indexer',
      url: `https://binsearch.info/?q=${encodedRaw}&max=100&adv_age=1100`,
    },
    {
      id: 'annas-archive',
      name: "Anna's Archive",
      category: 'academic-archive',
      description: 'Shadow library meta-search for books, papers, zines & bulk torrents',
      url: `https://annas-archive.org/search?q=${encodedRaw}`,
    },
    {
      id: 'ddosecrets-archive',
      name: 'DDoSecrets',
      category: 'raw-uncensored',
      description: 'Distributed Denial of Secrets primary leak archives & datasets',
      url: `https://ddosecrets.com/all_articles?q=${encodedRaw}`,
    },
    {
      id: 'wayback',
      name: 'Internet Archive',
      category: 'academic-archive',
      description: 'Verified archival BitTorrent swarms, texts & FOIA collections',
      url: `https://archive.org/search?query=${encodedRaw}`,
    },
    {
      id: 'desuarchive',
      name: 'Desuarchive',
      category: 'raw-uncensored',
      description: 'Full-text search of archived 4chan boards (/g/, /sci/, /vr/, /his/)',
      url: `https://desuarchive.org/_/search/text/${encodedRaw}/`,
    },
    {
      id: '4plebs',
      name: '4plebs',
      category: 'raw-uncensored',
      description: 'Archived /x/, /tg/, /tv/, /pol/ threads',
      url: `https://archive.4plebs.org/_/search/text/${encodedRaw}/`,
    },
    {
      id: 'warosu',
      name: 'Warosu',
      category: 'raw-uncensored',
      description: 'Long-running archive of science, DIY and literature boards',
      url: `https://warosu.org/sci/?task=search2&search_text=${encodedRaw}`,
    },
    {
      id: 'textfiles',
      name: 'textfiles.com',
      category: 'academic-archive',
      description: 'BBS-era text files, zines and phreaking docs',
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${trimmed} site:textfiles.com`)}`,
    },
  ];

  void DEFAULT_SLOP_DOMAINS;

  return {
    rawQuery: trimmed,
    cleanedTokens,
    lens,
    synthesizedQuery,
    negativeSiteOperators,
    positiveOperators,
    dateConstraint,
    escapeUrls,
  };
}
