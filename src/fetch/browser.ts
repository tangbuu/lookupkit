import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { log } from '../logger.js';

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  starting ??= (async () => {
    const t0 = Date.now();
    browser = await chromium.launch({
      args: [
        // Chromium advertises itself as automated by default; sites that
        // gate on that signal serve a challenge page instead of results.
        '--disable-blink-features=AutomationControlled',
        // Required in most containers: no user namespaces, and /dev/shm is
        // 64MB by default, which Chromium overruns and crashes on.
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    log.info(`chromium launched in ${Date.now() - t0}ms`);
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
      userAgent: config.userAgent,
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
