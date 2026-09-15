import { webkit } from 'playwright';
const browser = await webkit.launch();
const ctx = await browser.newContext({ locale: 'en-US', viewport:{width:1280,height:800} });
const page = await ctx.newPage();
const q = 'capital of Australia -site:youtube.com -site:facebook.com';
const resp = await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {waitUntil:'domcontentloaded', timeout:20000});
console.log('status', resp?.status());
console.log(JSON.stringify(await page.evaluate(() => {
  const out=[];
  for (const node of document.querySelectorAll('.result__body, .web-result')) {
    const a = node.querySelector('a.result__a');
    if (!a?.href?.startsWith('http')) continue;
    out.push({ url: a.href.slice(0,80), title: (a.textContent||'').trim().slice(0,55), snip: (node.querySelector('.result__snippet')?.textContent||'').replace(/\s+/g,' ').trim().slice(0,60) });
    if (out.length>=5) break;
  }
  return { counts: {resultBody: document.querySelectorAll('.result__body').length, webResult: document.querySelectorAll('.web-result').length, resultA: document.querySelectorAll('a.result__a').length}, out };
}), null, 1));
await browser.close();
