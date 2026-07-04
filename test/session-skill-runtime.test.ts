import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { prepareSessionSkillPrompt } from '../src/core/skills/session-runtime.js';
import { readSessionSkillManifest } from '../src/core/skills/manifest-store.js';
import { installLocalSkill } from '../src/services/skill-registry-store.js';

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
});
