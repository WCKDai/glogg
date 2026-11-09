/**
 * Deep index — where sources come from. Each list is an open directory or a
 * hand-verified set (checked live on 2026-11-09), plus anything you add.
 */
import { parse512kbSites, parseFeedList, parseLemmyverse, parseWebring } from './parse.js';
import type { SourceInput } from './store.js';

const HOUR = 60;
const DAY = 24 * HOUR;

/** How often each kind is revisited, in minutes. */
export const INTERVAL_MIN = { blog: DAY, forum: 3 * HOUR, board: HOUR, site: 30 * DAY } as const;
/** Lemmy communities are many and mostly slow; Stack Exchange shares one backend (the crawler paces it as one host). */
const LEMMY_INTERVAL_MIN = 12 * HOUR;
const STACK_EXCHANGE_INTERVAL_MIN = 6 * HOUR;
/** Lemmy communities smaller than this are mostly empty or abandoned. */
export const LEMMY_MIN_SUBSCRIBERS = 100;

export const SEED_LISTS = {
  smallweb: {
    url: 'https://raw.githubusercontent.com/kagisearch/smallweb/main/smallweb.txt',
    label: 'Kagi Small Web',
    licence: 'MIT © Kagi Search',
  },
  club512: {
    url: 'https://raw.githubusercontent.com/kevquirk/512kb.club/main/_data/sites.yml',
    label: '512KB Club',
    licence: 'MIT © Kev Quirk',
  },
  fourchan: { url: 'https://a.4cdn.org/boards.json', label: '4chan boards', licence: '4chan API (1 request/s, If-Modified-Since)' },
  webring: { url: 'https://webring.xxiivv.com/', label: 'XXIIVV webring', licence: 'public member list' },
  lemmy: {
    url: 'https://data.lemmyverse.net/data/community.full.json',
    label: 'Lemmyverse',
    licence: 'public dump of Lemmy communities (lemmy-explorer)',
  },
  discourse: { url: 'https://discover.discourse.org/latest.json', label: 'Discourse Discover', licence: 'public directory, read one page a second' },
} as const;

type BoardDef = [board: string, title: string, nsfw?: boolean];

/** An imageboard: where its catalogs live, how its thread links look, and its boards. */
interface Chan {
  origin: string;
  base: string;
  /** `{base}`, `{board}` and `{no}` are filled in; vichan's `/res/{no}.html` unless said otherwise. */
  thread?: string;
  boards: BoardDef[];
}

