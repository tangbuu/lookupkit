import { config } from '../config.js';
import { log } from '../logger.js';
import { approxTokenCount } from '../rank/tokenBudget.js';
import { withPage } from './browser.js';
import { extractContent, type ExtractionResult } from './extract.js';
import { detectFetchFailure } from './failDetector.js';

export interface FetchedPage {
  url: string;
  ms: number;
  text: string | null;
  tier: ExtractionResult['tier'] | null;
  chars: number;
  error?: string;
}

/**
 * Loads one candidate URL in its own browser context, waits for the page to
 * settle, then extracts its text.
 *
 * `networkidle` is tried first and its failure is NOT an error: plenty of real
 * pages hold a socket open forever (analytics beacons, live-price sockets) and
 * never go idle, yet have had their content painted for seconds by then. When
 * the wait times out we extract whatever is on screen rather than discarding a
 * page that was in fact ready.
 */
export async function fetchAndExtract(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  const t0 = Date.now();
  try {
    return await withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.fetchTimeoutMs });
      const budgetLeft = Math.max(500, config.fetchTimeoutMs - (Date.now() - t0));
      await page
        .waitForLoadState('networkidle', { timeout: Math.min(budgetLeft, 3000) })
        .catch(() => undefined);

      const html = await page.content();
      const { text, tier } = extractContent(html, page.url());
      const failure = detectFetchFailure(text, approxTokenCount(text));
      const ms = Date.now() - t0;
      if (failure.failed) {
        log.debug(`fetch(${url}) ${ms}ms -> FAIL: ${failure.reason}`);
        return { url, ms, text: null, tier, chars: text.length, error: failure.reason };
      }
      log.debug(`fetch(${url}) ${ms}ms -> OK ${text.length} chars via ${tier}`);
      return { url, ms, text, tier, chars: text.length };
    }, signal);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    log.debug(`fetch(${url}) ${Date.now() - t0}ms -> ERROR: ${message}`);
    return { url, ms: Date.now() - t0, text: null, tier: null, chars: 0, error: message };
  }
}
