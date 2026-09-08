import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensurePluginSkills, removeGlobalBotmuxSkills } from '../src/skills/installer.js';
import { BUILTIN_SKILLS, ASK_SKILL_NAME, RETIRED_SKILL_NAMES, WORKFLOW_FEATURE_SKILLS } from '../src/skills/definitions.js';
import { SEND_SKILL_SESSION_LOADER } from '../src/skills/reply-style-guide.js';
import { builtinSkillContent } from '../src/skills/injection-mode.js';

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

  it('每个内置 skill 写到 skills/<name>/SKILL.md，send 使用稳定会话加载器', () => {
    ensurePluginSkills('claude-code', dir);
    for (const skill of BUILTIN_SKILLS) {
      const skillFile = join(dir, 'skills', skill.name, 'SKILL.md');
      expect(existsSync(skillFile)).toBe(true);
      expect(readFileSync(skillFile, 'utf-8')).toBe(
        skill.name === 'botmux-send' ? SEND_SKILL_SESSION_LOADER : skill.content,
      );
    }
  });

  it('botmux-goal-ask 文案和 GoalInputs answer 结构一致', () => {
    // goal-ask moved into the feature-gated WORKFLOW_FEATURE_SKILLS group.
    const skill = WORKFLOW_FEATURE_SKILLS.find((s) => s.name === 'botmux-goal-ask');
    expect(skill?.content).toContain('"from": "human"');
    expect(skill?.content).toContain('"name": "answer"');
    expect(skill?.content).not.toContain('from: "human/answer"');
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

  it('二次扫描：第一次清理后重启竞态又写回的 botmux skill，会被再扫一遍清掉', () => {
    // 第一道：清理（模拟早期 cleanupGlobalBotmuxSkillsOnce）
    seed('botmux-send');
    removeGlobalBotmuxSkills(dir);
    expect(existsSync(join(dir, 'botmux-send'))).toBe(false);

    // 重启竞态：清理后又被外部老 build / 残留进程写回全局
    seed('botmux-send');
    seed('botmux-handoff');
    seed('my-own-skill');
    expect(existsSync(join(dir, 'botmux-send'))).toBe(true);

    // 第二道：restore 完成后再扫一遍（本次修复的核心）——botmux 残留清掉、用户 skill 保留
    removeGlobalBotmuxSkills(dir);
    expect(existsSync(join(dir, 'botmux-send'))).toBe(false);
    expect(existsSync(join(dir, 'botmux-handoff'))).toBe(false);
    expect(existsSync(join(dir, 'my-own-skill'))).toBe(true);
  });
});

/**
 * Liveness of user customization through the file-delivery path (#954 follow-up).
 *
 * worker-pool.ensureCliSkills re-runs ensurePluginSkills/ensureSkills on EVERY
 * spawn (before the once-cache gate), so a skill body override / disable set via
 * the customization store must show up in the on-disk SKILL.md files on the very
 * next call — no daemon restart. ensureSkills/ensurePluginSkills read the store
 * live via effectiveBuiltinSkills, so these installer-level assertions pin the
 * behavior the dashboard promises ("下一个会话即生效，无需重启 daemon").
 */
describe('ensurePluginSkills reflects live customization (no restart)', () => {
  let dir: string;
  let prevDataDir: string | undefined;
  let prevReplyStyle: string | undefined;
  let store: typeof import('../src/services/customization-store.js');
  const TARGET = BUILTIN_SKILLS[0].name; // e.g. botmux-chat-rename

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plugin-skills-live-'));
    prevDataDir = process.env.SESSION_DATA_DIR;
    prevReplyStyle = process.env.BOTMUX_REPLY_STYLE;
    // Isolate the customization store to a scratch dataDir.
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'cust-data-'));
    store = await import('../src/services/customization-store.js');
    store.invalidateCustomizationCache();
  });
  afterEach(() => {
    try { store.resetAllToFactory(); } catch { /* ignore */ }
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
    if (prevReplyStyle === undefined) delete process.env.BOTMUX_REPLY_STYLE;
    else process.env.BOTMUX_REPLY_STYLE = prevReplyStyle;
    store.invalidateCustomizationCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('第一次装出厂正文；覆盖正文后再装即写入覆盖正文（无需重启）', () => {
    ensurePluginSkills('claude-code', dir);
    const file = join(dir, 'skills', TARGET, 'SKILL.md');
    const shipped = BUILTIN_SKILLS[0].content;
    expect(readFileSync(file, 'utf-8')).toBe(shipped);

    // Owner overrides the body via the customization store.
    store.setSkillOverrideBody(TARGET, '---\nname: x\ndescription: 覆盖\n---\n自定义正文');
    store.invalidateCustomizationCache();

    // Next spawn re-runs ensurePluginSkills → file now carries the override.
    ensurePluginSkills('claude-code', dir);
    expect(readFileSync(file, 'utf-8')).toBe('---\nname: x\ndescription: 覆盖\n---\n自定义正文');
    expect(readFileSync(file, 'utf-8')).not.toBe(shipped);
  });

  it('停用某内置 skill 后再装即从磁盘移除其目录（无需重启）', () => {
    ensurePluginSkills('claude-code', dir);
    const skillDir = join(dir, 'skills', TARGET);
    expect(existsSync(skillDir)).toBe(true);

    store.setSkillDisabled(TARGET, true);
    store.invalidateCustomizationCache();

    ensurePluginSkills('claude-code', dir);
    expect(existsSync(skillDir)).toBe(false);
    // 其它未停用的 skill 仍在。
    expect(existsSync(join(dir, 'skills', BUILTIN_SKILLS[1].name))).toBe(true);
  });

  it('master 开关关闭时忽略覆盖，装回出厂正文', () => {
    store.setSkillOverrideBody(TARGET, 'OVERRIDE');
    store.setCustomizationEnabled(false);
    store.invalidateCustomizationCache();

    ensurePluginSkills('claude-code', dir);
    const file = join(dir, 'skills', TARGET, 'SKILL.md');
    expect(readFileSync(file, 'utf-8')).toBe(BUILTIN_SKILLS[0].content);
  });

  it('send 默认写稳定加载器，显式用户正文覆盖加载器，停用后删除', () => {
    const name = 'botmux-send';
    const file = join(dir, 'skills', name, 'SKILL.md');
    const skillDir = join(dir, 'skills', name);

    process.env.BOTMUX_REPLY_STYLE = JSON.stringify({ recipes: false, layout: false });
    ensurePluginSkills('claude-code', dir);
    expect(readFileSync(file, 'utf-8')).toBe(SEND_SKILL_SESSION_LOADER);

    process.env.BOTMUX_REPLY_STYLE = JSON.stringify({ recipes: true, layout: true });
    ensurePluginSkills('claude-code', dir);
    expect(readFileSync(file, 'utf-8')).toBe(SEND_SKILL_SESSION_LOADER);

    const custom = '---\nname: botmux-send\ndescription: 自定义\n---\n# 自定义发送规则';
    store.setSkillOverrideBody(name, custom);
    store.invalidateCustomizationCache();
    ensurePluginSkills('claude-code', dir);
    expect(readFileSync(file, 'utf-8')).toBe(custom);
    expect(builtinSkillContent(name, {
      BOTMUX_REPLY_STYLE: JSON.stringify({ recipes: false, layout: false }),
    })).toBe(custom);

    store.setSkillDisabled(name, true);
    store.invalidateCustomizationCache();
    ensurePluginSkills('claude-code', dir);
    expect(existsSync(skillDir)).toBe(false);
    expect(builtinSkillContent(name, {})).toBeUndefined();
  });
});
