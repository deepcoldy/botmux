import { describe, expect, it } from 'vitest';

import { renderSkillCatalogBlock } from '../src/core/skills/prompt.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';

function manifest(): SessionSkillManifest {
  return {
    sessionId: 's1',
    cliId: 'codex',
    workingDir: '/repo',
    policyMode: 'priority',
    prioritySkills: [{
      id: 'deploy',
      name: 'deploy',
      description: 'Deploy services',
      tags: ['sre'],
      rootDir: '/skills/deploy',
      entrypoint: 'SKILL.md',
      source: { type: 'user', root: '/skills/deploy' },
      priorityReason: 'bot:include',
    }],
    diagnostics: [],
    generatedAt: '2026-06-14T00:00:00.000Z',
  };
}

describe('skill prompt catalog', () => {
  it('renders empty string when manifest is null or has no skills', () => {
    expect(renderSkillCatalogBlock(null)).toBe('');
    expect(renderSkillCatalogBlock({ ...manifest(), prioritySkills: [] })).toBe('');
  });

  it('renders priority skill metadata and botmux skill commands', () => {
    const block = renderSkillCatalogBlock(manifest());

    expect(block).toContain('<botmux_skills mode="priority">');
    expect(block).toContain('name="deploy"');
    expect(block).toContain('botmux skill show deploy');
  });
});
