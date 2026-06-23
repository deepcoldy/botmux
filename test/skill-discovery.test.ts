import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverNativeCliSkillGroups, discoverProjectSkills } from '../src/core/skills/discovery.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

describe('skill discovery', () => {
  let repo: string;
  let previousCodexHome: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'botmux-skill-repo-'));
    previousCodexHome = process.env.CODEX_HOME;
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('HOME', previousHome);
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
            // Pin the source classification the dashboard's source badges key on.
            source: expect.objectContaining({ type: 'user' }),
          }),
        ],
      }),
    ]);
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('groups skills per CLI and skips a CLI whose skill root is empty', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'botmux-codex-home-'));
    const home = mkdtempSync(join(tmpdir(), 'botmux-home-'));
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = home;
    write(join(codexHome, 'skills', 'cx', 'SKILL.md'), '---\nname: cx\n---');
    write(join(home, '.trae', 'skills', 'tr', 'SKILL.md'), '---\nname: tr\n---'); // coco/traex root

    const groups = discoverNativeCliSkillGroups(['codex', 'coco']);

    expect(groups.map((g) => g.cliId)).toEqual(['codex', 'coco']);
    expect(groups.find((g) => g.cliId === 'codex')?.skills.map((s) => s.name)).toEqual(['cx']);
    expect(groups.find((g) => g.cliId === 'coco')?.rootDir).toBe(join(home, '.trae', 'skills'));
    expect(groups.find((g) => g.cliId === 'coco')?.skills.map((s) => s.name)).toEqual(['tr']);
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('dedups a skills root shared by two CLIs into a single group (first CLI owns it)', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-home-'));
    process.env.HOME = home;
    // coco and traex both declare skillsDir ~/.trae/skills.
    write(join(home, '.trae', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\n---');

    const groups = discoverNativeCliSkillGroups(['coco', 'traex']);

    expect(groups).toHaveLength(1);
    expect(groups[0].cliId).toBe('coco');
    expect(groups[0].rootDir).toBe(join(home, '.trae', 'skills'));
    expect(groups[0].skills.map((s) => s.name)).toEqual(['shared']);
    rmSync(home, { recursive: true, force: true });
  });
});
