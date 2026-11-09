# Contributing to glogg (`glogg.app`)

Thank you for helping **unslop and deshittify the internet**. `glogg` is an open-source anti-slop meta-indexer, Fediverse explorer, P2P/DHT/Usenet workbench, self-hosted container orchestrator, deshittified page reader, and Manifest V3 browser extension.

## Project Architecture

```text
glogg/
├── src/
│   ├── core/                  # Pure TypeScript anti-slop engine (shared by server, client, CLI & extension)
│   │   ├── types.ts           # Canonical domain models, lenses, connectors, Fediverse & P2P schemas
│   │   ├── curatedLists.ts    # Slop registries, affiliate markers, AI clichés & Real-Web Atlas entries
│   │   ├── slopScorer.ts      # Multi-signal authenticity & slop heuristic scoring engine
│   │   ├── ranker.ts          # Domain-diversity enforcement, deduplication & P2P/Fediverse interleaving
│   │   ├── queryCompiler.ts   # Search query compiler & escape-hatch meta-URL synthesizer
│   │   ├── pageCleaner.ts     # HTML deshittifier, tracker stripper & primary-source citation extractor
│   │   └── p2pUtils.ts        # SHA-1/SHA-256 infohash validator, magnet URI builder & malware/stub detector
│   └── client/                # React 19 + Vite UI (Benji Taylor / shadcn/ui Dark & Light aesthetic)
├── server/
│   ├── index.ts               # Express 5 API + OpenSearch XML + IPFS gateway + Vite middleware
│   ├── federatedSearch.ts     # 20-connector parallel federated search orchestrator
│   ├── fediverseIndexer.ts    # Live ATProtocol (Bluesky), ActivityPub (Mastodon), Matrix & Stoat connectors
│   ├── p2pIndexer.ts          # Bitmagnet GraphQL, Public DHT, Internet Archive BT, NZBIndex & Torznab/Newznab
│   └── containerManager.ts    # Docker / Podman / Colima self-hosted container orchestrator
├── extension/                 # Manifest V3 Browser Extension (Google/DDG/Brave/Bing SERP de-slopper)
├── scripts/
│   ├── glogg-cli.ts           # Terminal CLI (`npm run cli -- search "linux"`)
│   └── build-extension.ts     # esbuild bundler for the Manifest V3 extension
├── infra/                     # Optional services stack (docker-compose.services.yml), SearXNG and Bitmagnet configs
├── Dockerfile                 # glogg's image: web app, API and deep index in one container
├── docker-compose.yml         # glogg with Docker Compose (+ a private SearXNG with --profile searxng)
├── docker-compose.coolify.yml # glogg on Coolify: HTTPS, generated password, nothing published
└── tests/                     # Vitest unit & integration test suites
```

## Development Workflow

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Start the full-stack development server**
   ```bash
   npm run dev
   ```
   Opens at `http://localhost:4173` with hot-reload for both server and client.

3. **Run the CLI**
   ```bash
   npm run cli -- search "sqlite wal"
   npm run cli -- inspect "https://danluu.com/"
   npm run cli -- containers status
   ```

4. **Run checks, tests, and builds before submitting a PR**
   ```bash
   npm run check
   npm test
   npm run build
   ```

## Adding New Real-Web Atlas Sites or Connectors

- **Curated Real-Web Atlas (`src/core/curatedLists.ts`)**: Add independent blogs, small-web search engines, Fediverse relays, FOIA archives, or P2P indexers to `CURATED_INDIE_INDEX`. Ensure sites are high-signal, non-slop, and accurately tagged.
- **Slop Domains & AI Phrase Patterns (`src/core/curatedLists.ts`)**: Add verified content mills to `DEFAULT_SLOP_DOMAINS` or new affiliate/AI-slop regex rules to `SEO_LISTICLE_PATTERNS` and `AI_SLOP_PHRASES`, accompanied by unit tests in `tests/`.
- **New Federated Connectors (`server/federatedSearch.ts`)**: Every upstream connector must use `fetchWithTimeout` with a strict timeout (`<= 4200ms`) and fail gracefully (returning `[]` on network error) so a single slow upstream never blocks the federated search response.

## Adding a tool

Tools are plugins. Start from [`plugins/_template/index.mjs`](./plugins/_template/index.mjs): copy it to `~/.glogg/plugins/<id>/` to try it without touching the repo, or to `plugins/<id>/index.ts` to ship it. Keep keys in `settings` with `secret: true`, return output as blocks, and add a test to `tests/pluginTools.test.ts` that runs it offline (stub the network or serve fixtures from a local server, as the website-testing tests do).

## Before you open a PR

```bash
npm run check && npm test && npm run build && npm run check:bundle
```

`npm test` needs no network. If you change ranking, add or update a golden in `tests/quality.test.ts`; if you touch a hot path, run `npm run test:perf` and keep it inside its budget.

