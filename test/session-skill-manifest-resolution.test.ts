import { describe, expect, it } from 'vitest';

import { resolveSessionSkillManifest } from '../src/core/skills/session-resolver.js';

describe('session skill manifest resolution', () => {
  it('returns null when bot has no skill policy', () => {
    const manifest = resolveSessionSkillManifest({
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      botPolicy: undefined,
      registrySkills: [],
      projectSkills: [],
      now: () => '2026-06-14T00:00:00.000Z',
    });

    expect(manifest).toBeNull();
  });

  it('builds a manifest when policy selects skills', () => {
    const manifest = resolveSessionSkillManifest({
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      botPolicy: { include: ['skill:deploy'] },
      globalDelivery: 'prompt',
      registrySkills: [{
        id: 'deploy',
        name: 'deploy',
        tags: [],
        rootDir: '/skills/deploy',
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: '/skills/deploy' },
      }],
      projectSkills: [],
      now: () => '2026-06-14T00:00:00.000Z',
    });

    expect(manifest?.prioritySkills.map((s) => s.name)).toEqual(['deploy']);
    expect(manifest?.delivery).toBe('prompt');
    expect(manifest?.generatedAt).toBe('2026-06-14T00:00:00.000Z');
  });
});
