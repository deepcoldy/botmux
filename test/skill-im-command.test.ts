import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotSkillPolicy } from '../src/core/skills/types.js';

const botConfig: { skills?: BotSkillPolicy } = {};
const registry = {
  skills: {
    deploy: {
      id: 'deploy',
      name: 'deploy',
      description: 'Deploy services',
      tags: [],
      rootDir: '/skills/deploy',
      entrypoint: 'SKILL.md',
      source: { type: 'local-copy', originalPath: '/src/deploy' },
    },
  },
};

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    botName: 'Test Bot',
    resolvedAllowedUsers: ['ou_admin'],
    config: {
      larkAppId: 'app-1',
      larkAppSecret: 'secret',
      cliId: 'codex',
      ...botConfig,
    },
  })),
}));

vi.mock('../src/services/skill-registry-store.js', () => ({
  readSkillRegistry: vi.fn(() => registry),
}));

vi.mock('../src/services/bot-config-store.js', () => ({
  findConfigField: vi.fn(() => ({ key: 'skills', configKey: 'skills', kind: 'json', effect: 'next-session', clearable: true })),
  applyConfigField: vi.fn(async (_appId: string, _spec: unknown, value: unknown) => {
    if (value === null) delete botConfig.skills;
    else botConfig.skills = value as BotSkillPolicy;
    return { ok: true, oldText: '', newText: '', effect: 'next-session' };
  }),
}));

import { attachSkillPolicy, detachSkillPolicy, runSkillsImCommand } from '../src/core/skills/im-command.js';

describe('/skills IM command', () => {
  beforeEach(() => {
    delete botConfig.skills;
  });

  it('attaches an installed registry skill as a priority selector', async () => {
    const result = await runSkillsImCommand('app-1', '/skills attach deploy');

    expect(result.ok).toBe(true);
    expect(botConfig.skills?.include).toEqual(['skill:deploy']);
  });

  it('does not duplicate an existing attached skill selector', () => {
    const next = attachSkillPolicy({ include: ['skill:deploy'] }, 'deploy');

    expect(next.include).toEqual(['skill:deploy']);
  });

  it('clears the policy when detaching the last custom skill', async () => {
    botConfig.skills = { include: ['skill:deploy'] };

    const result = await runSkillsImCommand('app-1', '/skills detach deploy');

    expect(result.ok).toBe(true);
    expect(botConfig.skills).toBeUndefined();
  });

  it('drops unsupported non-direct selectors when detaching', () => {
    const next = detachSkillPolicy({ include: ['skill:deploy', 'tag:sre'] as any }, 'deploy');

    expect(next).toBeUndefined();
  });

  it('rejects attaching a skill that is not installed', async () => {
    const result = await runSkillsImCommand('app-1', '/skills attach missing');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('未安装 skill');
  });
});
