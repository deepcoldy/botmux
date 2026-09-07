#!/usr/bin/env node
// Run `bun run test -- --shard=i/N`, retry once if the only failure is vitest's
// pool reporting "Worker exited unexpectedly" AFTER every test file already passed.
//
// Measured on CI shard 3 (PR #1288): 416 files / 7374 tests green, then
// `ChildProcess.emitUnexpectedExit` during teardown. Same shard reran green.
// Sharding only slices the file list (sha1 of the path, then a contiguous
// range) — it does not change isolate/forks. A mid-file crash still shows
// `Test Files … failed` and is NOT retried.
//
// The retry reruns the whole shard (~400 files), not "the failed file":
// this flake class has zero failed files (that's the predicate). A
// failed-file rerun would have nothing to run. Worst measured ~7m23s;
// the job timeout is 20m.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ANSI = /\x1b\[[0-9;]*m/g;

export function isWorkerExitAfterAllFilesPassed(output) {
  const plain = String(output).replace(ANSI, '');
  if (!plain.includes('Worker exited unexpectedly')) return false;
  const filesLine = plain.split('\n').find(line => line.includes('Test Files'));
  if (!filesLine) return false;
  return filesLine.includes('passed') && !/\bfailed\b/.test(filesLine);
}

function runShard(shard) {
  return new Promise(resolvePromise => {
    const chunks = [];
    const child = spawn('bun', ['run', 'test', '--', `--shard=${shard}`], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const tap = stream => chunk => {
      chunks.push(chunk);
      stream.write(chunk);
    };
    child.stdout.on('data', tap(process.stdout));
    child.stderr.on('data', tap(process.stderr));
    child.on('error', err => {
      resolvePromise({ code: 1, out: `${chunks.join('')}\n${err.message}` });
    });
    child.on('close', code => {
      resolvePromise({ code: code ?? 1, out: chunks.join('') });
    });
  });
}

async function main() {
  const shard = process.argv[2] ?? '';
  if (!/^\d+\/\d+$/.test(shard)) {
    console.error('usage: node scripts/run-unit-shard.mjs <index>/<count>');
    process.exit(2);
  }
  const first = await runShard(shard);
  if (first.code === 0) process.exit(0);
  if (isWorkerExitAfterAllFilesPassed(first.out)) {
    console.error(
      '\n[run-unit-shard] retrying once: every test file passed, vitest worker exited in teardown\n',
    );
    const second = await runShard(shard);
    process.exit(second.code);
  }
  process.exit(first.code);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await main();
}
