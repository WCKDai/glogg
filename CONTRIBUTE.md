# Contribute to glogg

Welcome! We're glad you want to help make **glogg** better.

Full contributor documentation — including the repository architecture map, how to add search connectors, plugins, ranking improvements, and API routes — lives in [**`CONTRIBUTING.md`**](./CONTRIBUTING.md).

## Quick Start for Contributors

```bash
git clone https://github.com/WCKDai/glogg.git
cd glogg
npm install
npm run dev   # Starts Express + Vite with hot reload at http://localhost:4173
```

## Ways to Contribute

1. **Report SEO/AI Slop Domains or Submit Indie Sites:** [Open an issue](https://github.com/WCKDai/glogg/issues/new/choose) using the **Slop Report** or **Atlas Submission** template.
2. **Build a Plugin Tool:** Copy [`plugins/_template`](./plugins/_template/index.mjs) to `plugins/<your-tool>/index.ts` — see [`docs/plugins.md`](./docs/plugins.md).
3. **Improve Search Relevance, Speed, or Instant Answers:** Tune [`src/core/`](./src/core) or [`server/`](./server) and verify against the 31-case benchmark (`npm run benchmark:search`).
4. **Expand the Deep Index:** Contribute verified RSS/Atom/OPML directories, forums, or parser improvements in [`server/deep/`](./server/deep).
5. **Fix Bugs or Improve Accessibility & UI:** Every UI flow is tested offline in [`tests/ui.test.tsx`](./tests/ui.test.tsx), [`tests/views.test.tsx`](./tests/views.test.tsx), and headless Chrome ([`tests/e2e/`](./tests/e2e)).

## Pre-PR Checklist

Before submitting a pull request, run:

```bash
npm run check
npm run build
npm run benchmark:search
npm test
npm run test:coverage
npm run test:e2e
npm run check:bundle
```

- Read the full guide in [**`CONTRIBUTING.md`**](./CONTRIBUTING.md)
- Review our [**`CODE_OF_CONDUCT.md`**](./CODE_OF_CONDUCT.md)
- Report security issues privately via [**`SECURITY.md`**](./SECURITY.md)

All contributions are licensed under the [MIT License](./LICENSE).
