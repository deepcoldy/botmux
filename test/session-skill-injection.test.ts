import { describe, expect, it } from 'vitest';

import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import { renderSkillCatalogBlock } from '../src/core/skills/prompt.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';

const MANIFEST: SessionSkillManifest = {
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

describe('session skill injection', () => {
  // The skill catalog is injected at a single site — prepareSessionSkillPrompt
  // in the worker-pool fork path (covered by session-skill-runtime.test.ts).
  // buildNewTopicPrompt must never render it, so the block is never duplicated.
  it('does not inject the skill catalog from buildNewTopicPrompt', () => {
    const base = buildNewTopicPrompt('hello', 's1', 'codex');
    expect(base).not.toContain('<botmux_skills');
  });

  it('renderSkillCatalogBlock emits the priority skill catalog', () => {
    const block = renderSkillCatalogBlock(MANIFEST);
    expect(block).toContain('<botmux_skills mode="priority">');
    expect(block).toContain('botmux skill show deploy');
  });
});
