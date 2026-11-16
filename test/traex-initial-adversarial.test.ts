import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraexInitialDelivery } from '../src/services/traex-initial-delivery.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { InputTurnDeduper } from '../src/core/input-turn-dedupe.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { isOrdinaryImTurnId } from '../src/core/ordinary-im-turn.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { shouldQueueInitialPrompt } from '../src/codex-rpc-lifecycle.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import type * as TypeScript from 'typescript';

// Optional mutation run: edit only the AST loaded by the function harness.
// No production file is written. Run these modes through scripts/fenced-run.ts.
vi.mock('typescript', async importOriginal => {
  const module = await importOriginal<any>();
  const ts: typeof TypeScript = module.default ?? module;
  return { ...module, default: {
    ...ts,
    createSourceFile(...args: Parameters<typeof ts.createSourceFile>) {
      const source = ts.createSourceFile(...args);
      const mutation = process.env.BOTMUX_ADVERSARIAL_MUTATION;
      if (args[0] !== 'worker.ts' || !mutation) return source;
      if (!['observer-current', 'terminal-status', 'viewport-web-input', 'final-write', 'receipt-generation', 'native-poll'].includes(mutation)) {
        throw new Error(`Unknown adversarial mutation: ${mutation}`);
      }
      const transformed = ts.transform(source, [context => root => {
        const visit: TypeScript.Visitor = node => {
          if (mutation === 'native-poll' && ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name) && node.name.text === 'nativeInitial') {
            return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken,
              node.type, ts.factory.createFalse());
          }
          if (mutation === 'final-write' && ts.isExpressionStatement(node)
            && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
            && node.expression.expression.text === 'checkTraexStartup') return ts.factory.createEmptyStatement();
          if (mutation === 'receipt-generation' && ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name) && node.name.text === 'launchedHere') {
            return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, ts.factory.createTrue());
          }
          if (mutation === 'observer-current' && ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name) && node.name.text === 'current'
            && node.initializer && ts.isArrowFunction(node.initializer)) {
            return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken,
              node.type, ts.factory.updateArrowFunction(node.initializer,
                node.initializer.modifiers, node.initializer.typeParameters,
                node.initializer.parameters, node.initializer.type,
                node.initializer.equalsGreaterThanToken, ts.factory.createTrue()));
          }
          if (mutation === 'terminal-status' && ts.isIfStatement(node)
            && ts.isBinaryExpression(node.expression)
            && ts.isCallExpression(node.expression.left)
            && ts.isPropertyAccessExpression(node.expression.left.expression)
            && ts.isIdentifier(node.expression.left.expression.expression)
            && node.expression.left.expression.expression.text === 'emittedTurnTerminals') {
            return ts.factory.updateIfStatement(node, ts.factory.createTrue(), node.thenStatement, node.elseStatement);
          }
          if (mutation === 'viewport-web-input' && ts.isBinaryExpression(node)
            && ts.isIdentifier(node.left) && node.left.text === 'webTerminalInputGeneration'
            && ts.isIdentifier(node.right) && node.right.text === 'webInputGeneration') {
            return ts.factory.createFalse();
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

// Real worker functions run through the repository's AST harness, not a copy
// of their implementation. Only process/UI/IPC boundaries are substituted.
const roots: string[] = [];
const disposables: Array<{ dispose(): void }> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
});
afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deliveryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'traex-adversarial-'));
  roots.push(root);
  const history = join(root, 'history.jsonl');
  const receipt = new TraexInitialDelivery(root, 'session');
  const record = receipt.prepare('first task', 'om_first', 1, history);
  receipt.dispatch(record);
  const historyLine = JSON.stringify({ session_id: 'native-owned', text: record.content });
  return { root, history, receipt, record, historyLine };
}

