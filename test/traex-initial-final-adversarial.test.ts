import './helpers/require-fenced-data-dir.js';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraexInitialDelivery } from '../src/services/traex-initial-delivery.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { InputTurnDeduper } from '../src/core/input-turn-dedupe.js';
import { rewrapSubmissionFailure } from '../src/core/raw-dispatch-failure.js';
import { programStatusBlockHoldsTypeAhead } from '../src/core/program-status-gate.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type * as TypeScript from 'typescript';

const faults = vi.hoisted(() => ({ directoryFsync: false, partialWrite: false, hits: 0 }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const overrides = {
    fsyncSync(fd: number) {
      if (faults.directoryFsync && fs.fstatSync(fd).isDirectory()) {
        faults.directoryFsync = false;
        faults.hits++;
        throw Object.assign(new Error('probe: directory fsync failed after rename'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    },
    writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      if (faults.partialWrite && typeof args[0] === 'number') {
        faults.partialWrite = false;
        faults.hits++;
        fs.writeFileSync(args[0], String(args[1]).slice(0, 23));
        throw Object.assign(new Error('probe: disk full during receipt write'), { code: 'ENOSPC' });
      }
      return fs.writeFileSync(...args);
    },
  };
  return { ...fs, ...overrides, default: { ...fs, ...overrides } };
});

// Mutation modes affect only the AST executed by the real-function harness.
// Run them with scripts/fenced-run.ts; production files remain untouched.
vi.mock('typescript', async importOriginal => {
  const module = await importOriginal<any>();
  const ts: typeof TypeScript = module.default ?? module;
  return { ...module, default: {
    ...ts,
    createSourceFile(...args: Parameters<typeof ts.createSourceFile>) {
      const source = ts.createSourceFile(...args);
      const mode = process.env.BOTMUX_FINAL_ADVERSARIAL_MUTATION;
      if (args[0] !== 'worker.ts' || !mode || mode === 'synthetic-idle') return source;
      if (!['write-guard', 'receipt-generation', 'terminal-guard'].includes(mode)) {
        throw new Error(`Unknown mutation: ${mode}`);
      }
      const transformed = ts.transform(source, [context => root => {
        const visit: TypeScript.Visitor = node => {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            if (mode === 'write-guard' && node.name.text === 'checkTraexStartup'
              && node.initializer && ts.isArrowFunction(node.initializer)) {
              return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
                ts.factory.updateArrowFunction(node.initializer, node.initializer.modifiers,
                  node.initializer.typeParameters, node.initializer.parameters, node.initializer.type,
                  node.initializer.equalsGreaterThanToken, ts.factory.createBlock([])));
            }
            if (mode === 'receipt-generation' && node.name.text === 'launchedHere') {
              return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken,
                node.type, ts.factory.createTrue());
            }
          }
          if (mode === 'terminal-guard' && ts.isIfStatement(node)
            && ts.isBinaryExpression(node.expression) && ts.isCallExpression(node.expression.left)
            && ts.isPropertyAccessExpression(node.expression.left.expression)
            && ts.isIdentifier(node.expression.left.expression.expression)
            && node.expression.left.expression.expression.text === 'emittedTurnTerminals') {
            return ts.factory.updateIfStatement(node, ts.factory.createTrue(), node.thenStatement, node.elseStatement);
          }
          return ts.visitEachChild(node, visit, context);
        };
        return ts.visitNode(root, visit) as TypeScript.SourceFile;
      }]);
      const text = ts.createPrinter().printFile(transformed.transformed[0]!);
      transformed.dispose();
      return ts.createSourceFile(args[0], text, ...args.slice(2) as [
        TypeScript.ScriptTarget, boolean?, TypeScript.ScriptKind?,
      ]);
    },
  } };
});

