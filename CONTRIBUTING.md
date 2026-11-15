# Contributing to glogg

Thank you for contributing to **glogg**! Whether you are reporting a content farm, submitting an independent site to the Atlas, adding a search connector or plugin, improving ranking quality, or fixing a bug, your help is very welcome.

- **Troubleshooting first:** check [`docs/troubleshooting.md`](./docs/troubleshooting.md).
- **Bugs, feature ideas, slop domains & Atlas sites:** [open an issue](https://github.com/WCKDai/glogg/issues/new/choose).
- **Design questions & open-ended ideas:** start a thread in [GitHub Discussions](https://github.com/WCKDai/glogg/discussions).
- **Security vulnerabilities:** report **privately** per [`SECURITY.md`](./SECURITY.md) — never in a public issue.
- **Code of Conduct:** [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Quick Setup

Requires **Node.js 22.13+** (uses Node's built-in `node:sqlite`) and `git`. Chrome or Chromium is optional and used only for `npm run test:e2e`.

```bash
git clone https://github.com/WCKDai/glogg.git
cd glogg
npm install
npm run dev          # http://localhost:4173 — hot reloads server & React client
```

## Project Map

```text
glogg/
├── src/
│   ├── core/              Pure TypeScript shared by server, client, CLI & MV3 extension
│   │   ├── types.ts           Domain types: results, scopes (lenses), time ranges, answers
│   │   ├── searchSources.ts   Source registry and scope-to-connector mapping
│   │   ├── queryCompiler.ts   Operators (site:, -word, "phrase"), bangs & Unicode tokenizing
│   │   ├── queryIntelligence.ts  Query intent, anchor weights & instant computations
│   │   ├── slopScorer.ts      Anti-slop heuristics: SEO mills, affiliates, primary-source signals
│   │   ├── ranker.ts          Scoring, deduplication, domain caps, freshness & time-range filter
│   │   ├── freshness.ts       Timely-query detection & date-aware ranking adjustments
│   │   ├── media.ts           Commons media normalization & license attribution helpers
│   │   ├── curatedLists.ts    Slop/monoculture/boosted domain lists & hand-picked Atlas entries
│   │   ├── pageCleaner.ts     Server-only clean reader HTML stripper (uses cheerio)
│   │   ├── research.ts        Passage extraction & citation numbering for Research
│   │   ├── plugins.ts         Plugin manifest, field & output-block types
│   │   └── browser.ts         Client-safe barrel (excludes pageCleaner/cheerio)
│   └── client/            React 19 + Vite single-chunk web application
│       ├── App.tsx            Shell, URL state, streaming NDJSON search & keyboard navigation
│       ├── components/        SearchBox, Results, ReaderSheet, CommandPalette, AdvancedRail, Media…
│       └── views/             AtlasView, ToolsView, DownloadsView, ServicesView, SavedView, SourcesView, SettingsView
├── server/
│   ├── index.ts           Express 5 HTTP routes, OpenSearch, static assets & graceful startup
│   ├── serviceMode.ts     private vs public mode capability & route policy enforcement
│   ├── federatedSearch.ts Parallel connector fanout, grace timers, caching & NDJSON streaming
│   ├── answerEngine.ts    Instant computations, Stack Exchange accepted answers & Wikipedia extracts
│   ├── mediaSearch.ts     Wikimedia Commons image/video search & bounded raster image proxy
│   ├── research.ts, ai.ts Cited Research synthesis & streaming BYOK LLM client
│   ├── deep/              SQLite FTS5 deep index: directory parsers, OPML, polite crawler & blocklist
│   ├── plugins/           Plugin loader, settings store (0600) & tool runner
│   ├── auth.ts, security.ts, publicFetch.ts  Session auth, Host/CORS guard & DNS-pinned SSRF guard
│   └── telemetry.ts, lifecycle.ts, env.ts, net.ts, compress.ts, favicons.ts
├── plugins/               Built-in plugins (copy plugins/_template to build a new one)
├── extension/             Standalone Manifest V3 anti-slop browser extension
├── benchmarks/search/     31 offline judged search cases (NDCG@5, useful recall & slop rate)
├── scripts/               glogg CLI, PWA & extension builders, bundle budget & benchmark harnesses
├── infra/                 Optional companion Compose stack, SearXNG config & public nginx template
├── tests/                 Hermetic Vitest unit, API, fuzz/property, speed & headless Chrome e2e suites
└── docs/                  Install, usage, public-service, plugin SDK, troubleshooting & API docs
```

## Common Contributions

### 1. Adding a tool or service integration (Plugin)
Build it as a plugin — no React or CSS changes needed! Read [`docs/plugins.md`](./docs/plugins.md), copy [`plugins/_template`](./plugins/_template/index.mjs) to `plugins/<id>/index.ts`, mark API keys with `secret: true`, return structured output blocks (`kv`, `table`, `code`, `checklist`, `actions`), and add offline fixture tests in [`tests/pluginTools.test.ts`](./tests/pluginTools.test.ts).

### 2. Adding a search connector
Add a connector alongside similar ones in `server/` and register its metadata in [`src/core/searchSources.ts`](./src/core/searchSources.ts). Connectors must:
- Honor the caller's `AbortSignal` and shared byte/timeout budgets;
- Never throw on upstream errors — return `[]` and record refusal/rate-limit status so the UI status bar explains what happened;
- Decode HTML entities with `htmlToText` (`src/core/text.ts`);
- Include offline tests using `fixtureServer` (`tests/helpers.ts`) in `tests/indexers.test.ts` or `tests/searchPipeline.test.ts`.

### 3. Improving ranking, anti-slop rules, or instant answers
- Known content farms belong in `DEFAULT_SLOP_DOMAINS`, listicle/AI patterns in [`src/core/curatedLists.ts`](./src/core/curatedLists.ts), and scoring heuristics in [`src/core/slopScorer.ts`](./src/core/slopScorer.ts) / [`src/core/ranker.ts`](./src/core/ranker.ts).
- Always run `npm run benchmark:search` to verify that `meanNDCGAt5`, `meanUsefulRecall`, and `meanSlopRate` across [`benchmarks/search/cases.json`](./benchmarks/search/cases.json) improve or hold steady, and add regression cases to [`tests/quality.test.ts`](./tests/quality.test.ts).
- Keep server-heavy modules out of the browser bundle! Check [`src/core/browser.ts`](./src/core/browser.ts) and verify `npm run build:client && npm run check:bundle` stays within **125 KB JS / 16 KB CSS** gzipped.

### 4. Expanding the Atlas or Deep Index
- Hand-picked independent sites go in `CURATED_INDIE_DIRECTORY` ([`src/core/curatedLists.ts`](./src/core/curatedLists.ts)).
- Verified open directories, forums, and imageboards go in [`server/deep/sources.ts`](./server/deep/sources.ts).

### 5. Changing HTTP routes or environment variables
- [`tests/api.test.ts`](./tests/api.test.ts) enforces 1:1 parity between Express routes, [`docs/api.md`](./docs/api.md), and the contract table. Update all three together.
- [`tests/docker.test.ts`](./tests/docker.test.ts) enforces parity between `# VAR=` entries in [`.env.example`](./.env.example) and [`docker-compose.yml`](./docker-compose.yml).

## Verification Before Opening a PR

Run the full local gate (identical to GitHub Actions CI):

```bash
npm run check && npm run build && npm run benchmark:search && npm test && npm run test:coverage && npm run test:e2e && npm run check:bundle
```

- **100% offline tests:** `tests/setup.ts` rejects any fetch outside `127.0.0.1` / `localhost`. Stub `fetch` or use `fixtureServer` from `tests/helpers.ts`.
- **Property-based fuzzing:** invariants that must hold for arbitrary hostile input belong in [`tests/properties.test.ts`](./tests/properties.test.ts) (`forAll` in `tests/fuzz.ts`).
- **Coverage & bundle floors:** never lower thresholds in `vite.config.ts` or budgets in `scripts/check-bundle.ts` to make a build pass.
- **Changelog:** summarize user-visible changes under `## [Unreleased]` in [`CHANGELOG.md`](./CHANGELOG.md).

## Code Style & Principles

- **Strict TypeScript** everywhere (`npm run check` must pass with zero warnings/errors).
- **Pure core, explicit I/O:** keep `src/core/` deterministic and free of Node/DOM globals; keep network/disk/process work in `server/`.
- **Plain, honest copy:** tell the user specifically what happened and what action they can take; never label an unverified snippet as a verified fact.
- **Minimal dependencies & zero telemetry:** avoid adding runtime dependencies unless essential, and never introduce third-party browser requests or analytics.

## License

By contributing to glogg, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
