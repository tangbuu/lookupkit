import assert from 'node:assert/strict';
import test from 'node:test';
import { Bm25Okapi, tokenize } from '../src/rank/bm25.js';
import { condenseByBm25 } from '../src/rank/condense.js';

// A `\w`-based tokenizer is ASCII-only in some regex engines, which shreds
// every Vietnamese diacritic word into 1-2 character fragments and then
// matches those fragments against each other. Node supports `\p{L}` with the
// `u` flag, but that is asserted here rather than assumed.
test('tokenize keeps Vietnamese diacritic words whole', () => {
  assert.deepEqual(tokenize('Giá vàng hôm nay'), ['giá', 'vàng', 'hôm', 'nay']);
  assert.deepEqual(tokenize('Nguyễn Huệ đánh thắng'), ['nguyễn', 'huệ', 'đánh', 'thắng']);
  // The exact failure a `\w` tokenizer produces: "hôm" -> ["h", "m"].
  for (const token of tokenize('hôm nay có phim gì mới')) {
    assert.ok(token.length >= 2, `suspicious fragment token ${JSON.stringify(token)}`);
  }
});

test('tokenize keeps numbers and mixed scripts', () => {
  assert.deepEqual(tokenize('SJC 146,500 đồng'), ['sjc', '146', '500', 'đồng']);
  assert.deepEqual(tokenize('日本語 test'), ['日本語', 'test']);
});

test('BM25 ranks the line that shares rare query terms highest', () => {
  const docs = [
    'trang chủ liên hệ về chúng tôi đăng nhập',
    'giá vàng SJC hôm nay 146,500 nghìn đồng mỗi lượng',
    'thời tiết hà nội ngày mai có mưa',
  ].map(tokenize);
  const scores = new Bm25Okapi(docs).scores(tokenize('giá vàng SJC hôm nay'));
  assert.ok(scores[1]! > scores[0]!);
  assert.ok(scores[1]! > scores[2]!);
});

test('condense keeps relevant lines in document order and respects the budget', () => {
  const page = [
    'Trang chủ',
    'Đăng nhập',
    'Giá vàng SJC hôm nay niêm yết 146,500 nghìn đồng.',
    'Quảng cáo: mua ngay kẻo lỡ',
    'Vàng nhẫn 9999 hôm nay ở mức 145,000 nghìn đồng.',
  ].join('\n');
  const out = condenseByBm25(page, 'giá vàng SJC hôm nay', { tokenBudget: 40 });
  assert.ok(out.includes('146,500'), out);
  // Selected lines come back in their original document order.
  const lines = out.split('\n');
  assert.deepEqual([...lines].sort((a, b) => page.indexOf(a) - page.indexOf(b)), lines);
});

test('condense returns a prefix rather than nothing when one line blows the budget', () => {
  const page = 'giá vàng SJC hôm nay '.repeat(200);
  const out = condenseByBm25(page, 'giá vàng SJC', { tokenBudget: 20 });
  assert.ok(out.length > 0);
  assert.ok(out.length < page.length);
});
