#!/usr/bin/env node
// Downloads the PhoRanker int8 ONNX model if it is not already present with
// the correct checksum. Review found the 135.76MB (129.5MiB) file committed
// directly to git makes the repo UNPUSHABLE — GitHub hard-rejects any file
// over 100MiB, this is 129.5MiB, so `git push` fails outright, not just a
// "consider LFS" nice-to-have. History was rewritten (`git filter-repo`) to
// remove it; this script is how the file gets onto disk again, at Docker
// build time or a fresh local checkout, without ever going through git.
//
// A GitHub Release asset, not git-lfs: LFS's free bandwidth tier is 1GB per
// month, which a single 130MB file exhausts after ~8 clones — after that,
// every clone fails for everyone until someone pays. A Release asset has no
// such limit.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const modelPath = path.join(repoRoot, 'models', 'phoranker_int8.onnx');

// Filled in once a real GitHub Release exists for this repo — publishing
// the release asset and updating this URL is a required step before this
// script can download on a machine that doesn't already have the file
// on disk (fresh clone, CI, or a from-scratch Docker build without it
// baked into the build context). Overridable so a fork can point at its
// own release without editing this file.
const DEFAULT_MODEL_URL =
  'https://github.com/REPLACE_WITH_OWNER/lookupkit/releases/download/v0.1.0/phoranker_int8.onnx';
const MODEL_URL = process.env.LOOKUPKIT_MODEL_URL ?? DEFAULT_MODEL_URL;

// Computed from the actual file this project ships — verify what you
// downloaded actually matches, since this is executable-adjacent model
// weight, not inert data.
const EXPECTED_SHA256 = 'e78ef22c0a8ada6780b0cdd9f041aa2eb785e04293f73c531ec346e78c6103f7';

async function sha256(filePath) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function main() {
  if (existsSync(modelPath)) {
    const actual = await sha256(modelPath);
    if (actual === EXPECTED_SHA256) {
      console.log(`models/phoranker_int8.onnx already present, checksum verified (${actual}).`);
      return;
    }
    console.error(
      `models/phoranker_int8.onnx exists but checksum is ${actual}, expected ${EXPECTED_SHA256} — refusing to use it. Delete it and re-run to fetch a fresh copy.`,
    );
    process.exit(1);
  }

  if (MODEL_URL.includes('REPLACE_WITH_OWNER')) {
    console.error(
      'models/phoranker_int8.onnx is missing and no LOOKUPKIT_MODEL_URL is set (the built-in default is a placeholder — see this script\'s DEFAULT_MODEL_URL comment). Either place the file at models/phoranker_int8.onnx yourself, or set LOOKUPKIT_MODEL_URL to a real download location.',
    );
    process.exit(1);
  }

  console.log(`Downloading PhoRanker model from ${MODEL_URL} ...`);
  await mkdir(path.dirname(modelPath), { recursive: true });
  const tmpPath = `${modelPath}.download`;
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) {
    console.error(`Download failed: HTTP ${res.status}`);
    process.exit(1);
  }
  await pipeline(res.body, createWriteStream(tmpPath));

  const actual = await sha256(tmpPath);
  if (actual !== EXPECTED_SHA256) {
    await unlink(tmpPath).catch(() => undefined);
    console.error(`Downloaded file checksum ${actual} does not match expected ${EXPECTED_SHA256} — deleted, not using it.`);
    process.exit(1);
  }
  await rename(tmpPath, modelPath);
  console.log(`Downloaded and verified models/phoranker_int8.onnx (${actual}).`);
}

await main();
