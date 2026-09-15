import * as ort from 'onnxruntime-node';
import { config } from '../config.js';
import { log } from '../logger.js';
import { PhobertTokenizer } from './phobertTokenizer.js';

/**
 * PhoRanker cross-encoder relevance gate.
 *
 * A cross-encoder reads the query and the passage TOGETHER in one pass, which
 * is what lets it answer "does this text actually answer the question" rather
 * than "does this text repeat the question's words". BM25 (keyword overlap)
 * and bi-encoder embeddings (two separately encoded vectors) both get fooled
 * by keyword-stuffed navigation and SEO pages; that is the exact failure this
 * model is here to catch.
 *
 * Model: `itdainb/PhoRanker` (Apache-2.0), a PhoBERT-base-v2 cross-encoder,
 * exported to ONNX and int8-quantized. MAX_LENGTH 256 matches its training
 * export, so inference stays in the distribution it learned.
 *
 * Known caveat (documented, not fixed): int8 quantization noise moves
 * mid-confidence scores around by roughly 0.1-0.4 in some cases. Scores near
 * 0 or 1 are robust, which is why the threshold sits at 0.5 — in the middle
 * of the large empty gap between the clearly-good and clearly-junk clusters.
 */
const MAX_SEQ_LEN = 256;

let session: ort.InferenceSession | null = null;
let tokenizer: PhobertTokenizer | null = null;
let loading: Promise<void> | null = null;

export function isRerankerEnabled(): boolean {
  return config.rerankerEnabled;
}

/** Idempotent; call before {@link scoreRelevance}. */
export async function ensureRerankerLoaded(): Promise<void> {
  if (!config.rerankerEnabled) return;
  if (session && tokenizer) return;
  if (!loading) {
    loading = (async () => {
      const t0 = Date.now();
      tokenizer = PhobertTokenizer.fromFile(config.tokenizerPath);
      session = await ort.InferenceSession.create(config.modelPath, {
        intraOpNumThreads: 2,
        graphOptimizationLevel: 'all',
      });
      log.info(`reranker loaded in ${Date.now() - t0}ms`, { model: config.modelPath });
    })().catch((err: unknown) => {
      // Same rule as `getBrowser`: a memoized REJECTED promise would make
      // every future call fail forever on what might have been a transient
      // load error. Clear it so the next call actually retries.
      loading = null;
      throw err;
    });
  }
  await loading;
}

/** Relevance of `passage` to `query` as a sigmoid probability in [0, 1]. */
export async function scoreRelevance(query: string, passage: string): Promise<number> {
  if (!session || !tokenizer) throw new Error('ensureRerankerLoaded() was not awaited');

  const ids = tokenizer.encodePair(query, passage, MAX_SEQ_LEN);
  const seqLen = ids.length;
  const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, seqLen]);
  const attentionMask = new ort.Tensor('int64', new BigInt64Array(seqLen).fill(1n), [1, seqLen]);

  const outputs = await session.run({ input_ids: inputIds, attention_mask: attentionMask });
  const firstKey = session.outputNames[0]!;
  const logits = outputs[firstKey]!.data as Float32Array;
  // Sigmoid is only correct for a single-logit head. Asserted rather than
  // just assumed — review flagged that a 2-logit classification head would
  // need softmax instead, and the measured 0.0005-vs-0.98 score separation
  // in the README is evidence for single-logit but was never actually
  // checked against the model's real output shape.
  if (logits.length !== 1) {
    throw new Error(`PhoRanker output has ${logits.length} logits, expected exactly 1 for sigmoid scoring`);
  }
  const score = 1 / (1 + Math.exp(-logits[0]!));
  // A NaN (e.g. from a genuinely empty output tensor slipping past the
  // check above in some other way) would otherwise silently poison the
  // `ranked.sort()` comparator in pipeline.ts and serialize as `null`.
  if (!Number.isFinite(score)) throw new Error('PhoRanker produced a non-finite score');
  return score;
}
