import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { prepareSessionSkillPrompt } from '../src/core/skills/session-runtime.js';
import { readSessionSkillManifest } from '../src/core/skills/manifest-store.js';
import { installLocalSkill } from '../src/services/skill-registry-store.js';
import { loadSkillPackage } from '../src/core/skills/package.js';
import { readSkillRegistry } from '../src/services/skill-registry-store.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('session skill runtime preparation', () => {
  let home: string;
  let dataDir: string;
  let src: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-skill-home-'));
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-skill-data-'));
    src = mkdtempSync(join(tmpdir(), 'botmux-skill-src-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it('leaves prompt unchanged and writes no manifest when bot has no skill policy', () => {
    const result = prepareSessionSkillPrompt({
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      prompt: 'hello',
      botPolicy: undefined,
    });

    expect(result.prompt).toBe('hello');
    expect(result.manifest).toBeNull();
    expect(readSessionSkillManifest('s1')).toBeNull();
  });

  it('writes manifest and appends catalog for configured priority skills', () => {
    write(join(src, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy services\n---\n# Deploy');
    installLocalSkill(join(src, 'deploy'), { link: false });

    const result = prepareSessionSkillPrompt({
      sessionId: 's2',
      cliId: 'codex',
      workingDir: '/repo',
      prompt: 'hello',
      botPolicy: { include: ['skill:deploy'] },
    });

    expect(result.prompt).toContain('hello');
    expect(result.prompt).toContain('<botmux_skills mode="priority">');
    expect(result.prompt).toContain('botmux skill show deploy');
    expect(readSessionSkillManifest('s2')?.prioritySkills.map((s) => s.name)).toEqual(['deploy']);
  });

  it('injects plugin-owned skills without adding them to the user skill registry', () => {
    const pluginRoot = join(src, 'plugin-demo');
    const skillDir = join(pluginRoot, 'skills', 'browser');
    write(join(skillDir, 'SKILL.md'), '---\nname: browser\ndescription: Browser tools\n---\n# Browser');
    const pluginSkill = loadSkillPackage(skillDir, {
      source: { type: 'plugin', pluginId: 'demo', root: pluginRoot },
      id: 'plugin:demo:browser',
    });

    const result = prepareSessionSkillPrompt({
      sessionId: 'plugin-session',
      cliId: 'codex',
      workingDir: '/repo',
      prompt: 'hello',
      botPolicy: undefined,
      pluginSkills: [pluginSkill],
    });

    expect(result.prompt).toContain('botmux skill show browser');
    expect(readSessionSkillManifest('plugin-session')?.prioritySkills[0].source).toEqual({
      type: 'plugin',
      pluginId: 'demo',
      root: pluginRoot,
    });
    expect(readSkillRegistry().skills.browser).toBeUndefined();
  });

  it('refreshes a prompt-less CLI generation and removes stale session skills', () => {
    const pluginRoot = join(src, 'plugin-refresh');
    const skillDir = join(pluginRoot, 'skills', 'browser');
    write(join(skillDir, 'SKILL.md'), '---\nname: browser\ndescription: Browser tools\n---\n# Browser');
    const pluginSkill = loadSkillPackage(skillDir, {
      source: { type: 'plugin', pluginId: 'demo', root: pluginRoot },
      id: 'plugin:demo:browser',
    });

    const prepared = prepareSessionSkillPrompt({
      sessionId: 'refresh-session',
      cliId: 'codex',
      workingDir: '/repo',
      prompt: '',
      botPolicy: undefined,
      pluginSkills: [pluginSkill],
    });
    expect(prepared.prompt).toBe('');
    expect(readSessionSkillManifest('refresh-session')?.prioritySkills.map(skill => skill.name)).toEqual(['browser']);

    prepareSessionSkillPrompt({
      sessionId: 'refresh-session',
      cliId: 'codex',
      workingDir: '/repo',
      prompt: '',
      botPolicy: undefined,
      pluginSkills: [],
    });
    expect(readSessionSkillManifest('refresh-session')).toBeNull();
  });
});
