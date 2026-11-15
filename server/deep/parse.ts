/**
 * Deep index — parsers. Pure functions from fetched bytes to posts, so every
 * format the crawler reads is tested offline (tests/deep.test.ts).
 */
import * as cheerio from 'cheerio';

export type DeepKind = 'blog' | 'board' | 'forum' | 'site';

export interface DeepPost {
  url: string;
  title: string;
  /** Plain text, trimmed to SUMMARY_MAX characters. */
  summary: string;
  /** Epoch milliseconds. */
  published?: number;
}

export interface ParsedFeed {
  title?: string;
  siteUrl?: string;
  posts: DeepPost[];
}

const SUMMARY_MAX = 600;

/** Plain text of a fragment from a feed or catalog. Anything but a string (malformed JSON) reads as empty. */
export function htmlToText(html: unknown, max = SUMMARY_MAX): string {
  if (typeof html !== 'string' || !html) return '';
  let text: string;
  try {
    const $ = cheerio.load(`<div>${html.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h\d)>/gi, ' ')}</div>`);
    // Their contents are code or markup, not words.
    $('script, style, noscript, iframe, template, textarea').remove();
    text = $.text().replace(/\s+/g, ' ').trim();
  } catch (e) {
    // Thousands of nested elements overflow the parser's recursion: no summary rather than no feed.
    if (e instanceof RangeError) return '';
    throw e;
  }
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}

function toTime(value?: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? t : undefined;
}

function absolute(href: unknown, base: string): string | undefined {
  if (typeof href !== 'string' || !href) return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Lemmy's feeds open every item with "submitted by X to Y · N points | N comments · link"; the post is what follows. */
const LEMMY_ITEM_HEADER = /^submitted by \S+ to \S+\s+-?\d+ points? \| \d+ comments?\s*(?:https?:\/\/\S+\s*)?/i;

/** RSS 2.0, RSS 1.0 (RDF) and Atom. Items without a link are skipped. */
export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  const $ = cheerio.load(xml, { xmlMode: true });
  const posts: DeepPost[] = [];
  const seen = new Set<string>();
  const push = (p: DeepPost | null) => {
    if (!p || seen.has(p.url)) return;
    seen.add(p.url);
    posts.push(p);
  };

  const atom = $('feed').first();
  if (atom.length) {
    const siteUrl = absolute(atom.children('link[rel="alternate"]').attr('href') || atom.children('link:not([rel])').attr('href'), feedUrl);
    atom.find('entry').each((_, el) => {
      const e = $(el);
      const href =
        e.children('link[rel="alternate"]').attr('href') || e.children('link:not([rel])').attr('href') || e.children('link').first().attr('href');
      const url = absolute(href, siteUrl || feedUrl);
      if (!url) return;
      push({
        url,
        title: htmlToText(e.children('title').first().text(), 300) || url,
        summary: htmlToText(e.children('summary').first().text() || e.children('content').first().text()),
        published: toTime(e.children('published').first().text() || e.children('updated').first().text()),
      });
    });
    return { title: htmlToText(atom.children('title').first().text(), 200) || undefined, siteUrl, posts };
  }

  const channel = $('channel').first();
  const siteUrl = absolute(channel.children('link').first().text(), feedUrl);
  $('item').each((_, el) => {
    const i = $(el);
    const url = absolute(i.children('link').first().text() || i.children('guid[isPermaLink!="false"]').first().text() || i.attr('rdf:about'), siteUrl || feedUrl);
    if (!url) return;
    push({
      url,
      title: htmlToText(i.children('title').first().text(), 300) || url,
      summary: htmlToText(i.children('description').first().text() || i.children('content\\:encoded').first().text()).replace(LEMMY_ITEM_HEADER, ''),
      published: toTime(i.children('pubDate').first().text() || i.children('dc\\:date').first().text()),
    });
  });
  return { title: htmlToText(channel.children('title').first().text(), 200) || undefined, siteUrl, posts };
}

/** JSON Feed 1.x (jsonfeed.org). */
export function parseJsonFeed(data: unknown, feedUrl: string): ParsedFeed {
  const f = data as {
    title?: string;
    home_page_url?: string;
    items?: { url?: string; external_url?: string; title?: string; summary?: string; content_text?: string; content_html?: string; date_published?: string }[];
  };
  const siteUrl = absolute(f?.home_page_url, feedUrl);
  const posts: DeepPost[] = [];
  for (const it of Array.isArray(f?.items) ? f.items : []) {
    if (!it || typeof it !== 'object') continue;
    const url = absolute(it.url || it.external_url, siteUrl || feedUrl);
    if (!url) continue;
    posts.push({
      url,
      title: htmlToText(it.title || '', 300) || url,
      summary: it.summary ? htmlToText(it.summary) : it.content_text ? htmlToText(it.content_text) : htmlToText(it.content_html || ''),
      published: toTime(it.date_published),
    });
  }
  return { title: f?.title ? htmlToText(f.title, 200) : undefined, siteUrl, posts };
}

