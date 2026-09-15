/**
 * Real end-to-end timing for /lookup against a running server.
 * Usage: npx tsx scripts/bench.mts [runs]
 */
const BASE = process.env.LOOKUPKIT_URL ?? 'http://127.0.0.1:8080';
const runs = Number(process.argv[2] ?? 3);

const queries = [
  'giá vàng SJC hôm nay',
  'thời tiết Hà Nội ngày mai',
  'tỷ giá USD hôm nay',
  'what is the capital of Australia',
  'who wrote the novel Dune',
];

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log('query'.padEnd(34), 'runs', 'median', 'min', 'max', 'searchMed', 'score(med)', 'confident');
const all: number[] = [];
for (const q of queries) {
  const totals: number[] = [];
  const searches: number[] = [];
  const scores: number[] = [];
  let confident = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/lookup?q=${encodeURIComponent(q)}`);
    const body = (await res.json()) as {
      best: { score: number | null } | null;
      confident: boolean;
      timings: { totalMs: number; searchMs: number };
    };
    totals.push(Date.now() - t0);
    searches.push(body.timings.searchMs);
    if (body.best?.score != null) scores.push(body.best.score);
    if (body.confident) confident += 1;
    await new Promise((r) => setTimeout(r, 1500)); // be a good citizen
  }
  all.push(...totals);
  console.log(
    q.padEnd(34),
    String(runs).padStart(4),
    String(median(totals)).padStart(6),
    String(Math.min(...totals)).padStart(5),
    String(Math.max(...totals)).padStart(5),
    String(median(searches)).padStart(9),
    (scores.length ? median(scores).toFixed(3) : 'n/a').padStart(10),
    `${confident}/${runs}`,
  );
}
console.log(`\nALL RUNS  n=${all.length}  median=${median(all)}ms  min=${Math.min(...all)}ms  max=${Math.max(...all)}ms`);
