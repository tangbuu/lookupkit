# lookupkit

**A search + fetch + extract + rank backend for AI answering engines. It returns ranked, already-extracted passages — not a list of links — and it never calls an LLM.**

If you are building something in the shape of [Perplexica](https://github.com/ItzCrazyKns/Perplexica) or [Vane](https://github.com/ItzCrazyKns/Vane), you currently point `SEARXNG_API_URL` at a SearxNG instance, get back a list of links, and then re-implement the hard half yourself: fetch each page in a real browser, pull the readable content out of it, cut it down to something that fits a context window, and work out which of the five candidates actually answers the question. lookupkit is that hard half, as a service. It also sits directly on the search engines rather than behind a SearxNG middle-layer, which removes a failure mode that is [open in Vane right now](https://github.com/ItzCrazyKns/Vane/issues/763): when SearxNG's upstream engine answers with a CAPTCHA, the error propagates and the UI hangs (still reproducing as of a 2025-12-27 comment on that issue). Here, a blocked engine loses a race under a hard timeout and something else answers — a caller never sees it.

It deliberately stops before the LLM. No answer synthesis, no prompt, no API key. You get clean JSON and feed it to whatever model you want.

```
                                     ┌──────────────────────────── /search (fast path)
                                     │
query ──▶ search (raced engines) ──▶ URLs ──▶ fetch ×5 in parallel (Playwright)
                                                 │
                                                 ▶ extract (Readability ⇢ heuristic fallback)
                                                 ▶ condense (BM25, per line, to a token budget)
                                                 ▶ score (PhoRanker cross-encoder)
                                                 │
                                    first candidate ≥ 0.5 wins immediately ──▶ /lookup
```

---

## Quickstart

```bash
docker run --rm -p 8080:8080 --shm-size=1g ghcr.io/you/lookupkit:latest   # once published
# or, from a clone:
docker build -t lookupkit . && docker run --rm -p 8080:8080 --shm-size=1g lookupkit
```

```bash
curl -G --data-urlencode "q=what is the capital of Australia" localhost:8080/lookup
curl -G --data-urlencode "q=giá vàng SJC hôm nay"            localhost:8080/search
curl localhost:8080/healthz
```

`--shm-size=1g` matters: Chromium's default 64MB `/dev/shm` in a container shows up as tabs dying mid-navigation. `docker-compose.yml` sets it for you.

Running it directly instead:

```bash
npm ci && npx playwright install chromium && npm run build && npm start
```

---

## Endpoints

### `GET /search?q=...` — raw results, SearxNG-shaped

The cheap path: search engines only, no fetching. The response shape mirrors SearxNG's so you can point an existing `SEARXNG_API_URL` consumer here and see what happens.

```jsonc
{
  "query": "giá vàng SJC hôm nay",
  "number_of_results": 5,
  "results": [
    {
      "title": "Giá Vàng Online - CÔNG TY TNHH MTV VÀNG BẠC ĐÁ QUÝ SÀI GÒN - SJC",
      "url": "https://www.sjc.com.vn/gia-vang-online",
      "content": "CTY TNHH MTV VÀNG BẠC ĐÁ QUÝ SÀI GÒN - SJC Cập nhật lúc: …",
      "engine": "yahoo",
      "engines": ["yahoo"]
    }
  ],
  "answers": [], "corrections": [], "infoboxes": [], "suggestions": [],
  "unresponsive_engines": [],
  "lookupkit": { "ms": 1518, "engines": [{ "engine": "yahoo", "ms": 1517, "count": 5 }] }
}
```

`suggestions` is always empty — this scrapes result links, it does not reproduce an engine's query suggestions. Query parameters: `q` (required), `limit` (1–20, default 5).

### `GET /lookup?q=...` — the actual point of this project

Runs the whole pipeline and hands back a passage you can put straight into a prompt.

```jsonc
{
  "query": "what is the capital of Australia",
  "best": {
    "url": "https://www.worldatlas.com/articles/what-is-the-capital-of-australia.html",
    "title": "What Is The Capital Of Australia?",
    "passage": "What Is The Capital Of Australia?\nCanberra, Australia.\nAustralia is both a sub-continent and a country. … Canberra is the capital of the Federation of Australia and has been in place since 1913. …",
    "score": 0.9734,        // cross-encoder relevance, 0–1; null if reranking is off
    "extractor": "readability",
    "fetchMs": 3846
  },
  "candidates": [           // runners-up, best first, same shape as `best`
    { "url": "https://en.wikipedia.org/wiki/Canberra", "score": 0.004, "…": "…" }
  ],
  "confident": true,        // true = `best` crossed the threshold and we returned early
  "threshold": 0.5,
  "timings": {
    "totalMs": 6412,
    "searchMs": 2470,
    "engines": [{ "engine": "yahoo", "ms": 2470, "count": 5 }]
  },
  "rejected": [             // URLs that produced nothing usable, and why
    { "url": "https://www.vietcombank.com.vn/…", "reason": "net::ERR_HTTP2_PROTOCOL_ERROR" }
  ]
}
```

Returns `404` with `best: null` when nothing usable was found.

**Read `confident` before you trust `best`.** `true` means a candidate cleared 0.5 and the pipeline stopped early. `false` means everything finished and the highest scorer was returned anyway — sometimes that is a correct answer the model was unsure about, and sometimes every candidate was junk. `score` tells you which; see the Bing demonstration below for what "every candidate was junk" looks like.

### `GET /healthz`

`{"status":"ok","reranker":true,"engines":["yahoo"]}`.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `LOOKUPKIT_ENGINES` | `yahoo` | Comma-separated, raced in parallel. `yahoo`, `bing`, `duckduckgo`. |
| `LOOKUPKIT_MAX_URLS` | `5` | Candidates fetched in parallel per lookup |
| `LOOKUPKIT_TOKEN_BUDGET` | `200` | Approximate token budget for the condensed passage |
| `LOOKUPKIT_CONFIDENT_THRESHOLD` | `0.5` | Score at which the pipeline returns early |
| `LOOKUPKIT_RERANKER` | `1` | `0` skips the cross-encoder entirely (`score` becomes `null`) |
| `LOOKUPKIT_SEARCH_TIMEOUT_MS` | `8000` | Hard cap per engine |
| `LOOKUPKIT_FETCH_TIMEOUT_MS` | `8000` | Hard cap per candidate page |
| `LOOKUPKIT_EXCLUDED_DOMAINS` | `youtube.com,facebook.com` | Excluded via the `-site:` operator |
| `LOOKUPKIT_LOG_LEVEL` | `info` | `debug` logs every fetch and score |

Domains are excluded at the **engine** level with `-site:`, not filtered out of the results afterwards, so the engine backfills the slot with a different result instead of you simply losing one. YouTube extracts to recommended-video titles rather than an article; facebook.com serves an unauthenticated scraper a login wall with zero content.

---

## How it avoids the blocking problem

Scraping search engines is adversarial, and the honest version of this section is a table of what actually happened rather than a claim that it is solved.

**Engine survey**, measured 2026-09-15 from one residential IP with headless Chromium. Canary query `capital of Australia`, scored on whether the word "Canberra" appears anywhere in the rendered result page — a deliberately low bar that half the field still failed:

| Engine | Status | Time | Verdict |
| --- | --- | --- | --- |
| **Yahoo** | 200 | 1492 ms | **RELEVANT** — the only engine that passed |
| Bing | 200 | 613 ms | IRRELEVANT — *decoy results*, see below |
| DuckDuckGo (`html.` and `lite.`) | 403 | ~800 ms | blocked |
| Qwant | 200 | 2314 ms | no results in page |
| Mojeek | 200 | 1563 ms | altcha.org CAPTCHA widget |
| Startpage | 200 | 1098 ms | 22KB page, no results |
| Yandex | 200 | 2209 ms | no results in page |
| Ecosia | 403 | 788 ms | blocked |
| Brave | not attempted | — | see below |

Reproduce it with `node scripts/probe-engines2.mjs`. These results will change; re-measure rather than trusting this table.

Four things follow from it, and they are the whole design:

**1. Never let one engine's failure reach the caller.** Engines are raced in parallel under a hard timeout, and the first **non-empty** result set wins — not the first to *finish*, because a challenge-blocked engine answers fast and empty, and letting that win would hand you a blank page as if the web contained nothing. A blocked engine costs its own slot and nothing else. This is the structural difference from the SearxNG path in [Vane #763](https://github.com/ItzCrazyKns/Vane/issues/763): there is no code path here where an upstream CAPTCHA becomes your error or your hang.

The log pasted into that issue is worth reading next to the table above — the engine whose CAPTCHA hangs the UI is `searx.engines.duckduckgo`, raising `SearxEngineCaptchaException`. That is the same engine returning 403 in row three here. The difference is not that lookupkit gets past DuckDuckGo; it does not. The difference is what happens next.

**2. Bing does not block — it lies, and that is worse.** It answers 200 OK, echoes your query correctly in its own search box, and returns results for something else entirely: German model-railway forums for a Hanoi weather query, dictionary definitions of the word "capital" for *capital of Australia*. Any scraper whose health check is "did I get links back" accepts this silently and poisons everything downstream. It is implemented and selectable here, but it is not a default.

This is also the clearest demonstration of why the relevance gate exists. Running the full pipeline with `LOOKUPKIT_ENGINES=bing` against *what is the capital of Australia*:

```
confident: false   threshold: 0.5
best  0.0009  https://en.wikipedia.org/wiki/Ho_Chi_Minh_City
all candidate scores: [0.0009, 0.0009, 0.0009, 0.0002]
```

Four plausible-looking, entirely wrong pages, and every one of them scores three orders of magnitude below the threshold. A raw link list gives you no way to see that. A scored passage does.

**3. Talk to the endpoint that answers, not the one that redirects.** `duckduckgo.com/html` 302-redirects to `html.duckduckgo.com/html/`; going straight there saves a round trip (confirmed with `curl -D-`). DuckDuckGo is implemented and kept for exactly this reason — it is the endpoint worth having when it works — but it answered 403 to every request during this project's testing, including via POST, and the apex served a 418 block page.

**4. Brave is not here, on purpose.** It runs a proof-of-work challenge built specifically to stop scrapers ([search.brave.com/help/pow-captcha](https://search.brave.com/help/pow-captcha)). It is fast and works beautifully right up until it **permanently blocks the IP** — observed in the project this one is derived from after a single day of ordinary-volume use, after which every search returned zero results for good. That is not a rate limit you can back off from. Do not add it.

A plain HTTP client is not an option, incidentally: `curl` with a browser User-Agent to DuckDuckGo's HTML endpoint returned a 202 interstitial rather than results. The browser is load-bearing.

---

## Measured behaviour

All numbers below are from this implementation, measured on 2026-09-15 on an Apple Silicon laptop over a real residential connection. Nothing here is estimated or inherited.

### End-to-end `/lookup`, 15 real calls

`npx tsx scripts/bench.mts 3`

| Query | median | min | max | search | score | confident |
| --- | --- | --- | --- | --- | --- | --- |
| giá vàng SJC hôm nay | 4084 ms | 3368 | 4124 | 1093 ms | 0.963 | 3/3 |
| thời tiết Hà Nội ngày mai | 6841 ms | 6193 | 6956 | 1190 ms | 0.980 | 3/3 |
| tỷ giá USD hôm nay | 5762 ms | 5359 | 8389 | 1122 ms | 0.971 | 2/3 |
| what is the capital of Australia | 4936 ms | 4928 | 4937 | 1219 ms | 0.973 | 3/3 |
| who wrote the novel Dune | 4806 ms | 4347 | 5474 | 1701 ms | 0.682 | 3/3 |

**Overall: median 4937 ms, range 3368–8389 ms across all 15 calls.** Roughly 1.1–1.7 s of that is the search step; the rest is the slowest useful candidate page. `/search` alone runs 0.6–1.5 s.

Inside the container (`docker run`, same machine): `/lookup` 4.24 s for a Vietnamese query and 7.85 s for an English one, `/search` 1.52 s — the same ballpark, with Chromium taking 871 ms to launch at boot instead of ~100 ms.

### Fetch + extract, 9 real domains

`LOOKUPKIT_LOG_LEVEL=debug npx tsx scripts/probe-extract.mts`. "value-shaped numbers" counts runs of 3+ digits or grouped numbers like `146,500` — i.e. whether the page's actual *data* survived, not merely whether text came back.

| Domain | ms | chars | value-shaped numbers | tier |
| --- | --- | --- | --- | --- |
| sjc.com.vn/bieu-do-gia-vang | 2952 | 503 | 25 | readability |
| vnexpress.net/chu-de/gia-vang-1403 | 4027 | 5765 | 60 | **heuristic** |
| baomoi.com/tim-kiem/gia-vang.epi | 2301 | 1668 | 2 | **heuristic** |
| pnj.com.vn/site/gia-vang | 3916 | 1325 | 59 | readability |
| webgia.com/gia-vang/sjc/ | 4776 | 3945 | 56 | readability |
| giavang.org/ | 4656 | 5111 | 305 | readability |
| thoitiet.vn/ha-noi/ngay-mai | 5484 | 1250 | 10 | readability |
| 24h.com.vn/gia-vang-hom-nay-c425.html | 3734 | 4711 | 106 | readability |
| giavang.com.vn/gia-vang-sjc/ | 2030 | 2142 | 18 | readability |

9/9 returned usable content. Two points worth drawing out:

- **`sjc.com.vn/bieu-do-gia-vang` is the hard case** — a JS-rendered price grid. It comes back with all twelve branch rows intact and each label glued to its numbers: `Hồ Chí Minh 142,300+0 145,300+0`. That row-joining is not incidental; see "Two extractor tiers" below.
- **Two of nine fell through to the heuristic tier**, and both are listing pages — a newspaper topic index and a news aggregator's search results. Readability scores pages for "article-ness" and returns nothing for these. Deleting the fallback tier would silently lose them. `baomoi.com` showing only 2 numbers is correct, not a defect: it is a page of headlines, not prices.

`thoitiet.vn` returns real temperatures (`24.1°C / 25.1°C`, `1012 mb`) but splits them across lines, because the page lays its forecast out in a `<div>` grid rather than a table. The data is present; the line structure is poor.

### Cross-encoder scoring

`npx tsx scripts/probe-reranker.mts` — 7 hand-built pairs:

| Score | Pair |
| --- | --- |
| 0.9816 | weather query ↔ weather forecast with numbers |
| 0.9697 | gold-price query ↔ gold price with numbers |
| 0.9079 | English: *capital of France* ↔ Paris paragraph |
| 0.0545 | gold-price query ↔ weather forecast (off-topic) |
| 0.0090 | gold-price query ↔ site navigation chrome |
| 0.0011 | English: *capital of France* ↔ cookie-banner boilerplate |
| 0.0005 | gold-price query ↔ keyword-stuffed but answerless SEO text |

Good 0.91–0.98, junk 0.0005–0.055, with the threshold sitting in a very wide empty gap. Model load 212–289 ms; **17–23 ms per scored pair** on CPU.

The keyword-stuffed case at 0.0005 is the one that matters — that text repeats every query term and would score *well* on BM25 alone.

### Token budget: more context is not better

`npx tsx scripts/probe-budget.mts`, on `giavang.com.vn/gia-vang-sjc/`:

| budget | chars | score | price lines kept |
| --- | --- | --- | --- |
| 200 | 642 | **0.9439** | 0 |
| 300 | 976 | 0.8897 | 1 |
| 400 | 1311 | 0.3183 | 0 |
| 600 | 1357 | 0.0234 | 1 |
| 800 | 1357 | 0.0234 | 1 |

Raising the budget lets more boilerplate in and the relevance score **collapses by a factor of 40**. If you tune `LOOKUPKIT_TOKEN_BUDGET`, tune it down before you tune it up.

---

## How it works, and why

### Two extractor tiers, and why neither is optional

The page is loaded in Playwright, and then `page.content()` — the fully-rendered HTML after the page's own JavaScript has run — goes through `jsdom` + `@mozilla/readability` (the same pair Vane's `src/lib/scraper.ts` uses). Readability's `parse()` mutates the DOM it is handed, so it gets a clone, per Mozilla's own README. `charThreshold` is lowered from 500 to 200, because the default makes `parse()` return `null` on exactly the pages that need the most help: price and weather pages are mostly numbers and very little prose.

When Readability returns nothing or comes back materially thinner than a plain `p / table / h1-h6` sweep, the sweep wins. Measured above: 2 of 9 real domains, both listing pages.

Extracted text is **line-oriented**, and `<table>` rows are emitted one row per line. This is load-bearing rather than cosmetic: the condenser ranks per line, so if a row's cells land on separate lines, the label (`SJC`) parts company with its number (`146,500`), and a line containing only digits matches no query term and gets dropped — leaving you a passage of labels with no values.

### BM25, with a Unicode tokenizer

Condensing is BM25 (the `rank_bm25` `BM25Okapi` formulation, k1=1.5, b=0.75, including that library's `ln((N-n+0.5)/(n+0.5)+1)` IDF rather than the textbook one) applied per line, keeping the top lines that fit the budget and restoring their original document order so the result still reads as text.

The tokenizer is `[\p{L}\p{N}]+` with the `u` flag, not `\w`. In the Dart implementation this project is derived from, `\w` stayed ASCII-only even with a Unicode flag set, which shredded every Vietnamese diacritic word into 1–2 character fragments and produced matches between fragments — a query for `hôm nay có phim gì mới` once ranked an unrelated line top because both contained the fragment `m`. Node's regex engine handles `\p{L}` correctly, but `test/rank.test.ts` asserts it rather than assuming it.

### The cross-encoder gate

BM25 counts keyword overlap; a bi-encoder compares two independently-encoded vectors. Both are fooled by navigation chrome and SEO pages that repeat the query's words without answering it. A cross-encoder reads the query and the passage *together* in one pass, which is what lets it distinguish "mentions gold prices" from "states today's gold price". The 0.0005 row in the scoring table is that distinction.

The pipeline fetches all candidates in parallel and **returns the moment one crosses 0.5**, rather than waiting for the batch — the slowest candidate in a batch of five often costs several seconds alone. If none crosses it, the best-scoring candidate is returned with `confident: false` instead of an error, because the model has real false negatives and discarding a correct answer over one is worse than handing you a score you can judge yourself.

### Known limitations

- **BM25 can drop the answer while keeping the topic.** The clearest case is in the budget table above: for `giá vàng SJC hôm nay` on `giavang.com.vn`, prose *about* SJC gold (BM25 2.3–8.5) outranks the actual price rows (1.0), because those rows are labelled `VÀNG 1 LƯỢNG` rather than `SJC` and match only one query term. The passage scores 0.94 and reads well but contains no price. The cross-encoder only re-ranks whole candidate passages; it does not rescue individual lines BM25 discarded. A second cross-encoder pass at line level would fix this at roughly 20 ms × lines × candidates.
- **int8 quantization noise.** Mid-confidence scores can drift by roughly 0.1–0.4 from their fp32 values. Scores near 0 and 1 are robust, which is why the threshold sits in the middle of the gap rather than near either end.
- **PhoRanker is Vietnamese-first.** It is a PhoBERT fine-tune. English works well in testing (0.91 on a clean pair, 0.97 end-to-end on *capital of Australia*, 0.0011 on English junk), but Vietnamese is what it was trained for, and other languages are untested here.
- **One engine deep.** Yahoo is currently the only engine returning relevant results from the test IP. The racing architecture is built for several; today it usually races a field of one.
- **No caching, no rate limiting, no auth.** Put it behind something before exposing it.

---

## Development

```bash
npm ci
npx playwright install chromium
npm test          # 9 unit tests, no network
npm run typecheck
npm run lint
npm run dev       # tsx watch
```

`scripts/` holds the real-world probes used to produce every table above; they hit live sites, so run them deliberately rather than in a loop. `scripts/gen-tokenizer-fixture.mjs` regenerates the tokenizer parity fixture and is the only script needing a non-dependency (`npm i --no-save @xenova/transformers`).

**On the tokenizer:** transformers.js does load `itdainb/PhoRanker`'s tokenizer correctly out of the box — that was verified first. It was not kept, because it costs ~200MB of `node_modules` (including a second ONNX runtime) to run a BPE whose whole definition is four lines of `tokenizer.json`: whitespace pre-tokenizer, no normalizer, `</w>` end-of-word suffix, and a `<s> A </s></s> B </s>` pair template. `src/rank/phobertTokenizer.ts` implements those directly in ~80 lines and reads PhoRanker's own `tokenizer.json`; `test/tokenizer.test.ts` asserts its output is **bit-identical** to transformers.js across 8 cases covering Vietnamese diacritics, English, underscore-joined compounds, punctuation, numerics and truncation.

**Note on repository size:** the int8 model is a 136MB file committed directly to git. That is fine for a local clone and unpleasant for a public repository; consider `git lfs` or a release-asset download step before publishing.

---

## Acknowledgments

This project works as well as it does because of two pieces of other people's work:

- **[Mozilla Readability](https://github.com/mozilla/readability)** (Apache-2.0) — the content extraction algorithm behind Firefox's Reader Mode, and the reason 7 of 9 test domains extract cleanly without a single site-specific rule.
- **[PhoRanker](https://huggingface.co/itdainb/PhoRanker)** by `itdainb` (Apache-2.0) — the PhoBERT-based cross-encoder that does the relevance scoring, bundled here as an int8 ONNX export. Itself a fine-tune of [vinai/phobert-base-v2](https://huggingface.co/vinai/phobert-base-v2).

Also: [Playwright](https://playwright.dev/) (Apache-2.0), [jsdom](https://github.com/jsdom/jsdom) (MIT), [ONNX Runtime](https://onnxruntime.ai/) (MIT), and the `rank_bm25` [reference implementation](https://github.com/dorianbrown/rank_bm25) whose exact IDF formulation is ported here.

See [`NOTICE`](NOTICE) for full attribution.

## License

MIT — see [`LICENSE`](LICENSE). The bundled PhoRanker model and Mozilla Readability are Apache-2.0; see `NOTICE`.

---

*The name is a placeholder. Alternates considered: `passagekit`, `groundkit`, `retrievr`, `searchloop`, `answerless` (it returns everything but the answer, on purpose).*
