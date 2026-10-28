#!/usr/bin/env node
// Refresh test/shard-timings.json — the per-file durations the CI shard
// planner (scripts/duration-shards.mjs) balances on — from a CI run's logs.
//
//   node scripts/update-shard-timings.mjs <run-id>            # needs `gh` auth
//   node scripts/update-shard-timings.mjs --logs a.log b.log  # saved job logs
//
// With a run id, every job named `test (i/N)` in that run is read. Use a run
// whose shards all finished: a shard that was cancelled or crashed simply
// contributes no lines, and its files keep their previous durations.
//
// Merge rule: a file measured in these logs takes the new duration; a file
// not measured keeps its old one; an entry whose test file no longer exists is
// dropped. The table is advisory — stale or missing entries only make the
// shards less even, they never drop a file from the run.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHARD_TIMINGS_PATH } from './duration-shards.mjs';

const ANSI = /\x1b\[[0-9;]*m/g;
// `✓ unit  test/foo.test.ts (12 tests | 1 skipped) 3456ms` — vitest's per-file line.
const FILE_LINE = /\bunit {1,2}(test\/\S+\.(?:test|spec)\.ts) \(\d+ tests?[^)]*\) (\d+(?:\.\d+)?)(ms|s)\b/;
// ` Test Files  518 passed | 2 skipped (520)` and
// ` Duration  669.89s (transform 33.63s, setup 11.23s, import 263.00s, tests …`
const FILES_LINE = /Test Files .*\((\d+)\)\s*$/;
const DURATION_LINE = /Duration .*\(transform (\d+(?:\.\d+)?)(ms|s), setup (\d+(?:\.\d+)?)(ms|s), import (\d+(?:\.\d+)?)(ms|s)/;

const seconds = (value, unit) => (unit === 'ms' ? Number(value) / 1000 : Number(value));

/** Per-file durations and the per-file start-up cost (transform + setup +
 *  import, which vitest reports only as shard totals) found in job logs. */
export function parseShardLogs(logs) {
  const files = {};
  let overheadSeconds = 0;
  let overheadFiles = 0;
  for (const log of logs) {
    let fileCount;
    for (const raw of String(log).split('\n')) {
      const line = raw.replace(ANSI, '');
      const file = FILE_LINE.exec(line);
      if (file) {
        const value = seconds(file[2], file[3]);
        // A shard retried by run-unit-shard.mjs prints a file twice; keep the slower.
        files[file[1]] = Math.max(files[file[1]] ?? 0, value);
        continue;
      }
      const count = FILES_LINE.exec(line);
      if (count) {
        fileCount = Number(count[1]);
        continue;
      }
      const duration = DURATION_LINE.exec(line);
      if (duration && fileCount) {
        overheadSeconds += seconds(duration[1], duration[2]) + seconds(duration[3], duration[4]) + seconds(duration[5], duration[6]);
        overheadFiles += fileCount;
        fileCount = undefined;
      }
    }
  }
  return { files, perFileOverhead: overheadFiles ? overheadSeconds / overheadFiles : undefined };
}

const round = value => Math.round(value * 100) / 100;

/** New table: measured files overwrite, unmeasured keep their old value,
 *  entries for deleted test files go. Keys sorted so diffs stay reviewable. */
export function mergeShardTimings(previous, measured, { source, exists }) {
  const merged = { ...(previous?.files ?? {}), ...measured.files };
  const files = {};
  for (const file of Object.keys(merged).sort()) {
    if (exists(file)) files[file] = round(merged[file]);
  }
  return {
    source,
    perFileOverhead: round(measured.perFileOverhead ?? previous?.perFileOverhead ?? 0),
    files,
  };
}

function fetchRunLogs(runId) {
  const jobs = JSON.parse(execFileSync('gh', [
    'api', '--paginate', `repos/{owner}/{repo}/actions/runs/${runId}/jobs`,
    '--jq', '[.jobs[] | select(.name | test("^test \\\\([0-9]+/[0-9]+\\\\)$")) | {id, name, conclusion}]',
  ], { encoding: 'utf8' }).replace(/\]\s*\[/g, ','));
  if (jobs.length === 0) throw new Error(`run ${runId} has no "test (i/N)" jobs`);
  return jobs.map(job => {
    if (job.conclusion !== 'success') console.error(`warning: ${job.name} concluded ${job.conclusion}; its files keep their old durations unless measured`);
    return execFileSync('gh', ['api', `repos/{owner}/{repo}/actions/jobs/${job.id}/logs`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  });
}

function main(argv) {
  let logs;
  let source;
  if (argv[0] === '--logs' && argv.length > 1) {
    logs = argv.slice(1).map(path => readFileSync(path, 'utf8'));
    source = `logs: ${argv.slice(1).join(', ')}`;
  } else if (argv.length === 1 && /^\d+$/.test(argv[0])) {
    logs = fetchRunLogs(argv[0]);
    source = `GitHub Actions run ${argv[0]}`;
  } else {
    console.error('usage: node scripts/update-shard-timings.mjs <run-id> | --logs <file>...');
    process.exit(2);
  }
  const measured = parseShardLogs(logs);
  const count = Object.keys(measured.files).length;
  if (count === 0) {
    console.error('no per-file durations found in the logs; table left unchanged');
    process.exit(1);
  }
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const previous = existsSync(SHARD_TIMINGS_PATH) ? JSON.parse(readFileSync(SHARD_TIMINGS_PATH, 'utf8')) : undefined;
  const next = mergeShardTimings(previous, measured, { source, exists: file => existsSync(join(repoRoot, file)) });
  writeFileSync(SHARD_TIMINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`measured ${count} files; table now has ${Object.keys(next.files).length} (per-file overhead ${next.perFileOverhead}s)`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main(process.argv.slice(2));
