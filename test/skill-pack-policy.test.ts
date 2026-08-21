import { describe, expect, it } from 'vitest';
import { resolveSkillPolicy } from '../src/core/skills/policy.js';
import type { SkillPackage, SkillPack } from '../src/core/skills/types.js';

function pkg(name: string): SkillPackage {
  return {
    id: name,
    name,
    tags: [],
    rootDir: `/tmp/${name}`,
    entrypoint: 'SKILL.md',
    source: { type: 'user', root: `/tmp/${name}` },
  };
}

function pack(id: string, skills: string[]): SkillPack {
  return {
    id,
    name: id,
    include: skills.map((s) => `skill:${s}` as `skill:${string}`),
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('skill policy resolver with packs', () => {
  it('expands a pack into its member skills', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a'), pkg('b')],
      projectSkills: [],
      botPolicy: { include: ['pack:p1'] },
      workingDir: '/repo',
      packs: { p1: pack('p1', ['a', 'b']) },
    });
    expect(result.prioritySkills.map((s) => s.name)).toEqual(['a', 'b']);
    expect(result.prioritySkills[0].priorityReason).toBe('bot:pack:p1');
  });

  it('keeps direct skill references ahead of pack-expanded ones', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a'), pkg('b')],
      projectSkills: [],
      botPolicy: { include: ['skill:b', 'pack:p1'] },
      workingDir: '/repo',
      packs: { p1: pack('p1', ['a', 'b']) },
    });
    // b is direct (first), a comes from the pack; b's reason is bot:include
    expect(result.prioritySkills.map((s) => s.name)).toEqual(['b', 'a']);
    expect(result.prioritySkills[0].priorityReason).toBe('bot:include');
  });

  it('uses registry precedence consistently for direct and pack selectors', () => {
    const registry = pkg('shared');
    const project = { ...pkg('shared'), rootDir: '/repo/.agents/skills/shared' };

    const direct = resolveSkillPolicy({
      registrySkills: [registry],
      projectSkills: [project],
      globalProjectSkills: 'all',
      botPolicy: { include: ['skill:shared'] },
      workingDir: '/repo',
    });
    const packed = resolveSkillPolicy({
      registrySkills: [registry],
      projectSkills: [project],
      globalProjectSkills: 'all',
      botPolicy: { include: ['pack:p1'] },
      workingDir: '/repo',
      packs: { p1: pack('p1', ['shared']) },
    });

    expect(direct.prioritySkills[0].rootDir).toBe(registry.rootDir);
    expect(packed.prioritySkills[0].rootDir).toBe(registry.rootDir);
  });

  it('direct reference always wins even when pack: is listed first in include', () => {
    // Regression: previously the resolver expanded selectors in array order,
    // so a pack listed before a direct skill: would win. Direct must always
    // take priority over pack, regardless of include array order.
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a'), pkg('b')],
      projectSkills: [],
      botPolicy: { include: ['pack:p1', 'skill:b'] },
      workingDir: '/repo',
      packs: { p1: pack('p1', ['a', 'b']) },
    });
    // b is direct → reason bot:include (NOT bot:pack:p1); a comes from the pack
    expect(result.prioritySkills.map((s) => s.name)).toEqual(['b', 'a']);
    expect(result.prioritySkills[0].priorityReason).toBe('bot:include');
  });

  it('deduplicates skills across multiple packs (first wins)', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a')],
      projectSkills: [],
      botPolicy: { include: ['pack:p1', 'pack:p2'] },
      workingDir: '/repo',
      packs: { p1: pack('p1', ['a']), p2: pack('p2', ['a']) },
    });
    expect(result.prioritySkills.map((s) => s.name)).toEqual(['a']);
    expect(result.prioritySkills[0].priorityReason).toBe('bot:pack:p1');
    const dup = result.diagnostics.find((d) => d.code === 'duplicate_skill_shadowed');
    expect(dup).toBeDefined();
  });

  it('emits pack_not_found when a pack id is missing', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a')],
      projectSkills: [],
      botPolicy: { include: ['pack:missing'] },
      workingDir: '/repo',
      packs: {},
    });
    expect(result.prioritySkills).toEqual([]);
    expect(result.diagnostics.some((d) => d.code === 'pack_not_found')).toBe(true);
  });

  it('does not resolve inherited Object properties as packs', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a')],
      projectSkills: [],
      botPolicy: { include: ['pack:constructor'] },
      workingDir: '/repo',
      packs: {},
    });
    expect(result.prioritySkills).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('pack_not_found');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('pack_invalid');
  });

  it('emits pack_skill_missing when a pack references an uninstalled skill', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a')],
      projectSkills: [],
      botPolicy: { include: ['pack:p1'] },
      workingDir: '/repo',
      packs: { p1: pack('p1', ['a', 'ghost']) },
    });
    expect(result.prioritySkills.map((s) => s.name)).toEqual(['a']);
    const missing = result.diagnostics.find((d) => d.code === 'pack_skill_missing');
    expect(missing).toBeDefined();
    expect(missing?.skillName).toBe('ghost');
  });

  it('preserves old skill-only behaviour when no packs are supplied', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a'), pkg('b')],
      projectSkills: [],
      botPolicy: { include: ['skill:a', 'skill:b'] },
      workingDir: '/repo',
    });
    expect(result.prioritySkills.map((s) => s.name)).toEqual(['a', 'b']);
    expect(result.prioritySkills.every((s) => s.priorityReason === 'bot:include')).toBe(true);
  });

  it('treats pack:* as resolving to nothing when packs registry is absent', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('a')],
      projectSkills: [],
      botPolicy: { include: ['pack:p1', 'skill:a'] },
      workingDir: '/repo',
    });
    // No packs registry → pack_not_found, but the direct skill:a still resolves
    expect(result.prioritySkills.map((s) => s.name)).toEqual(['a']);
    expect(result.diagnostics.some((d) => d.code === 'pack_not_found')).toBe(true);
  });

  it('does not throw when a caller supplies non-string pack members', () => {
    const corrupted = {
      ...pack('p1', ['a']),
      include: [123, 'pack:nested', 'skill:a'],
    } as unknown as SkillPack;

    const result = resolveSkillPolicy({
      registrySkills: [pkg('a')],
      projectSkills: [],
      botPolicy: { include: ['pack:p1'] },
      workingDir: '/repo',
      packs: { p1: corrupted },
    });

    expect(result.prioritySkills.map((skill) => skill.name)).toEqual(['a']);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'pack_invalid')).toHaveLength(2);
  });
});
