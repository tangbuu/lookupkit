/**
 * Regenerates test/fixtures/tokenizer-parity.json from the REAL HuggingFace
 * tokenizer (transformers.js loading itdainb/PhoRanker's tokenizer.json).
 *
 * Not part of the test run and not a project dependency: run it by hand with
 * `npm i --no-save @xenova/transformers && node scripts/gen-tokenizer-fixture.mjs`
 * when the tokenizer or the vocabulary changes. The committed fixture is what
 * test/tokenizer.test.ts asserts against.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { AutoTokenizer, env } from '@xenova/transformers';

env.allowLocalModels = false;
const tok = await AutoTokenizer.from_pretrained('itdainb/PhoRanker');

const pairs = [
  ['giá vàng SJC hôm nay bao nhiêu', 'Giá vàng SJC hôm nay niêm yết 142,300 nghìn đồng mua vào và 145,300 nghìn đồng bán ra.'],
  ['thời tiết Hà Nội ngày mai', 'Dự báo thời tiết Hà Nội ngày mai có mưa rào, nhiệt độ thấp nhất 24°C, cao nhất 31°C.'],
  ['what is the capital of France', 'Paris is the capital and most populous city of France, with an estimated population of 2,102,650.'],
  ['tỷ giá USD hôm nay', 'Chào mừng quý khách! Đăng nhập | Đăng ký | Giỏ hàng | Liên hệ | Về chúng tôi'],
  ['Nguyễn Huệ là ai', 'Nguyễn_Huệ (1753-1792) là vị hoàng đế thứ hai của nhà Tây_Sơn.'],
  ['mixed ASCII and diacritics', 'Ăn cơm chưa? ĐỖ ĐẠT 100% — check https://example.com/path?a=1&b=2'],
  ['số học', '1+1=2; 3.14159; 2^10 = 1024'],
  ['edge', ''],
];

const cases = pairs.map(([query, passage]) => {
  const enc = tok(query, { text_pair: passage });
  const ids = Array.from(enc.input_ids.data ?? enc.input_ids[0]).map(Number);
  const qOnlyEnc = tok(query);
  const qOnly = Array.from(qOnlyEnc.input_ids.data ?? qOnlyEnc.input_ids[0]).map(Number);
  return { query, passage, pairIds: ids, singleIds: qOnly };
});

mkdirSync(new URL('../test/fixtures/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../test/fixtures/tokenizer-parity.json', import.meta.url),
  JSON.stringify({ source: 'transformers.js @xenova/transformers, itdainb/PhoRanker', cases }, null, 2),
);
console.log(`wrote ${cases.length} cases`);
