/**
 * prompt-context-store.test.ts
 *
 * per-turn sidecar 的写入、turnId 权威绑定 claim/pop、前缀兜底、淘汰。
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
  claimPromptContextAmongTurns,
  fingerprintPromptText,
  prefixOf,
  removePromptContextDir,
  removePromptContextForTurn,
  rekeyPromptContext,
} = await import('../src/services/prompt-context-store.js');

/** 测试辅助：模拟 hook 客户端——按 prompt 文本算指纹 + 前缀后，按 turnId claim。 */
function claimByPrompt(sessionId: string, turnId: string, prompt: string): string | undefined {
  return claimPromptContext(sessionId, turnId, fingerprintPromptText(prompt), prefixOf(prompt));
}

describe('prompt-context-store', () => {
  it('写入后按相同 turnId + 文本 claim 回 envelope（消费后第二次为 undefined）', () => {
    writePromptContext('sess-1', 'turn-1', '<user_message>\n你好\n</user_message>', '<botmux_reminder>提醒</botmux_reminder>');
    expect(claimByPrompt('sess-1', 'turn-1', '<user_message>\n你好\n</user_message>'))
      .toBe('<botmux_reminder>提醒</botmux_reminder>');
    // 消费后：sidecar 已删除
    expect(claimByPrompt('sess-1', 'turn-1', '<user_message>\n你好\n</user_message>')).toBeUndefined();
  });

  it('指纹容忍空白差异（PTY 逐行写入 vs hook 看到的文本）', () => {
    const ptyText = '<user_message>\n第一行\n第二行\n</user_message>';
    writePromptContext('sess-2', 'turn-1', ptyText, 'ENV');
    // hook 侧看到的文本可能有额外空白/换行——normaliseForFingerprint 折叠后应仍命中
    expect(claimByPrompt('sess-2', 'turn-1', '<user_message> 第一行  第二行 </user_message>')).toBe('ENV');
  });

  it('不同 session 互不干扰', () => {
    writePromptContext('sess-a', 'turn-1', '相同内容', 'A');
    writePromptContext('sess-b', 'turn-1', '相同内容', 'B');
    expect(claimByPrompt('sess-a', 'turn-1', '相同内容')).toBe('A');
    expect(claimByPrompt('sess-b', 'turn-1', '相同内容')).toBe('B');
  });

  it('未命中返回 undefined（用户手输/inline 模式/session 无 sidecar）', () => {
    expect(claimByPrompt('sess-x', 'turn-1', '从未写过的内容')).toBeUndefined();
    writePromptContext('sess-3', 'turn-1', '内容', 'ENV');
    expect(claimByPrompt('sess-3', 'turn-1', '不同内容')).toBeUndefined();
    expect(claimByPrompt('别的session', 'turn-1', '内容')).toBeUndefined();
  });

  it('HIGH-1 根治：同正文不同 turnId 各自绑定，claim 按权威 turnId 精确取（不 FIFO 串轮）', () => {
    // 同一 session、两轮内容完全相同 → 各存一条 (fingerprint, turnId) 记录
    writePromptContext('sess-fifo', 'turn-A', '<user_message>\n相同\n</user_message>', 'ENV-轮A');
    writePromptContext('sess-fifo', 'turn-B', '<user_message>\n相同\n</user_message>', 'ENV-轮B');
    const files = readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-fifo'));
    expect(files).toHaveLength(2);
    // 按权威 turnId claim：各得各的，不串轮
    expect(claimByPrompt('sess-fifo', 'turn-A', '<user_message>\n相同\n</user_message>')).toBe('ENV-轮A');
    expect(claimByPrompt('sess-fifo', 'turn-B', '<user_message>\n相同\n</user_message>')).toBe('ENV-轮B');
    // 已消费
    expect(claimByPrompt('sess-fifo', 'turn-A', '<user_message>\n相同\n</user_message>')).toBeUndefined();
  });

  it('HIGH-1 根治：某轮漏 claim 不污染后续轮（旧 FIFO 会串轮）', () => {
    // 轮 A 的 hook 崩了/没 claim；轮 B 同正文。轮 B claim 应得轮 B 的 envelope，
    // 不是轮 A 的旧 envelope（旧 FIFO 会按写入顺序把轮 A 的给轮 B）。
    writePromptContext('sess-miss', 'turn-A', '<user_message>\n相同\n</user_message>', 'ENV-轮A旧');
    writePromptContext('sess-miss', 'turn-B', '<user_message>\n相同\n</user_message>', 'ENV-轮B新');
    // 轮 A 没 claim，直接 claim 轮 B
    expect(claimByPrompt('sess-miss', 'turn-B', '<user_message>\n相同\n</user_message>')).toBe('ENV-轮B新');
    // 轮 A 的 envelope 仍在（孤儿，等 prune/TTL），但不会被轮 B 冒领
    expect(claimByPrompt('sess-miss', 'turn-A', '<user_message>\n相同\n</user_message>')).toBe('ENV-轮A旧');
  });

  it('turnId 不匹配时不返回（防跨轮冒领）', () => {
    writePromptContext('sess-t', 'turn-A', '内容', 'ENV-A');
    // 用错误的 turnId claim → 不返回
    expect(claimByPrompt('sess-t', 'turn-B', '内容')).toBeUndefined();
    // 正确的 turnId 仍能取到
    expect(claimByPrompt('sess-t', 'turn-A', '内容')).toBe('ENV-A');
  });

  it('sanitize 碰撞回归：含特殊字符的 turnId 不撞文件名（旧 lossy sanitize 会串轮）', () => {
    // 旧实现 sanitize 把非字母数字转 _：`turn/a` 和 `turn?a` 都变成 `turn_a`，
    // 后写覆盖前写，claim(`turn/a`) 取到 `turn?a` 的 envelope（跨轮串投）。
    // 现用全量 sha256(turnId) 做文件名键，两个 turnId 落不同文件，各取各的。
    writePromptContext('sess-col', 'turn/a', '<user_message>\n相同\n</user_message>', 'ENV-斜杠');
    writePromptContext('sess-col', 'turn?a', '<user_message>\n相同\n</user_message>', 'ENV-问号');
    const files = readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-col'));
    expect(files).toHaveLength(2);
    expect(claimByPrompt('sess-col', 'turn/a', '<user_message>\n相同\n</user_message>')).toBe('ENV-斜杠');
    expect(claimByPrompt('sess-col', 'turn?a', '<user_message>\n相同\n</user_message>')).toBe('ENV-问号');
  });

  it('前缀兜底：尾部被 paste 污染（软换行变字面量）仍能命中（按 turnId 定域）', () => {
    const longLine = '这是一行足够长的内容，用来模拟把 Ink 顶进 paste 模式的那一行，超过三十个字符';
    const clean = `<user_message>\n${longLine}\n第二行\n第三行\n</user_message>`;
    writePromptContext('sess-paste', 'turn-1', clean, 'ENV');
    // hook 侧：首行之后的换行变成字面 \r（两字符），尾部全脏
    const corrupted = `<user_message>\n${longLine}\\r第二行\\r第三行\\r</user_message>`;
    expect(claimByPrompt('sess-paste', 'turn-1', corrupted)).toBe('ENV');
  });

  it('前缀兜底按 turnId 定域：同正文多轮各自 paste 污染不互相干扰', () => {
    // 两轮同正文（同 prefix），轮 A paste 污染。按 turnId 定域后各取各的，
    // 不存在"多条同前缀碰撞"（旧实现会因 2 条匹配而拒绝，双丢）。
    const longLine = '这是一行足够长的内容，用来模拟把 Ink 顶进 paste 模式的那一行，超过三十个字符';
    const clean = `<user_message>\n${longLine}\n第二行\n</user_message>`;
    writePromptContext('sess-pc', 'turn-A', clean, 'ENV-A');
    writePromptContext('sess-pc', 'turn-B', clean, 'ENV-B');
    const corrupted = `<user_message>\n${longLine}\\r第二行\\r</user_message>`;
    expect(claimByPrompt('sess-pc', 'turn-A', corrupted)).toBe('ENV-A');
    expect(claimByPrompt('sess-pc', 'turn-B', corrupted)).toBe('ENV-B');
  });

  it('候选集同指纹有多条时 fail-open，且不消费任何 sidecar', () => {
    const prompt = '<user_message>\n继续\n</user_message>';
    writePromptContext('sess-ambiguous', 'turn-A', prompt, 'ENV-A');
    writePromptContext('sess-ambiguous', 'turn-B', prompt, 'ENV-B');
    const fingerprint = fingerprintPromptText(prompt);
    const prefix = prefixOf(prompt);
    expect(claimPromptContextAmongTurns('sess-ambiguous', ['turn-running', 'turn-A', 'turn-B'], fingerprint, prefix))
      .toBeUndefined();
    expect(readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-ambiguous'))).toHaveLength(2);
    // 歧义没有吞掉任何一轮；候选恢复唯一后仍各领各的。
    expect(claimPromptContextAmongTurns('sess-ambiguous', ['turn-A'], fingerprint, prefix))
      .toEqual({ turnId: 'turn-A', envelope: 'ENV-A' });
    expect(claimPromptContextAmongTurns('sess-ambiguous', ['turn-B'], fingerprint, prefix))
      .toEqual({ turnId: 'turn-B', envelope: 'ENV-B' });
  });

  it('候选集先做全局精确匹配，不让旧轮的前缀兜底抢走新轮精确命中', () => {
    const common = 'abcdefghijklmnopqrstuvwxyz一二三四五六七八九十';
    const promptA = `${common}-old-tail`;
    const promptB = `${common}-new-tail`;
    expect(prefixOf(promptA)).toBe(prefixOf(promptB));
    writePromptContext('sess-exact-first', 'turn-A', promptA, 'ENV-A');
    writePromptContext('sess-exact-first', 'turn-B', promptB, 'ENV-B');
    expect(claimPromptContextAmongTurns('sess-exact-first', ['turn-A', 'turn-B'],
      fingerprintPromptText(promptB), prefixOf(promptB)))
      .toEqual({ turnId: 'turn-B', envelope: 'ENV-B' });
    expect(claimByPrompt('sess-exact-first', 'turn-A', promptA)).toBe('ENV-A');
  });

  it('精确匹配为零时只允许全局唯一前缀匹配，多条同前缀同样不消费', () => {
    const common = 'abcdefghijklmnopqrstuvwxyz一二三四五六七八九十';
    const promptA = `${common}-old-tail`;
    const promptB = `${common}-new-tail`;
    writePromptContext('sess-prefix-ambiguous', 'turn-A', promptA, 'ENV-A');
    writePromptContext('sess-prefix-ambiguous', 'turn-B', promptB, 'ENV-B');
    const unmatchedFingerprint = fingerprintPromptText('paste-corrupted-tail');
    const prefix = prefixOf(promptB);
    expect(claimPromptContextAmongTurns('sess-prefix-ambiguous', ['turn-A', 'turn-B'], unmatchedFingerprint, prefix))
      .toBeUndefined();
    expect(readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-prefix-ambiguous'))).toHaveLength(2);
    expect(claimPromptContextAmongTurns('sess-prefix-ambiguous', ['turn-B'], unmatchedFingerprint, prefix))
      .toEqual({ turnId: 'turn-B', envelope: 'ENV-B' });
    expect(claimByPrompt('sess-prefix-ambiguous', 'turn-A', promptA)).toBe('ENV-A');
  });

  it('removePromptContextForTurn 只删除指定轮次', () => {
    writePromptContext('sess-remove-turn', 'turn-A', 'A', 'ENV-A');
    writePromptContext('sess-remove-turn', 'turn-B', 'B', 'ENV-B');
    removePromptContextForTurn('sess-remove-turn', 'turn-A');
    expect(claimByPrompt('sess-remove-turn', 'turn-A', 'A')).toBeUndefined();
    expect(claimByPrompt('sess-remove-turn', 'turn-B', 'B')).toBe('ENV-B');
  });

  it('损坏的 sidecar 返回 undefined 而不是抛错', () => {
    writePromptContext('sess-4', 'turn-1', '内容', 'ENV');
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-4');
    const file = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText('内容')))!;
    writeFileSync(join(dir, file), '{ not json');
    expect(claimByPrompt('sess-4', 'turn-1', '内容')).toBeUndefined();
  });

  it('淘汰：超过 100 个文件时最旧的被 prune（显式 mtime 确定性）', () => {
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-6');
    const base = Date.now() - 200_000;
    for (let i = 0; i < 105; i++) {
      writePromptContext('sess-6', `turn-${i}`, `内容-${i}`, `ENV-${i}`);
      // 快写会落在同一 mtime（fs 精度限制），显式设置递增 mtime 使淘汰顺序确定
      const file = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText(`内容-${i}`)))!;
      utimesSync(join(dir, file), (base + i * 1000) / 1000, (base + i * 1000) / 1000);
    }
    // 再写一个触发 prune（106 个文件，淘汰最旧的 6 个）
    writePromptContext('sess-6', 'turn-trigger', '内容-trigger', 'ENV-trigger');
    const files = readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(100);
    // 最旧的被淘汰
    const oldestExists = readdirSync(dir).some((f) => f.startsWith(fingerprintPromptText('内容-0')));
    expect(oldestExists).toBe(false);
    // 批次内最新的仍在
    expect(claimByPrompt('sess-6', 'turn-104', '内容-104')).toBe('ENV-104');
  });

  it('prune 保护当前文件：即使 mtime 最旧也不淘汰刚写的', () => {
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-7');
    const old = Date.now() - 100_000;
    // 写 105 个文件，mtime 都在过去
    for (let i = 0; i < 105; i++) {
      writePromptContext('sess-7', `turn-${i}`, `旧内容-${i}`, `ENV-${i}`);
      const file = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText(`旧内容-${i}`)))!;
      utimesSync(join(dir, file), old / 1000, old / 1000);
    }
    // 写第 106 个，mtime 也是过去（模拟时钟回拨/同 mtime）
    writePromptContext('sess-7', 'turn-current', '当前内容', 'ENV-current');
    const currentFile = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText('当前内容')))!;
    utimesSync(join(dir, currentFile), old / 1000, old / 1000);
    // 触发 prune
    writePromptContext('sess-7', 'turn-other', '另一个', 'ENV-other');
    // 当前文件（"另一个"）必须在
    const triggerExists = readdirSync(dir).some((f) => f.startsWith(fingerprintPromptText('另一个')));
    expect(triggerExists).toBe(true);
  });

  it('文件权限 0600 / 目录 0700', () => {
    writePromptContext('sess-8', 'turn-1', '内容', 'ENV');
    const dir = join(tmpRoot, 'prompt-ctx', 'sess-8');
    const file = readdirSync(dir).find((f) => f.startsWith(fingerprintPromptText('内容')))!;
    const dirMode = statSync(dir).mode & 0o777;
    const fileMode = statSync(join(dir, file)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('removePromptContextDir 删除整个 session 的 sidecar', () => {
    writePromptContext('sess-rm', 'turn-1', '内容1', 'ENV-1');
    writePromptContext('sess-rm', 'turn-2', '内容2', 'ENV-2');
    expect(readdirSync(join(tmpRoot, 'prompt-ctx', 'sess-rm'))).toHaveLength(2);
    removePromptContextDir('sess-rm');
    expect(existsSync(join(tmpRoot, 'prompt-ctx', 'sess-rm'))).toBe(false);
    // 幂等：再删不抛
    removePromptContextDir('sess-rm');
    // 不影响别的 session
    writePromptContext('sess-other', 'turn-1', 'x', 'Y');
    removePromptContextDir('sess-rm');
    expect(claimByPrompt('sess-other', 'turn-1', 'x')).toBe('Y');
  });

  it('rekeys a sidecar to the final PTY text when dispatch rewrites the prompt', () => {
    const assembled = '<shared_group_context>old background</shared_group_context>\n\n<user_message>\n任务\n</user_message>';
    const dispatched = '<user_message>\n任务\n</user_message>';
    writePromptContext('sess-1', 'turn-1', assembled, '<botmux_reminder>提醒</botmux_reminder>');
    expect(rekeyPromptContext('sess-1', 'turn-1', assembled, dispatched)).toBe(true);
    // The old key is gone; the final text claims the same envelope exactly once.
    expect(claimByPrompt('sess-1', 'turn-1', assembled)).toBeUndefined();
    expect(claimByPrompt('sess-1', 'turn-1', dispatched)).toBe('<botmux_reminder>提醒</botmux_reminder>');
    expect(claimByPrompt('sess-1', 'turn-1', dispatched)).toBeUndefined();
    // Unchanged text, another turn's sidecar, or a missing sidecar: nothing happens.
    writePromptContext('sess-1', 'turn-2', assembled, 'E2');
    expect(rekeyPromptContext('sess-1', 'turn-2', assembled, assembled)).toBe(false);
    expect(rekeyPromptContext('sess-1', 'turn-3', assembled, dispatched)).toBe(false);
    expect(claimByPrompt('sess-1', 'turn-2', assembled)).toBe('E2');
    // A sidecar written for a text the dispatcher never saw is still found by turnId.
    writePromptContext('sess-1', 'turn-4', 'builder text', 'E4');
    expect(rekeyPromptContext('sess-1', 'turn-4', 'something else', dispatched)).toBe(true);
    expect(claimByPrompt('sess-1', 'turn-4', dispatched)).toBe('E4');
  });

  it('aligns fingerprinting with sanitizeClaudeInput when text starts with ZWJ emoji or ZWSP', () => {
    // Claude PTY write strips ZWJ/ZWSP/BOM before typing; without <user_message>
    // leading user text starts at index 0, so both sides must produce identical keys.
    const rawFromFeishu = '\u200B👨\u200D👩\u200D👧\u200D👦 帮我看下这个报错\uFEFF';
    const sanitizedInClaude = rawFromFeishu.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    expect(fingerprintPromptText(rawFromFeishu)).toBe(fingerprintPromptText(sanitizedInClaude));
    expect(prefixOf(rawFromFeishu)).toBe(prefixOf(sanitizedInClaude));

    writePromptContext('sess-zwj', 'turn-zwj', rawFromFeishu, '<sender name="User" />');
    expect(claimPromptContext(
      'sess-zwj',
      'turn-zwj',
      fingerprintPromptText(sanitizedInClaude),
      prefixOf(sanitizedInClaude),
    )).toBe('<sender name="User" />');
  });

  it('supports chained rekeys across group-context, LinkRef, and worker <botmux_skills> appends', () => {
    const step0 = '<shared_group_context>bg</shared_group_context>\n\n帮我查报错';
    const step1 = '帮我查报错';
    const step2 = '帮我查报错\n\n<botmux_link_refs>L1=https://example.test</botmux_link_refs>';
    const step3 = `${step2}\n\n<botmux_skills mode="priority">- deploy</botmux_skills>`;

    writePromptContext('sess-chain', 'turn-chain', step0, '<sender name="U" />');
    expect(rekeyPromptContext('sess-chain', 'turn-chain', step0, step1)).toBe(true);
    expect(rekeyPromptContext('sess-chain', 'turn-chain', step1, step2)).toBe(true);
    expect(rekeyPromptContext('sess-chain', 'turn-chain', step2, step3)).toBe(true);

    expect(claimPromptContext('sess-chain', 'turn-chain', fingerprintPromptText(step0))).toBeUndefined();
    expect(claimPromptContext('sess-chain', 'turn-chain', fingerprintPromptText(step1))).toBeUndefined();
    expect(claimPromptContext('sess-chain', 'turn-chain', fingerprintPromptText(step2))).toBeUndefined();
    expect(claimPromptContext('sess-chain', 'turn-chain', fingerprintPromptText(step3))).toBe('<sender name="U" />');
  });

  it('maintains single-sidecar-per-turn invariant when writePromptContext rebuilds the same turnId', () => {
    const prefix = '这是一个超过三十个字符的相同前缀用于验证重建替换逻辑';
    const first = `${prefix} 版本一`;
    const second = `${prefix} 版本二`;
    writePromptContext('sess-rebuild', 'turn-same', first, 'OLD_ENV');
    writePromptContext('sess-rebuild', 'turn-same', second, 'NEW_ENV');

    // Old file was unlinked on rebuild; prefix fallback and rekey see exactly 1 file.
    expect(claimPromptContext('sess-rebuild', 'turn-same', fingerprintPromptText(first))).toBeUndefined();
    expect(rekeyPromptContext('sess-rebuild', 'turn-same', second, `${second} tail`)).toBe(true);
    expect(claimByPrompt('sess-rebuild', 'turn-same', `${second} tail`)).toBe('NEW_ENV');
  });
});
