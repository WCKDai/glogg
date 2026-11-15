import { fetchUpstream, readUpstreamJson, readUpstreamText } from './upstream.js';
import * as cheerio from 'cheerio';
import { analyzeQueryIntent, clip, htmlToText, RawSearchResult } from '../src/core/index.js';

function distillSearchQuery(query: string): string {
  const kw = analyzeQueryIntent(query).keywordQuery.trim();
  return kw || query.trim();
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 1900
): Promise<Response> {
  return await fetchUpstream(url, {
    ...options,

    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'application/json, text/html, */*',
      ...(options.headers || {}),
    },
  }, timeoutMs);
}

/** 4chan boards that aren't work-safe (`ws_board: 0` in a.4cdn.org/boards.json, checked 2026-11-09). */
const FOURCHAN_NSFW_BOARDS = new Set('aco b bant d e f gif h hc hm hr i ic pol r r9k s s4s soc t trash u wg y'.split(' '));

function stripHtmlTags(raw: string): string {
  return htmlToText(raw);
}

/**
 * 1. Live 4chan Catalog API (a.4cdn.org/{board}/catalog.json)
 * Searches active threads across /g/, /sci/, /diy/, /x/, /lit/, /his/, /vr/ (and 18+ boards when uncensored).
 */
export async function searchFourChanCatalogs(
  query: string,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  const q = distillSearchQuery(query).toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  const boards: string[] = ['g', 'sci', 'diy', 'x'];
  if (/\b(book|novel|philosophy|read|author|poem|kafka|dostoevsky)\b/i.test(q)) {
    boards.unshift('lit');
  }
  if (/\b(retro|dos|amiga|crt|ps1|ps2|snes|thinkpad|voodoo)\b/i.test(q)) {
    boards.unshift('vr');
  }
  if (/\b(crypto|bitcoin|monero|xmr|eth|stock|market|gold)\b/i.test(q)) {
    boards.unshift('biz');
  }
  const selectedBoards = Array.from(new Set(boards)).slice(0, 4);
  if (uncensoredMode) selectedBoards.push('pol', 'b');

  const boardBatch = await Promise.all(
    selectedBoards.map(async (board) => {
      try {
        const res = await fetchWithTimeout(
          `https://a.4cdn.org/${board}/catalog.json`,
          {},
          1600
        );
        if (!res.ok) return [];
        const pages = (await readUpstreamJson(res)) as {
          page: number;
          threads: {
            no: number;
            sub?: string;
            com?: string;
            time?: number;
            replies?: number;
            images?: number;
            name?: string;
          }[];
        }[];

        const matches: RawSearchResult[] = [];
        for (const page of pages || []) {
          for (const thread of page.threads || []) {
            const sub = stripHtmlTags(thread.sub || '');
            const com = stripHtmlTags(thread.com || '');
            const hay = `${sub} ${com}`.toLowerCase();
            const matchedCount = tokens.filter((t) => hay.includes(t)).length;
            if (matchedCount === 0) continue;
            if (tokens.length >= 2 && matchedCount < Math.ceil(tokens.length * 0.6)) {
              continue;
            }

            const title =
              sub ||
              (com.length > 72 ? `${com.slice(0, 72)}...` : com) ||
              `/${board}/ Thread #${thread.no}`;

            matches.push({
              title: `[/${board}/ #${thread.no}] ${title}`,
              url: `https://boards.4chan.org/${board}/thread/${thread.no}`,
              snippet: `${clip(com, 260)} · (${thread.replies ?? 0} replies, ${thread.images ?? 0} images on /${board}/)`,
              source: 'chanboards',
              publishedAt: thread.time
                ? new Date(thread.time * 1000).toISOString()
                : undefined,
              points: thread.replies ?? 0,
              commentsCount: thread.replies ?? 0,
              isNsfw: FOURCHAN_NSFW_BOARDS.has(board),
              tags: ['4chan', `/${board}/`, 'imageboard', 'wild-west'],
            });
          }
        }
        return matches.slice(0, 5);
      } catch {
        return [];
      }
    })
  );

  return boardBatch.flat().slice(0, 10);
}

/**
 * 2. FoolFuuka / Fuuka Chan Archives (Desuarchive, 4plebs, Warosu)
 * Searches permanent imageboard archives (/g/, /sci/, /x/, /tg/, /lit/, /diy/, /vr/).
 */
