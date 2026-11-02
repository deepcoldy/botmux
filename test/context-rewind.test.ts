import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSameInode,
  findCheckpoint,
  rewindClaudeTranscript,
  scanClaudeTranscriptCheckpoints,
  summarizeUserText,
  waitForTranscriptQuiet,
} from '../src/core/context-rewind.js';

const dirs: string[] = [];

function fixture(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-rewind-'));
  dirs.push(dir);
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const userTurn = (text: string, uuid: string, at = '2026-10-31T01:00:00.000Z') => ({
  type: 'user',
  message: { role: 'user', content: `<user_message>\n${text}\n</user_message>` },
  uuid,
  timestamp: at,
});
const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
const toolResult = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
};

describe('scanClaudeTranscriptCheckpoints', () => {
  it('只把真实用户轮次当检查点，返回从新到旧并带行首偏移', () => {
    const path = fixture([userTurn('第一轮', 'u1'), assistant, toolResult, userTurn('第二轮', 'u2'), assistant]);

    const checkpoints = scanClaudeTranscriptCheckpoints(path, 10);
    expect(checkpoints.map(cp => [cp.index, cp.preview, cp.uuid])).toEqual([[1, '第二轮', 'u2'], [2, '第一轮', 'u1']]);
    const raw = readFileSync(path);
    expect(checkpoints[1]!.offset).toBe(0);
    expect(raw[checkpoints[0]!.offset - 1]).toBe(0x0a);
    expect(raw.subarray(checkpoints[0]!.offset).toString()).toMatch(/^\{"type":"user".*第二轮/);
  });

  it('isMeta / compact 摘要 / sidechain / 斜杠命令包装 / 任务通知都不算轮次起点', () => {
    const path = fixture([
      userTurn('真的一轮', 'u1'),
      { ...userTurn('meta', 'm1'), isMeta: true },
      { ...userTurn('summary', 's1'), isCompactSummary: true },
      { ...userTurn('side', 'sc1'), isSidechain: true },
      { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/compact</command-name>' } },
      { type: 'user', uuid: 'n1', message: { role: 'user', content: '<task-notification>done</task-notification>' } },
    ]);
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => cp.uuid)).toEqual(['u1']);
  });

  it('type-ahead 出队是新轮次；轮中吸收的排队消息不是', () => {
    const queued = (prompt: string, uuid: string, absorbed: boolean) => ({
      type: 'attachment',
      uuid,
      attachment: { type: 'queued_command', prompt },
      ...(absorbed ? { renderedRole: 'system' } : {}),
    });
    const path = fixture([
      userTurn('a', 'u1'), assistant,
      queued('轮中补充', 'q1', true), assistant,
      queued('排队的新问题', 'q2', false), assistant,
    ]);
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => cp.uuid)).toEqual(['q2', 'u1']);
  });

  it('最近一次 compact 之前的检查点标记为 beforeCompaction', () => {
    const path = fixture([
      userTurn('压缩前', 'u1'), assistant,
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb' },
      { ...userTurn('summary', 's1'), isCompactSummary: true },
      userTurn('压缩后', 'u2'), assistant,
    ]);
    const cps = scanClaudeTranscriptCheckpoints(path);
    expect(cps.map(cp => [cp.uuid, cp.beforeCompaction])).toEqual([['u2', false], ['u1', true]]);
  });

  it('末尾没有换行的半行不算检查点', () => {
    const path = fixture([userTurn('a', 'u1'), assistant]);
    appendFileSync(path, JSON.stringify(userTurn('写了一半', 'u2')));
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => cp.uuid)).toEqual(['u1']);
  });

  it('最多返回 limit 个，且 index=1 仍是最新', () => {
    const path = fixture([userTurn('a', 'u1'), userTurn('b', 'u2'), userTurn('c', 'u3')]);
    const checkpoints = scanClaudeTranscriptCheckpoints(path, 2);
    expect(checkpoints.map(cp => cp.preview)).toEqual(['c', 'b']);
    expect(checkpoints.map(cp => cp.index)).toEqual([1, 2]);
  });
});