function watchHarness(f: ReturnType<typeof deliveryFixture>) {
  const scope: Record<string, any> = {
    sessionId: 'session', backend: {}, cliSpawnGeneration: 1,
    traexInitialDelivery: f.receipt, traexStartupSubmitPending: true,
    lastSpawnTraexInitialDelivery: f.record,
    codexBridgeQueue: new CodexBridgeQueue(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    activeTurnAuthority: new ActiveTurnAuthority(),
    ordinaryImTurnDedupe: new InputTurnDeduper(),
    universalOutputHandoff: undefined,
    lastInitConfig: { cliId: 'traex' },
    persistCliSessionId: vi.fn(),
    codexBridgeNotifyCliSessionId: vi.fn(),
    codexBridgeDrainAndMaybeEmit: vi.fn(),
    flushPending: vi.fn(), idleDetector: { confirmStartupFromSubmission: vi.fn() },
    send: vi.fn(), log: vi.fn(),
  };
  scope.ordinaryImTurnDedupe.begin(f.record.turnId);
  scope.codexBridgeQueue.mark(f.record.turnId, f.record.content);
  for (const name of [
    'traexStartupInputHeld', 'watchTraexInitialDelivery', 'markActiveTurnStarted',
    'turnAuthorityIdentity', 'acknowledgeTurnInputCommitted',
  ]) scope[name] = loadWorkerFunction(name, scope);
  return scope;
}

describe('independent TRAE receipt probes', () => {
  it('retains unknown across partial history and long waits, then acknowledges exactly once', async () => {
    const f = deliveryFixture();
    const h = watchHarness(f);
    h.watchTraexInitialDelivery({});
    appendFileSync(f.history, f.historyLine);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(new TraexInitialDelivery(f.root, 'session').record?.state).toBe('unknown');
    expect(h.send.mock.calls.filter(([m]: any[]) => m.type === 'user_notify')).toHaveLength(1);
    expect(h.flushPending).not.toHaveBeenCalled();
    appendFileSync(f.history, '\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.send.mock.calls.filter(([m]: any[]) => m.type === 'turn_input_committed')).toHaveLength(1);
    expect(h.ordinaryImTurnDedupe.state('om_first')).toBe('committed');
    expect(h.traexStartupInputHeld()).toBe(false);
    expect(new TraexInitialDelivery(f.root, 'session').record?.cliSessionId).toBe('native-owned');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.flushPending).toHaveBeenCalledTimes(1);
  });

  it('keeps input held when confirmation rename fails, and retries after storage recovers', async () => {
    const f = deliveryFixture();
    const h = watchHarness(f);
    h.watchTraexInitialDelivery({});
    appendFileSync(f.history, `${f.historyLine}\n`);
    // Real rename failure: a directory occupies the receipt leaf.
    renameSync(f.receipt.path, `${f.receipt.path}.saved`);
    mkdirSync(f.receipt.path);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.traexStartupInputHeld()).toBe(true);
    expect(h.flushPending).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    rmSync(f.receipt.path, { recursive: true });
    renameSync(`${f.receipt.path}.saved`, f.receipt.path);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.ordinaryImTurnDedupe.state('om_first')).toBe('committed');
    expect(h.flushPending).toHaveBeenCalledTimes(1);
  });

  it.each(['backend', 'generation', 'receipt'])('ignores a late receipt after %s replacement', async replacement => {
    const f = deliveryFixture();
    const h = watchHarness(f);
    h.watchTraexInitialDelivery({});
    if (replacement === 'backend') h.backend = {};
    if (replacement === 'generation') h.cliSpawnGeneration++;
    if (replacement === 'receipt') h.traexInitialDelivery = new TraexInitialDelivery(f.root, 'session');
    appendFileSync(f.history, `${f.historyLine}\n`);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.persistCliSessionId).not.toHaveBeenCalled();
    expect(h.flushPending).not.toHaveBeenCalled();
    expect(f.receipt.pending).toBe(true);
  });

  it('does not restart an already settled turn on a late receipt', async () => {
    const f = deliveryFixture();
    const h = watchHarness(f);
    h.watchTraexInitialDelivery({});
    h.emittedTurnTerminals.claim('session', 'om_first', undefined, 'cancelled');
    appendFileSync(f.history, `${f.historyLine}\n`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
    expect(h.ordinaryImTurnDedupe.state('om_first')).toBe('committed');
  });

  it('does not release a replacement CLI startup gate with an old confirmed receipt', async () => {
    const f = deliveryFixture();
    appendFileSync(f.history, `${f.historyLine}\n`);
    f.receipt.confirm(f.record.deliveryId);
    const h = watchHarness(f);
    h.cliSpawnGeneration = 2;
    h.lastSpawnTraexInitialDelivery = undefined;
    h.watchTraexInitialDelivery({});
    expect(h.traexStartupInputHeld()).toBe(true);
    expect(h.idleDetector.confirmStartupFromSubmission).not.toHaveBeenCalled();
  });

  it('preserves follow-ups without replaying the opening input after a delivered interrupt', async () => {
    const f = deliveryFixture();
    const h = watchHarness(f);
    Object.assign(h, {
      currentBotmuxTurnId: 'om_first', effectiveBackendType: 'pty', cliLifetimeNonce: 1,
      cliAdapter: { id: 'traex', interruptKey: 'esc' }, isCodexAppCliId,
      nativeSessionForkPending: () => false,
      inflightInputs: new InflightInputTracker(),
      pendingMessages: [{ content: 'second', turnId: 'om_second' }],
      runAfterAmbiguousSubmissionWrites: async (_backend: unknown, action: () => unknown) => action(),
      sendCriticalControlKey: async (_key: string, action: () => unknown) => action(),
      sendTermActionOnce: vi.fn(async () => true),
      retireDoubaoBridgeTurnOnInterrupt: vi.fn(),
      scheduleOneShotAfterAction: vi.fn(),
    });
    h.watchTraexInitialDelivery({});
    const interrupt = loadWorkerFunction('handleExactTurnInterrupt', h);
    await interrupt('stop-request', 'om_first');
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_interrupt_result', delivered: true,
    }));
    appendFileSync(f.history, `${f.historyLine}\n`);
    await vi.advanceTimersByTimeAsync(2_000);
    // delivered=true acknowledges the key, not a native cancelled terminal.
    // The separate settled-turn probe above tests confirmed cancellation.
    expect(h.pendingMessages.map((m: any) => m.turnId)).toEqual(['om_second']);
    expect(h.sendTermActionOnce).toHaveBeenCalledTimes(1);
    expect(() => new TraexInitialDelivery(f.root, 'session')
      .prepare('first task', 'om_first', 2, f.history)).toThrow();
  });

  it('notifies unknown delivery even while history is unreadable, then accepts a late receipt', async () => {
    const f = deliveryFixture();
    const h = watchHarness(f);
    mkdirSync(f.history);
    expect(() => f.receipt.confirm(f.record.deliveryId)).toThrow();
    h.watchTraexInitialDelivery({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect.soft(h.send.mock.calls.filter(([m]: any[]) => m.type === 'user_notify')).toHaveLength(1);
    expect(h.traexStartupInputHeld()).toBe(true);
    expect(h.flushPending).not.toHaveBeenCalled();
    rmSync(f.history, { recursive: true });
    appendFileSync(f.history, `${f.historyLine}\n`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.ordinaryImTurnDedupe.state('om_first')).toBe('committed');
  });
});

