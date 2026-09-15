import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { log } from '../logger.js';
import { isUrlSafeToFetch } from './ssrf.js';

/**
 * The browser engine is the single highest-impact setting in this project, and
 * WebKit is the default for a measured reason.
 *
 * Head-to-head on 2026-09-16, same IP, same minute, same URLs and UA, varying
 * only the engine (scripts/probe-webkit-ddg.mjs):
 *
 *   engine    ddg-html  ddg-lite  results  relevant
 *   chromium  403       403       0        no
 *   webkit    200       200       10-14    YES
 *   firefox   200       200       10-14    YES
 *
 * So DuckDuckGo's block is a headless-CHROMIUM fingerprint block, not an IP or
 * rate-limit block — the same address fetched real results through the other
 * two engines seconds later. Spoofing a Chrome user agent does not help and
 * makes it worse: Chromium with its own native UA gets a 202 challenge page,
 * while Chromium claiming to be Chrome gets a flat 403.
 *
 * The effect is not limited to DuckDuckGo. Re-running the whole engine survey
 * under WebKit turned Bing from "answers 200 with decoy results for an
 * unrelated query" into genuinely relevant results, and did the same for
 * Yandex. Engines that look broken under Chromium are frequently just
 * refusing to talk to it.
 *
 * This also explains why the Dart implementation this project derives from
 * never hit the DuckDuckGo block: it fetched through `flutter_inappwebview`'s
 * headless WKWebView, which is the same WebKit engine family.
 */
const LAUNCHERS = { webkit, firefox, chromium } as const;
export type BrowserEngine = keyof typeof LAUNCHERS;

/**
 * Well-known ad/tracker/chat-widget domains, blocked outright regardless of
 * resource type. Generic, not site-specific guesses — ported from the
 * reference Dart implementation's `_adTrackerDomains`, which measured a
 * ~45-56% reduction on pages carrying heavy third-party tracking.
 */
const AD_TRACKER_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'adservice.google.com',
  'facebook.net',
  'connect.facebook.net',
  'fbcdn.net',
  'hotjar.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  'amazon-adsystem.com',
  'clarity.ms',
  'zaloapp.com',
  'zalo.me',
];

function isBlockedDomain(hostname: string): boolean {
  return AD_TRACKER_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;

/**
 * Both failure modes found in review are fixed by the same rule: `starting`
 * must be cleared whenever the browser it resolves to stops being usable,
 * so the NEXT call actually retries instead of forever returning a promise
 * that already resolved to a dead browser (crash) or already rejected
 * (transient launch failure at boot bricking the process for its whole
 * lifetime).
 */
export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!starting) {
    const engine = config.browser;
    const launcher = LAUNCHERS[engine];
    starting = (async () => {
      const t0 = Date.now();
      const b = await launcher.launch({
        // Chromium-only flags. `--no-sandbox` and `--disable-dev-shm-usage` are
        // needed in most containers; the Blink automation flag is a (partial,
        // as the table above shows) attempt at looking less automated. WebKit
        // and Firefox take neither and would fail to launch if given them.
        ...(engine === 'chromium'
          ? {
              args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-dev-shm-usage',
              ],
            }
          : {}),
      });
      log.info(`${engine} launched in ${Date.now() - t0}ms`);
      b.on('disconnected', () => {
        log.warn(`${engine} disconnected — next getBrowser() call will relaunch`);
        if (browser === b) browser = null;
        starting = null;
      });
      browser = b;
      return b;
    })().catch((err: unknown) => {
      // A launch failure must not brick every future call — clear the memo
      // so the NEXT request gets a fresh attempt instead of the same
      // rejected promise forever.
      starting = null;
      throw err;
    });
  }
  return starting;
}

/** Shuts the shared browser down; safe to call more than once. */
export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  starting = null;
  searchContext = null;
  startingSearchContext = null;
  if (b) await b.close().catch(() => undefined);
}

function newContextOptions(javaScriptEnabled: boolean): Parameters<Browser['newContext']>[0] {
  return {
    // Empty means "send the engine's own UA". Spoofing a Chrome UA from a
    // non-Chrome engine is itself a detectable inconsistency, and measured
    // here it bought nothing: WebKit gets real DuckDuckGo results either
    // way.
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled,
  };
}

/**
 * Installs the same request-blocking rules on every page a context creates,
 * so the persistent search context and the one-off fetch context can never
 * drift apart.
 */
