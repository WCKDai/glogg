# Operating a public glogg

The default `GLOGG_MODE=private` is the personal workbench: everyone with access can change its settings and run its tools. A shared password does **not** create separate users or administrator roles.

`GLOGG_MODE=public` is a separate, restricted search service. It offers search, source preferences, the reader, read-only Atlas views and the browser-local Saved library. The server denies profiles, integrations, downloads, plugins, research, service management, crawl controls and IPFS gateway access, regardless of the caller's origin or password. It does not load plugins or resume crawls on startup. Atlas directories must be prepared by an operator; public visitors do not trigger directory seeding.

Public POST searches retain supported ranking preferences but cannot choose upstream addresses or inherit the private instance's keys. SearXNG comes only from `SEARXNG_URL`. Private file indexers remain disabled. Open Library is disabled unless the operator sets `GLOGG_PUBLIC_OPENLIBRARY=1` after checking its [usage policy](https://openlibrary.org/developers/api), which discourages high-traffic backend use. A separate public data volume avoids exposing private Atlas content. Never point public mode at your personal data directory.

Public bodies are limited to 64 KiB, queries to 1,024 characters, and preference lists to 100 entries of 256 characters each. Invalid `GLOGG_MODE` values and public mode with `GLOGG_ALLOW_PRIVATE_FETCH=1` prevent startup. The existing private-mode input contracts remain unchanged.

## Local deployment preparation

The dedicated Compose file builds one application process and a private SearXNG service in the separate `glogg-public` Compose project. If a private instance is also running on the same host, set a distinct `GLOGG_PORT` for this project. Its memory and CPU limits are starting containment settings, not certified capacity for 50,000 daily users.

```sh
GLOGG_ALLOWED_HOSTS=glogg.example.com docker compose -f docker-compose.public.yml config --quiet
GLOGG_ALLOWED_HOSTS=glogg.example.com docker compose -f docker-compose.public.yml build
GLOGG_ALLOWED_HOSTS=glogg.example.com docker compose -f docker-compose.public.yml up -d
curl --fail http://127.0.0.1:4173/api/health
curl --fail http://127.0.0.1:4173/api/capabilities
```

The application port is published on loopback only. Adapt [the nginx example](../infra/nginx-public.conf) with your real hostname and certificates; run `nginx -t` before reloading it. The example overwrites forwarded-address headers at the internet-facing edge and limits per-address/global request rates, connections, upload size and timeouts. If another proxy sits in front, configure its trusted address explicitly and derive the real client address there. Do not trust arbitrary incoming forwarding headers. Set `GLOGG_TRUST_PROXY` to the actual proxy address/range seen by the container, not an unverified hop count.

Run one app process. Do not use `docker compose --scale glogg`, Node clustering, or multiple replicas sharing writable data. Profiles and plugin settings use whole-file writes; session revocations and caches are process-local. Multi-instance private authentication needs coordinated persistence and revocation before it can be supported. Do not mount a Docker/Podman socket in the public service.

Restrict egress to your intended backends and public network destinations as defense in depth. The reader resolves and validates each redirect hop once, then pins the connection to those approved addresses while retaining the original hostname for HTTP and TLS. It refuses mixed public/private DNS answers and checks cancellation after DNS settles. Public-mode route tests are not a substitute for a deployment security review.

## Work limits and overload

- `GLOGG_MAX_SEARCHES=32`: admitted searches, including their outstanding source and answer work after an early response or disconnect. Excess searches receive HTTP 503 and `Retry-After: 1` before streaming headers. No waiting queue is created. Shared cached source work is not cancelled when one visitor leaves.
- `GLOGG_MAX_API_REQUESTS=64`: HTTP requests being processed, including JSON body parsing. Authentication and public-route authorization run before parsing. Health and capabilities remain outside this HTTP limit.
- `GLOGG_MAX_FAVICONS=32`: distinct favicon producers. Requests for the same icon share work; disconnecting does not release a producer's slot early.
- `GLOGG_MAX_READERS=16`: reader operations, including DNS resolution that can outlive a disconnected request. The slot remains occupied until resolution, fetching and parsing settle; excess readers receive HTTP 503 with `Retry-After: 1`.
- `GLOGG_SHUTDOWN_MS=15000`: the executable's drain deadline. The public Compose file allows 30 seconds before container termination. Increase both coherently if you deliberately increase request deadlines.

