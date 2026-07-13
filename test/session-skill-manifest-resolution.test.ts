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

  it('builds a manifest for enabled plugin skills without a bot policy', () => {
    const manifest = resolveSessionSkillManifest({
      sessionId: 'plugin-session',
      cliId: 'codex',
      workingDir: '/repo',
      botPolicy: undefined,
      pluginSkills: [{
        id: 'plugin:demo:browser',
        name: 'browser',
        tags: [],
        rootDir: '/plugins/demo/skills/browser',
        entrypoint: 'SKILL.md',
        source: { type: 'plugin', pluginId: 'demo', root: '/plugins/demo' },
      }],
      registrySkills: [],
      projectSkills: [],
      now: () => '2026-06-14T00:00:00.000Z',
    });

    expect(manifest?.prioritySkills.map((skill) => skill.name)).toEqual(['browser']);
    expect(manifest?.prioritySkills[0].source).toEqual({ type: 'plugin', pluginId: 'demo', root: '/plugins/demo' });
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
