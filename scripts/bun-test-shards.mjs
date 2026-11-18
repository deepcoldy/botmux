import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShardTimings, planShards } from './duration-shards.mjs';

export const BUN_SHARD_TIMINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'bun-shard-timings.json');

/** Runner flags must never reach `bun test`, whose sharding semantics differ. */
export function parseBunRunnerArgs(argv) {
  const options = { selfCheck: false, shard: undefined, timingsOutput: undefined, extraArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-check') {
      options.selfCheck = true;
      continue;
    }
    const flag = ['--shard', '--timings-output'].find(name => arg === name || arg.startsWith(`${name}=`));
    if (!flag) {
      options.extraArgs.push(arg);
      continue;
    }
    const value = arg === flag ? argv[++i] : arg.slice(flag.length + 1);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--timings-output') {
      if (options.timingsOutput) throw new Error('duplicate --timings-output');
      options.timingsOutput = value;
    } else {
      if (options.shard) throw new Error('duplicate --shard');
      const match = /^(\d+)\/(\d+)$/.exec(value);
      const index = Number(match?.[1]);
      const count = Number(match?.[2]);
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || count < 1 || index > count) {
        throw new Error(`invalid shard ${value}; expected index/count with 1 <= index <= count`);
      }
      options.shard = { index, count };
    }
  }
  if (options.selfCheck && (options.shard || options.timingsOutput)) {
    throw new Error('--self-check cannot produce suite timings or select a shard');
  }
  return options;
}

/** Bootstrap with Node estimates until a complete Bun run supplies its own table. */
export function loadBunShardTimings() {
  return existsSync(BUN_SHARD_TIMINGS_PATH) ? loadShardTimings(BUN_SHARD_TIMINGS_PATH) : loadShardTimings();
}

export function selectBunShard(files, shard, timings = loadBunShardTimings()) {
  if (!shard) return [...files];
  const { index, count } = shard;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || count < 1 || index > count) {
    throw new Error(`invalid shard ${index}/${count}`);
  }
  // planShards keeps the heaviest files first within each slice, too.
  return planShards(files, timings, count)[index - 1].files;
}

export function bunSuiteHash(files) {
  return createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex');
}

/** A killed job leaves a readable, explicitly incomplete checkpoint for upload. */
export function writeBunTimingReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, path);
}
