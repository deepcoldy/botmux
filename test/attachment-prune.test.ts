import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pruneOldAttachments,
  collectProtectedAttachmentDirs,
  DEFAULT_ATTACHMENT_MAX_AGE_MS,
} from '../src/core/attachment-prune.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bm-att-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function msgDir(app: string, msg: string, ageMs: number): string {
  const d = join(root, app, msg);
  mkdirSync(d, { recursive: true });
  const f = join(d, 'image.png');
  writeFileSync(f, 'x');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(d, t, t);
  utimesSync(f, t, t);
  return d;
}

describe('pruneOldAttachments', () => {
  it('removes message dirs older than max age, keeps recent ones and app buckets', () => {
    const old = msgDir('cli_a', 'msg-old', 30 * 24 * 3600_000);
    const recent = msgDir('cli_a', 'msg-new', 1 * 24 * 3600_000);
    const other = msgDir('cli_b', 'msg-old2', 30 * 24 * 3600_000);

    const r = pruneOldAttachments(root, 14 * 24 * 3600_000);
    expect(r.removedDirs).toBe(2);
    expect(r.appBuckets).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(root, 'cli_a'))).toBe(true);
    expect(existsSync(join(root, 'cli_b'))).toBe(true); // 空 app 桶保留
  });

  it('removes nothing when all within age', () => {
    msgDir('cli_a', 'm1', 60_000);
    expect(pruneOldAttachments(root, 14 * 24 * 3600_000).removedDirs).toBe(0);
  });

  it('returns 0 for a missing root', () => {
    expect(pruneOldAttachments(join(root, 'nope')).removedDirs).toBe(0);
  });

  it('never removes loose files at the root or inside an app bucket', () => {
    // 删除作用域只能是 <bucket>/<messageId>/ 目录：根层散落文件（元数据等）
    // 与桶内散落文件都必须原样保留。散落文件也要超龄——否则年龄判定先挡掉，
    // isDirectory() 守卫本身根本没被走到。
    const rootStray = join(root, 'stray-root.txt');
    const bucketStray = join(root, 'cli_a', 'stray-bucket.txt');
    writeFileSync(rootStray, 'x');
    mkdirSync(join(root, 'cli_a'), { recursive: true });
    writeFileSync(bucketStray, 'x');
    const oldSeconds = (Date.now() - 30 * 86400_000) / 1000;
    utimesSync(rootStray, oldSeconds, oldSeconds);
    utimesSync(bucketStray, oldSeconds, oldSeconds);
    msgDir('cli_a', 'om_old', 30 * 24 * 3600_000);

    const r = pruneOldAttachments(root, 14 * 24 * 3600_000);
    expect(r.removedDirs).toBe(1);
    expect(existsSync(rootStray)).toBe(true);
    expect(existsSync(bucketStray)).toBe(true);
  });

  it('keeps expired dirs referenced by any persisted attachment holder', () => {
    // 三类持久化持有者是同一机制：pendingRepoSetup（选仓卡）、
    // queuedAttachments（Dashboard backlog 待办）、dashboardAttachments
    // （Dashboard 建会话上传）。会话都被无限期保护，附件可能 14 天后才被引用。
    const repo = msgDir('cli_a', 'om_repo', 30 * 24 * 3600_000);
    const queued = msgDir('cli_a', 'om_queued', 30 * 24 * 3600_000);
    const dash = msgDir('cli_a', 'om_dash', 30 * 24 * 3600_000);
    const orphan = msgDir('cli_a', 'om_orphan', 30 * 24 * 3600_000);
    const protectedDirs = collectProtectedAttachmentDirs(
      [
        { pendingRepoSetup: { attachments: [{ path: join(repo, 'image.png') }] } },
        { queuedAttachments: [{ path: join(queued, 'image.png') }] },
        { dashboardAttachments: [{ path: join(dash, 'image.png') }] },
      ],
      root,
    );

    const r = pruneOldAttachments(root, 14 * 24 * 3600_000, undefined, protectedDirs);
    expect(r.removedDirs).toBe(1);
    expect(existsSync(repo)).toBe(true);
    expect(existsSync(queued)).toBe(true);
    expect(existsSync(dash)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it('default max age is a positive multi-day window', () => {
    expect(DEFAULT_ATTACHMENT_MAX_AGE_MS).toBeGreaterThanOrEqual(7 * 24 * 3600_000);
  });
});

describe('collectProtectedAttachmentDirs', () => {
  it('collects resolved message dirs from attachment file paths', () => {
    const dirs = collectProtectedAttachmentDirs(
      [
        { pendingRepoSetup: { attachments: [{ path: join(root, 'cli_a', 'om_1', 'f.png') }] } },
        { pendingRepoSetup: { attachments: [{ path: join(root, 'cli_a', 'om_2', 'f.png') }, { name: 'no-path' }] } },
        {},
      ],
      root,
    );
    expect([...dirs].sort()).toEqual([
      join(root, 'cli_a', 'om_1'),
      join(root, 'cli_a', 'om_2'),
    ]);
  });

  it('ignores the root itself and paths outside the attachments root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'bm-att-out-'));
    try {
      const dirs = collectProtectedAttachmentDirs(
        [{ pendingRepoSetup: { attachments: [
          { path: join(root, 'at-root.png') },
          { path: join(outside, 'om_x', 'f.png') },
        ] } }],
        root,
      );
      expect(dirs.size).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
