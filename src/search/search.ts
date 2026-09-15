import { config } from '../config.js';
import { withSearchPage } from '../fetch/browser.js';
import { log } from '../logger.js';
import { resolveEngines, type Engine, type SearchResult } from './engines.js';

export interface EngineOutcome {
  engine: string;
  ms: number;
  count: number;
  /** Set when the engine failed or was challenge-blocked. */
  error?: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  engines: EngineOutcome[];
}

/**
 * Appends `-site:` exclusions at the ENGINE level rather than filtering the
 * result list afterwards, so the engine backfills the slot with a different
 * result instead of the caller simply losing one. Both Yahoo and DuckDuckGo
 * document the operator; Bing honours it too.
 */
function withExclusions(query: string): string {
  if (config.excludedDomains.length === 0) return query;
  return `${query} ${config.excludedDomains.map((d) => `-site:${d}`).join(' ')}`;
}

async function runEngine(engine: Engine, query: string, limit: number): Promise<SearchResult[]> {
  return withSearchPage(async (page) => {
    await page.goto(engine.url(withExclusions(query)), {
      waitUntil: 'domcontentloaded',
      timeout: config.searchTimeoutMs,
    });
    const rows = await engine.extract(page, limit);
    // Belt-and-braces against an engine's markup listing the same result
    // twice; a duplicate would otherwise burn one of the parallel fetch slots.
    const seen = new Set<string>();
    return rows
      .filter((r) => !seen.has(r.url) && seen.add(r.url) !== undefined)
      .map((r) => ({ ...r, engine: engine.name }));
  });
}

/**
 * Fires one throwaway, discarded search per configured engine at server
 * startup, so the real DNS+TCP+TLS handshake to each search engine happens
 * before any user is waiting on it rather than during their first request.
 *
 * Sequential on purpose, not raced like {@link search} is: warming N engines
 * concurrently makes them contend for the same CPU/network at once, which
 * only matters here because it is a fixed, wasted cost paid once at boot
 * with nobody waiting — trading a slightly longer boot for a clean first
 * real request is a pure win. Racing at request time is a different
 * tradeoff (only one of the two is actually being waited on), which is why
 * {@link search} itself stays parallel.
 */
export async function warmUpEngines(query = 'warmup'): Promise<void> {
  const engines = resolveEngines(config.engines);
  for (const engine of engines) {
    const t0 = Date.now();
    try {
      await runEngine(engine, query, 1);
      log.info(`warmup search(${engine.name}) ${Date.now() - t0}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      log.warn(`warmup search(${engine.name}) failed after ${Date.now() - t0}ms`, message);
    }
  }
}

/**
 * Cache of exactly the one most recent (query, limit) search, so a repeat of
 * the immediately-previous call skips the network step entirely. Safe with
 * no staleness risk at all, unlike any cache keyed on age or size: an
 * IDENTICAL repeat query has no new information to invalidate it with,
 * so last call's answer is still this call's correct answer. Only the
 * single most recent entry is kept (not a general LRU) — this exists for
 * the "repeat/retry the same question" case, not as a general result store.
 */
let lastQuery: string | null = null;
let lastLimit: number | null = null;
let lastOutcome: SearchOutcome | null = null;

/**
 * Races every configured engine and returns the first NON-EMPTY result set.
 *
 * "First non-empty" rather than "first to finish" matters: a challenge-blocked
 * engine answers fast and empty, and letting that win would hand the caller an
 * empty page as if nothing existed. A blocked engine therefore costs its own
 * slot and nothing else — no error propagates to the caller, and nothing
 * hangs, because every engine runs under `searchTimeoutMs`.
 */
export async function search(query: string, limit = config.maxUrls): Promise<SearchOutcome> {
  if (query === lastQuery && limit === lastLimit && lastOutcome) {
    log.debug(`search cache hit for repeat query "${query}"`);
    return lastOutcome;
  }

  const engines = resolveEngines(config.engines);
  const outcomes: EngineOutcome[] = [];

  return new Promise<SearchOutcome>((resolve) => {
    let settled = false;
    let remaining = engines.length;

    const finish = (results: SearchResult[]) => {
      if (settled) return;
      settled = true;
      const outcome = { results, engines: outcomes };
      // Only a NON-EMPTY result is cached: caching a transient failure would
      // make a repeat of the same question keep failing for no reason, and
      // there is nothing here worth reusing in that case anyway.
      if (results.length > 0) {
        lastQuery = query;
        lastLimit = limit;
        lastOutcome = outcome;
      }
      resolve(outcome);
    };

    for (const engine of engines) {
      const t0 = Date.now();
      runEngine(engine, query, limit)
        .then(
          (results) => {
            outcomes.push({ engine: engine.name, ms: Date.now() - t0, count: results.length });
            log.debug(`search(${engine.name}) ${Date.now() - t0}ms -> ${results.length} results`);
            if (results.length > 0) finish(results);
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
            outcomes.push({ engine: engine.name, ms: Date.now() - t0, count: 0, error: message });
            log.warn(`search(${engine.name}) failed after ${Date.now() - t0}ms`, message);
          },
        )
        .finally(() => {
          remaining -= 1;
          if (remaining === 0) finish([]);
        });
    }
  });
}
