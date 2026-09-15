import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { builtinSkillContent, builtinSkillEntries } from '../src/skills/injection-mode.js';
import { ensureSkills } from '../src/skills/installer.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

afterEach(() => vi.unstubAllEnvs());

describe('multi-topic orchestration feature gate', () => {
  it('removes botmux-orchestrate from prompt discovery and on-demand reads', () => {
    const enabled = builtinSkillEntries({ asksViaHook: false, multiTopicEnabled: true });
    const disabled = builtinSkillEntries({ asksViaHook: false, multiTopicEnabled: false });
    expect(enabled.map(entry => entry.name)).toContain('botmux-orchestrate');
    expect(disabled.map(entry => entry.name)).not.toContain('botmux-orchestrate');

    vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', 'false');
    expect(builtinSkillContent('botmux-orchestrate')).toBeUndefined();
    expect(builtinSkillContent('botmux-handoff')).toContain('name: botmux-handoff');
  });

  it('removes a previously installed native skill when disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-multi-topic-skill-'));
    try {
      vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', 'true');
      ensureSkills('claude-code', dir);
      expect(existsSync(join(dir, 'botmux-orchestrate', 'SKILL.md'))).toBe(true);

      vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', 'false');
      ensureSkills('claude-code', dir);
      expect(existsSync(join(dir, 'botmux-orchestrate'))).toBe(false);
      expect(existsSync(join(dir, 'botmux-handoff', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses new topic dispatches but does not block --into', () => {
    const env = { ...process.env, BOTMUX_MULTI_TOPIC_ENABLED: 'false' };
    const { command, prefixArgs } = tsRunnerPrefix();
    const cli = join(__dirname, '..', 'src', 'cli.ts');
    const blocked = spawnSync(command, [...prefixArgs, cli,
      'dispatch', '--title', 'new topic', '--bot', 'ou_test',
    ], { env, encoding: 'utf-8' });
    const blockedOutput = `${blocked.stdout ?? ''}${blocked.stderr ?? ''}`;
    expect(blocked.status).toBe(2);
    expect(blockedOutput).toContain('multi_topic_disabled');

    const append = spawnSync(command, [...prefixArgs, cli,
      'dispatch', '--into', 'om_root', '--bot', 'ou_test', '--brief', 'continue',
    ], { env, encoding: 'utf-8' });
    const appendOutput = `${append.stdout ?? ''}${append.stderr ?? ''}`;
    expect(appendOutput).not.toContain('multi_topic_disabled');
  });
});
