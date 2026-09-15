# Fix tracklist — from the pre-publish code review (2026-09-16)

Source: `lookupkit-review` agent pass. Delete this file (or fold into GitHub issues) once done and before publishing. Check items off as they land; report anything skipped and why.

## CRITICAL

- [ ] **SSRF via unvalidated `page.goto`** (`src/fetch/fetchPage.ts:31`, reached from `src/pipeline.ts:131`). Reject non-`http(s)` schemes; resolve hostname via DNS and reject private/loopback/link-local ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`, `0.0.0.0`); re-check on every redirect hop (DNS rebinding). Also strip `rejected[].reason` (`pipeline.ts:137`) to a coarse enum (`unreachable`/`timeout`/`thin-content`) instead of the raw network error, which currently acts as a port-scan oracle.
- [ ] **Unhandled promise rejection crashes the process** (`src/pipeline.ts:130`, `:160`, the `void (async () => {...})().finally(...)` pattern). Wrap the IIFE body in try/catch recording into `rejected`; add a `process.on('unhandledRejection')` handler that logs rather than lets the process die.

## HIGH

- [ ] **Cached-promise singletons latch failure permanently** (`src/fetch/browser.ts:68-93` `getBrowser`, `:188-214` `getSearchContext`, `src/rank/reranker.ts` `ensureRerankerLoaded`). Clear the memo on failure/disconnect (`starting = promise.catch(e => { starting = null; throw e; })` pattern) and add a `browser.on('disconnected')` handler resetting `browser`/`starting`.
- [ ] **No rate limiting / concurrency cap** (`src/server.ts:69-76`, `src/pipeline.ts:129`, `src/fetch/browser.ts:169`). Add a global semaphore around `withPage` sized to a concrete context budget (e.g. 10–16); a per-IP token bucket in `server.ts`; cancel losing candidates (`page.close()`/AbortSignal) once `finish()` fires in the early-return path instead of letting them run to their own timeout.
- [ ] **Timeouts not enforced on every browser operation** (`src/fetch/fetchPage.ts:31-37`, `src/fetch/browser.ts:169-183`). `ctx.setDefaultTimeout(config.fetchTimeoutMs)` right after `newContext()` in both `withPage` and `getSearchContext`; wrap `runLookup` in `Promise.race` against a total deadline; correct the README/config claims to match reality once fixed.
- [ ] **136MB ONNX blob makes the repo unpushable** (`models/phoranker_int8.onnx`, added in `5b086e2`). `git filter-repo --path models/phoranker_int8.onnx --invert-paths` then force-push the rewritten history (safe — repo has no remote yet, one branch). Add `scripts/fetch-model.mjs` with a pinned SHA-256 checksum, called from a Docker build layer (`RUN node scripts/fetch-model.mjs` before `COPY models`) so the image stays self-contained. Use a GitHub Release asset, not git-lfs (LFS free bandwidth is 1GB/month — exhausted after ~8 clones of a 130MB file).

## MEDIUM

- [ ] **Apache-2.0 §4(a) not satisfied** — no full license text ships, and the NOTICE's claim about where Readability's license text lives is wrong (`node_modules/@mozilla/readability/LICENSE.md` is a 553-byte header, not the full text). Add `LICENSE-APACHE-2.0.txt` (full verbatim text) at repo root; fix NOTICE to reference it for PhoRanker, Readability, and Playwright; `COPY` it into the Docker image since the image redistributes all three.
- [ ] **`deadHosts` regex is dead code under the WebKit default** (`src/pipeline.ts:52-53`, `:133-136`) — matches Chromium's `net::ERR_*` strings, but WebKit's actual error message is different (measured: `"A server with the specified hostname could not be found."`). Fix the match to be engine-agnostic, or delete the mechanism since it currently does nothing. If kept, add a TTL and size cap — right now a single transient DNS blip blacklists a domain forever.
- [ ] **`npm run lint` is broken** (`package.json`) — `--ext .ts` doesn't match `scripts/`'s `.mts`/`.mjs` files, ESLint 8 treats zero matches as fatal. Fix to `eslint src scripts test --ext .ts,.mts,.mjs` (confirmed clean when run this way). Add a minimal `.github/` CI workflow running typecheck/lint/test — nothing currently would have caught this.
- [ ] **Raw error messages leak Playwright call-log detail** (`src/server.ts:73`) — inconsistent with `fetchPage.ts:49`'s `.split('\n')[0]!`. Apply the same treatment, or better: log detail server-side, return a generic `{error, requestId}` to the caller.
- [ ] **No startup validation of `LOOKUPKIT_BROWSER`/`LOOKUPKIT_ENGINES`** (`src/config.ts:30`, `:36`) — an unchecked cast lets a typo silently produce a server that's healthy on `/healthz` but 500s on every real request forever (per the singleton-latch bug above). Validate at module load, `process.exit(1)` with a clear message on a bad value.
- [ ] **Log injection via unescaped query** (`src/server.ts:59`) — a query containing a percent-decoded newline can forge log lines. `JSON.stringify(q)` in the log template; also cap query length (currently unbounded beyond Node's 16KB header limit).

## LOW (batch these in if time allows)

- [ ] README's "No caching, no rate limiting, no auth" is stale — the speed pass added a one-entry search cache (`src/search/search.ts:82-99`). Update the doc (and once the rate-limit/auth items above land, update further).
- [ ] Stale Chromium-era comments: `src/fetch/browser.ts` doc for `withPage` ("Contexts are cheap in Chromium" — already partially fixed by the concurrency-measurement pass, verify it's fully updated); `docker-compose.yml:16`'s `shm_size` comment justifies it by Chromium's `/dev/shm` when the default is WebKit.
- [ ] `src/rank/bm25.ts:16` points at a nonexistent `test/tokenize.test.ts` — the real file is `test/rank.test.ts`.
- [ ] `package.json`'s `"playwright": "^1.50.0"` vs. the Dockerfile's hardcoded `v1.63.0-noble` with a "MUST match" comment — nothing enforces this. Pin the npm version exactly, or derive the Docker tag from the lockfile in CI.
- [ ] `src/rank/reranker.ts:62-63` — `logits[0]!` is `undefined` on an empty output tensor, producing a silent `NaN` that poisons the sort comparator. Guard with `Number.isFinite`.
- [ ] `src/server.ts:96-102` — shutdown doesn't force-exit if `closeBrowser()` hangs. Add `setTimeout(() => process.exit(1), 5000).unref()`.
- [ ] Missing `SECURITY.md` (matters given the SSRF surface — a reporting channel should exist before, not after, someone finds it), `CONTRIBUTING.md`.
- [ ] Zero test coverage on `server.ts`/`pipeline.ts`/`fetch/`/`search/` — at minimum, `extract.ts` and `failDetector.ts` are pure functions over HTML strings and are trivially testable offline; add basic tests.

## Open questions surfaced by review, worth a quick look but not confirmed bugs

- [ ] `route.abort()`/`route.continue()` returned from a non-async handler (`browser.ts:129-156`) could reject if the page closes mid-flight — verify against Playwright 1.63.0's actual behavior; add a defensive `.catch()` if warranted.
- [ ] `new URL(page.url())` at `browser.ts:153` — add a defensive try/catch even though no reachable failing case was found.
- [ ] `reranker.ts:63` assumes a single-logit sigmoid head — add `assert(logits.length === 1)` at load time to make this verified rather than inferred.