interface ChanThread {
  no?: number;
  sub?: string;
  com?: string;
  time?: number;
  sticky?: number;
  replies?: number;
}

/** A thread in 2ch's catalog, which has its own field names. */
interface DvachThread {
  num?: number | string;
  subject?: string;
  comment?: string;
  timestamp?: number;
  sticky?: number;
  posts_count?: number;
}

/** Threads from either catalog shape: 4chan's pages, or 2ch's `{board, threads}`. */
function chanThreads(data: unknown): ChanThread[] {
  if (Array.isArray(data)) return (data as { threads?: ChanThread[] }[]).flatMap((page) => page?.threads || []);
  const threads = (data as { threads?: DvachThread[] } | null)?.threads;
  if (!Array.isArray(threads)) return [];
  return threads.map((t) => ({
    no: Number(t?.num) || undefined,
    sub: t?.subject,
    com: t?.comment,
    time: t?.timestamp,
    sticky: t?.sticky,
    // 2ch counts the opening post as one of the thread's posts.
    replies: t?.posts_count ? t.posts_count - 1 : undefined,
  }));
}

/**
 * Imageboard catalogs: the 4chan API shape (4chan, vichan, lainchan) `[{page, threads: [...]}]`,
 * and 2ch's `{board, threads: [...]}`. Text only. Pinned rules threads are skipped.
 */
export function parseChanCatalog(data: unknown, threadUrl: (no: number) => string): DeepPost[] {
  const out: DeepPost[] = [];
  for (const t of chanThreads(data)) {
    if (!t?.no || t.sticky) continue;
    const body = htmlToText(t.com || '');
    const subject = htmlToText(t.sub || '', 200);
    const title = subject || body.slice(0, 90) || `Thread ${t.no}`;
    out.push({
      url: threadUrl(t.no),
      title: subject ? title : `${title}${body.length > 90 ? '…' : ''}`,
      summary: `${body}${t.replies ? ` · ${t.replies} replies` : ''}`.trim(),
      published: t.time ? t.time * 1000 : undefined,
    });
  }
  return out;
}

/** `<link rel="alternate" type="application/rss+xml|atom+xml">` on a page. */
export function discoverFeeds(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $('link[rel~="alternate"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!/(rss|atom)\+xml|application\/feed\+json/.test(type)) return;
    const url = absolute($(el).attr('href'), pageUrl);
    if (url && !/comments/i.test(url)) urls.add(url);
  });
  return [...urls];
}

/** True when a page is a Discourse forum (its own generator meta tag). */
export function isDiscourse(html: string): boolean {
  return /<meta[^>]+name=["']generator["'][^>]+content=["']Discourse/i.test(html);
}

/** 512kb.club's `_data/sites.yml`: `- domain: x` / `url: y` pairs. */
export function parse512kbSites(yml: string): { domain: string; url: string }[] {
  const out: { domain: string; url: string }[] = [];
  let domain = '';
  for (const line of yml.split('\n')) {
    const d = line.match(/^-\s*domain:\s*(\S+)/);
    if (d) {
      domain = d[1];
      continue;
    }
    const u = line.match(/^\s+url:\s*(\S+)/);
    if (u && domain) {
      const url = absolute(u[1], 'https://x');
      if (url) out.push({ domain, url });
      domain = '';
    }
  }
  return out;
}

/** Kagi Small Web list: one feed URL per line. */
export function parseFeedList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l));
}

/** The XXIIVV webring's member list: `<ol id="icons"><li><a href=site>name</a> <a class="rss" href=feed>`. */
export function parseWebring(html: string, pageUrl: string): { name: string; url: string; feed?: string }[] {
  const $ = cheerio.load(html);
  const out: { name: string; url: string; feed?: string }[] = [];
  $('#icons li').each((_, el) => {
    const li = $(el);
    const link = li.find('a:not(.rss)').first();
    const url = absolute(link.attr('href'), pageUrl);
    if (!url) return;
    out.push({ name: link.text().replace(/\s+/g, ' ').trim() || new URL(url).hostname, url, feed: absolute(li.find('a.rss').attr('href'), pageUrl) });
  });
  return out;
}

export interface LemmyCommunity {
  instance: string;
  name: string;
  title: string;
  nsfw: boolean;
  subscribers: number;
  suspicious: boolean;
}

