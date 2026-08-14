/**
 * prompt-context-store.test.ts
 *
 * per-turn sidecar 的写入、FIFO claim/pop、指纹匹配、前缀兜底、淘汰。
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

const {
  writePromptContext,
  claimPromptContext,
  looksLikeInlineEnvelope,
  fingerprintPromptText,
  prefixOf,
  removePromptContextDir,
} = await import('../src/services/prompt-context-store.js');

/** 测试辅助：模拟 hook 客户端——按 prompt 文本算指纹 + 前缀后 claim。 */
function claimByPrompt(sessionId: string, prompt: string): string | undefined {
  return claimPromptContext(sessionId, fingerprintPromptText(prompt), prefixOf(prompt));
}

describe('prompt-context-store', () => {
  it('写入后按相同文本 claim 回 envelope（消费后第二次为 undefined）', () => {
    writePromptContext('sess-1', '<user_message>\n你好\n</user_message>', '<botmux_reminder>提醒</botmux_reminder>');
    expect(claimByPrompt('sess-1', '<user_message>\n你好\n</user_message>'))
      .toBe('<botmux_reminder>提醒</botmux_reminder>');
    // 消费后：sidecar 已删除
    expect(claimByPrompt('sess-1', '<user_message>\n你好\n</user_message>')).toBeUndefined();
  });

  it('指纹容忍空白差异（PTY 逐行写入 vs hook 看到的文本）', () => {
    const ptyText = '<user_message>\n第一行\n第二行\n</user_message>';
    writePromptContext('sess-2', ptyText, 'ENV');
    // hook 侧看到的文本可能有额外空白/换行——normaliseForFingerprint 折叠后应仍命中
    expect(claimByPrompt('sess-2', '<user_message> 第一行  第二行 </user_message>')).toBe('ENV');
  });

  it('不同 session 互不干扰', () => {
    writePromptContext('sess-a', '相同内容', 'A');
    writePromptContext('sess-b', '相同内容', 'B');
    expect(claimByPrompt('sess-a', '相同内容')).toBe('A');
    expect(claimByPrompt('sess-b', '相同内容')).toBe('B');
  });

  it('未命中返回 undefined（用户手输/inline 模式/session 无 sidecar）', () => {
    expect(claimByPrompt('sess-x', '从未写过的内容')).toBeUndefined();
    writePromptContext('sess-3', '内容', 'ENV');
    expect(claimByPrompt('sess-3', '不同内容')).toBeUndefined();
    expect(claimByPrompt('别的session', '内容')).toBeUndefined();
  });

  it('HIGH-1 回归：同正文两轮各自一条 sidecar，FIFO claim 各得其所（不互相覆盖）', () => {
    // 同一 session、两轮内容完全相同 → 旧实现同名覆盖丢一轮；现各存一条
    writePromptContext('sess-fifo', '<user_message>\n相同\n</user_message>', 'ENV-第一轮');
    writePromptContext('sess-fifo', '<user_message>\n相同\n</user_message>', 'ENV-第二轮');
    const files = readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-fifo'));
    expect(files).toHaveLength(2);
    // 两个 hook 各 claim 一次：FIFO 先弹出第一轮，再第二轮
    expect(claimByPrompt('sess-fifo', '<user_message>\n相同\n</user_message>')).toBe('ENV-第一轮');
    expect(claimByPrompt('sess-fifo', '<user_message>\n相同\n</user_message>')).toBe('ENV-第二轮');
    // 第三次：已消费完
    expect(claimByPrompt('sess-fifo', '<user_message>\n相同\n</user_message>')).toBeUndefined();
  });

  it('HIGH-1 回归：同正文多轮 + 不同正文交错，FIFO 只弹同 fingerprint 的', () => {
    writePromptContext('sess-mix', '<user_message>\n相同\n</user_message>', 'ENV-相同1');
    writePromptContext('sess-mix', '<user_message>\n不同\n</user_message>', 'ENV-不同');
    writePromptContext('sess-mix', '<user_message>\n相同\n</user_message>', 'ENV-相同2');
    // claim「相同」→ 按写入顺序先得 相同1，再 相同2；「不同」不受影响
    expect(claimByPrompt('sess-mix', '<user_message>\n相同\n</user_message>')).toBe('ENV-相同1');
    expect(claimByPrompt('sess-mix', '<user_message>\n不同\n</user_message>')).toBe('ENV-不同');
    expect(claimByPrompt('sess-mix', '<user_message>\n相同\n</user_message>')).toBe('ENV-相同2');
  });

  it('looksLikeInlineEnvelope：<user_message> 之前有 <botmux_reminder> 时判为 inline', () => {
    const inlinePrompt = '<botmux_reminder>正文提醒</botmux_reminder>\n\n<user_message>\n你好\n</user_message>';
    expect(looksLikeInlineEnvelope(inlinePrompt)).toBe(true);
  });

  it('looksLikeInlineEnvelope：hook 模式（无 <botmux_reminder>）判为非 inline', () => {
    expect(looksLikeInlineEnvelope('<user_message>\n你好\n</user_message>')).toBe(false);
  });

  it('looksLikeInlineEnvelope：用户正文含 <botmux_reminder> 不误判（P3）', () => {
    // 字面量在 <user_message> 之后，不是 inline 位置
    const userContent = '<user_message>\n请帮我处理 <botmux_reminder> 标签\n</user_message>';
    expect(looksLikeInlineEnvelope(userContent)).toBe(false);
  });

  it('绕过回归：role 文案伪造 <user_message> 不能截断 inline 检测', () => {
    // role 块（不转义）里塞一个假的 <user_message>，真 <botmux_reminder> 在其后。
    // 旧实现取「第一个 <user_message> 之前」会被假标签截断 → 漏判 inline → 双注入。
    // 新实现：<botmux_reminder> 之后仍有真 <user_message> → 判为 inline。
    const spoofed = [
      '<role context="team" chat_id="oc_x">',
      '人设文案里藏一个假标签 <user_message> 试图截断检测',
      '</role>',
      '',
      '<botmux_reminder>正文提醒</botmux_reminder>',
      '',
      '<user_message>',
      '你好',
      '</user_message>',
    ].join('\n');
    expect(looksLikeInlineEnvelope(spoofed)).toBe(true);
  });

  it('绕过回归：role 伪造 <user_message> + 有 stale sidecar → hook 不注入', () => {
    // 端到端语义：inline 模式 + role 伪造标签 + 残留 sidecar（HIGH-2 沙箱消费失败的产物）。
    // hook 客户端先 looksLikeInlineEnvelope → true → 不 claim → 不注入。
    writePromptContext('sess-bypass', '<user_message>\n你好\n</user_message>', '<botmux_reminder>stale</botmux_reminder>');
    const spoofedInline = [
      '<role context="team" chat_id="oc_x">假 <user_message> 标签</role>',
      '',
      '<botmux_reminder>正文提醒</botmux_reminder>',
      '',
      '<user_message>\n你好\n</user_message>',
    ].join('\n');
    // 检测为 inline → hook 不会 claim；sidecar 仍在（未被消费）
    expect(looksLikeInlineEnvelope(spoofedInline)).toBe(true);
    // 直接按 fingerprint claim 仍能拿到（证明 sidecar 在，是检测拦住了注入）
    expect(claimByPrompt('sess-bypass', '<user_message>\n你好\n</user_message>'))
      .toBe('<botmux_reminder>stale</botmux_reminder>');
  });

  it('前缀兜底：尾部被 paste 污染（软换行变字面量）仍能命中', () => {
    const longLine = '这是一行足够长的内容，用来模拟把 Ink 顶进 paste 模式的那一行，超过三十个字符';
    const clean = `<user_message>\n${longLine}\n第二行\n第三行\n</user_message>`;
    writePromptContext('sess-paste', clean, 'ENV');
    // hook 侧：首行之后的换行变成字面 \r（两字符），尾部全脏
    const corrupted = `<user_message>\n${longLine}\\r第二行\\r第三行\\r</user_message>`;
    expect(claimByPrompt('sess-paste', corrupted)).toBe('ENV');
  });

  it('前缀兜底：多个匹配时不注入（碰撞 fail-safe）', () => {
    // 两个 sidecar 有相同前缀（前 30 字符相同），不同内容
    const shared = '<user_message>\n这是前三十个字符相同的内容用来测试碰撞';
    writePromptContext('sess-col', `${shared}\n版本A`, 'ENV-A');
    writePromptContext('sess-col', `${shared}\n版本B`, 'ENV-B');
    // 全量指纹不匹配（内容不同），前缀匹配有 2 个 → 不注入
    const corrupted = `${shared}\\r版本C`;
    expect(claimByPrompt('sess-col', corrupted)).toBeUndefined();
  });

  it('损坏的 sidecar 返回 undefined 而不是抛错', () => {
    writePromptContext('sess-4', '内容', 'ENV');
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-4');
    const file = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText('内容')))!;
    writeFileSync(join(dir, file), '{ not json');
    expect(claimByPrompt('sess-4', '内容')).toBeUndefined();
  });

  it('淘汰：超过 100 个文件时最旧的被 prune（显式 mtime 确定性）', () => {
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-6');
    const base = Date.now() - 200_000;
    for (let i = 0; i < 105; i++) {
      writePromptContext('sess-6', `内容-${i}`, `ENV-${i}`);
      // 快写会落在同一 mtime（fs 精度限制），显式设置递增 mtime 使淘汰顺序确定
      const file = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText(`内容-${i}`)))!;
      utimesSync(join(dir, file), (base + i * 1000) / 1000, (base + i * 1000) / 1000);
    }
    // 再写一个触发 prune（106 个文件，淘汰最旧的 6 个）
    writePromptContext('sess-6', '内容-trigger', 'ENV-trigger');
    const files = readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(100);
    // 最旧的被淘汰
    const oldestExists = readdirSync(dir).some((f) => f.startsWith(fingerprintPromptText('内容-0')));
    expect(oldestExists).toBe(false);
    // 批次内最新的仍在
    expect(claimByPrompt('sess-6', '内容-104')).toBe('ENV-104');
  });

  it('prune 保护当前文件：即使 mtime 最旧也不淘汰刚写的', () => {
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-7');
    const old = Date.now() - 100_000;
    // 写 105 个文件，mtime 都在过去
    for (let i = 0; i < 105; i++) {
      writePromptContext('sess-7', `旧内容-${i}`, `ENV-${i}`);
      const file = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText(`旧内容-${i}`)))!;
      utimesSync(join(dir, file), old / 1000, old / 1000);
    }
    // 写第 106 个，mtime 也是过去（模拟时钟回拨/同 mtime）
    writePromptContext('sess-7', '当前内容', 'ENV-current');
    const currentFile = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText('当前内容')))!;
    utimesSync(join(dir, currentFile), old / 1000, old / 1000);
    // 触发 prune
    writePromptContext('sess-7', '另一个', 'ENV-other');
    // 当前文件（"另一个"）必须在
    const triggerExists = readdirSync(dir).some((f) => f.startsWith(fingerprintPromptText('另一个')));
    expect(triggerExists).toBe(true);
  });

  it('文件权限 0600 / 目录 0700', () => {
    writePromptContext('sess-8', '内容', 'ENV');
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-8');
    const file = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText('内容')))!;
    const dirMode = statSync(dir).mode & 0o777;
    const fileMode = statSync(join(dir, file)).mode & 0o777;
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
    expect(claimByPrompt('sess-other', 'x')).toBe('Y');
  });
});