export async function searchChanArchives(
  query: string,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  const q = distillSearchQuery(query);
  if (!q) return [];

  const results: RawSearchResult[] = [];

  // A) Desuarchive JSON API (/g/, /sci/, /his/, /vr/, /k/, /m/)
  const desuPromise = (async () => {
    try {
      const res = await fetchWithTimeout(
        `https://desuarchive.org/_/api/chan/search/?text=${encodeURIComponent(q)}`,
        {},
        1800
      );
      if (!res.ok) return [];
      const data = (await readUpstreamJson(res)) as {
        0?: {
          posts?: {
            num?: string;
            thread_num?: string;
            board?: { shortname?: string; name?: string };
            title?: string | null;
            comment_processed?: string;
            comment?: string;
            timestamp?: number;
          }[];
        };
      };
      const posts = data?.[0]?.posts || [];
      return posts.slice(0, 6).map((p) => {
        const board = p.board?.shortname || 'g';
        const threadNum = p.thread_num || p.num || '';
        const cleanComment = stripHtmlTags(p.comment_processed || p.comment || '');
        const title =
          p.title?.trim() ||
          cleanComment.slice(0, 76) ||
          `Archived /${board}/ Thread #${threadNum}`;
        return {
          title: `[Desuarchive /${board}/] ${title}`,
          url: `https://desuarchive.org/${board}/thread/${threadNum}/#${p.num || threadNum}`,
          snippet: clip(cleanComment, 260) || `Archived /${board}/ imageboard post #${p.num}`,
          source: 'chanboards' as const,
          publishedAt: p.timestamp
            ? new Date(p.timestamp * 1000).toISOString()
            : undefined,
          isNsfw: FOURCHAN_NSFW_BOARDS.has(board),
          tags: ['desuarchive', `/${board}/`, 'chan-archive', 'wild-west'],
        };
      });
    } catch {
      return [];
    }
  })();

  // B) 4plebs JSON API (/x/, /tg/, /tv/, /hr/, /pol/)
  const plebsPromise = (async () => {
    try {
      const boardsParam = uncensoredMode ? '' : '&boards=x.tg.tv.adv.trv.sp.o';
      const res = await fetchWithTimeout(
        `https://archive.4plebs.org/_/api/chan/search/?text=${encodeURIComponent(q)}${boardsParam}`,
        {},
        1800
      );
      if (!res.ok) return [];
      const data = (await readUpstreamJson(res)) as {
        0?: {
          posts?: {
            num?: string;
            thread_num?: string;
            board?: { shortname?: string };
            title?: string | null;
            comment_processed?: string;
            comment?: string;
            timestamp?: number;
          }[];
        };
      };
      const posts = data?.[0]?.posts || [];
      return posts.slice(0, 5).map((p) => {
        const board = p.board?.shortname || 'x';
        const threadNum = p.thread_num || p.num || '';
        const cleanComment = stripHtmlTags(p.comment_processed || p.comment || '');
        const title =
          p.title?.trim() ||
          cleanComment.slice(0, 76) ||
          `4plebs /${board}/ Thread #${threadNum}`;
        return {
          title: `[4plebs /${board}/] ${title}`,
          url: `https://archive.4plebs.org/${board}/thread/${threadNum}/#${p.num || threadNum}`,
          snippet: cleanComment.slice(0, 260) || `Archived /${board}/ thread on 4plebs`,
          source: 'chanboards' as const,
          publishedAt: p.timestamp
            ? new Date(p.timestamp * 1000).toISOString()
            : undefined,
          isNsfw: FOURCHAN_NSFW_BOARDS.has(board),
          tags: ['4plebs', `/${board}/`, 'chan-archive', 'wild-west'],
        };
      });
    } catch {
      return [];
    }
  })();

  // C) Lainchan Cyberpunk & Tech Imageboard (lainchan.org/tech/catalog.json & /cyb/catalog.json)
  const lainchanPromise = (async () => {
    const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];
    try {
      const res = await fetchWithTimeout('https://lainchan.org/tech/catalog.json', {}, 1500);
      if (!res.ok) return [];
      const pages = (await readUpstreamJson(res)) as {
        threads?: {
          no: number;
          sub?: string;
          com?: string;
          time?: number;
          replies?: number;
        }[];
      }[];
      const hits: RawSearchResult[] = [];
      for (const page of pages || []) {
        for (const t of page.threads || []) {
          const sub = stripHtmlTags(t.sub || '');
          const com = stripHtmlTags(t.com || '');
          const hay = `${sub} ${com}`.toLowerCase();
          if (tokens.some((tok) => hay.includes(tok))) {
            hits.push({
              title: `[Lainchan /tech/] ${sub || com.slice(0, 68) || `Thread #${t.no}`}`,
              url: `https://lainchan.org/tech/res/${t.no}.html`,
              snippet: `${com.slice(0, 240)} · (${t.replies ?? 0} replies on lainchan.org/tech/)`,
              source: 'chanboards',
              publishedAt: t.time ? new Date(t.time * 1000).toISOString() : undefined,
              tags: ['lainchan', 'cyberpunk', 'imageboard', 'wild-west'],
            });
          }
        }
      }
      return hits.slice(0, 4);
    } catch {
      return [];
    }
  })();

  // D) b4k (/v/, /vg/, /vrpg/ …) and Palanq (/p/, /vt/, /bant/ …): boards the archives above don't keep.
  const [desu, plebs, lain, b4k, palanq] = await Promise.all([
    desuPromise,
    plebsPromise,
    lainchanPromise,
    searchFoolFuuka('arch.b4k.dev', 'b4k', q, 4),
    searchFoolFuuka('archive.palanq.win', 'Palanq', q, 4),
  ]);
  results.push(...desu, ...plebs, ...lain, ...b4k, ...palanq);
  return results;
}

