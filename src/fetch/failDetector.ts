/**
 * Catches fetches that "succeed" while returning nothing usable: an empty
 * body, a body too thin to contain an answer, or a "this site needs
 * JavaScript" placeholder.
 */

export const MIN_TOKEN_LEN = 50;

const JS_REQUIRED_PATTERNS: RegExp[] = [
  /javascript.{0,20}(disabled|required|enable)/i,
  /enable.{0,20}javascript/i,
  /bạn cần bật javascript/i,
  /vui lòng bật javascript/i,
  /turn on javascript/i,
  /javascript is not available/i,
];

export interface FetchFailure {
  failed: boolean;
  reason?: string;
}

export function detectFetchFailure(
  content: string | null,
  tokenCount: number,
  minTokenLen = MIN_TOKEN_LEN,
): FetchFailure {
  if (content === null || content.trim() === '') return { failed: true, reason: 'empty content' };
  if (tokenCount < minTokenLen) {
    return { failed: true, reason: `too short (${tokenCount} tokens < ${minTokenLen})` };
  }
  for (const pattern of JS_REQUIRED_PATTERNS) {
    if (pattern.test(content)) {
      return { failed: true, reason: `javascript-required placeholder (${pattern.source})` };
    }
  }
  return { failed: false };
}
