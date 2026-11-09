/**
 * !bangs — jump from glogg to any engine without leaving the search box.
 * Works at the start or end of a query: "!w turing" or "turing !w".
 * Users can add their own; custom bangs override built-ins with the same trigger.
 */
export interface BangDefinition {
  trigger: string; // without the "!"
  name: string;
  url: string; // must contain {q}
  category: 'web' | 'reference' | 'code' | 'forums' | 'chans' | 'p2p' | 'usenet' | 'archives' | 'fediverse' | 'media';
}

export const BUILTIN_BANGS: BangDefinition[] = [
  { trigger: 'g', name: 'Google (udm=14, no AI)', url: 'https://www.google.com/search?udm=14&safe=off&q={q}', category: 'web' },
  { trigger: 'ddg', name: 'DuckDuckGo (unfiltered)', url: 'https://duckduckgo.com/?kp=-2&q={q}', category: 'web' },
  { trigger: 'b', name: 'Brave Search', url: 'https://search.brave.com/search?q={q}', category: 'web' },
  { trigger: 'k', name: 'Kagi', url: 'https://kagi.com/search?q={q}', category: 'web' },
  { trigger: 'mj', name: 'Mojeek', url: 'https://www.mojeek.com/search?q={q}', category: 'web' },
  { trigger: 'mg', name: 'Marginalia', url: 'https://search.marginalia.nu/search?query={q}', category: 'web' },
  { trigger: 'wiby', name: 'Wiby', url: 'https://wiby.me/?q={q}', category: 'web' },
  { trigger: 'sx', name: 'Local SearXNG', url: 'http://localhost:8080/search?q={q}', category: 'web' },

  { trigger: 'w', name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search={q}', category: 'reference' },
  { trigger: 'wa', name: 'Wolfram|Alpha', url: 'https://www.wolframalpha.com/input?i={q}', category: 'reference' },
  { trigger: 'aw', name: 'Arch Wiki', url: 'https://wiki.archlinux.org/index.php?search={q}', category: 'reference' },
  { trigger: 'scholar', name: 'Google Scholar', url: 'https://scholar.google.com/scholar?q={q}', category: 'reference' },
  { trigger: 'arxiv', name: 'arXiv', url: 'https://arxiv.org/search/?query={q}&searchtype=all', category: 'reference' },

  { trigger: 'gh', name: 'GitHub', url: 'https://github.com/search?type=repositories&q={q}', category: 'code' },
  { trigger: 'cb', name: 'Codeberg', url: 'https://codeberg.org/explore/repos?q={q}', category: 'code' },
  { trigger: 'so', name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q={q}', category: 'code' },
  { trigger: 'mdn', name: 'MDN', url: 'https://developer.mozilla.org/en-US/search?q={q}', category: 'code' },
  { trigger: 'npm', name: 'npm', url: 'https://www.npmjs.com/search?q={q}', category: 'code' },

  { trigger: 'hn', name: 'Hacker News', url: 'https://hn.algolia.com/?q={q}', category: 'forums' },
  { trigger: 'lob', name: 'Lobsters', url: 'https://lobste.rs/search?q={q}&what=stories', category: 'forums' },
  { trigger: 'r', name: 'Reddit (old)', url: 'https://old.reddit.com/search?q={q}', category: 'forums' },
  { trigger: 'vogons', name: 'VOGONS', url: 'https://www.vogons.org/search.php?keywords={q}', category: 'forums' },
  { trigger: 'eev', name: 'EEVblog Forum', url: 'https://duckduckgo.com/?q={q}+site%3Aeevblog.com', category: 'forums' },

  { trigger: '4c', name: '4chan archives (Desuarchive)', url: 'https://desuarchive.org/_/search/text/{q}/', category: 'chans' },
  { trigger: '4p', name: '4plebs', url: 'https://archive.4plebs.org/_/search/text/{q}/', category: 'chans' },
  { trigger: 'warosu', name: 'Warosu (/sci/ /diy/ /lit/)', url: 'https://warosu.org/sci/?task=search2&search_text={q}', category: 'chans' },
  { trigger: 'lain', name: 'Lainchan', url: 'https://duckduckgo.com/?q={q}+site%3Alainchan.org', category: 'chans' },

  { trigger: 'tpb', name: 'The Pirate Bay', url: 'https://thepiratebay.org/search.php?q={q}', category: 'p2p' },
  { trigger: 'btdig', name: 'BTDigg (DHT)', url: 'https://btdig.com/search?q={q}', category: 'p2p' },
  { trigger: 'nyaa', name: 'Nyaa', url: 'https://nyaa.si/?q={q}', category: 'p2p' },
  { trigger: 'at', name: 'Academic Torrents', url: 'https://academictorrents.com/browse.php?search={q}', category: 'p2p' },
  { trigger: 'bm', name: 'Local Bitmagnet', url: 'http://localhost:3333/webui/torrents?query={q}', category: 'p2p' },

  { trigger: 'nzb', name: 'NZBIndex', url: 'https://nzbindex.com/search?q={q}', category: 'usenet' },
  { trigger: 'bin', name: 'Binsearch', url: 'https://binsearch.info/?q={q}', category: 'usenet' },
  { trigger: 'nzbl', name: 'NZB.life', url: 'https://nzb.life/search?q={q}', category: 'usenet' },

  { trigger: 'ia', name: 'Internet Archive', url: 'https://archive.org/search?query={q}', category: 'archives' },
  { trigger: 'wb', name: 'Wayback Machine', url: 'https://web.archive.org/web/*/{q}*', category: 'archives' },
  { trigger: 'aa', name: "Anna's Archive", url: 'https://annas-archive.org/search?q={q}', category: 'archives' },
  { trigger: 'foia', name: 'The Black Vault', url: 'https://www.theblackvault.com/documentarchive/?s={q}', category: 'archives' },
  { trigger: 'dds', name: 'DDoSecrets', url: 'https://ddosecrets.com/all_articles?q={q}', category: 'archives' },

  { trigger: 'bsky', name: 'Bluesky', url: 'https://bsky.app/search?q={q}', category: 'fediverse' },
  { trigger: 'masto', name: 'Mastodon', url: 'https://mastodon.social/search?q={q}', category: 'fediverse' },
  { trigger: 'lemmy', name: 'Lemmy', url: 'https://lemmy.world/search?q={q}', category: 'fediverse' },
  { trigger: 'mx', name: 'Matrix rooms', url: 'https://matrixrooms.info/?s={q}', category: 'fediverse' },

  { trigger: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query={q}', category: 'media' },
  { trigger: 'inv', name: 'Invidious', url: 'https://yewtu.be/search?q={q}', category: 'media' },
  { trigger: 'bc', name: 'Bandcamp', url: 'https://bandcamp.com/search?q={q}', category: 'media' },
];

export interface BangMatch {
  bang: BangDefinition;
  query: string;
  url: string;
}

const BANG_TOKEN = /(?:^|\s)!([a-z0-9][a-z0-9._-]*)(?=\s|$)/i;

export function mergeBangs(custom: BangDefinition[] = []): BangDefinition[] {
  const byTrigger = new Map<string, BangDefinition>();
  for (const b of BUILTIN_BANGS) byTrigger.set(b.trigger.toLowerCase(), b);
  for (const b of custom) {
    if (b.trigger && b.url.includes('{q}')) byTrigger.set(b.trigger.toLowerCase(), b);
  }
  return Array.from(byTrigger.values());
}

/** Returns a redirect target if the query contains a known !bang, otherwise null. */
export function resolveBang(rawQuery: string, custom: BangDefinition[] = []): BangMatch | null {
  const m = rawQuery.match(BANG_TOKEN);
  if (!m) return null;
  const trigger = m[1].toLowerCase();
  const bang = mergeBangs(custom).find((b) => b.trigger.toLowerCase() === trigger);
  if (!bang) return null;
  const query = rawQuery.replace(BANG_TOKEN, ' ').replace(/\s+/g, ' ').trim();
  return { bang, query, url: bang.url.replace('{q}', encodeURIComponent(query)) };
}

/** Suggestions while the user is typing a "!" token at the end of the query. */
export function suggestBangs(rawQuery: string, custom: BangDefinition[] = [], limit = 8): BangDefinition[] {
  const m = rawQuery.match(/(?:^|\s)!([a-z0-9._-]*)$/i);
  if (!m) return [];
  const prefix = m[1].toLowerCase();
  const all = mergeBangs(custom);
  const scored = all
    .map((b) => {
      const t = b.trigger.toLowerCase();
      const n = b.name.toLowerCase();
      let score = -1;
      if (t === prefix) score = 100;
      else if (t.startsWith(prefix)) score = 80 - t.length;
      else if (prefix && n.includes(prefix)) score = 40;
      else if (!prefix) score = 10;
      return { b, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.b);
}
