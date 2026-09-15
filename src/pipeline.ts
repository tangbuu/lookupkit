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
 * again. Never recorded for a merely thin page: a perfectly good domain can
 * come back thin for one article and fine for the next, and blacklisting on
 * that would punish it forever for a problem that has since cleared.
 *
 * Two things review found broken here, both fixed below: (1) the match
 * regex was Chromium-only (`net::ERR_*`) while the shipped default engine
 * is WebKit, whose real messages ("A server with the specified hostname
 * could not be found.") never matched it at all — measured directly with
 * `page.goto()` against a nonexistent host under both engines — so
 * `deadHosts` was silently never populated under the shipped defaults; (2)
 * an entry never expired, so one transient DNS blip blacklisted a domain
 * for the rest of the process's life. Fixed with engine-agnostic phrase
 * matching plus a TTL and a size cap.
 */
const deadHosts = new Map<string, number>(); // host -> expiry epoch ms
const DEAD_HOST_TTL_MS = 10 * 60 * 1000;
const DEAD_HOST_CAP = 500;
const CONNECTION_ERROR_RE =
  /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_CLOSED|could not be found|couldn.t be completed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i;

function isHostDead(host: string): boolean {
  const expiry = deadHosts.get(host);
  if (expiry === undefined) return false;
  if (expiry < Date.now()) {
    deadHosts.delete(host);
    return false;
  }
  return true;
}

function markHostDead(host: string): void {
  if (deadHosts.size >= DEAD_HOST_CAP) {
    const oldest = deadHosts.keys().next().value;
    if (oldest !== undefined) deadHosts.delete(oldest);
  }
  deadHosts.set(host, Date.now() + DEAD_HOST_TTL_MS);
}

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
      if (host && isHostDead(host)) {
        rejected.push({ url: r.url, reason: 'host-recently-unreachable' });
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
  // Cancels every still-running candidate's fetch the moment one of them
  // answers confidently (or the batch runs out), instead of letting the
  // losers hold a browser context/fetch slot open until their own timeout
  // for an answer nobody will use — review found the early-return path
  // improved latency without freeing capacity, exactly backwards under load.
  const cancelRest = new AbortController();

  // A total deadline independent of any single candidate's own timeout: with
  // `withPage` now queuing behind a concurrency cap (see browser.ts), a
  // candidate can wait for a free slot before its own `fetchTimeoutMs` even
  // starts counting, so nothing upstream previously bounded the WHOLE
  // batch's wall-clock time. On expiry, whatever cleared the reranker
  // threshold so far still wins the same way an early return would.
  const settled = await Promise.race([
    new Promise<{ early: Candidate | null }>((resolve) => {
      let finished = false;
      let remaining = batch.length;

      const finish = (early: Candidate | null) => {
        if (finished) return;
        finished = true;
        cancelRest.abort();
        resolve({ early });
      };

      for (const result of batch) {
      void (async () => {
        try {
          const page = await fetchAndExtract(result.url, cancelRest.signal);
          if (page.text === null) {
            if (page.error && CONNECTION_ERROR_RE.test(page.error)) {
              const host = hostOf(result.url);
              if (host) markHostDead(host);
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
        } catch (err) {
          // Review found this uncaught: an exception here (e.g. the
          // reranker throwing because warmup silently failed) previously
          // left `remaining` never decremented and the whole lookup hung
          // forever. Recording it as a normal rejection instead keeps this
          // path behaving exactly like every other candidate failure.
          const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
          log.warn(`candidate ${result.url} threw`, message);
          rejected.push({ url: result.url, reason: message });
        }
      })().finally(() => {
        remaining -= 1;
        if (remaining === 0) finish(null);
      });
      }
    }),
    new Promise<{ early: Candidate | null }>((resolve) => {
      setTimeout(() => {
        cancelRest.abort();
        resolve({ early: null });
      }, config.lookupTimeoutMs);
    }),
  ]);

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
