/**
 * Resume 跨桶兜底单测（bug：/cd 后"空窗重启"静默丢上下文）。
 *
 * 真实场景：Claude 的 transcript 按 cwd 分桶存（<dataDir>/projects/<slug(cwd)>/<sid>.jsonl），
 * `/cd` 只改未来写入的落点、不回迁已有文件。若 /cd 之后没写任何 turn 就重启，
 * 旧 transcript 孤儿在旧 cwd 的桶里，而 resume 预检只探当前 cwd 的桶 →
 * checkResumeTargetExists 返回 false → worker 丢弃 --resume、静默新开会话。
 *
 * 修复：<sid>.jsonl 在同一 dataDir 下全局唯一。当前桶探不到时扫兄弟桶，
 * 命中则把孤儿 transcript 迁进当前桶（claude --resume 只认当前 cwd 的桶），
 * 迁移成功返回 true —— 上下文得以恢复。
 *
 * Run:  pnpm vitest run test/claude-resume-cross-bucket.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

import {
  createClaudeCodeAdapter,
  claudeJsonlPathForSession,
  rescueOrphanClaudeTranscript,
} from '../src/adapters/cli/claude-code.js';

const SID = 'aaaa1111-2222-4333-8444-555566667777';

let tmpRoot: string;
let dataDir: string;
let dirA: string; // 写入过 transcript 的旧 cwd
let dirB: string; // /cd 目标 = resume 时的当前 cwd（桶为空）

beforeEach(() => {
  // macOS 上 os.tmpdir() 是符号链接（/var → /private/var），helper 会 realpath，
  // 先解掉否则期望路径对不上。
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-xbucket-')));
  dataDir = join(tmpRoot, 'claude-data');
  dirA = join(tmpRoot, 'role-a');
  dirB = join(tmpRoot, 'role-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 在 cwd 对应的桶里种一份 transcript，返回其路径。 */
