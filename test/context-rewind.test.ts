import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertOpenedInsideTree,
  assertSameInode,
  findCheckpoint,
  rewindClaudeTranscript,
  scanClaudeTranscriptCheckpoints,
  summarizeUserText,
  waitForTranscriptQuiet,
  withOpenTranscript,
} from '../src/core/context-rewind.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { rewindBackupSuffix } from '../src/core/rewind-backup-retention.js';

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

  it('removedBytes 是回退到该轮会删掉的字节数（含末尾未写完的半行）', () => {
    const path = fixture([userTurn('a', 'u1'), assistant, userTurn('b', 'u2'), assistant]);
    appendFileSync(path, JSON.stringify(userTurn('写了一半', 'u3')));
    const size = statSync(path).size;
    const cps = scanClaudeTranscriptCheckpoints(path);
    expect(cps.map(cp => [cp.uuid, cp.removedBytes])).toEqual(cps.map(cp => [cp.uuid, size - cp.offset]));
    expect(cps.map(cp => cp.uuid)).toEqual(['u2', 'u1']);
  });

  it('最多返回 limit 个，且 index=1 仍是最新', () => {
    const path = fixture([userTurn('a', 'u1'), userTurn('b', 'u2'), userTurn('c', 'u3')]);
    const checkpoints = scanClaudeTranscriptCheckpoints(path, 2);
    expect(checkpoints.map(cp => cp.preview)).toEqual(['c', 'b']);
    expect(checkpoints.map(cp => cp.index)).toEqual([1, 2]);
  });
});

describe('scanClaudeTranscriptCheckpoints 只读普通文件', () => {
  it('路径是软链：拒绝读取，链接目标的内容不会变成检查点预览', () => {
    const target = fixture([userTurn('LINK_TARGET_TEXT', 'uT'), assistant]);
    const link = join(dirs.at(-1)!, 'link.jsonl');
    symlinkSync(target, link);
    let checkpoints: unknown;
    expect(() => { checkpoints = scanClaudeTranscriptCheckpoints(link); }).toThrow();
    expect(JSON.stringify(checkpoints ?? null)).not.toContain('LINK_TARGET_TEXT');
  });

  // 没有写端的命名管道会让阻塞式 open(2) 永远等下去；放进子进程跑，回归时
  // 以超时失败，而不是把整个测试进程卡死。
  it.skipIf(process.platform === 'win32')('路径是命名管道：立即拒绝，不在管道上阻塞', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-rewind-fifo-'));
    dirs.push(dir);
    const fifo = join(dir, 'session.jsonl');
    const mk = spawnSync('mkfifo', [fifo]);
    expect(mk.status, String(mk.stderr)).toBe(0);
    const mod = pathToFileURL(resolve('src/core/context-rewind.ts')).href;
    const snippet = `
      const { scanClaudeTranscriptCheckpoints } = await import(${JSON.stringify(mod)});
      let outcome;
      try {
        outcome = { returned: scanClaudeTranscriptCheckpoints(${JSON.stringify(fifo)}) };
      } catch (err) {
        outcome = { error: String(err && err.message || err) };
      }
      console.log(JSON.stringify(outcome));
    `;
    const res = spawnSyncTsEvalWithRepoImports(snippet, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    expect(res.signal, `child blocked on the FIFO; stderr=${res.stderr}`).toBeNull();
    expect(res.status, String(res.stderr)).toBe(0);
    const out = JSON.parse(String(res.stdout).trim().split('\n').pop()!);
    expect(out.returned).toBeUndefined();
    expect(out.error).toMatch(/non-regular/);
  }, 90_000);
});

/** `<root>/bots/app/claude/projects/key/session.jsonl` plus the same relative
 *  layout under an outside directory, for swapping an ancestor for a link. */
function treeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'botmux-rewind-tree-'));
  dirs.push(base);
  const root = join(base, 'bots');
  const projects = join(root, 'app', 'claude', 'projects');
  const path = join(projects, 'key', 'session.jsonl');
  mkdirSync(join(projects, 'key'), { recursive: true });
  writeFileSync(path, [userTurn('树里的会话', 'u1'), assistant, userTurn('第二轮', 'u2')].map(l => `${JSON.stringify(l)}\n`).join(''));
  const outside = join(base, 'outside');
  mkdirSync(join(outside, 'key'), { recursive: true });
  const outsideFile = join(outside, 'key', 'session.jsonl');
  // Same byte layout as the tree's file (same-length texts and uuids), so an
  // offset computed on one lands on a line boundary in the other.
  writeFileSync(outsideFile, [userTurn('OUTSIDE_TEXT___', 'u1'), assistant, userTurn('OUT_TWO__', 'u2')].map(l => `${JSON.stringify(l)}\n`).join(''));
  /** Replace `dir` (inside the tree) with a link to `target`. */
  const swapForLink = (dir: string, target: string) => {
    renameSync(dir, `${dir}.aside`);
    symlinkSync(target, dir);
  };
  return { root, projects, path, outside, outsideFile, swapForLink };
}

const noProc = () => { throw new Error('no /proc'); };