/** Each board checked live: its catalog parses and a thread link from it opens. */
const CHANS: Chan[] = [
  {
    origin: 'lainchan',
    base: 'https://lainchan.org',
    boards: [
      ['λ', 'Programming'],
      ['Δ', 'Do It Yourself'],
      ['sec', 'Security'],
      ['Ω', 'Technology'],
      ['inter', 'Games and Interactive Media'],
      ['lit', 'Literature'],
      ['music', 'Musical and Audible Media'],
      ['vis', 'Visual Media'],
      ['hum', 'Humanity'],
      ['drug', 'Drugs 3.0'],
      ['zzz', 'Consciousness and Dreams'],
      ['layer', 'Layer'],
      ['q', 'Questions and Complaints'],
      ['r', 'Random'],
      ['psy', 'Paranoia'],
      ['mega', 'Mega'],
    ],
  },
  {
    origin: 'wizchan',
    base: 'https://wizchan.org',
    boards: [
      ['wiz', 'Wizardry'],
      ['dep', 'Depression'],
      ['hob', 'Hobbies'],
      ['lounge', 'Lounge'],
      ['jp', 'Japan/Anime'],
      ['games', 'Video Games'],
      ['music', 'Music'],
    ],
  },
  {
    origin: 'uboachan',
    base: 'https://uboachan.net',
    boards: [
      ['yn', 'Yume Nikki General'],
      ['fg', 'Fangames'],
      ['2', '日本 ~redux~'],
      ['ig', 'RPGMaker / Gamedev'],
      ['lit', 'Literature / Fanfic / Poetry'],
      ['o', 'Art / Oekaki'],
      ['x', 'Paranormal / Occult'],
      ['hikki', 'NEET / Advice'],
      ['n', 'NEET'],
      ['ot', 'Off-topic'],
    ],
  },
  {
    origin: 'sushigirl',
    base: 'https://sushigirl.cafe',
    boards: [
      ['lounge', 'sushi social'],
      ['arcade', 'Video games'],
      ['kawaii', 'Cute things'],
      ['kitchen', 'Food & cooking'],
      ['tunes', 'Music'],
      ['culture', 'Arts & literature'],
      ['silicon', 'Technology'],
      ['otaku', 'Japan / Otaku / Anime'],
      ['hell', 'Internet death cult', true],
    ],
  },
  {
    origin: 'leftypol',
    base: 'https://leftypol.org',
    boards: [
      ['leftypol', 'Leftist Politically Incorrect'],
      ['edu', 'Education'],
      ['labor', 'Labor'],
      ['tech', 'Technology'],
      ['games', 'Games'],
      ['anime', 'Anime'],
      ['music', 'Music'],
      ['draw', 'Original Art'],
      ['hobby', 'Hobby'],
      ['lgbt', 'LGBT'],
      ['latam', 'LATAM'],
      ['AKM', 'Guns, weapons and the art of war'],
      ['ufo', 'Paranormal and Conspiracies'],
      ['420', 'Drugs and Psychedelics'],
      ['siberia', 'Off-topic', true],
    ],
  },
  {
    origin: 'kissu',
    base: 'https://kissu.moe',
    thread: '{base}/{board}/thread/{no}',
    boards: [
      ['qa', 'Questions & Answers'],
      ['jp', '2D/Random'],
    ],
  },
  {
    // Russian-language; 2ch.hk now redirects here. 2ch's catalog has its own shape (see parseChanCatalog).
    origin: '2ch',
    base: 'https://2ch.su',
    boards: [
      ['pr', 'Programming'],
      ['s', 'Software'],
      ['hw', 'Hardware'],
      ['ra', 'Radio engineering'],
      ['mobi', 'Mobile devices'],
      ['gd', 'Game development'],
      ['sci', 'Science'],
      ['hi', 'History'],
      ['bo', 'Books'],
      ['mov', 'Films'],
      ['tv', 'TV series'],
      ['mu', 'Music'],
      ['v', 'Video games'],
      ['cg', 'Consoles'],
      ['fiz', 'Fitness'],
      ['news', 'News'],
      ['po', 'Politics'],
      ['zog', 'Conspiracy theories'],
      ['b', 'Random', true],
    ],
  },
];

export const OTHER_BOARDS: SourceInput[] = CHANS.flatMap((chan) =>
  chan.boards.map(([board, title, nsfw]) => ({
    url: `${chan.base}/${board}/catalog.json`,
    kind: 'board' as const,
    site: hostOf(chan.base),
    origin: chan.origin,
    title: `/${board}/ ${title}`,
    ...(nsfw ? { nsfw } : {}),
    intervalMin: INTERVAL_MIN.board,
    threadUrl: (chan.thread ?? '{base}/{board}/res/{no}.html').replace('{base}', chan.base).replace('{board}', board),
  }))
);

/** Discourse forums: indexed through /latest.rss, and searched live for old threads. */
export const DISCOURSE_FORUMS = [
  'discuss.python.org',
  'users.rust-lang.org',
  'internals.rust-lang.org',
  'discourse.nixos.org',
  'forum.level1techs.com',
  'meta.discourse.org',
  'forums.swift.org',
  'discuss.kotlinlang.org',
  'community.home-assistant.io',
  'forum.obsidian.md',
  'discourse.julialang.org',
  'forum.manjaro.org',
  'discourse.ubuntu.com',
  'discussion.fedoraproject.org',
  'forum.endeavouros.com',
  'discuss.pytorch.org',
  'forum.freecodecamp.org',
  'forum.arduino.cc',
  'forum.kicad.info',
  'forum.f-droid.org',
  'discourse.mozilla.org',
  'forum.syncthing.net',
  'forum.rclone.org',
  'forum.restic.net',
  'discourse.llvm.org',
  'community.letsencrypt.org',
  'forum.duplicati.com',
  'discuss.ocaml.org',
];

