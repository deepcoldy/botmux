#!/usr/bin/env node
import { appendFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunSuiteHash, writeBunTimingReport } from './bun-test-shards.mjs';

/** The stable required check validates actual execution across every shard. */
export function mergeBunShardReports(reports, count) {
  if (!Number.isSafeInteger(count) || count < 1 || reports.length !== count) {
    throw new Error(`expected ${count} Bun shard reports, found ${reports.length}`);
  }
  const first = reports[0];
  const indexes = new Set();
  const measured = new Map();
  for (const report of reports) {
    if (report.schemaVersion !== 1 || report.runtime !== 'bun' || report.complete !== true) {
      throw new Error('Bun shard report is unsupported or incomplete');
    }
    if (typeof report.revision !== 'string' || !report.revision || typeof report.runId !== 'string' || !report.runId) {
      throw new Error('Bun timing merge requires CI revision and run identity; unbound local reports are diagnostic only');
    }
    const { index, count: total } = report.shard ?? {};
    if (total !== count || !Number.isInteger(index) || index < 1 || index > count || indexes.has(index)) {
      throw new Error('missing, duplicate, or inconsistent Bun shard index');
    }
    indexes.add(index);
    if (report.revision !== first.revision || report.runId !== first.runId
      || report.suite?.hash !== first.suite?.hash || report.suite?.count !== first.suite?.count) {
      throw new Error('Bun shard reports describe different revisions, runs, or suites');
    }
    if (!Array.isArray(report.files) || report.files.length === 0 || report.files.length !== report.plannedCount) {
      throw new Error(`shard ${index} did not execute every planned file`);
    }
    for (const result of report.files) {
      if (typeof result.file !== 'string' || !/^test\/.+\.(test|spec)\.ts$/.test(result.file)
        || result.file.split('/').includes('..') || result.ok !== true
        || !Number.isFinite(result.seconds) || result.seconds <= 0) {
        throw new Error(`invalid or failing Bun file result: ${result.file}`);
      }
      if (measured.has(result.file)) throw new Error(`Bun file ran more than once: ${result.file}`);
      measured.set(result.file, result.seconds);
    }
  }
  const names = [...measured.keys()].sort();
  if (names.length !== first.suite?.count || bunSuiteHash(names) !== first.suite?.hash) {
    throw new Error('Bun shards do not cover the collected suite exactly once');
  }
  return {
    source: `GitHub Actions run ${first.runId}`,
    // Measured from process launch through cleanup, including startup/setup.
    perFileOverhead: 0,
    files: Object.fromEntries(names.map(file => [file, Math.max(0.001, Math.round(measured.get(file) * 1000) / 1000)])),
  };
}

function readReports(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return readReports(path);
    return /^bun-shard-\d+\.json$/.test(entry.name) ? [JSON.parse(readFileSync(path, 'utf8'))] : [];
  });
}

function main(argv) {
  const [dir, shardArg, outputArg] = argv;
  if (argv.length !== 3 || !/^--shards=\d+$/.test(shardArg ?? '') || !outputArg?.startsWith('--output=')) {
    throw new Error('usage: node scripts/merge-bun-test-timings.mjs <artifact-dir> --shards=N --output=<file>');
  }
  const output = outputArg.slice('--output='.length);
  if (!output) throw new Error('--output requires a file');
  const table = mergeBunShardReports(readReports(dir), Number(shardArg.slice('--shards='.length)));
  writeBunTimingReport(output, table);
  const slowest = Object.entries(table.files).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const summary = [
    `Validated ${Object.keys(table.files).length} Bun files across ${shardArg.slice('--shards='.length)} shards, each executed exactly once.`,
    '', '| Slowest file | Wall time (s) |', '|---|---:|',
    ...slowest.map(([file, seconds]) => `| ${file} | ${seconds} |`), '',
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

// Loaders may add URL queries; Node and Bun also resolve entry symlinks differently.
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    // Importing from an eval has no physical entry file.
    return false;
  }
}
if (isMain()) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
