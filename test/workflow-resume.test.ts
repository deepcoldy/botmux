import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventLog, type EventDraft } from '../src/workflows/events/append.js';
import {
  resume,
  type ProviderReconciler,
  type ResumeResult,
} from '../src/workflows/resume.js';
import { PROVIDER_TTL_MS } from '../src/workflows/events/schema.js';

const RUN_ID = 'run-resume-test-01';
const SHA = 'sha256:' + 'c'.repeat(64);
const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 32,
  outputSchemaVersion: 1,
};

let baseDir: string;
let log: EventLog;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-resume-'));
  log = new EventLog(RUN_ID, baseDir);
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

// ─── Fixture helpers ────────────────────────────────────────────────────────

const runCreated: EventDraft = {
  runId: RUN_ID,
  type: 'runCreated',
  actor: 'scheduler',
  payload: {
    workflowId: 'wf-demo',
    revisionId: 'rev-001',
    inputRef: sampleOutputRef,
    initiator: 'tester',
  },
};

function attemptCreated(activityId: string, attemptId: string, nodeId = 'n-1'): EventDraft {
  return {
    runId: RUN_ID,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      activityId,
      attemptId,
      attemptNumber: 1,
      nodeId,
      inputRef: sampleOutputRef,
    },
  };
}

function effectAttempted(
  activityId: string,
  attemptId: string,
  provider: 'feishu-im' | 'botmux-schedule' | string,
  idempotencyKey: string,
  attemptedAtMs?: number,
  ttlMs?: number,
): EventDraft {
  return {
    runId: RUN_ID,
    type: 'effectAttempted',
    actor: 'hostExecutor',
    payload: {
      activityId,
      attemptId,
      idempotencyKey,
      inputHash: 'sha256:' + 'd'.repeat(64),
      idempotencyTtlMs: ttlMs ?? PROVIDER_TTL_MS['feishu-im'],
      provider,
    },
    ...(attemptedAtMs !== undefined ? { timestamp: attemptedAtMs } : {}),
  };
}

async function bootstrapWith(...drafts: EventDraft[]): Promise<void> {
  await log.append(runCreated);
  for (const d of drafts) await log.append(d);
}

function emptyReconcilers(): Map<string, ProviderReconciler> {
  return new Map();
}

// ─── resumeStarted is always written first ─────────────────────────────────

describe('resume — resumeStarted audit entry', () => {
  it('writes resumeStarted as the first event of the resume cycle', async () => {
    await bootstrapWith();
    const before = (await log.readAll()).length;
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    const after = await log.readAll();
    expect(after.length).toBe(before + 1);
    expect(r.resumeStartedEvent.type).toBe('resumeStarted');
    const payload = r.resumeStartedEvent.payload as { daemonId: string; lastSeenEventId: string };
    expect(payload.daemonId).toBe('d-1');
    expect(payload.lastSeenEventId).toMatch(/-1$/); // runCreated is seq 1
  });

  it('rejects resume against an empty log (no runCreated to project)', async () => {
    // No bootstrap — log is empty.  Resume writes resumeStarted as audit
    // entry, then tries to replay; replay rejects logs that don't begin
    // with runCreated.  The resumeStarted IS written before the throw
    // (audit semantics), which is fine — it just records "a resume was
    // attempted against a run that has no creation event".
    await expect(
      resume({ log, runId: RUN_ID, daemonId: 'd-1', reconcilers: emptyReconcilers() }),
    ).rejects.toThrow(/first event must be runCreated/);
  });

  it('rejects runId mismatch between ctx and log', async () => {
    await bootstrapWith();
    await expect(
      resume({ log, runId: 'wrong-run-id', daemonId: 'd-1', reconcilers: emptyReconcilers() }),
    ).rejects.toThrow(/does not match log.runId/);
  });
});

// ─── No dangling state → resume is a no-op (only resumeStarted) ─────────────

describe('resume — terminal-state runs', () => {
  it('writes no terminal events when there are no dangling activities', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      {
        runId: RUN_ID,
        type: 'activitySucceeded',
        actor: 'worker',
        payload: {
          activityId: 'a-1',
          attemptId: 'at-1',
          outputRef: sampleOutputRef,
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.reconcileOutcomes).toEqual([]);
    expect(r.workerCrashedOutcomes).toEqual([]);
  });
});

// ─── Dangling activity, NO effectAttempted → WorkerCrashed ─────────────────

