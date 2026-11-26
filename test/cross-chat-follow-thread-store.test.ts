import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const fsControl = vi.hoisted(() => ({ failHostAppend: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
      if (fsControl.failHostAppend && String(args[0]).includes('.dashboard-secret.cross-chat-follow-thread')) {
        throw Object.assign(new Error('EACCES: host binding append denied'), { code: 'EACCES' });
      }
      return actual.appendFileSync(...args);
    },
  };
});

import { recordBridgeReplyMarker } from '../src/services/bridge-reply-marker.js';
import {
  effectiveCrossChatFollowThreadMode,
  ensureCrossChatFollowThreadAtBinding,
  persistCrossChatFollowThreadOffBeforeProvider,
  recordCrossChatFollowThreadBinding,
} from '../src/services/cross-chat-follow-thread-store.js';
import {
  __clearCrossChatFollowBindingCacheForTest,
  resolveCrossChatFollowedThread,
  type CrossChatCandidateSession,
} from '../src/services/cross-chat-thread-binding.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { canonicalJson } from '../src/utils/canonical-input-hash.js';

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cross-chat-store-failure-'));
  fsControl.failHostAppend = false;
  __clearCrossChatFollowBindingCacheForTest();
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

const sessions: CrossChatCandidateSession[] = [{
  sessionId: 'sess-a', larkAppId: 'cli_cross', chatId: 'oc_origin', rootMessageId: 'oc_origin',
  scope: 'chat', status: 'active',
}];

function resolve() {
  return resolveCrossChatFollowedThread({
    dataDir: tempDir, larkAppId: 'cli_cross', chatId: 'oc_followed',
    candidateRootIds: ['om_root_b'], sessions,
  });
}

