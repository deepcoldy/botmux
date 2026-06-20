import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSkillsAdminCommand } from '../src/core/skills/cli-admin-command.js';
import { readSkillRegistry } from '../src/services/skill-registry-store.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('botmux skills admin command', () => {
  let home: string;
  let src: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-skill-home-'));
    src = mkdtempSync(join(tmpdir(), 'botmux-skill-src-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it('validates, installs, lists, inspects and removes a local skill', () => {
    const dir = join(src, 'deploy');
    write(join(dir, 'SKILL.md'), '---\nname: deploy\ndescription: Deploy services\n---\n# Deploy');

    expect(runSkillsAdminCommand(['validate', dir])).toMatchObject({ code: 0 });
    expect(runSkillsAdminCommand(['install', dir]).stdout).toContain('installed deploy');
    expect(runSkillsAdminCommand(['list']).stdout).toContain('deploy');
    expect(runSkillsAdminCommand(['inspect', 'deploy']).stdout).toContain('"name": "deploy"');
    expect(readSkillRegistry().skills.deploy).toBeDefined();
    expect(runSkillsAdminCommand(['remove', 'deploy']).stdout).toContain('removed deploy');
    expect(readSkillRegistry().skills.deploy).toBeUndefined();
  });

  it('updates an installed local-copy skill from its recorded source', () => {
    const dir = join(src, 'deploy');
    write(join(dir, 'SKILL.md'), '---\nname: deploy\ndescription: Old\n---\n# Deploy');
    runSkillsAdminCommand(['install', dir]);
    write(join(dir, 'SKILL.md'), '---\nname: deploy\ndescription: New\n---\n# Deploy');

    const updated = runSkillsAdminCommand(['update', 'deploy']);

    expect(updated.stdout).toContain('updated deploy');
    expect(readSkillRegistry().skills.deploy.description).toBe('New');
  });

  it('requires --force when removing a skill referenced by bot policy', () => {
    const dir = join(src, 'deploy');
    const botsPath = join(home, 'bots.json');
    write(join(dir, 'SKILL.md'), '---\nname: deploy\n---\n# Deploy');
    write(botsPath, JSON.stringify([{
      larkAppId: 'app-1',
      larkAppSecret: 'secret',
      name: 'ops-bot',
      cliId: 'codex',
      skills: { include: ['skill:deploy'] },
    }]));
    vi.stubEnv('BOTS_CONFIG', botsPath);
    runSkillsAdminCommand(['install', dir]);

    const blocked = runSkillsAdminCommand(['remove', 'deploy']);

    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('skill_in_use');
    expect(blocked.stderr).toContain('ops-bot');
    expect(readSkillRegistry().skills.deploy).toBeDefined();

    expect(runSkillsAdminCommand(['remove', 'deploy', '--force']).stdout).toContain('removed deploy');
    expect(readSkillRegistry().skills.deploy).toBeUndefined();
  });

  it('reports missing skill before checking dangling bot references', () => {
    const botsPath = join(home, 'bots.json');
    write(botsPath, JSON.stringify([{
      larkAppId: 'app-1',
      larkAppSecret: 'secret',
      name: 'ops-bot',
      cliId: 'codex',
      skills: { include: ['skill:deploy'] },
    }]));
    vi.stubEnv('BOTS_CONFIG', botsPath);

    const result = runSkillsAdminCommand(['remove', 'deploy']);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('skill_not_installed\n');
  });

});
