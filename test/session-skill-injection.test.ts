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
  // The USER-registered skill catalog (`<botmux_skills mode=...>`) is injected at
  // a single site — prepareSessionSkillPrompt in the worker-pool fork path
  // (covered by session-skill-runtime.test.ts). buildNewTopicPrompt must never
  // render THAT catalog, so it's never duplicated. (buildNewTopicPrompt does emit
  // the separate built-in bridge-skill catalog `<botmux_builtin_skills>` in
  // prompt mode — a distinct tag/concept, covered by skill-injection-mode.test.ts.)
  it('does not inject the user-skill priority catalog from buildNewTopicPrompt', () => {
    const base = buildNewTopicPrompt('hello', 's1', 'codex');
    expect(base).not.toContain('<botmux_skills ');
    expect(base).not.toContain('mode="priority"');
  });

  it('renderSkillCatalogBlock emits the priority skill catalog', () => {
    const block = renderSkillCatalogBlock(MANIFEST);
    expect(block).toContain('<botmux_skills mode="priority">');
    expect(block).toContain('botmux skill show deploy');
  });
});
