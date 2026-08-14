/**
 * Unit tests for resolveAsyncTriggerState — the pure four-state resolver behind
 * GET /api/sessions/:id/trigger-result (async dispatch design A).
 *
 * Focus: the state contract riff branches on, and the restart guarantee
 * (already-completed / still-armed turns never degrade to not_found once the
 * in-memory Map is gone).
 *
 * Run:  pnpm vitest run test/async-trigger-state.test.ts
 */
import { describe, it, expect } from 'vitest';
import { resolveAsyncTriggerState, decideAsyncOwnership } from '../src/services/async-trigger-state.js';

describe('decideAsyncOwnership — fail-closed cross-bot isolation (P1-1)', () => {
  const OWNER = 'cli_me';

  it('live ds → both sources kept (always ours)', () => {
    const d = decideAsyncOwnership({ owner: OWNER, liveDs: true, storedExists: true, storedOwner: undefined, persistedExists: true, persistedOwner: undefined });
    expect(d).toMatchObject({ keepStored: true, keepPersisted: true, foreignLeak: false });
  });

  it('stored record owned by another bot (no ds) → dropped, foreignLeak', () => {
    const d = decideAsyncOwnership({ owner: OWNER, liveDs: false, storedExists: true, storedOwner: 'cli_other', persistedExists: false });
    expect(d.keepStored).toBe(false);
    expect(d.foreignLeak).toBe(true);
  });

  it('persisted stamped with another bot → dropped, foreignLeak', () => {
    const d = decideAsyncOwnership({ owner: OWNER, liveDs: false, storedExists: false, persistedExists: true, persistedOwner: 'cli_other' });
    expect(d.keepPersisted).toBe(false);
    expect(d.foreignLeak).toBe(true);
  });

  it('THE fail-open regression: unstamped legacy persisted file + no owned session → DROPPED', () => {
    // Pre-owner-stamping file (persistedOwner undefined) with no stored record
    // and no live ds. Owner is unprovable → must NOT be served to any daemon.
    const d = decideAsyncOwnership({ owner: OWNER, liveDs: false, storedExists: false, persistedExists: true, persistedOwner: undefined });
    expect(d.keepPersisted).toBe(false);
    expect(d.foreignLeak).toBe(true);
  });

  it('unstamped legacy persisted file CORROBORATED by our own stored record → kept', () => {
    // Same unstamped file, but a stored record owned by us exists for the id —
    // that positively attributes it to us, so the legacy file resolves.
    const d = decideAsyncOwnership({ owner: OWNER, liveDs: false, storedExists: true, storedOwner: OWNER, persistedExists: true, persistedOwner: undefined });
    expect(d.keepStored).toBe(true);
    expect(d.keepPersisted).toBe(true);
    expect(d.foreignLeak).toBe(false);
  });

  it('persisted stamped with OUR owner → kept even with no stored record', () => {
    const d = decideAsyncOwnership({ owner: OWNER, liveDs: false, storedExists: false, persistedExists: true, persistedOwner: OWNER });
    expect(d.keepPersisted).toBe(true);
    expect(d.foreignLeak).toBe(false);
  });

  it('no raw data at all → no foreignLeak (falls through to normal not_found)', () => {
    const d = decideAsyncOwnership({ owner: OWNER, liveDs: false, storedExists: false, persistedExists: false });
    expect(d).toMatchObject({ keepStored: false, keepPersisted: false, foreignLeak: false });
  });

  it('empty owner (larkAppId not yet cached) never spuriously matches a stamped file', () => {
    const d = decideAsyncOwnership({ owner: '', liveDs: false, storedExists: false, persistedExists: true, persistedOwner: 'cli_other' });
    expect(d.keepPersisted).toBe(false);
    expect(d.foreignLeak).toBe(true);
  });
});