describe('resumable', () => {
  it('第一轮之前只剩元数据行：不可回退；之后的轮次可回退', () => {
    const meta = { type: 'permission-mode', permissionMode: 'default', sessionId: 's' };
    const path = fixture([meta, userTurn('第一轮', 'u1'), assistant, userTurn('第二轮', 'u2')]);
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => [cp.uuid, cp.resumable])).toEqual([['u2', true], ['u1', false]]);
  });

  it('嵌套记录里的 "type":"assistant" 不会把第一轮标成可恢复（fail-closed）', () => {
    // attachment 等嵌套对象的 type 字段在 JSON 文本里同样带真引号；廉价子串闸
    // 若直接翻 sawConversation，就会允许截断到只剩元数据行（--resume 必然失败）。
    const nested = { type: 'attachment', attachment: { type: 'assistant', text: 'lookalike' } };
    const meta = { type: 'permission-mode', permissionMode: 'default' };
    const path = fixture([meta, nested, userTurn('第一轮', 'u1'), assistant]);
    const cps = scanClaudeTranscriptCheckpoints(path);
    expect(cps.map(cp => [cp.uuid, cp.resumable])).toEqual([['u1', false]]);
  });
});

describe('findCheckpoint', () => {
  it('预览后又来了一轮：按 uuid 找回原来那一轮，而不是按序号删错', () => {
    const path = fixture([userTurn('毒消息', 'u1'), assistant]);
    const [picked] = scanClaudeTranscriptCheckpoints(path);
    appendFileSync(path, `${JSON.stringify(userTurn('新的一轮', 'u2'))}\n`);
    const rescanned = scanClaudeTranscriptCheckpoints(path);
    expect(rescanned[0]!.uuid).toBe('u2');
    expect(findCheckpoint(rescanned, picked!)?.uuid).toBe('u1');
  });

  it('原来那一轮已经不在了就返回 undefined', () => {
    const path = fixture([userTurn('a', 'u1')]);
    expect(findCheckpoint(scanClaudeTranscriptCheckpoints(path), { offset: 0, preview: 'x', uuid: 'gone' })).toBeUndefined();
  });
});

