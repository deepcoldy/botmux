// HD2D office runtime assets — lazy, on-demand download + local cache.
//
// The Godot web build's heavy binaries (index.wasm ~36MB, index.pck ~38MB) are
// NOT shipped in the npm package or committed to git. They live as GitHub
// Release assets under a pinned tag and are downloaded on first use into
// `~/.botmux/cache/hd2d/<tag>/`, verified by SHA256, then served same-origin
// from `/game/*`. Bump the tag (and the specs below) only when the game itself
// changes — the assets are otherwise invariant across botmux versions, so a
// single canonical release avoids duplicating 74MB per version.

import {
  createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from '../utils/logger.js';
import { getReleaseStream, resolveHttpProxy } from '../core/release-download.js';

// The proxy-aware release download lives in core/release-download.ts so the
// binary self-update reuses this exact transport (redirect teardown, CONNECT
// tunnelling) rather than growing a second copy. Re-exported because callers
// and tests already import it from here.
export { resolveHttpProxy };

export const HD2D_ASSETS_TAG = 'hd2d-assets-v2';
const RELEASE_BASE_URL = `https://github.com/deepcoldy/botmux/releases/download/${HD2D_ASSETS_TAG}`;

interface AssetSpec { name: string; size: number; sha256: string; }

// Pinned to the binaries uploaded to the `hd2d-assets-v1` release. SHA256 is
// verified after download — a mismatch (corruption / tampering) discards the
// file rather than serving an unverified wasm blob.
const ASSETS: readonly AssetSpec[] = [
  { name: 'index.wasm', size: 37700666, sha256: '26b61ce95247012ab3dca3ff51e96d1cdbff44ee91a8c20a83e150afca83f1b6' },
  { name: 'index.pck', size: 40521520, sha256: '6016b257075cdfbb6d3ddea881b7a0eea09235d7972921ca73504379c5a29ee3' },
];

export const HD2D_CACHE_DIR = join(homedir(), '.botmux', 'cache', 'hd2d', HD2D_ASSETS_TAG);
const TOTAL_BYTES = ASSETS.reduce((s, a) => s + a.size, 0);

export type Hd2dState = 'absent' | 'downloading' | 'ready' | 'error';
export interface Hd2dStatus { state: Hd2dState; received: number; total: number; error?: string }

let downloading = false;
let received = 0;
let lastError: string | undefined;

/** Absolute cache path for a known asset, or null for anything not on the
 *  allow-list (defends the static route against path games). */
export function hd2dAssetPath(name: string): string | null {
  return ASSETS.some(a => a.name === name) ? join(HD2D_CACHE_DIR, name) : null;
}

function assetReady(a: AssetSpec): boolean {
  try { return statSync(join(HD2D_CACHE_DIR, a.name)).size === a.size; }
  catch { return false; }
}

export function hd2dStatus(): Hd2dStatus {
  if (downloading) return { state: 'downloading', received, total: TOTAL_BYTES };
  if (ASSETS.every(assetReady)) return { state: 'ready', received: TOTAL_BYTES, total: TOTAL_BYTES };
  if (lastError) return { state: 'error', received, total: TOTAL_BYTES, error: lastError };
  return { state: 'absent', received: 0, total: TOTAL_BYTES };
}

async function sha256File(fp: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(fp), hash);
  return hash.digest('hex');
}

const DOWNLOAD_UA = 'botmux-hd2d';

async function downloadAsset(a: AssetSpec): Promise<void> {
  if (assetReady(a)) return; // already cached + correct size — bytes pre-counted
  mkdirSync(HD2D_CACHE_DIR, { recursive: true });
  const dest = join(HD2D_CACHE_DIR, a.name);
  const tmp = join(HD2D_CACHE_DIR, `.${a.name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const res = await getReleaseStream(`${RELEASE_BASE_URL}/${a.name}`, resolveHttpProxy(), DOWNLOAD_UA);
  // Count bytes via an in-stream Transform — NOT a `res.on('data')` listener,
  // which would flip the source into flowing mode and race pipeline's pull-based
  // consumption (dropping early chunks / stalling the download).
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) { received += chunk.length; cb(null, chunk); },
  });
  try {
    await pipeline(res, counter, createWriteStream(tmp));
    const got = await sha256File(tmp);
    if (got !== a.sha256) throw new Error(`${a.name} SHA256 校验不通过`);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Idempotently kick off the asset download. Returns the current status
 *  immediately; callers poll `/api/game/status` for progress. */
export function startHd2dDownload(): Hd2dStatus {
  if (downloading || ASSETS.every(assetReady)) return hd2dStatus();
  downloading = true;
  lastError = undefined;
  // Pre-count any already-cached assets so progress reflects total work left.
  received = ASSETS.filter(assetReady).reduce((s, a) => s + a.size, 0);
  void (async () => {
    try {
      for (const a of ASSETS) await downloadAsset(a);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logger.warn(`[hd2d] asset download failed: ${lastError}`);
    } finally {
      downloading = false;
    }
  })();
  return hd2dStatus();
}
