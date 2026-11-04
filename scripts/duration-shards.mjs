// Duration-balanced test sharding for CI (`vitest --shard=i/N`).
//
// Vitest's own sharding hashes each file path and cuts the sorted list into N
// runs of equal FILE COUNT. A handful of multi-minute integration files decide
// a shard's wall clock, so equal counts gave walls of 8 to 19 minutes on the
// same run — the slowest one brushing the 20-minute job limit.
//
// planShards() instead deals files out by recorded duration: heaviest first,
// each into the currently lightest shard (longest-processing-time greedy).
// Fully deterministic — every shard job computes the same plan independently
// from the same inputs, so the shards never overlap and never miss a file.
//
// Durations come from test/shard-timings.json (seconds per file, as vitest
// reports them). A file without a recorded duration — new, renamed, or simply
// absent from the last measurement — is weighed at the median of the known
// durations. A stale table can only make the shards less even; it can never
// drop or duplicate a file, because the plan is built from the files vitest
// actually collected, not from the table. Refresh the table with
// scripts/update-shard-timings.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARD_TIMINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'shard-timings.json');

/** The recorded table: seconds per file, keyed by repo-relative posix path,
 *  plus the per-file start-up cost (transform + setup + import) vitest only
 *  reports as shard totals. A missing or unreadable table yields no entries —
 *  every file then weighs the same and the plan is an even split by count. */
export function loadShardTimings(path = SHARD_TIMINGS_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return normalizeTimings(parsed);
  } catch {
    return { perFileOverhead: 0, files: {} };
  }
}

function normalizeTimings(table) {
  const files = {};
  const raw = table && typeof table === 'object' ? table.files : undefined;
  if (raw && typeof raw === 'object') {
    for (const [file, seconds] of Object.entries(raw)) {
      if (isPositive(seconds)) files[file] = seconds;
    }
  }
  const overhead = table && typeof table === 'object' ? table.perFileOverhead : undefined;
  return { perFileOverhead: isPositive(overhead) ? overhead : 0, files };
}

const isPositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Split `files` into `count` shards balanced by duration.
 *
 * @param {readonly string[]} files repo-relative posix paths vitest collected
 * @param {{ perFileOverhead?: number; files?: Record<string, number> }} table see loadShardTimings
 * @param {number} count number of shards (>= 1)
 * @returns {{ files: string[]; load: number }[]} one entry per shard, in shard order
 */
export function planShards(files, table, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid shard count: ${count}`);
  const { perFileOverhead, files: recorded } = normalizeTimings(table);
  const unique = [...new Set(files)];
  const fallback = median(unique.map(file => recorded[file]).filter(isPositive));
  const weighed = unique
    .map(file => ({ file, weight: (recorded[file] ?? fallback) + perFileOverhead }))
    // Heaviest first; equal weights in path order, so the plan never depends
    // on the order vitest happened to list the files in.
    .sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], load: 0 }));
  for (const { file, weight } of weighed) {
    let target = 0;
    for (let i = 1; i < count; i += 1) {
      if (shards[i].load < shards[target].load) target = i;
    }
    shards[target].files.push(file);
    shards[target].load += weight;
  }
  return shards;
}

/**
 * The test specifications vitest's `--shard=index/count` should run: the
 * sequencer hook (vitest.config.ts) hands every collected specification in,
 * and gets back the ones planned for this shard. Specifications that share a
 * file (the same file in two projects) stay together.
 *
 * @template {{ moduleId: string }} Spec
 * @param {readonly Spec[]} specs
 * @param {{ root: string; shard: { index: number; count: number } }} config
 * @param {{ perFileOverhead?: number; files?: Record<string, number> }} [table]
 * @returns {Spec[]}
 */
export function selectShard(specs, { root, shard }, table = loadShardTimings()) {
  const { index, count } = shard;
  if (!Number.isInteger(index) || index < 1 || index > count) throw new Error(`invalid shard ${index}/${count}`);
  const byFile = new Map();
  for (const spec of specs) {
    const file = relative(root, spec.moduleId).split(sep).join('/');
    const group = byFile.get(file);
    if (group) group.push(spec);
    else byFile.set(file, [spec]);
  }
  return planShards([...byFile.keys()], table, count)[index - 1].files.flatMap(file => byFile.get(file));
}
