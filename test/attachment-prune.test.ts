import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return dataDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  pruneBotAttachments,
  collectProtectedAttachmentDirs,
  DEFAULT_ATTACHMENT_MAX_AGE_MS,
} from '../src/core/attachment-prune.js';
import { init } from '../src/services/session-store.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const DAY = 24 * 3600_000;
const MAX_AGE = 14 * DAY;
let root: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bm-att-data-'));
  root = join(dataDir, 'attachments');
  mkdirSync(root);
});
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

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

const prune = (appId: string, loadSessions: () => Iterable<object> = () => []) =>
  pruneBotAttachments({ attachmentsRoot: root, appId, loadSessions, maxAgeMs: MAX_AGE });

describe('pruneBotAttachments', () => {
  it('removes old message dirs of its own bucket only, keeps recent ones and the bucket', () => {
    const old = msgDir('cli_a', 'msg-old', 30 * DAY);
    const recent = msgDir('cli_a', 'msg-new', 1 * DAY);
    const otherBot = msgDir('cli_b', 'msg-old2', 30 * DAY);

    expect(prune('cli_a')).toEqual({ status: 'pruned', removedDirs: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(root, 'cli_a'))).toBe(true); // 空 app 桶保留
    // 别的 bot 的桶归它自己的 daemon 回收，这里不碰。
    expect(existsSync(otherBot)).toBe(true);
  });

  it('removes nothing when all within age', () => {
    msgDir('cli_a', 'm1', 60_000);
    expect(prune('cli_a')).toEqual({ status: 'pruned', removedDirs: 0 });
  });

  it('is a no-op for a bot without a bucket yet', () => {
    expect(prune('cli_new')).toEqual({ status: 'pruned', removedDirs: 0 });
  });

  it('never removes loose files inside the bucket', () => {
    // 删除作用域只能是 <bucket>/<messageId>/ 目录：桶内散落文件必须原样保留。
    // 散落文件也要超龄——否则年龄判定先挡掉，isDirectory() 守卫本身根本没被走到。
    const bucketStray = join(root, 'cli_a', 'stray-bucket.txt');
    mkdirSync(join(root, 'cli_a'), { recursive: true });
    writeFileSync(bucketStray, 'x');
    const oldSeconds = (Date.now() - 30 * DAY) / 1000;
    utimesSync(bucketStray, oldSeconds, oldSeconds);
    msgDir('cli_a', 'om_old', 30 * DAY);

    expect(prune('cli_a')).toEqual({ status: 'pruned', removedDirs: 1 });
    expect(existsSync(bucketStray)).toBe(true);
  });

  it('keeps expired dirs referenced by any persisted attachment holder', () => {
    // 三类持久化持有者是同一机制：pendingRepoSetup（选仓卡）、
    // queuedAttachments（Dashboard backlog 待办）、dashboardAttachments
    // （Dashboard 建会话上传）。会话都被无限期保护，附件可能 14 天后才被引用。
    const repo = msgDir('cli_a', 'om_repo', 30 * DAY);
    const queued = msgDir('cli_a', 'om_queued', 30 * DAY);
    const dash = msgDir('cli_a', 'om_dash', 30 * DAY);
    const orphan = msgDir('cli_a', 'om_orphan', 30 * DAY);

    const result = prune('cli_a', () => [
      { pendingRepoSetup: { attachments: [{ path: join(repo, 'image.png') }] } },
      { queuedAttachments: [{ path: join(queued, 'image.png') }] },
      { dashboardAttachments: [{ path: join(dash, 'image.png') }] },
    ]);
    expect(result).toEqual({ status: 'pruned', removedDirs: 1 });
    expect(existsSync(repo)).toBe(true);
    expect(existsSync(queued)).toBe(true);
    expect(existsSync(dash)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it('skips the round, deleting nothing, when the protecting sessions cannot be read', () => {
    const old = msgDir('cli_a', 'om_old', 30 * DAY);
    const result = prune('cli_a', () => { throw new Error('store locked'); });
    expect(result).toEqual({ status: 'skipped', error: 'store locked' });
    expect(existsSync(old)).toBe(true);
  });

  it('refuses an app id that is not a single safe path segment', () => {
    const old = msgDir('cli_a', 'om_old', 30 * DAY);
    expect(prune('..').status).toBe('skipped');
    expect(existsSync(old)).toBe(true);
  });

  it('default max age is a positive multi-day window', () => {
    expect(DEFAULT_ATTACHMENT_MAX_AGE_MS).toBeGreaterThanOrEqual(7 * DAY);
  });
});

// 默认的保护集合读取是 daemon 自己的会话库：读得出来就按它保护，读不出来就不删。
describe('pruneBotAttachments with the daemon session store', () => {
  const pruneDefault = (appId: string) =>
    pruneBotAttachments({ attachmentsRoot: root, appId, maxAgeMs: MAX_AGE });

  it('protects dirs referenced by this bot\'s own persisted sessions', () => {
    const repo = msgDir('cli_a', 'om_repo', 30 * DAY);
    const orphan = msgDir('cli_a', 'om_orphan', 30 * DAY);
    seedPersistedSessionRows(dataDir, 'cli_a', {
      s1: {
        sessionId: 's1', chatId: 'oc_x', rootMessageId: 'om_s1', title: 's1', status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        pendingRepoSetup: { mode: 'picker', prompt: 'p', attachments: [{ path: join(repo, 'image.png') }] },
      },
    });
    init('cli_a');

    expect(pruneDefault('cli_a')).toEqual({ status: 'pruned', removedDirs: 1 });
    expect(existsSync(repo)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it('skips the round when this bot\'s session store is unreadable', () => {
    const old = msgDir('cli_a', 'om_old', 30 * DAY);
    mkdirSync(join(dataDir, 'session-stores', 'cli_a'), { recursive: true });
    writeFileSync(join(dataDir, 'session-stores', 'cli_a', 'sessions.db'), 'this is not a database');
    init('cli_a');

    expect(pruneDefault('cli_a').status).toBe('skipped');
    expect(existsSync(old)).toBe(true);
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
