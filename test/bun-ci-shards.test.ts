import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { bunSuiteHash, parseBunRunnerArgs, selectBunShard } from '../scripts/bun-test-shards.mjs';
import { mergeBunShardReports } from '../scripts/merge-bun-test-timings.mjs';

const names = Array.from({ length: 97 }, (_, i) => `test/file-${i}.test.ts`);

function reportsFor(files = names, count = 4) {
  return Array.from({ length: count }, (_, i) => {
    const selected = selectBunShard(files, { index: i + 1, count }, { files: {} });
    return {
      schemaVersion: 1, runtime: 'bun', revision: 'revision', runId: 'run', complete: true,
      shard: { index: i + 1, count }, suite: { count: files.length, hash: bunSuiteHash(files) },
      plannedCount: selected.length,
      files: selected.map(file => ({ file, seconds: 1, ok: true })),
    };
  });
}

describe('Bun runner arguments and duration shards', () => {
  it('consumes runner flags while preserving Bun test options', () => {
    for (const args of [
      ['--shard=2/4', '--timings-output=out.json', '--bail'],
      ['--shard', '2/4', '--timings-output', 'out.json', '--bail'],
    ]) {
      expect(parseBunRunnerArgs(args)).toEqual({
        selfCheck: false, shard: { index: 2, count: 4 }, timingsOutput: 'out.json', extraArgs: ['--bail'],
      });
    }
    expect(parseBunRunnerArgs(['--self-check']).selfCheck).toBe(true);
  });

  it('rejects invalid slices and refuses to label a self-check as suite evidence', () => {
    for (const args of [
      ['--shard=0/4'], ['--shard=5/4'], ['--shard=1/0'], ['--shard=1.5/4'],
      ['--shard=1/9007199254740992'], ['--shard'], ['--shard='],
      ['--shard=1/4', '--shard=2/4'], ['--self-check', '--shard=1/4'],
      ['--self-check', '--timings-output=out.json'], ['--timings-output'],
    ]) expect(() => parseBunRunnerArgs(args)).toThrow();
  });

  it('covers the current file list exactly once with missing, stale, or unequal weights', () => {
    for (const table of [
      { files: {} },
      { files: { [names[0]!]: 600, [names[1]!]: 300, 'test/deleted.test.ts': 9000 } },
    ]) {
      const slices = [1, 2, 3, 4].map(index => selectBunShard(names, { index, count: 4 }, table));
      expect(slices.flat()).toHaveLength(names.length);
      expect(new Set(slices.flat())).toEqual(new Set(names));
      expect([1, 2, 3, 4].map(index => selectBunShard([...names].reverse(), { index, count: 4 }, table))).toEqual(slices);
    }
  });

  it('starts long files first and preserves the unsharded command population', () => {
    const files = ['test/short.test.ts', 'test/long.test.ts', 'test/mid.test.ts'];
    expect(selectBunShard(files, undefined)).toEqual(files);
    expect(selectBunShard(files, { index: 1, count: 1 }, {
      files: { [files[0]!]: 1, [files[1]!]: 100, [files[2]!]: 10 },
    })).toEqual([files[1], files[2], files[0]]);
  });
});

