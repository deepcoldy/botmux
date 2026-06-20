import { describe, expect, it } from 'vitest';

import { resolveSkillPolicy } from '../src/core/skills/policy.js';
import type { SkillPackage } from '../src/core/skills/types.js';

function pkg(name: string, tags: string[], source: SkillPackage['source']): SkillPackage {
  return {
    id: name,
    name,
    tags,
    rootDir: `/tmp/${name}`,
    entrypoint: 'SKILL.md',
    source,
    description: `${name} description`,
  };
}

describe('skill policy resolver', () => {
  it('is disabled when bot policy is absent', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('deploy', ['sre'], { type: 'user', root: '/tmp/deploy' })],
      projectSkills: [],
      botPolicy: undefined,
      workingDir: '/repo',
    });

    expect(result.enabled).toBe(false);
    expect(result.prioritySkills).toEqual([]);
  });

  it('resolves direct skill includes only', () => {
    const result = resolveSkillPolicy({
      registrySkills: [
        pkg('design-review', ['frontend'], { type: 'user', root: '/tmp/design-review' }),
        pkg('deploy', ['sre'], { type: 'user', root: '/tmp/deploy' }),
        pkg('old-release', ['sre'], { type: 'user', root: '/tmp/old-release' }),
      ],
      projectSkills: [],
      botPolicy: {
        include: ['skill:deploy', 'tag:frontend'] as any,
      } as any,
      workingDir: '/repo',
    });

    expect(result.enabled).toBe(true);
    expect(result.prioritySkills.map((s) => s.name)).toEqual(['deploy']);
  });

  it('diagnoses duplicate names and keeps one selected skill', () => {
    const result = resolveSkillPolicy({
      registrySkills: [pkg('deploy', ['sre'], { type: 'user', root: '/user/deploy' })],
      projectSkills: [pkg('deploy', ['repo'], { type: 'project', root: '/repo/.agents/skills/deploy' })],
      globalProjectSkills: 'all',
      botPolicy: { include: ['skill:deploy'] },
      workingDir: '/repo',
    });

    expect(result.prioritySkills).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.code === 'duplicate_skill_shadowed')).toBe(true);
  });

  it('uses global project skill trust and ignores bot-level project overrides', () => {
    const projectSkills = [pkg('deploy', ['repo'], { type: 'project', root: '/repo/.agents/skills/deploy' })];
    const trusted = resolveSkillPolicy({
      registrySkills: [],
      projectSkills,
      globalProjectSkills: 'trusted',
      botPolicy: { include: ['skill:deploy'] },
      workingDir: '/repo',
    });
    const botOverrideIgnored = resolveSkillPolicy({
      registrySkills: [],
      projectSkills,
      globalProjectSkills: 'trusted',
      botPolicy: { include: ['skill:deploy'], projectSkills: 'off' } as any,
      workingDir: '/repo',
    });

    expect(trusted.prioritySkills.map((s) => s.name)).toEqual(['deploy']);
    expect(trusted.diagnostics.some((d) => d.code === 'project_skills_trusted_deprecated')).toBe(true);
    expect(botOverrideIgnored.prioritySkills.map((s) => s.name)).toEqual(['deploy']);
  });

  it('uses the global delivery default and ignores bot-level delivery overrides', () => {
    const globalDefault = resolveSkillPolicy({
      registrySkills: [pkg('deploy', ['sre'], { type: 'user', root: '/tmp/deploy' })],
      projectSkills: [],
      globalDelivery: 'prompt',
      botPolicy: { include: ['skill:deploy'] },
      workingDir: '/repo',
    });
    const botOverride = resolveSkillPolicy({
      registrySkills: [pkg('deploy', ['sre'], { type: 'user', root: '/tmp/deploy' })],
      projectSkills: [],
      globalDelivery: 'prompt',
      botPolicy: { include: ['skill:deploy'], delivery: 'native' } as any,
      workingDir: '/repo',
    });

    expect(globalDefault.delivery).toBe('prompt');
    expect(botOverride.delivery).toBe('prompt');
  });
});
