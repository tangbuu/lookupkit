// One-off real verification (not part of the test suite) that the SSRF
// guard actually stops a redirect-to-private-IP chain end-to-end through
// the real fetch path, not just the isolated isUrlSafeToFetch() unit tests.
import http from 'node:http';
import { fetchAndExtract } from '../dist/fetch/fetchPage.js';

const attacker = http.createServer((req, res) => {
  res.writeHead(302, { Location: 'http://127.0.0.1:9/should-never-be-fetched' });
  res.end();
});

await new Promise((resolve) => attacker.listen(0, '127.0.0.1', resolve));
const port = attacker.address().port;
const url = `http://127.0.0.1:${port}/`;

console.log(`Fetching ${url} (redirects to a private-IP target) ...`);
const result = await fetchAndExtract(url);
console.log(JSON.stringify(result, null, 2));

attacker.close();

if (result.text !== null) {
  console.error('FAIL: SSRF guard did not block the redirect — content came back');
  process.exit(1);
}
console.log('PASS: navigation to the private-IP redirect target was blocked');
