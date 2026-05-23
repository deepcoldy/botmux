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
  inputHash?: string,
): EventDraft {
  return {
    runId: RUN_ID,
    type: 'effectAttempted',
    actor: 'hostExecutor',
    payload: {
      activityId,
      attemptId,
      idempotencyKey,
      inputHash: inputHash ?? 'sha256:' + 'd'.repeat(64),
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

  it('rejects resume against an empty log (preflight, no events written)', async () => {
    // Round 1 F4: preflight rejects bad inputs BEFORE writing
    // resumeStarted, so the run event log is never polluted by a
    // failed resume attempt.
    await expect(
      resume({ log, runId: RUN_ID, daemonId: 'd-1', reconcilers: emptyReconcilers() }),
    ).rejects.toThrow(/cannot resume an empty event log/);
    const events = await log.readAll();
    expect(events).toEqual([]);
  });

  it('rejects resume when the first event is not runCreated (preflight)', async () => {
    // Forge a log starting with runStarted by appending it as if
    // someone had pre-seeded the file.  EventLog.append rejects this
    // path so we have to bypass it with direct file write.
    await log.append({
      runId: RUN_ID,
      type: 'runCreated',
      actor: 'scheduler',
      payload: {
        workflowId: 'wf-demo',
        revisionId: 'rev-001',
        inputRef: sampleOutputRef,
        initiator: 'tester',
      },
    });
    // Drop the runCreated line so the first event is something else.
    // Direct fs write to simulate corruption:
    const { promises: fs } = await import('node:fs');
    const path = log.eventsFile;
    const content = await fs.readFile(path, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const obj = JSON.parse(lines[0]);
    obj.type = 'runStarted';
    obj.payload = {};
    await fs.writeFile(path, JSON.stringify(obj) + '\n', 'utf-8');

    await expect(
      resume({ log, runId: RUN_ID, daemonId: 'd-1', reconcilers: emptyReconcilers() }),
    ).rejects.toThrow(/first event must be runCreated/);
    const events = await log.readAll();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('runStarted');
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

  it('keeps the activity dangling when idempotentSubmit returns retryable (F3)', async () => {
    // Round 1 F3: retryable failure must NOT terminate the attempt.
    // The provider may have received the request and dropped the
    // response; writing manual terminal would freeze a wrong state.
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
    expect(r.reconcileOutcomes).toEqual([]);
    expect(r.transientFailures).toHaveLength(1);
    const t = r.transientFailures[0];
    expect(t.activityId).toBe('a-feishu');
    expect(t.errorCode).toBe('NetworkError');
    expect(t.errorClass).toBe('retryable');
    // No terminal in the event log — activity stays dangling for the
    // next resume to retry.
    const events = await log.readAll();
    const terminals = events.filter(
      (e) =>
        (e.type === 'activitySucceeded' || e.type === 'activityFailed') &&
        (e.payload as { activityId: string }).activityId === 'a-feishu',
    );
    expect(terminals).toEqual([]);
    // No reconcileResult written either — preserves the option to
    // retry the decision tree from scratch next cycle.
    const reconciles = events.filter((e) => e.type === 'reconcileResult');
    expect(reconciles).toEqual([]);
  });

  it('still writes manual terminal when idempotentSubmit returns fatal/userFault', async () => {
    await bootstrapWith(
      attemptCreated('a-feishu', 'at-1'),
      effectAttempted('a-feishu', 'at-1', 'feishu-im', 'wf_abc', 1000, PROVIDER_TTL_MS['feishu-im']),
    );
    const reconciler: ProviderReconciler = {
      provider: 'feishu-im',
      async idempotentSubmit() {
        return {
          ok: false,
          errorCode: 'IdempotencyInputMismatch',
          errorClass: 'fatal',
          errorMessage: 'inputHash mismatch on retry',
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
    expect(r.transientFailures).toEqual([]);
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    expect(o.capability).toBe('idempotentSubmit');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string; errorClass: string } };
    expect(ep.error.errorCode).toBe('IdempotencyInputMismatch');
    expect(ep.error.errorClass).toBe('manual');
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

// ─── F1 recovery — reconcileResult written, terminal missing ───────────────

describe('resume — F1: crash between reconcileResult and terminal', () => {
  it('completedByIdempotentSubmit reuses recorded evidence; provider is NOT called', async () => {
    // Simulate: first resume crashed AFTER writing reconcileResult but
    // BEFORE writing activitySucceeded.  Second resume must finish the
    // job from the recorded evidence, not by re-querying the provider.
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_x', 1, Number.MAX_SAFE_INTEGER),
      // Manually written reconcileResult — simulates the first resume's
      // half-completed work surviving the crash.
      {
        runId: RUN_ID,
        type: 'reconcileResult',
        actor: 'system',
        payload: {
          activityId: 'a-1',
          idempotencyKey: 'wf_x',
          capability: 'readOnlyLookup',
          decision: 'completedByIdempotentSubmit',
          evidence: { source: 'getTask', externalRefs: { taskId: 'wf_x' } },
        },
      },
    );
    let providerCalled = false;
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        providerCalled = true;
        return { found: true, externalRefs: { taskId: 'wf_x' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    expect(providerCalled).toBe(false);
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.recovered).toBe(true);
    expect(o.decision).toBe('completedByIdempotentSubmit');
    expect(o.terminalEvent?.type).toBe('activitySucceeded');
    expect(o.reconcileEvent).toBeNull(); // recovery does NOT write a new reconcileResult
    const sp = o.terminalEvent!.payload as { externalRefs: { taskId: string } };
    expect(sp.externalRefs).toEqual({ taskId: 'wf_x' });
  });

  it('manual recovery writes activityFailed using the recorded errorCode', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'feishu-im', 'wf_y', 1000, PROVIDER_TTL_MS['feishu-im']),
      {
        runId: RUN_ID,
        type: 'reconcileResult',
        actor: 'system',
        payload: {
          activityId: 'a-1',
          idempotencyKey: 'wf_y',
          capability: 'idempotentSubmit',
          decision: 'manual',
          evidence: { reason: 'no_capability', errorCode: 'IdempotencyInputMismatch' },
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
      now: () => 1001,
    });
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.recovered).toBe(true);
    expect(o.decision).toBe('manual');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string; errorClass: string } };
    expect(ep.error.errorCode).toBe('IdempotencyInputMismatch');
    expect(ep.error.errorClass).toBe('manual');
  });

  it('freshRetry recovery returns the recorded decision; writes no terminal', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_z', 1, Number.MAX_SAFE_INTEGER),
      {
        runId: RUN_ID,
        type: 'reconcileResult',
        actor: 'system',
        payload: {
          activityId: 'a-1',
          idempotencyKey: 'wf_z',
          capability: 'readOnlyLookup',
          decision: 'freshRetry',
          evidence: { source: 'getTask', returned: 'undefined' },
        },
      },
    );
    let providerCalled = false;
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        providerCalled = true;
        return { found: true, externalRefs: { taskId: 'wf_z' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    expect(providerCalled).toBe(false);
    const o = r.reconcileOutcomes[0];
    expect(o.recovered).toBe(true);
    expect(o.decision).toBe('freshRetry');
    expect(o.terminalEvent).toBeNull();
  });

  it('TTL boundary does NOT override a recorded completedByIdempotentSubmit', async () => {
    // The strongest correctness test for F1: even if TTL has now
    // expired, recovery from a prior "completed" decision still
    // succeeds — because the first resume already proved the effect
    // landed, the TTL boundary is moot.
    const longAgo = 1000;
    const ttl = 60_000;
    const farFuture = longAgo + ttl + 1_000_000;
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'feishu-im', 'wf_late', longAgo, ttl),
      {
        runId: RUN_ID,
        type: 'reconcileResult',
        actor: 'system',
        payload: {
          activityId: 'a-1',
          idempotencyKey: 'wf_late',
          capability: 'idempotentSubmit',
          decision: 'completedByIdempotentSubmit',
          evidence: { externalRefs: { messageId: 'om_late' } },
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map(), // no reconciler — recovery shouldn't need one
      now: () => farFuture,
    });
    const o = r.reconcileOutcomes[0];
    expect(o.recovered).toBe(true);
    expect(o.decision).toBe('completedByIdempotentSubmit');
    const sp = o.terminalEvent!.payload as { externalRefs: { messageId: string } };
    expect(sp.externalRefs).toEqual({ messageId: 'om_late' });
  });

  it('completedByIdempotentSubmit without evidence.externalRefs → CorruptLog/manual (codex round 2 blocker)', async () => {
    // Strict validation: a reconcileResult{decision=completedByIdempotentSubmit}
    // whose evidence has no externalRefs is corruption (someone wrote a
    // partial event).  Recovery MUST NOT fabricate an activitySucceeded
    // with `{}` externalRefs — that would convert log corruption into a
    // fake success.
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'feishu-im', 'wf_corrupt', 1000, PROVIDER_TTL_MS['feishu-im']),
      {
        runId: RUN_ID,
        type: 'reconcileResult',
        actor: 'system',
        payload: {
          activityId: 'a-1',
          idempotencyKey: 'wf_corrupt',
          capability: 'idempotentSubmit',
          decision: 'completedByIdempotentSubmit',
          evidence: { reason: 'missing on purpose' }, // NO externalRefs
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map(),
      now: () => 1001,
    });
    const o = r.reconcileOutcomes[0];
    expect(o.recovered).toBe(true);
    expect(o.decision).toBe('manual'); // escalated from completedByIdempotentSubmit
    expect(o.terminalEvent?.type).toBe('activityFailed');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string; errorMessage: string } };
    expect(ep.error.errorCode).toBe('CorruptLog');
    expect(ep.error.errorMessage).toMatch(/externalRefs/);
    expect(o.evidence).toMatchObject({
      corruptReason: 'missing_external_refs',
      originalDecision: 'completedByIdempotentSubmit',
    });
    // No activitySucceeded landed in the log.
    const events = await log.readAll();
    const succeeded = events.filter((e) => e.type === 'activitySucceeded');
    expect(succeeded).toEqual([]);
  });

  it('completedByIdempotentSubmit where evidence.externalRefs is not an object → CorruptLog', async () => {
    // Same blocker, different malformed shape: externalRefs is a
    // string/number/array instead of an object.  Recovery still refuses.
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'feishu-im', 'wf_bad_shape', 1000, PROVIDER_TTL_MS['feishu-im']),
      {
        runId: RUN_ID,
        type: 'reconcileResult',
        actor: 'system',
        payload: {
          activityId: 'a-1',
          idempotencyKey: 'wf_bad_shape',
          capability: 'idempotentSubmit',
          decision: 'completedByIdempotentSubmit',
          evidence: { externalRefs: ['not', 'an', 'object'] },
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map(),
      now: () => 1001,
    });
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string } };
    expect(ep.error.errorCode).toBe('CorruptLog');
  });

  it('replayed fallback includes reconcileEventId in evidence (codex round 2 suggestion)', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_replayed', 1, Number.MAX_SAFE_INTEGER),
      {
        runId: RUN_ID,
        type: 'reconcileResult',
        actor: 'system',
        payload: {
          activityId: 'a-1',
          idempotencyKey: 'wf_replayed',
          capability: 'none',
          decision: 'replayed',
          evidence: { source: 'first-resume' },
        },
      },
    );
    // Find the reconcileResult event so we know its expected eventId.
    const eventsBefore = await log.readAll();
    const recEvent = eventsBefore.find((e) => e.type === 'reconcileResult');
    expect(recEvent).toBeDefined();
    const expectedEventId = recEvent!.eventId;

    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map(),
    });
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    expect(o.evidence).toMatchObject({
      originalDecision: 'replayed',
      reconcileEventId: expectedEventId,
    });
  });
});

