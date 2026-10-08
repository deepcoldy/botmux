import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TurnSendLedger, turnSendLedgerSessionDir } from '../src/services/turn-send-ledger.js';

const key = {
  larkAppId: 'cli_test',
  sessionId: 'session_test',
  turnId: 'turn_test',
  dispatchAttempt: 1,
};

describe('TurnSendLedger', () => {
  it('reuses the first message id for an identical final retry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const dispatch = vi.fn(async () => 'om_first');

      await expect(ledger.execute(key, 'final', 'answer with https://example.test/', dispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: false });
      await expect(ledger.execute(key, 'final', 'answer with https://example.test/', dispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: true });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a different final and ordinary progress after final', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await ledger.execute(key, 'final', 'first answer', async () => 'om_first');
      const dispatch = vi.fn(async () => 'om_late');

      await expect(ledger.execute(key, 'final', 'changed answer', dispatch))
        .rejects.toThrow('目标、提及或附件与已投递请求不同');
      await expect(ledger.execute(key, 'progress', 'late progress', dispatch))
        .rejects.toThrow('本轮 final 已完成');
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('allows explicitly auxiliary output after final', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await ledger.execute(key, 'final', 'answer', async () => 'om_first');

      await expect(ledger.execute(key, 'auxiliary', 'supplement', async () => 'om_aux'))
        .resolves.toEqual({ messageId: 'om_aux', replayed: false });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent final sends so only one provider call wins', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const first = vi.fn(async () => { await blocked; return 'om_first'; });
      const second = vi.fn(async () => 'om_second');

      const a = ledger.execute(key, 'final', 'same answer', first);
      await new Promise(resolve => setTimeout(resolve, 50));
      const b = ledger.execute(key, 'final', 'same answer', second);
      release();

      await expect(a).resolves.toEqual({ messageId: 'om_first', replayed: false });
      await expect(b).resolves.toEqual({ messageId: 'om_first', replayed: true });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('treats dispatch attempts of one logical turn as the same final slot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const firstDispatch = vi.fn(async () => 'om_first');
      const retryDispatch = vi.fn(async () => 'om_retry');

      await expect(ledger.execute({ ...key, dispatchAttempt: 1 }, 'final', 'same answer', firstDispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: false });
      await expect(ledger.execute({ ...key, dispatchAttempt: 2 }, 'final', 'same answer', retryDispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: true });
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect(retryDispatch).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reconciles a crash after provider acceptance with the same stable uuid', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      let acceptedUuid: string | undefined;
      const firstDispatch = vi.fn(async (providerUuid?: string) => {
        acceptedUuid = providerUuid;
        throw new Error('provider accepted but the client lost its response');
      });

      await expect(ledger.execute(key, 'final', 'same answer', firstDispatch))
        .rejects.toThrow('lost its response');
      expect(acceptedUuid).toMatch(/^bts_[a-f0-9]{32}$/);
      expect(readdirSync(ledger.sessionDirectory(key.sessionId)).filter(name => name.endsWith('.json'))).toHaveLength(0);

      const retryDispatch = vi.fn(async (providerUuid?: string) => {
        expect(providerUuid).toBe(acceptedUuid);
        return 'om_reconciled';
      });
      await expect(ledger.execute({ ...key, dispatchAttempt: 2 }, 'final', 'same answer', retryDispatch))
        .resolves.toEqual({ messageId: 'om_reconciled', replayed: false });
      expect(retryDispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('resumes known completed non-idempotent steps but refuses an unknown in-flight step', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const firstAttempt = vi.fn(async (index: number, effects: {
        providerRequestStarted(): void;
      }) => {
        effects.providerRequestStarted();
        if (index === 1) throw new Error('provider response lost');
      });

      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 3, firstAttempt as never, 'doc:comment-1',
      )).rejects.toThrow('provider response lost');
      expect(firstAttempt.mock.calls.map(call => call[0])).toEqual([0, 1]);

      const retry = vi.fn(async () => {});
      await expect(ledger.executeNonIdempotentSequence(
        { ...key, dispatchAttempt: 2 }, 'final', 'long answer', 3, retry, 'doc:comment-1',
      )).rejects.toThrow('第 2 个投递分块的结果未知');
      expect(retry).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('allows retry when a non-idempotent step fails before reaching the provider', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'answer', 1, async () => {
          throw new Error('missing token before request');
        }, 'doc:comment-1',
      )).rejects.toThrow('missing token before request');

      const retry = vi.fn(async (_index: number, effects?: {
        providerRequestStarted(): void;
      }) => {
        effects?.providerRequestStarted();
      });
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'answer', 1, retry as never, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: false });
      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('allows retry when the provider definitively rejects a non-idempotent step', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'answer', 1, async (_index: number, effects?: {
          providerRequestStarted(): void;
          providerRequestNotDelivered(): void;
        }) => {
          effects?.providerRequestStarted();
          effects?.providerRequestNotDelivered();
          throw new Error('provider rejected request');
        }, 'doc:comment-1',
      )).rejects.toThrow('provider rejected request');

      const retry = vi.fn(async (_index: number, effects?: {
        providerRequestStarted(): void;
      }) => {
        effects?.providerRequestStarted();
      });
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'answer', 1, retry as never, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: false });
      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('records a completed non-idempotent sequence as the turn final', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const firstAttempt = vi.fn(async () => {});

      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 2, firstAttempt, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: false });
      expect(firstAttempt.mock.calls.map(call => call[0])).toEqual([0, 1]);

      const retry = vi.fn(async () => {});
      await expect(ledger.executeNonIdempotentSequence(
        { ...key, dispatchAttempt: 2 }, 'final', 'long answer', 2, retry, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: true });
      expect(retry).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('inspects an unknown in-flight document-comment step by its human turn identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 3, async (index, effects) => {
          effects.providerRequestStarted();
          if (index === 1) throw new Error('provider response lost');
        }, 'doc:comment-1',
      )).rejects.toThrow('provider response lost');

      expect(ledger.inspect({ sessionId: key.sessionId, turnId: key.turnId })).toEqual([{
        larkAppId: key.larkAppId,
        sessionId: key.sessionId,
        turnId: key.turnId,
        state: 'in_flight',
        target: 'doc:comment-1',
        stepCount: 3,
        completedSteps: 1,
        inFlightStep: 2,
      }]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('resumes after an operator confirms the unknown step was delivered', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 3, async (index, effects) => {
          effects.providerRequestStarted();
          if (index === 1) throw new Error('provider response lost');
        }, 'doc:comment-1',
      )).rejects.toThrow('provider response lost');

      await expect(ledger.resolveUnknownStep(key, 'delivered')).resolves.toMatchObject({
        state: 'incomplete',
        completedSteps: 2,
      });
      const retry = vi.fn(async () => {});
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 3, retry, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: false });
      expect(retry.mock.calls.map(call => call[0])).toEqual([2]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('retries the same step after an operator confirms the unknown step was not delivered', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 3, async (index, effects) => {
          effects.providerRequestStarted();
          if (index === 1) throw new Error('provider response lost');
        }, 'doc:comment-1',
      )).rejects.toThrow('provider response lost');

      await expect(ledger.resolveUnknownStep(key, 'not-delivered')).resolves.toMatchObject({
        state: 'incomplete',
        completedSteps: 1,
      });
      const retry = vi.fn(async () => {});
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 3, retry, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: false });
      expect(retry.mock.calls.map(call => call[0])).toEqual([1, 2]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('finalizes without another provider call after the last unknown step is confirmed delivered', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'short answer', 1, async (_index, effects) => {
          effects.providerRequestStarted();
          throw new Error('provider response lost');
        }, 'doc:comment-1',
      )).rejects.toThrow('provider response lost');

      await ledger.resolveUnknownStep(key, 'delivered');
      const retry = vi.fn(async () => {});
      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'short answer', 1, retry, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: false });
      expect(retry).not.toHaveBeenCalled();
      expect(ledger.inspect({ sessionId: key.sessionId, turnId: key.turnId })[0]).toMatchObject({
        state: 'completed', messageId: 'doc:comment-1',
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('prunes only completed records older than 30 days and preserves in-flight recovery evidence', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const completedKey = { ...key, turnId: 'turn_completed' };
      const stuckKey = { ...key, turnId: 'turn_stuck' };
      await ledger.execute(completedKey, 'final', 'done', async () => 'om_done');
      await expect(ledger.executeNonIdempotentSequence(
        stuckKey, 'final', 'long answer', 2, async (_index, effects) => {
          effects.providerRequestStarted();
          throw new Error('provider response lost');
        }, 'doc:comment-stuck',
      )).rejects.toThrow('provider response lost');

      const completedPath = ledger.recordPath(completedKey);
      const stuckPath = ledger.recordPath(stuckKey);
      const result = await ledger.pruneCompleted(Date.now() + 31 * 24 * 60 * 60_000);

      expect(result).toEqual({ removed: 1, retained: 1 });
      expect(existsSync(completedPath)).toBe(false);
      expect(existsSync(stuckPath)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('runs automatic completed-record pruning at most once per day', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const firstKey = { ...key, turnId: 'turn_first_old' };
      const secondKey = { ...key, turnId: 'turn_second_old' };
      await ledger.execute(firstKey, 'final', 'first', async () => 'om_first');
      const future = Date.now() + 31 * 24 * 60 * 60_000;

      await expect(ledger.pruneCompletedIfDue(future)).resolves.toEqual({
        ran: true, removed: 1, retained: 0,
      });
      await ledger.execute(secondKey, 'final', 'second', async () => 'om_second');
      await expect(ledger.pruneCompletedIfDue(future + 60_000)).resolves.toEqual({
        ran: false, removed: 0, retained: 0,
      });
      expect(existsSync(ledger.recordPath(secondKey))).toBe(true);
      await expect(ledger.pruneCompletedIfDue(future + 24 * 60 * 60_000)).resolves.toEqual({
        ran: true, removed: 1, retained: 0,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('skips a completed record that is busy instead of delaying the send-path sweep', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    let releaseLock: ReturnType<typeof setTimeout> | undefined;
    try {
      const ledger = new TurnSendLedger(dataDir);
      await ledger.execute(key, 'final', 'done', async () => 'om_done');
      const recordPath = ledger.recordPath(key);
      const lockPath = `${recordPath}.lock`;
      writeFileSync(lockPath, String(process.pid));
      releaseLock = setTimeout(() => rmSync(lockPath, { force: true }), 250);

      const result = await ledger.pruneCompleted(Date.now() + 31 * 24 * 60 * 60_000);

      expect(result).toEqual({ removed: 0, retained: 1 });
      expect(existsSync(recordPath)).toBe(true);
    } finally {
      if (releaseLock) clearTimeout(releaseLock);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('skips an automatic sweep when another process owns the prune marker lock', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    let releaseLock: ReturnType<typeof setTimeout> | undefined;
    try {
      const ledger = new TurnSendLedger(dataDir);
      await ledger.execute(key, 'final', 'done', async () => 'om_done');
      const markerLockPath = join(ledger.directory, '.completed-prune.lock');
      writeFileSync(markerLockPath, String(process.pid));
      releaseLock = setTimeout(() => rmSync(markerLockPath, { force: true }), 250);

      await expect(ledger.pruneCompletedIfDue(
        Date.now() + 31 * 24 * 60 * 60_000,
      )).resolves.toEqual({ ran: false, removed: 0, retained: 0 });
    } finally {
      if (releaseLock) clearTimeout(releaseLock);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('TurnSendLedger per-session layout', () => {
  const withLedger = async (fn: (ledger: TurnSendLedger, dataDir: string) => Promise<void>) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try { await fn(new TurnSendLedger(dataDir), dataDir); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  };
  const legacyPath = (ledger: TurnSendLedger, k: typeof key) => join(ledger.directory, `${ledger.id(k)}.json`);

  it('files each record under its own session directory, never the shared root', async () => {
    await withLedger(async (ledger, dataDir) => {
      const otherKey = { ...key, sessionId: 'session_other' };
      await ledger.execute(key, 'final', 'a', async () => 'om_a');
      await ledger.execute(otherKey, 'final', 'b', async () => 'om_b');

      expect(ledger.recordPath(key)).toBe(join(dataDir, 'turn-send-ledger', key.sessionId, `${ledger.id(key)}.json`));
      expect(turnSendLedgerSessionDir(dataDir, key.sessionId)).toBe(ledger.sessionDirectory(key.sessionId));
      expect(existsSync(ledger.recordPath(key))).toBe(true);
      expect(existsSync(ledger.recordPath(otherKey))).toBe(true);
      expect(readdirSync(ledger.directory).filter(name => name.endsWith('.json'))).toEqual([]);
      expect(ledger.inspect().map(r => r.sessionId).sort()).toEqual([key.sessionId, otherKey.sessionId].sort());
    });
  });

  it.each(['..', '.', 'a/b', '', '.completed-prune', 'x'.repeat(129)])('refuses session id %j as a directory name', async sessionId => {
    await withLedger(async ledger => {
      const dispatch = vi.fn(async () => 'om_never');
      await expect(ledger.execute({ ...key, sessionId }, 'final', 'a', dispatch))
        .rejects.toThrow('Invalid turn-send ledger session id');
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it('still fences with a record written in the legacy flat layout, then migrates it on the next write', async () => {
    await withLedger(async ledger => {
      await ledger.execute(key, 'final', 'answer', async () => 'om_first');
      renameSync(ledger.recordPath(key), legacyPath(ledger, key));
      const dispatch = vi.fn(async () => 'om_dup');

      await expect(ledger.execute(key, 'final', 'answer', dispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: true });
      await expect(ledger.execute(key, 'final', 'changed', dispatch))
        .rejects.toThrow('目标、提及或附件与已投递请求不同');
      expect(dispatch).not.toHaveBeenCalled();
      expect(ledger.inspect()).toHaveLength(1);
      expect((await ledger.pruneCompleted(Date.now() + 31 * 24 * 60 * 60_000)).removed).toBe(1);
      expect(existsSync(legacyPath(ledger, key))).toBe(false);
    });
  });

  it('resolves a legacy in-flight record into the session directory without leaving a duplicate', async () => {
    await withLedger(async ledger => {
      await expect(ledger.executeNonIdempotentSequence(key, 'final', 'long', 2, async (_i, effects) => {
        effects.providerRequestStarted();
        throw new Error('provider response lost');
      }, 'doc:comment')).rejects.toThrow('provider response lost');
      renameSync(ledger.recordPath(key), legacyPath(ledger, key));

      await expect(ledger.resolveUnknownStep(key, 'delivered')).resolves.toMatchObject({ completedSteps: 1 });
      expect(existsSync(ledger.recordPath(key))).toBe(true);
      expect(existsSync(legacyPath(ledger, key))).toBe(false);
      expect(ledger.inspect()).toHaveLength(1);
    });
  });

  it('rejects a record filed under another session directory', async () => {
    await withLedger(async ledger => {
      const victim = { ...key, sessionId: 'session_victim' };
      await ledger.execute(key, 'final', 'answer', async () => 'om_first');
      // Same content under a different session directory: the hash-only
      // filename check would accept it, the owning-session check must not.
      mkdirSync(ledger.sessionDirectory(victim.sessionId), { recursive: true });
      writeFileSync(join(ledger.sessionDirectory(victim.sessionId), `${ledger.id(key)}.json`),
        readFileSync(ledger.recordPath(key), 'utf8'));

      expect(() => ledger.inspect()).toThrow('filed under another session');
    });
  });
});
