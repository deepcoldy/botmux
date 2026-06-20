import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSkillSessionCommand } from '../src/core/skills/cli-session-command.js';
import { writeSessionSkillManifest } from '../src/core/skills/manifest-store.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('botmux skill session command', () => {
  let dataDir: string;
  let skillDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-skill-data-'));
    skillDir = mkdtempSync(join(tmpdir(), 'botmux-skill-dir-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    write(join(skillDir, 'SKILL.md'), '# Deploy');
    write(join(skillDir, 'references', 'release.md'), '# Release');
    writeSessionSkillManifest({
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        description: 'Deploy services',
        tags: [],
        rootDir: skillDir,
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: skillDir },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('lists skills from the current session manifest', () => {
    expect(runSkillSessionCommand(['list'], { BOTMUX_SESSION_ID: 's1' }).stdout).toContain('deploy');
  });

  it('shows SKILL.md entrypoint', () => {
    expect(runSkillSessionCommand(['show', 'deploy'], { BOTMUX_SESSION_ID: 's1' }).stdout).toContain('# Deploy');
  });

  it('reads relative resources', () => {
    expect(runSkillSessionCommand(['read', 'deploy', 'references/release.md'], { BOTMUX_SESSION_ID: 's1' }).stdout).toContain('# Release');
  });

  it('refuses to run without a session id', () => {
    expect(runSkillSessionCommand(['list'], {}).stderr).toContain('missing BOTMUX_SESSION_ID');
  });
});
