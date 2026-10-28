import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadShardTimings, planShards, selectShard } from '../scripts/duration-shards.mjs';
import { mergeShardTimings, parseShardLogs } from '../scripts/update-shard-timings.mjs';
import vitestConfig from '../vitest.config.ts';

/**
 * CI runs the unit suite as N jobs, each computing the same duration-balanced
 * plan on its own (scripts/duration-shards.mjs, wired in vitest.config.ts) and
 * running its slice. Nothing cross-checks the jobs at runtime: if the plan ever
 * left a file out, or gave it to two shards, every check would stay green while
 * a file silently stopped running. These tests pin that every file lands in
 * exactly one shard — on the real file list and table, and when the table is
 * stale, empty, or describes files that no longer exist.
 */
const ROOT = resolve(import.meta.dirname, '..');

// Mirrors the unit project's include/exclude in vitest.config.ts.
function unitTestFiles(dir = 'test'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (path !== 'test/e2e-browser' && entry.name !== 'node_modules') found.push(...unitTestFiles(path));
    } else if (/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith('.e2e.ts')) {
      found.push(path);
    }
  }
  return found;
}

const spec = (file: string, project = 'unit') => ({ moduleId: join(ROOT, file), project });

function shardsOf(files: string[], table: Parameters<typeof planShards>[1], count: number) {
  const specs = files.map(file => spec(file));
  return Array.from({ length: count }, (_, i) =>
    selectShard(specs, { root: ROOT, shard: { index: i + 1, count } }, table).map(s => s.moduleId),
  );
}

function expectExactCover(shards: string[][], files: string[]) {
  const all = shards.flat();
  expect(all).toHaveLength(files.length);
  expect(new Set(all)).toEqual(new Set(files.map(file => join(ROOT, file))));
}

const shuffled = <T,>(items: T[], seed: number) => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

