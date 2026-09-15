/**
 * Fetch + extract against the real domain list (a known-hard JS-grid case
 * plus several known-good ones). Reports real char counts AND whether real
 * numeric data survived, because "returned something non-empty" is not the
 * same as "returned the numbers the page exists to show".
 */
import { closeBrowser } from '../src/fetch/browser.js';
import { fetchAndExtract } from '../src/fetch/fetchPage.js';

const urls = [
  'https://sjc.com.vn/bieu-do-gia-vang',
  'https://vnexpress.net/chu-de/gia-vang-1403',
  'https://baomoi.com/tim-kiem/gia-vang.epi',
  'https://www.pnj.com.vn/site/gia-vang',
  'https://webgia.com/gia-vang/sjc/',
  'https://giavang.org/',
  'https://thoitiet.vn/ha-noi/ngay-mai',
  'https://www.24h.com.vn/gia-vang-hom-nay-c425.html',
  'https://giavang.com.vn/gia-vang-sjc/',
];

// "value-shaped" numbers: 3+ digits, optionally grouped (146,500 / 146.500).
const NUM_RE = /\d{1,3}(?:[.,]\d{3})+|\d{3,}/g;

console.log('url'.padEnd(52), 'ms'.padStart(6), 'chars'.padStart(7), 'nums'.padStart(6), 'tier');
for (const url of urls) {
  const r = await fetchAndExtract(url);
  const nums = r.text ? (r.text.match(NUM_RE) ?? []).length : 0;
  const sample = r.text
    ? r.text.split('\n').find((l) => NUM_RE.test(l))?.slice(0, 80).replace(/\s+/g, ' ')
    : null;
  console.log(
    url.replace('https://', '').padEnd(52),
    String(r.ms).padStart(6),
    String(r.chars).padStart(7),
    String(nums).padStart(6),
    (r.tier ?? '-') + (r.error ? `  FAIL: ${r.error}` : ''),
  );
  if (sample) console.log(`${' '.repeat(6)}sample: ${sample}`);
}
await closeBrowser();
