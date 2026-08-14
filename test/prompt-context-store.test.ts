/**
 * prompt-context-store.test.ts
 *
 * per-turn sidecar 的读写、指纹对齐（空白容忍）、淘汰。
 * Run: pnpm vitest run test/prompt-context-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
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

const { writePromptContext, readPromptContext, fingerprintPromptText } = await import('../src/services/prompt-context-store.js');

describe('prompt-context-store', () => {
  it('写入后按相同文本读回 envelope', () => {
    writePromptContext('sess-1', '<user_message>\n你好\n</user_message>', '<botmux_reminder>提醒</botmux_reminder>');
    expect(readPromptContext('sess-1', '<user_message>\n你好\n</user_message>'))
      .toBe('<botmux_reminder>提醒</botmux_reminder>');
  });

  it('指纹容忍空白差异（PTY 逐行写入 vs hook 看到的文本）', () => {
    const ptyText = '<user_message>\n第一行\n第二行\n</user_message>';
    writePromptContext('sess-2', ptyText, 'ENV');
    // hook 侧看到的文本可能有额外空白/换行——normaliseForFingerprint 折叠后应仍命中
    expect(readPromptContext('sess-2', '<user_message> 第一行  第二行 </user_message>')).toBe('ENV');
    expect(readPromptContext('sess-2', '\n<user_message>\n第一行\n第二行\n</user_message>\n')).toBe('ENV');
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

  it('淘汰：超过 100 个文件时最旧的被 prune', () => {
    for (let i = 0; i < 105; i++) {
      writePromptContext('sess-6', `内容-${i}`, `ENV-${i}`);
    }
    const files = readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-6'));
    expect(files.length).toBeLessThanOrEqual(100);
    // 最旧的 5 个应被淘汰
    expect(existsSync(join(tmpRoot, 'prompt-ctx', 'sess-6', `${fingerprintPromptText('内容-0')}.json`))).toBe(false);
    // 最新的仍在
    expect(readPromptContext('sess-6', '内容-104')).toBe('ENV-104');
  });

  it('文件权限 0600 / 目录 0700', () => {
    writePromptContext('sess-7', '内容', 'ENV');
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-7');
    const file = join(dir, `${fingerprintPromptText('内容')}.json`);
    const dirMode = statSync(dir).mode & 0o777;
    const fileMode = statSync(file).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});