describe('resume — worker-crashed path (pure-skill dangling)', () => {
  it('writes activityFailed{WorkerCrashed, retryable} for pure-skill dangling', async () => {
    await bootstrapWith(attemptCreated('a-pure', 'at-1'));
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.workerCrashedOutcomes).toHaveLength(1);
    const w = r.workerCrashedOutcomes[0];
    expect(w.activityId).toBe('a-pure');
    expect(w.attemptId).toBe('at-1');
    expect(w.terminalEvent.type).toBe('activityFailed');
    const p = w.terminalEvent.payload as { error: { errorCode: string; errorClass: string } };
    expect(p.error.errorCode).toBe('WorkerCrashed');
    expect(p.error.errorClass).toBe('retryable');
  });

  it('leaves dangling waits alone (human-gate)', async () => {
    await bootstrapWith(
      attemptCreated('a-wait', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: {
          activityId: 'a-wait',
          nodeId: 'n-1',
          waitKind: 'human-gate',
          prompt: 'approve?',
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.workerCrashedOutcomes).toEqual([]);
    expect(r.reconcileOutcomes).toEqual([]);
  });
});

// ─── Decision: manual (TTL expired) ────────────────────────────────────────

describe('resume — manual decision (TTL expired)', () => {
  it('writes manual/TtlExpired when (now - attemptedAtMs) > ttl', async () => {
    const longAgo = 1_000_000;
    const ttl = 60_000; // 60s
    const now = longAgo + ttl + 1;
    await bootstrapWith(
      attemptCreated('a-feishu', 'at-1'),
      effectAttempted('a-feishu', 'at-1', 'feishu-im', 'wf_xxx', longAgo, ttl),
    );
    // Reconciler with idempotentSubmit that would succeed — we should
    // never call it because TTL boundary fires first.
    let called = false;
    const reconciler: ProviderReconciler = {
      provider: 'feishu-im',
      async idempotentSubmit() {
        called = true;
        return { ok: true, externalRefs: { messageId: 'om_xxx' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', reconciler]]),
      now: () => now,
    });
    expect(called).toBe(false);
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    expect(o.capability).toBe('none');
    expect(o.terminalEvent?.type).toBe('activityFailed');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string; errorClass: string } };
    expect(ep.error.errorCode).toBe('TtlExpired');
    expect(ep.error.errorClass).toBe('manual');
    expect(o.evidence).toMatchObject({ reason: 'ttl_expired' });
  });

  it('writes manual/UnknownProviderError when no reconciler is registered', async () => {
    await bootstrapWith(
      attemptCreated('a-x', 'at-1'),
      effectAttempted('a-x', 'at-1', 'mystery-provider', 'wf_y'),
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    expect(o.capability).toBe('none');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string } };
    expect(ep.error.errorCode).toBe('UnknownProviderError');
  });
});

// ─── Decision: completedByIdempotentSubmit (readOnlyLookup found) ──────────

describe('resume — completedByIdempotentSubmit via readOnlyLookup', () => {
  it('writes activitySucceeded when readOnlyLookup finds the effect', async () => {
    await bootstrapWith(
      attemptCreated('a-sched', 'at-1'),
      effectAttempted('a-sched', 'at-1', 'botmux-schedule', 'wf_abc', 1, Number.MAX_SAFE_INTEGER),
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup(key) {
        expect(key).toBe('wf_abc');
        return { found: true, externalRefs: { taskId: 'wf_abc' }, evidence: { source: 'getTask' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
      now: () => 1000, // arbitrary; ttl is effectively infinite
    });
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('completedByIdempotentSubmit');
    expect(o.capability).toBe('readOnlyLookup');
    expect(o.terminalEvent?.type).toBe('activitySucceeded');
    const sp = o.terminalEvent!.payload as { externalRefs: { taskId: string } };
    expect(sp.externalRefs).toEqual({ taskId: 'wf_abc' });
  });
});

// ─── Decision: completedByIdempotentSubmit (idempotentSubmit success) ──────

describe('resume — completedByIdempotentSubmit via idempotentSubmit', () => {
  it('writes activitySucceeded when feishu re-submit returns the original ref', async () => {
    await bootstrapWith(
      attemptCreated('a-feishu', 'at-1'),
      effectAttempted('a-feishu', 'at-1', 'feishu-im', 'wf_abc', 1000, PROVIDER_TTL_MS['feishu-im']),
    );
    const reconciler: ProviderReconciler = {
      provider: 'feishu-im',
      async idempotentSubmit(key) {
        expect(key).toBe('wf_abc');
        return { ok: true, externalRefs: { messageId: 'om_xxx' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', reconciler]]),
      now: () => 1001, // still inside TTL
    });
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('completedByIdempotentSubmit');
    expect(o.capability).toBe('idempotentSubmit');
    const sp = o.terminalEvent!.payload as { externalRefs: { messageId: string } };
    expect(sp.externalRefs).toEqual({ messageId: 'om_xxx' });
  });

  it('falls back to manual when idempotentSubmit errors', async () => {
    await bootstrapWith(
      attemptCreated('a-feishu', 'at-1'),
      effectAttempted('a-feishu', 'at-1', 'feishu-im', 'wf_abc', 1000, PROVIDER_TTL_MS['feishu-im']),
    );
    const reconciler: ProviderReconciler = {
      provider: 'feishu-im',
      async idempotentSubmit() {
        return {
          ok: false,
          errorCode: 'NetworkError',
          errorClass: 'retryable',
          errorMessage: 'connection refused',
        };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', reconciler]]),
      now: () => 1001,
    });
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    expect(o.capability).toBe('idempotentSubmit');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string; errorClass: string } };
    expect(ep.error.errorCode).toBe('NetworkError');
    expect(ep.error.errorClass).toBe('manual'); // resume escalates retryable→manual
  });
});

// ─── Decision: freshRetry (readOnlyLookup not-found) ───────────────────────

describe('resume — freshRetry decision', () => {
  it('writes reconcileResult{freshRetry} with NO terminal event', async () => {
    await bootstrapWith(
      attemptCreated('a-sched', 'at-1'),
      effectAttempted('a-sched', 'at-1', 'botmux-schedule', 'wf_zzz', 1, Number.MAX_SAFE_INTEGER),
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        return { found: false, evidence: { source: 'getTask', returned: 'undefined' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('freshRetry');
    expect(o.capability).toBe('readOnlyLookup');
    expect(o.terminalEvent).toBeNull();
    // The activity should NOT have an activitySucceeded/Failed yet — it
    // should still appear as dangling on a follow-up replay.
    const events = await log.readAll();
    const terminals = events.filter(
      (e) =>
        (e.type === 'activitySucceeded' || e.type === 'activityFailed') &&
        (e.payload as { activityId: string }).activityId === 'a-sched',
    );
    expect(terminals).toEqual([]);
  });
});

// ─── No-capability reconciler → manual ──────────────────────────────────────

describe('resume — reconciler with no capability', () => {
  it('falls to manual/UnknownProviderError when reconciler exposes nothing', async () => {
    await bootstrapWith(
      attemptCreated('a-stub', 'at-1'),
      effectAttempted('a-stub', 'at-1', 'stub-provider', 'wf_y'),
    );
    const reconciler: ProviderReconciler = {
      provider: 'stub-provider',
      // No readOnlyLookup, no idempotentSubmit
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['stub-provider', reconciler]]),
    });
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    expect(o.capability).toBe('none');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string } };
    expect(ep.error.errorCode).toBe('UnknownProviderError');
  });
});

