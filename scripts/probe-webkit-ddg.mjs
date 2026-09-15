// Hypothesis under test: DuckDuckGo's 403 is a Chromium-headless fingerprint
// block, and Playwright's WebKit (the Safari/WKWebView engine family, which the
// Dart reference implementation used without ever being blocked) gets through.
//
// Everything except the browser engine is held constant: same URLs, same UA,
// same locale/viewport, same extraction.
import { chromium, webkit, firefox } from 'playwright';

const Q = 'capital of Australia';
const EXPECT = /canberra/i;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const urls = {
  'ddg-html': `https://html.duckduckgo.com/html/?q=${encodeURIComponent(Q)}`,
  'ddg-lite': `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(Q)}`,
  yahoo: `https://search.yahoo.com/search?p=${encodeURIComponent(Q)}`,
};

// WebKit has no --disable-blink-features (that is a Blink flag); pass it only
// to Chromium so each engine gets its own best shot.
const engines = {
  chromium: { launcher: chromium, opts: { args: ['--disable-blink-features=AutomationControlled'] } },
  webkit: { launcher: webkit, opts: {} },
  firefox: { launcher: firefox, opts: {} },
};

// Let WebKit send its OWN native UA too, since spoofing a Chrome UA from a
// WebKit engine is itself an inconsistency a fingerprinter can catch.
const uaModes = { spoofChromeUA: UA, nativeUA: undefined };

console.log('engine    ua-mode        target     status  len     results  relevant');
for (const [engineName, { launcher, opts }] of Object.entries(engines)) {
  let browser;
  try {
    browser = await launcher.launch(opts);
  } catch (e) {
    console.log(`${engineName.padEnd(9)} LAUNCH FAILED: ${e.message.split('\n')[0]}`);
    continue;
  }
  for (const [uaName, ua] of Object.entries(uaModes)) {
    for (const [target, url] of Object.entries(urls)) {
      const ctx = await browser.newContext({
        ...(ua ? { userAgent: ua } : {}),
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
      });
      const page = await ctx.newPage();
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const out = await page.evaluate(() => ({
          len: document.documentElement.outerHTML.length,
          ddg: document.querySelectorAll('a.result__a, .result-link').length,
          yahoo: document.querySelectorAll('div.algo').length,
          text: document.body?.innerText ?? document.body?.textContent ?? '',
        }));
        const n = target.startsWith('ddg') ? out.ddg : out.yahoo;
        console.log(
          engineName.padEnd(9),
          uaName.padEnd(14),
          target.padEnd(10),
          String(resp?.status()).padEnd(7),
          String(out.len).padEnd(7),
          String(n).padEnd(8),
          EXPECT.test(out.text) ? 'YES' : 'no',
        );
      } catch (e) {
        console.log(engineName.padEnd(9), uaName.padEnd(14), target.padEnd(10), 'ERR', e.message.split('\n')[0].slice(0, 60));
      }
      await ctx.close();
      await new Promise((r) => setTimeout(r, 2500)); // do not hammer
    }
  }
  await browser.close();
}
