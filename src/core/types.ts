import type { PluginDownloadTargetInfo } from './plugins.js';

export type SearchLensId =
  | 'all'
  | 'wild-west'
  | 'small-web'
  | 'fediverse'
  | 'forums'
  | 'deep-archives'
  | 'raw-news'
  | 'p2p-magnet'
  | 'usenet-nzb'
  | 'primary'
  | 'pre-llm';

export const SEARCH_LENS_IDS: readonly SearchLensId[] = ['all', 'wild-west', 'small-web', 'fediverse', 'forums', 'deep-archives', 'raw-news', 'p2p-magnet', 'usenet-nzb', 'primary', 'pre-llm'];

/** A lens glogg knows. ("constructor" is a property of every object, not a lens.) */
export function isSearchLens(v: unknown): v is SearchLensId {
  return typeof v === 'string' && (SEARCH_LENS_IDS as readonly string[]).includes(v);
}

export type SourceConnectorId =
  | 'marginalia'
  | 'indie-index'
  | 'wiby'
  | 'chanboards'
  | 'wild-west'
  | 'atproto'
  | 'activitypub'
  | 'lemmy'
  | 'matrix'
  | 'stoat'
  | 'lobsters'
  | 'hn'
  | 'gdelt-news'
  | 'archive-deep'
  | 'openalex'
  | 'arxiv'
  | 'codeberg'
  | 'github'
  | 'archive'
  | 'stackexchange'
  | 'wikipedia'
  | 'bitmagnet-dht'
  | 'academic-torrents'
  | 'archive-bt'
  | 'usenet-nzb'
  | 'nzb-life'
  | 'ipfs-dht'
  | 'web'
  /** glogg's own index (server/deep): small-web blogs, imageboards, forums */
  | 'deep-blogs'
  | 'deep-boards'
  | 'deep-forums'
  | 'mwmbl'
  | 'discourse';

export type SlopVerdict =
  | 'primary-source'
  | 'indie-gem'
  | 'verified-p2p'
  | 'fediverse-node'
  | 'human-signal'
  | 'raw-uncensored'
  | 'neutral'
  | 'seo-suspect'
  | 'sponsored-ad'
  | 'slop-farm';

export interface SignalHit {
  id: string;
  label: string;
  delta: number;
  category:
    | 'primary'
    | 'indie'
    | 'fediverse'
    | 'density'
    | 'p2p'
    | 'sponsored'
    | 'seo-slop'
    | 'ai-fluff'
    | 'monoculture'
    | 'user-rule';
  detail?: string;
}

export interface P2PMetadata {
  protocol: 'bittorrent-dht' | 'usenet-nzb' | 'ipfs';
  infoHash?: string;
  magnetUri?: string;
  torrentUrl?: string;
  nzbUrl?: string;
  ipfsCid?: string;
  sizeBytes?: number;
  sizeFormatted: string;
  seeders?: number;
  leechers?: number;
  filesCount?: number;
  newsgroup?: string;
  usenetAgeDays?: number;
  par2Status?: 'verified' | 'complete' | 'unverified';
  indexerName: string;
  categoryLabel?: string;
  isAdultNsfw?: boolean;
  healthVerdict: 'verified-swarm' | 'active' | 'archival-seedbox' | 'low-seed' | 'suspect-spam';
}

export interface FediverseMetadata {
  protocol: 'atproto' | 'activitypub' | 'matrix' | 'stoat';
  handleOrRoom: string; // e.g. @user.bsky.social, @user@mastodon.social, #linux:matrix.org, stoat.chat/server
  uri: string; // at://did:plc:..., https://..., matrix:r/...
  cidOrId?: string;
  instanceDomain: string;
  membersOrInteractions?: number;
}

export interface RawSearchResult {
  id?: string;
  title: string;
  url: string;
  snippet: string;
  source: SourceConnectorId;
  publishedAt?: string;
  author?: string;
  points?: number;
  commentsCount?: number;
  /** Where people discuss it (a Hacker News thread for a linked story). */
  discussionUrl?: string;
  tags?: string[];
  isNsfw?: boolean;
  country?: string;
  p2p?: P2PMetadata;
  fediverse?: FediverseMetadata;
}

export interface ScoredSearchResult extends RawSearchResult {
  id: string;
  domain: string;
  rootDomain: string;
  tld: string;
  slopScore: number;
  authenticityScore: number;
  relevanceScore: number;
  netScore: number;
  verdict: SlopVerdict;
  signals: SignalHit[];
  isPreLlm: boolean;
  isIndieWeb: boolean;
  isPrimarySource: boolean;
  isSponsored: boolean;
  isBigTechMonoculture: boolean;
  domainOccurrenceRank?: number;
  demotedReason?: string;
}