// ─── F2 — reconciler input passthrough ─────────────────────────────────────

describe('resume — F2: loadEffectInput + reconciler API takes input', () => {
  it('passes the loaded input to readOnlyLookup', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_q', 1, Number.MAX_SAFE_INTEGER),
    );
    let lookupInput: unknown = null;
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup(_key, input) {
        lookupInput = input;
        return { found: true, externalRefs: { taskId: 'wf_q' } };
      },
    };
    await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
      async loadEffectInput(activityId, attemptId) {
        expect(activityId).toBe('a-1');
        expect(attemptId).toBe('at-1');
        return { schedule: '30m', prompt: 'hi' };
      },
    });
    expect(lookupInput).toEqual({ schedule: '30m', prompt: 'hi' });
  });

  it('passes the loaded input to idempotentSubmit', async () => {
    const loaded = { chatId: 'oc_abc', content: 'hi' };
    // Hash guard added in inputHash slice: provide canonicalInput on the
    // reconciler AND seed effectAttempted with the matching hash so the
    // guard lets the call through.  Identity canonical = literal input.
    const { computeInputHash } = await import('../src/workflows/events/idempotency.js');
    const matchingHash = computeInputHash(loaded);
    await bootstrapWith(
      attemptCreated('a-feishu', 'at-1'),
      effectAttempted(
        'a-feishu',
        'at-1',
        'feishu-im',
        'wf_p',
        1000,
        PROVIDER_TTL_MS['feishu-im'],
        matchingHash,
      ),
    );
    let submitInput: unknown = null;
    const reconciler: ProviderReconciler = {
      provider: 'feishu-im',
      requiresEffectInput: true,
      canonicalInput(input) { return input; },
      async idempotentSubmit(_key, input) {
        submitInput = input;
        return { ok: true, externalRefs: { messageId: 'om_p' } };
      },
    };
    await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', reconciler]]),
      now: () => 1001,
      async loadEffectInput() {
        return loaded;
      },
    });
    expect(submitInput).toEqual(loaded);
  });

  it('writes manual/InputUnrecoverable when requiresEffectInput=true and no loader', async () => {
    await bootstrapWith(
      attemptCreated('a-feishu', 'at-1'),
      effectAttempted('a-feishu', 'at-1', 'feishu-im', 'wf_p', 1000, PROVIDER_TTL_MS['feishu-im']),
    );
    let submitCalled = false;
    const reconciler: ProviderReconciler = {
      provider: 'feishu-im',
      requiresEffectInput: true,
      async idempotentSubmit() {
        submitCalled = true;
        return { ok: true, externalRefs: { messageId: 'om_p' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', reconciler]]),
      now: () => 1001,
      // No loadEffectInput
    });
    expect(submitCalled).toBe(false);
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string } };
    expect(ep.error.errorCode).toBe('InputUnrecoverable');
  });

  it('writes manual/InputUnrecoverable when loadEffectInput throws', async () => {
    await bootstrapWith(
      attemptCreated('a-feishu', 'at-1'),
      effectAttempted('a-feishu', 'at-1', 'feishu-im', 'wf_p', 1000, PROVIDER_TTL_MS['feishu-im']),
    );
    const reconciler: ProviderReconciler = {
      provider: 'feishu-im',
      requiresEffectInput: true,
      async idempotentSubmit() {
        return { ok: true, externalRefs: {} };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', reconciler]]),
      now: () => 1001,
      async loadEffectInput() {
        throw new Error('storage offline');
      },
    });
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    const ep = o.terminalEvent!.payload as { error: { errorCode: string; errorMessage: string } };
    expect(ep.error.errorCode).toBe('InputUnrecoverable');
    expect(ep.error.errorMessage).toMatch(/storage offline/);
  });

  it('passes undefined input to reconcilers that do NOT require it', async () => {
    await bootstrapWith(
      attemptCreated('a-sched', 'at-1'),
      effectAttempted('a-sched', 'at-1', 'botmux-schedule', 'wf_q', 1, Number.MAX_SAFE_INTEGER),
    );
    let lookupInput: unknown = 'not-touched';
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      // requiresEffectInput unset → optional
      async readOnlyLookup(_key, input) {
        lookupInput = input;
        return { found: true, externalRefs: { taskId: 'wf_q' } };
      },
    };
    await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
      // No loadEffectInput
    });
    expect(lookupInput).toBeUndefined();
  });
});

