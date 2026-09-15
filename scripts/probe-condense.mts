import { closeBrowser } from '../src/fetch/browser.js';
import { fetchAndExtract } from '../src/fetch/fetchPage.js';
import { Bm25Okapi, tokenize } from '../src/rank/bm25.js';

const url = 'https://giavang.com.vn/gia-vang-sjc/';
const query = 'giá vàng SJC hôm nay';
const r = await fetchAndExtract(url);
const lines = r.text!.split('\n').map(s=>s.trim()).filter(Boolean);
const bm = new Bm25Okapi(lines.map(tokenize));
const scores = bm.scores(tokenize(query));
const ranked = lines.map((l,i)=>({l,s:scores[i]!,i})).sort((a,b)=>b.s-a.s);
console.log('total lines', lines.length);
console.log('\n--- TOP 15 BY BM25 ---');
for (const x of ranked.slice(0,15)) console.log(x.s.toFixed(3), '|', x.l.slice(0,95));
console.log('\n--- LINES CONTAINING PRICE-SHAPED NUMBERS ---');
for (const x of ranked.filter(x=>/\d{1,3}([.,]\d{3}){2,}/.test(x.l)).slice(0,12)) console.log(x.s.toFixed(3), '|', x.l.slice(0,95));
await closeBrowser();