describe('cross-chat follow store failure and replay semantics', () => {
  it('persists the source turn only for a fresh host-observed delivery', () => {
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 1000,
      turnId: 'om_source_human',
      deliveryKind: 'detoured_send',
      messageId: 'om_root_b',
      targetChatId: 'oc_followed',
      crossChatFollowThread: 'at',
    });
    expect(resolve()).toMatchObject({
      sourceSessionId: 'sess-a',
      sourceTurnId: 'om_source_human',
    });
    const record = JSON.parse(readFileSync(
      join(tempDir, '.dashboard-secret.cross-chat-follow-thread', 'sess-a.jsonl'),
      'utf-8',
    ).trim());
    expect(record).toMatchObject({ sourceTurnId: 'om_source_human' });
    expect(record).not.toHaveProperty('turnId');

    const replayDir = mkdtempSync(join(tmpdir(), 'cross-chat-store-replay-recovery-'));
    try {
      expect(ensureCrossChatFollowThreadAtBinding({
        dataDir: replayDir,
        sessionId: 'sess-a',
        sentAtMs: 1000,
        messageId: 'om_root_b',
        targetChatId: 'oc_followed',
        sourceTurnId: 'om_replayed_human',
      })).toBe(true);
      const replayRecord = JSON.parse(readFileSync(
        join(replayDir, '.dashboard-secret.cross-chat-follow-thread', 'sess-a.jsonl'),
        'utf-8',
      ).trim());
      expect(replayRecord).toMatchObject({ sourceTurnId: 'om_replayed_human' });
    } finally {
      rmSync(replayDir, { recursive: true, force: true });
    }
  });

  it('reports an off append failure instead of treating the old at as a tombstone', () => {
    const marker = {
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 1000, messageId: 'om_root_b',
      deliveryKind: 'detoured_send' as const, content: 'cross-chat', targetChatId: 'oc_followed',
      crossChatFollowThread: 'at' as const,
    };
    recordBridgeReplyMarker(marker);
    expect(resolve()).not.toBeNull();

    fsControl.failHostAppend = true;
    expect(recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 2000, deliveryKind: 'detoured_send', targetChatId: 'oc_followed',
      targetRootMessageId: 'om_root_b', crossChatFollowThread: 'off',
    })).toBe(false);
    expect(resolve()).not.toBeNull();

    fsControl.failHostAppend = false;
    expect(recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 3000, deliveryKind: 'detoured_send', targetChatId: 'oc_followed',
      targetRootMessageId: 'om_root_b', crossChatFollowThread: 'off',
    })).toBe(true);
    expect(resolve()).toBeNull();
  });

  it('uses durable append order rather than wall-clock time for off/at overrides', () => {
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 2000, deliveryKind: 'detoured_send', messageId: 'om_root_b',
      targetChatId: 'oc_followed', crossChatFollowThread: 'at',
    });
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 1000, deliveryKind: 'detoured_send', targetRootMessageId: 'om_root_b',
      targetChatId: 'oc_followed', crossChatFollowThread: 'off',
    });
    expect(resolve()).toBeNull();
  });

  it('makes a follow-mode change a durable replay conflict instead of a silent replay', async () => {
    const ledger = new TurnSendLedger(tempDir);
    const key = { larkAppId: 'cli_cross', sessionId: 'sess-a', turnId: 'om_turn' };
    const mode = (noFollowThread: boolean) => effectiveCrossChatFollowThreadMode({
      targetChatId: 'oc_followed', sourceChatId: 'oc_origin', noFollowThread,
    });
    const identity = (noFollowThread: boolean) => canonicalJson({
      version: 1,
      destination: { into: 'om_root_b', chatId: 'oc_followed' },
      controls: { followThread: mode(noFollowThread) },
    });
    await ledger.execute(key, 'final', identity(false), async () => 'om_root_b');
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 1000, deliveryKind: 'detoured_send', messageId: 'om_root_b',
      targetChatId: 'oc_followed', crossChatFollowThread: 'at',
    });
    await expect(ledger.replayOrThrow(key, 'final', identity(false)))
      .resolves.toEqual({ messageId: 'om_root_b', replayed: true });
    await expect(ledger.execute(key, 'final', identity(true), async () => 'om_other', {
      beforeDispatch: () => persistCrossChatFollowThreadOffBeforeProvider({
        dataDir: tempDir, sessionId: 'sess-a', targetChatId: 'oc_followed', targetRootMessageId: 'om_root_b',
      }),
    })).rejects.toThrow('目标、提及或附件与已投递请求不同');
    expect(resolve()).not.toBeNull();
  });

  it('aborts a no-turn off send before provider when the tombstone cannot persist', async () => {
    fsControl.failHostAppend = true;
    const dispatch = vi.fn(async () => 'om_root_b');
    await expect((async () => {
      persistCrossChatFollowThreadOffBeforeProvider({
        dataDir: tempDir, sessionId: 'sess-a', targetChatId: 'oc_followed', targetRootMessageId: 'om_root_b',
      });
      return dispatch();
    })()).rejects.toThrow('无法持久化 --no-follow-thread');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('backfills a missing at binding without duplicating or reviving an off root', () => {
    expect(ensureCrossChatFollowThreadAtBinding({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 1000, messageId: 'om_root_b', targetChatId: 'oc_followed',
    })).toBe(true);
    expect(resolve()).not.toBeNull();
    expect(ensureCrossChatFollowThreadAtBinding({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 1000, messageId: 'om_root_b', targetChatId: 'oc_followed',
    })).toBe(true);
    expect(readFileSync(join(tempDir, '.dashboard-secret.cross-chat-follow-thread', 'sess-a.jsonl'), 'utf-8')
      .trim().split('\n')).toHaveLength(1);

    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 2000, deliveryKind: 'detoured_send', targetRootMessageId: 'om_root_b',
      targetChatId: 'oc_followed', crossChatFollowThread: 'off',
    });
    expect(resolve()).toBeNull();
    expect(ensureCrossChatFollowThreadAtBinding({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 1000, messageId: 'om_root_b', targetChatId: 'oc_followed',
      sourceTurnId: 'om_old_source',
    })).toBe(true);
    expect(resolve()).toBeNull();
  });

  it('enriches only the same legacy provider receipt and never overwrites a newer root binding', () => {
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 1000, deliveryKind: 'detoured_send', messageId: 'om_delivery_old',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed', crossChatFollowThread: 'at',
    });
    expect(ensureCrossChatFollowThreadAtBinding({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 1000, messageId: 'om_delivery_old',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed', sourceTurnId: 'om_source_old',
    })).toBe(true);
    expect(resolve()).toMatchObject({ sourceTurnId: 'om_source_old' });

    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 2000, deliveryKind: 'detoured_send', messageId: 'om_delivery_new',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed', crossChatFollowThread: 'at',
      turnId: 'om_source_new',
    });
    expect(ensureCrossChatFollowThreadAtBinding({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 1000, messageId: 'om_delivery_old',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed', sourceTurnId: 'om_source_old',
    })).toBe(true);
    expect(resolve()).toMatchObject({ sourceTurnId: 'om_source_new' });
    const records = readFileSync(
      join(tempDir, '.dashboard-secret.cross-chat-follow-thread', 'sess-a.jsonl'),
      'utf-8',
    ).trim().split('\n');
    expect(records).toHaveLength(3);
  });

  it('never enriches a legacy receipt when the replay names a different provider receipt', () => {
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 1000, deliveryKind: 'detoured_send', messageId: 'om_delivery_a',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed', crossChatFollowThread: 'at',
    });
    // A replay backfill naming a receipt the root's latest record does not know
    // must leave the journal untouched: stamping the old receipt with the new
    // turn would inject an attribution the actual delivery never carried.
    expect(ensureCrossChatFollowThreadAtBinding({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 2000, messageId: 'om_delivery_c',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed', sourceTurnId: 'om_source_c',
    })).toBe(true);
    const records = readFileSync(
      join(tempDir, '.dashboard-secret.cross-chat-follow-thread', 'sess-a.jsonl'),
      'utf-8',
    ).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ messageId: 'om_delivery_a' });
    expect(records[0]).not.toHaveProperty('sourceTurnId');
    const match = resolve();
    expect(match).not.toBeNull();
    expect(match).not.toHaveProperty('sourceTurnId');
  });

  it('never re-stamps an already attributed receipt onto another source turn', () => {
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 1000, deliveryKind: 'detoured_send', messageId: 'om_delivery_a',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed',
      crossChatFollowThread: 'at', turnId: 'om_source_1',
    });
    expect(ensureCrossChatFollowThreadAtBinding({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 3000, messageId: 'om_delivery_a',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed', sourceTurnId: 'om_source_2',
    })).toBe(true);
    const records = readFileSync(
      join(tempDir, '.dashboard-secret.cross-chat-follow-thread', 'sess-a.jsonl'),
      'utf-8',
    ).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ messageId: 'om_delivery_a', sourceTurnId: 'om_source_1' });
    expect(resolve()).toMatchObject({ sourceTurnId: 'om_source_1' });
  });

  it('does not make an old replay outrank a later binding from another source session', () => {
    const candidateSessions: CrossChatCandidateSession[] = [
      ...sessions,
      {
        sessionId: 'sess-b', larkAppId: 'cli_cross', chatId: 'oc_other_origin',
        rootMessageId: 'oc_other_origin', scope: 'chat', status: 'active',
      },
    ];
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 1000, deliveryKind: 'detoured_send', messageId: 'om_delivery_a',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed',
      crossChatFollowThread: 'at',
    });
    recordCrossChatFollowThreadBinding(tempDir, 'sess-b', {
      sentAtMs: 2000, deliveryKind: 'detoured_send', messageId: 'om_delivery_b',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed',
      crossChatFollowThread: 'at', turnId: 'om_source_b',
    });
    const resolveBoth = () => resolveCrossChatFollowedThread({
      dataDir: tempDir, larkAppId: 'cli_cross', chatId: 'oc_followed',
      candidateRootIds: ['om_root_b'], sessions: candidateSessions,
    });
    expect(resolveBoth()).toMatchObject({
      sourceSessionId: 'sess-b', sourceTurnId: 'om_source_b',
    });

    expect(ensureCrossChatFollowThreadAtBinding({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 3000,
      messageId: 'om_delivery_a', targetRootMessageId: 'om_root_b',
      targetChatId: 'oc_followed', sourceTurnId: 'om_source_a',
    })).toBe(true);

    expect(resolveBoth()).toMatchObject({
      sourceSessionId: 'sess-b', sourceTurnId: 'om_source_b',
    });
    const enriched = readFileSync(
      join(tempDir, '.dashboard-secret.cross-chat-follow-thread', 'sess-a.jsonl'),
      'utf-8',
    ).trim().split('\n').map(line => JSON.parse(line));
    expect(enriched).toHaveLength(2);
    expect(enriched[1]).toMatchObject({
      sentAtMs: 1000, sourceTurnId: 'om_source_a', messageId: 'om_delivery_a',
    });
  });

  it('rejects cross-session timestamp ties in either traversal order, but accepts a later unique owner', () => {
    const other = { ...sessions[0], sessionId: 'sess-b', chatId: 'oc_other' };
    for (const [sessionId, turnId] of [['sess-a', 'om_source_a'], ['sess-b', 'om_source_b']]) {
      recordCrossChatFollowThreadBinding(tempDir, sessionId, {
        sentAtMs: 1000, deliveryKind: 'detoured_send', messageId: `om_receipt_${sessionId}`,
        targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed',
        crossChatFollowThread: 'at', turnId,
      });
    }
    const resolveOrder = (order: CrossChatCandidateSession[]) => resolveCrossChatFollowedThread({
      dataDir: tempDir, larkAppId: 'cli_cross', chatId: 'oc_followed',
      candidateRootIds: ['om_root_b'], sessions: order,
    });
    expect(resolveOrder([sessions[0], other])).toBeNull();
    expect(resolveOrder([other, sessions[0]])).toBeNull();
    recordCrossChatFollowThreadBinding(tempDir, 'sess-b', {
      sentAtMs: 1001, deliveryKind: 'detoured_send', messageId: 'om_new_receipt',
      targetRootMessageId: 'om_root_b', targetChatId: 'oc_followed',
      crossChatFollowThread: 'at', turnId: 'om_source_b',
    });
    for (const order of [[sessions[0], other], [other, sessions[0]]]) {
      expect(resolveOrder(order)).toMatchObject({ sourceSessionId: 'sess-b', sourceTurnId: 'om_source_b' });
    }
  });

  it('serializes replay at with a concurrent off writer across real processes', async () => {
    const replayReady = join(tempDir, 'replay-ready');
    const offReady = join(tempDir, 'off-ready');
    const release = join(tempDir, 'release');
    const script = fileURLToPath(new URL('./fixtures/cross-chat-replay-lock.ts', import.meta.url));
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    recordCrossChatFollowThreadBinding(tempDir, 'sess-a', {
      sentAtMs: 500, deliveryKind: 'detoured_send', messageId: 'om_other_root',
      targetChatId: 'oc_followed', crossChatFollowThread: 'at',
    });
    const replay = spawnNodeTsScript(script, ['replay', tempDir, replayReady, release], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let off: ReturnType<typeof spawnNodeTsScript> | undefined;
    const wait = (child: ReturnType<typeof spawnNodeTsScript>) => new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    try {
      await vi.waitFor(() => expect(existsSync(replayReady)).toBe(true), { timeout: 10_000 });
      off = spawnNodeTsScript(script, ['off', tempDir, offReady, release], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      await vi.waitFor(() => expect(existsSync(offReady)).toBe(true), { timeout: 10_000 });
      writeFileSync(release, 'go');
      await Promise.all([wait(replay), wait(off)]);
      expect(resolve()).toBeNull();
    } finally {
      replay.kill('SIGKILL');
      off?.kill('SIGKILL');
    }
  });
});