describe('resolveAsyncTriggerState — completed', () => {
  it('from live in-memory result', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: true,
      chatId: 'http_async_x',
      memResult: { status: 'completed', content: 'BOTMUX_RUN_OK', completedAt: 5000 },
      memTriggerId: 'trg_a',
      storedStatus: 'open',
    });
    expect(r.state).toBe('completed');
    expect(r.output?.content).toBe('BOTMUX_RUN_OK');
    expect(r.finishedAt).toBe(new Date(5000).toISOString());
    expect(r.triggerId).toBe('trg_a');
  });

  it('emits per-turn usage from the completed result (mem and persisted), omits when absent', () => {
    const usage = { inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreateTokens: 0 };
    const fromMem = resolveAsyncTriggerState({
      sessionId: 's1', liveActive: true, storedStatus: 'open', memTriggerId: 'trg_a',
      memResult: { status: 'completed', content: 'x', completedAt: 1, usage },
    });
    expect(fromMem.usage).toEqual(usage);

    const fromDisk = resolveAsyncTriggerState({
      sessionId: 's1', liveActive: false, storedStatus: 'closed',
      persisted: { triggerId: 'trg_a', result: { status: 'completed', content: 'x', completedAt: 1, usage } },
    });
    expect(fromDisk.usage).toEqual(usage);

    const noUsage = resolveAsyncTriggerState({
      sessionId: 's1', liveActive: true, storedStatus: 'open', memTriggerId: 'trg_a',
      memResult: { status: 'completed', content: 'x', completedAt: 1 },
    });
    expect(noUsage.state).toBe('completed');
    expect(noUsage.usage).toBeUndefined();
  });

  it('rebuilt from durable result after restart (no live session)', () => {
    // Simulates daemon restart: no live ds, in-memory Map gone, but the
    // session record is closed and the durable result says completed.
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'completed', content: 'survived', completedAt: 7000 } },
      storedStatus: 'closed',
      closedAt: new Date(8000).toISOString(),
    });
    expect(r.state).toBe('completed');
    expect(r.output?.content).toBe('survived');
    expect(r.finishedAt).toBe(new Date(7000).toISOString());
  });

  it('closed session WITH captured output is completed, not failed', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'completed', content: 'done', completedAt: 100 } },
      storedStatus: 'closed',
    });
    expect(r.state).toBe('completed');
  });
});

describe('resolveAsyncTriggerState — running', () => {
  it('live session, pending in-memory', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: true,
      memResult: { status: 'pending' },
      memTriggerId: 'trg_a',
      storedStatus: 'open',
    });
    expect(r.state).toBe('running');
  });

  it('durable pending after restart never degrades to not_found', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'pending', content: undefined } },
      storedStatus: undefined, // record not found, but a pending trigger was armed
    });
    expect(r.state).toBe('running');
  });

  it('open session record with no result yet', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      storedStatus: 'open',
    });
    expect(r.state).toBe('running');
  });
});

describe('resolveAsyncTriggerState — failed', () => {
  it('reports an explicit worker terminal immediately even while the session stays open', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: true,
      storedStatus: 'open',
      memTriggerId: 'trg_a',
      memResult: {
        status: 'failed',
        failedAt: 7000,
        errorCode: 'trigger_failed',
        terminalErrorCode: 'provider_unexpected_eof',
      },
    });
    expect(r).toMatchObject({
      state: 'failed',
      triggerId: 'trg_a',
      errorCode: 'trigger_failed',
      error: expect.stringContaining('provider_unexpected_eof'),
      finishedAt: new Date(7000).toISOString(),
    });
  });

  it('rebuilds an explicit worker terminal from durable state after restart', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      storedStatus: 'open',
      persisted: {
        triggerId: 'trg_a',
        result: {
          status: 'failed',
          failedAt: 7000,
          errorCode: 'trigger_failed',
          reason: 'turn_terminal',
          terminalErrorCode: 'provider_server_error',
        },
      },
    });
    expect(r).toMatchObject({
      state: 'failed',
      errorCode: 'trigger_failed',
      error: expect.stringContaining('provider_server_error'),
    });
  });

  it('closed session, no captured output → failed(no_output)', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      storedStatus: 'closed',
      closedAt: new Date(9000).toISOString(),
    });
    expect(r.state).toBe('failed');
    expect(r.errorCode).toBe('no_output');
    expect(r.finishedAt).toBe(new Date(9000).toISOString());
    expect(r.output).toBeUndefined();
  });

  it('closed session with a still-pending durable record → failed, NOT running (cancel path)', () => {
    // Regression: canceling (close) a running async session leaves its persisted
    // record at `pending`. The closed check must win over durable-pending, or the
    // poller loops on `running` forever after a cancel.
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'pending' } },
      storedStatus: 'closed',
      closedAt: new Date(9000).toISOString(),
    });
    expect(r.state).toBe('failed');
    expect(r.errorCode).toBe('no_output');
  });
});

