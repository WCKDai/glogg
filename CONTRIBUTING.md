# Contributing to glogg

Thanks for helping. Bug reports, new sources, plugins, docs fixes and design feedback are all welcome.

- **Questions and problems:** check [docs/troubleshooting.md](./docs/troubleshooting.md), then [open an issue](https://github.com/WCKDai/glogg/issues/new/choose).
- **Security problems:** privately, per [SECURITY.md](./SECURITY.md).
- **Conduct:** [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Set up

You need Node.js 22.13+ and git. Chrome or Chromium is optional (browser tests).

```bash
git clone https://github.com/WCKDai/glogg.git
cd glogg
npm install
npm run dev          # http://localhost:4173, server and client reload as you edit
```

## Where things are

```text
glogg/
├── src/
│   ├── core/              Pure TypeScript shared by server, client, CLI and extension
│   │   ├── types.ts           Domain types: results, scopes (lenses), sources
│   │   ├── searchSources.ts   Which sources each scope asks
│   │   ├── queryCompiler.ts   Operators (site:, -word, "phrase"), bangs, escape-hatch URLs
│   │   ├── queryIntelligence.ts  Query intent and keywords
│   │   ├── slopScorer.ts      Junk signals: SEO farms, affiliates, AI filler
│   │   ├── ranker.ts          Ranking, de-duplication, per-site limits
│   │   ├── curatedLists.ts    Known junk domains, phrases, the Atlas
│   │   ├── pageCleaner.ts     The clean reader: strips scripts, trackers, banners
│   │   ├── research.ts        Passage selection and citations for Research
│   │   ├── plugins.ts         The plugin contract (manifest, fields, output blocks)
│   │   └── p2pUtils.ts, bangs.ts, text.ts, browser.ts
│   └── client/            React 19 + Vite app
│       ├── App.tsx            Shell, routing, search state
│       ├── components/        Search box, results, reader, palette, Research panel…
│       └── views/             Atlas, Tools, Downloads, Services, Settings
├── server/
│   ├── index.ts           Express 5: API routes, OpenSearch, static assets, startup
│   ├── federatedSearch.ts Asks every source at once, deadlines, caching, streaming
│   ├── answerEngine.ts    Instant answers
│   ├── research.ts, ai.ts Research and BYOK model calls
│   ├── fediverseIndexer.ts, p2pIndexer.ts, wildWestIndexer.ts   Source connectors
│   ├── deep/              The deep index: directories, crawler, SQLite FTS5 store, blocklist
│   ├── plugins/           Plugin runtime and SDK
│   ├── downloadManager.ts Send: Offcloud, aria2, Nextcloud, local, plugins
│   ├── containerManager.ts  Docker/Podman services stack
│   ├── auth.ts, security.ts, publicFetch.ts   Password, request guard, SSRF-safe fetch
│   ├── lifecycle.ts, env.ts   Startup checks, clean shutdown, env parsing
│   └── net.ts, compress.ts, favicons.ts, profile.ts
├── plugins/               Built-in plugins, one folder each (_template is the starting point)
├── extension/             Manifest V3 browser extension
├── scripts/               CLI, extension build, bundle budget, services, icon generation
├── infra/                 Optional services stack and SearXNG/Bitmagnet configs
├── tests/                 Vitest suites; tests/e2e drives headless Chrome
└── docs/                  Install, usage, troubleshooting, plugins, API
```

## Common changes

**A new tool or integration.** Make it a plugin: see [docs/plugins.md](./docs/plugins.md). Copy [`plugins/_template`](./plugins/_template/index.mjs) to `plugins/<id>/index.ts`, keep keys in `settings` with `secret: true`, return output as blocks, and add an offline test to `tests/pluginTools.test.ts`.

**A new search source.** Add a connector next to the similar ones in `server/` and register it in `src/core/searchSources.ts`. It must use the shared timeout helpers, return `[]` on failure rather than throw, and report why it came back empty (refused, rate-limited, not set up) so the status bar can say so. Add a test with a fixture server in `tests/indexers.test.ts` or `tests/searchPipeline.test.ts`.

**Junk filtering.** Known content mills go in `DEFAULT_SLOP_DOMAINS`, patterns in `SEO_LISTICLE_PATTERNS` / `AI_SLOP_PHRASES` (`src/core/curatedLists.ts`). Add or update a golden in `tests/quality.test.ts`.

**The Atlas or the deep index.** Hand-picked sites go in `CURATED_INDIE_INDEX`; deep-index directories and verified boards/forums in `server/deep/sources.ts`.

## Before you open a pull request

```bash
npm run check && npm run build && npm test && npm run test:coverage && npm run test:e2e && npm run check:bundle
```

- `npm test` needs no network, and can't use it: a fetch to anything but this machine fails at once. Serve fixtures from a local server (`fixtureServer` in `tests/helpers.ts`) or stub `fetch`.
- For a bug, add the test that fails first.
- For anything that must hold for every input, add a property to `tests/properties.test.ts` (`forAll` from `tests/fuzz.ts`).
- Coverage has a floor in `vite.config.ts`: raise it when you add tests, never lower it to pass.
- If you touch a hot path, run `npm run test:perf` and keep it inside its budget.
- Update `CHANGELOG.md` under **Unreleased**, and the docs if behavior or settings change. New settings go in `.env.example` and `docker-compose.yml` (a test checks they match).

Keep pull requests focused: one change, with a description of what changed and how you checked it. CI runs the same commands on every pull request.

## Style

- TypeScript everywhere, strict mode. `npm run check` must pass.
- Small, pure functions in `src/core`; I/O in `server/`.
- User-facing text is plain and specific: say what happened and what to do about it.
- No new runtime dependencies without a good reason; the client bundle has a size budget (`npm run check:bundle`).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
