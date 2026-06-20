// Validates opaque-dir landing (#8 + #10) with a REAL overlay opaque dir.
//   - a REPLACED dir (exists in lower) → stale lower files dropped on land
//   - a NEW dir (not in lower)         → mkdir only, never rm -rf unrelated files
import { applySandboxDiff, computeSandboxDiff } from '../dist/services/sandbox-land.js';
import { mountOverlay, unmountOverlay } from '../dist/adapters/backend/sandbox.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = (k, v) => console.log(`${k}=${v}`);
const base = mkdtempSync(join(tmpdir(), 'opq-'));
const lower = join(base, 'lower');     // the REAL project (overlay lower)
const dataDir = join(base, 'data');
const sid = 'opq';
const sessionRoot = join(dataDir, 'sandboxes', sid);
const upper = join(sessionRoot, 'proj-upper');
const work = join(sessionRoot, 'proj-work');
const merged = join(sessionRoot, 'proj-merged');

// Lower (real project): an existing dir with stale files + a top file.
mkdirSync(join(lower, 'replaceme', 'sub'), { recursive: true });
writeFileSync(join(lower, 'replaceme', 'stale-top.txt'), 'STALE TOP\n');
writeFileSync(join(lower, 'replaceme', 'sub', 'stale-deep.txt'), 'STALE DEEP\n');
writeFileSync(join(lower, 'keep.txt'), 'keep me\n');

const ok = mountOverlay({ lower, upper, work, merged });
out('MOUNT', ok);
if (!ok) process.exit(1);
// prepareSandbox records this; the probe mounts directly so write it ourselves.
writeFileSync(join(sessionRoot, 'meta.json'), JSON.stringify({ projectLower: lower }));

// Agent in the merged view: wholesale-replace `replaceme/` and create a NEW dir.
rmSync(join(merged, 'replaceme'), { recursive: true, force: true });
mkdirSync(join(merged, 'replaceme'), { recursive: true });
writeFileSync(join(merged, 'replaceme', 'fresh.txt'), 'FRESH\n');
mkdirSync(join(merged, 'brandnew'), { recursive: true });
writeFileSync(join(merged, 'brandnew', 'n.txt'), 'NEW\n');

// Build a landing TARGET = a copy of the real lower (the actual repo to land into),
// drifted: it ALSO has a concurrent file under the brand-new dir path.
const target = join(base, 'target');
cpSync(lower, target, { recursive: true });
mkdirSync(join(target, 'brandnew'), { recursive: true });
writeFileSync(join(target, 'brandnew', 'concurrent.txt'), 'DO NOT DELETE\n');

const d = computeSandboxDiff(dataDir, sid);
out('DIFF_OK', d.ok); out('DIFF_FILES', d.ok ? d.files : 'n/a');

const a = applySandboxDiff(target, dataDir, sid);
out('APPLY_OK', a.ok); if (!a.ok) out('APPLY_ERR', a.error);

// Assertions:
out('REPLACED_STALE_TOP_GONE', !existsSync(join(target, 'replaceme', 'stale-top.txt')));   // want true
out('REPLACED_STALE_DEEP_GONE', !existsSync(join(target, 'replaceme', 'sub', 'stale-deep.txt'))); // want true
out('REPLACED_FRESH_PRESENT', existsSync(join(target, 'replaceme', 'fresh.txt')));         // want true
out('NEWDIR_CONCURRENT_SURVIVES', existsSync(join(target, 'brandnew', 'concurrent.txt'))); // want true (no clobber)
out('NEWDIR_FILE_PRESENT', existsSync(join(target, 'brandnew', 'n.txt')));                 // want true
out('UNRELATED_KEEP_SURVIVES', existsSync(join(target, 'keep.txt')));                      // want true

unmountOverlay(merged);
out('DONE', 'ok');