function seedTranscript(cwd: string, content = '{"role":"user","content":"hi"}\n', sid = SID): string {
  const p = claudeJsonlPathForSession(sid, cwd, dataDir);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

describe('rescueOrphanClaudeTranscript', () => {
  it('把孤儿 transcript 从旧 cwd 桶迁进当前 cwd 桶，并返回来源路径', () => {
    const orphan = seedTranscript(dirA);
    const target = claudeJsonlPathForSession(SID, dirB, dataDir);
    expect(existsSync(target)).toBe(false);

    const from = rescueOrphanClaudeTranscript(SID, dirB, dataDir);

    expect(from).toBe(orphan);
    expect(existsSync(target)).toBe(true);
    // 迁移（非拷贝）：旧桶不留 stale 副本，避免日后 /cd 回旧目录时
    // 直接命中过期 transcript、静默丢掉迁移后新写的 turn。
    expect(existsSync(orphan)).toBe(false);
  });

  it('随 transcript 一起迁移相邻的 `<sid>/` sidecar 目录（tool-results 等），不留在旧桶', () => {
    const orphan = seedTranscript(dirA);
    // Claude 在 <sid>.jsonl 旁建 <sid>/ 存放会话产物。
    const srcSidecar = join(orphan, '..', SID);
    mkdirSync(join(srcSidecar, 'tool-results'), { recursive: true });
    writeFileSync(join(srcSidecar, 'tool-results', 'r1.txt'), 'result-payload\n');

    const from = rescueOrphanClaudeTranscript(SID, dirB, dataDir);
    expect(from).toBe(orphan);

    const target = claudeJsonlPathForSession(SID, dirB, dataDir);
    const dstSidecar = join(target, '..', SID);
    // sidecar 随迁到新桶、内容完整；旧桶不再残留。
    expect(existsSync(join(dstSidecar, 'tool-results', 'r1.txt'))).toBe(true);
    expect(readFileSync(join(dstSidecar, 'tool-results', 'r1.txt'), 'utf8')).toBe('result-payload\n');
    expect(existsSync(srcSidecar)).toBe(false);
  });

  it('sidecar 缺失时正常迁移 transcript、不报错（sidecar 迁移是尽力而为）', () => {
    const orphan = seedTranscript(dirA); // 只有 jsonl，无 <sid>/ 目录
    const from = rescueOrphanClaudeTranscript(SID, dirB, dataDir);
    expect(from).toBe(orphan);
    expect(existsSync(claudeJsonlPathForSession(SID, dirB, dataDir))).toBe(true);
  });

  it('把指向 dataDir 外部的符号链接 `<sid>.jsonl` 当命中 → 拒绝跟随、不迁移（符号链接逃逸）', () => {
    // 攻击者在某个桶里植入一个指向 dataDir 之外真实文件的软链，命名成目标 sid。
    const outsideSecret = join(tmpRoot, 'outside-secret.jsonl');
    writeFileSync(outsideSecret, 'not-a-transcript\n');
    const bucketDir = join(dataDir, 'projects', 'evil-bucket');
    mkdirSync(bucketDir, { recursive: true });
    symlinkSync(outsideSecret, join(bucketDir, `${SID}.jsonl`));

    const from = rescueOrphanClaudeTranscript(SID, dirB, dataDir);

    // lstat 不跟随 → 该软链被跳过 → 无真实命中 → 不迁移任何东西。
    expect(from).toBeUndefined();
    expect(existsSync(claudeJsonlPathForSession(SID, dirB, dataDir))).toBe(false);
    expect(readFileSync(outsideSecret, 'utf8')).toBe('not-a-transcript\n'); // 外部文件未被动过
  });

  it('当前桶已有目标文件时不动任何东西', () => {
    const inPlace = seedTranscript(dirB, 'current\n');
    const orphan = seedTranscript(dirA, 'stale\n');

    const from = rescueOrphanClaudeTranscript(SID, dirB, dataDir);

    expect(from).toBeUndefined();
    expect(readFileSync(inPlace, 'utf8')).toBe('current\n');
    expect(existsSync(orphan)).toBe(true);
  });

  it('哪个桶都没有 → 返回 undefined', () => {
    expect(rescueOrphanClaudeTranscript(SID, dirB, dataDir)).toBeUndefined();
  });

  it('多个桶命中同一 sid 时取 mtime 最新的那份', () => {
    const dirC = join(tmpRoot, 'role-c');
    mkdirSync(dirC);
    const older = seedTranscript(dirA, 'older\n');
    const newer = seedTranscript(dirC, 'newer\n');
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);

    const from = rescueOrphanClaudeTranscript(SID, dirB, dataDir);

    expect(from).toBe(newer);
    const target = claudeJsonlPathForSession(SID, dirB, dataDir);
    expect(readFileSync(target, 'utf8')).toBe('newer\n');
  });

  it('projects 目录不存在（该 dataDir 从未写过）→ undefined，不抛', () => {
    expect(rescueOrphanClaudeTranscript(SID, dirB, join(tmpRoot, 'nonexistent'))).toBeUndefined();
  });

  it('非 UUID 的 sid（含路径穿越 payload）→ 直接拒绝，不做任何文件操作', () => {
    seedTranscript(dirA);
    expect(rescueOrphanClaudeTranscript('../../../etc/passwd', dirB, dataDir)).toBeUndefined();
    expect(rescueOrphanClaudeTranscript('not-a-uuid', dirB, dataDir)).toBeUndefined();
  });

  // 权限剥夺类用例在 root 下不生效（root 无视 w 位），CI 以 root 跑时跳过；
  // Windows 无 POSIX 目录 w 位语义（chmod 0o555 挡不住 rename），一并跳过。
  const notRoot = process.getuid?.() !== 0 && process.platform !== 'win32';

  it.runIf(notRoot)('rename 失败（源父目录只读）→ 降级 copy，目标就位、rescue 仍成功', () => {
    const orphan = seedTranscript(dirA, 'payload\n');
    const srcDir = join(orphan, '..');
    chmodSync(srcDir, 0o555); // rename/unlink 需要源父目录 w；copy 只需源文件 r
    try {
      const from = rescueOrphanClaudeTranscript(SID, dirB, dataDir);
      expect(from).toBe(orphan);
      const target = claudeJsonlPathForSession(SID, dirB, dataDir);
      expect(readFileSync(target, 'utf8')).toBe('payload\n');
      // unlink 同样被只读父目录挡住 → 源文件残留（已尽力，并有 stderr 告警）
      expect(existsSync(orphan)).toBe(true);
    } finally {
      chmodSync(srcDir, 0o755);
    }
  });

  it.runIf(notRoot)('rename 与 copy 全败 → 回滚自建的目标桶目录，probe 的 false 语义不被污染', () => {
    const orphan = seedTranscript(dirA, 'unreadable\n');
    const srcDir = join(orphan, '..');
    chmodSync(orphan, 0o000);  // copy 需要源文件 r
    chmodSync(srcDir, 0o555);  // rename 需要源父目录 w
    try {
      expect(rescueOrphanClaudeTranscript(SID, dirB, dataDir)).toBeUndefined();
      // mkdir 的副作用必须被回滚：否则 checkResumeTargetExists 的
      // 「projectDir 不存在 → false（干净降级 fresh）」会漂移成 undefined。
      const targetDir = join(claudeJsonlPathForSession(SID, dirB, dataDir), '..');
      expect(existsSync(targetDir)).toBe(false);
    } finally {
      chmodSync(srcDir, 0o755);
      chmodSync(orphan, 0o644);
    }
  });
});

describe('checkResumeTargetExists: 跨桶兜底', () => {
  const adapter = createClaudeCodeAdapter();

  function probe(workingDir: string) {
    return adapter.checkResumeTargetExists!({ sessionId: SID, workingDir, dataDir });
  }

  it('bug 复现场景：transcript 孤儿在 A 桶、探 B 桶 → 兜底迁移后返回 true', () => {
    seedTranscript(dirA);
    // 修复前这里返回 false（B 桶目录不存在 = "provably absent"）→ 静默丢上下文
    expect(probe(dirB)).toBe(true);
    // 迁移后 claude --resume 在 dirB 能找到文件
    expect(existsSync(claudeJsonlPathForSession(SID, dirB, dataDir))).toBe(true);
  });

  it('当前桶直接命中 → true，不发生迁移', () => {
    seedTranscript(dirB, 'current\n');
    const stale = seedTranscript(dirA, 'stale\n');
    expect(probe(dirB)).toBe(true);
    expect(existsSync(stale)).toBe(true);
    expect(readFileSync(claudeJsonlPathForSession(SID, dirB, dataDir), 'utf8')).toBe('current\n');
  });

  it('全库都没有 + 当前桶目录不存在 → false（真·不可恢复，行为不变）', () => {
    expect(probe(dirB)).toBe(false);
  });

  it('全库都没有 + 当前桶目录存在 → undefined（可能 mid-session 轮换，行为不变）', () => {
    seedTranscript(dirB, 'other\n', 'bbbb1111-2222-4333-8444-555566667777');
    expect(probe(dirB)).toBeUndefined();
  });
});
