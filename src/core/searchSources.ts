/**
 * The sources a search asks, by the key the server and the status bar use,
 * with a line on what each one is. Settings lets you turn any of them off.
 */
export interface SearchSourceInfo {
  key: string;
  name: string;
  about: string;
}

export const SEARCH_SOURCES: SearchSourceInfo[] = [
  { key: 'wikimedia', name: 'Wikimedia Commons', about: 'Images and videos with creator credits and licence metadata' },
  { key: 'ddg', name: 'DuckDuckGo', about: 'Web results' },
  { key: 'brave', name: 'Brave', about: 'Web results' },
  { key: 'mojeek', name: 'Mojeek', about: 'Independent crawler API, when a key is set' },
  { key: 'kagi', name: 'Kagi', about: 'Kagi Search API, when a key is set' },
  { key: 'searxng', name: 'SearXNG', about: 'Your own meta-search, when one is set up' },
  { key: 'se', name: 'Stack Exchange', about: 'Questions and accepted answers' },
  { key: 'wiki', name: 'Wikipedia', about: 'Encyclopedia articles' },
  { key: 'hn', name: 'Hacker News', about: 'Links and discussions' },
  { key: 'github', name: 'GitHub', about: 'Repositories' },
  { key: 'marginalia', name: 'Marginalia', about: 'The small, non-commercial web' },
  { key: 'wiby', name: 'Wiby', about: 'Simple, old-style pages' },
  { key: 'mwmbl', name: 'Mwmbl', about: 'A community-built web index' },
  { key: 'lemmy', name: 'Lemmy', about: 'Fediverse link aggregator' },
  { key: 'fediverse', name: 'Fediverse', about: 'Bluesky, Mastodon, Matrix and Stoat' },
  { key: 'gdelt', name: 'GDELT news', about: 'The world news wire' },
  { key: 'archive', name: 'Internet Archive', about: 'Texts, FOIA files and old documents' },
  { key: 'openalex', name: 'OpenAlex', about: 'Scholarly papers' },
  { key: 'arxiv', name: 'arXiv', about: 'Preprints' },
  { key: 'p2p', name: 'Torrents & Usenet', about: 'DHT, archive torrents and NZB indexers' },
  { key: 'deep', name: 'Deep index (local)', about: 'Blogs, boards and forums glogg has crawled' },
  { key: 'discourse', name: 'Discourse forums (live)', about: 'In the Forums scope' },
  { key: 'chanLive', name: '4chan', about: 'Live catalogs, in the Wild West scope or 18+ mode' },
  { key: 'chanArchive', name: 'Chan archives', about: 'Archived threads, in the Wild West scope or 18+ mode' },
  { key: 'forums', name: 'Old-web forums', about: 'In the Wild West scope or 18+ mode' },
];

export const SEARCH_SOURCE_NAMES: Record<string, string> = /* @__PURE__ */ Object.fromEntries(SEARCH_SOURCES.map((s) => [s.key, s.name]));
