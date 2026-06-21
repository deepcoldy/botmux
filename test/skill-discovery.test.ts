import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverNativeCliSkillGroups, discoverProjectSkills } from '../src/core/skills/discovery.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('skill discovery', () => {
  let repo: string;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'botmux-skill-repo-'));
    previousCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it('discovers project skills from .agents/skills and .botmux/skills', () => {
    write(join(repo, '.agents', 'skills', 'agent-skill', 'SKILL.md'), '---\nname: agent-skill\n---');
    write(join(repo, '.botmux', 'skills', 'botmux-skill', 'SKILL.md'), '---\nname: botmux-skill\n---');

    expect(discoverProjectSkills(repo).map((s) => s.name).sort()).toEqual(['agent-skill', 'botmux-skill']);
  });

  it('discovers native codex skills from CODEX_HOME', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'botmux-codex-home-'));
    process.env.CODEX_HOME = codexHome;
    write(join(codexHome, 'skills', 'native-codex-skill', 'SKILL.md'), '---\nname: native-codex-skill\ndescription: Native Codex skill\n---');

    const groups = discoverNativeCliSkillGroups(['codex']);

    expect(groups).toEqual([
      expect.objectContaining({
        cliId: 'codex',
        rootDir: join(codexHome, 'skills'),
        skills: [
          expect.objectContaining({
            name: 'native-codex-skill',
            rootDir: realpathSync(join(codexHome, 'skills', 'native-codex-skill')),
          }),
        ],
      }),
    ]);
    rmSync(codexHome, { recursive: true, force: true });
  });
});
