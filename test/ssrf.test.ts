import assert from 'node:assert/strict';
import test from 'node:test';
import { isUrlSafeToFetch } from '../src/fetch/ssrf.js';

// Review's SSRF finding, exercised offline: `localhost`/`127.0.0.1` resolve
// via the system resolver with no network hit, which is enough to prove the
// private-range check actually runs on the RESOLVED address, not just the
// hostname string.
test('rejects loopback and private-range targets', async () => {
  assert.equal((await isUrlSafeToFetch('http://127.0.0.1/')).safe, false);
  assert.equal((await isUrlSafeToFetch('http://localhost/')).safe, false);
  assert.equal((await isUrlSafeToFetch('http://[::1]/')).safe, false);
});

test('rejects non-http(s) schemes before any DNS lookup', async () => {
  assert.equal((await isUrlSafeToFetch('file:///etc/passwd')).safe, false);
  assert.equal((await isUrlSafeToFetch('javascript:alert(1)')).safe, false);
});

test('rejects an unparsable URL rather than throwing', async () => {
  const result = await isUrlSafeToFetch('not a url');
  assert.equal(result.safe, false);
});

test('allows a real public target', async () => {
  // example.com is IANA-reserved for documentation and always resolves to a
  // stable public IP — a real DNS hit, deliberately, to prove the "allow"
  // path also works and this isn't a check that only ever says no.
  const result = await isUrlSafeToFetch('https://example.com/');
  assert.equal(result.safe, true);
});
