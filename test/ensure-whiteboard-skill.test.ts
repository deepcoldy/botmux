import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureWhiteboardSkill } from '../src/skills/installer.js';
import { WHITEBOARD_SKILL, WHITEBOARD_SKILL_NAME } from '../src/skills/definitions.js';

// 白板能力默认关闭，是可选增强：它的 skill 不进 BUILTIN_SKILLS（那会被无条件安装），
// 而是按 whiteboardEnabled() 动态写入 / 删除（与 botmux-ask 同构）：
//   install=true（白板开启）→ 写入 botmux-whiteboard/SKILL.md
//   install=false（白板关闭）→ 删除该目录（agent 不会看到一个用不了的能力）
describe('ensureWhiteboardSkill', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wb-skill-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const skillFile = () => join(dir, WHITEBOARD_SKILL_NAME, 'SKILL.md');

  it('install=true：写入 botmux-whiteboard/SKILL.md，内容为 WHITEBOARD_SKILL', () => {
    ensureWhiteboardSkill('claude-code', dir, true);
    expect(existsSync(skillFile())).toBe(true);
    expect(readFileSync(skillFile(), 'utf-8')).toBe(WHITEBOARD_SKILL);
  });

  it('install=false：删除已存在的 botmux-whiteboard（白板关闭 / 旧版残留清理）', () => {
    mkdirSync(join(dir, WHITEBOARD_SKILL_NAME), { recursive: true });
    writeFileSync(skillFile(), WHITEBOARD_SKILL, 'utf-8');
    ensureWhiteboardSkill('claude-code', dir, false);
    expect(existsSync(join(dir, WHITEBOARD_SKILL_NAME))).toBe(false);
  });

  it('install=false 且本就不存在：no-op，不报错', () => {
    expect(() => ensureWhiteboardSkill('codex', dir, false)).not.toThrow();
    expect(existsSync(join(dir, WHITEBOARD_SKILL_NAME))).toBe(false);
  });

  it('install=true 幂等：内容相同则不重复报错，文件仍在', () => {
    ensureWhiteboardSkill('claude-code', dir, true);
    expect(() => ensureWhiteboardSkill('claude-code', dir, true)).not.toThrow();
    expect(readFileSync(skillFile(), 'utf-8')).toBe(WHITEBOARD_SKILL);
  });

  it('开 → 关：先写入再删除，目录被清掉（模拟运行时切换开关）', () => {
    ensureWhiteboardSkill('claude-code', dir, true);
    expect(existsSync(skillFile())).toBe(true);
    ensureWhiteboardSkill('claude-code', dir, false);
    expect(existsSync(join(dir, WHITEBOARD_SKILL_NAME))).toBe(false);
  });

  it('skillsDir 为 undefined：直接跳过（无 skills 目录的 CLI）', () => {
    expect(() => ensureWhiteboardSkill('cursor', undefined, true)).not.toThrow();
  });
});
