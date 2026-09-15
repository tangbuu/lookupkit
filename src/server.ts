import http from 'node:http';
import { config } from './config.js';
import { closeBrowser, getBrowser } from './fetch/browser.js';
import { log } from './logger.js';
import { runLookup, runSearch } from './pipeline.js';
import { ensureRerankerLoaded, isRerankerEnabled } from './rank/reranker.js';
import { warmUpEngines } from './search/search.js';

// Defense in depth, not the primary fix: every fire-and-forget async path in
// this codebase (pipeline.ts's candidate loop, search.ts's engine race) was
// reviewed and now handles its own rejections explicitly. This exists in
// case a future change reintroduces the pattern review found — logging and
// staying up beats Node's default of tearing the whole process down over
// one candidate's error.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection (this should not happen — see server.ts)', String(reason));
});

const MAX_QUERY_LENGTH = 512;

/** Simple per-IP token bucket. Not a substitute for a real reverse-proxy
 * rate limiter in production, but the review's point stands even without
 * one: today there is NOTHING, so a single caller can drive unlimited
 * `/lookup` fan-out. */
const RATE_LIMIT_CAPACITY = 20;
const RATE_LIMIT_REFILL_PER_SEC = 1;
const buckets = new Map<string, { tokens: number; last: number }>();

function takeToken(ip: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip) ?? { tokens: RATE_LIMIT_CAPACITY, last: now };
  const elapsedSec = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + elapsedSec * RATE_LIMIT_REFILL_PER_SEC);
  bucket.last = now;
  if (bucket.tokens < 1) {
    buckets.set(ip, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(ip, bucket);
  return true;
}

// Bound the map's own growth — an unbounded number of distinct IPs would
// otherwise leak memory over the life of a long-running process.
const MAX_TRACKED_IPS = 10_000;
function pruneBucketsIfNeeded(): void {
  if (buckets.size <= MAX_TRACKED_IPS) return;
  const oldest = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, buckets.size - MAX_TRACKED_IPS);
  for (const [ip] of oldest) buckets.delete(ip);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    send(res, 200, { status: 'ok', reranker: isRerankerEnabled(), engines: config.engines });
    return;
  }

  const ip = req.socket.remoteAddress ?? 'unknown';
  if (!takeToken(ip)) {
    send(res, 429, { error: 'rate limit exceeded, slow down' });
    return;
  }
  pruneBucketsIfNeeded();

  const q = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim().slice(0, MAX_QUERY_LENGTH);

  if (url.pathname === '/search') {
    if (q === '') return send(res, 400, { error: 'missing required query parameter "q"' });
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || config.maxUrls));
    const { results, engines, ms } = await runSearch(q, limit);
    // SearxNG-shaped so an existing SEARXNG_API_URL consumer can be pointed
    // here unchanged. `suggestions` is always empty: this project scrapes
    // result links, it does not reproduce an engine's query suggestions.
    send(res, 200, {
      query: q,
      number_of_results: results.length,
      results: results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        engine: r.engine,
        engines: [r.engine],
      })),
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: [],
      unresponsive_engines: engines.filter((e) => e.error).map((e) => [e.engine, e.error]),
      lookupkit: { ms, engines },
    });
    return;
  }

  if (url.pathname === '/lookup') {
    if (q === '') return send(res, 400, { error: 'missing required query parameter "q"' });
    const result = await runLookup(q);
    // JSON.stringify, not raw interpolation: a query containing a
    // percent-decoded newline could otherwise forge a convincing extra log
    // line (review's "log injection" finding).
    log.info(
      `lookup ${JSON.stringify(q)} ${result.timings.totalMs}ms -> ` +
        (result.best ? `${result.best.url} score=${result.best.score ?? 'n/a'}` : 'no result'),
    );
    send(res, result.best ? 200 : 404, result);
    return;
  }

  send(res, 404, { error: `unknown endpoint ${url.pathname}`, endpoints: ['/search', '/lookup', '/healthz'] });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    // Full detail (which for a Playwright TimeoutError includes a
    // multi-line "Call log:" with internal navigation URLs/state) goes to
    // OUR log only — an unauthenticated caller gets a generic message, not
    // Playwright's internals (review's finding, inconsistent with
    // fetchPage.ts's own `.split('\n')[0]` treatment of the same class of
    // error).
    const message = err instanceof Error ? err.message : String(err);
    log.error('request failed', message);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
    else res.end();
  });
});

server.listen(config.port, config.host, () => {
  log.info(`lookupkit listening on http://${config.host}:${config.port}`, {
    engines: config.engines,
    reranker: isRerankerEnabled(),
  });
  // Pay the browser launch, the ~136MB model load, and the DNS+TCP+TLS
  // handshake to each search engine now, while nobody is waiting on a
  // request — see warmUpEngines' doc comment for why that last part runs
  // sequentially rather than racing every engine at once like a real
  // request does.
  void getBrowser()
    .then(() => warmUpEngines())
    .catch((e: unknown) => log.error('browser/search warmup failed', String(e)));
  if (isRerankerEnabled()) {
    void ensureRerankerLoaded().catch((e: unknown) => log.error('reranker warmup failed', String(e)));
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close();
    // Forces the exit even if `closeBrowser()` itself hangs (e.g. the
    // browser process is wedged) — otherwise the container sits until
    // Docker's own SIGKILL instead of exiting cleanly.
    const forceExit = setTimeout(() => process.exit(1), 5000);
    forceExit.unref();
    void closeBrowser().then(() => process.exit(0));
  });
}