export interface InstantCitation {
  index: number;
  title: string;
  url: string;
  domain: string;
  source: SourceConnectorId;
}

export interface InstantAnswerPayload {
  kind: 'computation' | 'direct-fact' | 'technical-answer' | 'knowledge-synthesis';
  title: string;
  subtitle?: string;
  directAnswer: string;
  confidence: 'verified' | 'high' | 'synthesized';
  codeBlock?: string;
  keyFacts?: { label: string; value: string }[];
  takeaways?: { text: string; citationIndex: number }[];
  primarySourceUrl?: string;
  primarySourceTitle?: string;
  primarySourceDomain?: string;
  citations: InstantCitation[];
}

export interface CustomEndpointsConfig {
  bitmagnetUrl?: string;
  searxngUrl?: string;
  ipfsGatewayUrl?: string;
  torznabUrl?: string;
  torznabApiKey?: string;
  newznabUrl?: string;
  newznabApiKey?: string;
  nzbLifeUrl?: string;
  nzbLifeApiKey?: string;
  /** Personal Marginalia key; the shared "public" key is rate-limited. */
  marginaliaApiKey?: string;
  /** Stack Exchange app key: 10,000 requests a day instead of 300 per IP. */
  stackexchangeKey?: string;
  offcloudApiKey?: string;
  offcloudRemoteOptionId?: string;
  nextcloudUrl?: string;
  nextcloudUser?: string;
  nextcloudAppPassword?: string;
  nextcloudFolder?: string;
  aria2RpcUrl?: string;
  aria2RpcSecret?: string;
  matrixHomeserverUrl?: string;
  atprotoAppViewUrl?: string;
}

export type DownloadTargetId =
  | 'auto'
  | 'offcloud'
  | 'nextcloud'
  | 'aria2-rpc'
  | 'local-vault'
  /** Any plugin that declares `downloadTarget`, e.g. `plugin:realdebrid`. */
  | `plugin:${string}`;

export interface DownloadJob {
  id: string;
  title: string;
  sourceUrl: string; // magnet:..., .nzb URL, .torrent URL, or HTTP URL
  kind: 'magnet' | 'torrent' | 'nzb' | 'web-archive' | 'direct-file';
  target: Exclude<DownloadTargetId, 'auto'>;
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'cached-instant';
  progressPercent: number;
  sizeFormatted?: string;
  createdAt: string;
  remoteId?: string;
  destinationUrl?: string; // e.g. Offcloud cloud link, Nextcloud WebDAV path, or local /downloads path
  statusDetail: string;
}

export interface DownloadManagerReport {
  config: CustomEndpointsConfig;
  integrations: {
    offcloudConfigured: boolean;
    nzbLifeConfigured: boolean;
    nextcloudConfigured: boolean;
    aria2Reachable: boolean;
    localDownloadsDir: string;
  };
  jobs: DownloadJob[];
  /** Plugins that can receive downloads (Real-Debrid, TorBox, SABnzbd…). */
  pluginTargets?: PluginDownloadTargetInfo[];
}

export interface SearchFilterConfig {
  lens: SearchLensId;
  maxPerDomain: number;
  slopThreshold: number;
  preLlmOnly: boolean;
  obscureWebOnly: boolean;
  stripSponsored: boolean;
  uncensoredMode: boolean; // 18+ Unfiltered Mode (raw news, OSINT, adult/NSFW DHT & Usenet, SafeSearch=Off)
  /** Never shown. */
  blockedDomains: string[];
  /** Raised: ranked higher. */
  boostedDomains: string[];
  /** Lowered: still shown, ranked lower. */
  loweredDomains?: string[];
  /** Pinned: on top whenever they match the query. */
  pinnedDomains?: string[];
  /** Results mentioning any of these are hidden. */
  blockedPhrases: string[];
  /** Sources (keys from SEARCH_SOURCES) a search doesn't ask. */
  disabledSources?: string[];
  /** From the query's operators (parseQueryOperators): site:, -site:, -word and "phrase". */
  onlySites?: string[];
  excludeSites?: string[];
  excludeWords?: string[];
  phrases?: string[];
  endpoints?: CustomEndpointsConfig;
}

