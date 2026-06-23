import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverClaudePluginSkillGroups, discoverNativeCliSkillGroups, discoverProjectSkills } from '../src/core/skills/discovery.js';

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

  it('discovers Claude plugin + marketplace skills under a claudeDataDir', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-claude-data-'));
    const pluginsRoot = join(dataDir, 'plugins');

    // Enabled plugin WITH skills: installed_plugins.json → <installPath>/skills.
    const installPath = join(pluginsRoot, 'cache', 'mkt', 'frontend-design', '1.0.0');
    write(join(installPath, 'skills', 'fe-skill', 'SKILL.md'), '---\nname: fe-skill\ndescription: FE\n---');
    // Enabled plugin WITHOUT a skills/ dir (e.g. gopls-lsp) → contributes nothing.
    const lspPath = join(pluginsRoot, 'cache', 'mkt', 'gopls-lsp', '1.0.0');
    write(join(lspPath, 'README.md'), '# no skills here');
    write(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'frontend-design@mkt': [{ scope: 'user', installPath }],
        'gopls-lsp@mkt': [{ scope: 'user', installPath: lspPath }],
      },
    }));
    // Marketplace-level skill collection (e.g. anthropic-agent-skills).
    write(join(pluginsRoot, 'marketplaces', 'anthropic-agent-skills', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\n---');

    const groups = discoverClaudePluginSkillGroups(dataDir, 'claude-code');

    const fe = groups.find((g) => g.label === 'frontend-design (plugin)');
    expect(fe).toBeDefined();
    expect(fe?.cliId).toBe('claude-code');
    expect(fe?.rootDir).toBe(join(installPath, 'skills'));
    expect(fe?.skills.map((s) => s.name)).toEqual(['fe-skill']);

    // A plugin without a skills/ dir produces no group.
    expect(groups.some((g) => g.label?.startsWith('gopls-lsp'))).toBe(false);

    const mp = groups.find((g) => g.label === 'anthropic-agent-skills (marketplace)');
    expect(mp).toBeDefined();
    expect(mp?.skills.map((s) => s.name)).toEqual(['pdf']);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('honors the shared `seen` set so a root claimed elsewhere is not re-added', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-claude-data-'));
    const skillsRoot = join(dataDir, 'plugins', 'marketplaces', 'mp', 'skills');
    write(join(skillsRoot, 's', 'SKILL.md'), '---\nname: s\n---');

    expect(discoverClaudePluginSkillGroups(dataDir, 'claude-code', new Set([skillsRoot]))).toEqual([]);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns [] when the claudeDataDir has no plugins dir', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-claude-empty-'));
    expect(discoverClaudePluginSkillGroups(dataDir, 'claude-code')).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
