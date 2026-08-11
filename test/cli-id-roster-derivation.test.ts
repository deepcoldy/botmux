import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ALL_CLI_IDS, createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { discoverNativeCliSkillGroups } from '../src/core/skills/discovery.js';

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

  it('no test file re-types the roster as a stale literal', () => {
    // Both of these had drifted: cli-adapters dropped mojo/cursor/relay, and
    // slash-commands-doc-sync dropped mojo/reasonix while keeping a retired id —
    // so "the roster is single-sourced" was not actually true.
    for (const file of ['cli-adapters.test.ts', 'slash-commands-doc-sync.test.ts']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(src).toContain("ALL_CLI_IDS as REGISTRY_ALL_CLI_IDS");
      expect(src).not.toMatch(/const ALL_CLI_IDS: CliId\[\] = \['claude-code'/);
    }
  });
});

/**
 * Putting mojo in the roster was necessary but NOT sufficient: the dashboard
 * resolves skill directories through the *adapter*, so a roster entry whose
 * adapter declares no skillsDir is scanned into nothing. The first fix shipped
 * exactly that hole — roster green, mojo skills still 100% invisible — which is
 * why this asserts the discovered root rather than the roster membership.
 */
describe('native skill discovery reaches every CLI that ships skills', () => {
  it('discovers a mojo skills root, not an empty group', () => {
    const groups = discoverNativeCliSkillGroups(['mojo']);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.some(g => g.rootDir.endsWith('/.mojo/skills'))).toBe(true);
  });

  it('declares skillsDir for every CLI whose adapter claims a home dir of skills', () => {
    // Guard the general shape, not just mojo: an adapter that lists ~/.x in
    // authPaths and is known to keep skills there must say so explicitly,
    // because authPaths is a sandbox carve-out and never a skills source.
    const offenders: string[] = [];
    for (const id of ALL_CLI_IDS) {
      let adapter;
      try { adapter = createCliAdapterSync(id); } catch { continue; }
      const hasSkillSource = !!adapter.skillsDir || !!adapter.claudeDataDir;
      if (!hasSkillSource) continue;
      // If it claims a skill source, discovery must actually resolve a root.
      if (discoverNativeCliSkillGroups([id]).length === 0) offenders.push(id);
    }
    expect(offenders).toEqual([]);
  });
});