// ─── Step 8: wait recovery integration ─────────────────────────────────────

describe('resume — Step 8: dangling wait resolutions', () => {
  it('approved resolution → activitySucceeded recovery', async () => {
    await bootstrapWith(
      attemptCreated('a-wait', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a-wait', nodeId: 'n-1', waitKind: 'human-gate' },
      },
      {
        runId: RUN_ID,
        type: 'waitResolved',
        actor: 'human',
        payload: { activityId: 'a-wait', resolution: 'approved', by: 'ou_alice' },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.waitRecoveryOutcomes).toHaveLength(1);
    const w = r.waitRecoveryOutcomes[0];
    expect(w.activityId).toBe('a-wait');
    expect(w.kind).toBe('succeeded');
    expect(w.source).toBe('resolved');
    const p = w.terminalEvent.payload as { externalRefs: { resolution: string; by: string } };
    expect(p.externalRefs).toMatchObject({ resolution: 'approved', by: 'ou_alice' });
  });

  it('rejected resolution → activityFailed/userFault recovery', async () => {
    await bootstrapWith(
      attemptCreated('a-wait', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a-wait', nodeId: 'n-1', waitKind: 'human-gate' },
      },
      {
        runId: RUN_ID,
        type: 'waitResolved',
        actor: 'human',
        payload: {
          activityId: 'a-wait',
          resolution: 'rejected',
          by: 'ou_alice',
          comment: 'nope',
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    const w = r.waitRecoveryOutcomes[0];
    expect(w.kind).toBe('failed');
    const p = w.terminalEvent.payload as { error: { errorCode: string; errorClass: string; errorMessage: string } };
    expect(p.error.errorCode).toBe('InputValidationFailed');
    expect(p.error.errorClass).toBe('userFault');
    expect(p.error.errorMessage).toMatch(/rejected by ou_alice/);
    expect(p.error.errorMessage).toMatch(/nope/);
  });

  it('deadlineExceeded + onTimeout=fail (default) → activityFailed{WaitDeadlineExceeded}', async () => {
    await bootstrapWith(
      attemptCreated('a-wait', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: {
          activityId: 'a-wait',
          nodeId: 'n-1',
          waitKind: 'time',
          deadlineAt: 1_000_000,
        },
      },
      {
        runId: RUN_ID,
        type: 'waitDeadlineExceeded',
        actor: 'scheduler',
        payload: {
          activityId: 'a-wait',
          deadlineAt: 1_000_000,
          exceededAtMs: 1_000_010,
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    const w = r.waitRecoveryOutcomes[0];
    expect(w.kind).toBe('failed');
    expect(w.source).toBe('deadlineExceeded');
    const p = w.terminalEvent.payload as { error: { errorCode: string } };
    expect(p.error.errorCode).toBe('WaitDeadlineExceeded');
  });

  it('deadlineExceeded + onTimeout=success → activitySucceeded{defaultedToTimeout}', async () => {
    await bootstrapWith(
      attemptCreated('a-wait', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: {
          activityId: 'a-wait',
          nodeId: 'n-1',
          waitKind: 'time',
          deadlineAt: 1_000_000,
          onTimeout: 'success',
        },
      },
      {
        runId: RUN_ID,
        type: 'waitDeadlineExceeded',
        actor: 'scheduler',
        payload: {
          activityId: 'a-wait',
          deadlineAt: 1_000_000,
          exceededAtMs: 1_000_010,
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    const w = r.waitRecoveryOutcomes[0];
    expect(w.kind).toBe('succeeded');
    const p = w.terminalEvent.payload as { externalRefs: { defaultedToTimeout: boolean } };
    expect(p.externalRefs.defaultedToTimeout).toBe(true);
  });

  it('wait recovery does NOT trigger WorkerCrashed path', async () => {
    await bootstrapWith(
      attemptCreated('a-wait', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a-wait', nodeId: 'n-1', waitKind: 'human-gate' },
      },
      {
        runId: RUN_ID,
        type: 'waitResolved',
        actor: 'human',
        payload: { activityId: 'a-wait', resolution: 'approved', by: 'x' },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.workerCrashedOutcomes).toEqual([]);
    expect(r.waitRecoveryOutcomes).toHaveLength(1);
  });

  it('still-open wait (no resolution) stays dangling, no recovery', async () => {
    await bootstrapWith(
      attemptCreated('a-wait', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a-wait', nodeId: 'n-1', waitKind: 'human-gate' },
      },
      // No resolution.
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.waitRecoveryOutcomes).toEqual([]);
    expect(r.workerCrashedOutcomes).toEqual([]);
    const events = await log.readAll();
    const terminals = events.filter(
      (e) => e.type === 'activitySucceeded' || e.type === 'activityFailed',
    );
    expect(terminals).toEqual([]);
  });

  it('second resume after wait recovery does nothing', async () => {
    await bootstrapWith(
      attemptCreated('a-wait', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a-wait', nodeId: 'n-1', waitKind: 'human-gate' },
      },
      {
        runId: RUN_ID,
        type: 'waitResolved',
        actor: 'human',
        payload: { activityId: 'a-wait', resolution: 'approved', by: 'x' },
      },
    );
    const first = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(first.waitRecoveryOutcomes).toHaveLength(1);
    const second = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(second.waitRecoveryOutcomes).toEqual([]);
  });
});

// ─── Step 9: cancel recovery ────────────────────────────────────────────────

describe('resume — Step 9: dangling cancel recovery', () => {
  it('cancelRequested + no terminal → activityCanceled recovery', async () => {
    await bootstrapWith(
      attemptCreated('a-cancel', 'at-1'),
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'activity', activityId: 'a-cancel' },
          reason: 'user stop',
          by: 'ou_alice',
        },
      },
    );
    const events = await log.readAll();
    const cancelReq = events.find((e) => e.type === 'cancelRequested')!;

    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.cancelRecoveryOutcomes).toHaveLength(1);
    const c = r.cancelRecoveryOutcomes[0];
    expect(c.activityId).toBe('a-cancel');
    expect(c.delivered).toBe(false);
    expect(c.cancelOriginEventId).toBe(cancelReq.eventId);
    expect(c.terminalEvent.type).toBe('activityCanceled');
    const p = c.terminalEvent.payload as { cancelOriginEventId: string };
    expect(p.cancelOriginEventId).toBe(cancelReq.eventId);
    expect(r.workerCrashedOutcomes).toEqual([]);
  });

  it('cancelRequested + cancelDelivered + no terminal → activityCanceled + delivered=true', async () => {
    await bootstrapWith(
      attemptCreated('a-cancel', 'at-1'),
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'activity', activityId: 'a-cancel' },
          reason: 'r',
          by: 'b',
        },
      },
      {
        runId: RUN_ID,
        type: 'cancelDelivered',
        actor: 'worker',
        payload: {
          target: { kind: 'activity', activityId: 'a-cancel' },
          activityId: 'a-cancel',
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.cancelRecoveryOutcomes[0].delivered).toBe(true);
  });

  it('cancel + effectAttempted: reconciles FIRST (captures evidence), then writes activityCanceled (codex Step 9 round 1 finding 1)', async () => {
    // New Step 9 semantics: when an activity has BOTH a dangling
    // effectAttempted AND a cancelRequested, resume MUST run reconcile
    // first so the provider's actual state is recorded in
    // reconcileResult.evidence — even though the terminal will be
    // `activityCanceled` (cancel wins as terminal reason).  Skipping
    // reconcile loses the audit of whether the side effect happened.
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_x', 1, Number.MAX_SAFE_INTEGER),
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'activity', activityId: 'a-1' },
          reason: 'preempt',
          by: 'ou_a',
        },
      },
    );
    let providerCalled = false;
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        providerCalled = true;
        return { found: true, externalRefs: { taskId: 'wf_x' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    // Provider WAS called — evidence capture is mandatory for cancel + effect.
    expect(providerCalled).toBe(true);
    expect(r.cancelRecoveryOutcomes).toHaveLength(1);
    const c = r.cancelRecoveryOutcomes[0];
    // Terminal is `activityCanceled` (cancel wins), not activitySucceeded.
    expect(c.kind).toBe('cancelled');
    expect(c.terminalEvent.type).toBe('activityCanceled');
    // Evidence was preserved in the reconcileResult written alongside.
    expect(c.reconcileEvent?.type).toBe('reconcileResult');
    expect(c.reconcileDecision).toBe('completedByIdempotentSubmit');
    // The reconcile branch produces NO ReconcileOutcome — cancel branch
    // owns the activity entirely.
    expect(r.reconcileOutcomes).toEqual([]);
    // Reconcile evidence carries the provider's externalRefs for forensics.
    const ep = c.reconcileEvent?.payload as {
      evidence: {
        externalRefs?: unknown;
        cancelOriginEventId?: string;
        cancelReason?: string;
        cancelRequestedBy?: string;
      };
    };
    expect(ep.evidence.externalRefs).toEqual({ taskId: 'wf_x' });
    // Codex Step 9 round 2 finding 1: cancel chain is preserved
    // STRUCTURALLY on reconcileResult.evidence so dashboards / forensics
    // can correlate cancel × reconcile without parsing errorMessage.
    expect(ep.evidence.cancelOriginEventId).toBe(c.cancelOriginEventId);
    expect(ep.evidence.cancelReason).toBe('preempt');
    expect(ep.evidence.cancelRequestedBy).toBe('ou_a');
  });

  it('cancel + effect with readOnlyLookup found=false → freshRetry evidence + activityCanceled', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_x', 1, Number.MAX_SAFE_INTEGER),
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'activity', activityId: 'a-1' },
          reason: 'preempt',
          by: 'b',
        },
      },
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        return { found: false };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    expect(r.cancelRecoveryOutcomes).toHaveLength(1);
    const c = r.cancelRecoveryOutcomes[0];
    expect(c.kind).toBe('cancelled');
    expect(c.terminalEvent.type).toBe('activityCanceled');
    expect(c.reconcileDecision).toBe('freshRetry');
    // Cancel chain preserved on the reconcileResult evidence.
    const ep = c.reconcileEvent?.payload as {
      evidence: { cancelOriginEventId?: string };
    };
    expect(ep.evidence.cancelOriginEventId).toBe(c.cancelOriginEventId);
  });

  it('cancel + effect with TTL expired → manual evidence + activityFailed{manual} (NOT activityCanceled)', async () => {
    // When reconcile reports manual (e.g. TTL expired, provider state unknown),
    // writing activityCanceled would fabricate a clean cancel terminal we
    // can't substantiate.  Step 9 escalates to activityFailed{manual}.
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_x', 1, 1), // ttl=1ms
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'activity', activityId: 'a-1' },
          reason: 'preempt',
          by: 'b',
        },
      },
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        return { found: true, externalRefs: { taskId: 'wf_x' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
      now: () => Number.MAX_SAFE_INTEGER, // TTL definitely expired
    });
    expect(r.cancelRecoveryOutcomes).toHaveLength(1);
    const c = r.cancelRecoveryOutcomes[0];
    expect(c.kind).toBe('failed');
    expect(c.terminalEvent.type).toBe('activityFailed');
    expect(c.reconcileDecision).toBe('manual');
    const tp = c.terminalEvent.payload as { error: { errorCode: string; errorClass: string } };
    expect(tp.error.errorCode).toBe('TtlExpired');
    expect(tp.error.errorClass).toBe('manual');
    // Codex Step 9 round 2 finding 1: cancel chain is preserved
    // structurally on reconcileResult.evidence (TTL+cancel is the key
    // case where errorMessage parsing would otherwise be required).
    const ep = c.reconcileEvent?.payload as {
      evidence: {
        cancelOriginEventId?: string;
        cancelReason?: string;
        cancelRequestedBy?: string;
        reason?: string;
      };
    };
    expect(ep.evidence.cancelOriginEventId).toBe(c.cancelOriginEventId);
    expect(ep.evidence.cancelReason).toBe('preempt');
    expect(ep.evidence.cancelRequestedBy).toBe('b');
    // TTL-specific keys are still present alongside cancel keys.
    expect(ep.evidence.reason).toBe('ttl_expired');
  });

  it('cancel + effect with transient retryable failure → activity stays dangling, transientFailure surfaced', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'feishu-im', 'fhash', 1, Number.MAX_SAFE_INTEGER),
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'activity', activityId: 'a-1' },
          reason: 'preempt',
          by: 'b',
        },
      },
    );
    const reconciler: ProviderReconciler = {
      provider: 'feishu-im',
      requiresEffectInput: false,
      async idempotentSubmit() {
        return {
          ok: false as const,
          errorCode: 'NetworkError',
          errorClass: 'retryable' as const,
          errorMessage: 'temporary network blip',
        };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', reconciler]]),
    });
    expect(r.cancelRecoveryOutcomes).toEqual([]);
    expect(r.transientFailures).toHaveLength(1);
    expect(r.transientFailures[0].activityId).toBe('a-1');
    // No terminal events written for the cancel-pending activity.
    const events = await log.readAll();
    const aTerm = events.find(
      (e) =>
        (e.type === 'activityCanceled' || e.type === 'activityFailed' || e.type === 'activitySucceeded') &&
        (e.payload as { activityId?: string }).activityId === 'a-1',
    );
    expect(aTerm).toBeUndefined();
  });

  it('cancel preempts wait recovery: waitResolved + cancelRequested → activityCanceled', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a-1', nodeId: 'n-1', waitKind: 'human-gate' },
      },
      {
        runId: RUN_ID,
        type: 'waitResolved',
        actor: 'human',
        payload: { activityId: 'a-1', resolution: 'approved', by: 'x' },
      },
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'activity', activityId: 'a-1' },
          reason: 'preempt',
          by: 'ou_a',
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.cancelRecoveryOutcomes).toHaveLength(1);
    expect(r.waitRecoveryOutcomes).toEqual([]);
    expect(r.workerCrashedOutcomes).toEqual([]);
  });

  it('second resume after cancel recovery is a no-op', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'activity', activityId: 'a-1' },
          reason: 'r',
          by: 'b',
        },
      },
    );
    const first = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(first.cancelRecoveryOutcomes).toHaveLength(1);
    const second = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(second.cancelRecoveryOutcomes).toEqual([]);
  });

  it('node-target cancel fans out to activities under that node (Step 10)', async () => {
    // Step 10: replay-level fan-out marks activities under a node-cancel
    // as cancel-pending; resume completes them via activityCanceled.
    await bootstrapWith(
      attemptCreated('a-1', 'at-1', 'n-1'),
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'node', nodeId: 'n-1' },
          reason: 'abort node',
          by: 'b',
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.cancelRecoveryOutcomes).toHaveLength(1);
    expect(r.cancelRecoveryOutcomes[0].activityId).toBe('a-1');
    expect(r.workerCrashedOutcomes).toEqual([]);
  });

  it('run-target cancel fans out to ALL in-flight activities (Step 10)', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1', 'n-1'),
      attemptCreated('a-2', 'at-2', 'n-2'),
      {
        runId: RUN_ID,
        type: 'cancelRequested',
        actor: 'human',
        payload: {
          target: { kind: 'run', runId: RUN_ID },
          reason: 'kill run',
          by: 'b',
        },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.cancelRecoveryOutcomes).toHaveLength(2);
    expect(new Set(r.cancelRecoveryOutcomes.map((o) => o.activityId))).toEqual(
      new Set(['a-1', 'a-2']),
    );
    expect(r.workerCrashedOutcomes).toEqual([]);
  });
});