/** Searched live in the Forums scope; a broad mix so most questions land somewhere. */
export const LIVE_DISCOURSE = [
  'discuss.python.org',
  'users.rust-lang.org',
  'discourse.nixos.org',
  'forum.level1techs.com',
  'community.home-assistant.io',
  'discourse.ubuntu.com',
  'discussion.fedoraproject.org',
  'forum.arduino.cc',
];

export const OTHER_FORUMS: SourceInput[] = [
  { url: 'https://www.vogons.org/app.php/feed', site: 'vogons.org', title: 'VOGONS: vintage PC hardware & games' },
  { url: 'https://forum.vcfed.org/index.php?forums/-/index.rss', site: 'forum.vcfed.org', title: 'Vintage Computer Federation forums' },
  { url: 'https://forums.raspberrypi.com/app.php/feed', site: 'forums.raspberrypi.com', title: 'Raspberry Pi forums' },
  { url: 'https://bbs.archlinux.org/extern.php?action=feed&type=atom', site: 'bbs.archlinux.org', title: 'Arch Linux forums' },
  { url: 'https://lobste.rs/rss', site: 'lobste.rs', title: 'Lobsters' },
  { url: 'https://tildes.net/topics.rss', site: 'tildes.net', title: 'Tildes' },
].map((f) => ({ ...f, kind: 'forum' as const, origin: 'forums', intervalMin: INTERVAL_MIN.forum }));

/**
 * Stack Exchange sites, newest questions as Atom at /feeds. All 100 answered
 * when asked one at a time; a burst of requests gets throttled.
 */
const STACK_EXCHANGE_DOMAINS = ['stackoverflow.com', 'superuser.com', 'serverfault.com', 'askubuntu.com', 'mathoverflow.net'];
const STACK_EXCHANGE_SITES = [
  // computing
  'unix', 'apple', 'android', 'security', 'crypto', 'codereview', 'softwareengineering', 'dba', 'datascience', 'devops', 'networkengineering',
  'webmasters', 'gamedev', 'reverseengineering', 'opensource', 'softwarerecs', 'hardwarerecs', 'tex', 'emacs', 'vi', 'gis', 'retrocomputing',
  'raspberrypi', 'arduino', 'electronics', 'iot', 'robotics', 'drones', '3dprinting', 'ham', 'bitcoin', 'ethereum',
  // science and maths
  'math', 'stats', 'physics', 'chemistry', 'biology', 'astronomy', 'earthscience', 'space', 'aviation', 'quant', 'economics',
  // making and doing
  'diy', 'woodworking', 'mechanics', 'bicycles', 'cooking', 'homebrew', 'gardening', 'photo', 'video', 'sound', 'music', 'outdoors', 'travel',
  'expatriates', 'fitness', 'pets', 'parenting', 'money', 'law', 'patents', 'workplace', 'academia',
  // culture and language
  'english', 'linguistics', 'french', 'german', 'spanish', 'italian', 'russian', 'chinese', 'japanese', 'writing', 'literature', 'history',
  'philosophy', 'politics', 'skeptics', 'judaism', 'christianity', 'islam', 'buddhism', 'hinduism', 'mythology', 'genealogy', 'scifi', 'movies',
  'worldbuilding', 'gaming', 'rpg', 'boardgames', 'chess', 'puzzling',
];