describe('resolveAsyncTriggerState — precise triggerId miss (P1-2)', () => {
  it('session exists but requested triggerId has no record → bad_request (not running/failed)', () => {
    // A live session with a DIFFERENT trigger; caller pins a trigger this
    // session never had. Legacy semantics: bad_request precise-miss, NOT a
    // fall-through to running just because the session is open.
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: true,
      storedStatus: 'open',
      requestedTriggerId: 'trg_never',
      // no memResult / persisted for trg_never
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('bad_request');
    expect(r.state).toBeUndefined(); // request-shape error, not a task-lifecycle state
    expect(r.triggerId).toBe('trg_never');
  });

  it('closed session + unknown requested triggerId → bad_request (not failed)', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      storedStatus: 'closed',
      requestedTriggerId: 'trg_never',
    });
    expect(r.errorCode).toBe('bad_request');
  });

  it('no triggerId pinned → NOT a precise miss (falls through to session state)', () => {
    const r = resolveAsyncTriggerState({ sessionId: 's1', liveActive: true, storedStatus: 'open' });
    expect(r.state).toBe('running');
  });

  it('ghost session + requested triggerId → session_not_found, not bad_request', () => {
    // No session anywhere: this is a genuinely unknown session, not a
    // precise-miss on an existing one.
    const r = resolveAsyncTriggerState({ sessionId: 'ghost', liveActive: false, requestedTriggerId: 'trg_q' });
    expect(r.errorCode).toBe('session_not_found');
  });
});

describe('resolveAsyncTriggerState — not_found', () => {
  it('no session record and no persisted result', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 'ghost',
      liveActive: false,
      requestedTriggerId: 'trg_q',
    });
    expect(r.state).toBe('not_found');
    expect(r.errorCode).toBe('session_not_found');
    expect(r.triggerId).toBe('trg_q');
  });

  it('the restart-critical distinction: completed session never reads as not_found', () => {
    // Two lookups for the same id: one where nothing is known (not_found),
    // one where a durable completed result exists (completed). This is the
    // exact false-"task lost" the design guards against.
    const ghost = resolveAsyncTriggerState({ sessionId: 's1', liveActive: false });
    expect(ghost.state).toBe('not_found');

    const recovered = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'completed', content: 'x', completedAt: 1 } },
      storedStatus: 'closed',
    });
    expect(recovered.state).toBe('completed');
  });
});

describe('resolveAsyncTriggerState — four resolved states carry ok:true', () => {
  it('running/completed/failed/not_found are ok:true (task state is in .state, not ok/HTTP); only precise-miss is ok:false', () => {
    const inputs = [
      { sessionId: 's', liveActive: true, memResult: { status: 'completed' as const, content: 'c', completedAt: 1 }, memTriggerId: 't' },
      { sessionId: 's', liveActive: true, storedStatus: 'open' as const },
      { sessionId: 's', liveActive: false, storedStatus: 'closed' as const },
      { sessionId: 's', liveActive: false },
    ];
    for (const i of inputs) expect(resolveAsyncTriggerState(i).ok).toBe(true);
  });
});