Search connectors keep deadlines through body consumption and reject decoded bodies larger than 2 MB before parsing. Unused error bodies are cancelled. This bounds individual responses, not total process memory; retain the container memory limit and measure RSS. The result caches are process-local and bounded by entry count. Monitor successful searches, 503/429 counts, upstream refusal rates, process memory, CPU, and health latency. `GET /api/telemetry` exposes bounded, query-free latency quantiles, cache hit/coalesce counts, 503 rejections and per-connector outcomes (requiring `Authorization: Bearer <GLOGG_TELEMETRY_TOKEN>` with a >=16-character token in `GLOGG_MODE=public`). `/api/health` is a liveness probe, not proof that search providers are available.

## Capacity target: 50,000 daily active users

Include timely searches and media in the workload mix. Timely source caches expire within 60 seconds, so they reuse less upstream work than the ordinary ten-minute cache. Commons media discovery makes one metadata request for up to eight results, paced to at most one request per second per process, with refusal backoff. The image proxy caps bodies at 4 MiB, active producers at eight and retained cache bytes at 32 MiB; image traffic can consume substantial egress even when request latency is low. Video bytes travel directly from Commons after Play. The existing short search harness does not model this media workload or establish provider quota suitability.

Daily active users alone do not specify server capacity. For a provisional workload, assume ten searches per user per day and a tenfold peak: 500,000 searches/day, 5.79 searches/second on average, about 58 searches/second at peak. Both assumptions need real usage evidence. Browser late-refresh searches, reader requests, icons and other traffic are additional. Source fanout and upstream quotas can dominate before the app's CPU does.

Run the offline harness on an otherwise quiet machine:

```sh
npx tsx scripts/load-test.ts --scenario=warm --samples=5 --seconds=5 --rps=58 --output=.tmp/capacity/warm.json
npx tsx scripts/load-test.ts --scenario=cold --samples=5 --seconds=5 --rps=58 --output=.tmp/capacity/cold.json
npx tsx scripts/load-test.ts --scenario=slow --samples=5 --seconds=5 --rps=58 --output=.tmp/capacity/slow.json
npx tsx scripts/load-test.ts --scenario=overload --samples=5 --seconds=5 --rps=120 --output=.tmp/capacity/overload.json
```

The driver and server use separate processes. Each sample gets an isolated home and a fresh server, five warm-up searches, and the production HTTP/search/ranking code. Every upstream fetch, including localhost backends, is intercepted: eight Hacker News fixture results, empty 404 responses elsewhere, and controlled source latency. No live providers or customer data are load-tested. Reports include Node/OS/CPU, fixture description, configured limits, actual server mode, status counts, empty responses, successful-request latency, scheduled-arrival lag, health latency, peak RSS and event-loop delay. The generator has a finite in-flight cap; dropped requests are reported and fail the run.

Warm/cold experiments fail on overload, empty successful responses, unexpected statuses or network/health failures. Slow/overload scenarios permit explicit 503s but must still complete useful searches. Their accepted throughput must not be compared with an unlimited baseline without also comparing rejected traffic. `--root=/absolute/checkout` runs the same harness against another checkout for a same-machine baseline. The earlier private-only server is labelled `legacy-private` in results.

These short fixtures validate local behavior and overload containment. They do **not** establish real-provider latency, useful result quality at scale, CDN/proxy/TLS overhead, a long-term memory plateau, geographical latency, upstream permission, or 50,000-DAU production readiness. Before admitting public traffic, run a sustained soak on the intended host, set explicit latency/error/RSS budgets, validate allowed provider quotas, and test slow clients, disconnects, restart/drain and restore. Arrange high-volume upstream access; do not increase concurrency to evade provider limits.

## Update and rollback

Keep the previous image by immutable digest/tag and back up the public data volume using the [installation guide](install.md). Rehearse restore on a disposable volume before launch. For an update, drain incoming traffic, allow active requests to finish, replace the single instance, then check health, capabilities, search, Saved/source preferences, and denial of `/api/integrations` before routing traffic back.

This change introduces no database migration. Roll back application behavior by restoring the prior image; retain the separate public data volume. **Do not expose the older image publicly**: it does not implement `GLOGG_MODE=public`. Keep traffic blocked or behind administrator-only authentication until public protections are restored. The Saved library remains in each browser; exported JSON is a portable backup, and the application does not sync it to the server.
