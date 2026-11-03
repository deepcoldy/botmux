import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The unit suite runs as N vitest shards plus one aggregator job. The ruleset
 * requires only the aggregator's name, `test`, so the shard count can change
 * without touching repository settings — but only if every place that encodes
 * N agrees and the aggregator still fails whenever any shard does.
 *
 * What a drift would do, silently and with every check green:
 *   • matrix lists fewer shards than `--shard=i/N` divides into → the files in
 *     the missing slice never run;
 *   • matrix lists more → two jobs run the same slice, and one slice is skipped
 *     in a sibling count;
 *   • the aggregator stops depending on the shards, or stops running when one
 *     fails (`if: always()`), or accepts a non-success result → a red or
 *     cancelled shard (the 20-minute limit) no longer blocks merge.
 *
 * Machine-checkable consistency of the workflow file (not src text), so these
 * assertions read the parsed YAML that GitHub executes.
 */
const CI = parse(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf-8')) as {
  jobs: Record<string, {
    name?: string;
    needs?: string | string[];
    if?: string;
    strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: unknown } };
    steps?: Array<{ name?: string; run?: string }>;
  }>;
};

const shardJob = CI.jobs.test;
const shards = shardJob?.strategy?.matrix?.shard;
const count = Array.isArray(shards) ? shards.length : 0;

describe('unit test shards in ci.yml', () => {
  it('lists every shard exactly once, numbered 1..N', () => {
    expect(count).toBeGreaterThan(0);
    expect(shards).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  it('divides the suite into the same N the matrix runs', () => {
    expect(shardJob.name).toBe(`test (\${{ matrix.shard }}/${count})`);
    const unitSteps = (shardJob.steps ?? []).filter(step => step.run?.includes('--shard='));
    expect(unitSteps).toHaveLength(1);
    expect(unitSteps[0]!.run).toBe(`bun run test -- --shard=\${{ matrix.shard }}/${count}`);
    expect(unitSteps[0]!.name).toBe(`Unit tests (shard \${{ matrix.shard }}/${count})`);
    // A red shard must not cancel the others: their walls are the evidence
    // for the next shard-count decision.
    expect(shardJob.strategy?.['fail-fast']).toBe(false);
  });

  it('reports one check named `test` that is green only when every shard succeeded', () => {
    const aggregators = Object.values(CI.jobs).filter(job => job.name === 'test');
    expect(aggregators).toHaveLength(1);
    const aggregator = aggregators[0]!;
    const needs = Array.isArray(aggregator.needs) ? aggregator.needs : [aggregator.needs];
    expect(needs).toContain('test');
    // Without always() a failed or cancelled shard skips the aggregator, and a
    // skipped required check does not block.
    expect(aggregator.if).toBe('always()');
    const script = (aggregator.steps ?? []).map(step => step.run ?? '').join('\n');
    expect(script).toContain('${{ needs.test.result }}');
    expect(script).toMatch(/^\s*success\) exit 0 ;;$/m);
    expect(script).toMatch(/^\s*\*\).*exit 1 ;;$/m);
  });
});