const SHORT = '\u276f Ask TRAE CLI to do anything\n  ? for shortcuts';
const LOADED = '\u276f Ask TRAE CLI to do anything\n  GPT-6 \u00b7 Context 100% left';

async function readinessHarness(screen: string) {
  const renderer = new TerminalRenderer(160, 30);
  const adapter = createTraexAdapter('/bin/true');
  const detector = new IdleDetector(adapter);
  disposables.push(renderer, detector);
  const paint = renderer.writeAndFlush(screen.replaceAll('\n', '\r\n'));
  await vi.advanceTimersByTimeAsync(10);
  await paint;
  // No constructor or tmux process: only captureViewportAsync is external I/O.
  const backend = Object.create(TmuxPipeBackend.prototype);
  backend.captureViewportAsync = vi.fn(async () => LOADED);
  const scope: Record<string, any> = {
    lastInitConfig: { cliId: 'traex' }, backend,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    idleDetector: detector, cliAdapter: adapter, cliSpawnGeneration: 1,
    awaitingFirstPrompt: true, traexStartupSubmitPending: true,
    renderer, inflightInputs: new InflightInputTracker(),
    lastPtyOutputAtMs: Date.now() - 5_000,
    webTerminalInputGeneration: 0, backendScreenRevision: 1,
    ptyOutputGeneration: { snapshot: () => 1, isCurrent: (g: number) => g === 1 },
    TmuxPipeBackend, traexRestoredComposerReady,
    holdFirstPromptForStuckPage: () => false,
    cliName: () => 'traex', log: vi.fn(),
    flushPending: vi.fn(), flushPendingInjections: vi.fn(),
  };
  scope.traexStartupInputHeld = loadWorkerFunction('traexStartupInputHeld', scope);
  detector.onIdle(() => {
    if (!scope.traexStartupInputHeld()) scope.flushPending();
  });
  scope.schedule = loadWorkerFunction('scheduleTraexFirstPromptReadiness', scope);
  return scope;
}

