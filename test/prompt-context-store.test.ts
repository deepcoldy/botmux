/**
 * prompt-context-store.test.ts
 *
 * per-turn sidecar 的读写、指纹匹配、前缀兜底、读后消费、淘汰。
 * Run: pnpm vitest run test/prompt-context-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 每个用例独立 SESSION_DATA_DIR（config.session.dataDir 读 env）
let tmpRoot: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'botmux-pctx-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmpRoot;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
});

const { writePromptContext, readPromptContext, fingerprintPromptText, removePromptContextDir } = await import('../src/services/prompt-context-store.js');

describe('prompt-context-store', () => {
  it('写入后按相同文本读回 envelope（读后消费，第二次读为 undefined）', () => {
    writePromptContext('sess-1', '<user_message>\n你好\n</user_message>', '<botmux_reminder>提醒</botmux_reminder>');
    expect(readPromptContext('sess-1', '<user_message>\n你好\n</user_message>'))
      .toBe('<botmux_reminder>提醒</botmux_reminder>');
    // 读后消费：sidecar 已删除
    expect(readPromptContext('sess-1', '<user_message>\n你好\n</user_message>')).toBeUndefined();
  });

  it('指纹容忍空白差异（PTY 逐行写入 vs hook 看到的文本）', () => {
    const ptyText = '<user_message>\n第一行\n第二行\n</user_message>';
    writePromptContext('sess-2', ptyText, 'ENV');
    // hook 侧看到的文本可能有额外空白/换行——normaliseForFingerprint 折叠后应仍命中
    expect(readPromptContext('sess-2', '<user_message> 第一行  第二行 </user_message>')).toBe('ENV');
  });

  it('不同 session 互不干扰', () => {
    writePromptContext('sess-a', '相同内容', 'A');
    writePromptContext('sess-b', '相同内容', 'B');
    expect(readPromptContext('sess-a', '相同内容')).toBe('A');
    expect(readPromptContext('sess-b', '相同内容')).toBe('B');
  });

  it('未命中返回 undefined（用户手输/inline 模式/session 无 sidecar）', () => {
    expect(readPromptContext('sess-x', '从未写过的内容')).toBeUndefined();
    writePromptContext('sess-3', '内容', 'ENV');
    expect(readPromptContext('sess-3', '不同内容')).toBeUndefined();
    expect(readPromptContext('别的session', '内容')).toBeUndefined();
  });

  it('inline 检测：<user_message> 之前有 <botmux_reminder> 时不注入', () => {
    writePromptContext('sess-inline', '<user_message>\n你好\n</user_message>', '<botmux_reminder>隐藏</botmux_reminder>');
    // inline 模式的 prompt：reminder 在 user_message 之前
    const inlinePrompt = '<botmux_reminder>正文提醒</botmux_reminder>\n\n<user_message>\n你好\n</user_message>';
    expect(readPromptContext('sess-inline', inlinePrompt)).toBeUndefined();
    // sidecar 未被消费（inline 检测在匹配之前）
    expect(readPromptContext('sess-inline', '<user_message>\n你好\n</user_message>')).toBe('<botmux_reminder>隐藏</botmux_reminder>');
  });

  it('inline 检测：用户正文含 <botmux_reminder> 不误判（P3）', () => {
    writePromptContext('sess-p3', '<user_message>\n请帮我处理 <botmux_reminder> 标签\n</user_message>', '<botmux_reminder>隐藏</botmux_reminder>');
    // 用户正文里有 <botmux_reminder>，但在 <user_message> 之后，不应误判为 inline
    const userContent = '<user_message>\n请帮我处理 <botmux_reminder> 标签\n</user_message>';
    expect(readPromptContext('sess-p3', userContent)).toBe('<botmux_reminder>隐藏</botmux_reminder>');
  });

  it('前缀兜底：尾部被 paste 污染（软换行变字面量）仍能命中', () => {
    const longLine = '这是一行足够长的内容，用来模拟把 Ink 顶进 paste 模式的那一行，超过三十个字符';
    const clean = `<user_message>\n${longLine}\n第二行\n第三行\n</user_message>`;
    writePromptContext('sess-paste', clean, 'ENV');
    // hook 侧：首行之后的换行变成字面 \r（两字符），尾部全脏
    const corrupted = `<user_message>\n${longLine}\\r第二行\\r第三行\\r</user_message>`;
    expect(readPromptContext('sess-paste', corrupted)).toBe('ENV');
  });

  it('前缀兜底：多个匹配时不注入（碰撞 fail-safe）', () => {
    // 两个 sidecar 有相同前缀（前 30 字符相同），不同内容
    const shared = '<user_message>\n这是前三十个字符相同的内容用来测试碰撞';
    writePromptContext('sess-col', `${shared}\n版本A`, 'ENV-A');
    writePromptContext('sess-col', `${shared}\n版本B`, 'ENV-B');
    // 全量指纹不匹配（内容不同），前缀匹配有 2 个 → 不注入
    const corrupted = `${shared}\\r版本C`;
    expect(readPromptContext('sess-col', corrupted)).toBeUndefined();
  });

  it('损坏的 sidecar 返回 undefined 而不是抛错', () => {
    writePromptContext('sess-4', '内容', 'ENV');
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-4');
    const file = join(dir, `${fingerprintPromptText('内容')}.json`);
    writeFileSync(file, '{ not json');
    expect(readPromptContext('sess-4', '内容')).toBeUndefined();
  });

  it('同内容重写幂等（覆盖同一文件）', () => {
    writePromptContext('sess-5', '内容', 'ENV-1');
    writePromptContext('sess-5', '内容', 'ENV-2');
    const files = readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-5'));
    expect(files).toHaveLength(1);
    expect(readPromptContext('sess-5', '内容')).toBe('ENV-2');
  });

  it('淘汰：超过 100 个文件时最旧的被 prune（显式 mtime 确定性）', () => {
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-6');
    const base = Date.now() - 200_000;
    for (let i = 0; i < 105; i++) {
      writePromptContext('sess-6', `内容-${i}`, `ENV-${i}`);
      // 快写会落在同一 mtime（fs 精度限制），显式设置递增 mtime 使淘汰顺序确定
      const file = join(dir, `${fingerprintPromptText(`内容-${i}`)}.json`);
      utimesSync(file, (base + i * 1000) / 1000, (base + i * 1000) / 1000);
    }
    // 再写一个触发 prune（106 个文件，淘汰最旧的 6 个）
    writePromptContext('sess-6', '内容-trigger', 'ENV-trigger');
    const files = readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(100);
    // 最旧的被淘汰
    expect(existsSync(join(dir, `${fingerprintPromptText('内容-0')}.json`))).toBe(false);
    // 批次内最新的仍在
    expect(readPromptContext('sess-6', '内容-104')).toBe('ENV-104');
  });

  it('prune 保护当前文件：即使 mtime 最旧也不淘汰刚写的', () => {
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-7');
    const old = Date.now() - 100_000;
    // 写 105 个文件，mtime 都在过去
    for (let i = 0; i < 105; i++) {
      writePromptContext('sess-7', `旧内容-${i}`, `ENV-${i}`);
      const file = join(dir, `${fingerprintPromptText(`旧内容-${i}`)}.json`);
      utimesSync(file, old / 1000, old / 1000);
    }
    // 写第 106 个，mtime 也是过去（模拟时钟回拨/同 mtime）
    writePromptContext('sess-7', '当前内容', 'ENV-current');
    const currentFile = join(dir, `${fingerprintPromptText('当前内容')}.json`);
    utimesSync(currentFile, old / 1000, old / 1000);
    // 触发 prune
    writePromptContext('sess-7', '另一个', 'ENV-other');
    // 当前文件（"另一个"）必须在；"当前内容"可能被淘汰（mtime 旧且非当前）
    expect(existsSync(join(dir, `${fingerprintPromptText('另一个')}.json`))).toBe(true);
  });

  it('文件权限 0600 / 目录 0700', () => {
    writePromptContext('sess-8', '内容', 'ENV');
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-8');
    const file = join(dir, `${fingerprintPromptText('内容')}.json`);
    const dirMode = statSync(dir).mode & 0o777;
    const fileMode = statSync(file).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('removePromptContextDir 删除整个 session 的 sidecar', () => {
    writePromptContext('sess-rm', '内容1', 'ENV-1');
    writePromptContext('sess-rm', '内容2', 'ENV-2');
    expect(readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-rm'))).toHaveLength(2);
    removePromptContextDir('sess-rm');
    expect(existsSync(join(tmpRoot, 'prompt-ctx', 'sess-rm'))).toBe(false);
    // 幂等：再删不抛
    removePromptContextDir('sess-rm');
    // 不影响别的 session
    writePromptContext('sess-other', 'x', 'Y');
    removePromptContextDir('sess-rm');
    expect(readPromptContext('sess-other', 'x')).toBe('Y');
  });
});