describe('Bun timing evidence and complete coverage', () => {
  it('merges all completed slices into a separate runtime timing table', () => {
    const reports = reportsFor();
    reports[0]!.files[0]!.seconds = 0.00234;
    const merged = mergeBunShardReports(reports, 4);
    expect(Object.keys(merged.files).sort()).toEqual([...names].sort());
    expect(merged.files[reports[0]!.files[0]!.file]).toBe(0.002);
    expect(merged.perFileOverhead).toBe(0);
    expect(mergeBunShardReports([...reports].reverse(), 4)).toEqual(merged);
  });

  it('rejects missing or duplicate shards, incomplete runs, failures, and invalid durations', () => {
    const mutations = [
      (reports: ReturnType<typeof reportsFor>) => { reports.pop(); },
      (reports: ReturnType<typeof reportsFor>) => { reports[1] = reports[0]!; },
      (reports: ReturnType<typeof reportsFor>) => { reports[0]!.complete = false; },
      (reports: ReturnType<typeof reportsFor>) => { reports[0]!.files[0]!.ok = false; },
      (reports: ReturnType<typeof reportsFor>) => { reports[0]!.files[0]!.seconds = NaN; },
      (reports: ReturnType<typeof reportsFor>) => { reports[0]!.files[0]!.seconds = 0; },
      (reports: ReturnType<typeof reportsFor>) => { reports[0]!.revision = 'other'; },
      (reports: ReturnType<typeof reportsFor>) => { reports.forEach(report => { report.revision = ''; }); },
      (reports: ReturnType<typeof reportsFor>) => { reports[0]!.runId = 'other'; },
      (reports: ReturnType<typeof reportsFor>) => { reports[0]!.suite.hash = 'other'; },
      (reports: ReturnType<typeof reportsFor>) => { reports[0]!.plannedCount += 1; },
    ];
    for (const mutate of mutations) {
      const reports = reportsFor();
      mutate(reports);
      expect(() => mergeBunShardReports(reports, 4)).toThrow();
    }
  });

  it('detects duplicated execution and omissions even when each local count agrees', () => {
    const duplicate = reportsFor();
    duplicate[1]!.files[0]!.file = duplicate[0]!.files[0]!.file;
    expect(() => mergeBunShardReports(duplicate, 4)).toThrow(/more than once/);
    const omission = reportsFor();
    omission[0]!.files.pop();
    omission[0]!.plannedCount -= 1;
    expect(() => mergeBunShardReports(omission, 4)).toThrow(/cover/);
    const replacement = reportsFor();
    replacement[0]!.files[0]!.file = 'test/uncollected.test.ts';
    expect(() => mergeBunShardReports(replacement, 4)).toThrow(/cover/);
  });

  it('refuses unbound local evidence that could mix different source revisions', () => {
    const local = reportsFor().map(report => ({ ...report, revision: null, runId: null }));
    expect(() => mergeBunShardReports(local, 4)).toThrow(/identity/);
  });
});

// 源码结构护栏(K4)：核对 GitHub 执行的分片矩阵、命令、证据上传与必需检查的一致性。
describe('Bun CI matrix and stable required check', () => {
  const ci = parse(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8'));
  const shards = ci.jobs['bun-test-shards'];
  const aggregate = ci.jobs['bun-test'];
  const count = shards.strategy.matrix.shard.length;

  it('runs every slice and uploads a distinct artifact even on failure', () => {
    expect(shards.strategy.matrix.shard).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(shards.strategy['fail-fast']).toBe(false);
    expect(shards.name).toBe(`bun-test (\${{ matrix.shard }}/${count})`);
    const run = shards.steps.find((step: { run?: string }) => step.run?.includes('--shard='));
    expect(run.run).toBe(`bun run test:bun -- --shard=\${{ matrix.shard }}/${count} --timings-output=artifacts/bun-shard-\${{ matrix.shard }}.json`);
    const upload = shards.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.if).toBe('always()');
    expect(upload.with.name).toBe('bun-test-timings-${{ matrix.shard }}');
    expect(upload.with.path).toBe('artifacts/bun-shard-${{ matrix.shard }}.json');
    expect(upload.with['if-no-files-found']).toBe('error');
    // Re-run failed jobs must replace their partial evidence, not fail on an
    // artifact-name conflict or let the aggregator read the previous failure.
    expect(upload.with.overwrite).toBe(true);
  });

  it('keeps bun-test required and refuses any non-success shard result', () => {
    expect(aggregate.name ?? 'bun-test').toBe('bun-test');
    expect(aggregate.needs).toBe('bun-test-shards');
    expect(aggregate.if).toBe('always()');
    const guard = aggregate.steps[0].run;
    expect(guard).toContain('${{ needs.bun-test-shards.result }}');
    expect(guard).toMatch(/^\s*success\) exit 0 ;;$/m);
    expect(guard).toMatch(/^\s*\*\).*exit 1 ;;$/m);
    const merge = aggregate.steps.find((step: { run?: string }) => step.run?.includes('merge-bun-test-timings'));
    expect(merge.run).toBe(`node scripts/merge-bun-test-timings.mjs artifacts/bun-shards --shards=${count} --output=artifacts/bun-shard-timings.json`);
    const upload = aggregate.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.with.overwrite).toBe(true);
  });
});
