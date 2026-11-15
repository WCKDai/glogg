# glogg HTTP API

Everything the web app does goes through this API, so scripts can do it too. Request and response bodies are JSON unless noted.

On an open glogg (no password), `GET` on `/api/health`, `/api/capabilities`, `/api/sources`, `/api/search`, `/api/opensearch/suggest`, `/api/directory`, `/api/ipfs/:cid` and `/opensearch.xml` is public, with CORS `*`. Everything else, `POST /api/search` included, answers only glogg itself, local tools without an `Origin` header (curl, the CLI) and origins in `GLOGG_ALLOWED_ORIGINS` (list a browser extension there as `chrome-extension://<id>`). Paths are case-sensitive.

With `GLOGG_PASSWORD` set, every route except `/api/health` and the three `/api/auth` routes needs the session cookie from `POST /api/auth/login`, including the routes that are otherwise public. See [Security](../README.md#security).

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Liveness: `{status: "ok", …}` |
| `/api/telemetry` | `GET` | Bounded operational counters and latency quantiles (`{startedAt, searches, http, cache, latencyMs, sources}`) with no visitor query text, URLs or client addresses. Private by default; in public mode requires `Authorization: Bearer <GLOGG_TELEMETRY_TOKEN>`. |
| `/api/capabilities` | `GET` | `{mode, features}`: whether tools, research, downloads, administration and server profiles are available. Private by default; public mode disables these capabilities. |
| `/api/sources` | `GET` | `{sources}`: search task IDs, names, descriptions, categories and homepages. IDs match `config.disabledSources`. This is a catalogue, not a live availability probe. |
| `/api/auth` | `GET` | `{required, authenticated}`: whether this glogg has a password, and whether this request has a session |
| `/api/auth/login` | `POST` | `{password}` → `204` and the session cookie, `401` for a wrong password, `429` (with `Retry-After`) after ten wrong ones from one address |
| `/api/auth/logout` | `POST` | Signs this session out for good (it's revoked, not just forgotten by the browser) and clears the cookie |
| `/api/search` | `POST` / `GET` | Federated search: `{query, config?, compact?}` or `?q=…&lens=…&time=day\|week\|month\|year&uncensored=true`. `GET`, which any site may call on a glogg without a password, uses none of your keys or indexers (Torznab, Newznab and NZB.life put their key in every download link, and Brave charges per search); `POST`, which glogg's own pages use and other sites can't, uses them all. With `Accept: application/x-ndjson`, `POST` streams `{"type":"partial","response"}` (an early batch, `response.partial: true`) when the main sources answer first, then `{"type":"final","response"}`, or `{"type":"error","error"}`. `compact: true` trims hidden rows to what a list shows (at most 60; `metrics.filteredSlopCount` keeps the total). Big responses are compressed (brotli or gzip) when the request accepts it. `config` also takes `timeRange`, `pinnedDomains`, `boostedDomains` (raised), `loweredDomains`, `blockedDomains`, `blockedPhrases` and `disabledSources` (keys as in `metrics.sourceTimings`, which then shows them as `off`). A stored indexer key is only sent to the address it was saved with, so `config.endpoints` naming another indexer gets no key |
| `/api/opensearch/suggest` | `GET` | Search suggestions for browsers (`?q=`) |
| `/api/research` | `POST` | Research a query. Streams newline-delimited JSON events: `status`, `sources`, `delta`, `notice`, `done`, `error`. Body: `{query, candidates?, instantAnswer?, depth?, history?}` |
| `/api/inspect` | `POST` | Clean a URL or raw HTML for reading and pull out the primary sources it cites. URLs on private or local addresses are refused (`502`) unless `GLOGG_ALLOW_PRIVATE_FETCH=1`; at most 5 MB of a page is read |
| `/api/favicon/:domain` | `GET` | A site's icon, fetched by glogg and kept for a day (PNG, ICO, GIF, JPEG, WebP; no SVG). `404` when there is none, `400` for anything but a plain host name |
| `/api/media/image` | `GET` | A Wikimedia raster image specified by `url`. Exact HTTPS asset hosts and file paths only; no redirects, SVG or arbitrary URLs. `400` for unsupported URLs, `404` for unavailable/invalid/oversized images, `503` with `Retry-After` on overload. See media privacy below |
| `/api/directory` | `GET` | The hand-picked Atlas (`?category=…&shuffle=true`) |
| `/api/ipfs/:cid` | `GET` | Resolve an IPFS CID through the local Kubo gateway, with a public fallback |
| `/api/deep` | `GET` | Deep index status: posts, sources visited per kind, crawl state, size |
| `/api/deep/crawl` | `POST` | `{action: "start" \| "pause" \| "reseed"}` |
| `/api/deep/sites` | `GET` | The directory: `?kind=blog\|site\|board\|forum&origin=&q=&order=posts\|random\|name&offset=&limit=&nsfw=`. Returns `{total, items, counts, origins, errors, loading}`; the first call loads the open directories (it never crawls) |
| `/api/deep/sources` | `POST` | Add `{url, nsfw?, indexNow?}`; the kind (feed, Discourse forum, board catalog, page with a feed) is detected, and `indexNow: true` indexes its posts right away |
| `/api/deep/sources/:id` | `DELETE` | Remove a user-added source and its indexed posts |
| `/api/deep/opml` | `GET` / `POST` | Export feeds as OPML 2.0 (`?scope=user\|all&nsfw=`), or import feed outlines from `{xml, nsfw?}` |
| `/api/deep/random` | `GET` | A random indexed post (`?kind=&nsfw=`) |
| `/api/downloads` | `GET` / `POST` | List jobs (with live aria2/Offcloud progress), or queue `{url, title?, target?}` |
| `/api/downloads/:id` | `DELETE` | Remove a job (`finished` clears all finished jobs) |
| `/api/integrations` | `GET` / `PUT` | Read the masked integration settings, or save `{config}` |
| `/api/profile` | `GET` / `PUT` | The web app's settings saved on this glogg: `GET` returns `{savedAt, settings}` (`404` when none), `PUT {settings}` saves an object of at most 256 KB |
| `/api/plugins` | `GET` | Plugins with their tools and masked settings |
| `/api/plugins/reload` | `POST` | Re-scan the built-in and user plugin folders |
| `/api/plugins/:id/settings` | `PUT` | Save `{values}`; masked values are kept, empty values clear |
| `/api/plugins/:id/tools/:tool` | `POST` | Run a tool with `{input}`; returns `{blocks, summary?}` |
| `/api/plugins/:id/container` | `GET` / `POST` | A plugin's container status, or `{action: "up" \| "down" \| "remove"}` |
| `/api/containers` | `GET` | The optional services stack: Docker/Podman/Colima status and the 7 managed services |
| `/api/containers/action` | `POST` | `up`, `stop`, `restart`, `logs`, `stack-up`, `stack-down` or `start-daemon` (refused with `GLOGG_CONTAINER_RUNTIME=none`) |
| `/api/nodes` | `GET` | Reachability of the self-hosted services and upstream connectors |
| `/opensearch.xml` | `GET` | OpenSearch 1.1 descriptor, so a browser can use glogg as its search engine |

## How each source did

A search response's `metrics.sourceTimings` has one entry per source asked, keyed as in `config.disabledSources`: `{ms, count, status, note?, fetchedAt?, cacheAgeMs?}`. `fetchedAt` is when that connector's response finished, not the article's publication date. `cacheAgeMs` is its age when the search response was assembled; it can be nonzero even on the first request while other sources finish.

| `status` | Meaning |
| :--- | :--- |
| `ok` | Answered with `count` results in `ms` |
| `empty` | Answered, with nothing that matched |
| `late` | Hadn't answered by the deadline; it keeps running, and a repeat of the search picks it up |
| `error` | Failed with an error |
| `refused` | Turned glogg away: a rate limit, a bot check or captcha, a `403`. `note` says which, and when glogg asks again (as its `Retry-After` says, otherwise in five minutes); until then the source isn't asked |
| `unset` | Not set up: nothing answers at its address (SearXNG, say). `note` names the address |
| `resting` | Skipped: it hung or failed twice in a row, so it rests for five minutes |
| `off` | Turned off in `config.disabledSources` |

## Freshness and media search modes

The `raw-news` lens and inferred time-sensitive queries request recent results where providers support date filters. Explicit historical constraints remain historical; a product year does not cancel an explicit request for its latest updates. News requests use a one-day provider window; other changing-information requests use a month. Relevant recent results receive a bounded ranking bonus. Unknown, invalid and future dates receive no recency bonus.

These searches cap source cache lifetime at 60 seconds (or a shorter operator-configured lifetime), with request coalescing and existing provider throttling intact. `metrics.freshness` adds `{intent: "news" | "current", checkedAt, maxCacheAgeMs}`. The UI shows the check time and fetch age, not an inferred "cached" label based on speed. Providers can index late, refuse requests or lack coverage; this is not a real-time completeness guarantee. Time-sensitive queries omit generic cached fact cards; arithmetic still works. GDELT timestamps have `dateKind: "indexed"`, distinguishing discovery time from publication.

The `images` and `videos` lenses query only Wikimedia Commons. Results add optional `media` metadata: `kind`, `previewUrl`, `url`, `mimeType`, dimensions, duration, attribution and license fields. The normal result `url` stays the canonical source/credit page. Images and videos have distinct cache keys; unique assets survive the ordinary per-domain result limit. Source switches, domain/phrase rules and explicit date/adult preferences still apply. An unknown media creation date cannot satisfy a strict pre-LLM filter.

## Public mode and overload

`GLOGG_MODE=public` adds a server-side allowlist: search (GET/POST), source catalogue, capabilities, authentication, directory/Atlas reads, favicons, media images, reader (POST), health and the OpenSearch descriptor/suggestions. All other API operations return 403, including requests without Origin and authenticated visitors. Private mode remains the default. Public requests cannot select upstream endpoints or use stored private keys; the operator's `SEARXNG_URL` is used and private indexers are disabled. Open Library requires the operator's public-service opt-in. See [public hosting](public-service.md) for the exact limits and deployment requirements.

Search admission or HTTP capacity exhaustion returns 503 with `Retry-After: 1`, including NDJSON requests before stream headers. Clients should back off and offer retry; do not automatically retry without a delay. Source-level throttling remains visible in `metrics.sourceTimings` as a refusal. `/api/health` reports the catalogue connector count, not the number currently reachable.

### Media privacy and bounds

Image and video search use Wikimedia Commons metadata, with source, author and license links. Raster thumbnails and image previews use `/api/media/image`, so browsing results does not contact image hosts from the browser. The endpoint accepts only `upload.wikimedia.org` and `thumb.wikimedia.org` asset paths, verifies raster MIME and signatures, rejects redirects, and caps each response at 4 MiB, active producers at 8, and its shared memory cache at 32 MiB/256 entries. Requests for the same image share one producer. The deadline covers response bodies; oversized and invalid bodies are cancelled.

Video playback is an explicit exception to same-origin browsing: after the user presses Play, the browser connects directly to `upload.wikimedia.org`. Glogg does not proxy video bytes. The page uses `Referrer-Policy: no-referrer`; playback does not send credentials, and scripts, frames and other connections remain restricted. Native playback depends on codec support; the original Commons source remains available. Wikimedia documents modern mobile support from iOS 17.4 in [TimedMediaHandler](https://www.mediawiki.org/wiki/Extension:TimedMediaHandler#Client_support). These tabs search Commons, not the entire image/video web. Explicit terms in file names, descriptions and categories are marked for the existing adult-content preference; this metadata check is conservative and is not comprehensive SafeSearch.
