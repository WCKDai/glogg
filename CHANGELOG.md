# Changelog

All notable changes to **glogg** (`glogg.app`) are documented in this file.

## [Unreleased]

### Added
- **Docker.**
  - The Dockerfile builds one image with the web app, the API and the deep index. It runs as an unprivileged user, keeps data in `/data`, has a health check and never probes Docker or Podman.
  - `docker compose up -d` runs glogg on <http://localhost:4173>, with a private SearXNG via `--profile searxng`.
  - The container's filesystem is read-only except its data volume, it has no Linux capabilities, `no-new-privileges` is on, and the port is published on `127.0.0.1` only.
- **Coolify.** `docker-compose.coolify.yml` deploys glogg with a generated domain and HTTPS, a generated password, glogg answering only under its domain, no published ports and a private SearXNG.
- `GLOGG_CONTAINER_RUNTIME` (`auto`, `docker`, `podman`, `none`) for the Services page.
- `GLOGG_ALLOWED_HOSTS` accepts URLs as well as host names (Coolify's `SERVICE_FQDN_*` includes the scheme).
- `docs/api.md`, the full HTTP API reference.
- **More of the deep web in the deep index** (≈45,000 → ≈56,000 sources): imageboards on 2ch (in its own catalog format), leftypol, uboachan, sushigirl, kissu and more of wizchan; ≈9,800 Lemmy communities from Lemmyverse; ≈920 forums from Discourse Discover; 100 Stack Exchange sites; the XXIIVV webring. Every new board was crawled and a thread link from each opened.
- **b4k and Palanq** archives in chan search.
- Atlas: filter each tab by where its sources come from (Lemmy, Discourse, Stack Exchange …); mark a source you add as 18+ (in 18+ mode).
- A blocklist (`server/deep/blocklist.ts`) keeps sources that advertise sexual material involving minors, and posts using the jargon for trading it, out of the index in every mode. On the real directories (≈70,000 names) it blocks nothing else.
- **Deep index of the obscure web** (`server/deep/`): ≈43,000 small-web blogs (Kagi Small Web), ≈960 tiny sites (512KB Club), every 4chan board plus lainchan and wizchan, 34 forums (28 Discourse, VOGONS, VCFed, Raspberry Pi, Arch, Lobsters, Tildes) and any source you add. Opt-in, polite crawler; SQLite full-text index in `~/.glogg/deep.db`; searched on every query in milliseconds. New source types `deep-blogs`, `deep-boards`, `deep-forums`.
- **Atlas** lists all of it, not just the 39 hand-picked sites: tabs per kind, filter, random order, Surprise me, crawl controls, add-your-own-source with type detection.
- **Mwmbl** connector, and **live Discourse search** in the Forums scope.
- Optional Stack Exchange key (`STACKEXCHANGE_KEY` or Settings → Integrations).
- **Tools as plugins.** Each tool is a folder (`plugins/<id>/` built in, `~/.glogg/plugins/<id>/` yours) with settings, typed inputs, an optional `>trigger`, an optional container and an optional download hand-off. Built in: Real-Debrid, TorBox, Offcloud, Nextcloud, pCloud, NZB.life, SABnzbd, OSINT (8 tools), Website testing (8 tools), Utilities, and AI with your own key or a local model. A Tools page, `>trigger` runs from any search box, and a copyable template in `plugins/_template`.
- **Simple and Advanced views.** Advanced adds a rail (scope, sources, filters), ranking signals per result, and **Research**: reads the top pages and streams a cited answer from your model, or quotes the best passages without one. Follow-up questions keep context.
- **Status bar** with source health and timing; click for a per-source breakdown.
- **Start screen** with recent searches and quick-launch tools.
- Plugin download targets in every Send menu and in Downloads.
- API: `/api/research` (NDJSON), `/api/plugins`, `/api/plugins/reload`, `/api/plugins/:id/settings`, `/api/plugins/:id/tools/:tool`, `/api/plugins/:id/container`. `metrics.sourceTimings` in search responses.
- Test suites for quality goldens, research, the search pipeline, security, plugins, plugin tools, client logic, UI flows in jsdom, and speed budgets (`npm run test:perf`); a bundle-size budget in CI (`npm run check:bundle`).

### Changed
- **The README is rewritten:** what glogg does, installing with Docker Compose, Coolify or from source, configuration and security, with screenshots.
- **The optional services stack moved to `infra/docker-compose.services.yml`.**
  - The root `docker-compose.yml` now runs glogg itself.
  - `npm run docker:up` builds and starts glogg in Docker; `npm run services:up` starts the optional services.
  - Their admin and API ports now listen on `127.0.0.1` only: SearXNG, the Bitmagnet API, the IPFS API and gateway, aria2 RPC, Prowlarr, NZBHydra2 and Nextcloud. Before, they were open on every interface with default credentials. Peer-to-peer ports are unchanged.
- `tsx` is a runtime dependency: `npm start` runs it, so `npm ci --omit=dev && npm start` failed before.
- **18+ mode is switched on in Settings only, after a confirmation.** The one-click flame button in the header and the switch in the Advanced rail are gone, so a stray click can't turn it on. While it's on, an **18+** pill in the header turns it off with one click; the command palette offers "Turn 18+ off", or opens Settings to turn it on.
- **Requires Node 22.13+** (was 20): the deep index uses Node's built-in SQLite. Node 20 reached end of life in April 2026; CI already runs 22.
- **Outgoing connections are IPv4-first with the normal connect timeout.** Node's default gives each address a few hundred milliseconds and failed many parallel requests on networks without IPv6 (measured: 6–31 of 40); with this, 0–3. `GLOGG_HAPPY_EYEBALLS=1` restores Node's default.
- **New look ("Stein")**: colours sampled from the icon, tighter and denser layout, quicker motion, honours reduced motion.
- **The look, reworked as a tool rather than a landing page.**
  - Sections (Search, Tools, Atlas, Downloads, Services, Settings) sit in a labelled bar on the left, a tab bar on phones, in place of a row of unlabelled icons.
  - The search box sits in the same column on every page, and the home screen starts with it, not with a big logo.
  - Results are rows separated by hairlines rather than floating cards; only menus, the palette and toasts cast shadows.
  - All ten scopes fit on one line, and source filters scroll instead of wrapping.
  - Atlas's hand-picked sites are a dense list with short names.
  - A site with no icon (yet) shows its initial instead of a blank square.
- **System fonts.** The page no longer loads Inter and JetBrains Mono from Google Fonts, so opening glogg contacts no third party for fonts and paints sooner.
- **Plainer, truer copy.**
  - The answer card no longer claims "Verified Sources" or a "Synthesized Answer". Quotes from the top pages are labelled *From the top results*, with a grey bar instead of the blue one real answers get.
  - Hacker News, Lemmy and SearXNG results no longer show "Surfaced via…", "Shared on Fediverse…" or "[SearXNG via …]" boilerplate as their text, and that boilerplate no longer leaks into answers.
  - Lemmy posts in the deep index drop the "submitted by … N points | N comments" header Lemmy puts on every item.
  - "Search elsewhere" links use plain names ("Google", not "Google udm=14 (De-Slopped)").
  - Breadcrumbs skip bare ids and hashes.
- **Faster searches**: results return shortly after the main sources answer instead of waiting for the slowest; instant answers are looked up in parallel with the sources; per-source results are cached for 10 minutes (repeat searches and filter changes take milliseconds); sources that keep hanging rest for five minutes; slow sources are picked up shortly after the first results without reordering them. Typical warm search went from 3–5 s to about 0.5 s.
- **Better ranking**: synonyms for how-to queries (undo ⇄ reset/revert …), modifier words like "best" or "last" count less, official documentation and accepted Q&A answers rank higher for how-to questions, and filler phrases are caught with typographic apostrophes too.
- Marginalia moved to `api2.marginalia-search.com`; a personal key can be set in Settings → Integrations or `MARGINALIA_API_KEY`.
- The client bundle no longer includes the server-side page cleaner (−26 KB gzipped).

### Security
- **Password protection for glogg on a public address.**
  - Set `GLOGG_PASSWORD` (or `GLOGG_PASSWORD_FILE`) and every route except health and sign-in needs a session.
  - The session cookie is HttpOnly, SameSite=Strict, Secure over HTTPS and lasts 30 days. It's signed with a key derived from the password and a random secret in `$GLOGG_HOME/session.key`.
  - Sign-ins are rate-limited per address. A sign-in screen covers the app until you're in, and Settings has Sign out.
  - Off unless set: nothing changes for local use.
- `GLOGG_TRUST_PROXY` (default: private-network proxies only) and `HOST` (default `0.0.0.0`).
- Archive results from 4chan's adult boards (`/b/`, `/r9k/`, `/trash/` …, from 4chan's own `ws_board` flags) are now marked 18+ and hidden outside 18+ mode; before, only `/b/` and `/pol/` were.
- The local API now refuses requests from other websites and DNS-rebinding hosts, except a few public read-only routes (search, OpenSearch, suggestions, Atlas, health, IPFS lookup). Previously any site could call every route, including ones that use stored keys or start containers. Use `GLOGG_ALLOWED_HOSTS` / `GLOGG_ALLOWED_ORIGINS` for custom domains.

