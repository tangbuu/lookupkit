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

const VALID_BROWSERS = ['webkit', 'firefox', 'chromium'] as const;
type ValidBrowser = (typeof VALID_BROWSERS)[number];

function browserEngine(name: string, fallback: ValidBrowser): ValidBrowser {
  const raw = str(name, fallback);
  if ((VALID_BROWSERS as readonly string[]).includes(raw)) return raw as ValidBrowser;
  // Review found an unchecked cast here meant a typo produced a server that
  // reports /healthz 200 and 500s on every real request forever (the
  // browser launcher lookup fails deep inside getBrowser(), which then
  // permanently latches the failure — see browser.ts). Fail at startup
  // instead, where a bad value is loud and obvious.
  // eslint-disable-next-line no-console
  console.error(`${name}=${raw} is not one of ${VALID_BROWSERS.join(', ')}`);
  process.exit(1);
}

export const config = {
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),

  /**
   * Browser engine for every fetch: `webkit` (default), `firefox` or
   * `chromium`. Read the comment in src/fetch/browser.ts before changing it —
   * Chromium is measurably blocked by search engines that serve WebKit fine.
   */
  browser: browserEngine('LOOKUPKIT_BROWSER', 'webkit'),

  /**
   * Engines raced per search. See the survey table in src/search/engines.ts —
   * which engines work depends heavily on `browser` above. Validity of each
   * name is checked by `resolveEngines()` at call time (unchanged); that
   * throw is per-request rather than at startup today, a smaller version of
   * the same "fail loud, fail early" gap as `browser` above, but left as-is
   * since it's exercised on every request rather than only at boot.
   */
  engines: str('LOOKUPKIT_ENGINES', 'duckduckgo,yahoo')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Hard cap on a single search-engine page load. */
  searchTimeoutMs: num('LOOKUPKIT_SEARCH_TIMEOUT_MS', 8000),

  /** Hard cap on a single candidate page load. */
  fetchTimeoutMs: num('LOOKUPKIT_FETCH_TIMEOUT_MS', 8000),

  /**
   * Hard cap on the WHOLE `/lookup` candidate-fetching phase, independent of
   * any single candidate's own `fetchTimeoutMs` — see the comment in
   * pipeline.ts on why a per-candidate cap alone doesn't bound the batch.
   */
  lookupTimeoutMs: num('LOOKUPKIT_LOOKUP_TIMEOUT_MS', 20000),

  /** How many search results to fetch in parallel for /lookup. */
  maxUrls: num('LOOKUPKIT_MAX_URLS', 5),

  /**
   * Process-wide cap on simultaneously open fetch contexts, across ALL
   * in-flight requests — see the comment on `withPage` in browser.ts. Sized
   * well above one request's own `maxUrls` so a single request never queues
   * against itself; it exists to bound concurrent REQUESTS, not one
   * request's own fan-out.
   */
  maxConcurrentFetches: num('LOOKUPKIT_MAX_CONCURRENT_FETCHES', 12),

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
