import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PhobertTokenizer } from '../src/rank/phobertTokenizer.js';

const tokenizer = PhobertTokenizer.fromFile(
  fileURLToPath(new URL('../models/phoranker_tokenizer.json', import.meta.url)),
);

interface Fixture {
  source: string;
  cases: { query: string; passage: string; pairIds: number[]; singleIds: number[] }[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/tokenizer-parity.json', import.meta.url)), 'utf8'),
) as Fixture;

// The point of this test: this project reimplements PhoRanker's tokenizer in
// ~80 lines instead of depending on transformers.js (~200MB of node_modules,
// including a second ONNX runtime). That is only safe if the ids come out
// bit-identical, so every case here was produced by the real HuggingFace
// tokenizer -- see scripts/gen-tokenizer-fixture.mjs.
test('pair encoding matches transformers.js exactly', () => {
  for (const c of fixture.cases) {
    assert.deepEqual(
      tokenizer.encodePair(c.query, c.passage, 256),
      c.pairIds,
      `pair mismatch for ${JSON.stringify(c.query)}`,
    );
  }
});

test('single-sequence encoding matches transformers.js exactly', () => {
  for (const c of fixture.cases) {
    assert.deepEqual(
      [PhobertTokenizer.bosId, ...tokenizer.encode(c.query), PhobertTokenizer.eosId],
      c.singleIds,
      `single mismatch for ${JSON.stringify(c.query)}`,
    );
  }
});

test('pair layout is <s> q </s></s> p </s> with no token_type_ids', () => {
  const ids = tokenizer.encodePair('xin chào', 'thế giới', 256);
  assert.equal(ids[0], PhobertTokenizer.bosId);
  assert.equal(ids.at(-1), PhobertTokenizer.eosId);
  // exactly one </s></s> pair in the middle
  const doubles = ids.filter(
    (id, i) => id === PhobertTokenizer.eosId && ids[i + 1] === PhobertTokenizer.eosId,
  );
  assert.equal(doubles.length, 1);
});

test('truncation trims the passage, never the query', () => {
  const query = 'giá vàng SJC hôm nay';
  const longPassage = 'giá vàng miếng SJC niêm yết ở mức một trăm bốn sáu triệu đồng '.repeat(40);
  const ids = tokenizer.encodePair(query, longPassage, 64);
  assert.equal(ids.length, 64);
  const queryIds = tokenizer.encode(query);
  assert.deepEqual(ids.slice(1, 1 + queryIds.length), queryIds);
});
