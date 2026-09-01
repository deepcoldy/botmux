import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The store reads config.session.dataDir lazily via a getter backed by
// SESSION_DATA_DIR, so pointing that env at a temp dir isolates each test.
import {
  readCustomizationState,
  customizationEnabled,
  setCustomizationEnabled,
  setPromptOverride,
  setConditionalLine,
  setSkillOverrideBody,
  setSkillDisabled,
  readSkillOverrideBody,
  resetAllToFactory,
  rollbackToSnapshot,
  listSnapshots,
  replaceState,
  invalidateCustomizationCache,
  MAX_SKILL_BODY_BYTES,
} from '../src/services/customization-store.js';
import {
  effectiveBuiltinSkills,
  effectiveBuiltinSkillContent,
  resolveConditionalLine,
  isBuiltinSkillDisabled,
} from '../src/skills/effective-builtins.js';
import { BUILTIN_SKILLS } from '../src/skills/definitions.js';

let tmp: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'botmux-custom-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmp;
  invalidateCustomizationCache();
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  invalidateCustomizationCache();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('customization store — baseline (RED LINE: byte-identical when empty)', () => {
  it('reads an empty state and reports enabled by default', () => {
    expect(readCustomizationState()).toEqual({ schemaVersion: 1 });
    expect(customizationEnabled()).toBe(true);
  });

  it('effectiveBuiltinSkills equals the shipped list when there are no overrides', () => {
    const eff = effectiveBuiltinSkills([...BUILTIN_SKILLS]);
    expect(eff).toEqual(BUILTIN_SKILLS);
    // And it never mutates the input.
    expect(eff).not.toBe(BUILTIN_SKILLS);
  });

  it('effectiveBuiltinSkillContent returns shipped content untouched', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(effectiveBuiltinSkillContent(s.name, s.content)).toBe(s.content);
    }
  });

  it('resolveConditionalLine returns the shipped default with no override', () => {
    expect(resolveConditionalLine('ai.routing.no_visible_output_ok', false)).toBe(false);
    expect(resolveConditionalLine('ai.routing.no_visible_output_ok', true)).toBe(true);
  });
});

describe('prompt-key overrides', () => {
  it('sets and clears a per-locale override', () => {
    setPromptOverride('zh', 'ai.routing.intro', '自定义开场白');
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides?.zh?.['ai.routing.intro']).toBe('自定义开场白');
    // Other locale untouched.
    expect(readCustomizationState().promptOverrides?.en).toBeUndefined();

    setPromptOverride('zh', 'ai.routing.intro', null);
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides).toBeUndefined();
  });

  it('rejects an oversized override', () => {
    const huge = 'x'.repeat(20 * 1024);
    expect(() => setPromptOverride('zh', 'ai.routing.intro', huge)).toThrow(/too_large/);
  });

  it('master off suppresses overrides (byte-identical fallthrough)', () => {
    setPromptOverride('zh', 'ai.routing.intro', '自定义');
    setCustomizationEnabled(false);
    invalidateCustomizationCache();
    expect(customizationEnabled()).toBe(false);
    // The override string is still on disk…
    expect(readCustomizationState().promptOverrides?.zh?.['ai.routing.intro']).toBe('自定义');
    // …but conditional/skill resolvers short-circuit to shipped defaults.
    expect(resolveConditionalLine('ai.routing.no_visible_output_ok', false)).toBe(false);
    expect(effectiveBuiltinSkills([...BUILTIN_SKILLS])).toEqual(BUILTIN_SKILLS);
  });
});

describe('conditional lines', () => {
  it('forces a gated line on/off regardless of shipped default', () => {
    setConditionalLine('ai.routing.no_visible_output_ok', true);
    invalidateCustomizationCache();
    expect(resolveConditionalLine('ai.routing.no_visible_output_ok', false)).toBe(true);

    setConditionalLine('ai.routing.no_visible_output_ok', false);
    invalidateCustomizationCache();
    expect(resolveConditionalLine('ai.routing.no_visible_output_ok', true)).toBe(false);

    setConditionalLine('ai.routing.no_visible_output_ok', null);
    invalidateCustomizationCache();
    expect(resolveConditionalLine('ai.routing.no_visible_output_ok', true)).toBe(true);
  });
});

