// Engine survey that checks RELEVANCE, not just "did we get links".
// Bing taught this lesson: it answers 200 OK with the right query in the
// search box and completely unrelated results, which a link-count check
// happily accepts.
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Canary query with an unambiguous right answer.
const Q = 'capital of Australia';
const EXPECT = /canberra/i;

const engines = {
  yahoo: `https://search.yahoo.com/search?p=${encodeURIComponent(Q)}`,
  bing: `https://www.bing.com/search?q=${encodeURIComponent(Q)}`,
  ddg_html: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(Q)}`,
  ddg_lite: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(Q)}`,
  qwant: `https://lite.qwant.com/?q=${encodeURIComponent(Q)}&t=web`,
  brave: 'SKIPPED — permanent PoW IP ban risk, see src/search/engines.ts',
  mojeek: `https://www.mojeek.com/search?q=${encodeURIComponent(Q)}`,
  startpage: `https://www.startpage.com/sp/search?query=${encodeURIComponent(Q)}`,
  ask: `https://www.ask.com/web?q=${encodeURIComponent(Q)}`,
  yandex: `https://yandex.com/search/?text=${encodeURIComponent(Q)}`,
};

const browser = await chromium.launch({
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
});

for (const [name, url] of Object.entries(engines)) {
  if (!url.startsWith('http')) {
    console.log(name.padEnd(11), url);
    continue;
  }
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const out = await page.evaluate(() => ({
      text: document.body.innerText || document.body.textContent || '',
      hosts: [
        ...new Set(
          Array.from(document.querySelectorAll('a[href^="http"]'))
            .map((a) => a.hostname.toLowerCase())
            .filter((h) => !/duckduckgo|yahoo|bing|microsoft|mojeek|startpage|qwant|ask\.com|yandex|msn/.test(h)),
        ),
      ],
    }));
    const relevant = EXPECT.test(out.text);
    console.log(
      name.padEnd(11),
      String(resp?.status()).padEnd(4),
      String(Date.now() - t0).padStart(5) + 'ms',
      relevant ? 'RELEVANT ' : 'IRRELEVANT',
      'hosts=' + out.hosts.length,
      JSON.stringify(out.hosts.slice(0, 4)),
    );
  } catch (e) {
    console.log(name.padEnd(11), 'ERR', e.message.split('\n')[0]);
  }
  await ctx.close();
  await new Promise((r) => setTimeout(r, 2500));
}
await browser.close();
