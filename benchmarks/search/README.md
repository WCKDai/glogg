# Search benchmark protocol

These experiments measure three different things. Keep their results separate.

## Judged offline ranking

```sh
npx tsx scripts/benchmark-search.ts --output=.tmp/search-quality.json
# Fail the command if any explicit case expectation fails:
npx tsx scripts/benchmark-search.ts --output=.tmp/search-quality.json --assert
```

`cases.json` is a versioned corpus with a fixed clock, synthetic provider candidates, and explicit judgments. Grades are 3 (directly useful), 2 (useful supporting material), 1 (related but insufficient), and 0 (irrelevant or violates the query). These provisional agent-authored labels need independent human review. They do not measure the quality of the entire live web or validate factual claims in a page. Glogg's own relevance and slop scores never serve as judgment labels.

The report records nDCG@5, useful-result precision among returned slots up to five, useful-candidate recall, first useful result's rank, and missing useful candidate IDs. Precision alone rewards a short page, so always read it with recall and returned counts. Empty output and ranking errors receive zero scores when useful candidates were available. Cases with no useful candidates report absent retrieval coverage, not a ranking success. Intent-only cases have no ranking metrics. Site/exclusion, expected first result and inclusion checks are reported independently.

Freeze the corpus and runner before measuring a code change. Preserve baseline JSON unchanged; write the candidate to a different file. Compare hashes before comparing scores. Improvements on this authored corpus are regression evidence, not an independent estimate of satisfaction or retention. Add failed real-world examples to the next corpus version with a written judgment, then rerun both revisions.

## Controlled HTTP latency

```sh
npx tsx scripts/benchmark-latency.ts --samples=5 --profile=all --output=.tmp/search-latency.json
```

Each sample uses a fresh process, a temporary home, a full unmeasured warmup, and one measured HTTP NDJSON request. All upstream fetches are intercepted, including localhost services. The cold profiles clear source/answer caches after draining warmup work; the warm profile retains them. Profile order rotates across repetitions. No requests go to real providers.

The four profiles are cold caches with an 80 ms core source, warm caches, a 900 ms answer source, and a 1,200 ms secondary source. The latter two check whether useful partial results arrive while slower work remains. Useful means one of eight explicitly identified fixture URLs. Report first nonempty results, first useful results, first partial, first useful partial and final completion separately. A missing partial stays null. The runner also records HTTP headers, response size, upstream calls, process CPU/RSS, event-loop delay, fixture/source hashes, runtime and hardware.

Use at least five repetitions on otherwise idle hardware. The nearest-rank p95 of five observations is the maximum observed sample, not a reliable population-tail estimate. Preserve raw samples and compare median, p95, range, failures and missing observations. This excludes process startup, browser rendering, TLS, real provider conditions, concurrent production load and capacity for 50,000 daily active users.

## Paced live observations

Live observations use only fixed author-selected queries, never visitor query logs. They must require an explicit target, stay serial and paced, and report provider failures, empty responses and timing as observations. Do not infer relevance from result counts or present one changing upstream snapshot as a controlled performance comparison.

## Change boundaries and rollback

Ranking changes affect the server's search, answer extraction and connector filtering, plus the browser/extension through shared core modules. Public API fields, filters, defaults, persistence and credentials are outside this pass. Run targeted lexical/ranking/freshness tests, then typecheck, build, unit tests, coverage, browser tests and bundle budgets. Run the same latency workload on the candidate with no other heavy checks in parallel.

The engineering kit is not installed in this repository; its `eng impact`, `eng verify` and `eng evidence verify` commands are unavailable. Use the repository commands above and record their actual results. Before deployment, build a clean commit into a new immutable image, check that artifact, retain the previous image/release and public volume, and verify public health, streaming, media and PWA assets after switching. Revert the application image if verification fails.
