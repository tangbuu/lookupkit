import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// `dist/config.js` at runtime, `src/config.ts` under tsx — both are one
// level below the repo root.
export const repoRoot = path.resolve(here, '..');

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export const config = {
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),

  /**
   * Browser engine for every fetch: `webkit` (default), `firefox` or
   * `chromium`. Read the comment in src/fetch/browser.ts before changing it —
   * Chromium is measurably blocked by search engines that serve WebKit fine.
   */
  browser: str('LOOKUPKIT_BROWSER', 'webkit') as 'webkit' | 'firefox' | 'chromium',

  /**
   * Engines raced per search. See the survey table in src/search/engines.ts —
   * which engines work depends heavily on `browser` above.
   */
  engines: str('LOOKUPKIT_ENGINES', 'duckduckgo,yahoo')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Hard cap on a single search-engine page load. */
  searchTimeoutMs: num('LOOKUPKIT_SEARCH_TIMEOUT_MS', 8000),

  /** Hard cap on a single candidate page load. */
  fetchTimeoutMs: num('LOOKUPKIT_FETCH_TIMEOUT_MS', 8000),

  /** How many search results to fetch in parallel for /lookup. */
  maxUrls: num('LOOKUPKIT_MAX_URLS', 5),

  /** Approximate token budget for the condensed passage. */
  tokenBudget: num('LOOKUPKIT_TOKEN_BUDGET', 200),

  /**
   * PhoRanker score at or above which a candidate is "good enough" and the
   * pipeline returns immediately without waiting for the slower candidates.
   * 0.5 is the threshold validated in the reference implementation.
   */
  confidentThreshold: num('LOOKUPKIT_CONFIDENT_THRESHOLD', 0.5),

  /** Set to "0" to run the pipeline without the cross-encoder (BM25 order only). */
  rerankerEnabled: str('LOOKUPKIT_RERANKER', '1') !== '0',

  modelPath: str('LOOKUPKIT_MODEL_PATH', path.join(repoRoot, 'models', 'phoranker_int8.onnx')),
  tokenizerPath: str(
    'LOOKUPKIT_TOKENIZER_PATH',
    path.join(repoRoot, 'models', 'phoranker_tokenizer.json'),
  ),

  /**
   * Empty (the default) sends the browser engine's own user agent. Claiming to
   * be Chrome from a WebKit engine is a detectable inconsistency and measured
   * here it gained nothing.
   */
  userAgent: str('LOOKUPKIT_USER_AGENT', ''),

  /**
   * Excluded at the ENGINE level via the `-site:` operator rather than
   * filtered afterwards, so the engine backfills the slot with another
   * result instead of the caller simply losing one.
   */
  excludedDomains: str('LOOKUPKIT_EXCLUDED_DOMAINS', 'youtube.com,facebook.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  logLevel: str('LOOKUPKIT_LOG_LEVEL', 'info'),
} as const;
