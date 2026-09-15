/**
 * Task: isolate the REAL cost of concurrent `browser.newContext()` calls on
 * Playwright's bundled WebKit, separated from network variance.
 *
 * Hypothesis under test: the Dart reference implementation measured (by
 * reading `WKProcessPoolManager.swift`) that every `flutter_inappwebview`
 * headless webview — persistent and one-shot — shares ONE static OS-level
 * `WKProcessPool`, so N concurrent one-shot webviews cost ~15MB extra RSS
 * total. Playwright's WebKit is a portable, package-managed build, not the
 * OS's native WKWebView — it may not get that same pool sharing, so
 * `withPage()`'s 5-way-parallel fan-out (src/fetch/browser.ts) might carry
 * real per-context overhead the Dart app never paid.
 *
 * Method: a tiny local HTTP server serves an instant static page, so timing
 * differences come from context/page creation and Playwright's own
 * navigation bookkeeping, not from network latency or a remote server's
 * variance. For N in {1,3,5}, run N context+page+goto+close cycles two ways:
 *   - sequential: one cycle finishes before the next starts
 *   - parallel:   all N cycles run via Promise.all
 * over several rounds, and report wall-clock ms and REAL OS-level RSS
 * (summed over the browser's actual process tree via `ps`, not
 * `process.memoryUsage()`, which only sees this Node process — Playwright's
 * browser runs as a separate OS process/tree entirely).
 *
 * Usage: npx tsx scripts/probe-context-cost.mts
 */
import http from 'node:http';
import { execSync } from 'node:child_process';
import { webkit, type Browser } from 'playwright';

const ROUNDS = 5;
const LEVELS = [1, 3, 5];

// --- tiny local server: eliminates network variance ---
const PAGE = '<!doctype html><html><body><p>hi</p></body></html>';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address();
if (addr === null || typeof addr === 'string') throw new Error('bad server address');
const url = `http://127.0.0.1:${addr.port}/`;

// --- real OS-level RSS of the browser's whole process tree ---
function psTable(): Map<number, { ppid: number; rssKb: number }> {
  const out = execSync('ps -A -o pid=,ppid=,rss=').toString();
  const map = new Map<number, { ppid: number; rssKb: number }>();
  for (const line of out.trim().split('\n')) {
    const parts = line.trim().split(/\s+/).map(Number);
    if (parts.length < 3) continue;
    const [pid, ppid, rssKb] = parts;
    if (pid === undefined || ppid === undefined || rssKb === undefined) continue;
    map.set(pid, { ppid, rssKb });
  }
  return map;
}

function treeRssKb(rootPid: number): number {
  const table = psTable();
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  let total = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const entry = table.get(pid);
    if (entry) total += entry.rssKb;
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return total;
}

async function cycle(browser: Browser): Promise<number> {
  const t0 = performance.now();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await ctx.close();
  return performance.now() - t0;
}

function stats(xs: number[]): { mean: number; median: number; min: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  return { mean, median, min: s[0]!, max: s[s.length - 1]! };
}

console.log('Launching webkit...');
// `launchServer()` (unlike plain `launch()`) exposes the real spawned OS
// process, which is what we need to walk the process tree for RSS. Connect
// a normal `Browser` to it over its own websocket endpoint so the rest of
// the script uses the exact same public API `withPage()` does.
const browserServer = await webkit.launchServer();
const rootPid = browserServer.process().pid;
if (rootPid === undefined) throw new Error('no browser process pid — cannot measure RSS');
const browser = await webkit.connect(browserServer.wsEndpoint());

// Let the freshly launched browser settle before baselining RSS.
await new Promise((r) => setTimeout(r, 300));
const baselineRssKb = treeRssKb(rootPid);
console.log(`baseline browser-tree RSS: ${(baselineRssKb / 1024).toFixed(1)} MB (pid ${rootPid})\n`);

console.log(
  ['mode', 'N', 'round', 'wallMs', 'perOpMs', 'rssDeltaMB'].map((s) => s.padEnd(10)).join(''),
);

type Row = { mode: string; n: number; wallMs: number; rssDeltaMb: number };
const rows: Row[] = [];

for (const n of LEVELS) {
  for (const mode of ['sequential', 'parallel'] as const) {
    for (let round = 1; round <= ROUNDS; round++) {
      const rssBefore = treeRssKb(rootPid);
      const t0 = performance.now();
      if (mode === 'sequential') {
        for (let i = 0; i < n; i++) await cycle(browser);
      } else {
        await Promise.all(Array.from({ length: n }, () => cycle(browser)));
      }
      const wallMs = performance.now() - t0;
      // Contexts are already closed; let any teardown settle before reading RSS.
      await new Promise((r) => setTimeout(r, 150));
      const rssAfter = treeRssKb(rootPid);
      const rssDeltaMb = (rssAfter - rssBefore) / 1024;
      rows.push({ mode, n, wallMs, rssDeltaMb });
      console.log(
        [mode, String(n), String(round), wallMs.toFixed(0), (wallMs / n).toFixed(0), rssDeltaMb.toFixed(1)]
          .map((s) => s.padEnd(10))
          .join(''),
      );
    }
  }
}

console.log('\n--- summary (per level/mode, across rounds) ---');
console.log(['mode', 'N', 'meanWallMs', 'medianWallMs', 'meanPerOpMs', 'meanRssDeltaMB'].map((s) => s.padEnd(14)).join(''));
for (const n of LEVELS) {
  for (const mode of ['sequential', 'parallel'] as const) {
    const subset = rows.filter((r) => r.mode === mode && r.n === n);
    const wallStats = stats(subset.map((r) => r.wallMs));
    const rssStats = stats(subset.map((r) => r.rssDeltaMb));
    console.log(
      [
        mode,
        String(n),
        wallStats.mean.toFixed(0),
        wallStats.median.toFixed(0),
        (wallStats.mean / n).toFixed(0),
        rssStats.mean.toFixed(1),
      ]
        .map((s) => s.padEnd(14))
        .join(''),
    );
  }
}

const finalRssKb = treeRssKb(rootPid);
console.log(`\nfinal browser-tree RSS: ${(finalRssKb / 1024).toFixed(1)} MB (grew ${((finalRssKb - baselineRssKb) / 1024).toFixed(1)} MB over the whole run)`);

await browser.close();
await browserServer.close();
server.close();
