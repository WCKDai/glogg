/**
 * Deep index — where sources come from. Each list is an open directory or a
 * hand-verified set (checked live on 2026-11-09), plus anything you add.
 */
import { parse512kbSites, parseFeedList } from './parse.js';
import type { SourceInput } from './store.js';

const HOUR = 60;
const DAY = 24 * HOUR;

/** How often each kind is revisited, in minutes. */
export const INTERVAL_MIN = { blog: DAY, forum: 3 * HOUR, board: HOUR, site: 30 * DAY } as const;

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
} as const;

const LAINCHAN_BOARDS: [string, string][] = [
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
];

export const OTHER_BOARDS: SourceInput[] = [
  ...LAINCHAN_BOARDS.map(([b, title]) => ({
    url: `https://lainchan.org/${b}/catalog.json`,
    kind: 'board' as const,
    site: 'lainchan.org',
    origin: 'lainchan',
    title: `/${b}/ ${title}`,
    intervalMin: INTERVAL_MIN.board,
    threadUrl: `https://lainchan.org/${b}/res/{no}.html`,
  })),
  {
    url: 'https://wizchan.org/wiz/catalog.json',
    kind: 'board',
    site: 'wizchan.org',
    origin: 'wizchan',
    title: '/wiz/ Wizardry',
    intervalMin: INTERVAL_MIN.board,
    threadUrl: 'https://wizchan.org/wiz/res/{no}.html',
  },
];

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
