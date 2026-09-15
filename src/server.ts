import http from 'node:http';
import { config } from './config.js';
import { closeBrowser, getBrowser } from './fetch/browser.js';
import { log } from './logger.js';
import { runLookup, runSearch } from './pipeline.js';
import { ensureRerankerLoaded, isRerankerEnabled } from './rank/reranker.js';

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

  const q = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim();

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
    log.info(
      `lookup "${q}" ${result.timings.totalMs}ms -> ` +
        (result.best ? `${result.best.url} score=${result.best.score ?? 'n/a'}` : 'no result'),
    );
    send(res, result.best ? 200 : 404, result);
    return;
  }

  send(res, 404, { error: `unknown endpoint ${url.pathname}`, endpoints: ['/search', '/lookup', '/healthz'] });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error('request failed', message);
    if (!res.headersSent) send(res, 500, { error: message });
    else res.end();
  });
});

server.listen(config.port, config.host, () => {
  log.info(`lookupkit listening on http://${config.host}:${config.port}`, {
    engines: config.engines,
    reranker: isRerankerEnabled(),
  });
  // Pay the browser launch and the ~136MB model load now, while nobody is
  // waiting on a request.
  void getBrowser().catch((e: unknown) => log.error('browser warmup failed', String(e)));
  if (isRerankerEnabled()) {
    void ensureRerankerLoaded().catch((e: unknown) => log.error('reranker warmup failed', String(e)));
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close();
    void closeBrowser().then(() => process.exit(0));
  });
}
