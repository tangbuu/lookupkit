/**
 * Approximate token count. Deliberately not a real BPE count: this is only
 * ever compared against coarse thresholds (the "page is too thin to be real
 * content" floor and the condenser budget), never used to bill an API.
 *
 * The 1.4 tokens/word factor was measured against tiktoken's o200k_base on
 * real Vietnamese prose in the reference implementation (1.31-1.55, mean
 * ~1.41).
 */
export function approxTokenCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return Math.round(trimmed.split(/\s+/).length * 1.4);
}
