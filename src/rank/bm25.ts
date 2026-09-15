/**
 * Port of `rank_bm25`'s `BM25Okapi` (https://github.com/dorianbrown/rank_bm25)
 * using that library's real IDF formula `ln((N-n+0.5)/(n+0.5)+1)` — NOT the
 * textbook one, which can go negative for very common terms — with the
 * library's defaults k1=1.5, b=0.75.
 */

/**
 * Word tokenizer for BM25.
 *
 * `\w` is ASCII-only in several regex engines, which silently shreds every
 * Vietnamese diacritic word into 1-2 character fragments and produces
 * nonsense BM25 matches (the reference implementation hit exactly this: a
 * query fragment "m" matching an unrelated line). `[\p{L}\p{N}]` with the `u`
 * flag matches every Unicode letter/number instead. See
 * test/tokenize.test.ts — this is asserted, not assumed.
 */
const WORD_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

const K1 = 1.5;
const B = 0.75;

export class Bm25Okapi {
  private readonly docLengths: number[];
  private readonly avgDocLength: number;
  private readonly termFreqs: Map<string, number>[];
  private readonly idf: Map<string, number>;

  constructor(private readonly corpus: string[][]) {
    this.docLengths = corpus.map((doc) => doc.length);
    this.avgDocLength = corpus.length
      ? this.docLengths.reduce((a, b) => a + b, 0) / corpus.length
      : 0;

    this.termFreqs = [];
    const docFreq = new Map<string, number>();
    for (const doc of corpus) {
      const tf = new Map<string, number>();
      for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
      this.termFreqs.push(tf);
      for (const term of tf.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }

    const n = corpus.length;
    this.idf = new Map();
    for (const [term, freq] of docFreq) {
      this.idf.set(term, Math.log((n - freq + 0.5) / (freq + 0.5) + 1));
    }
  }

  /** BM25 score of `query` (already tokenized) against each doc, in corpus order. */
  scores(query: string[]): number[] {
    const avg = this.avgDocLength === 0 ? 1 : this.avgDocLength;
    return this.corpus.map((_, i) => {
      const tf = this.termFreqs[i]!;
      const docLen = this.docLengths[i]!;
      let score = 0;
      for (const term of query) {
        const freq = tf.get(term);
        if (freq === undefined) continue;
        const idf = this.idf.get(term) ?? 0;
        const denom = freq + K1 * (1 - B + (B * docLen) / avg);
        score += (idf * (freq * (K1 + 1))) / denom;
      }
      return score;
    });
  }
}
