import { Bm25Okapi, tokenize } from './bm25.js';
import { approxTokenCount } from './tokenBudget.js';

const HEADING_RE = /^#{1,6}\s/;
const CITATION_RE = /^\d+\.\s*(\^|↑)/;
const ARCHIVE_LINK_RE = /lưu trữ.*wayback machine/i;

function paragraphsOf(fullText: string): string[] {
  return fullText
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== '' && !HEADING_RE.test(p) && !CITATION_RE.test(p) && !ARCHIVE_LINK_RE.test(p));
}

export interface CondenseOptions {
  tokenBudget?: number;
  bm25TopN?: number;
}

/**
 * Shrinks an extracted page down to ~`tokenBudget` tokens, keeping the lines
 * most relevant to `question` and restoring their original document order
 * (so the passage still reads as continuous text, not a scoreboard).
 *
 * Scoring happens per LINE, which is why the extractors must preserve line
 * boundaries — and why table rows are joined into one line each: a row split
 * across lines separates a label ("SJC") from its number ("146,000"), and the
 * number-only line then matches no query term and gets dropped.
 */
export function condenseByBm25(
  fullText: string,
  question: string,
  { tokenBudget = 200, bm25TopN = 15 }: CondenseOptions = {},
): string {
  const paragraphs = paragraphsOf(fullText);
  if (paragraphs.length === 0) return '';

  const bm25 = new Bm25Okapi(paragraphs.map(tokenize));
  const scores = bm25.scores(tokenize(question));

  const ranked = paragraphs
    .map((_, i) => i)
    .sort((a, b) => scores[b]! - scores[a]!)
    .slice(0, bm25TopN);

  const selected: number[] = [];
  let total = 0;
  for (const i of ranked) {
    const t = approxTokenCount(paragraphs[i]!);
    if (total + t > tokenBudget) {
      if (selected.length === 0) {
        // Top-scoring line alone already blows the budget: return a prefix of
        // it rather than nothing at all.
        const ratio = tokenBudget / t;
        const cut = Math.min(paragraphs[i]!.length, Math.max(0, Math.floor(paragraphs[i]!.length * ratio)));
        return paragraphs[i]!.slice(0, cut);
      }
      continue;
    }
    selected.push(i);
    total += t;
  }

  selected.sort((a, b) => a - b);
  return selected.map((i) => paragraphs[i]!).join('\n');
}
