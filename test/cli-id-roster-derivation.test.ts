import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ALL_CLI_IDS } from '../src/adapters/cli/registry.js';

/**
 * `CliId[]` literals are checked for *bad* members but never for *missing*
 * ones, so a hand-maintained roster of "every CLI" goes stale in total silence.
 * dashboard.ts had exactly that: its `allCliIds` omitted both `reasonix` and
 * `mojo`, so those two CLIs' skill directories were never scanned.
 *
 * ALL_CLI_IDS is derived from the closed `Record<CliId, …>` that tsc does force
 * to be exhaustive. Keep every "all CLIs" consumer on it.
 */
describe('CLI id roster stays derived, not hand-typed', () => {
  it('exposes every CLI in the type union, including the remote ones', () => {
    const union = readFileSync(new URL('../src/adapters/cli/types.ts', import.meta.url), 'utf8')
      .split('\n')
      .find(line => line.startsWith('export type CliId ='));
    expect(union).toBeTruthy();
    const declared = [...union!.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]).sort();

    expect([...ALL_CLI_IDS].sort()).toEqual(declared);
    // Sentinel: the two ids that the stale literal actually dropped.
    expect(ALL_CLI_IDS).toContain('mojo');
    expect(ALL_CLI_IDS).toContain('reasonix');
  });

  it('keeps the dashboard skill scan on the derived roster', () => {
    const dashboard = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
    expect(dashboard).toContain('for (const cliId of ALL_CLI_IDS) ids.add(cliId);');
    // No re-typed union literal may come back: match a long inline CliId[] list.
    expect(dashboard).not.toMatch(/const allCliIds: CliId\[\] = \[/);
  });
});
