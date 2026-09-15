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
 * ENGINE SURVEY — one residential IP, canary query "capital of Australia",
 * scored on whether the word "Canberra" appears anywhere in the result page.
 * Both columns measured the same way, minutes apart, varying ONLY the browser
 * engine. Refresh with `node scripts/probe-engines2.mjs chromium` and
 * `node scripts/probe-engines2.mjs webkit`; these things change.
 *
 *                headless Chromium        WebKit (default)
 *   duckduckgo   403 blocked              200 RELEVANT
 *   yahoo        200 RELEVANT             200 RELEVANT
 *   bing         200 IRRELEVANT (decoys)  200 RELEVANT
 *   yandex       200 no results           200 INCONSISTENT (relevant once,
 *                                         not on a repeat run)
 *   qwant        200 no results           200 no results
 *   mojeek       200 altcha CAPTCHA       200 altcha CAPTCHA
 *   startpage    200 no results           200 no results
 *   ecosia       403 blocked              (not retested)
 *
 * The lesson is worth more than the table: THREE of these engines look hostile
 * under Chromium and are perfectly cooperative under WebKit (a fourth, Yandex,
 * improves but is not dependable). Before concluding
 * that an engine blocks scrapers, check whether it merely blocks Chromium.
 * See the comment in src/fetch/browser.ts for the controlled experiment.
 *
 * Bing's Chromium behaviour is the one worth remembering, because it is the
 * failure mode you cannot detect by checking whether you got links back: it
 * does not block, it answers 200 OK with the query echoed correctly in its own
 * search box and results for something else entirely — German model-railway
 * forums for a Hanoi weather query. Under WebKit it returns the right results
 * for the same queries. It stays off the default list for that reason: an
 * engine that answers wrong rather than failing is one to keep on a short
 * leash, even when it currently behaves.
 *
 * Brave is implemented NOWHERE, deliberately, and this is NOT the same kind of
 * problem — do not go looking for a browser engine that gets past it. It runs
 * a proof-of-work challenge built specifically to stop scrapers
 * (search.brave.com/help/pow-captcha) and blocks by IP/device, affecting a
 * hand-driven real browser too. In the reference implementation it worked
 * beautifully for one day of ordinary-volume use and then PERMANENTLY blocked
 * the IP, after which every search returned zero results. That is not a rate
 * limit you can back off from. Do not add it.
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
 * Works correctly under WebKit; NOT a default anyway. Under Chromium it
 * answers detected scrapers with plausible-looking results for an unrelated
 * query rather than an error — read the survey note above before enabling it.
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
      // Iterate the title anchors rather than result containers: `.web-result`
      // and `.result__body` both wrap the same result, so selecting on either
      // pair returns every result twice.
      const out: { title: string; url: string; content: string }[] = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a.result__a')) as HTMLAnchorElement[]) {
        if (!a.href.startsWith('http')) continue;
        const host = new URL(a.href).hostname.toLowerCase();
        if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) continue;
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        const container = a.closest('.result, .web-result, .result__body') ?? a.parentElement;
        out.push({
          title: (a.textContent ?? '').replace(/\s+/g, ' ').trim() || a.href,
          url: a.href,
          content: (container?.querySelector('.result__snippet')?.textContent ?? '')
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