describe('independent TRAE startup polling probes', () => {
  it('keeps observing a confirmed native first turn until its missed composer becomes ready', async () => {
    const h = await readinessHarness('');
    h.lastSpawnTraexInitialDelivery = { spawnGeneration: 1 };
    h.promptReadyEdges = 0;
    h.awaitingFirstPrompt = false;
    h.traexStartupSubmitPending = false;
    h.idleDetector.reset({ inputCycle: true });
    h.idleDetector.confirmStartupFromSubmission();
    h.schedule(h.backend);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.backend.captureViewportAsync).toHaveBeenCalled();
    expect(h.flushPending).toHaveBeenCalled();
    h.promptReadyEdges++;
    const captures = h.backend.captureViewportAsync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.backend.captureViewportAsync).toHaveBeenCalledTimes(captures);
  });

  it('recovers an empty stream renderer from the native viewport', async () => {
    const h = await readinessHarness('');
    h.schedule(h.backend);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.backend.captureViewportAsync).toHaveBeenCalled();
    expect(h.traexStartupInputHeld()).toBe(false);
    expect(h.flushPending).toHaveBeenCalled();
  });

  it('recovers a partial shortcut-only stream renderer from the loaded native viewport', async () => {
    const h = await readinessHarness(SHORT);
    const screen = h.renderer.rawSnapshot({ preserveFormatting: true });
    expect(traexRestoredComposerReady(screen)).toBe(true);
    expect(traexRestoredComposerReady(screen, { requireModelFooter: true })).toBe(false);
    h.schedule(h.backend);
    await vi.advanceTimersByTimeAsync(120_000);
    expect.soft(h.backend.captureViewportAsync).toHaveBeenCalled();
    expect.soft(h.flushPending).toHaveBeenCalled();
    expect(h.traexStartupInputHeld()).toBe(false);
  });

  it('rejects a viewport read overlapping human input, then observes the next stable frame', async () => {
    const h = await readinessHarness(LOADED);
    const realFlush = h.renderer.writeAndFlush.bind(h.renderer);
    const flush = vi.spyOn(h.renderer, 'writeAndFlush');
    flush.mockImplementationOnce(async () => {
      h.webTerminalInputGeneration++;
      await realFlush('');
    });
    h.schedule(h.backend);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.traexStartupInputHeld()).toBe(true);
    expect(h.flushPending).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.traexStartupInputHeld()).toBe(false);
    expect(h.flushPending).toHaveBeenCalled();
  });
});