describe('会话记录路径经过 CLI 可写的树', () => {
  it('树里的普通文件照常扫描', () => {
    const { root, path } = treeFixture();
    const cps = scanClaudeTranscriptCheckpoints(path, 10, { writableTreeRoot: root });
    expect(cps.map(cp => cp.preview)).toEqual(['第二轮', '树里的会话']);
  });

  it('项目目录被换成指向外部的链接：拒绝扫描，外部内容不进预览', () => {
    const { root, projects, path, outside, swapForLink } = treeFixture();
    swapForLink(join(projects, 'key'), join(outside, 'key'));
    let cps: unknown;
    expect(() => { cps = scanClaudeTranscriptCheckpoints(path, 10, { writableTreeRoot: root }); }).toThrow(/not the one under|not a directory/);
    expect(JSON.stringify(cps ?? null)).not.toContain('OUTSIDE');
  });

  it('projects 被换成链接：同样拒绝', () => {
    const { root, projects, path, outside, swapForLink } = treeFixture();
    swapForLink(projects, outside);
    expect(() => scanClaudeTranscriptCheckpoints(path, 10, { writableTreeRoot: root })).toThrow();
  });

  for (const [label, openedPath] of [['/proc', undefined], ['逐级 lstat', noProc]] as const) {
    it(`经链接打开后又换回真目录：仍认出打开的不是树里的文件（${label}）`, () => {
      const { root, projects, path, outside, swapForLink } = treeFixture();
      const key = join(projects, 'key');
      swapForLink(key, join(outside, 'key'));
      const fd = openSync(path, 'r');
      try {
        // Put the real directory back before the check runs.
        rmSync(key);
        renameSync(`${key}.aside`, key);
        expect(() => assertOpenedInsideTree(fd, path, root, openedPath)).toThrow(/not the one under|replaced between validation and open/);
      } finally {
        closeSync(fd);
      }
    });

    it(`树里一路是真目录时放行（${label}）`, () => {
      const { root, path } = treeFixture();
      const fd = openSync(path, 'r');
      try {
        expect(() => assertOpenedInsideTree(fd, path, root, openedPath)).not.toThrow();
      } finally {
        closeSync(fd);
      }
    });
  }

  it('路径不在给出的树下：拒绝', () => {
    const { root, outsideFile } = treeFixture();
    const fd = openSync(outsideFile, 'r');
    try {
      expect(() => assertOpenedInsideTree(fd, outsideFile, root)).toThrow(/not under/);
    } finally {
      closeSync(fd);
    }
  });

  it('截断时项目目录被换成链接：拒绝，外部文件不被截断、不在外部留备份', () => {
    const { root, projects, path, outside, outsideFile, swapForLink } = treeFixture();
    const [latest] = scanClaudeTranscriptCheckpoints(path, 10, { writableTreeRoot: root });
    swapForLink(join(projects, 'key'), join(outside, 'key'));
    const before = readFileSync(outsideFile, 'utf8');
    expect(() => rewindClaudeTranscript(path, latest!.offset, Date.now(), { writableTreeRoot: root })).toThrow();
    expect(readFileSync(outsideFile, 'utf8')).toBe(before);
    expect(readdirSync(join(outside, 'key'))).toEqual(['session.jsonl']);
  });

  it('树内的会话记录没给备份目录：拒绝截断，树里不创建任何文件', () => {
    const { root, path } = treeFixture();
    const [latest] = scanClaudeTranscriptCheckpoints(path, 10, { writableTreeRoot: root });
    const size = statSync(path).size;
    expect(() => rewindClaudeTranscript(path, latest!.offset, Date.now(), { writableTreeRoot: root }))
      .toThrow(/no backup directory/);
    expect(statSync(path).size).toBe(size);
    expect(readdirSync(dirname(path))).toEqual(['session.jsonl']);
  });

  it('树内的会话记录：备份写进给定目录；备份前祖先目录被换成链接也碰不到树外', () => {
    const { root, projects, path, outside, swapForLink } = treeFixture();
    const backupDir = mkdtempSync(join(tmpdir(), 'botmux-rewind-backups-'));
    dirs.push(backupDir);
    const [latest] = scanClaudeTranscriptCheckpoints(path, 10, { writableTreeRoot: root });
    const result = rewindClaudeTranscript(path, latest!.offset, Date.UTC(2026, 10, 18), {
      writableTreeRoot: root,
      backupDir,
      beforeBackup: () => swapForLink(join(projects, 'key'), join(outside, 'key')),
    });
    expect(dirname(result.backupPath)).toBe(backupDir);
    expect(readFileSync(result.backupPath, 'utf8')).toContain('第二轮');
    expect(readdirSync(join(outside, 'key'))).toEqual(['session.jsonl']);
    // The cut landed on the descriptor opened before the swap.
    expect(statSync(join(projects, 'key.aside', 'session.jsonl')).size).toBe(latest!.offset);
  });

  it('withOpenTranscript：扫描与截断走同一个描述符，截在扫描读的那个文件上', () => {
    const { root, path } = treeFixture();
    const backupDir = mkdtempSync(join(tmpdir(), 'botmux-rewind-backups-'));
    dirs.push(backupDir);
    const result = withOpenTranscript(path, { writableTreeRoot: root, backupDir }, transcript => {
      const [latest] = transcript.scan(10);
      expect(latest!.preview).toBe('第二轮');
      return { cut: transcript.cut(latest!.offset, Date.UTC(2026, 10, 18)), offset: latest!.offset };
    });
    expect(statSync(path).size).toBe(result.offset);
    expect(dirname(result.cut.backupPath)).toBe(backupDir);
    expect(readFileSync(result.cut.backupPath, 'utf8')).toContain('第二轮');
  });

  it('withOpenTranscript：同一个描述符上再扫一次，结果不变', () => {
    const { root, path } = treeFixture();
    withOpenTranscript(path, { writableTreeRoot: root }, transcript => {
      const first = transcript.scan(10);
      expect(transcript.scan(10)).toEqual(first);
      expect(first).toHaveLength(2);
    });
  });

  it('withOpenTranscript：扫描之后路径被删掉重建（inode 号可能被复用）：拒绝截断，新文件不动', () => {
    const { root, path } = treeFixture();
    const replacement = readFileSync(path, 'utf8');
    const backupDir = mkdtempSync(join(tmpdir(), 'botmux-rewind-backups-'));
    dirs.push(backupDir);
    expect(() => withOpenTranscript(path, { writableTreeRoot: root, backupDir }, transcript => {
      const [latest] = transcript.scan(10);
      rmSync(path);
      writeFileSync(path, replacement);
      return transcript.cut(latest!.offset);
    })).toThrow(/replaced between validation and open/);
    expect(readFileSync(path, 'utf8')).toBe(replacement);
    expect(readdirSync(dirname(path))).toEqual(['session.jsonl']);
    expect(readdirSync(backupDir)).toEqual([]);
  });

  it('withOpenTranscript：命名管道或链接一律拒绝打开', () => {
    const { root, path, outsideFile } = treeFixture();
    rmSync(path);
    symlinkSync(outsideFile, path);
    expect(() => withOpenTranscript(path, { writableTreeRoot: root }, t => t.scan(10))).toThrow();
    rmSync(path);
    expect(spawnSync('mkfifo', [path]).status).toBe(0);
    expect(() => withOpenTranscript(path, { writableTreeRoot: root }, t => t.scan(10))).toThrow(/non-regular/);
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

  it('备份目录在调用方建好之后、写备份之前被清掉（清空目录的周期清扫）：重建目录照常回退', () => {
    const { root, path } = treeFixture();
    const backupDir = join(mkdtempSync(join(tmpdir(), 'botmux-rewind-backups-')), 'sess-1');
    dirs.push(dirname(backupDir));
    mkdirSync(backupDir);
    const [latest] = scanClaudeTranscriptCheckpoints(path, 10, { writableTreeRoot: root });
    const result = rewindClaudeTranscript(path, latest!.offset, Date.UTC(2026, 10, 18), {
      writableTreeRoot: root,
      backupDir,
      beforeBackup: () => rmSync(backupDir, { recursive: true }),
    });
    expect(dirname(result.backupPath)).toBe(backupDir);
    expect(readFileSync(result.backupPath, 'utf8')).toContain('第二轮');
    expect(statSync(path).size).toBe(latest!.offset);
  });

  it('备份写完、截断之前备份不在了（被删掉、换成别的文件、或被挪走）：拒绝截断，也不删换进来的文件', () => {
    for (const takeAway of ['removed', 'replaced', 'moved'] as const) {
      const path = fixture([userTurn('a', 'u1'), assistant, userTurn('b', 'u2'), assistant]);
      const before = readFileSync(path, 'utf8');
      const now = Date.UTC(2026, 10, 18, 12, 0, 0);
      const backupPath = `${path}${rewindBackupSuffix(now, 'full')}`;
      const [latest] = scanClaudeTranscriptCheckpoints(path);
      expect(() => rewindClaudeTranscript(path, latest!.offset, now, {
        beforeCut: () => {
          if (takeAway === 'moved') return renameSync(backupPath, `${backupPath}.moved`);
          rmSync(backupPath);
          if (takeAway === 'replaced') writeFileSync(backupPath, 'someone else');
        },
      })).toThrow(/went away before the cut/);
      expect(readFileSync(path, 'utf8')).toBe(before);
      if (takeAway === 'replaced') expect(readFileSync(backupPath, 'utf8')).toBe('someone else');
    }
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

  // #2716: bare（transcript + solo）续轮没有 <user_message> 壳，格式提示块被
  // 追加在用户正文之后；块体必须随标签一起剥掉，不能混进 /rewind 预览。
  it('bare 续轮追加在正文后的 <botmux_formatting> 块体不进预览', () => {
    const bare = '继续看一下这个 PR\n\n<botmux_formatting>短进度优先纯文本；强调仅包短词或无中文标点的短语，标点和后文放在 `**` 外。</botmux_formatting>';
    expect(summarizeUserText(bare)).toBe('继续看一下这个 PR');
  });
});