const roots: string[] = [];
const detectors: IdleDetector[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
  Object.assign(faults, { directoryFsync: false, partialWrite: false, hits: 0 });
  if (process.env.BOTMUX_FINAL_ADVERSARIAL_MUTATION === 'synthetic-idle') {
    vi.spyOn(IdleDetector.prototype, 'confirmStartupFromSubmission')
      .mockImplementation(function (this: IdleDetector) { this.fireIdle(); });
  }
});
afterEach(() => {
  for (const detector of detectors.splice(0)) detector.dispose();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(dispatched = true) {
  const root = mkdtempSync(join(tmpdir(), 'traex-final-adversarial-'));
  roots.push(root);
  const history = join(root, 'history.jsonl');
  const receipt = new TraexInitialDelivery(root, 'session');
  const record = receipt.prepare('first task', 'om_first', 1, history);
  if (dispatched) receipt.dispatch(record);
  return {
    root, history, receipt, record,
    accept: () => appendFileSync(history, `${JSON.stringify({
      session_id: 'native-owned', text: record.content,
    })}\n`),
  };
}

function newDetector() {
  const detector = new IdleDetector(createTraexAdapter('/bin/true'));
  detectors.push(detector);
  return detector;
}

function watchHarness(f: ReturnType<typeof fixture>) {
  const detector = newDetector();
  const scope: Record<string, any> = {
    backend: {}, cliSpawnGeneration: 1, sessionId: 'session',
    traexInitialDelivery: f.receipt, lastSpawnTraexInitialDelivery: f.record,
    traexStartupSubmitPending: true, awaitingFirstPrompt: true,
    firstWriteLivenessConfirmed: false, openingInputBoxSettled: false,
    lastInitConfig: { cliId: 'traex' }, idleDetector: detector,
    cliAdapter: createTraexAdapter('/bin/true'), programStatusBlockHoldsTypeAhead,
    codexBridgeQueue: new CodexBridgeQueue(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    activeTurnAuthority: new ActiveTurnAuthority(),
    ordinaryImTurnDedupe: new InputTurnDeduper(),
    persistCliSessionId: vi.fn(), codexBridgeNotifyCliSessionId: vi.fn(),
    codexBridgeDrainAndMaybeEmit: vi.fn(), flushPending: vi.fn(),
    log: vi.fn(), send: vi.fn(),
  };
  scope.codexBridgeQueue.mark(f.record.turnId, f.record.content);
  scope.ordinaryImTurnDedupe.begin(f.record.turnId);
  for (const name of ['watchTraexInitialDelivery', 'traexStartupInputHeld',
    'markActiveTurnStarted', 'turnAuthorityIdentity', 'acknowledgeTurnInputCommitted',
    'programStatusBlockedHoldsTypeAhead']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  return scope;
}

function commits(h: Record<string, any>) {
  return h.send.mock.calls.filter(([message]: any[]) => message.type === 'turn_input_committed');
}

describe('final adversarial: partial durable writes', () => {
  it('keeps a truncated exclusive receipt fail-closed after a dispatch write error', async () => {
    const f = fixture(false);
    faults.partialWrite = true;
    expect(() => f.receipt.dispatch(f.record)).toThrow();
    expect(faults.hits).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(() => new TraexInitialDelivery(f.root, 'session')).toThrow();
    expect(() => f.receipt.dispatch(f.record)).toThrow();
  });

  it('retries directory fsync failure without acknowledging before durable confirmation', async () => {
    const f = fixture();
    const h = watchHarness(f);
    h.watchTraexInitialDelivery({});
    f.accept();
    faults.directoryFsync = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(faults.hits).toBe(1);
    expect(JSON.parse(readFileSync(f.receipt.path, 'utf8')).state).toBe('confirmed');
    expect(f.receipt.pending).toBe(true);
    expect(commits(h)).toHaveLength(0);
    expect(h.traexStartupInputHeld()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(commits(h)).toHaveLength(1);
    expect(f.receipt.pending).toBe(false);
  });

  it('retains a renamed confirmation when history rotates after directory fsync fails', async () => {
    const f = fixture();
    const h = watchHarness(f);
    h.watchTraexInitialDelivery({});
    f.accept();
    faults.directoryFsync = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(faults.hits).toBe(1);
    expect(new TraexInitialDelivery(f.root, 'session').record?.state).toBe('confirmed');
    expect(commits(h)).toHaveLength(0);
    renameSync(f.history, `${f.history}.rotated`);
    await vi.advanceTimersByTimeAsync(120_000);
    const recovered = new TraexInitialDelivery(f.root, 'session');
    expect.soft(recovered.record?.state).toBe('confirmed');
    expect.soft(recovered.confirm(f.record.deliveryId)).toBe('native-owned');
    expect.soft(commits(h)).toHaveLength(1);
    expect.soft(h.traexStartupInputHeld()).toBe(false);
  });

  it('stops the old callback after restart in the post-rename failure window', async () => {
    const f = fixture();
    const h = watchHarness(f);
    h.watchTraexInitialDelivery({});
    f.accept();
    faults.directoryFsync = true;
    await vi.advanceTimersByTimeAsync(1_000);
    h.cliSpawnGeneration++;
    h.backend = {};
    h.lastSpawnTraexInitialDelivery = undefined;
    h.traexInitialDelivery = new TraexInitialDelivery(f.root, 'session');
    renameSync(f.history, `${f.history}.rotated`);
    h.watchTraexInitialDelivery({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(commits(h)).toHaveLength(1);
    expect(h.traexStartupInputHeld()).toBe(true);
    expect(h.idleDetector.isStartupComplete()).toBe(false);
    expect(new TraexInitialDelivery(f.root, 'session').record?.state).toBe('confirmed');
  });
});

describe('final adversarial: cancellation and live startup evidence', () => {
  it.each(['cancelled', 'completed', 'failed'])('does not replace a successor authority after %s', async status => {
    const f = fixture();
    const h = watchHarness(f);
    h.watchTraexInitialDelivery({});
    h.emittedTurnTerminals.claim('session', 'om_first', undefined, status);
    h.activeTurnAuthority.reserve({ turnId: 'om_second' });
    h.activeTurnAuthority.markStarted({ turnId: 'om_second' });
    f.accept();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.activeTurnAuthority.snapshot()).toMatchObject({ turnId: 'om_second', started: true });
    expect(commits(h)).toHaveLength(1);
    expect(h.codexBridgeNotifyCliSessionId).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('never treats a recovered receipt as live startup evidence at generation %s', async generation => {
    const f = fixture();
    f.accept();
    f.receipt.confirm(f.record.deliveryId);
    const h = watchHarness(f);
    h.cliSpawnGeneration = generation;
    h.lastSpawnTraexInitialDelivery = undefined;
    h.watchTraexInitialDelivery({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(commits(h)).toHaveLength(1);
    expect(h.traexStartupInputHeld()).toBe(true);
    expect(h.idleDetector.isStartupComplete()).toBe(false);
    expect(h.awaitingFirstPrompt).toBe(true);
  });

  it('confirms startup without publishing a synthetic idle edge', async () => {
    const f = fixture();
    const h = watchHarness(f);
    const idle = vi.fn();
    h.idleDetector.onIdle(idle);
    f.accept();
    h.watchTraexInitialDelivery({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.idleDetector.isStartupComplete()).toBe(true);
    expect(h.idleDetector.isIdleNow()).toBe(false);
    expect(idle).not.toHaveBeenCalled();
  });

  it.each(['working', 'blocked'] as const)('preserves authoritative %s through receipt and quiet time', async state => {
    const f = fixture();
    const h = watchHarness(f);
    const idle = vi.fn();
    h.idleDetector.onIdle(idle);
    h.idleDetector.reset({ inputCycle: true });
    h.idleDetector.observeProgramStatus({ state, kind: 'permission', msg: 'approval required' });
    f.accept();
    h.watchTraexInitialDelivery({});
    h.idleDetector.feed('\u276f Ask TRAE CLI to do anything\n  GPT-6 \u00b7 Context 100% left\n');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.idleDetector.isStartupComplete()).toBe(true);
    expect(h.idleDetector.programStatusHeldBusy()).toBe(true);
    expect(h.idleDetector.isIdleNow()).toBe(false);
    expect(idle).not.toHaveBeenCalled();
    if (state === 'blocked') {
      expect(h.idleDetector.programStatusBlock()).toMatchObject({ kind: 'permission' });
      expect(h.programStatusBlockedHoldsTypeAhead()).toBe(true);
    }
  });

  it('arms the native argv input cycle before relying on blocked status after its receipt', async () => {
    const f = fixture();
    const h = watchHarness(f);
    const idle = vi.fn();
    const blockedAtFlush: boolean[] = [];
    h.flushPending.mockImplementation(() => {
      blockedAtFlush.push(h.programStatusBlockedHoldsTypeAhead());
    });
    h.idleDetector.onIdle(idle);
    // Native argv has not traversed beginCliWriteCycle/reset(inputCycle).
    h.idleDetector.observeProgramStatus({ state: 'blocked', kind: 'permission', msg: 'approval required' });
    f.accept();
    h.watchTraexInitialDelivery({});
    h.idleDetector.observeProgramStatus({ state: 'blocked', kind: 'permission', msg: 'approval required' });
    h.idleDetector.feed('\u276f Ask TRAE CLI to do anything\n  GPT-6 \u00b7 Context 100% left\n');
    await vi.advanceTimersByTimeAsync(120_000);
    expect.soft(h.idleDetector.programStatusHeldBusy()).toBe(true);
    expect.soft(h.idleDetector.programStatusBlock()).toMatchObject({ kind: 'permission' });
    expect.soft(h.idleDetector.isIdleNow()).toBe(false);
    expect.soft(idle).not.toHaveBeenCalled();
    expect.soft(blockedAtFlush).toEqual([true]);
    expect.soft(h.programStatusBlockedHoldsTypeAhead()).toBe(true);
  });
});

class SubmissionWriteError extends Error {
  constructor(message: string, readonly recoveryFailureReason?: string,
    readonly submissionStarted = true, readonly runnerGenerationUnsafe = false) {
    super(message);
  }
}

function transactionHarness(journal: boolean, cliId = 'traex') {
  const target = journal ? {
    captureAmbiguousSubmissionFence: vi.fn(() => 1),
    cancelAmbiguousSubmission: vi.fn(),
    confirmAmbiguousSubmission: vi.fn(),
  } : {};
  const h: Record<string, any> = {
    backend: target, cliSpawnGeneration: 1, cliRestartInProgress: false,
    lastInitConfig: { cliId }, traexStartupSubmitPending: false,
    ambiguousSubmissionWriteTail: Promise.resolve(),
    SubmissionWriteError, AmbiguousSubmissionBlockedError: class extends Error {},
    rewrapSubmissionFailure, log: vi.fn(), t: (key: string) => key,
  };
  for (const name of ['traexStartupInputHeld', 'runAmbiguousSubmissionTransaction',
    'captureAmbiguousSubmissionFence', 'cancelAmbiguousSubmissionAfterFailure',
    'confirmAmbiguousSubmissionAfterSuccess', 'ambiguousSubmissionRecoveryMessage']) {
    h[name] = loadWorkerFunction(name, h);
  }
  return { h, target };
}

describe('final adversarial: final-write wait overlap', () => {
  for (const journal of [false, true]) {
    it.each(['held', 'backend', 'generation', 'restart'])(
      `rejects %s across beforeWrite with journal=${journal} and leaves the lock reusable`,
      async change => {
        const { h, target } = transactionHarness(journal);
        const write = vi.fn(async () => 'sent');
        const run = h.runAmbiguousSubmissionTransaction(target, write, undefined, async () => {
          await new Promise(resolve => setTimeout(resolve, 4_000));
          if (change === 'held') h.traexStartupSubmitPending = true;
          if (change === 'backend') h.backend = {};
          if (change === 'generation') h.cliSpawnGeneration++;
          if (change === 'restart') h.cliRestartInProgress = true;
        });
        const result = run.then((value: unknown) => value, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await result).toMatchObject({ submissionStarted: false });
        expect(write).not.toHaveBeenCalled();
        h.backend = target;
        h.cliRestartInProgress = h.traexStartupSubmitPending = false;
        await expect(h.runAmbiguousSubmissionTransaction(target, write)).resolves.toMatchObject({ result: 'sent' });
        expect(write).toHaveBeenCalledTimes(1);
      },
    );
  }

  it('rechecks a waiting transaction after the prior write and a generation change', async () => {
    const { h, target } = transactionHarness(true);
    const first = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      return 'first';
    });
    const next = vi.fn(async () => 'second');
    const a = h.runAmbiguousSubmissionTransaction(target, first);
    const b = h.runAmbiguousSubmissionTransaction(target, next)
      .then((value: unknown) => value, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    h.cliSpawnGeneration++;
    await vi.advanceTimersByTimeAsync(5_000);
    await a;
    expect(await b).toMatchObject({ submissionStarted: false });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not apply the TRAE startup guard to a Codex transaction', async () => {
    const { h, target } = transactionHarness(false, 'codex');
    h.traexStartupSubmitPending = true;
    const write = vi.fn(async () => 'codex-sent');
    await expect(h.runAmbiguousSubmissionTransaction(target, write)).resolves.toEqual({ result: 'codex-sent' });
    expect(write).toHaveBeenCalledTimes(1);
  });
});