/** One FoolFuuka archive's search API. Posts from 4chan's adult boards are marked 18+ and only shown in 18+ mode. */
async function searchFoolFuuka(host: string, label: string, q: string, max: number): Promise<RawSearchResult[]> {
  try {
    const res = await fetchWithTimeout(`https://${host}/_/api/chan/search/?text=${encodeURIComponent(q)}`, {}, 2000);
    if (!res.ok) return [];
    const data = (await readUpstreamJson(res)) as {
      0?: { posts?: { num?: string; thread_num?: string; board?: { shortname?: string }; title?: string | null; comment?: string; timestamp?: number }[] };
    };
    return (data?.[0]?.posts || []).slice(0, max).flatMap((p) => {
      const board = p.board?.shortname;
      const threadNum = p.thread_num || p.num;
      if (!board || !threadNum) return [];
      const comment = stripHtmlTags(p.comment || '');
      return [
        {
          title: `[${label} /${board}/] ${p.title?.trim() || comment.slice(0, 76) || `Thread #${threadNum}`}`,
          url: `https://${host}/${board}/thread/${threadNum}/#${p.num || threadNum}`,
          snippet: comment.slice(0, 260) || `Archived /${board}/ thread on ${label}`,
          source: 'chanboards' as const,
          publishedAt: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : undefined,
          isNsfw: FOURCHAN_NSFW_BOARDS.has(board),
          tags: [label.toLowerCase(), `/${board}/`, 'chan-archive', 'wild-west'],
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * 3. Obscure Forums, BBS Textfiles, Underground Zines & Old-Web Communities
 * Searches Lobste.rs, VOGONS, EEVblog, Doom9, LowEndTalk, ServeTheHome, Textfiles.com, Phrack, etc.
 */
export async function searchObscureForumsAndWildWest(
  query: string,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  const q = distillSearchQuery(query);
  if (!q) return [];

  // A) Lobste.rs practitioner community
  const lobstersPromise = (async (): Promise<RawSearchResult[]> => {
    try {
      const res = await fetchWithTimeout(
        `https://lobste.rs/search?q=${encodeURIComponent(q)}&what=stories&order=relevance`,
        {},
        1700
      );
      if (!res.ok) return [];
      const html = await readUpstreamText(res);
      const $ = cheerio.load(html);
      const items: RawSearchResult[] = [];
      $('li.story').each((idx, el) => {
        if (idx >= 6) return;
        const linkEl = $(el).find('.u-url').first();
        const title = linkEl.text().trim();
        const url = linkEl.attr('href')?.trim() || '';
        const commentsUrl = $(el).find('.comments_label a').attr('href') || '';
        const score = Number.parseInt($(el).find('.score').text().trim(), 10) || 0;
        const tags: string[] = [];
        $(el)
          .find('a.tag')
          .each((_, t) => {
            tags.push($(t).text().trim());
          });
        if (title && url.startsWith('http')) {
          items.push({
            title,
            url,
            snippet: `Lobste.rs discussion (${score} points)${tags.length ? ` · tags: ${tags.join(', ')}` : ''}${commentsUrl ? ` · https://lobste.rs${commentsUrl}` : ''}`,
            source: 'wild-west',
            points: score,
            tags: ['lobsters', ...tags],
          });
        }
      });
      return items;
    } catch {
      return [];
    }
  })();

  // B) Scoped Old-Web Forum & BBS / Zine Discovery via DuckDuckGo Lite HTML
  const scopedForumsPromise = (async (): Promise<RawSearchResult[]> => {
    const forumQuery = `${q} (site:vogons.org OR site:eevblog.com OR site:doom9.org OR site:lowendtalk.com OR site:servethehome.com OR site:level1techs.com OR site:textfiles.com OR site:phrack.org OR site:audiokarma.org OR site:overclock.net)`;
    try {
      const res = await fetchWithTimeout(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(forumQuery)}${uncensoredMode ? '&kp=-2' : ''}`,
        {},
        1900
      );
      if (!res.ok) return [];
      const html = await readUpstreamText(res);
      const $ = cheerio.load(html);
      const items: RawSearchResult[] = [];
      $('.result').each((idx, el) => {
        if (idx >= 8) return;
        const a = $(el).find('.result__a').first();
        const title = a.text().trim();
        let href = a.attr('href') || '';
        if (href.includes('uddg=')) {
          try {
            const u = new URL(href, 'https://duckduckgo.com');
            href = decodeURIComponent(u.searchParams.get('uddg') || href);
          } catch {
            // keep
          }
        }
        const snippet = $(el).find('.result__snippet').text().trim();
        if (title && href.startsWith('http')) {
          items.push({
            title,
            url: href,
            snippet: snippet || 'Independent practitioner forum / early-web archive thread.',
            source: 'wild-west',
            tags: ['obscure-forum', 'wild-west'],
          });
        }
      });
      return items;
    } catch {
      return [];
    }
  })();

  const [lobsters, forums] = await Promise.all([lobstersPromise, scopedForumsPromise]);
  return [...lobsters, ...forums];
}
