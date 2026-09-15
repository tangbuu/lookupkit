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

`--shm-size=1g` matters if you switch to Chromium: its default 64MB `/dev/shm` in a container shows up as tabs dying mid-navigation. `docker-compose.yml` sets it for you.

Running it directly instead:

```bash
npm ci && npx playwright install webkit && npm run build && npm start
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

`{"status":"ok","reranker":true,"engines":["duckduckgo","yahoo"]}`.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `LOOKUPKIT_BROWSER` | `webkit` | `webkit`, `firefox` or `chromium`. Read the finding below before changing it. |
| `LOOKUPKIT_ENGINES` | `duckduckgo,yahoo` | Comma-separated, raced in parallel. `duckduckgo`, `yahoo`, `bing`. |
| `LOOKUPKIT_USER_AGENT` | *(empty)* | Empty sends the engine's own UA. Spoofing Chrome from WebKit is a detectable inconsistency and gained nothing in testing. |
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

### The single most important finding: use WebKit, not Chromium

This project originally defaulted to Playwright's Chromium and concluded that most of the search engine field was hostile. That conclusion was wrong, and the way it was wrong is the most useful thing here.

Controlled test — same IP, same minute, same URLs, same headers, varying **only** the browser engine (`node scripts/probe-webkit-ddg.mjs`):

| Engine | `html.duckduckgo.com` | `lite.duckduckgo.com` | results | "Canberra" present |
| --- | --- | --- | --- | --- |
| **chromium** | **403** | **403** | 0 | no |
| **webkit** | **200** | **200** | 10–14 | **yes** |
| **firefox** | **200** | **200** | 10–14 | **yes** |

DuckDuckGo's block is a **headless-Chromium fingerprint block**, not an IP or rate-limit block. The same address pulled real results through the other two engines seconds later. Spoofing a Chrome user agent does not help and makes things worse: Chromium sending its own native UA gets a 202 challenge page, while Chromium *claiming to be Chrome* gets a flat 403.

Re-running the whole engine survey under WebKit changes four verdicts (`node scripts/probe-engines2.mjs chromium` vs `node scripts/probe-engines2.mjs webkit`):

| Engine | headless Chromium | **WebKit (default)** |
| --- | --- | --- |
| DuckDuckGo | 403 blocked | **200 RELEVANT** |
| Yahoo | 200 RELEVANT | 200 RELEVANT |
| Bing | 200 IRRELEVANT (*decoys*) | **200 RELEVANT** |
| Yandex | 200 no results | inconsistent — relevant once, not on a repeat run |
| Qwant | 200 no results | 200 no results |
| Mojeek | 200 altcha CAPTCHA | 200 altcha CAPTCHA |
| Startpage | 200 no results | 200 no results |
| Ecosia | 403 blocked | not retested |
| Brave | not attempted | not attempted — see below |

**Before concluding that an engine blocks scrapers, check whether it merely blocks Chromium.**

This also explains something that had looked like luck. The Dart application this project is derived from has scraped DuckDuckGo daily for a long time and has never hit this block — and it fetches through `flutter_inappwebview`'s headless `WKWebView`, which is the same WebKit engine family Playwright's `webkit` launches. It was never getting away with anything; it simply was not Chromium.

WebKit costs nothing elsewhere: re-running the 9-domain extraction test under it produced the same tiers and the same content as Chromium. It is the default for **every** fetch, not just search, since the same fingerprinting plausibly affects ordinary sites too. Set `LOOKUPKIT_BROWSER=chromium` if you want the old behaviour, and `firefox` also works.

### The rest of the design

**Never let one engine's failure reach the caller.** Engines are raced in parallel under a hard timeout, and the first **non-empty** result set wins — not the first to *finish*, because a challenge-blocked engine answers fast and empty, and letting that win would hand you a blank page as if the web contained nothing. A blocked engine costs its own slot and nothing else. This is the structural difference from the SearxNG path in [Vane #763](https://github.com/ItzCrazyKns/Vane/issues/763): there is no code path here where an upstream CAPTCHA becomes your error or your hang.

The log pasted into that issue is worth reading next to the tables above. The engine whose CAPTCHA hangs the UI is `searx.engines.duckduckgo`, raising `SearxEngineCaptchaException` — the same engine that returns 403 to Chromium here and 200 with real results to WebKit. Both halves of this project's answer to that bug are visible in that one line: prefer an engine stack the site will actually talk to, and never let the failure of one become the caller's problem.

**Bing is the reason the relevance gate exists.** Under Chromium it does not block — it answers 200 OK, echoes your query correctly in its own search box, and returns results for something else entirely: German model-railway forums for a Hanoi weather query. Any scraper whose health check is "did I get links back" accepts that silently. Running the full pipeline over those decoys:

```
confident: false   threshold: 0.5
best  0.0009  https://en.wikipedia.org/wiki/Ho_Chi_Minh_City
all candidate scores: [0.0009, 0.0009, 0.0009, 0.0002]
```

Four plausible-looking, entirely wrong pages, every one scoring three orders of magnitude below the threshold. A raw link list gives you no way to see that; a scored passage does. Under WebKit Bing returns correct results for the same queries — but it stays off the default list regardless, because an engine that answers *wrong* rather than failing is one to keep on a short leash even when it is behaving.

**Talk to the endpoint that answers, not the one that redirects.** `duckduckgo.com/html` 302-redirects to `html.duckduckgo.com/html/`; going straight there saves a round trip (confirmed with `curl -D-`).

**Brave is not here, on purpose — and this is not the same problem.** Do not go looking for a browser engine that gets past it. It runs a proof-of-work challenge built specifically to stop scrapers ([search.brave.com/help/pow-captcha](https://search.brave.com/help/pow-captcha)), and it blocks by IP/device, affecting a hand-driven real browser too. In the project this one derives from it worked beautifully for one day of ordinary-volume use and then **permanently blocked the IP**, after which every search returned zero results for good. That is not a rate limit you can back off from.

A plain HTTP client is not an option either: `curl` with a browser User-Agent to DuckDuckGo's HTML endpoint returned a 202 interstitial rather than results. The browser is load-bearing.

---

## Measured behaviour

All numbers below are from this implementation, measured on 2026-09-15/16 on an Apple Silicon laptop over a real residential connection, with the shipped defaults (WebKit, DuckDuckGo + Yahoo raced). Nothing here is estimated or inherited.

### End-to-end `/lookup`, 15 real calls

`npx tsx scripts/bench.mts 3`

| Query | median | min | max | search | score | confident |
| --- | --- | --- | --- | --- | --- | --- |
| giá vàng SJC hôm nay | 3800 ms | 3038 | 4059 | 2071 ms | 0.908 | 3/3 |
| thời tiết Hà Nội ngày mai | 6541 ms | 6091 | 11143 | 1726 ms | 0.985 | 3/3 |
| tỷ giá USD hôm nay | 6176 ms | 5162 | 8150 | 933 ms | 0.971 | 3/3 |
| what is the capital of Australia | 3577 ms | 3161 | 3708 | 1189 ms | 0.520 | 3/3 |
| who wrote the novel Dune | 4746 ms | 4558 | 7683 | 1290 ms | 0.682 | 3/3 |

**Overall: median 4746 ms, range 3038–11143 ms across all 15 calls, 15/15 confident.** Roughly 0.9–2.1 s of that is the search step; the rest is the slowest useful candidate page. `/search` alone runs 0.6–1.5 s.

Inside the container (`docker run`, same machine): `/lookup` 4.24 s for a Vietnamese query and 7.85 s for an English one, `/search` 1.52 s — the same ballpark, with the browser taking ~870 ms to launch at boot instead of ~100 ms.

### Fetch + extract, 9 real domains

`LOOKUPKIT_LOG_LEVEL=debug npx tsx scripts/probe-extract.mts`, under the default WebKit. "value-shaped numbers" counts runs of 3+ digits or grouped numbers like `146,500` — i.e. whether the page's actual *data* survived, not merely whether text came back.

| Domain | ms | chars | value-shaped numbers | tier |
| --- | --- | --- | --- | --- |
| sjc.com.vn/bieu-do-gia-vang | 3635 | 503 | 25 | readability |
| vnexpress.net/chu-de/gia-vang-1403 | 4265 | 5412 | 64 | **heuristic** |
| baomoi.com/tim-kiem/gia-vang.epi | 2578 | 1664 | 2 | **heuristic** |
| pnj.com.vn/site/gia-vang | 3936 | 1325 | 59 | readability |
| webgia.com/gia-vang/sjc/ | 4863 | 3904 | 56 | readability |
| giavang.org/ | 3786 | 5109 | 305 | readability |
| thoitiet.vn/ha-noi/ngay-mai | 3978 | 1190 | 9 | readability |
| 24h.com.vn/gia-vang-hom-nay-c425.html | 3822 | 4064 | 91 | readability |
| giavang.com.vn/gia-vang-sjc/ | 2002 | 2142 | 18 | readability |

Run under Chromium the same table comes out equivalent (same tiers, same content), so the WebKit default costs nothing on extraction — it only buys access to more search engines.

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
- **Anti-bot findings rot fast.** Every table here is a snapshot from one residential IP on one day. The Chromium-versus-WebKit result was a complete reversal of this project's own earlier conclusion, discovered only because the hypothesis was tested rather than reasoned about. Re-measure with the `scripts/probe-*` harnesses before trusting any of it.
- **No caching, no rate limiting, no auth.** Put it behind something before exposing it.

---

## Development

```bash
npm ci
npx playwright install webkit      # or: npx playwright install (all three)
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
