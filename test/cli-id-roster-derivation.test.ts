import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ALL_CLI_IDS, createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { discoverNativeCliSkillGroups } from '../src/core/skills/discovery.js';
import { resolveSkillInjectionSupport, type SkillInjectionSupport } from '../src/skills/injection-mode.js';
import type { CliId } from '../src/adapters/cli/types.js';

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

  it('pins each CLI to a reviewed skill-delivery classification', () => {
    // The previous version of this guard was circular: it skipped any adapter
    // with no skill source, i.e. exactly the adapters that FORGOT to declare one
    // (the mojo bug). It could never have caught a repeat.
    //
    // A closed Record<CliId, …> instead: tsc forces a new CLI to be classified,
    // so adding one is a deliberate decision, and dropping a skillsDir from an
    // adapter classified 'global' turns this red.
    const EXPECTED: Readonly<Record<CliId, SkillInjectionSupport>> = {
      // per-session --plugin-dir (claude family)
      'claude-code': 'dynamic', seed: 'dynamic', relay: 'dynamic',
      // shared global skills dir → global|prompt|off all apply
      coco: 'global', codex: 'global', cursor: 'global', gemini: 'global',
      genius: 'global', opencode: 'global', mtr: 'global', traex: 'global',
      // Added by upstream #821; shares ~/.config/opencode/skills with opencode,
      // so the shared-root dedup below covers it.
      opencode2: 'global',
      pi: 'global', 'oh-my-pi': 'global', grok: 'global', 'kiro-cli': 'global',
      reasonix: 'global', mojo: 'global',
      // no skill mechanism at all
      aiden: 'none', 'codex-app': 'none', antigravity: 'none', hermes: 'none',
      // Added by upstream #858: a bundled Node JSON-RPC runner with no skills dir.
      dsh: 'none',
      mira: 'none', mir: 'none', copilot: 'none', kimi: 'none', riff: 'none',
    };
    // Two-way key equality. `Record<CliId, …>` looks like tsc enforces
    // exhaustiveness, but this file lives in test/ and tsconfig only includes
    // `src/**/*` — nothing type-checks it. So a DELETED CLI would leave a stale
    // entry here forever, and the loop below would never visit it. Compare the
    // key sets in both directions at runtime instead of trusting the annotation.
    const expectedIds = Object.keys(EXPECTED).sort();
    expect(expectedIds, 'stale or missing entries in EXPECTED').toEqual([...ALL_CLI_IDS].sort());

    for (const id of ALL_CLI_IDS) {
      expect(resolveSkillInjectionSupport(id), `support for ${id}`).toBe(EXPECTED[id]);
    }
  });

  it('makes every "global" CLI resolve a real discovery root', () => {
    // Complements the classification: 'global' is derived from skillsDir being
    // set, so this proves the declared dir is also reachable by discovery
    // (the roster/adapter/discovery chain, end to end).
    const offenders = ALL_CLI_IDS.filter(id =>
      resolveSkillInjectionSupport(id) === 'global'
      && discoverNativeCliSkillGroups([id]).length === 0);
    // Shared-root dedup means a CLI can legitimately yield no group of its own
    // when an earlier CLI already claimed the same dir, so allow that case only.
    const unexplained = offenders.filter(id => {
      const dir = createCliAdapterSync(id).skillsDir;
      return !ALL_CLI_IDS.some(other => other !== id
        && createCliAdapterSync(other).skillsDir === dir
        && discoverNativeCliSkillGroups([other]).length > 0);
    });
    expect(unexplained).toEqual([]);
  });
});
