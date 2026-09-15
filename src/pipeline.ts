import { config } from './config.js';
import { fetchAndExtract } from './fetch/fetchPage.js';
import { log } from './logger.js';
import { condenseByBm25 } from './rank/condense.js';
import { ensureRerankerLoaded, isRerankerEnabled, scoreRelevance } from './rank/reranker.js';
import { search, type EngineOutcome } from './search/search.js';
import type { SearchResult } from './search/engines.js';

export interface Candidate {
  url: string;
  title: string;
  /** Condensed, query-relevant passage extracted from the page. */
  passage: string;
  /** PhoRanker cross-encoder relevance in [0, 1], or null if reranking is off. */
  score: number | null;
  /** Which extractor tier produced the text. */
  extractor: 'readability' | 'heuristic' | 'empty' | null;
  /** Wall-clock ms for this candidate's fetch + extract. */
  fetchMs: number;
}

export interface LookupResult {
  query: string;
  /** Highest-scoring candidate, or null when nothing usable was found. */
  best: Candidate | null;
  /** Runners-up, best first. Excludes `best`. */
  candidates: Candidate[];
  /**
   * True when `best` crossed `confidentThreshold` and the pipeline returned
   * without waiting for the remaining candidates. False means every candidate
   * finished and the highest-scoring one was taken anyway.
   */
  confident: boolean;
  threshold: number;
  timings: {
    totalMs: number;
    searchMs: number;
    engines: EngineOutcome[];
  };
  /** URLs that produced nothing usable, with the reason. */
  rejected: { url: string; reason: string }[];
}

/**
 * Hosts that returned a hard connection/DNS error THIS process. Skipped on
 * later lookups so they cannot burn a candidate slot and the fetch timeout
 * again. In memory only, and never recorded for a merely thin page: a
 * perfectly good domain can come back thin for one article and fine for the
 * next, and a persisted blacklist would then punish it forever for a problem
 * that has since cleared.
 */
const deadHosts = new Set<string>();
const CONNECTION_ERROR_RE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_CLOSED/;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Raw search results only — the cheap path behind `GET /search`. */
export async function runSearch(query: string, limit: number): Promise<{
  results: SearchResult[];
  engines: EngineOutcome[];
  ms: number;
}> {
  const t0 = Date.now();
  const { results, engines } = await search(query, limit);
  return { results, engines, ms: Date.now() - t0 };
}

/**
 * The full pipeline behind `GET /lookup`: search, fetch every candidate in
 * parallel, extract, condense against the query, score with the cross-encoder.
 *
 * Returns as soon as ONE candidate crosses `confidentThreshold` instead of
 * waiting for the whole batch — on easy factual queries some page usually
 * clears the bar early, and the slowest candidate in a batch of five often
 * costs several seconds on its own. If nothing crosses it, the best-scoring
 * candidate is returned anyway rather than an error: the model has real
 * false negatives, and discarding a correct answer over one is worse than
 * handing the caller a score it can judge for itself.
 */
export async function runLookup(query: string): Promise<LookupResult> {
  const t0 = Date.now();
  if (isRerankerEnabled()) await ensureRerankerLoaded();

  const searchStart = Date.now();
  const { results, engines } = await search(query, config.maxUrls);
  const searchMs = Date.now() - searchStart;
  const rejected: { url: string; reason: string }[] = [];

  const batch = results
    .filter((r) => {
      const host = hostOf(r.url);
      if (host && deadHosts.has(host)) {
        rejected.push({ url: r.url, reason: 'host previously unreachable this process' });
        return false;
      }
      return true;
    })
    .slice(0, config.maxUrls);

  const base = {
    query,
    threshold: config.confidentThreshold,
    timings: { totalMs: 0, searchMs, engines },
    rejected,
  };

  if (batch.length === 0) {
    return { ...base, best: null, candidates: [], confident: false, timings: { totalMs: Date.now() - t0, searchMs, engines } };
  }

  const done: Candidate[] = [];

  const settled = await new Promise<{ early: Candidate | null }>((resolve) => {
    let finished = false;
    let remaining = batch.length;

    const finish = (early: Candidate | null) => {
      if (finished) return;
      finished = true;
      resolve({ early });
    };

    for (const result of batch) {
      void (async () => {
        const page = await fetchAndExtract(result.url);
        if (page.text === null) {
          if (page.error && CONNECTION_ERROR_RE.test(page.error)) {
            const host = hostOf(result.url);
            if (host) deadHosts.add(host);
          }
          rejected.push({ url: result.url, reason: page.error ?? 'no content' });
          return;
        }

        const passage = condenseByBm25(page.text, query, { tokenBudget: config.tokenBudget });
        if (passage === '') {
          rejected.push({ url: result.url, reason: 'nothing survived condensing' });
          return;
        }

        const score = isRerankerEnabled() ? await scoreRelevance(query, passage) : null;
        const candidate: Candidate = {
          url: result.url,
          title: result.title,
          passage,
          score,
          extractor: page.tier,
          fetchMs: page.ms,
        };
        done.push(candidate);
        log.debug(`candidate ${result.url} score=${score ?? 'n/a'}`);

        if (score !== null && score >= config.confidentThreshold) finish(candidate);
      })().finally(() => {
        remaining -= 1;
        if (remaining === 0) finish(null);
      });
    }
  });

  const ranked = [...done].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = settled.early ?? ranked[0] ?? null;

  return {
    ...base,
    best,
    candidates: ranked.filter((c) => c !== best),
    confident: settled.early !== null,
    timings: { totalMs: Date.now() - t0, searchMs, engines },
  };
}