describe('built-in skill overrides', () => {
  const target = BUILTIN_SKILLS[0].name;

  it('replaces a skill body and stores it as a .md file', () => {
    const body = `---\nname: ${target}\ndescription: custom\n---\n\n# custom body`;
    setSkillOverrideBody(target, body);
    invalidateCustomizationCache();
    expect(readSkillOverrideBody(target)).toBe(body);
    expect(effectiveBuiltinSkillContent(target, 'SHIPPED')).toBe(body);
    const eff = effectiveBuiltinSkills([...BUILTIN_SKILLS]);
    expect(eff.find((s) => s.name === target)?.content).toBe(body);
  });

  it('disables a skill so it drops out of the effective list', () => {
    setSkillDisabled(target, true);
    invalidateCustomizationCache();
    expect(isBuiltinSkillDisabled(target)).toBe(true);
    expect(effectiveBuiltinSkillContent(target, 'SHIPPED')).toBeUndefined();
    const eff = effectiveBuiltinSkills([...BUILTIN_SKILLS]);
    expect(eff.find((s) => s.name === target)).toBeUndefined();
    // Re-enable restores it.
    setSkillDisabled(target, false);
    invalidateCustomizationCache();
    expect(effectiveBuiltinSkills([...BUILTIN_SKILLS]).find((s) => s.name === target)).toBeTruthy();
  });

  it('clearing a body removes the .md file but keeps a disable flag', () => {
    setSkillOverrideBody(target, 'body');
    setSkillDisabled(target, true);
    setSkillOverrideBody(target, null);
    invalidateCustomizationCache();
    expect(readSkillOverrideBody(target)).toBeUndefined();
    expect(isBuiltinSkillDisabled(target)).toBe(true);
  });

  it('rejects an oversized body', () => {
    expect(() => setSkillOverrideBody(target, 'x'.repeat(MAX_SKILL_BODY_BYTES + 1))).toThrow(/too_large/);
  });
});

describe('history / rollback (non-destructive)', () => {
  it('snapshots each mutation and rolls back to a prior state', () => {
    setPromptOverride('zh', 'ai.routing.intro', 'v1');
    setPromptOverride('zh', 'ai.routing.intro', 'v2');
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides?.zh?.['ai.routing.intro']).toBe('v2');

    const snaps = listSnapshots();
    // Two set operations → at least two snapshots (each captures the prior state).
    expect(snaps.length).toBeGreaterThanOrEqual(2);

    // The newest snapshot captured the state right before the v2 write → holds v1.
    const beforeV2 = snaps[0];
    rollbackToSnapshot(beforeV2.id);
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides?.zh?.['ai.routing.intro']).toBe('v1');

    // Rollback is itself a snapshot → we can roll forward again (non-destructive).
    const afterRollback = listSnapshots();
    expect(afterRollback.length).toBeGreaterThan(snaps.length);
  });

  it('reset-all clears content but is reversible', () => {
    setPromptOverride('zh', 'ai.routing.intro', 'keep-me');
    setSkillOverrideBody(BUILTIN_SKILLS[0].name, 'skill-body');
    invalidateCustomizationCache();

    resetAllToFactory();
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides).toBeUndefined();
    expect(readCustomizationState().builtinSkills).toBeUndefined();
    expect(readSkillOverrideBody(BUILTIN_SKILLS[0].name)).toBeUndefined();

    // The pre-reset snapshot restores everything, bodies included.
    const preReset = listSnapshots()[0];
    rollbackToSnapshot(preReset.id);
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides?.zh?.['ai.routing.intro']).toBe('keep-me');
    expect(readSkillOverrideBody(BUILTIN_SKILLS[0].name)).toBe('skill-body');
  });
});

describe('replaceState (bundle import)', () => {
  it('materialises state + skill bodies atomically', () => {
    const name = BUILTIN_SKILLS[0].name;
    replaceState(
      {
        schemaVersion: 1,
        promptOverrides: { en: { 'ai.routing.intro': 'imported' } },
        builtinSkills: { [name]: { body: 'x' } },
      },
      { [name]: 'imported-skill-body' },
      'import bundle',
    );
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides?.en?.['ai.routing.intro']).toBe('imported');
    expect(readSkillOverrideBody(name)).toBe('imported-skill-body');
    expect(effectiveBuiltinSkillContent(name, 'SHIPPED')).toBe('imported-skill-body');
  });
});