// ─── Step 10: workerLost integration ────────────────────────────────────────

describe('resume — Step 10: workerLost recovery (Step 7 handles consequences)', () => {
  it('workerLost + dangling effectAttempted → reconcile path (Step 7) handles it', async () => {
    await bootstrapWith(
      attemptCreated('a-1', 'at-1'),
      effectAttempted('a-1', 'at-1', 'botmux-schedule', 'wf_x', 1, Number.MAX_SAFE_INTEGER),
      {
        runId: RUN_ID,
        type: 'workerLost',
        actor: 'system',
        payload: { workerId: 'w-7', lostActivityIds: ['a-1'] },
      },
    );
    const reconciler: ProviderReconciler = {
      provider: 'botmux-schedule',
      async readOnlyLookup() {
        return { found: true, externalRefs: { taskId: 'wf_x' } };
      },
    };
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: new Map([['botmux-schedule', reconciler]]),
    });
    expect(r.reconcileOutcomes).toHaveLength(1);
    expect(r.reconcileOutcomes[0].decision).toBe('completedByIdempotentSubmit');
    expect(r.workerCrashedOutcomes).toEqual([]);
  });

  it('workerLost + dangling pure activity → WorkerCrashed path', async () => {
    await bootstrapWith(
      attemptCreated('a-pure', 'at-1'),
      {
        runId: RUN_ID,
        type: 'workerLost',
        actor: 'system',
        payload: { workerId: 'w-7', lostActivityIds: ['a-pure'] },
      },
    );
    const r = await resume({
      log,
      runId: RUN_ID,
      daemonId: 'd-1',
      reconcilers: emptyReconcilers(),
    });
    expect(r.workerCrashedOutcomes).toHaveLength(1);
    expect(r.workerCrashedOutcomes[0].activityId).toBe('a-pure');
  });
});