export interface RankedSearchResponse {
  query: string;
  lens: SearchLensId;
  uncensoredMode: boolean;
  compiledQuery: CompiledQueryPlan;
  instantAnswer?: InstantAnswerPayload;
  results: ScoredSearchResult[];
  p2pResults: ScoredSearchResult[];
  filteredSlop: ScoredSearchResult[];
  /** An early batch, streamed before the final response; slower sources are still coming. */
  partial?: boolean;
  metrics: {
    totalRawResults: number;
    surfacedCount: number;
    p2pCount: number;
    fediverseCount: number;
    filteredSlopCount: number;
    sponsoredRemovedCount: number;
    primarySourcesCount: number;
    demotedDuplicateDomainsCount: number;
    uniqueDomainsCount: number;
    tldDistribution: Record<string, number>;
    sourceDistribution: Record<string, number>;
    domainDiversityRatio: number;
    avgAuthenticityScore: number;
    avgSlopScore: number;
    sourcesQueried: SourceConnectorId[];
    /** Per upstream: time to answer, results returned, and whether it made the deadline. */
    sourceTimings?: Record<string, { ms: number; count: number; status: 'ok' | 'empty' | 'error' | 'late' | 'resting' | 'off' }>;
    durationMs: number;
  };
}

export interface CompiledQueryPlan {
  rawQuery: string;
  cleanedTokens: string[];
  lens: SearchLensId;
  synthesizedQuery: string;
  negativeSiteOperators: string[];
  positiveOperators: string[];
  dateConstraint?: string;
  escapeUrls: {
    id: string;
    name: string;
    category: 'web-meta' | 'p2p-dht' | 'usenet-nzb' | 'fediverse' | 'academic-archive' | 'raw-uncensored';
    description: string;
    url: string;
  }[];
}

export interface CleanedContentSection {
  id: string;
  heading?: string;
  tag: 'h1' | 'h2' | 'h3' | 'p' | 'pre' | 'blockquote' | 'ul' | 'table';
  text: string;
  html?: string;
  isFluffPreamble: boolean;
  isSponsoredCallout?: boolean;
  isCoreAnswer: boolean;
  wordCount: number;
  fluffTriggers: string[];
}

export interface ExtractedPageLink {
  text: string;
  url: string;
  domain: string;
  kind: 'primary-source' | 'magnet-p2p' | 'indie' | 'reference' | 'external' | 'affiliate-or-tracker';
  sourceTypeLabel?: string;
  strippedParams: string[];
}

export interface PageAutopsyReport {
  url: string;
  title: string;
  domain: string;
  byline?: string;
  publishedDate?: string;
  generator?: string;
  hasRssFeed: boolean;
  rssFeedUrl?: string;
  hasIndieWebMarkers: boolean;
  verdict: SlopVerdict;
  slopScore: number;
  authenticityScore: number;
  signals: SignalHit[];
  stats: {
    rawHtmlBytes: number;
    cleanTextBytes: number;
    bloatReductionPercent: number;
    totalScriptsRemoved: number;
    trackersBlocked: string[];
    sponsoredBlocksRemoved: number;
    affiliateLinksDisarmed: number;
    trackingParamsStripped: number;
    primarySourcesFound: number;
    aiPhrasesDetected: string[];
    seoPatternsDetected: string[];
    estimatedRawReadMinutes: number;
    estimatedCleanReadMinutes: number;
    fluffPreambleParagraphs: number;
  };
  coreTakeaway: string;
  primarySources: ExtractedPageLink[];
  sections: CleanedContentSection[];
  links: ExtractedPageLink[];
}

export interface IndieSiteEntry {
  title: string;
  url: string;
  domain: string;
  category:
    | 'p2p-dht-usenet'
    | 'fediverse-protocols'
    | 'meta-indexers'
    | 'deep-archives-osint'
    | 'niche-forums'
    | 'systems-code'
    | 'science-hardware'
    | 'practical-nobs'
    | 'archives-reference'
    | 'essays-culture';
  description: string;
  tags: string[];
  era: 'pre-llm' | 'classic-web' | 'indie-modern';
  is18Plus?: boolean;
  rssUrl?: string;
}

export interface ContainerServiceStatus {
  id: string;
  name: string;
  containerName: string;
  image: string;
  category:
    | 'P2P & DHT'
    | 'Decentralized Web'
    | 'Meta-Search'
    | 'P2P & Usenet'
    | 'Usenet NZB'
    | 'Download & Cloud'
    | 'Deep Web / Onion';
  description: string;
  webUrl: string;
  apiUrl: string;
  ports: string[];
  state: 'running' | 'stopped' | 'not-created';
  reachable: boolean;
  containerId?: string;
  statusText: string;
}

export interface ContainerStackReport {
  runtimes: {
    docker: boolean;
    podman: boolean;
    colima: boolean;
  };
  activeRuntime: 'docker' | 'podman' | 'none';
  daemonRunning: boolean;
  composeFilePath: string;
  services: ContainerServiceStatus[];
}