### Fixed
- A search could overrun its deadlines, or never finish when a core source hung: Node can fire a timer a millisecond before `Date.now()` shows its full delay, and the deadline check then missed. Each deadline now counts as reached when its own timer fires.
- Board catalogs over 1.5 MB (leftypol's) failed as "not a board catalog"; boards now get 8 MB.
- One site with thousands of feeds (a big Lemmy instance) could fill the crawler's whole batch and slow it to one request a second; sites that are waiting are now skipped when picking the next batch.
- A directory that failed to load was fetched again on every Atlas page load; it now waits ten minutes.
- Plugins failed to load under Vite-based runtimes because of a fractional cache-busting query; plugin load errors no longer show as "[object Object]".
- TorBox torrent uploads typecheck again.

## [0.3.0] — 2026-11-08

### Added
- **Fediverse Protocol Indexing (`server/fediverseIndexer.ts`)**:
  - Live **ATProtocol / Bluesky** connector (`public.api.bsky.app` XRPC actor discovery + author feed indexing).
  - Live **ActivityPub / Mastodon** federation connector across `mastodon.social`, `fosstodon.org`, and `infosec.exchange` + **Lemmy** (`lemmy.world`).
  - Live **Matrix** public room directory indexer (`matrix.org/_matrix/client/v3/publicRooms`).
  - Live **Stoat (`stoat.chat` / Revolt)** federated community chat indexer.
- **Self-Hosted Container Orchestrator (`server/containerManager.ts`, `docker-compose.yml`)**:
  - Native **Docker / Podman / Colima** runtime detection and one-click deployment for **Bitmagnet DHT**, **Kubo IPFS**, **SearXNG**, **Prowlarr**, **NZBHydra2**, and **Tor Proxy**.
- **Deep Archives, FOIA, OSINT & GDELT Raw World News**:
  - Live **GDELT Project v2 DOC API** connector (`gdelt-news`) for unfiltered global wire articles.
  - Live **Internet Archive Deep Texts & FOIA** connector (`archive-deep`) + curated OSINT & leak repositories (`DDoSecrets`, `Cryptome`, `The Black Vault`, `CourtListener RECAP`).
- **18+ Uncensored & Unfiltered Mode (`uncensoredMode`)**:
  - Unlocks adult `5xx` BitTorrent DHT infohashes, `alt.binaries.*erotica*` Usenet NZB releases, DuckDuckGo `kp=-2`, SearXNG `safesearch=0`, and NSFW Fediverse content when toggled on.
- **Benji Taylor / shadcn/ui Dark & Light UI (`src/client/`)**:
  - High-craft zinc/obsidian dark mode and crisp alabaster light mode with electric blue (`#3b82f6` / `#2563eb`) accents.
- **OpenSearch 1.1 & Terminal CLI (`scripts/glogg-cli.ts`)**:
  - `/opensearch.xml` and `/api/opensearch/suggest` so any browser can set `glogg.app` as its default search engine.
  - Full-featured terminal CLI (`npm run cli -- search | inspect | containers | atlas | rules | query-plan`).

## [0.2.0] — 2026-11-08

### Added
- **Bitmagnet DHT / BitTorrent Swarm & Usenet NZB Workbench (`server/p2pIndexer.ts`, `src/core/p2pUtils.ts`)**:
  - SHA-1 (40-hex) and BitTorrent v2 SHA-256 (64-hex) infohash validation, tracker-injected magnet URI builder, and `.exe`/stub malware detection.
- **Marginalia, Wiby & OpenAlex Connectors**:
  - Live integration with Marginalia Small-Web API, Wiby Handmade Web API, and OpenAlex 250M+ scholarly works.

## [0.1.0] — 2026-11-08

### Added
- Initial anti-slop heuristic scoring engine (`src/core/slopScorer.ts`), domain diversity ranker (`src/core/ranker.ts`), HTML deshittifier & primary source citation extractor (`src/core/pageCleaner.ts`), and Manifest V3 browser extension (`extension/`).
