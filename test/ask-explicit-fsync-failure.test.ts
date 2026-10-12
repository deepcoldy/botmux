/**
 * Persistence-failure contract for daemon-owned explicit asks.
 *
 * The durable handoff write is a correctness gate for a real human ANSWER only:
 *  - a failed fsync on the click path MUST throw so the card click fails closed
 *    (settle runs before any state mutation → the ask stays pending),
 *  - a failed fsync on the timeout / boot-restore path MUST NOT throw: those run
 *    from bare setTimeout callbacks with no caller-side catch, and the daemon
 *    installs no uncaughtException trap, so an escape kills the process; explicit
 *    records are exempt from the disk deadline reaper, so it would crash-loop on
 *    every restart while the disk stays unhealthy.
 *
 * The real createAskPersistStore is used with atomicWriteFileSync forced to fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(() => {
    throw Object.assign(new Error('EIO: fsync failed'), { code: 'EIO' });
  }),
}));

import {
  _getPending,
  _pendingCount,
  _resetForTest,
  registerHostAsk,
  setAskPersistStore,
  setCardDispatcher,
  setCanTalkChecker,
  tryResolveAsk,
} from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';

const dirs: string[] = [];

function hostExplicitInput(timeoutMs: number): CreateAskInput {
  return {
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    requestId: 'explicit-req-1',
    originKind: 'host_explicit',
    questions: [{
      prompt: '继续发版吗？',
      options: [{ key: 'yes', label: '继续' }, { key: 'no', label: '回滚' }],
      multiSelect: false,
    }],
    timeoutMs,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
  setCanTalkChecker(() => true);
  const dir = mkdtempSync(join(tmpdir(), 'ask-fsync-'));
  dirs.push(dir);
  setAskPersistStore(createAskPersistStore(join(dir, 'asks')));
});

afterEach(() => {
  vi.useRealTimers();
  _resetForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('host_explicit fsync failure', () => {
  it('deadline timer still settles timedOut and never throws when the disk write fails', async () => {
    let dispatched: PendingAsk | undefined;
    setCardDispatcher({ send: async ask => { dispatched = ask; return { messageId: 'om_card' }; } });

    const escaped: unknown[] = [];
    const onUncaught = (e: unknown) => escaped.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const p = registerHostAsk(hostExplicitInput(1_000));
      // Flush the async card-delivery chain (its post-delivery write also fails
      // — it must be swallowed as best-effort, not invalidate the ask).
      await Promise.resolve();
      await Promise.resolve();
      expect(_pendingCount()).toBe(1);
      expect(dispatched?.askId).toBeTruthy();

      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
      await expect(p).resolves.toMatchObject({ kind: 'timedOut', timedOut: true });
      expect(escaped).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  it('a human answer click fails closed: it throws, and the ask stays pending', async () => {
    let dispatched: PendingAsk | undefined;
    setCardDispatcher({ send: async ask => { dispatched = ask; return { messageId: 'om_card' }; } });

    const p = registerHostAsk(hostExplicitInput(60_000));
    void p.catch(() => { /* never settles in this test */ });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatched).toBeTruthy();

    expect(() => tryResolveAsk({
      askId: dispatched!.askId,
      nonce: dispatched!.nonce,
      selected: 'yes',
      by: 'ou_owner',
    })).toThrow(/EIO: fsync failed/);

    // settle() runs before any state mutation when the write throws, so the
    // human can click again once the disk is healthy.
    expect(_pendingCount()).toBe(1);
    expect(_getPending(dispatched!.askId)?.settled).toBe(false);
  });
});
