import { fetchUpstream, readUpstreamJson } from './upstream.js';
import {
  analyzeQueryIntent,
  clip,
  computeQueryRelevance,
  CustomEndpointsConfig,
  htmlToText,
  RawSearchResult,
} from '../src/core/index.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GloggFediverse/0.3 (+https://github.com/WCKDai/glogg)';

async function fetchFast(url: string, timeoutMs = 3600): Promise<Response> {
  return await fetchUpstream(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
    },
  }, timeoutMs);
}

/**
 * 1. ATProtocol (Bluesky XRPC Public AppView: searchPosts + relevant searchActors)
 */
export async function searchAtProtocol(
  query: string,
  appViewBase = 'https://public.api.bsky.app'
): Promise<RawSearchResult[]> {
  try {
    const analysis = analyzeQueryIntent(query);
    const searchQ = analysis.keywordQuery || query;
    if (!searchQ.trim()) return [];

    const results: RawSearchResult[] = [];

    // 1a. Search actual ATProtocol posts first via app.bsky.feed.searchPosts.
    // The public AppView answers searchPosts with 403 Forbidden; api.bsky.app still answers it without
    // signing in (checked November 2026). Accounts are still looked up on the public one.
    const postsBase = /^https:\/\/public\.api\.bsky\.app\/?$/.test(appViewBase) ? 'https://api.bsky.app' : appViewBase;
    try {
      const postsUrl = `${postsBase}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(
        searchQ
      )}&limit=6`;
      const postsRes = await fetchFast(postsUrl, 3200);
      if (postsRes.ok) {
        const postsData = (await readUpstreamJson(postsRes)) as {
          posts?: Array<{
            uri: string;
            cid: string;
            author: { handle: string; displayName?: string };
            record?: { text?: string; createdAt?: string };
            embed?: {
              external?: { uri?: string; title?: string; description?: string };
            };
            likeCount?: number;
            repostCount?: number;
            replyCount?: number;
          }>;
        };

        for (const post of postsData.posts ?? []) {
          const text = post.record?.text?.replace(/\s+/g, ' ').trim() || '';
          if (!text && !post.embed?.external?.uri) continue;
          const rkey = post.uri.split('/').pop() || '';
          const webPostUrl = `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
          const extUri = post.embed?.external?.uri;
          const title =
            post.embed?.external?.title ||
            `[ATProto · @${post.author.handle}] ${text.slice(0, 82)}${text.length > 82 ? '…' : ''}`;
          const targetUrl = extUri && extUri.startsWith('http') ? extUri : webPostUrl;

          const rel = computeQueryRelevance(query, title, text, targetUrl);
          if (!rel.matchedAnchor || rel.relevanceScore < 45) continue;

          results.push({
            id: `atproto-post-${post.cid}`,
            title,
            url: targetUrl,
            snippet: `${clip(text, 240)} · AT-URI: ${post.uri}`,
            source: 'atproto',
            publishedAt: post.record?.createdAt,
            author: `@${post.author.handle}`,
            points: (post.likeCount ?? 0) + (post.repostCount ?? 0),
            commentsCount: post.replyCount,
            fediverse: {
              protocol: 'atproto',
              handleOrRoom: `@${post.author.handle}`,
              uri: post.uri,
              cidOrId: post.cid,
              instanceDomain: 'bsky.app',
              membersOrInteractions: (post.likeCount ?? 0) + (post.repostCount ?? 0),
            },
          });
        }
      }
    } catch {
      // ignore searchPosts error and fallback to actor check
    }

    // 1b. Search ATProtocol actors ONLY when the actor handle/name/bio strongly matches the query subject
    try {
      const actorUrl = `${appViewBase}/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(
        searchQ
      )}&limit=4`;
      const actorRes = await fetchFast(actorUrl, 3000);
      if (actorRes.ok) {
        const actorData = (await readUpstreamJson(actorRes)) as {
          actors?: Array<{
            did: string;
            handle: string;
            displayName?: string;
            description?: string;
            indexedAt?: string;
          }>;
        };

        const relevantActors = (actorData.actors ?? []).filter((actor) => {
          const title = `${actor.displayName || ''} ${actor.handle}`;
          const bio = actor.description || '';
          const rel = computeQueryRelevance(
            query,
            title,
            bio,
            `https://bsky.app/profile/${actor.handle}`
          );
          return rel.matchedAnchor && rel.relevanceScore >= 52;
        });

        for (const actor of relevantActors.slice(0, 2)) {
          results.push({
            id: `atproto-actor-${actor.did}`,
            title: `[ATProto @${actor.handle}] ${actor.displayName || actor.handle}`,
            url: `https://bsky.app/profile/${actor.handle}`,
            snippet: `${
              actor.description?.replace(/\s+/g, ' ').trim() || 'ATProtocol Identity / PDS Repository'
            } · DID: ${actor.did}`,
            source: 'atproto',
            publishedAt: actor.indexedAt,
            author: `@${actor.handle}`,
            fediverse: {
              protocol: 'atproto',
              handleOrRoom: `@${actor.handle}`,
              uri: `at://${actor.did}`,
              cidOrId: actor.did,
              instanceDomain: 'bsky.app',
            },
          });
        }
      }
    } catch {
      // the posts found so far still count when the account search fails or times out
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * 2. ActivityPub (Mastodon Public Timelines across mastodon.social, fosstodon.org, infosec.exchange)
 */
export async function searchActivityPubMastodon(
  query: string,
  uncensoredMode = false
): Promise<RawSearchResult[]> {
  try {
    const analysis = analyzeQueryIntent(query);
    const primaryTag = (analysis.anchorTokens[0] || analysis.coreKeywords[0] || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 32);
    if (!primaryTag || primaryTag.length < 3) return [];

    const instances = ['mastodon.social', 'fosstodon.org', 'infosec.exchange'];
    const responses = await Promise.all(
      instances.map(async (inst) => {
        try {
          const url = `https://${inst}/api/v1/timelines/tag/${encodeURIComponent(primaryTag)}?limit=4`;
          const res = await fetchFast(url, 3200);
          if (!res.ok) return [];
          const items = (await readUpstreamJson(res)) as Array<{
            id: string;
            url?: string | null;
            uri: string;
            created_at: string;
            sensitive?: boolean;
            content: string;
            favourites_count?: number;
            reblogs_count?: number;
            replies_count?: number;
            account: {
              acct: string;
              display_name?: string;
            };
            card?: {
              url?: string;
              title?: string;
              description?: string;
            };
          }>;

          if (!Array.isArray(items)) return [];

          const isWebLink = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);
          return items
            .filter((st) => uncensoredMode || !st.sensitive)
            // A status may have no url of its own (a remote post, say): link its uri, or leave it out.
            .filter((st) => isWebLink(st.url) || isWebLink(st.uri))
            .map((st) => {
              const plainContent = htmlToText(st.content);
              const handle = st.account.acct.includes('@')
                ? `@${st.account.acct}`
                : `@${st.account.acct}@${inst}`;
              const cardUrl = st.card?.url;
              const ownUrl = isWebLink(st.url) ? st.url : st.uri;

              return {
                id: `ap-${inst}-${st.id}`,
                title:
                  st.card?.title ||
                  `[ActivityPub ${handle}] ${plainContent.slice(0, 76)}${
                    plainContent.length > 76 ? '…' : ''
                  }`,
                url: isWebLink(cardUrl) ? cardUrl : ownUrl,
                snippet: `${clip(plainContent, 240)} · ActivityPub Actor: ${handle} (${
                  (st.favourites_count ?? 0) + (st.reblogs_count ?? 0)
                } boosts/favs)`,
                source: 'activitypub' as const,
                publishedAt: st.created_at,
                author: handle,
                points: (st.favourites_count ?? 0) + (st.reblogs_count ?? 0),
                commentsCount: st.replies_count,
                isNsfw: Boolean(st.sensitive),
                fediverse: {
                  protocol: 'activitypub' as const,
                  handleOrRoom: handle,
                  uri: st.uri || ownUrl,
                  cidOrId: st.id,
                  instanceDomain: inst,
                  membersOrInteractions: (st.favourites_count ?? 0) + (st.reblogs_count ?? 0),
                },
              };
            })
            .filter((item) => {
              const rel = computeQueryRelevance(query, item.title, item.snippet, item.url);
              return rel.matchedAnchor && rel.relevanceScore >= 44;
            });
        } catch {
          return [];
        }
      })
    );

    return responses.flat().slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * 3. Matrix Public Rooms Directory (matrix.org/_matrix/client/v3/publicRooms)
 */
type MatrixRoom = {
  room_id: string;
  canonical_alias?: string;
  name?: string;
  topic?: string;
  num_joined_members?: number;
};
/** The room directories of the last few homeservers asked, for five minutes each. */
const matrixRoomCache = new Map<string, { rooms: MatrixRoom[]; at: number }>();
const MATRIX_CACHE_SERVERS = 8;

export async function searchMatrixPublicRooms(
  query: string,
  homeserver = 'https://matrix.org'
): Promise<RawSearchResult[]> {
  try {
    const analysis = analyzeQueryIntent(query);
    const tokens = analysis.coreKeywords.filter((t) => t.length >= 3);
    if (tokens.length === 0) return [];

    const now = Date.now();
    let cached = matrixRoomCache.get(homeserver);
    if (!cached || now - cached.at > 5 * 60 * 1000) {
      const res = await fetchFast(`${homeserver}/_matrix/client/v3/publicRooms?limit=300`, 3600);
      if (res.ok) {
        const data = (await readUpstreamJson(res)) as {
          chunk?: MatrixRoom[];
        };
        if (Array.isArray(data.chunk)) {
          cached = { rooms: data.chunk, at: now };
          matrixRoomCache.delete(homeserver);
          if (matrixRoomCache.size >= MATRIX_CACHE_SERVERS) matrixRoomCache.delete(matrixRoomCache.keys().next().value as string);
          matrixRoomCache.set(homeserver, cached);
        }
      }
    }

    const rooms = cached?.rooms ?? [];
    const primaryAnchor = analysis.anchorTokens[0];

    const matched = rooms.filter((r) => {
      const titleAndAlias = `${r.name || ''} ${r.canonical_alias || ''}`.toLowerCase();
      const hay = `${titleAndAlias} ${r.topic || ''}`.toLowerCase();
      if (primaryAnchor && !hay.includes(primaryAnchor)) return false;
      const hits = tokens.filter((tk) => hay.includes(tk)).length;
      return hits >= Math.ceil(tokens.length * 0.6) && titleAndAlias.includes(primaryAnchor || tokens[0]);
    });

    matched.sort((a, b) => (b.num_joined_members ?? 0) - (a.num_joined_members ?? 0));

    return matched.slice(0, 5).map((room) => {
      const alias = room.canonical_alias || room.room_id;
      const matrixToUrl = `https://matrix.to/#/${encodeURIComponent(alias)}`;
      return {
        id: `matrix-${room.room_id}`,
        title: `[Matrix Room ${alias}] ${room.name || alias}`,
        url: matrixToUrl,
        snippet: `${
          clip(room.topic?.replace(/\s+/g, ' ').trim() ?? '', 230) || 'Public federated Matrix room'
        } · ${room.num_joined_members ?? 0} members · Room ID: ${room.room_id}`,
        source: 'matrix' as const,
        points: room.num_joined_members,
        fediverse: {
          protocol: 'matrix' as const,
          handleOrRoom: alias,
          uri: `matrix:r/${alias.replace(/^#/, '')}`,
          cidOrId: room.room_id,
          instanceDomain: 'matrix.org',
          membersOrInteractions: room.num_joined_members,
        },
      };
    });
  } catch {
    return [];
  }
}

/**
 * 4. Stoat (stoat.chat / Open-Source Decentralized Community & Self-Hosted Chat Ecosystem)
 */
const STOAT_ECOSYSTEM_INDEX: Array<{
  id: string;
  title: string;
  url: string;
  handle: string;
  description: string;
  tags: string[];
}> = [
  {
    id: 'stoat-core',
    title: 'Stoat (stoat.chat) — Open-Source Federated & Self-Hostable Chat Platform',
    url: 'https://stoat.chat/',
    handle: 'stoat.chat',
    description:
      'User-first, privacy-respecting open-source chat platform (formerly Revolt) with E2EE roadmap, custom self-hosted nodes, and zero corporate telemetry.',
    tags: ['stoat', 'revolt', 'chat', 'fediverse', 'selfhosted', 'open-source'],
  },
  {
    id: 'stoat-github',
    title: 'Stoat / Revolt Open-Source Protocol & Backend (Rust / MongoDB / WebSocket)',
    url: 'https://github.com/revoltchat',
    handle: 'github.com/revoltchat',
    description:
      'Source repositories for Stoat/Revolt backend daemon (delta), voice server (vortex), file server (autumn), and link proxy (january).',
    tags: ['stoat', 'revolt', 'rust', 'selfhosted', 'protocol', 'websocket'],
  },
  {
    id: 'stoat-selfhost',
    title: 'Stoat Self-Hosted Deployment Stack (Docker Compose & Federation Bridges)',
    url: 'https://github.com/revoltchat/self-hosted',
    handle: 'stoat.chat/self-hosted',
    description:
      'Deploy your own independent Stoat server node with Matrix/IRC/ActivityPub bridges and custom community discovery.',
    tags: ['stoat', 'revolt', 'docker', 'selfhosted', 'matrix', 'bridge'],
  },
];

export async function searchStoatEcosystem(query: string): Promise<RawSearchResult[]> {
  const analysis = analyzeQueryIntent(query);
  const tokens = analysis.coreKeywords.filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];

  const results: RawSearchResult[] = [];
  for (const item of STOAT_ECOSYSTEM_INDEX) {
    const rel = computeQueryRelevance(query, item.title, item.description, item.url, item.tags);
    if (rel.matchedAnchor && rel.relevanceScore >= 52) {
      results.push({
        id: item.id,
        title: `[Stoat] ${item.title}`,
        url: item.url,
        snippet: item.description,
        source: 'stoat',
        publishedAt: '2024-06-01',
        tags: item.tags,
        fediverse: {
          protocol: 'stoat',
          handleOrRoom: item.handle,
          uri: item.url,
          instanceDomain: 'stoat.chat',
        },
      });
    }
  }
  return results;
}

export async function executeFediverseSearch(
  query: string,
  uncensoredMode = false,
  endpoints?: CustomEndpointsConfig
): Promise<RawSearchResult[]> {
  const [atprotoItems, activityPubItems, matrixItems, stoatItems] = await Promise.all([
    searchAtProtocol(query, endpoints?.atprotoAppViewUrl),
    searchActivityPubMastodon(query, uncensoredMode),
    searchMatrixPublicRooms(query, endpoints?.matrixHomeserverUrl),
    searchStoatEcosystem(query),
  ]);

  return [...atprotoItems, ...activityPubItems, ...matrixItems, ...stoatItems];
}