describe('rewindClaudeTranscript', () => {
  it('截断到检查点并保留完整备份', () => {
    const path = fixture([userTurn('第一轮', 'u1'), assistant, userTurn('第二轮', 'u2')]);
    const before = statSync(path).size;
    const [latest] = scanClaudeTranscriptCheckpoints(path, 10);
    const result = rewindClaudeTranscript(path, latest!.offset, Date.UTC(2026, 9, 31, 1, 10, 0));

    expect(result.removedBytes).toBe(before - latest!.offset);
    expect(statSync(path).size).toBe(latest!.offset);
    expect(readFileSync(result.backupPath, 'utf8')).toContain('第二轮');
    expect(readFileSync(path, 'utf8')).not.toContain('第二轮');
    // The kept prefix must still be whole JSONL lines for --resume to parse.
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('拒绝非行首偏移和 0 偏移', () => {
    const path = fixture([userTurn('ab', 'u1'), userTurn('cd', 'u2')]);
    expect(() => rewindClaudeTranscript(path, 3)).toThrow(/line boundary/);
    expect(() => rewindClaudeTranscript(path, 0)).toThrow(/invalid rewind offset/);
  });
});

describe('assertSameInode', () => {
  it('dev/ino 一致时放行，任一不符即拒绝', () => {
    expect(() => assertSameInode({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }, 'x')).not.toThrow();
    expect(() => assertSameInode({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }, 'x')).toThrow(/replaced between validation and open/);
    expect(() => assertSameInode({ dev: 1, ino: 2 }, { dev: 9, ino: 2 }, 'x')).toThrow(/replaced between validation and open/);
  });
});

describe('rewindClaudeTranscript 文件安全', () => {
  it('拒绝符号链接，不截断链接指向的文件', () => {
    const real = fixture([userTurn('a', 'u1'), userTurn('b', 'u2')]);
    const link = `${real}.link.jsonl`;
    symlinkSync(real, link);
    const before = statSync(real).size;
    const [latest] = scanClaudeTranscriptCheckpoints(real);
    expect(() => rewindClaudeTranscript(link, latest!.offset)).toThrow(/non-regular/);
    expect(statSync(real).size).toBe(before);
  });

  it('备份路径已存在（含预埋链接）时失败且不截断', () => {
    const path = fixture([userTurn('a', 'u1'), userTurn('b', 'u2')]);
    const now = Date.UTC(2026, 9, 31, 1, 10, 0);
    const victim = fixture([assistant]);
    const victimBefore = readFileSync(victim, 'utf8');
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    symlinkSync(victim, `${path}.rewind-${stamp}.bak`);
    const before = statSync(path).size;
    const [latest] = scanClaudeTranscriptCheckpoints(path);
    expect(() => rewindClaudeTranscript(path, latest!.offset, now)).toThrow();
    expect(statSync(path).size).toBe(before);
    expect(readFileSync(victim, 'utf8')).toBe(victimBefore);
    expect(existsSync(victim)).toBe(true);
  });

  it('源路径在描述符校验后被换成软链：备份与截断仍钉在原 inode，不读链接目标', () => {
    // 沙盒 agent 可在备份瞬间 unlink 原文件并把路径换成指向宿主文件的软链。
    // 备份只允许从已 O_NOFOLLOW 打开的源 fd 读：链接目标内容绝不能进 .bak。
    const path = fixture([userTurn('第一轮', 'u1'), assistant, userTurn('第二轮', 'u2')]);
    const victim = fixture([{ type: 'user', message: { role: 'user', content: 'HOST_SECRET_TOKEN' } }]);
    const victimBefore = readFileSync(victim, 'utf8');
    const aside = `${path}.moved-aside`;
    const [latest] = scanClaudeTranscriptCheckpoints(path);
    const result = rewindClaudeTranscript(
      path,
      latest!.offset,
      Date.UTC(2026, 9, 31, 2, 0, 0),
      {
        beforeBackup: () => {
          renameSync(path, aside);
          symlinkSync(victim, path);
        },
      },
    );
    const backupText = readFileSync(result.backupPath, 'utf8');
    expect(backupText).toContain('第二轮');
    expect(backupText).not.toContain('HOST_SECRET_TOKEN');
    // 链接目标没有被动过。
    expect(readFileSync(victim, 'utf8')).toBe(victimBefore);
    // 截断落在被钉住的原 inode（此刻挂在 aside 路径下）。
    expect(statSync(aside).size).toBe(latest!.offset);
    expect(readFileSync(aside, 'utf8')).not.toContain('第二轮');
  });

  it('备份期间源文件被追加（大小变化）：拒绝截断并清掉半成品备份', () => {
    const path = fixture([userTurn('第一轮', 'u1'), assistant, userTurn('第二轮', 'u2')]);
    const before = statSync(path).size;
    const now = Date.UTC(2026, 9, 31, 4, 0, 0);
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const backupPath = `${path}.rewind-${stamp}.bak`;
    const [latest] = scanClaudeTranscriptCheckpoints(path);
    expect(() => rewindClaudeTranscript(
      path,
      latest!.offset,
      now,
      { beforeBackup: () => appendFileSync(path, JSON.stringify(userTurn('晚到', 'uLate')) + '\n') },
    )).toThrow(/changed size/);
    // 活 CLI 还在写的文件没有被截断。
    expect(statSync(path).size).toBeGreaterThan(before);
    expect(readFileSync(path, 'utf8')).toContain('第二轮');
    expect(existsSync(backupPath)).toBe(false);
  });

  it('备份目标路径被目录占用：失败且原文件不动（replay 回滚由 handler 用例钉）', () => {
    const path = fixture([userTurn('第一轮', 'u1'), assistant, userTurn('第二轮', 'u2')]);
    const now = Date.UTC(2026, 9, 31, 5, 0, 0);
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const backupDir = `${path}.rewind-${stamp}.bak`;
    mkdirSync(backupDir);
    const before = statSync(path).size;
    const [latest] = scanClaudeTranscriptCheckpoints(path);
    expect(() => rewindClaudeTranscript(path, latest!.offset, now)).toThrow();
    expect(statSync(path).size).toBe(before);
    expect(readFileSync(path, 'utf8')).toContain('第二轮');
  });

  it('lstat 与 open 之间被换成另一个普通文件：拒绝，两个文件都不截断', () => {
    const path = fixture([userTurn('第一轮', 'u1'), assistant, userTurn('第二轮', 'u2')]);
    const foreign = fixture([userTurn('无关会话', 'uX'), assistant]);
    const originalSize = statSync(path).size;
    const foreignSize = statSync(foreign).size;
    const [latest] = scanClaudeTranscriptCheckpoints(path);
    expect(() => rewindClaudeTranscript(
      path,
      latest!.offset,
      Date.now(),
      {
        beforeOpen: () => {
          // Reproduce the lstat→open race: the pathname now names a different
          // REGULAR file (O_NOFOLLOW would only catch a symlink).
          renameSync(path, `${path}.hidden`);
          renameSync(foreign, path);
        },
      },
    )).toThrow(/replaced between validation and open/);
    // Neither the original transcript nor the swapped-in file was truncated.
    expect(statSync(`${path}.hidden`).size).toBe(originalSize);
    expect(statSync(path).size).toBe(foreignSize);
  });
});

describe('waitForTranscriptQuiet', () => {
  const fakeClock = (onTick?: (n: number) => void) => {
    let ticks = 0;
    return async (_ms: number) => { ticks += 1; onTick?.(ticks); };
  };

  it('文件还在增长时一直等，停下来连续 quietMs 才返回 true', async () => {
    const path = fixture([userTurn('a', 'u1')]);
    const grewAt: number[] = [];
    const ok = await waitForTranscriptQuiet(path, {
      quietMs: 300, pollMs: 100, timeoutMs: 5000,
      sleep: fakeClock(n => { if (n <= 4) { appendFileSync(path, 'x\n'); grewAt.push(n); } }),
    });
    expect(ok).toBe(true);
    expect(grewAt).toEqual([1, 2, 3, 4]);
  });

  it('短于 quietMs 的停顿不算写完', async () => {
    const path = fixture([userTurn('a', 'u1')]);
    let lastTick = 0;
    // Writes on ticks 1, 3, 5: each pause is one poll (100ms) < quietMs (300ms).
    const ok = await waitForTranscriptQuiet(path, {
      quietMs: 300, pollMs: 100, timeoutMs: 5000,
      sleep: fakeClock(n => { lastTick = n; if (n === 1 || n === 3 || n === 5) appendFileSync(path, 'x\n'); }),
    });
    expect(ok).toBe(true);
    expect(lastTick).toBe(8);
  });

  it('一直在写就超时返回 false', async () => {
    const path = fixture([userTurn('a', 'u1')]);
    const ok = await waitForTranscriptQuiet(path, {
      quietMs: 300, pollMs: 100, timeoutMs: 1000,
      sleep: fakeClock(() => appendFileSync(path, 'x\n')),
    });
    expect(ok).toBe(false);
  });
});

describe('summarizeUserText', () => {
  it('剥掉 botmux 注入的标签只留用户原话', () => {
    expect(summarizeUserText('<user_message>\n  @steve 帮我看下  \n</user_message>\n<sender name="x"/>')).toBe('@steve 帮我看下');
  });
});
