import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { log } from '../logger.js';

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

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  starting ??= (async () => {
    const engine = config.browser;
    const launcher = LAUNCHERS[engine];
    const t0 = Date.now();
    browser = await launcher.launch({
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
    return browser;
  })();
  return starting;
}

/** Shuts the shared browser down; safe to call more than once. */
export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  starting = null;
  if (b) await b.close().catch(() => undefined);
}

/**
 * One throwaway context per page load. Contexts are cheap in Chromium and
 * isolate cookies/storage between the sites we visit, so a consent banner or
 * tracking cookie picked up on one candidate cannot leak into the next.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await getBrowser();
  let ctx: BrowserContext | null = null;
  try {
    ctx = await b.newContext({
      // Empty means "send the engine's own UA". Spoofing a Chrome UA from a
      // non-Chrome engine is itself a detectable inconsistency, and measured
      // here it bought nothing: WebKit gets real DuckDuckGo results either
      // way.
      ...(config.userAgent ? { userAgent: config.userAgent } : {}),
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true,
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await ctx.newPage();
    // Images/media/fonts never contribute text and dominate page weight.
    // Stylesheets and scripts are deliberately NOT blocked: some data pages
    // fill their tables from JS that waits on CSS, and blocking CSS leaves
    // those tables permanently empty — a real bug found in the reference
    // implementation, where the page looked "slow" but was actually broken.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });
    return await fn(page);
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}