// ─── Multiple dangling — independence ──────────────────────────────────────

describe('resume — multiple dangling activities', () => {
  it('reconciles each dangling effectAttempted independently and writes worker-crashed for the others', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1', 'n-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_1', 1, Number.MAX_SAFE_INTEGER),
      attemptCreated('a-2', 'at-2', 'n-2'),
      // a-2 is pure-skill: no effectAttempted, no waitCreated → worker-crashed
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        return { found: true, externalRefs: { taskId: 'wf_1' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    expect(r.reconcileOutcomes).toHaveLength(1);
    expect(r.reconcileOutcomes[0].activityId).toBe('a-1');
    expect(r.reconcileOutcomes[0].decision).toBe('completedByIdempotentSubmit');
    expect(r.workerCrashedOutcomes).toHaveLength(1);
    expect(r.workerCrashedOutcomes[0].activityId).toBe('a-2');
  });
});

// ─── Re-running resume is idempotent at the snapshot level ─────────────────

describe('resume — second resume after a successful first resume', () => {
  it('does not re-reconcile already-terminal activities', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_x', 1, Number.MAX_SAFE_INTEGER),
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        return { found: true, externalRefs: { taskId: 'wf_x' } };
      },
    };
    const first = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    expect(first.reconcileOutcomes).toHaveLength(1);

    let secondLookupCalled = false;
    const reconciler2: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        secondLookupCalled = true;
        return { found: true, externalRefs: { taskId: 'wf_x' } };
      },
    };
    const second = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler2]]),
    });
    // a-1 has activitySucceeded after first resume — it's not dangling anymore.
    expect(secondLookupCalled).toBe(false);
    expect(second.reconcileOutcomes).toEqual([]);
    expect(second.workerCrashedOutcomes).toEqual([]);
  });
});

// ─── Event ordering: reconcileResult before terminal ───────────────────────

describe('resume — event order', () => {
  it('writes reconcileResult before the terminal event for that activity', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_x', 1, Number.MAX_SAFE_INTEGER),
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        return { found: true, externalRefs: { taskId: 'wf_x' } };
      },
    };
    await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    const events = await log.readAll();
    const types = events.map((e) => e.type);
    const reconcileIdx = types.lastIndexOf('reconcileResult');
    const terminalIdx = types.lastIndexOf('activitySucceeded');
    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeGreaterThan(reconcileIdx);
  });

  it('writes resumeStarted before any reconcileResult', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_x', 1, Number.MAX_SAFE_INTEGER),
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        return { found: true, externalRefs: { taskId: 'wf_x' } };
      },
    };
    await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    const events = await log.readAll();
    const types = events.map((e) => e.type);
    const resumeIdx = types.indexOf('resumeStarted');
    const reconcileIdx = types.indexOf('reconcileResult');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(resumeIdx);
  });
});
