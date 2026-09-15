import type { Page } from 'playwright';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engine: string;
}

export interface Engine {
  readonly name: string;
  /** Result page URL for `query` (already carrying any `-site:` exclusions). */
  url(query: string): string;
  /** Runs inside the loaded result page and returns raw result rows. */
  extract(page: Page, limit: number): Promise<Omit<SearchResult, 'engine'>[]>;
}

/**
 * Engines are scraped DIRECTLY rather than through a SearxNG-style aggregator,
 * because an aggregator turns one engine's anti-bot challenge into an error or
 * a hang for the caller (see README, Vane issue #763). Every engine in
 * `LOOKUPKIT_ENGINES` is raced under a hard timeout and the first non-empty
 * result set wins, so a blocked engine costs nothing but its own slot.
 *
 * ENGINE SURVEY — measured 2026-09-15, headless Chromium, one residential IP,
 * canary query "capital of Australia" scored on whether the word "Canberra"
 * appears anywhere in the result page. Re-run scripts/probe-engines2.mjs to
 * refresh it; these things change.
 *
 *   yahoo      200  1492ms  RELEVANT    <- the only engine that passed
 *   bing       200   613ms  IRRELEVANT  decoy results, see below
 *   ddg (html) 403   830ms  blocked
 *   ddg (lite) 403   747ms  blocked
 *   qwant      200  2314ms  no results in page
 *   mojeek     200  1563ms  altcha.org CAPTCHA widget
 *   startpage  200  1098ms  22KB page, no results
 *   yandex     200  2209ms  no results in page
 *   ecosia     403   788ms  blocked
 *
 * Bing deserves its own warning. It does not block; it answers 200 OK, echoes
 * the query correctly in its own search box, and returns results for something
 * else entirely — German model-railway forums for a Hanoi weather query,
 * dictionary definitions for "capital of Australia". A scraper that checks
 * "did I get links back" accepts this silently. It is implemented here and
 * selectable, but it is not a default, and anything downstream of it needs the
 * relevance gate on `/lookup` to catch it.
 *
 * Brave is implemented NOWHERE, deliberately. It runs a proof-of-work
 * challenge built specifically to stop scrapers
 * (search.brave.com/help/pow-captcha). It is fast and works well right up
 * until it PERMANENTLY blocks the IP — observed in the reference
 * implementation after a single day of ordinary-volume use, after which every
 * search returned zero results. That is not a rate limit you can back off
 * from. Do not add it.
 */

function encode(query: string): string {
  return encodeURIComponent(query);
}

export const yahoo: Engine = {
  name: 'yahoo',
  url: (query) => `https://search.yahoo.com/search?p=${encode(query)}`,
  extract: (page, limit) =>
    page.evaluate((limit) => {
      // Yahoo A/B-tests its result markup, and the two layouts nest the
      // headline the opposite way round: one serves `h3 > a`, the other
      // `a > h3.title`. Anchoring on either one alone silently returns zero
      // results whenever the other variant is served, so find the anchor and
      // the headline independently within the result block.
      const out: { title: string; url: string; content: string }[] = [];
      for (const node of Array.from(document.querySelectorAll('div.algo'))) {
        const anchors = Array.from(
          node.querySelectorAll('.compTitle a[href^="http"], h3 a[href^="http"], a[href^="http"]'),
        ) as HTMLAnchorElement[];
        const a = anchors.find((el) => {
          const host = new URL(el.href).hostname.toLowerCase();
          return host !== 'yahoo.com' && !host.endsWith('.yahoo.com');
        });
        if (!a) continue;

        // Both layouts put a "site.com › path › crumb" breadcrumb next to the
        // headline; drop any element carrying "›" before reading the text.
        const titleSource = node.querySelector('h3') ?? a;
        const clone = titleSource.cloneNode(true) as Element;
        for (const child of Array.from(clone.querySelectorAll('*'))) {
          if ((child.textContent ?? '').includes('›')) child.remove();
        }
        const title = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();

        out.push({
          title: title || a.href,
          url: a.href,
          content: (node.querySelector('.compText')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        });
        if (out.length >= limit) break;
      }
      return out;
    }, limit),
};

/**
 * NOT a default. Bing answers detected scrapers with plausible-looking results
 * for an unrelated query rather than an error — read the survey note above
 * before enabling it.
 */
export const bing: Engine = {
  name: 'bing',
  url: (query) => `https://www.bing.com/search?q=${encode(query)}`,
  extract: (page, limit) =>
    page.evaluate((limit) => {
      // Bing wraps every result in a `bing.com/ck/a?...&u=a1<base64url>`
      // click tracker; the real URL is that base64url payload minus its
      // two-character "a1" scheme marker.
      const unwrap = (href: string): string | null => {
        try {
          const u = new URL(href);
          if (!/(^|\.)bing\.com$/.test(u.hostname)) return href;
          const packed = u.searchParams.get('u');
          if (!packed?.startsWith('a1')) return null;
          const b64 = packed.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          const decoded = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
          return decoded.startsWith('http') ? decoded : null;
        } catch {
          return null;
        }
      };
      const out: { title: string; url: string; content: string }[] = [];
      for (const li of Array.from(document.querySelectorAll('li.b_algo'))) {
        const a = li.querySelector('h2 a') as HTMLAnchorElement | null;
        if (!a) continue;
        const url = unwrap(a.href);
        if (!url) continue;
        const snippet = li.querySelector('.b_caption p, .b_lineclamp2, p');
        out.push({
          title: (a.textContent ?? '').replace(/\s+/g, ' ').trim() || url,
          url,
          content: (snippet?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        });
        if (out.length >= limit) break;
      }
      return out;
    }, limit),
};

export const duckduckgo: Engine = {
  name: 'duckduckgo',
  // Go straight to `html.duckduckgo.com/html/`: the `duckduckgo.com/html`
  // spelling answers with a 302 to exactly this URL, so using it costs an
  // extra round trip for nothing (confirmed with `curl -D-`).
  url: (query) => `https://html.duckduckgo.com/html/?q=${encode(query)}`,
  extract: (page, limit) =>
    page.evaluate((limit) => {
      const out: { title: string; url: string; content: string }[] = [];
      for (const node of Array.from(document.querySelectorAll('.result__body, .web-result'))) {
        const a = node.querySelector('a.result__a') as HTMLAnchorElement | null;
        if (!a?.href?.startsWith('http')) continue;
        const host = new URL(a.href).hostname.toLowerCase();
        if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) continue;
        out.push({
          title: (a.textContent ?? '').replace(/\s+/g, ' ').trim() || a.href,
          url: a.href,
          content: (node.querySelector('.result__snippet')?.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim(),
        });
        if (out.length >= limit) break;
      }
      return out;
    }, limit),
};

export const ENGINES: Record<string, Engine> = {
  yahoo,
  bing,
  duckduckgo,
  ddg: duckduckgo,
};

export function resolveEngines(names: readonly string[]): Engine[] {
  const picked: Engine[] = [];
  for (const name of names) {
    const engine = ENGINES[name.toLowerCase()];
    if (!engine) throw new Error(`Unknown engine "${name}". Known: ${Object.keys(ENGINES).join(', ')}`);
    if (!picked.includes(engine)) picked.push(engine);
  }
  if (picked.length === 0) throw new Error('No search engines configured');
  return picked;
}