async function installBlocking(page: Page): Promise<void> {
  // Images/media/fonts never contribute text and dominate page weight.
  // Stylesheets are deliberately NOT blocked: some data pages fill their
  // tables from JS that waits on CSS, and blocking CSS leaves those tables
  // permanently empty — a real bug found in the reference implementation,
  // where the page looked "slow" but was actually broken.
  await page.route('**/*', async (route) => {
    const request = route.request();
    const type = request.resourceType();

    // SSRF guard, checked first and on every hop of a redirect chain (each
    // redirect is a new intercepted request through this same handler): a
    // search result — or a page IT redirects to — must not be allowed to
    // point this browser at a private/loopback/internal address. See
    // ssrf.ts's doc comment for the exact exploit this closes.
    if (request.isNavigationRequest()) {
      const check = await isUrlSafeToFetch(request.url());
      if (!check.safe) {
        log.warn(`blocked navigation: ${check.reason}`);
        return route.abort();
      }
    }

    if (type === 'image' || type === 'media' || type === 'font') return route.abort();

    // Ad content is commonly iframe-embedded, and extractContent() only
    // ever reads the top document (jsdom is handed page.content(), which
    // does not include iframe subdocuments) — blocking child-frame loads
    // entirely costs nothing content-wise.
    if (request.frame() !== page.mainFrame()) return route.abort();

    const url = request.url();
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      return route.continue();
    }
    if (isBlockedDomain(hostname)) return route.abort();

    // Third-party scripts only, not the page's own: a page's first-party
    // script is frequently what renders its content (including the
    // search engines' own href-rewriting script), but a third-party
    // script is overwhelmingly analytics/ads/chat-widget weight.
    // Defensive: `page.url()` is `about:blank` (empty hostname, no throw) on
    // a fresh page in practice, so this hasn't been observed to throw, but
    // costs nothing to guard.
    let pageHostname = '';
    try {
      pageHostname = new URL(page.url()).hostname;
    } catch {
      /* leave empty — treat as third-party below */
    }
    if (type === 'script' && hostname !== pageHostname) return route.abort();

    return route.continue();
  });
}

/**
 * Caps how many `withPage` contexts can be open at once, process-wide. Concurrent
 * contexts are cheap on this stack (measured — see below), but "cheap" is not
 * "free": with no cap at all, review found N simultaneous `/lookup` requests each
 * fan out to `maxUrls` contexts with no queue, so a handful of concurrent callers
 * multiplies unboundedly instead of queueing — a trivial resource-exhaustion path
 * for a service meant to run unauthenticated on the internet.
 */
let activeFetches = 0;
const fetchQueue: (() => void)[] = [];

function acquireFetchSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    const tryAcquire = (): void => {
      if (activeFetches < config.maxConcurrentFetches) {
        activeFetches += 1;
        resolve();
      } else {
        fetchQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseFetchSlot(): void {
  activeFetches -= 1;
  fetchQueue.shift()?.();
}

/**
 * One throwaway context per page load, queued behind {@link acquireFetchSlot}
 * once `config.maxConcurrentFetches` are already open. Isolates cookies/storage
 * between the sites we visit, so a consent banner or tracking cookie picked up
 * on one candidate cannot leak into the next.
 *
 * This isolation is specifically about FETCH targets — arbitrary,
 * unrelated third-party sites where one candidate's cookies must never
 * touch another's. It does not apply to the two fixed search engines; see
 * {@link withSearchPage}.
 *
 * Concurrent contexts are cheap on THIS stack too, not just on the reference
 * Dart app's native WKWebView — measured directly (`scripts/probe-context-cost.mts`,
 * webkit engine, local instant target to isolate context-creation cost from
 * network variance, 5 rounds/level): going from 1-at-a-time to 5-concurrent
 * contexts dropped mean per-context time from ~203ms to ~44ms (parallelism
 * amortizes fixed overhead, it does not add per-context penalty) and grew
 * real OS-level browser-process-tree RSS by well under 1MB per 5-way batch
 * after the first-ever context's one-time ~43MB warmup. So a 5-way parallel
 * batch WITHIN one request is both faster AND cheaper per candidate than doing
 * the same 5 one at a time — that finding is about per-request fan-out, not
 * about how many requests the process should serve at once, which is what the
 * cap above is for.
 *
 * `signal`, if given, both skips the wait when already aborted and closes the
 * context early if aborted mid-flight — used by the caller to free a slot the
 * moment a lookup no longer needs this particular candidate (e.g. a sibling
 * candidate already answered confidently) instead of holding it to its own
 * timeout for nothing.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('aborted before a fetch slot was acquired');
  await acquireFetchSlot();
  try {
    const b = await getBrowser();
    let ctx: BrowserContext | null = null;
    try {
      if (signal?.aborted) throw new Error('aborted while waiting for a fetch slot');
      ctx = await b.newContext(newContextOptions(true));
      ctx.setDefaultTimeout(config.fetchTimeoutMs);
      const liveCtx = ctx;
      const onAbort = (): void => {
        void liveCtx.close().catch(() => undefined);
      };
      signal?.addEventListener('abort', onAbort);
      try {
        await ctx.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        const page = await ctx.newPage();
        await installBlocking(page);
        return await fn(page);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } finally {
      await ctx?.close().catch(() => undefined);
    }
  } finally {
    releaseFetchSlot();
  }
}

let searchContext: BrowserContext | null = null;
let startingSearchContext: Promise<BrowserContext> | null = null;

async function getSearchContext(): Promise<BrowserContext> {
  if (searchContext) return searchContext;
  if (startingSearchContext) return startingSearchContext;
  startingSearchContext = (async () => {
    const b = await getBrowser();
    // Both configured engines are confirmed server-rendered (see engines.ts
    // and README): DuckDuckGo and Yahoo's result markup is present without
    // running a single line of the page's own JS. Disabling it here is safe
    // ONLY because the search targets are these two fixed, known origins —
    // `withPage`'s fetch targets are arbitrary search-result pages that may
    // be client-rendered, so it keeps JS on. Measured (`node` one-off probe,
    // `javaScriptEnabled` on vs off, same URLs, 3 rounds each): identical
    // result counts every time, ~5-20% faster per search
    // (DDG ~1046→996/1125→1069/842→809ms, Yahoo ~1440→1221/1499→1246/1161→979ms).
    // Unlike the reference Dart implementation's WKWebView, where disabling
    // this flag killed the app's OWN injected extraction script too,
    // Playwright's `page.evaluate()` keeps working with the page's JS off —
    // confirmed directly before relying on it, not assumed from WKWebView's
    // behaviour.
    const ctx = await b.newContext(newContextOptions(false));
    ctx.setDefaultTimeout(config.fetchTimeoutMs);
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    ctx.on('close', () => {
      // A context can die independently of the browser (e.g. an internal
      // crash) — without this, `searchContext` would still be a truthy
      // reference to a dead context and every search would break until
      // relaunch. See the same fix on `getBrowser`.
      if (searchContext === ctx) searchContext = null;
      startingSearchContext = null;
    });
    searchContext = ctx;
    return ctx;
  })().catch((err: unknown) => {
    startingSearchContext = null;
    throw err;
  });
  return startingSearchContext;
}

/**
 * Runs `fn` against a fresh PAGE in a long-lived, shared context reused
 * across every search call — deliberately NOT a fresh context per call like
 * {@link withPage}.
 *
 * Measured directly (`page.on('request', ...)` against a real navigation):
 * a cold context's first hit to `search.yahoo.com` 307-redirects through a
 * bot-verification beacon (`/_bv/v.gif`) before landing back on the real
 * results page — three navigation hops, ~1.3s. Once that beacon sets its
 * cookies (`YBV`/`A1`/`A3`/`A1S`), every later request in the SAME context
 * skips it outright — one hop, ~0.75-1.0s. A fresh context per search (the
 * `withPage` default) pays that beacon tax on literally every request,
 * forever.
 *
 * This does not carry the cross-site cookie-leak risk `withPage`'s doc
 * comment warns about, because search only ever navigates to the same two
 * fixed engine origins — there is no unrelated third-party site for a stray
 * cookie to leak into. It also does not carry the reference Dart
 * implementation's stale-DOM risk from reusing one polled webview across
 * different URLs: Playwright's `page.goto()` is a real navigation with its
 * own lifecycle/load events per call, not a polling read of whatever the
 * DOM happens to contain — there is nothing to go stale between calls, only
 * a fresh page per call inside one long-lived context.
 */
export async function withSearchPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await getSearchContext();
  const page = await ctx.newPage();
  try {
    await installBlocking(page);
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}