export const STACK_EXCHANGE: SourceInput[] = [...STACK_EXCHANGE_DOMAINS, ...STACK_EXCHANGE_SITES.map((s) => `${s}.stackexchange.com`)].map((host) => ({
  url: `https://${host}/feeds`,
  kind: 'forum' as const,
  site: host,
  origin: 'stackexchange',
  intervalMin: STACK_EXCHANGE_INTERVAL_MIN,
}));

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Sources that need no download: verified boards and forums. */
export function builtinSources(): SourceInput[] {
  return [
    ...OTHER_BOARDS,
    ...DISCOURSE_FORUMS.map((host) => ({
      url: `https://${host}/latest.rss`,
      kind: 'forum' as const,
      site: host,
      origin: 'discourse',
      intervalMin: INTERVAL_MIN.forum,
    })),
    ...OTHER_FORUMS,
    ...STACK_EXCHANGE,
  ];
}

export function sourcesFromSmallWeb(text: string): SourceInput[] {
  return parseFeedList(text).map((url) => ({ url, kind: 'blog' as const, site: hostOf(url), origin: 'smallweb', intervalMin: INTERVAL_MIN.blog }));
}

export function sourcesFrom512kb(yml: string): SourceInput[] {
  return parse512kbSites(yml).map(({ domain, url }) => ({
    url,
    kind: 'site' as const,
    site: domain.replace(/^www\./, ''),
    origin: '512kb',
    intervalMin: INTERVAL_MIN.site,
  }));
}

export function sourcesFrom4chan(json: unknown): SourceInput[] {
  const boards = (json as { boards?: { board: string; title: string; ws_board: number }[] })?.boards || [];
  return boards.map((b) => ({
    url: `https://a.4cdn.org/${b.board}/catalog.json`,
    kind: 'board' as const,
    site: 'boards.4chan.org',
    origin: '4chan',
    title: `/${b.board}/ ${b.title}`,
    nsfw: b.ws_board !== 1,
    intervalMin: INTERVAL_MIN.board,
    threadUrl: `https://boards.4chan.org/${b.board}/thread/{no}`,
  }));
}

/** XXIIVV webring members: their feed when the ring lists one, otherwise the site (its feed is found on the first visit). */
export function sourcesFromWebring(html: string): SourceInput[] {
  return parseWebring(html, SEED_LISTS.webring.url).map(({ name, url, feed }) =>
    feed
      ? { url: feed, kind: 'blog' as const, site: hostOf(url), origin: 'xxiivv', title: name, intervalMin: INTERVAL_MIN.blog }
      : { url, kind: 'site' as const, site: hostOf(url), origin: 'xxiivv', title: name, intervalMin: INTERVAL_MIN.site }
  );
}

/** Lemmy communities with a real audience, read through each community's RSS. Flagged ones are left out, 18+ ones gated. */
export function sourcesFromLemmyverse(json: unknown, minSubscribers = LEMMY_MIN_SUBSCRIBERS): SourceInput[] {
  return parseLemmyverse(json)
    .filter((c) => !c.suspicious && c.subscribers >= minSubscribers)
    .sort((a, b) => b.subscribers - a.subscribers)
    .map((c) => ({
      url: `https://${c.instance}/feeds/c/${c.name}.xml?sort=New`,
      kind: 'forum' as const,
      site: c.instance,
      origin: 'lemmy',
      title: c.title,
      // Some instances are adult-only without flagging each community.
      nsfw: c.nsfw || /nsfw|porn|hentai|lewd|xxx/.test(c.instance),
      intervalMin: LEMMY_INTERVAL_MIN,
    }));
}

/** Discourse forums listed on Discourse Discover, read through /latest.rss. */
export function sourcesFromDiscourseDirectory(forums: { url: string; title: string; nsfw: boolean }[]): SourceInput[] {
  return forums.map((f) => ({
    url: `${f.url}/latest.rss`,
    kind: 'forum' as const,
    site: hostOf(f.url),
    origin: 'discourse',
    ...(f.title ? { title: f.title } : {}),
    ...(f.nsfw ? { nsfw: true } : {}),
    intervalMin: INTERVAL_MIN.forum,
  }));
}
