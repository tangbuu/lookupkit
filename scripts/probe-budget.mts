import { closeBrowser } from '../src/fetch/browser.js';
import { fetchAndExtract } from '../src/fetch/fetchPage.js';
import { condenseByBm25 } from '../src/rank/condense.js';
import { ensureRerankerLoaded, scoreRelevance } from '../src/rank/reranker.js';
const url='https://giavang.com.vn/gia-vang-sjc/', query='giá vàng SJC hôm nay';
const PRICE=/\d{1,3}([.,]\d{3}){2,}/;
await ensureRerankerLoaded();
const r = await fetchAndExtract(url);
for (const b of [200, 300, 400, 600, 800]) {
  const p = condenseByBm25(r.text!, query, { tokenBudget: b });
  const s = await scoreRelevance(query, p);
  const priceLines = p.split('\n').filter(l=>PRICE.test(l));
  console.log(`budget=${String(b).padStart(4)} chars=${String(p.length).padStart(5)} score=${s.toFixed(4)} priceLines=${priceLines.length}  ${priceLines[0]?.slice(0,60) ?? ''}`);
}
await closeBrowser();
