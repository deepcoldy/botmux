/**
 * Shared harness for the bot-executed (external) goal-node tests: a real
 * runtime over a temp run dir, a recording fake transport, and an injectable
 * engine clock. A "restart" is a fresh runtime + executor on the same dir.
 */

import { expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateDag, type V3Dag } from '../../src/workflows/v3/dag.js';
import { readJournal, type StoredEvent, type V3Event } from '../../src/workflows/v3/journal.js';
import { materialize } from '../../src/workflows/v3/state.js';
import { readAndValidateManifest, ManifestValidationError } from '../../src/workflows/v3/manifest.js';
import { openV3ExternalAttempts } from '../../src/workflows/v3/external-attempt-ledger.js';
import {
  runWorkflow,
  type V3RunOutcome,
  type V3RuntimeDeps,
  type V3RuntimeOptions,
} from '../../src/workflows/v3/runtime.js';
import type {
  V3ExternalAcceptanceProbe,
  V3ExternalAttemptRef,
  V3ExternalDispatchOutcome,
  V3ExternalDispatchRequest,
  V3ExternalNodeExecutor,
  V3ExternalStopRequest,
} from '../../src/workflows/v3/external-executor.js';
import {
  ingestExternalSubmission,
  recordExternalAccepted,
  type V3ExternalSubmission,
} from '../../src/workflows/v3/external-control.js';
import type { BotSnapshot, RunNode } from '../../src/workflows/v3/contract.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

export const ACCEPT_MS = 20_000;
export const TIMEOUT_SEC = 600;
export const T0 = 1_700_000_000_000;

export const validateManifest: V3RuntimeDeps['validateManifest'] = async (manifestPath, outputDir) => {
  try {
    return { ok: true, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (err) {
    return { ok: false, problems: err instanceof ManifestValidationError ? err.problems : [String(err)] };
  }
};

export const snapshotFor = (bot: string | undefined): BotSnapshot => ({
  larkAppId: bot ?? 'cli_main',
  cliId: 'claude-code',
  workingDir: '/tmp',
});

export class FakeExecutor implements V3ExternalNodeExecutor {
  readonly dispatches: V3ExternalDispatchRequest[] = [];
  readonly probes: Array<V3ExternalAttemptRef & { handoffMessageId: string }> = [];
  readonly stops: V3ExternalStopRequest[] = [];
  onDispatch: (req: V3ExternalDispatchRequest) => V3ExternalDispatchOutcome | Promise<V3ExternalDispatchOutcome> =
    (req) => ({ kind: 'sent', handoffMessageId: `om_${req.idempotency.handoff}` });
  onProbe: (ref: V3ExternalAttemptRef) => V3ExternalAcceptanceProbe | Promise<V3ExternalAcceptanceProbe> =
    () => ({ status: 'notAccepted' });
  onStop: (req: V3ExternalStopRequest) => void | Promise<void> = () => {};

  async dispatch(req: V3ExternalDispatchRequest): Promise<V3ExternalDispatchOutcome> {
    this.dispatches.push(req);
    return this.onDispatch(req);
  }

  async probeAcceptance(ref: V3ExternalAttemptRef & { handoffMessageId: string }): Promise<V3ExternalAcceptanceProbe> {
    this.probes.push(ref);
    return this.onProbe(ref);
  }

  async stop(req: V3ExternalStopRequest): Promise<void> {
    this.stops.push(req);
    await this.onStop(req);
  }
}

const bases: string[] = [];
/** Call from afterEach: removes every run dir created since the last call.
 *  A refusal the node daemon records fire-and-forget (a registry write behind
 *  `withFileLock` + an atomic rename) can still be landing when the test body
 *  returns. The write itself is quick, but acquiring its file lock on a
 *  loaded CI runner can take seconds; retry the removal generously instead
 *  of failing teardown with ENOTEMPTY (the first 10 × 50 ms budget still lost
 *  that race in CI twice). This is teardown only, so the wait is harmless. */
export function cleanupBotRuns(): void {
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true, maxRetries: 60, retryDelay: 100 });
  }
}

/** Register an extra temp dir for cleanupBotRuns. */
export function trackTempDir(dir: string): string {
  bases.push(dir);
  return dir;
}

export class BotRun {
  readonly base: string;
  readonly runDir: string;
  readonly journalPath: string;
  readonly clock = { t: T0 };
  workerSpawns = 0;

  constructor(readonly dag: V3Dag) {
    this.base = mkdtempSync(join(tmpdir(), 'v3-ext-'));
    bases.push(this.base);
    this.runDir = join(this.base, dag.runId);
    this.journalPath = join(this.runDir, 'journal.ndjson');
  }

  drive(
    executor: V3ExternalNodeExecutor,
    extra: { opts?: Partial<V3RuntimeOptions>; deps?: Partial<V3RuntimeDeps> } = {},
  ): Promise<V3RunOutcome> {
    const runNode: RunNode = async () => {
      this.workerSpawns++;
      throw new Error('bot mode must never spawn an ephemeral worker');
    };
    return runWorkflow(this.dag, {
      runNode,
      validateManifest,
      resolveBotSnapshot: snapshotFor,
      externalExecutor: executor,
      now: () => this.clock.t,
      ...extra.deps,
    }, {
      baseDir: this.base,
      gateMode: 'suspend',
      nodeExecutor: 'bot',
      externalAcceptTimeoutMs: ACCEPT_MS,
      ...extra.opts,
    });
  }

  events(): StoredEvent[] {
    return readJournal(this.journalPath);
  }

  of<T extends V3Event['type']>(type: T): Array<StoredEvent & Extract<V3Event, { type: T }>> {
    return this.events().filter((event) => event.type === type) as Array<StoredEvent & Extract<V3Event, { type: T }>>;
  }

  snap() {
    return materialize(this.events());
  }

  ctx() {
    return { dag: this.dag, now: () => this.clock.t };
  }

  openAttempt(nodeId: string) {
    const found = openV3ExternalAttempts(this.events()).filter((attempt) => attempt.nodeId === nodeId);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  accept(attemptId: string, sessionId = 'sess-1') {
    return recordExternalAccepted(this.runDir, { attemptId, sessionId }, this.ctx());
  }

  submit(attemptId: string, input: Partial<V3ExternalSubmission> = {}) {
    return ingestExternalSubmission(this.runDir, {
      attemptId,
      files: [],
      summary: 'done',
      ...input,
    }, this.ctx());
  }
}

export function reportDag(runId: string, extra: Record<string, unknown> = {}) {
  return validateDag({
    schemaVersion: 2,
    runId,
    nodes: [{
      id: 'write',
      type: 'goal',
      goal: 'write the report',
      bot: 'cli_a',
      timeoutSec: TIMEOUT_SEC,
      outputs: { report: { path: 'report.md', kind: 'markdown' } },
      resultSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      ...extra,
    }],
  });
}

export const reportFiles = (content = '# report\n') => ({
  files: [{ key: 'report', name: 'risk-report.md', data: Buffer.from(content) }],
  result: { message: 'ok' },
});

export function expectAwaitingExternal(outcome: V3RunOutcome) {
  expect(outcome.reason).toBe('awaitingExternal');
  if (outcome.reason !== 'awaitingExternal') throw new Error('unreachable');
  return outcome;
}

export function expectTerminal(outcome: V3RunOutcome) {
  expect(outcome.reason).toBe('terminal');
  if (outcome.reason !== 'terminal') throw new Error('unreachable');
  return outcome;
}
