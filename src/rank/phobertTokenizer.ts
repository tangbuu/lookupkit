import { readFileSync } from 'node:fs';

/**
 * Minimal PhoBERT/RoBERTa BPE tokenizer that reads PhoRanker's own
 * HuggingFace `tokenizer.json` directly.
 *
 * That file (checked, not assumed) declares exactly this pipeline:
 *   normalizer:     null
 *   pre_tokenizer:  {"type": "WhitespaceSplit"}
 *   model:          BPE, end_of_word_suffix "</w>", no continuing prefix,
 *                   unk "<unk>", fuse_unk false
 *   post_processor: TemplateProcessing
 *                     single: <s> A </s>
 *                     pair:   <s> A </s> </s> B </s>       (all type_id 0)
 *
 * So the whole tokenizer is ~80 lines, which is why this does not depend on
 * transformers.js: that package brings ~200MB of node_modules (including a
 * second ONNX runtime) purely to run these same rules. Output is asserted
 * identical to transformers.js's — see test/tokenizer.test.ts.
 *
 * Note the pair layout has TWO `</s>` between the segments and emits no
 * token_type_ids; RoBERTa-family models have no segment embeddings.
 */

interface TokenizerJson {
  model: {
    type: string;
    vocab: Record<string, number>;
    merges: string[] | [string, string][];
    end_of_word_suffix?: string | null;
    unk_token?: string | null;
  };
  pre_tokenizer?: { type?: string } | null;
  normalizer?: unknown;
}

export class PhobertTokenizer {
  static readonly bosId = 0;
  static readonly eosId = 2;

  private constructor(
    private readonly vocab: Map<string, number>,
    private readonly mergeRank: Map<string, number>,
    private readonly unkId: number,
    private readonly eow: string,
    private readonly cache = new Map<string, number[]>(),
  ) {}

  static fromFile(tokenizerJsonPath: string): PhobertTokenizer {
    const raw = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8')) as TokenizerJson;
    const model = raw.model;
    if (model.type !== 'BPE') {
      throw new Error(`Unsupported tokenizer model type "${model.type}" (expected BPE)`);
    }
    if (raw.normalizer) {
      throw new Error('Tokenizer declares a normalizer; this minimal port implements none');
    }
    const preType = raw.pre_tokenizer?.type;
    if (preType !== 'WhitespaceSplit') {
      throw new Error(`Unsupported pre_tokenizer "${preType}" (expected WhitespaceSplit)`);
    }

    const vocab = new Map<string, number>(Object.entries(model.vocab));
    const mergeRank = new Map<string, number>();
    model.merges.forEach((m, i) => {
      const key = Array.isArray(m) ? `${m[0]} ${m[1]}` : m;
      // Earlier line = higher priority; keep the first rank if a pair repeats.
      if (!mergeRank.has(key)) mergeRank.set(key, i);
    });

    const unkToken = model.unk_token ?? '<unk>';
    const unkId = vocab.get(unkToken);
    if (unkId === undefined) throw new Error(`unk token "${unkToken}" missing from vocab`);

    return new PhobertTokenizer(vocab, mergeRank, unkId, model.end_of_word_suffix ?? '</w>');
  }

  /** BPE-merges one whitespace-delimited word into vocab ids. */
  private encodeWord(word: string): number[] {
    const cached = this.cache.get(word);
    if (cached) return cached;

    const chars = Array.from(word);
    let symbols = chars.map((c, i) => (i === chars.length - 1 ? c + this.eow : c));

    for (;;) {
      let bestRank = Infinity;
      let bestPair = '';
      for (let i = 0; i < symbols.length - 1; i++) {
        const pair = `${symbols[i]} ${symbols[i + 1]}`;
        const rank = this.mergeRank.get(pair);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestPair = pair;
        }
      }
      if (bestPair === '') break;

      // Merge EVERY occurrence of the winning pair in one pass, matching
      // HuggingFace `tokenizers`/subword-nmt (not one occurrence per sweep).
      const [left, right] = bestPair.split(' ') as [string, string];
      const next: string[] = [];
      for (let i = 0; i < symbols.length; ) {
        if (i < symbols.length - 1 && symbols[i] === left && symbols[i + 1] === right) {
          next.push(left + right);
          i += 2;
        } else {
          next.push(symbols[i]!);
          i += 1;
        }
      }
      symbols = next;
    }

    const ids = symbols.map((s) => this.vocab.get(s) ?? this.unkId);
    this.cache.set(word, ids);
    return ids;
  }

  /** Token ids for `text`, without any special tokens. */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const word of text.split(/\s+/)) {
      if (word === '') continue;
      ids.push(...this.encodeWord(word));
    }
    return ids;
  }

  /**
   * RoBERTa pair encoding: `<s> query </s></s> passage </s>`, truncated to
   * `maxLen` by trimming the PASSAGE first (the query is short and carries
   * the intent; cutting it would change the question being asked).
   */
  encodePair(query: string, passage: string, maxLen: number): number[] {
    const budget = maxLen - 4; // <s> + </s></s> + </s>
    const q = this.encode(query).slice(0, budget);
    const p = this.encode(passage).slice(0, Math.max(0, budget - q.length));
    return [
      PhobertTokenizer.bosId,
      ...q,
      PhobertTokenizer.eosId,
      PhobertTokenizer.eosId,
      ...p,
      PhobertTokenizer.eosId,
    ];
  }
}
