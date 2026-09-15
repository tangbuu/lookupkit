import { config } from '../config.js';
import { withPage } from '../fetch/browser.js';
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
  return withPage(async (page) => {
    await page.goto(engine.url(withExclusions(query)), {
      waitUntil: 'domcontentloaded',
      timeout: config.searchTimeoutMs,
    });
    const rows = await engine.extract(page, limit);
    return rows.map((r) => ({ ...r, engine: engine.name }));
  });
}

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
  const engines = resolveEngines(config.engines);
  const outcomes: EngineOutcome[] = [];

  return new Promise<SearchOutcome>((resolve) => {
    let settled = false;
    let remaining = engines.length;

    const finish = (results: SearchResult[]) => {
      if (settled) return;
      settled = true;
      resolve({ results, engines: outcomes });
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
