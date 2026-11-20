import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    await expect(ledger.replayOrThrow(key, 'final', identity(false)))
      .resolves.toEqual({ messageId: 'om_root_b', replayed: true });
    await expect(ledger.replayOrThrow(key, 'final', identity(true)))
      .rejects.toThrow('目标、提及或附件与已投递请求不同');
  });
});
