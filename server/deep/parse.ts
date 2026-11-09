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

export function htmlToText(html: string, max = SUMMARY_MAX): string {
  if (!html) return '';
  const text = cheerio
    .load(`<div>${html.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h\d)>/gi, ' ')}</div>`)
    .text()
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}

function toTime(value?: string): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? t : undefined;
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

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
      summary: htmlToText(i.children('description').first().text() || i.children('content\\:encoded').first().text()),
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
  for (const it of f?.items || []) {
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

/**
 * 4chan-API catalogs (4chan, vichan, lainchan): `[{page, threads: [...]}]`.
 * Text only. Pinned rules threads are skipped.
 */
export function parseChanCatalog(data: unknown, threadUrl: (no: number) => string): DeepPost[] {
  if (!Array.isArray(data)) return [];
  const out: DeepPost[] = [];
  for (const page of data as { threads?: ChanThread[] }[]) {
    for (const t of page?.threads || []) {
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