/** Lemmyverse's community dump (data.lemmyverse.net). Entries without a home instance or name are dropped. */
export function parseLemmyverse(data: unknown): LemmyCommunity[] {
  if (!Array.isArray(data)) return [];
  const out: LemmyCommunity[] = [];
  for (const c of data as { baseurl?: string; name?: string; title?: string; nsfw?: boolean; isSuspicious?: boolean; counts?: { subscribers?: number } }[]) {
    const instance = String(c?.baseurl || '').toLowerCase();
    const name = String(c?.name || '');
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(instance) || !/^\w+$/.test(name)) continue;
    out.push({
      instance,
      name,
      title: String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 120) || name,
      nsfw: Boolean(c.nsfw),
      subscribers: Number(c.counts?.subscribers) || 0,
      suspicious: Boolean(c.isSuspicious),
    });
  }
  return out;
}

/**
 * One page of Discourse Discover (discover.discourse.org/latest.json): each topic
 * features a community. Returns the forums' base URLs and the next page, if any.
 */
export function parseDiscourseDirectory(data: unknown, pageUrl: string): { forums: { url: string; title: string; nsfw: boolean }[]; next?: string } {
  const list = (data as { topic_list?: { topics?: { title?: string; featured_link?: string | null; tags?: (string | { name?: string })[] }[]; more_topics_url?: string } })
    ?.topic_list;
  const forums: { url: string; title: string; nsfw: boolean }[] = [];
  for (const t of list?.topics || []) {
    const link = absolute(t.featured_link || undefined, pageUrl);
    if (!link) continue;
    const u = new URL(link);
    // A forum can live under a path (example.com/forum); cut off any page inside it.
    const path = u.pathname.replace(/\/(t|c|u|latest|categories)(\/.*)?$/, '').replace(/\/+$/, '');
    const tags = (t.tags || []).map((tag) => (typeof tag === 'string' ? tag : tag?.name || ''));
    forums.push({ url: `${u.origin}${path}`, title: (t.title || '').replace(/\s+/g, ' ').trim(), nsfw: tags.some((tag) => /nsfw|adult/i.test(tag)) });
  }
  // more_topics_url is the HTML route; the same route answers JSON with .json.
  const more = list?.more_topics_url;
  return { forums, next: more ? absolute(more.replace(/^\/latest(?=\?|$)/, '/latest.json'), pageUrl) : undefined };
}

export interface OpmlOutline {
  xmlUrl: string;
  htmlUrl?: string;
  title?: string;
  category?: string;
}

/** OPML 1.x / 2.0 subscription lists (`<outline xmlUrl="…">`), nested folders included. */
export function parseOpml(xml: string): OpmlOutline[] {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: OpmlOutline[] = [];
  const seen = new Set<string>();
  $('outline').each((_, el) => {
    const node = $(el);
    const rawXml = node.attr('xmlUrl') || node.attr('xmlurl') || node.attr('url');
    const xmlUrl = absolute(rawXml, 'https://x');
    if (!xmlUrl || seen.has(xmlUrl)) return;
    seen.add(xmlUrl);
    const htmlUrl = absolute(node.attr('htmlUrl') || node.attr('htmlurl'), xmlUrl);
    const title = htmlToText(node.attr('title') || node.attr('text') || '', 200) || undefined;
    const parent = node.parent('outline');
    const category = parent.length ? htmlToText(parent.attr('title') || parent.attr('text') || '', 80) || undefined : undefined;
    out.push({ xmlUrl, htmlUrl, title, category });
  });
  return out;
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Exports deep-index feeds as standard OPML 2.0 grouped by kind. */
export function exportOpml(sources: { url: string; site: string; title?: string | null; kind: DeepKind }[], docTitle = 'glogg Deep Index Subscriptions'): string {
  const byKind = new Map<DeepKind, typeof sources>();
  for (const s of sources) {
    if (s.kind === 'site') continue;
    const bucket = byKind.get(s.kind) ?? [];
    bucket.push(s);
    byKind.set(s.kind, bucket);
  }
  const groups: string[] = [];
  for (const [kind, items] of byKind.entries()) {
    const label = kind === 'blog' ? 'Small-Web Blogs' : kind === 'forum' ? 'Independent Forums' : 'Imageboard Catalogs';
    const rows = items.map((s) => {
      const text = escapeXmlAttr(s.title || s.site);
      const xmlUrl = escapeXmlAttr(s.url);
      const htmlUrl = escapeXmlAttr(`https://${s.site}/`);
      return `      <outline type="rss" text="${text}" title="${text}" xmlUrl="${xmlUrl}" htmlUrl="${htmlUrl}"/>`;
    });
    groups.push(`    <outline text="${label}" title="${label}">\n${rows.join('\n')}\n    </outline>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXmlAttr(docTitle)}</title>`,
    '  </head>',
    '  <body>',
    ...groups,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

