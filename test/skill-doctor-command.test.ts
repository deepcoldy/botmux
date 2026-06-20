import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSkillsAdminCommand } from '../src/core/skills/cli-admin-command.js';
import { installLocalSkill, readSkillRegistry } from '../src/services/skill-registry-store.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function writeBots(home: string, bots: unknown[]): void {
  write(join(home, '.botmux', 'bots.json'), JSON.stringify(bots, null, 2));
}

describe('botmux skills diagnostics commands', () => {
  let home: string;
  let src: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-skill-home-'));
    src = mkdtempSync(join(tmpdir(), 'botmux-skill-src-'));
    repo = mkdtempSync(join(tmpdir(), 'botmux-skill-repo-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports broken installed skills in doctor output', () => {
    write(join(src, 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n# Deploy');
    installLocalSkill(join(src, 'deploy'), { link: false });
    rmSync(readSkillRegistry().skills.deploy.rootDir, { recursive: true, force: true });

    const result = runSkillsAdminCommand(['doctor']);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('broken\tdeploy\tmissing_root');
  });

  it('shows default CLI behavior when a bot has no custom skill policy', () => {
    writeBots(home, [{
      larkAppId: 'app-default',
      larkAppSecret: 'secret',
      cliId: 'codex',
      name: 'default',
    }]);

    const result = runSkillsAdminCommand(['resolve', '--bot', 'default', '--cwd', repo]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('skills: default');
    expect(result.stdout).toContain('CLI-native skills remain unchanged');
  });

  it('resolves bot priority skills and explains delivery per CLI', () => {
    write(join(src, 'deploy', 'SKILL.md'), [
      '---',
      'name: deploy',
      'description: Deploy services',
      'tags: [sre]',
      '---',
      '# Deploy',
    ].join('\n'));
    installLocalSkill(join(src, 'deploy'), { link: false });
    writeBots(home, [{
      larkAppId: 'app-skilled',
      larkAppSecret: 'secret',
      cliId: 'codex',
      name: 'skilled',
      skills: { include: ['skill:deploy'] },
    }]);

    const resolved = runSkillsAdminCommand(['resolve', '--bot', 'skilled', '--cwd', repo]);
    const codex = runSkillsAdminCommand(['delivery', '--bot', 'skilled']);
    const claude = runSkillsAdminCommand(['delivery', '--cli', 'claude-code', '--mode', 'auto']);

    expect(resolved.stdout).toContain('deploy\tbot:include\tDeploy services');
    expect(codex.stdout).toContain('delivery: prompt');
    expect(claude.stdout).toContain('delivery: hybrid');
  });
});
