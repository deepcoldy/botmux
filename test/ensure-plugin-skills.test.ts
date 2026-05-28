import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensurePluginSkills, removeGlobalBotmuxSkills } from '../src/skills/installer.js';
import { BUILTIN_SKILLS, ASK_SKILL_NAME, RETIRED_SKILL_NAMES } from '../src/skills/definitions.js';

describe('ensurePluginSkills', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plugin-skills-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('写入 .claude-plugin/plugin.json（合法 JSON，name=botmux）', () => {
    ensurePluginSkills('claude-code', dir);
    const manifestFile = join(dir, '.claude-plugin', 'plugin.json');
    expect(existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    expect(manifest.name).toBe('botmux');
  });

  it('每个内置 skill 写到 skills/<name>/SKILL.md，内容与定义一致', () => {
    ensurePluginSkills('claude-code', dir);
    for (const skill of BUILTIN_SKILLS) {
      const skillFile = join(dir, 'skills', skill.name, 'SKILL.md');
      expect(existsSync(skillFile)).toBe(true);
      expect(readFileSync(skillFile, 'utf-8')).toBe(skill.content);
    }
  });

  it('幂等：重复调用不报错且内容稳定', () => {
    ensurePluginSkills('claude-code', dir);
    const sample = join(dir, 'skills', BUILTIN_SKILLS[0].name, 'SKILL.md');
    const first = readFileSync(sample, 'utf-8');
    expect(() => ensurePluginSkills('claude-code', dir)).not.toThrow();
    expect(readFileSync(sample, 'utf-8')).toBe(first);
  });

  it('pluginDir 为 undefined：直接跳过，不报错', () => {
    expect(() => ensurePluginSkills('claude-code', undefined)).not.toThrow();
  });
});

describe('removeGlobalBotmuxSkills', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'global-skills-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const seed = (name: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), 'x', 'utf-8');
  };

  it('按 botmux- 前缀删除所有 botmux skill（含未在本版本列表里的），保留用户自有 skill', () => {
    for (const s of BUILTIN_SKILLS) seed(s.name);
    seed(ASK_SKILL_NAME);
    for (const r of RETIRED_SKILL_NAMES) seed(r);
    // 其它 botmux 版本装过、但本 checkout 不认识的 skill（如 botmux-handoff）也要清掉
    seed('botmux-handoff');
    seed('botmux-some-future-skill');
    seed('my-own-skill');

    removeGlobalBotmuxSkills(dir);

    for (const s of BUILTIN_SKILLS) expect(existsSync(join(dir, s.name))).toBe(false);
    expect(existsSync(join(dir, ASK_SKILL_NAME))).toBe(false);
    for (const r of RETIRED_SKILL_NAMES) expect(existsSync(join(dir, r))).toBe(false);
    expect(existsSync(join(dir, 'botmux-handoff'))).toBe(false);
    expect(existsSync(join(dir, 'botmux-some-future-skill'))).toBe(false);
    // 不属于 botmux 的 skill 必须保留
    expect(existsSync(join(dir, 'my-own-skill'))).toBe(true);
  });

  it('目录不存在 / undefined：no-op，不报错', () => {
    expect(() => removeGlobalBotmuxSkills(join(dir, 'nope'))).not.toThrow();
    expect(() => removeGlobalBotmuxSkills(undefined)).not.toThrow();
  });
});
