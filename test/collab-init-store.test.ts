/**
 * CollabInitStore（design §10.1）契约测试：稳定 source store、原子写、mutex 串行、
 * sourceIndex 永久 / activeByDmChat 临时。
 *
 * 用真实临时目录 + 假时钟驱动（不 mock config —— store 的 dataDir 显式传入）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collabInitFilePath,
  markCollabInitTerminal,
  placeCollabGroupInit,
  readCollabInitStore,
  readCollabInitStoreStrict,
  patchCollabInitEntry,
  CollabInitStoreCorruptedError,
  __testOnly_resetCollabInitMutexes,
  type CollabPlaceResult,
} from '../src/services/collab-init-store.js';
import {
  collabCreatorAdmissionOperationId,
  collabInitId,
  collabSourceKey,
  type SessionGroupCollaborationConfig,
} from '../src/services/collab-group-config.js';

let tempDir: string;
let clock = 0;
const now = () => ++clock;

const APP = 'cli_creator_app';
const DM = 'oc_dm';
const SRC_MSG_1 = 'om_source_1';
const SRC_MSG_2 = 'om_source_2';

function snapshotConfig(): SessionGroupCollaborationConfig {
  return {
    enabled: true,
    agents: [{ appId: 'cli_creator' }],
    kickoff: [{ appId: 'cli_creator', trigger: 'immediate' }],
  };
}

function placeOpts(sourceMessageId: string, overrides: Record<string, unknown> = {}) {
  const sourceKey = collabSourceKey(APP, DM, sourceMessageId);
  const initId = collabInitId(sourceKey);
  return {
    dataDir: tempDir,
    creatorAppId: APP,
    dmChatId: DM,
    sourceKey,
    initId,
    sourceMessageId,
    configVersion: 'cv-v1',
    configSnapshot: snapshotConfig(),
    creatorAdmissionOperationId: collabCreatorAdmissionOperationId(initId),
    createAttempt: 0,
    now: now(),
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'collab-init-store-'));
  clock = 0;
  __testOnly_resetCollabInitMutexes();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  __testOnly_resetCollabInitMutexes();
});

describe('CollabInitStore：稳定 source store', () => {
  it('首次占位 created，同 sourceKey 重投 existing（同 initId）', async () => {
    const opts = placeOpts(SRC_MSG_1);
    const first = await placeCollabGroupInit(opts);
    expect(first.kind).toBe('created');
    expect((first as CollabPlaceResult & { initId: string }).initId).toBe(opts.initId);

    const second = await placeCollabGroupInit(placeOpts(SRC_MSG_1));
    expect(second.kind).toBe('existing');
    expect((second as CollabPlaceResult & { initId: string }).initId).toBe(opts.initId);
  });

  it('同 DM 不同 source 并发返回 busy', async () => {
    await placeCollabGroupInit(placeOpts(SRC_MSG_1));
    const second = await placeCollabGroupInit(placeOpts(SRC_MSG_2));
    expect(second.kind).toBe('busy');
  });

  it('sourceIndex 永久：done/failed/cancelled 后同 source 仍 existing', async () => {
    const opts = placeOpts(SRC_MSG_1);
    await placeCollabGroupInit(opts);
    await markCollabInitTerminal({ dataDir: tempDir, creatorAppId: APP, initId: opts.initId, dmChatId: DM, state: 'done', now: now() });
    const again = await placeCollabGroupInit(placeOpts(SRC_MSG_1));
    expect(again.kind).toBe('existing');
  });

  it('activeByDmChat 临时：done 释放后同 DM 新 source 可建新请求', async () => {
    const opts = placeOpts(SRC_MSG_1);
    await placeCollabGroupInit(opts);
    // 释放前 busy
    expect((await placeCollabGroupInit(placeOpts(SRC_MSG_2))).kind).toBe('busy');
    // 释放
    await markCollabInitTerminal({ dataDir: tempDir, creatorAppId: APP, initId: opts.initId, dmChatId: DM, state: 'done', now: now() });
    // 释放后新 source 建新请求
    const next = await placeCollabGroupInit(placeOpts(SRC_MSG_2));
    expect(next.kind).toBe('created');
  });

  it('activeByDmChat 临时：failed 释放后同 DM 新 source 可建新请求', async () => {
    const opts = placeOpts(SRC_MSG_1);
    await placeCollabGroupInit(opts);
    await markCollabInitTerminal({ dataDir: tempDir, creatorAppId: APP, initId: opts.initId, dmChatId: DM, state: 'failed', now: now() });
    const next = await placeCollabGroupInit(placeOpts(SRC_MSG_2));
    expect(next.kind).toBe('created');
  });

  it('activeByDmChat 临时：cancelled 释放后同 DM 新 source 可建新请求（并留 cancelReason）', async () => {
    const opts = placeOpts(SRC_MSG_1);
    await placeCollabGroupInit(opts);
    await markCollabInitTerminal({ dataDir: tempDir, creatorAppId: APP, initId: opts.initId, dmChatId: DM, state: 'cancelled', now: now(), cancelReason: 'user cancelled' });
    // 释放后新 source 可建
    const next = await placeCollabGroupInit(placeOpts(SRC_MSG_2));
    expect(next.kind).toBe('created');
    // entry 留证 cancelled + cancelReason
    const entry = readCollabInitStore(tempDir, APP).entries[opts.initId];
    expect(entry.state).toBe('cancelled');
    expect(entry.cancelReason).toBe('user cancelled');
  });

  it('原子写 tmp+rename+0600（无残留 tmp，内容完整含三份结构）', async () => {
    const opts = placeOpts(SRC_MSG_1);
    await placeCollabGroupInit(opts);
    const fp = collabInitFilePath(tempDir, APP);
    expect(existsSync(fp)).toBe(true);
    // 0600（fs 权限，考虑 umask 下更紧也可能）
    const mode = statSync(fp).mode & 0o777;
    expect(mode === 0o600 || mode === 0o400).toBe(true);
    // 内容完整可读且含三份结构
    const store = JSON.parse(readFileSync(fp, 'utf-8'));
    expect(store.entries[opts.initId]).toBeTruthy();
    expect(store.sourceIndex[opts.sourceKey]).toBe(opts.initId);
    expect(store.activeByDmChat[DM]).toBe(opts.initId);
    // 无残留 tmp 文件
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(tempDir).some(f => f.includes('.tmp'))).toBe(false);
  });

  it('per-app mutex 串行：并发两个 initId 写同一文件不互相覆盖', async () => {
    // 不同 DM 的两个 source 并发 place，各自 created，互不覆盖。
    const optsA = {
      ...placeOpts(SRC_MSG_1),
      dmChatId: 'oc_dm_a',
      sourceKey: collabSourceKey(APP, 'oc_dm_a', SRC_MSG_1),
      initId: collabInitId(collabSourceKey(APP, 'oc_dm_a', SRC_MSG_1)),
    };
    const optsB = {
      ...placeOpts(SRC_MSG_2),
      dmChatId: 'oc_dm_b',
      sourceKey: collabSourceKey(APP, 'oc_dm_b', SRC_MSG_2),
      initId: collabInitId(collabSourceKey(APP, 'oc_dm_b', SRC_MSG_2)),
    };
    const [ra, rb] = await Promise.all([
      placeCollabGroupInit(optsA),
      placeCollabGroupInit(optsB),
    ]);
    expect(ra.kind).toBe('created');
    expect(rb.kind).toBe('created');
    const store = readCollabInitStore(tempDir, APP);
    expect(Object.keys(store.entries)).toHaveLength(2);
    expect(store.entries[optsA.initId]).toBeTruthy();
    expect(store.entries[optsB.initId]).toBeTruthy();
  });

  it('损坏 JSON → strict corrupted，mutation 失败且原文件字节不变', async () => {
    await placeCollabGroupInit(placeOpts(SRC_MSG_1));
    const fp = collabInitFilePath(tempDir, APP);
    writeFileSync(fp, '{broken-json', { mode: 0o600 });
    const before = readFileSync(fp, 'utf-8');
    expect(readCollabInitStoreStrict(tempDir, APP).kind).toBe('corrupted');
    await expect(placeCollabGroupInit(placeOpts(SRC_MSG_2))).rejects.toThrow(CollabInitStoreCorruptedError);
    expect(readFileSync(fp, 'utf-8')).toBe(before);
  });

  it('sourceIndex 悬空 → 判 corrupted，不允许重新占位覆盖', async () => {
    const opts = placeOpts(SRC_MSG_1);
    await placeCollabGroupInit(opts);
    const fp = collabInitFilePath(tempDir, APP);
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    raw.sourceIndex['["dangling"]'] = 'f'.repeat(64);
    writeFileSync(fp, JSON.stringify(raw), { mode: 0o600 });
    const before = readFileSync(fp, 'utf-8');
    expect(readCollabInitStoreStrict(tempDir, APP).kind).toBe('corrupted');
    await expect(placeCollabGroupInit(placeOpts(SRC_MSG_2))).rejects.toThrow(CollabInitStoreCorruptedError);
    expect(readFileSync(fp, 'utf-8')).toBe(before);
  });

  it('终态 entry 的 stale active 指针不判损坏，新请求放置时清理', async () => {
    const opts = placeOpts(SRC_MSG_1);
    await placeCollabGroupInit(opts);
    await patchCollabInitEntry({
      dataDir: tempDir, creatorAppId: APP, initId: opts.initId,
      mutate: (entry) => { entry.state = 'cancelled'; return true; },
    });
    expect(readCollabInitStoreStrict(tempDir, APP).kind).toBe('ok');
    const next = await placeCollabGroupInit(placeOpts(SRC_MSG_2));
    expect(next.kind).toBe('created');
    const store = readCollabInitStore(tempDir, APP);
    expect(store.activeByDmChat[DM]).toBe(next.initId);
  });
});