describe('TRAE final write boundary', () => {
  it.each(['held', 'backend', 'generation', 'restart'])('rejects %s after an asynchronous beforeWrite', async change => {
    const target = {};
    const h: Record<string, any> = {
      backend: target, cliSpawnGeneration: 1, cliRestartInProgress: false,
      lastInitConfig: { cliId: 'traex' },
      traexStartupInputHeld: () => change === 'held' && changed,
      SubmissionWriteError: class extends Error {},
    };
    let changed = false;
    const run = loadWorkerFunction('runAmbiguousSubmissionTransaction', h);
    const write = vi.fn(async () => true);
    await expect(run(target, write, undefined, async () => {
      await Promise.resolve();
      changed = true;
      if (change === 'backend') h.backend = {};
      if (change === 'generation') h.cliSpawnGeneration++;
      if (change === 'restart') h.cliRestartInProgress = true;
    })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});

function recoveryInitHarness(root: string) {
  const stopBeforeLaunch = new Error('probe: stop before external launch');
  const noop = () => {};
  const h: Record<string, any> = {
    TraexInitialDelivery, followBotTraeHome: noop, codexRpcEngine: null,
    isRemoteBackendType: () => false,
    process: { env: { SESSION_DATA_DIR: root } },
    // Run the real recovery prefix, ending at the first unrelated boundary.
    protectedHttpEgressCliSupportError: () => { throw stopBeforeLaunch; },
    backend: {}, cliSpawnGeneration: 2, sessionId: 'session',
    codexBridgeQueue: new CodexBridgeQueue(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    activeTurnAuthority: new ActiveTurnAuthority(),
    persistCliSessionId: vi.fn(), flushPending: vi.fn(),
    codexBridgeNotifyCliSessionId: vi.fn(), codexBridgeDrainAndMaybeEmit: vi.fn(),
    isOrdinaryImTurnId, isCodexAppCliId,
    WORKFLOW_NODE_SESSION_ENV: 'BOTMUX_WORKFLOW_NODE_SESSION',
    config: { daemon: { backendType: 'pty' }, web: { workerHost: '127.0.0.1' } },
    ordinaryImTurnDedupe: new InputTurnDeduper(),
    configureTraexAutoModel: noop, applyCodexInstanceEnv: noop,
    isCodexFamilyCliId: () => false,
    seedInitTurnTerminals: noop, initializeFinalOutputHandoff: noop,
    applyInitFinalOutputBackpressure: noop, refreshTerminalWriteToken: noop,
    refreshTerminalCardViewToken: noop, applySessionOwnerEnv: noop,
    registerPromptOverrideResolver: noop, sessionLarkTransportEnabled: () => false,
    resolveRenderDimensions: () => ({ cols: 160, rows: 30 }),
    setCaptureIdentity: noop, rememberTurnLinkRefMode: noop,
    reserveActiveTurn: noop, markTurnExecutionStart: noop,
    writeCliPidMarker: noop, publishSandboxRelayCapability: noop,
    backendSupportsWebTerminal: () => false, isWorkflowWorker: () => false,
    startScreenUpdates: noop, startStuckDetector: noop, sandboxEnabled: () => false,
    orchestrateCodexRpcInit: async () => ({ engaged: false, queuePrompt: false }),
    traexAutoModelRuntimeEligible: () => false,
    prepareCodexNativeTitleGeneration: noop,
    codexAppRecoveredDispatches: [], pendingMessages: [],
    takeUnsentInputsFromPredecessor: () => [], shouldQueueInitialPrompt,
    isPromptReady: false, cliAdapter: createTraexAdapter('/bin/true'),
    readSendMarkers: () => [], log: vi.fn(), send: vi.fn(),
    CliSpawnSupersededError: class extends Error {},
    sendFatalWorkerErrorAndExit: async (error: Error) => { throw error; },
  };
  for (const name of ['receiveOrdinaryImTurn', 'acknowledgeTurnInputReceived',
    'acknowledgeTurnInputCommitted', 'watchTraexInitialDelivery',
    'markActiveTurnStarted', 'turnAuthorityIdentity']) h[name] = loadWorkerFunction(name, h);
  const spawnBody = loadWorkerFunction('spawnCliBody', h);
  h.spawnCli = async (cfg: any) => {
    try { await spawnBody(cfg); } catch (error) {
      if (error !== stopBeforeLaunch) throw error;
    }
    // Remaining launch I/O is inert; real init materialization still executes.
  };
  return { h, init: loadWorkerMessageHandler('init', h) };
}

describe('independent TRAE crash recovery probe', () => {
  it('re-ACKs a persisted confirmation after a crash before the daemon commit ACK', async () => {
    const f = deliveryFixture();
    const old = watchHarness(f);
    old.persistCliSessionId.mockImplementation(() => { throw new Error('simulated crash after receipt fsync'); });
    old.watchTraexInitialDelivery({});
    appendFileSync(f.history, `${f.historyLine}\n`);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(readFileSync(f.receipt.path, 'utf8')).state).toBe('confirmed');
    expect(old.ordinaryImTurnDedupe.state('om_first')).toBe('inflight');
    old.backend = null;

    const { h, init } = recoveryInitHarness(f.root);
    const message = {
      type: 'init', sessionId: 'session', cliId: 'traex', backendType: 'pty',
      prompt: 'first task', turnId: 'om_first', workingDir: f.root,
    };
    await init({ ...message });
    expect(h.lastInitConfig).toMatchObject({ prompt: '', resume: true, cliSessionId: 'native-owned' });
    expect(h.pendingMessages).toHaveLength(0);
    // Retry the original daemon message after recovery, well beyond a poll.
    await vi.advanceTimersByTimeAsync(120_000);
    await init({ ...message });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_input_committed', turnId: 'om_first',
    }));
    expect(h.ordinaryImTurnDedupe.state('om_first')).toBe('committed');
  });
});