describe('duration-balanced unit shards', () => {
  const files = unitTestFiles();
  const table = loadShardTimings();

  it('reads the committed timings table', () => {
    expect(Object.keys(table.files).length).toBeGreaterThan(0);
  });

  it('puts every unit test file in exactly one shard, for any shard count', () => {
    for (const count of [1, 2, 3, 4, 5, 6]) expectExactCover(shardsOf(files, table, count), files);
  });

  it('is what vitest itself uses to pick the files of `--shard=i/N`', async () => {
    const Sequencer = vitestConfig.test!.sequence!.sequencer! as unknown as new (ctx: unknown) => {
      shard(specs: unknown[]): Promise<unknown[]>;
    };
    const specs = files.map(file => spec(file));
    for (const index of [1, 2, 3, 4]) {
      const ctx = { config: { root: ROOT, shard: { index, count: 4 } } };
      expect(await new Sequencer(ctx).shard(specs)).toEqual(selectShard(specs, ctx.config));
    }
  });

  it('still covers every file exactly once when the table is stale, empty or unreadable', () => {
    const stale = { perFileOverhead: 0.5, files: { 'test/deleted-long-ago.test.ts': 900, [files[0]!]: 300 } };
    const unreadable = loadShardTimings(join(ROOT, 'test/no-such-shard-timings.json'));
    for (const t of [stale, { files: {} }, unreadable]) expectExactCover(shardsOf(files, t, 4), files);
  });

  it('gives every shard job the same plan whatever order vitest lists the files in', () => {
    const reference = planShards(files, table, 4);
    for (const seed of [1, 2, 3]) expect(planShards(shuffled(files, seed), table, 4)).toEqual(reference);
  });

  it('keeps the busiest shard within one file of the average load', () => {
    for (const count of [3, 4, 5]) {
      const plan = planShards(files, table, count);
      const loads = plan.map(shard => shard.load);
      const total = loads.reduce((sum, load) => sum + load, 0);
      // Unrecorded files weigh the median, never more than the heaviest recorded one.
      const heaviest = Math.max(...Object.values(table.files)) + table.perFileOverhead;
      expect(Math.max(...loads)).toBeLessThanOrEqual(total / count + heaviest + 1e-9);
    }
  });

  it('balances recorded time, not file count', () => {
    const t = {
      files: {
        'test/long.test.ts': 600,
        'test/mid-1.test.ts': 300,
        'test/mid-2.test.ts': 300,
        'test/short-1.test.ts': 1,
        'test/short-2.test.ts': 1,
        'test/short-3.test.ts': 1,
        'test/short-4.test.ts': 1,
      },
    };
    const plan = planShards(Object.keys(t.files), t, 2);
    // Both medium files go opposite the long one; an even split by count
    // would pair the long file with a medium one (900s against 300s).
    expect(plan.map(shard => shard.files.filter(file => !file.includes('short')))).toEqual([
      ['test/long.test.ts'],
      ['test/mid-1.test.ts', 'test/mid-2.test.ts'],
    ]);
    expect(plan.map(shard => shard.load)).toEqual([602, 602]);
  });

  it('weighs a file the table has never seen at the median recorded duration, plus start-up cost', () => {
    const t = { perFileOverhead: 0.5, files: { 'test/a.test.ts': 10, 'test/b.test.ts': 2, 'test/c.test.ts': 1, 'test/gone.test.ts': 1000 } };
    const plan = planShards(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/new.test.ts'], t, 1);
    // Median of the files being planned (10, 2, 1) is 2; the deleted file's 1000 must not count.
    expect(plan[0]!.load).toBe(10 + 2 + 1 + 2 + 4 * 0.5);
  });

  it('keeps a file listed by two projects in one shard', () => {
    const specs = [spec('test/a.test.ts', 'unit'), spec('test/a.test.ts', 'e2e'), spec('test/b.test.ts'), spec('test/c.test.ts')];
    const t = { files: { 'test/a.test.ts': 5, 'test/b.test.ts': 5, 'test/c.test.ts': 5 } };
    const picked = [1, 2, 3].map(index => selectShard(specs, { root: ROOT, shard: { index, count: 3 } }, t));
    const withA = picked.filter(shard => shard.some(s => s.moduleId.endsWith('a.test.ts')));
    expect(withA).toHaveLength(1);
    expect(withA[0]!.map(s => s.project).sort()).toEqual(['e2e', 'unit']);
    expect(picked.flat()).toHaveLength(specs.length);
  });

  it('rejects a shard index outside 1..count', () => {
    for (const index of [0, 5]) {
      expect(() => selectShard([spec('test/a.test.ts')], { root: ROOT, shard: { index, count: 4 } }, { files: {} })).toThrow();
    }
  });
});

describe('refreshing the timings table from CI logs', () => {
  const log = [
    '2026-10-27T20:56:01.1Z  \x1b[32m✓\x1b[39m \x1b[30;46m unit \x1b[49;39m test/a.test.ts \x1b[2m(3 tests)\x1b[22m\x1b[33m 1234\x1b[2mms\x1b[22m\x1b[39m',
    '2026-10-27T20:56:02.1Z  ❯ unit  test/b.test.ts (5 tests | 1 failed | 1 skipped) 2.5s',
    '2026-10-27T20:56:03.1Z  ✓ unit  test/a.test.ts (3 tests) 900ms',
    '2026-10-27T21:06:47.7Z  Test Files  1 failed | 2 passed (3)',
    '2026-10-27T21:06:47.7Z    Duration  9.89s (transform 1.00s, setup 500ms, import 1.50s, tests 4.61s, environment 78ms)',
  ].join('\n');

  it('takes each file’s duration (the slower one if a retry printed it twice) and the per-file start-up cost', () => {
    expect(parseShardLogs([log])).toEqual({ files: { 'test/a.test.ts': 1.234, 'test/b.test.ts': 2.5 }, perFileOverhead: 1 });
  });

  it('overwrites measured files, keeps unmeasured ones, drops deleted ones', () => {
    const previous = { perFileOverhead: 0.4, files: { 'test/a.test.ts': 50, 'test/kept.test.ts': 7, 'test/deleted.test.ts': 9 } };
    const next = mergeShardTimings(previous, parseShardLogs([log]), {
      source: 'run 1',
      exists: (file: string) => file !== 'test/deleted.test.ts',
    });
    expect(next).toEqual({
      source: 'run 1',
      perFileOverhead: 1,
      files: { 'test/a.test.ts': 1.23, 'test/b.test.ts': 2.5, 'test/kept.test.ts': 7 },
    });
  });
});
