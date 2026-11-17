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

  it('renders every TraeX skill as a compact trigger index without slicing a sentence', () => {
    const longSingleSentence = 'Use when this exact long trigger remains semantically necessary even in the compact catalog';
    const chineseFirstSentence = '统一处理 v3 Workflow：把有界目标拆成 DAG，按依赖执行。更多实现细节留在 SKILL.md。';
    const dashFirstSentence = '给当前会话改名时触发——用户明确要求改名时使用。后续规则按需读取。';
    const input = {
      ...manifest(),
      prioritySkills: [
        ...manifest().prioritySkills.map(skill => ({
          ...skill,
          description: 'Use when deploying a service. Extra implementation guidance stays in SKILL.md.',
        })),
        {
          ...manifest().prioritySkills[0],
          id: 'diagnose',
          name: 'diagnose',
          description: longSingleSentence,
        },
        {
          ...manifest().prioritySkills[0],
          id: 'workflow',
          name: 'workflow',
          description: chineseFirstSentence,
        },
        {
          ...manifest().prioritySkills[0],
          id: 'rename',
          name: 'rename',
          description: dashFirstSentence,
        },
      ],
    };

    const compact = renderSkillCatalogBlock(input, { compact: true } as any);

    expect(compact).toContain('name="deploy"');
    expect(compact).toContain('trigger="Use when deploying a service."');
    expect(compact).not.toContain('Extra implementation guidance');
    expect(compact).toContain('name="diagnose"');
    expect(compact).toContain(`trigger="${longSingleSentence}"`);
    expect(compact).toContain('trigger="统一处理 v3 Workflow：把有界目标拆成 DAG，按依赖执行。"');
    expect(compact).toContain('trigger="给当前会话改名时触发——用户明确要求改名时使用。"');
    expect(compact).not.toContain('更多实现细节');
    expect(compact).not.toContain('后续规则按需读取');
    expect(compact).toContain('botmux skill show <name>');
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThan(Buffer.byteLength(renderSkillCatalogBlock(input), 'utf8'));
  });
});
