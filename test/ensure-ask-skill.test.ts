import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureAskSkill } from '../src/skills/installer.js';
import { ASK_SKILL, ASK_SKILL_NAME } from '../src/skills/definitions.js';

// hook 优先 + 非 hook CLI 兜底：
//   install=true（无 hook 的 CLI）→ 写入 botmux-ask SKILL.md
//   install=false（有 hook 的 CLI）→ 删除 botmux-ask（避免与 hook 双重弹卡）
describe('ensureAskSkill', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ask-skill-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const skillFile = () => join(dir, ASK_SKILL_NAME, 'SKILL.md');

  it('install=true：写入 botmux-ask/SKILL.md，内容为 ASK_SKILL', () => {
    ensureAskSkill('codex', dir, true);
    expect(existsSync(skillFile())).toBe(true);
    expect(readFileSync(skillFile(), 'utf-8')).toBe(ASK_SKILL);
  });

  it('install=false：删除已存在的 botmux-ask（hook 接管的 CLI）', () => {
    mkdirSync(join(dir, ASK_SKILL_NAME), { recursive: true });
    writeFileSync(skillFile(), ASK_SKILL, 'utf-8');
    ensureAskSkill('claude-code', dir, false);
    expect(existsSync(join(dir, ASK_SKILL_NAME))).toBe(false);
  });

  it('install=false 且本就不存在：no-op，不报错', () => {
    expect(() => ensureAskSkill('claude-code', dir, false)).not.toThrow();
    expect(existsSync(join(dir, ASK_SKILL_NAME))).toBe(false);
  });

  it('skillsDir 为 undefined：直接跳过', () => {
    expect(() => ensureAskSkill('cursor', undefined, true)).not.toThrow();
  });
});
