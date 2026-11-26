import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { buildAbsorbedTurnSettlementGate, resolvePromotedAbsorbedTurnForCompletion, selectReplyMessageId } from '../src/core/reply-message.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import {
  advanceAncestorSessionTurn,
  findAncestorSessionMarkerContext,
  markerBelongsToLiveProcess,
  parseAbsorbedHostBinding,
  parseSettledAbsorbedTurns,
  readProcessStartIdentity,
  type AncestorSessionContext,
  type QueuedTypeAheadTurn,
} from '../src/core/session-marker.js';
import { isValidMarkerIdentityTurnId } from '../src/core/turn-id-shape.js';
import type { DaemonSession } from '../src/core/types.js';
import { BridgeTurnQueue, makeFingerprint, normaliseForFingerprint } from '../src/services/bridge-turn-queue.js';
import { recordBridgeReplyMarker } from '../src/services/bridge-reply-marker.js';
import { sendCompletionHintKey } from '../src/services/send-completion-hint.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { promptSuggestionReportTurn } from '../src/utils/prompt-suggestion-publisher.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { withFileLockSync } from '../src/utils/file-lock.js';
import { t } from '../src/i18n/index.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const replayWinnerCrashFixture = fileURLToPath(new URL('./fixtures/send-replay-winner-crash.ts', import.meta.url));
const voiceDocFixture = fileURLToPath(new URL('./fixtures/send-voice-doc-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function createWorkerHarness(dataDir: string, initialQueue: Array<Record<string, unknown>> = []) {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  mkdirSync(markersDir, { recursive: true });
  const markerPath = join(markersDir, String(process.pid));
  const microtasks: Array<() => void> = [];
  const scope: Record<string, any> = {
    heldPidMarkerPaths: new Set<string>(),
    existsSync, readFileSync, unlinkSync, basename,
    withFileLockSync, atomicWriteFileSync,
    readProcessStartIdentity, markerBelongsToLiveProcess, isValidMarkerIdentityTurnId,
    parseAbsorbedHostBinding, parseSettledAbsorbedTurns,
    sessionId: 'sid',
    cliPidMarker: markerPath,
    rpcEnginePidMarker: null,
    cliAdapter: { claudeDataDir: '/home/u/.claude' },
    lastInitConfig: { cliId: 'claude-code', cliSessionId: 'native-sid-1234', adoptMode: false, larkAppId: 'cli_test' },
    currentBotmuxTurnId: 'om_A',
    currentBotmuxDispatchAttempt: undefined,
    currentBotmuxCallerOpenId: undefined,
    currentBotmuxLinkRefMode: undefined,
    currentTurnSteerPromoted: false,
    currentVcMeetingImTurnOrigin: undefined,
    sandboxRelayCapability: null,
    activeTurnAuthority: new ActiveTurnAuthority(),
    retiredTurnIds: new Set<string>(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    queuedTypeAheadTurns: initialQueue,
    foldedTypeAheadTurn: undefined,
    queuedTurnAdvanceConsumedForPrompt: undefined,
    ptyOutputGeneration: { snapshot: () => 1 },
    publishActiveTurn: () => {},
    publishSandboxRelayCapability: () => false,
    cancelAntigravityFoldedReconcilePending: () => {},
    log: () => {},
    inflightInputs: { onTurnStarted: vi.fn(), onTurnComplete: vi.fn() },
    lastWrittenCliInput: undefined,
    send: vi.fn(),
    queueMicrotask: (fn: () => void) => { microtasks.push(fn); },
  };
  for (const name of [
    'withPidMarkerLock',
    'markTurnRetired',
    'setCaptureIdentity',
    'markerIdentityTurnId',
    'turnTerminalEmitted',
    'retireTerminatedMarkerTurn',
    'markerQueuedTurnStillLive',
    'turnAuthorityIdentity',
    'markActiveTurnStarted',
    'rememberQueuedTurnAdvanceForPendingReady',
    'activeAuthorityMatchesMarker',
    'adoptInitialActiveTurn',
    'adoptDisplacedActiveTurn',
    'dropQueuedTurnRecord',
    'retireTerminatedQueuedTurn',
    'writeCliPidMarker',
    'restoreQueuedTurnsFromMarkerDisk',
    'syncQueuedTurnsFromMarkerDisk',
    'advanceQueuedTypeAheadTurn',
    'bridgeMarkerPath',
    'readSendMarkers',
    'markReplyInputConsumed',
    'scheduleConsumedQueuedTurnAdvance',
    'acknowledgeNativeInputConsumed',
    'notifyNativeTranscriptConsumedLarkTurn',
  ]) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  scope.markActiveTurnStarted({ turnId: 'om_A' });
  return {
    scope,
    markerPath,
    readMarker: () => JSON.parse(readFileSync(markerPath, 'utf8')),
    flushMicrotasks: () => { for (const fn of microtasks.splice(0)) fn(); },
  };
}

/** Execute the real closure immediately before a new Claude input is written.
 * Unrelated PTY/execution-clock effects are inert; queue, ledger and marker I/O
 * remain the production implementations. */
function prepareIncomingNormalWrite(
  h: ReturnType<typeof createWorkerHarness>,
  dataDir: string,
  item = { turnId: 'om_C', content: 'new message C', dispatchAttempt: undefined },
  beforePrepare?: () => void,
): void {
  Object.assign(h.scope, {
    normalWritePrepared: false,
    webWireWriteRefused: false,
    webTerminalInputWireDirty: () => false,
    item,
    claudeBridgeActive: true,
    bridgeIngest: () => {},
    crossPrincipalIsolationOn: () => false,
    promptReadyAtFlushStart: false,
    itemsWrittenInThisFlush: 0,
    cliSubmissionInFlight: { item, composerOwned: false },
    typedIntoComposer: true,
    renderer: { markNewTurn: () => {} },
    traexAutoModelRuntimeEligible: () => false,
    rememberSubmittedTurnText: () => undefined,
    durableWrite: false,
    writeBackend: {},
    writeRpcEngine: undefined,
    writeAdapter: h.scope.cliAdapter,
    effectiveBackendType: 'pty',
    stuckDetector: undefined,
    noteCliInputWritten: () => {},
    msg: item.content,
    logicalMsg: item.content,
    turnSeq: 0,
    bridgeTurnId: undefined,
    cliGenerationTurnWrites: 0,
    cliSpawnGeneration: 1,
    webTerminalInputGeneration: 0,
    cliInterruptGeneration: 0,
    inputDeliveryEvidence: { start: () => {} },
    codexBridgeActive: false,
    bridgeMarkPendingTurn: () => 'bridge_C',
    bridgeQueue: { holdForWrite: () => {} },
    markTurnExecutionStart: () => {},
    submissionPreparationFailed: false,
  });
  h.scope.inflightInputs.onWrite = () => {};
  h.scope.adoptActiveTurnWhenIsolationOff = loadWorkerFunction('adoptActiveTurnWhenIsolationOff', h.scope);
  h.scope.prepareNormalWrite = loadWorkerFunction('prepareNormalWrite', h.scope);
  const priorDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  beforePrepare?.();
  try { h.scope.prepareNormalWrite(); } finally {
    if (priorDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = priorDataDir;
  }
}

function setupSendFixture(opts: {
  cliId?: string;
  scope?: 'thread' | 'chat';
  queuedTurns?: Array<Record<string, unknown>>;
  extraMarkerFields?: Record<string, unknown>;
  turns?: Array<{ id: string; root?: string; sender: string; crossChat?: boolean }>;
  replyDelivery?: 'send' | 'transcript';
  replyCardMode?: 'legacy' | 'unified';
  crossPrincipalInterruption?: boolean;
} = {}) {
  const home = makeTempDir('claude-absorbed-send-');
  const data = join(home, 'data');
  const markerDir = join(data, '.botmux-cli-pids');
  mkdirSync(markerDir, { recursive: true });
  const markerPath = join(markerDir, String(process.pid));
  const sessionScope = opts.scope ?? 'thread';
  const turns = opts.turns ?? [
    { id: 'om_A', root: 'om_root', sender: 'ou_user_a' },
    { id: 'om_B', root: 'om_root', sender: 'ou_user_a' },
  ];
  writeFileSync(markerPath, JSON.stringify({
    sessionId: 'sid',
    turnId: 'om_A',
    capability: 'cap-token-preserved',
    identityTurnId: 'om_A',
    callerOpenId: 'ou_user_a',
    ...(opts.extraMarkerFields ?? {}),
    ...(opts.queuedTurns && opts.queuedTurns.length > 0
      ? { queuedTurnId: opts.queuedTurns[0]!.turnId, queuedTurns: opts.queuedTurns }
      : {}),
  }));
  writeFileSync(join(home, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test',
    larkAppSecret: 'test',
    cliId: opts.cliId ?? 'claude-code',
    replyCardMode: opts.replyCardMode ?? 'legacy',
    ...(opts.crossPrincipalInterruption ? { crossPrincipalInterruption: true } : {}),
  }]));
  const ds = {
    scope: sessionScope,
    chatId: 'oc_test',
    session: {
      sessionId: 'sid',
      status: 'active',
      cliId: opts.cliId ?? 'claude-code',
      larkAppId: 'cli_test',
      chatId: 'oc_test',
      rootMessageId: sessionScope === 'thread' ? 'om_root' : 'oc_test',
      scope: sessionScope,
      chatType: sessionScope === 'thread' ? 'group' : 'p2p',
      workingDir: home,
    },
  } as DaemonSession;
  for (const turn of turns) {
    ds.session.quoteTargetId = turn.id;
    ds.session.quoteTargetSenderOpenId = turn.sender;
    beginReplyTargetTurn(ds, turn.root, turn.id, new Date().toISOString(), {
      senderOpenId: turn.sender,
      participants: [{ openId: turn.sender, isBot: false }],
      inThread: !!turn.root,
      ...(turn.crossChat
        ? { crossChatOrigin: { sourceChatId: 'oc_test', followedChatId: 'oc_other', followedRootMessageId: 'om_other' } }
        : {}),
    });
  }
  seedPersistedSessionRows(data, 'cli_test', { sid: ds.session });
  return {
    home,
    data,
    markerPath,
    marker: () => JSON.parse(readFileSync(markerPath, 'utf8')),
    run: (args: string[] = [], text = 'answer A and B', script = fixture) => {
      const hasMentionArg = args.some(a => a === '--mention-back' || a === '--no-mention' || a === '--mention' || a.startsWith('--mention='));
      const finalArgs = hasMentionArg ? args : ['--mention-back', ...args];
      const result = spawnSyncTsScript(script, ['send', ...finalArgs, text], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          BOTS_CONFIG: join(home, 'bots.json'),
          SESSION_DATA_DIR: data,
          BOTMUX_SESSION_ID: 'sid',
          BOTMUX_TURN_ID: 'om_A',
          BOTMUX_LARK_APP_ID: 'cli_test',
          ...(opts.replyDelivery ? { BOTMUX_REPLY_DELIVERY: opts.replyDelivery } : {}),
        },
      });
      const writes = String(result.stdout)
        .split('\n')
        .filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      return { ...result, writes };
    },
  };
}

describe('parseAbsorbedHostBinding & parseSettledAbsorbedTurns fail-closed validation', () => {
  it('accepts absorbed binding only when inputConsumed is true and host differs from turnId', () => {
    expect(parseAbsorbedHostBinding({ inputConsumed: true, absorbedIntoTurnId: 'om_A' }, 'om_B'))
      .toEqual({ absorbedIntoTurnId: 'om_A' });
    expect(parseAbsorbedHostBinding({
      inputConsumed: true, absorbedIntoTurnId: 'om_A', absorbedIntoDispatchAttempt: 2,
    }, 'om_B')).toEqual({ absorbedIntoTurnId: 'om_A', absorbedIntoDispatchAttempt: 2 });

    // Missing inputConsumed, self-absorption, control chars, or invalid attempt fail closed.
    expect(parseAbsorbedHostBinding({ absorbedIntoTurnId: 'om_A' }, 'om_B')).toBeUndefined();
    expect(parseAbsorbedHostBinding({ inputConsumed: true, absorbedIntoTurnId: 'om_B' }, 'om_B')).toBeUndefined();
    expect(parseAbsorbedHostBinding({ inputConsumed: true, absorbedIntoTurnId: 'bad\nid' }, 'om_B')).toBeUndefined();
    expect(parseAbsorbedHostBinding({
      inputConsumed: true, absorbedIntoTurnId: 'om_A', absorbedIntoDispatchAttempt: -1,
    }, 'om_B')).toBeUndefined();
    expect(parseAbsorbedHostBinding({
      inputConsumed: true, absorbedIntoTurnId: 'om_A', absorbedIntoDispatchAttempt: '1',
    }, 'om_B')).toBeUndefined();
  });

  it('deduplicates and validates settledAbsorbedTurns entries', () => {
    expect(parseSettledAbsorbedTurns([
      { turnId: 'om_B', hostTurnId: 'om_A' },
      { turnId: 'om_B', hostTurnId: 'om_A' },
      { turnId: 'om_X', hostTurnId: 'om_X' }, // self-ref dropped
      { turnId: 'om_bad', hostTurnId: 'om_A', dispatchAttempt: 0 }, // invalid attempt dropped
      { turnId: 'om_C', hostTurnId: 'om_A', hostDispatchAttempt: 3 },
    ])).toEqual([
      { turnId: 'om_B', hostTurnId: 'om_A' },
      { turnId: 'om_C', hostTurnId: 'om_A', hostDispatchAttempt: 3 },
    ]);
  });
});

describe('advanceAncestorSessionTurn structural settlement', () => {
  const allowAll = () => true;

  it('settles a single absorbed turn in-place without advancing and preserves all host marker fields', () => {
    const dir = makeTempDir('advance-absorbed-single-');
    const markerDir = join(dir, '.botmux-cli-pids');
    mkdirSync(markerDir, { recursive: true });
    const markerPath = join(markerDir, String(process.pid));
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 'sid',
      turnId: 'om_A',
      capability: 'secret-cap',
      identityTurnId: 'om_A',
      callerOpenId: 'ou_alice',
      backgroundHeld: true,
      queuedTurnId: 'om_B',
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    }));

    const result = advanceAncestorSessionTurn(dir, process.pid, 'om_A', { canSettleAbsorbed: allowAll });
    expect(result).toEqual({ advanced: false, turnId: 'om_A', settledAbsorbedTurnIds: ['om_B'] });

    const onDisk = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(onDisk.turnId).toBe('om_A');
    expect(onDisk.capability).toBe('secret-cap');
    expect(onDisk.identityTurnId).toBe('om_A');
    expect(onDisk.callerOpenId).toBe('ou_alice');
    expect(onDisk.backgroundHeld).toBe(true);
    expect(onDisk.queuedTurnId).toBeUndefined();
    expect(onDisk.queuedTurns).toBeUndefined();
    expect(onDisk.settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);
  });

  it('publishes the final marker before the locked queue decision, even if the PID file vanished', () => {
    const dir = makeTempDir('advance-absorbed-final-callback-');
    const markerDir = join(dir, '.botmux-cli-pids');
    mkdirSync(markerDir, { recursive: true });
    const markerPath = join(markerDir, String(process.pid));
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 'sid', turnId: 'om_A',
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    }));
    let markerVisibleBeforeTransition = false;
    const result = advanceAncestorSessionTurn(dir, process.pid, 'om_A', {
      canSettleAbsorbed: allowAll,
      beforeTransition: () => {
        recordBridgeReplyMarker({
          dataDir: dir, sessionId: 'sid', sentAtMs: Date.now(), messageId: 'om_final',
          deliveryKind: 'current_session_send', content: 'done', responseKind: 'final', turnId: 'om_A',
        });
        markerVisibleBeforeTransition = readFileSync(join(dir, 'turn-sends', 'sid.jsonl'), 'utf8').includes('om_final');
      },
    });
    expect(markerVisibleBeforeTransition).toBe(true);
    expect(result.settledAbsorbedTurnIds).toEqual(['om_B']);

    // The delivery journal is still required when the queue no longer exists.
    unlinkSync(markerPath);
    let orphanCallbackCalls = 0;
    expect(advanceAncestorSessionTurn(dir, process.pid, 'om_A', {
      beforeTransition: () => { orphanCallbackCalls++; },
    })).toEqual({ advanced: false });
    expect(orphanCallbackCalls).toBe(1);
  });

  it('settles multiple consecutive absorbed turns [B1, B2] together when no unabsorbed turn follows', () => {
    const dir = makeTempDir('advance-absorbed-multi-');
    const markerDir = join(dir, '.botmux-cli-pids');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, String(process.pid)), JSON.stringify({
      sessionId: 'sid',
      turnId: 'om_A',
      queuedTurns: [
        { turnId: 'om_B1', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
        { turnId: 'om_B2', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
      ],
    }));

    const result = advanceAncestorSessionTurn(dir, process.pid, 'om_A', { canSettleAbsorbed: allowAll });
    expect(result).toEqual({ advanced: false, turnId: 'om_A', settledAbsorbedTurnIds: ['om_B1', 'om_B2'] });
    const ctx = findAncestorSessionMarkerContext(dir, process.pid, 'sid');
    expect(ctx?.turnId).toBe('om_A');
    expect(ctx?.queuedTurns).toBeUndefined();
    expect(ctx?.settledAbsorbedTurns).toEqual([
      { turnId: 'om_B1', hostTurnId: 'om_A' },
      { turnId: 'om_B2', hostTurnId: 'om_A' },
    ]);
  });

  it('skips absorbed B and advances directly to unconsumed C in [B(absorbed), C(unconsumed)]', () => {
    const dir = makeTempDir('advance-absorbed-mixed-');
    const markerDir = join(dir, '.botmux-cli-pids');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, String(process.pid)), JSON.stringify({
      sessionId: 'sid',
      turnId: 'om_A',
      queuedTurns: [
        { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
        { turnId: 'om_C' },
      ],
    }));

    const result = advanceAncestorSessionTurn(dir, process.pid, 'om_A', { canSettleAbsorbed: allowAll });
    expect(result).toEqual({ advanced: true, turnId: 'om_C', settledAbsorbedTurnIds: ['om_B'] });
    const ctx = findAncestorSessionMarkerContext(dir, process.pid, 'sid');
    expect(ctx?.turnId).toBe('om_C');
    expect(ctx?.steerPromotedTurn).toBe(true);
    expect(ctx?.queuedTurns).toBeUndefined();
    expect(ctx?.settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);
  });

  it('never settles bare inputConsumed (Codex / standalone Claude), mismatched host, durable, scheduled, or omitted gate', () => {
    const cases: Array<{ name: string; marker: Record<string, unknown>; opts?: { canSettleAbsorbed?: () => boolean } }> = [
      {
        name: 'bare inputConsumed without absorbedIntoTurnId (Codex / Claude standalone)',
        marker: { sessionId: 'sid', turnId: 'om_A', queuedTurns: [{ turnId: 'om_B', inputConsumed: true }] },
        opts: { canSettleAbsorbed: allowAll },
      },
      {
        name: 'absorbed into different host (e.g. local-* turn)',
        marker: { sessionId: 'sid', turnId: 'om_A', queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'local-1' }] },
        opts: { canSettleAbsorbed: allowAll },
      },
      {
        name: 'durable queued turn (dispatchAttempt set)',
        marker: { sessionId: 'sid', turnId: 'om_A', queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A', dispatchAttempt: 1 }] },
        opts: { canSettleAbsorbed: allowAll },
      },
      {
        name: 'scheduled queued turn',
        marker: { sessionId: 'sid', turnId: 'om_A', queuedTurns: [{ turnId: 'schedule:t1:11111111-2222-3333-4444-555555555555', inputConsumed: true, absorbedIntoTurnId: 'om_A' }] },
        opts: { canSettleAbsorbed: allowAll },
      },
      {
        name: 'workflow queued turn',
        marker: { sessionId: 'sid', turnId: 'om_A', queuedTurns: [{ turnId: 'wf:run1:node1', inputConsumed: true, absorbedIntoTurnId: 'om_A' }] },
        opts: { canSettleAbsorbed: allowAll },
      },
      {
        name: 'omitted canSettleAbsorbed gate (fail-closed catch-up loop)',
        marker: { sessionId: 'sid', turnId: 'om_A', queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }] },
      },
    ];
    for (const tc of cases) {
      const dir = makeTempDir('advance-absorbed-refuse-');
      const markerDir = join(dir, '.botmux-cli-pids');
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(join(markerDir, String(process.pid)), JSON.stringify(tc.marker));
      const expectedNext = (tc.marker.queuedTurns as Array<{ turnId: string }>)[0]!.turnId;
      const result = advanceAncestorSessionTurn(dir, process.pid, 'om_A', tc.opts);
      expect(result, tc.name).toEqual({ advanced: true, turnId: expectedNext });
    }
  });
});

describe('buildAbsorbedTurnSettlementGate & selectReplyMessageId invariants', () => {
  const alice = { requestUserOpenId: 'ou_alice', requestLarkAppId: 'cli_test', senderType: 'user' as const };
  const bob = { requestUserOpenId: 'ou_bob', requestLarkAppId: 'cli_test', senderType: 'user' as const };
  const baseMarker: AncestorSessionContext = {
    sessionId: 'sid',
    turnId: 'om_A',
    trustedCaller: alice,
    queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A', trustedCaller: alice }],
  };
  const baseTurn: QueuedTypeAheadTurn = baseMarker.queuedTurns![0]!;

  it('enforces TOCTOU snapshot, --reply-to, destination match, privateReply, crossChat, and XPI gates', () => {
    const baseCtx = {
      session: {
        sessionId: 'sid',
        scope: 'chat' as const,
        turnReplyContexts: {
          om_A: { target: { mode: 'thread', rootMessageId: 'om_topic_1' }, replyTargetSenderOpenId: 'ou_alice' },
          om_B: { target: { mode: 'plain', chatId: 'oc_main' }, replyTargetSenderOpenId: 'ou_alice' },
        },
      },
      originSessionId: 'sid',
      originDispatchAttempt: undefined,
      preSendAbsorbedTurnIds: new Set(['om_B']),
      actualDeliveredTarget: { mode: 'plain' as const, chatId: 'oc_main' },
      privateReply: false,
      replyTargetSenderOpenId: 'ou_alice',
      explicitReplyTo: undefined,
      routingOverride: false,
      excludedSendKind: false,
      crossPrincipalInterruption: false,
    };

    expect(buildAbsorbedTurnSettlementGate(baseCtx)(baseTurn, baseMarker)).toBe(true);
    // TOCTOU: empty snapshot OR a later turn om_D absorbed mid-HTTP while om_B was in snapshot
    expect(buildAbsorbedTurnSettlementGate({ ...baseCtx, preSendAbsorbedTurnIds: new Set() })(baseTurn, baseMarker)).toBe(false);
    const lateTurnD: QueuedTypeAheadTurn = { turnId: 'om_D', inputConsumed: true, absorbedIntoTurnId: 'om_A', trustedCaller: alice };
    expect(buildAbsorbedTurnSettlementGate({
      ...baseCtx,
      session: {
        ...baseCtx.session,
        turnReplyContexts: {
          ...baseCtx.session.turnReplyContexts,
          om_D: { target: { mode: 'plain', chatId: 'oc_main' }, replyTargetSenderOpenId: 'ou_alice' },
        },
      },
    })(lateTurnD, baseMarker)).toBe(false);
    // Explicit --reply-to om_A excludes om_B; --reply-to om_B permits it
    expect(buildAbsorbedTurnSettlementGate({ ...baseCtx, explicitReplyTo: 'om_A' })(baseTurn, baseMarker)).toBe(false);
    expect(buildAbsorbedTurnSettlementGate({ ...baseCtx, explicitReplyTo: 'om_B' })(baseTurn, baseMarker)).toBe(true);
    // Destination mismatch (e.g. unified reply card patched in topic_1 while B is in oc_main)
    expect(buildAbsorbedTurnSettlementGate({
      ...baseCtx,
      actualDeliveredTarget: { mode: 'thread', rootMessageId: 'om_topic_1' },
    })(baseTurn, baseMarker)).toBe(false);
    // Explicit routing override (--top-level / --into / --chat-id / --quote)
    expect(buildAbsorbedTurnSettlementGate({ ...baseCtx, routingOverride: true })(baseTurn, baseMarker)).toBe(false);
    // Private reply: same sender allowed, different sender rejected
    expect(buildAbsorbedTurnSettlementGate({ ...baseCtx, privateReply: true })(baseTurn, baseMarker)).toBe(true);
    expect(buildAbsorbedTurnSettlementGate({
      ...baseCtx,
      privateReply: true,
      replyTargetSenderOpenId: 'ou_bob',
    })(baseTurn, baseMarker)).toBe(false);
    // Cross-principal isolation: collaborative allowed when XPI off, rejected when XPI on
    const bobTurn: QueuedTypeAheadTurn = { ...baseTurn, trustedCaller: bob };
    expect(buildAbsorbedTurnSettlementGate({ ...baseCtx, crossPrincipalInterruption: false })(bobTurn, baseMarker)).toBe(true);
    expect(buildAbsorbedTurnSettlementGate({ ...baseCtx, crossPrincipalInterruption: true })(bobTurn, baseMarker)).toBe(false);
    // Cross-chat origin rejected
    expect(buildAbsorbedTurnSettlementGate({
      ...baseCtx,
      session: {
        ...baseCtx.session,
        turnReplyContexts: {
          ...baseCtx.session.turnReplyContexts,
          om_B: {
            ...baseCtx.session.turnReplyContexts.om_B,
            crossChatOrigin: { sourceChatId: 'oc_main', followedChatId: 'oc_other', followedRootMessageId: 'om_other' },
          },
        },
      },
    })(baseTurn, baseMarker)).toBe(false);
  });

  it('selectReplyMessageId keeps addressing settled absorbed B for idempotent replays and auxiliary supplements', () => {
    const session = {
      sessionId: 'sid',
      turnReplyContexts: {
        om_A: { target: { mode: 'thread', rootMessageId: 'om_topic_1' } },
        om_B: { target: { mode: 'plain', chatId: 'oc_main' } },
        om_C: { target: { mode: 'thread', rootMessageId: 'om_topic_2' } },
      },
    };
    const afterSettle: AncestorSessionContext = {
      sessionId: 'sid',
      turnId: 'om_A',
      settledAbsorbedTurns: [{ turnId: 'om_B', hostTurnId: 'om_A' }],
    };
    expect(selectReplyMessageId(session, 'om_A', afterSettle)).toBe('om_B');
    // Newer consumed queued turn still outranks settled turns
    expect(selectReplyMessageId(session, 'om_A', {
      ...afterSettle,
      queuedTurns: [{ turnId: 'om_C', inputConsumed: true }],
    })).toBe('om_C');
    // Another execution turn never inherits A's settled turns
    expect(selectReplyMessageId(session, 'om_C', {
      ...afterSettle,
      turnId: 'om_C',
    })).toBe('om_C');
  });
});

describe('Claude transcript -> BridgeTurnQueue -> worker marker -> botmux send end-to-end', () => {
  it('① mid-turn absorbed B settles with A final, emits after_success_hint (no steer_advanced), blocks duplicate final, and allows auxiliary & replay', () => {
    const dataDir = makeTempDir('claude-absorbed-e2e-worker-');
    const h = createWorkerHarness(dataDir, [{ turnId: 'om_B' }]);
    const queue = new BridgeTurnQueue(
      undefined,
      undefined,
      (turn, evidence) => h.scope.notifyNativeTranscriptConsumedLarkTurn(turn, evidence),
    );
    const msgA = '把表 X 拆成两组，再写方案文档';
    const msgB = '其他几组也一起拆了吧';
    queue.mark('om_A', makeFingerprint(msgA), 1000, normaliseForFingerprint(msgA));
    queue.mark('om_B', makeFingerprint(msgB), 2000, normaliseForFingerprint(msgB));

    // Real Claude JSONL sequence: A starts -> tool_use -> B enqueued -> tool_result
    // -> remove(reason=absorbed_mid_turn) -> attachment(queued_command, system-reminder).
    queue.ingest([
      { type: 'user', uuid: 'u1', timestamp: '2026-11-26T00:00:01.000Z', message: { role: 'user', content: msgA } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-11-26T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }], stop_reason: 'tool_use' } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-26T00:00:03.000Z', content: msgB },
      { type: 'user', uuid: 'u2', timestamp: '2026-11-26T00:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
      { type: 'queue-operation', operation: 'remove', timestamp: '2026-11-26T00:00:05.000Z', content: msgB, reason: 'absorbed_mid_turn', commandUuid: 'cmd-1' } as any,
      {
        type: 'attachment',
        uuid: 'att1',
        timestamp: '2026-11-26T00:00:05.001Z',
        attachment: { type: 'queued_command', prompt: msgB, commandMode: 'prompt' },
        renderedRole: 'system',
        rendered: [{ content: `<system-reminder>\nThe user sent a new message while you were working:\n${msgB}\n</system-reminder>` }],
      } as any,
    ], '/home/u/.claude/projects/p/0f3c1d2e-aaaa-bbbb-cccc-1234567890ab.jsonl');

    // Worker propagated absorbedIntoTurnId into PID marker alongside inputConsumed.
    expect(h.readMarker().turnId).toBe('om_A');
    expect(h.readMarker().queuedTurns).toEqual([
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);

    // Real botmux send --response-kind final subprocess in a Claude topic session.
    const f = setupSendFixture({
      queuedTurns: h.readMarker().queuedTurns,
    });
    const first = f.run(['--response-kind', 'final'], 'Combined answer for A and B');
    expect(first.status, String(first.stderr)).toBe(0);
    expect(first.writes).toHaveLength(1);
    expect(String(first.stderr)).toContain(t('ai.send.after_success_hint', undefined, 'zh'));
    expect(String(first.stderr)).not.toContain(t('ai.send.after_success_steer_advanced', undefined, 'zh'));
    expect(f.marker().turnId).toBe('om_A');
    expect(f.marker().queuedTurns).toBeUndefined();
    expect(f.marker().settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);
    expect(f.marker().capability).toBe('cap-token-preserved');

    // A hallucinated second --response-kind final with different text is mechanically blocked!
    const dupFinal = f.run(['--response-kind', 'final'], '上一条消息已经回答了 B');
    expect(dupFinal.status).toBe(2);
    expect(dupFinal.writes).toHaveLength(0);

    // An idempotent retry of the exact same final replays cleanly.
    const replay = f.run(['--response-kind', 'final'], 'Combined answer for A and B');
    expect(replay.status, String(replay.stderr)).toBe(0);
    expect(replay.writes).toHaveLength(0);

    // A genuine post-final supplement with --response-kind auxiliary succeeds.
    const aux = f.run(['--response-kind', 'auxiliary'], 'P.S. extra note');
    expect(aux.status, String(aux.stderr)).toBe(0);
    expect(aux.writes).toHaveLength(1);
    expect(String(aux.stderr)).toContain(t('ai.send.after_success_auxiliary', undefined, 'zh'));
  });

  it('①b transcript delivery mode emits no steer-advance notice when absorbed B settles with A final', () => {
    const f = setupSendFixture({
      replyDelivery: 'transcript',
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const res = f.run(['--response-kind', 'final'], 'Combined answer');
    expect(res.status, String(res.stderr)).toBe(0);
    expect(String(res.stderr)).not.toContain(t('ai.send.after_success_steer_advanced_transcript', undefined, 'zh'));
    expect(String(res.stderr)).not.toContain('BOTMUX_NOTHING_TO_SEND');
    expect(f.marker().turnId).toBe('om_A');
  });

  it('② unconsumed B (not yet absorbed) still advances to B and requires a separate final', () => {
    const f = setupSendFixture({
      queuedTurns: [{ turnId: 'om_B' }],
    });
    const first = f.run(['--response-kind', 'final'], 'Answer A only');
    expect(first.status, String(first.stderr)).toBe(0);
    expect(String(first.stderr)).toContain(t('ai.send.after_success_steer_advanced', undefined, 'zh'));
    expect(f.marker().turnId).toBe('om_B');
    expect(f.marker().steerPromotedTurn).toBe(true);

    const second = f.run(['--response-kind', 'final'], 'Answer B');
    expect(second.status, String(second.stderr)).toBe(0);
    expect(second.writes).toHaveLength(1);
  });

  it('③ [B(absorbedInto: A), C(unconsumed)] settles B and advances directly to C', () => {
    const f = setupSendFixture({
      turns: [
        { id: 'om_A', root: 'om_root', sender: 'ou_user_a' },
        { id: 'om_B', root: 'om_root', sender: 'ou_user_a' },
        { id: 'om_C', root: 'om_root', sender: 'ou_user_a' },
      ],
      queuedTurns: [
        { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
        { turnId: 'om_C' },
      ],
    });
    const first = f.run(['--response-kind', 'final'], 'Answer A+B');
    expect(first.status, String(first.stderr)).toBe(0);
    expect(String(first.stderr)).toContain(t('ai.send.after_success_steer_advanced', undefined, 'zh'));
    expect(f.marker().turnId).toBe('om_C');
    expect(f.marker().steerPromotedTurn).toBe(true);
    expect(f.marker().queuedTurns).toBeUndefined();
    expect(f.marker().settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);

    const second = f.run(['--response-kind', 'final'], 'Answer C');
    expect(second.status, String(second.stderr)).toBe(0);
    expect(second.writes).toHaveLength(1);
  });

  it('④ chat-scope: default final addresses B and settles B (and keeps B on replay/aux), while --reply-to om_A advances to B', () => {
    const turns = [
      { id: 'om_A', root: 'om_topic_1', sender: 'ou_first' },
      { id: 'om_B', root: undefined, sender: 'ou_second' },
    ];
    // Default send routes to B (main chat) -> matches B's destination -> settles B.
    const f1 = setupSendFixture({
      scope: 'chat',
      turns,
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const r1 = f1.run(['--response-kind', 'final', '--mention-back'], 'Combined answer in main chat');
    expect(r1.status, String(r1.stderr)).toBe(0);
    expect(r1.writes[0].path).toBe('/open-apis/im/v1/messages');
    expect(r1.writes[0].body.content).toContain('ou_second');
    expect(f1.marker().turnId).toBe('om_A');
    expect(f1.marker().settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);

    // Idempotent replay hashes the exact same om_B target & sender -> succeeds!
    const r1Replay = f1.run(['--response-kind', 'final', '--mention-back'], 'Combined answer in main chat');
    expect(r1Replay.status, String(r1Replay.stderr)).toBe(0);
    expect(r1Replay.writes).toHaveLength(0);

    // Post-final auxiliary still routes to main chat / ou_second, not topic_1 / ou_first!
    const r1Aux = f1.run(['--response-kind', 'auxiliary', '--mention-back'], 'Supplement');
    expect(r1Aux.status, String(r1Aux.stderr)).toBe(0);
    expect(r1Aux.writes[0].path).toBe('/open-apis/im/v1/messages');
    expect(r1Aux.writes[0].body.content).toContain('ou_second');

    // Explicit --reply-to om_A routes to topic_1 -> does NOT settle B, advances to B!
    const f2 = setupSendFixture({
      scope: 'chat',
      turns,
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const r2 = f2.run(['--response-kind', 'final', '--reply-to', 'om_A', '--mention-back'], 'Answer A in topic');
    expect(r2.status, String(r2.stderr)).toBe(0);
    expect(r2.writes[0].path).toBe('/open-apis/im/v1/messages/om_topic_1/reply');
    expect(f2.marker().turnId).toBe('om_B');
    const r2b = f2.run(['--response-kind', 'final', '--mention-back'], 'Answer B in main chat');
    expect(r2b.status, String(r2b.stderr)).toBe(0);
    expect(r2b.writes[0].path).not.toBe('/open-apis/im/v1/messages/om_topic_1/reply');
    expect(r2b.writes[0].body.reply_in_thread).not.toBe(true);
    expect(r2b.writes[0].body.content).toContain('ou_second');
    expect(r2b.writes[0].body.content).not.toContain('ou_first');
  }, 30_000);

  it('④b Claude standalone queued turn (handleTurnStart) never sets absorbedIntoTurnId and still advances', () => {
    const dataDir = makeTempDir('claude-standalone-');
    const h = createWorkerHarness(dataDir, [{ turnId: 'om_B' }]);
    const queue = new BridgeTurnQueue(
      undefined,
      undefined,
      (turn, evidence) => h.scope.notifyNativeTranscriptConsumedLarkTurn(turn, evidence),
    );
    const msgA = 'First task prompt';
    const msgB = 'Second standalone task prompt';
    queue.mark('om_A', makeFingerprint(msgA), 1000, normaliseForFingerprint(msgA));
    queue.mark('om_B', makeFingerprint(msgB), 2000, normaliseForFingerprint(msgB));

    // A completes with turn_duration, then B dequeues as an independent turn (no system-reminder).
    queue.ingest([
      { type: 'user', uuid: 'u1', timestamp: '2026-11-26T00:00:01.000Z', message: { role: 'user', content: msgA } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-11-26T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done A' }], stop_reason: 'end_turn' } },
      { type: 'system', subtype: 'turn_duration', uuid: 'td1', timestamp: '2026-11-26T00:00:03.000Z' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-11-26T00:00:04.000Z' },
      {
        type: 'attachment',
        uuid: 'att_standalone',
        timestamp: '2026-11-26T00:00:04.001Z',
        attachment: { type: 'queued_command', prompt: msgB, commandMode: 'prompt' },
      } as any,
    ], '/home/u/.claude/projects/p/0f3c1d2e-aaaa-bbbb-cccc-1234567890ab.jsonl');

    expect(h.readMarker().queuedTurns).toEqual([{ turnId: 'om_B', inputConsumed: true }]);
    expect(h.readMarker().queuedTurns[0].absorbedIntoTurnId).toBeUndefined();
  });
});

describe('worker <-> PID marker synchronization & lifecycle invariants', () => {
  it('never resurrects settled B on subsequent writeCliPidMarker and preserves foldedTypeAheadTurn at turn_terminal', () => {
    const dataDir = makeTempDir('worker-sync-settled-');
    const h = createWorkerHarness(dataDir, [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }]);
    h.scope.writeCliPidMarker();
    expect(h.readMarker().queuedTurns).toEqual([{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }]);

    // botmux send settles B on disk while worker memory still holds B in queuedTypeAheadTurns.
    const adv = advanceAncestorSessionTurn(dataDir, process.pid, 'om_A', { canSettleAbsorbed: () => true });
    expect(adv).toEqual({ advanced: false, turnId: 'om_A', settledAbsorbedTurnIds: ['om_B'] });

    // Worker writes the marker again (e.g., before turn_duration): B must NOT be resurrected!
    h.scope.writeCliPidMarker();
    expect(h.scope.queuedTypeAheadTurns).toEqual([]);
    expect(h.readMarker().queuedTurns).toBeUndefined();
    expect(h.readMarker().settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);
    expect(h.scope.send).toHaveBeenCalledWith({ type: 'type_ahead_turn_dropped', turnId: 'om_B' });

    // syncQueuedTurnsFromMarkerDisk returns false when only settled turns were pruned (no active turn change).
    expect(h.scope.syncQueuedTurnsFromMarkerDisk()).toBe(false);

    // Later turn_duration emits terminals for A and B: foldedTypeAheadTurn is still recorded and disk clears settledAbsorbedTurns.
    h.scope.emittedTurnTerminals.claim('sid', 'om_A', undefined, 'completed');
    h.scope.emittedTurnTerminals.claim('sid', 'om_B', undefined, 'completed');
    h.scope.retireTerminatedQueuedTurn('om_B', undefined, 'completed');
    expect(promptSuggestionReportTurn(
      { turnId: h.scope.currentBotmuxTurnId },
      h.scope.foldedTypeAheadTurn,
      (tid: string, attempt?: number) => h.scope.turnTerminalEmitted(tid, attempt),
    )).toEqual({ turnId: 'om_B', dispatchAttempt: undefined });
    expect(h.readMarker().settledAbsorbedTurns).toBeUndefined();
  });

  it('Scenario B reversal: worker still adopts disk promotion of B when B was absorbed AFTER A final already promoted B', () => {
    const dataDir = makeTempDir('worker-scenario-b-');
    const h = createWorkerHarness(dataDir, [{ turnId: 'om_B' }]);
    h.scope.writeCliPidMarker();

    // A's final ran while B was unconsumed -> disk legitimately promoted marker to om_B.
    const adv = advanceAncestorSessionTurn(dataDir, process.pid, 'om_A', { canSettleAbsorbed: () => true });
    expect(adv).toEqual({ advanced: true, turnId: 'om_B' });

    // Claude then absorbs B into still-open A and worker observes it.
    h.scope.markReplyInputConsumed('om_B', undefined, { hostTurnId: 'om_A' });

    // Worker MUST adopt om_B from disk (never overwrite disk back to om_A).
    expect(h.scope.currentBotmuxTurnId).toBe('om_B');
    expect(h.readMarker().turnId).toBe('om_B');
    expect(h.scope.activeTurnAuthority.snapshot()?.turnId).toBe('om_B');
  });

  it('never promotes absorbed B via scheduleConsumedQueuedTurnAdvance or prompt_ready, while still promoting standalone C (#3519)', () => {
    const dataDir = makeTempDir('worker-authority-absorbed-');
    const h = createWorkerHarness(dataDir, [
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
      { turnId: 'om_C', inputConsumed: true },
    ]);
    h.scope.writeCliPidMarker();

    // Spurious mid-turn prompt_ready while A has not terminated: neither B nor C is promoted.
    expect(h.scope.advanceQueuedTypeAheadTurn('prompt_ready')).toBe(false);
    expect(h.scope.currentBotmuxTurnId).toBe('om_A');
    expect(h.scope.queuedTypeAheadTurns.map((t: { turnId: string }) => t.turnId)).toEqual(['om_B', 'om_C']);

    // Once A terminates and releases authority (even before B's terminal runs),
    // scheduleConsumedQueuedTurnAdvance skips absorbed B and hands authority to standalone C.
    h.scope.emittedTurnTerminals.claim('sid', 'om_A', undefined, 'completed');
    h.scope.activeTurnAuthority.clear();
    h.scope.scheduleConsumedQueuedTurnAdvance();
    h.flushMicrotasks();

    expect(h.scope.currentBotmuxTurnId).toBe('om_C');
    expect(h.scope.activeTurnAuthority.snapshot()?.turnId).toBe('om_C');
    expect(h.scope.retiredTurnIds.has('om_B')).toBe(true);
    expect(h.scope.send).toHaveBeenCalledWith({ type: 'type_ahead_turn_dropped', turnId: 'om_B' });
  });

  it('preserves absorbedIntoTurnId across worker restart (restoreQueuedTurnsFromMarkerDisk) and disk merge', () => {
    const dataDir = makeTempDir('worker-restart-absorbed-');
    const first = createWorkerHarness(dataDir, [{ turnId: 'om_B' }]);
    first.scope.acknowledgeNativeInputConsumed('om_B', 'claude_transcript_user_record', 'native-sid', undefined, undefined, { hostTurnId: 'om_A' });
    expect(first.readMarker().queuedTurns).toEqual([
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);

    const restored = createWorkerHarness(dataDir, []);
    restored.scope.restoreQueuedTurnsFromMarkerDisk(restored.markerPath);
    expect(restored.scope.queuedTypeAheadTurns).toEqual([
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);

    // Existing in-memory entry without absorbedIntoTurnId merges monotonically from disk.
    const merged = createWorkerHarness(dataDir, [{ turnId: 'om_B' }]);
    merged.scope.writeCliPidMarker();
    expect(merged.scope.queuedTypeAheadTurns).toEqual([
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);
    expect(merged.readMarker().queuedTurns).toEqual([
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);
  });

  it('retires skipped absorbed prefix cleanly when syncing A -> C advance from disk', () => {
    const dataDir = makeTempDir('worker-sync-skip-prefix-');
    const h = createWorkerHarness(dataDir, [
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
      { turnId: 'om_C' },
    ]);
    h.scope.writeCliPidMarker();

    const adv = advanceAncestorSessionTurn(dataDir, process.pid, 'om_A', { canSettleAbsorbed: () => true });
    expect(adv).toEqual({ advanced: true, turnId: 'om_C', settledAbsorbedTurnIds: ['om_B'] });

    expect(h.scope.syncQueuedTurnsFromMarkerDisk()).toBe(true);
    expect(h.scope.currentBotmuxTurnId).toBe('om_C');
    expect(h.scope.queuedTypeAheadTurns).toEqual([]);
    expect(h.scope.retiredTurnIds.has('om_B')).toBe(true);
    expect(h.scope.send).toHaveBeenCalledWith({ type: 'type_ahead_turn_dropped', turnId: 'om_B' });
  });

  it('distinguishes authorized, rejected, unknown and legacy final state across lock failures', async () => {
    const cases: Array<{
      mode: string;
      authorization: string[];
      lock: boolean;
      terminal: boolean;
      corrupt?: boolean;
      legacy?: boolean;
      expected: 'settled' | 'retained' | 'promoted';
    }> = [
      { mode: 'authorized-control', authorization: ['om_B'], lock: false, terminal: false, expected: 'settled' },
      { mode: 'authorized-lock-timeout', authorization: ['om_B'], lock: true, terminal: false, expected: 'retained' },
      { mode: 'rejected-lock-timeout-terminal', authorization: [], lock: true, terminal: true, expected: 'retained' },
      { mode: 'unreadable-ledger', authorization: ['om_B'], corrupt: true, lock: false, terminal: false, expected: 'retained' },
      { mode: 'legacy-no-ledger', authorization: [], legacy: true, lock: false, terminal: false, expected: 'promoted' },
    ];
    for (const tc of cases) {
      const dataDir = makeTempDir(`worker-final-${tc.mode}-`);
      const h = createWorkerHarness(dataDir, [
        { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
      ]);
      h.scope.advanceQueuedTypeAheadTurnAfterFinal = loadWorkerFunction('advanceQueuedTypeAheadTurnAfterFinal', h.scope);
      const key = { larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_A' };
      const ledger = new TurnSendLedger(dataDir);
      if (!tc.legacy) {
        await ledger.execute(key, 'final', 'Answer A', async () => 'om_A_final', {
          resolveSettledAbsorbedTurnIds: () => [...tc.authorization],
        });
        if (tc.corrupt) writeFileSync(ledger.recordPath(key), '{not-json');
      }
      recordBridgeReplyMarker({
        dataDir, sessionId: 'sid', sentAtMs: Date.now(), messageId: 'om_A_final',
        deliveryKind: 'current_session_send', content: 'Answer A', responseKind: 'final', turnId: 'om_A',
      });
      if (tc.terminal) h.scope.emittedTurnTerminals.claim('sid', 'om_A', undefined, 'completed');
      const previous = process.env.SESSION_DATA_DIR;
      process.env.SESSION_DATA_DIR = dataDir;
      try {
        if (tc.lock) {
          withFileLockSync(h.markerPath, () => {
            const realNow = Date.now;
            let ticks = 0;
            Date.now = () => realNow() + (++ticks * 6_000);
            try { h.scope.advanceQueuedTypeAheadTurnAfterFinal(); }
            finally { Date.now = realNow; }
          });
        } else {
          h.scope.advanceQueuedTypeAheadTurnAfterFinal();
        }
        h.scope.writeCliPidMarker();
      } finally {
        if (previous === undefined) delete process.env.SESSION_DATA_DIR;
        else process.env.SESSION_DATA_DIR = previous;
      }
      if (tc.expected === 'settled') {
        expect(h.scope.currentBotmuxTurnId, tc.mode).toBe('om_A');
        expect(h.scope.queuedTypeAheadTurns, tc.mode).toEqual([]);
        expect(h.readMarker().settledAbsorbedTurns, tc.mode).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);
      } else if (tc.expected === 'retained') {
        expect(h.scope.currentBotmuxTurnId, tc.mode).toBe('om_A');
        expect(h.scope.queuedTypeAheadTurns.map((turn: { turnId: string }) => turn.turnId), tc.mode).toEqual(['om_B']);
        expect(h.readMarker().turnId, tc.mode).toBe('om_A');
        expect(h.readMarker().settledAbsorbedTurns, tc.mode).toBeUndefined();
        expect(h.readMarker().queuedTurns, tc.mode).toEqual([
          { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
        ]);
      } else {
        expect(h.scope.currentBotmuxTurnId, tc.mode).toBe('om_B');
        expect(h.scope.queuedTypeAheadTurns, tc.mode).toEqual([]);
        expect(h.readMarker().turnId, tc.mode).toBe('om_B');
        expect(h.readMarker().settledAbsorbedTurns, tc.mode).toBeUndefined();
      }
    }
  });

  it('keeps every live settled turn across the historical 32-entry boundary until worker synchronization', () => {
    const dataDir = makeTempDir('worker-settled-over-32-');
    const queue = Array.from({ length: 33 }, (_, index) => ({
      turnId: `om_B${index + 1}`, inputConsumed: true as const, absorbedIntoTurnId: 'om_A',
    }));
    const h = createWorkerHarness(dataDir, queue);
    h.scope.writeCliPidMarker();

    const adv = advanceAncestorSessionTurn(dataDir, process.pid, 'om_A', { canSettleAbsorbed: () => true });
    expect(adv.advanced).toBe(false);
    expect(adv.settledAbsorbedTurnIds).toHaveLength(33);
    expect(h.readMarker().settledAbsorbedTurns).toHaveLength(33);

    // No entry may reappear merely because an in-memory cap or persisted-history
    // cap was smaller than the live absorbed batch.
    h.scope.writeCliPidMarker();
    expect(h.scope.queuedTypeAheadTurns).toEqual([]);
    expect(h.readMarker().queuedTurns).toBeUndefined();
    const session = {
      sessionId: 'sid',
      turnReplyContexts: Object.fromEntries(queue.map(turn => [turn.turnId, {
        target: { mode: 'thread', rootMessageId: 'om_root' },
      }])),
    };
    const normalizedMarker = { ...h.readMarker(), dispatchAttempt: undefined };
    expect(selectReplyMessageId(session, 'om_A', normalizedMarker)).toBe('om_B33');
  });

  it('syncSettledAbsorbedTurnsFromParsed never tombstones a live durable retry (dispatchAttempt 2) or active disk turnId', () => {
    const dataDir = makeTempDir('worker-settled-durable-sibling-');
    const h = createWorkerHarness(dataDir, []);
    h.scope.currentBotmuxTurnId = undefined;
    h.scope.activeTurnAuthority.clear();
    writeFileSync(h.markerPath, JSON.stringify({
      sessionId: 'sid',
      turnId: 'om_A',
      queuedTurns: [{ turnId: 'om_B', dispatchAttempt: 2 }],
      settledAbsorbedTurns: [{ turnId: 'om_B', dispatchAttempt: 1, hostTurnId: 'om_A' }],
    }));

    h.scope.restoreQueuedTurnsFromMarkerDisk(h.markerPath);
    expect(h.scope.retiredTurnIds.has('om_B')).toBe(false);
    expect(h.scope.queuedTypeAheadTurns).toEqual([{ turnId: 'om_B', dispatchAttempt: 2 }]);

    // Active durable retry attempt: 2 on disk must also survive restore.
    const dataDir2 = makeTempDir('worker-settled-durable-active-');
    const h2 = createWorkerHarness(dataDir2, []);
    h2.scope.currentBotmuxTurnId = undefined;
    h2.scope.activeTurnAuthority.clear();
    writeFileSync(h2.markerPath, JSON.stringify({
      sessionId: 'sid',
      turnId: 'om_B',
      dispatchAttempt: 2,
      settledAbsorbedTurns: [{ turnId: 'om_B', dispatchAttempt: 1, hostTurnId: 'om_A' }],
    }));
    h2.scope.restoreQueuedTurnsFromMarkerDisk(h2.markerPath);
    expect(h2.scope.retiredTurnIds.has('om_B')).toBe(false);
    expect(h2.scope.currentBotmuxTurnId).toBe('om_B');
    expect(h2.scope.currentBotmuxDispatchAttempt).toBe(2);

    // Malformed marker listing parsed.turnId inside settledAbsorbedTurns must not wipe parsed.turnId.
    const dataDir3 = makeTempDir('worker-settled-malformed-active-');
    const h3 = createWorkerHarness(dataDir3, []);
    h3.scope.currentBotmuxTurnId = undefined;
    h3.scope.activeTurnAuthority.clear();
    writeFileSync(h3.markerPath, JSON.stringify({
      sessionId: 'sid',
      turnId: 'om_B',
      settledAbsorbedTurns: [{ turnId: 'om_B', hostTurnId: 'om_A' }],
    }));
    h3.scope.restoreQueuedTurnsFromMarkerDisk(h3.markerPath);
    expect(h3.scope.currentBotmuxTurnId).toBe('om_B');
  });

  it('emitTurnTerminal triggers scheduleConsumedQueuedTurnAdvance for standalone C even when prompt_ready already released A authority', () => {
    const dataDir = makeTempDir('worker-terminal-after-prompt-ready-');
    const h = createWorkerHarness(dataDir, [
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
      { turnId: 'om_C', inputConsumed: true },
    ]);
    h.scope.workerSessionEventScope = undefined;
    h.scope.traexQuotaPending = undefined;
    h.scope.traexModelAccessSwitchNotice = undefined;
    h.scope.cancelSubmitFailureChainForTerminal = () => {};
    h.scope.submitFailureChains = new Map();
    h.scope.cliSpawnGeneration = 1;
    h.scope.turnExecutionClock = { settle: () => undefined, forget: () => {} };
    h.scope.traexAutoModelController = undefined;
    h.scope.codexBridgeQueue = { dropPendingTurn: () => false };
    h.scope.kimiActivityObserver = undefined;
    h.scope.thinkingTurn = undefined;
    h.scope.captureTurnFailureDiagnostics = false;
    h.scope.durableTurnInFlight = false;
    h.scope.terminalReleasesDurableTurn = () => false;
    h.scope.releaseActiveTurnAuthority = loadWorkerFunction('releaseActiveTurnAuthority', h.scope);
    h.scope.releaseTerminatedActiveTurnAuthority = loadWorkerFunction('releaseTerminatedActiveTurnAuthority', h.scope);
    h.scope.emitTurnTerminal = loadWorkerFunction('emitTurnTerminal', h.scope);
    h.scope.writeCliPidMarker();

    // Simulate prompt_ready already releasing A's activeTurnAuthority before turn_duration(A) lands.
    h.scope.activeTurnAuthority.clear();
    h.scope.emitTurnTerminal('om_A', 'completed');
    h.scope.emitTurnTerminal('om_B', 'completed');
    h.flushMicrotasks();

    expect(h.scope.currentBotmuxTurnId).toBe('om_C');
    expect(h.scope.activeTurnAuthority.snapshot()?.turnId).toBe('om_C');
    expect(h.scope.queuedTypeAheadTurns).toEqual([]);
  });
});

describe('adversarial regression matrix (crash recovery, multi-destination, privateReply, unified card, malformed markers)', () => {
  it('final-visible C write uses ledger authorization, preserves a rejected B promotion, and retains steer guidance', async () => {
    const f = setupSendFixture({
      scope: 'chat',
      turns: [
        { id: 'om_A', root: undefined, sender: 'ou_first' },
        { id: 'om_B', root: 'om_topic_1', sender: 'ou_second' },
      ],
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const h = createWorkerHarness(f.data, [
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);
    const ledgerKey = { larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_A' };
    // A's final is durable, but its --reply-to A / different-destination gate
    // rejected B, so no settledAbsorbedTurnIds were authorized.
    await new TurnSendLedger(f.data).execute(ledgerKey, 'final', 'Answer A only', async () => 'om_A_final');
    recordBridgeReplyMarker({
      dataDir: f.data, sessionId: 'sid', sentAtMs: Date.now(), messageId: 'om_A_final',
      deliveryKind: 'current_session_send', content: 'Answer A only', responseKind: 'final',
      turnId: 'om_A', targetChatId: 'oc_test', targetSessionId: 'sid',
    });

    prepareIncomingNormalWrite(h, f.data);
    expect(h.scope.currentBotmuxTurnId).toBe('om_B');
    expect(h.scope.queuedTypeAheadTurns.map((turn: { turnId: string }) => turn.turnId)).toEqual(['om_C']);
    expect(f.marker().turnId).toBe('om_B');
    expect(f.marker().steerPromotedTurn).toBe(true);
    expect(f.marker().settledAbsorbedTurns).toBeUndefined();
    expect(f.marker().queuedTurns).toEqual([expect.objectContaining({ turnId: 'om_C' })]);

    const originalMarker: AncestorSessionContext = {
      sessionId: 'sid', turnId: 'om_A',
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    };
    const rejectB = buildAbsorbedTurnSettlementGate({
      session: {
        sessionId: 'sid', scope: 'chat',
        turnReplyContexts: {
          om_A: { target: { mode: 'plain', chatId: 'oc_test' } },
          om_B: { target: { mode: 'thread', rootMessageId: 'om_topic_1' } },
        },
      },
      originSessionId: 'sid', originDispatchAttempt: undefined,
      preSendAbsorbedTurnIds: new Set(['om_B']),
      actualDeliveredTarget: { mode: 'plain', chatId: 'oc_test' },
      privateReply: false, replyTargetSenderOpenId: 'ou_first', explicitReplyTo: 'om_A',
      routingOverride: false, excludedSendKind: false, crossPrincipalInterruption: false,
    });
    const adv = advanceAncestorSessionTurn(f.data, process.pid, 'om_A', { canSettleAbsorbed: rejectB });
    expect(adv).toEqual({ advanced: false, turnId: 'om_B' });
    const fresh = findAncestorSessionMarkerContext(f.data, process.pid, 'sid');
    const completionTurn = resolvePromotedAbsorbedTurnForCompletion(adv, new Set(['om_B']), fresh);
    expect(completionTurn).toBe('om_B');
    expect(sendCompletionHintKey('final', false, completionTurn)).toBe('ai.send.after_success_steer_advanced');
    // An unrelated promoted/active C can never inherit B's completion steering.
    expect(resolvePromotedAbsorbedTurnForCompletion(
      { advanced: false, turnId: 'om_C' }, new Set(['om_B']), fresh,
    )).toBeUndefined();
  });

  it('an unresolved first final transition fails closed before markNewTurn can clear absorbed B', async () => {
    const f = setupSendFixture({
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const h = createWorkerHarness(f.data, [
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);
    await new TurnSendLedger(f.data).execute(
      { larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_A' },
      'final', 'Answer A', async () => 'om_A_final',
    );
    recordBridgeReplyMarker({
      dataDir: f.data, sessionId: 'sid', sentAtMs: Date.now(), messageId: 'om_A_final',
      deliveryKind: 'current_session_send', content: 'Answer A', responseKind: 'final', turnId: 'om_A',
    });
    expect(() => prepareIncomingNormalWrite(h, f.data, undefined, () => {
      // Mutation: disable the first transition entirely. The second cleanup
      // point must still refuse to write C rather than silently dropping B.
      h.scope.advanceQueuedTypeAheadTurnAfterFinal = () => {};
      h.scope.SubmissionWriteError = class SubmissionWriteError extends Error {
        constructor(
          message: string,
          readonly recoveryFailureReason?: string,
          readonly submissionStarted = true,
          readonly runnerGenerationUnsafe = false,
          readonly traexCatalogAdmissionRequired = false,
          readonly retainPendingInput = false,
        ) { super(message); }
      };
    })).toThrow(/final transition is still unresolved/);
    expect(h.scope.currentBotmuxTurnId).toBe('om_A');
    expect(h.scope.queuedTypeAheadTurns.map((turn: { turnId: string }) => turn.turnId)).toEqual(['om_B']);
    expect(f.marker().turnId).toBe('om_A');
    expect(f.marker().queuedTurns).toEqual([
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);
    expect(f.marker().settledAbsorbedTurns).toBeUndefined();
  });

  it('primary final lock timeout keeps delivery successful and exact retry converges marker and queue', () => {
    const f = setupSendFixture({
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const args = ['--response-kind', 'final', '--no-mention'];
    const first = withFileLockSync(f.markerPath, () => f.run(args, 'answer A and B'));
    expect(first.status, String(first.stderr)).toBe(0);
    expect(first.writes).toHaveLength(1);
    expect(String(first.stderr)).not.toContain(t('ai.send.after_success_hint', undefined, 'zh'));
    expect(f.marker().turnId).toBe('om_A');
    expect(f.marker().queuedTurns).toEqual([
      { turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
    ]);
    const journal = join(f.data, 'turn-sends', 'sid.jsonl');
    const firstMarkers = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(firstMarkers).toHaveLength(1);
    expect(firstMarkers[0]).toMatchObject({ turnId: 'om_A', messageId: 'om_separate_message', responseKind: 'final' });

    const retry = f.run(args, 'answer A and B');
    expect(retry.status, String(retry.stderr)).toBe(0);
    expect(retry.writes).toHaveLength(0);
    expect(f.marker().turnId).toBe('om_A');
    expect(f.marker().queuedTurns).toBeUndefined();
    expect(f.marker().settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);
    const retriedMarkers = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean);
    expect(retriedMarkers).toHaveLength(1);
  }, 30_000);

  it('explicit old-target lock retry replays A on every subsequent command instead of minting B final to A', () => {
    const f = setupSendFixture({
      scope: 'chat',
      turns: [
        { id: 'om_A', root: 'om_topic_A', sender: 'ou_first' },
        { id: 'om_B', root: 'om_topic_B', sender: 'ou_second' },
      ],
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const args = ['--response-kind', 'final', '--reply-to', 'om_A', '--no-mention'];
    const first = withFileLockSync(f.markerPath, () => f.run(args, 'Answer A only'));
    expect(first.status, String(first.stderr)).toBe(0);
    expect(first.writes).toHaveLength(1);
    expect(first.writes[0].path).toBe('/open-apis/im/v1/messages/om_topic_A/reply');

    for (const [index, result] of [f.run(args, 'Answer A only'), f.run(args, 'Answer A only')].entries()) {
      expect(result.status, `replay ${index + 2}: ${result.stderr}`).toBe(0);
      expect(result.writes, `replay ${index + 2} must not publish again`).toHaveLength(0);
      expect(String(result.stdout)).toContain('"replayed":true');
      expect(f.marker().turnId).toBe('om_B');
      expect(f.marker().steerPromotedTurn).toBe(true);
      expect(f.marker().promotedAbsorbedTurn).toBe(true);
      expect(f.marker().promotedFromTurnId).toBe('om_A');
      expect(new TurnSendLedger(f.data).read({ larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_B' })?.final)
        .toBeUndefined();
    }
    const markers = readFileSync(join(f.data, 'turn-sends', 'sid.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ turnId: 'om_A', targetRootMessageId: 'om_topic_A' });
  }, 30_000);

  it('concurrent replay after winner crash restores the missing final marker and ledger-authorized queue state', () => {
    const f = setupSendFixture({
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const res = f.run(['--response-kind', 'final', '--no-mention'], 'answer A and B', replayWinnerCrashFixture);
    expect(res.status, String(res.stderr)).toBe(0);
    expect(res.writes).toHaveLength(1);
    expect(String(res.stdout)).toContain('REPLAY_RESULT={"winnerReplayed":false,"loserReplayed":true}');
    expect(f.marker().turnId).toBe('om_A');
    expect(f.marker().queuedTurns).toBeUndefined();
    expect(f.marker().settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);
    const markers = readFileSync(join(f.data, 'turn-sends', 'sid.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ turnId: 'om_A', messageId: 'om_final', responseKind: 'final' });
  });

  it('voice and doc final lock failures preserve delivery and converge on exact replay', () => {
    for (const kind of ['voice', 'doc'] as const) {
      const root = makeTempDir(`final-${kind}-lock-replay-`);
      const dataDir = join(root, 'data');
      const binDir = join(root, 'bin');
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      mkdirSync(binDir);
      writeFileSync(join(binDir, 'opusenc'), [
        '#!/bin/sh', 'if [ "$1" = "--version" ]; then exit 0; fi',
        'for last do :; done', 'printf "test-opus" > "$last"', '',
      ].join('\n'), { mode: 0o755 });
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: 'cli_test', larkAppSecret: 'secret', cliId: 'codex', replyCardMode: 'legacy',
        voice: { engine: 'openai', openai: { baseUrl: 'https://tts.example.test/v1', model: 'test' } },
      }]));
      const markerPath = join(dataDir, '.botmux-cli-pids', String(process.pid));
      writeFileSync(markerPath, JSON.stringify({
        sessionId: 'sid', turnId: 'old-input', queuedTurnId: 'om_B',
        queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'old-input' }],
      }));
      seedPersistedSessionRows(dataDir, 'cli_test', { sid: {
        sessionId: 'sid', status: 'active', larkAppId: 'cli_test', cliId: 'codex',
        scope: 'chat', chatType: 'group', workingDir: root,
        chatId: kind === 'doc' ? 'doc:doc_test:comment_test' : 'oc_chat',
        ...(kind === 'doc' ? { docCommentTargets: {
          'old-input': { fileToken: 'doc_test', fileType: 'docx', commentId: 'comment_test', turnId: 'old-input' },
          om_B: { fileToken: 'doc_test', fileType: 'docx', commentId: 'comment_test_b', turnId: 'om_B' },
        } } : {}),
      } });
      const run = () => spawnSyncTsScript(voiceDocFixture, [
        'send', '--no-mention', '--response-kind', 'final', ...(kind === 'voice' ? ['--voice'] : []), 'Final answer',
      ], {
        cwd: repo, encoding: 'utf8', timeout: 30_000,
        env: {
          ...process.env,
          PATH: [binDir, process.env.PATH].join(delimiter), HOME: root,
          SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: 'sid', BOTMUX_LARK_APP_ID: 'cli_test',
        },
      });
      const first = withFileLockSync(markerPath, () => run());
      expect(first.status, `${kind}: ${first.stderr}`).toBe(0);
      expect(String(first.stdout).split('\n').filter(line => line.startsWith('PROVIDER_DELIVERY='))).toHaveLength(1);
      expect(JSON.parse(readFileSync(markerPath, 'utf8')).turnId).toBe('old-input');
      const journal = join(dataDir, 'turn-sends', 'sid.jsonl');
      const firstMarkers = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(firstMarkers).toHaveLength(1);
      expect(firstMarkers[0]).toMatchObject({ turnId: 'old-input', responseKind: 'final' });
      if (kind === 'voice') expect(firstMarkers[0].terminalCarrier).toBe('non_patchable');

      const retry = run();
      expect(retry.status, `${kind} retry: ${retry.stderr}`).toBe(0);
      // This gate rejected B: the retry first restores B's promotion, then B's
      // own required final is a new turn, not a duplicate of A. A third exact
      // command proves that new final is itself idempotent.
      expect(String(retry.stdout).split('\n').filter(line => line.startsWith('PROVIDER_DELIVERY='))).toHaveLength(1);
      const retriedMarker = JSON.parse(readFileSync(markerPath, 'utf8'));
      expect(retriedMarker.turnId).toBe('om_B');
      expect(retriedMarker.steerPromotedTurn).toBe(true);
      expect(readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(2);

      const replayB = run();
      expect(replayB.status, `${kind} replay B: ${replayB.stderr}`).toBe(0);
      expect(String(replayB.stdout).split('\n').filter(line => line.startsWith('PROVIDER_DELIVERY='))).toHaveLength(0);
      const markers = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(markers).toHaveLength(2);
      expect(new Set(markers.map(marker => marker.turnId))).toEqual(new Set(['old-input', 'om_B']));
    }
  }, 60_000);

  it('same-topic new B final with different content is not blocked by the old-host replay guard', () => {
    const f = setupSendFixture({
      scope: 'chat',
      turns: [
        { id: 'om_A', root: 'om_shared_topic', sender: 'ou_first' },
        { id: 'om_B', root: 'om_shared_topic', sender: 'ou_second' },
      ],
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const first = f.run(['--response-kind', 'final', '--reply-to', 'om_A', '--no-mention'], 'Answer A only');
    expect(first.status, String(first.stderr)).toBe(0);
    expect(first.writes).toHaveLength(1);
    expect(f.marker().turnId).toBe('om_B');
    expect(f.marker().promotedAbsorbedTurn).toBe(true);
    expect(f.marker().promotedFromTurnId).toBe('om_A');

    const second = f.run(['--response-kind', 'final', '--no-mention'], 'New answer for B');
    expect(second.status, String(second.stderr)).toBe(0);
    expect(second.writes).toHaveLength(1);
    expect(second.writes[0].path).toBe('/open-apis/im/v1/messages/om_shared_topic/reply');
    expect(new TurnSendLedger(f.data).read({ larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_B' })?.final)
      .toBeDefined();
  });

  it('voice explicit old-target lock retry also replays A without another TTS or B-to-A marker', () => {
    const root = makeTempDir('voice-old-target-lock-replay-');
    const dataDir = join(root, 'data');
    const binDir = join(root, 'bin');
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'opusenc'), [
      '#!/bin/sh', 'if [ "$1" = "--version" ]; then exit 0; fi',
      'for last do :; done', 'printf "test-opus" > "$last"', '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'secret', cliId: 'codex', replyCardMode: 'legacy',
      voice: { engine: 'openai', openai: { baseUrl: 'https://tts.example.test/v1', model: 'test' } },
    }]));
    const ds = {
      scope: 'chat', chatId: 'oc_chat',
      session: {
        sessionId: 'sid', status: 'active', larkAppId: 'cli_test', cliId: 'codex',
        scope: 'chat', chatType: 'group', workingDir: root, chatId: 'oc_chat', rootMessageId: 'oc_chat',
      },
    } as DaemonSession;
    for (const turn of [
      { id: 'om_A', root: 'om_topic_A', sender: 'ou_first' },
      { id: 'om_B', root: 'om_topic_B', sender: 'ou_second' },
    ]) {
      ds.session.quoteTargetId = turn.id;
      ds.session.quoteTargetSenderOpenId = turn.sender;
      beginReplyTargetTurn(ds, turn.root, turn.id, new Date().toISOString(), {
        senderOpenId: turn.sender, participants: [{ openId: turn.sender, isBot: false }], inThread: true,
      });
    }
    seedPersistedSessionRows(dataDir, 'cli_test', { sid: ds.session });
    const markerPath = join(dataDir, '.botmux-cli-pids', String(process.pid));
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 'sid', turnId: 'om_A', queuedTurnId: 'om_B',
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    }));
    const run = () => spawnSyncTsScript(voiceDocFixture, [
      'send', '--voice', '--no-mention', '--response-kind', 'final', '--reply-to', 'om_A', 'Answer A only',
    ], {
      cwd: repo, encoding: 'utf8', timeout: 30_000,
      env: {
        ...process.env, PATH: [binDir, process.env.PATH].join(delimiter), HOME: root,
        SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: 'sid', BOTMUX_LARK_APP_ID: 'cli_test', BOTMUX_TURN_ID: 'om_A',
      },
    });
    const first = withFileLockSync(markerPath, () => run());
    expect(first.status, String(first.stderr)).toBe(0);
    expect(String(first.stdout).split('\n').filter(line => line.startsWith('PROVIDER_DELIVERY='))).toHaveLength(1);

    for (const result of [run(), run()]) {
      expect(result.status, String(result.stderr)).toBe(0);
      expect(String(result.stdout).split('\n').filter(line => line.startsWith('PROVIDER_DELIVERY='))).toHaveLength(0);
      expect(String(result.stdout)).toContain('"replayed":true');
      expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({
        turnId: 'om_B', steerPromotedTurn: true, promotedAbsorbedTurn: true, promotedFromTurnId: 'om_A',
      });
      expect(new TurnSendLedger(dataDir).read({ larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_B' })?.final)
        .toBeUndefined();
    }
    const markers = readFileSync(join(dataDir, 'turn-sends', 'sid.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      turnId: 'om_A', targetRootMessageId: 'om_topic_A', terminalCarrier: 'non_patchable',
    });
  }, 45_000);

  it('crash recovery: TurnSendLedger records settledAbsorbedTurnIds so pre-send catch-up settles B instead of promoting it', () => {
    const f = setupSendFixture({
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const preAdvanceMarker = readFileSync(f.markerPath, 'utf8');

    // Process 1 commits TurnSendLedger.final (recording settledAbsorbedTurnIds: ['om_B']).
    const first = f.run(['--response-kind', 'final'], 'Combined answer for A and B');
    expect(first.status, String(first.stderr)).toBe(0);
    expect(first.writes).toHaveLength(1);
    const ledger = new TurnSendLedger(f.data);
    expect(ledger.read({ larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_A' })?.final?.settledAbsorbedTurnIds)
      .toEqual(['om_B']);

    // Simulate crash right after TurnSendLedger write and BEFORE advanceAncestorSessionTurn ran.
    writeFileSync(f.markerPath, preAdvanceMarker);

    // 1. Exact idempotent retry must settle B in catch-up loop and replay with 0 provider writes.
    const retry = f.run(['--response-kind', 'final'], 'Combined answer for A and B');
    expect(retry.status, String(retry.stderr)).toBe(0);
    expect(retry.writes).toHaveLength(0);
    expect(f.marker().turnId).toBe('om_A');
    expect(f.marker().settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);

    // 2. Restore pre-advance marker again: hallucinated duplicate final must be refused (exit 2, 0 writes).
    writeFileSync(f.markerPath, preAdvanceMarker);
    const dup = f.run(['--response-kind', 'final'], 'Duplicate second final');
    expect(dup.status).toBe(2);
    expect(dup.writes).toHaveLength(0);
    expect(f.marker().turnId).toBe('om_A');

    // 3. Restore pre-advance marker again: auxiliary supplement stays auxiliary and does NOT promote om_B.
    writeFileSync(f.markerPath, preAdvanceMarker);
    const aux = f.run(['--response-kind', 'auxiliary'], 'P.S. small footnote');
    expect(aux.status, String(aux.stderr)).toBe(0);
    expect(aux.writes).toHaveLength(1);
    expect(f.marker().turnId).toBe('om_A');
    expect(ledger.read({ larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_B' })?.final).toBeUndefined();
  }, 30_000);

  it('chat-scope multi-destination absorbed turns [B1(topic_1), B2(plain)] settle B2 on send 1 and deliver B1 to topic_1 on send 2 without hijack', () => {
    const f = setupSendFixture({
      scope: 'chat',
      turns: [
        { id: 'om_A', root: 'om_topic_1', sender: 'ou_first' },
        { id: 'om_B1', root: 'om_topic_1', sender: 'ou_first' },
        { id: 'om_B2', root: undefined, sender: 'ou_second' },
      ],
      queuedTurns: [
        { turnId: 'om_B1', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
        { turnId: 'om_B2', inputConsumed: true, absorbedIntoTurnId: 'om_A' },
      ],
    });

    // Send 1 addresses B2 (plain) -> settles B2, promotes B1 (topic_1), leaves queuedTurns empty!
    const s1 = f.run(['--response-kind', 'final', '--no-mention'], 'Answer for B2 in main chat');
    expect(s1.status, String(s1.stderr)).toBe(0);
    expect(s1.writes[0].body.reply_in_thread).not.toBe(true);
    expect(f.marker().turnId).toBe('om_B1');
    expect(f.marker().queuedTurns).toBeUndefined();
    expect(f.marker().settledAbsorbedTurns).toEqual([{ turnId: 'om_B2', hostTurnId: 'om_A' }]);

    // Send 2 answers B1 -> lands in om_topic_1 and completes cleanly with after_success_hint!
    const s2 = f.run(['--response-kind', 'final', '--no-mention'], 'Answer for B1 in topic 1');
    expect(s2.status, String(s2.stderr)).toBe(0);
    expect(s2.writes[0].path).toBe('/open-apis/im/v1/messages/om_topic_1/reply');
    expect(s2.writes[0].body.reply_in_thread).toBe(true);
    expect(String(s2.stderr)).toContain(t('ai.send.after_success_hint', undefined, 'zh'));

    // selectReplyMessageId also ignores queued entries absorbed into another host.
    const session = {
      sessionId: 'sid',
      turnReplyContexts: {
        om_B1: { target: { mode: 'thread', rootMessageId: 'om_topic_1' } },
        om_B2: { target: { mode: 'plain', chatId: 'oc_test' } },
      },
    };
    expect(selectReplyMessageId(session, 'om_B1', {
      sessionId: 'sid',
      turnId: 'om_B1',
      queuedTurns: [{ turnId: 'om_B2', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    })).toBe('om_B1');
  }, 30_000);

  it('privateReply with crossChatOrigin host mismatch (DM sent only to Alice) refuses to settle Bob absorbed turn', () => {
    const f = setupSendFixture({
      scope: 'thread',
      turns: [
        { id: 'om_A', root: 'om_root', sender: 'ou_alice', crossChat: true },
        { id: 'om_B', root: 'om_root', sender: 'ou_bob' },
      ],
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const roleMetaDir = join(f.data, 'roles', 'cli_test');
    mkdirSync(roleMetaDir, { recursive: true });
    writeFileSync(join(roleMetaDir, 'oc_test.meta.json'), JSON.stringify({ replyPrivately: true }));

    const res = f.run(['--response-kind', 'final', '--no-mention'], 'Private answer for Alice');
    expect(res.status, String(res.stderr)).toBe(0);
    expect(res.writes[0].body.receive_id).toBe('ou_alice');
    // Bob did not receive the private DM -> must NOT settle om_B!
    expect(f.marker().turnId).toBe('om_B');
    expect(f.marker().steerPromotedTurn).toBe(true);
  });

  it('unified reply card progress -> final in main chat persists deliveredTarget and settles absorbed B', () => {
    const home = makeTempDir('unified-progress-final-');
    const data = join(home, 'data');
    const markerDir = join(data, '.botmux-cli-pids');
    mkdirSync(markerDir, { recursive: true });
    const markerPath = join(markerDir, String(process.pid));
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 'sid',
      turnId: 'om_A',
      queuedTurnId: 'om_B',
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    }));
    writeFileSync(join(home, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'claude-code', replyCardMode: 'unified',
    }]));
    const ds = {
      scope: 'chat',
      chatId: 'oc_test',
      session: {
        sessionId: 'sid', status: 'active', cliId: 'claude-code', larkAppId: 'cli_test',
        chatId: 'oc_test', rootMessageId: 'oc_test', scope: 'chat', chatType: 'p2p', workingDir: home,
      },
    } as DaemonSession;
    for (const [id, root, sender] of [['om_A', 'om_topic_1', 'ou_first'], ['om_B', undefined, 'ou_second']] as const) {
      ds.session.quoteTargetId = id;
      ds.session.quoteTargetSenderOpenId = sender;
      beginReplyTargetTurn(ds, root, id, new Date().toISOString(), {
        senderOpenId: sender, participants: [{ openId: sender, isBot: false }], inThread: !!root,
      });
    }
    seedPersistedSessionRows(data, 'cli_test', { sid: ds.session });
    const replyStore = new TurnReplyCardStore(data);
    replyStore.prepareSync({ larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_A' }, {
      mode: 'unified', chatId: 'oc_test', rootId: 'om_topic_1',
    });

    const run = (args: string[], text: string) => {
      const res = spawnSyncTsScript(fixture, ['send', '--no-mention', ...args, text], {
        cwd: repo, encoding: 'utf8', timeout: 30000,
        env: {
          PATH: process.env.PATH, HOME: home, BOTS_CONFIG: join(home, 'bots.json'),
          SESSION_DATA_DIR: data, BOTMUX_SESSION_ID: 'sid', BOTMUX_TURN_ID: 'om_A', BOTMUX_LARK_APP_ID: 'cli_test',
        },
      });
      const writes = String(res.stdout).split('\n').filter(l => l.startsWith('CAPTURE_REPLY='))
        .map(l => JSON.parse(l.slice('CAPTURE_REPLY='.length)));
      return { ...res, writes };
    };

    // Progress creates card in main chat (for consumed om_B) and records deliveredTarget = plain:oc_test.
    const prog = run([], 'Working on A+B');
    expect(prog.status, String(prog.stderr)).toBe(0);
    expect(prog.writes[0].method).toBe('POST');
    expect(replyStore.read({ larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_A' })?.deliveredTarget)
      .toEqual({ mode: 'plain', chatId: 'oc_test' });

    // Final PATCHes that same card in main chat -> matches om_B's target -> settles om_B cleanly!
    const fin = run(['--response-kind', 'final'], 'Done A+B');
    expect(fin.status, String(fin.stderr)).toBe(0);
    expect(fin.writes[0].method).toBe('PATCH');
    const markerAfter = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(markerAfter.turnId).toBe('om_A');
    expect(markerAfter.settledAbsorbedTurns).toEqual([{ turnId: 'om_B', hostTurnId: 'om_A' }]);
  });

  it('unified card already created by daemon without deliveredTarget fails closed and promotes absorbed B', async () => {
    const f = setupSendFixture({
      scope: 'chat',
      replyCardMode: 'unified',
      turns: [
        { id: 'om_A', root: 'om_topic_1', sender: 'ou_first' },
        { id: 'om_B', root: 'om_topic_1', sender: 'ou_second' },
      ],
      queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
    });
    const key = { larkAppId: 'cli_test', sessionId: 'sid', turnId: 'om_A' };
    const store = new TurnReplyCardStore(f.data);
    store.prepareSync(key, { mode: 'unified', chatId: 'oc_test', rootId: 'oc_test' });
    const daemonPublication = await store.update(key, { kind: 'progress', text: 'daemon progress' }, {
      render: () => JSON.stringify({ config: { update_multi: true }, body: { elements: [] } }),
      send: async () => 'om_daemon_card',
      patch: async () => { throw new Error('unexpected initial patch'); },
      beforeEffect: () => {},
      isWithdrawn: () => false,
      // The daemon transport predates deliveredTarget persistence.
    });
    expect(daemonPublication.record.messageId).toBe('om_daemon_card');
    expect(daemonPublication.record.deliveredTarget).toBeUndefined();

    const res = f.run(['--response-kind', 'final', '--no-mention'], 'Final only patches the main-chat card');
    expect(res.status, String(res.stderr)).toBe(0);
    expect(res.writes).toHaveLength(1);
    expect(res.writes[0].method).toBe('PATCH');
    expect(res.writes[0].path).toBe('/open-apis/im/v1/messages/om_daemon_card');
    // The visible card is plain:oc_test, not A/B's topic_1. Unknown historical
    // destination must preserve B for a separate answer instead of settling it.
    expect(f.marker().turnId).toBe('om_B');
    expect(f.marker().steerPromotedTurn).toBe(true);
    expect(f.marker().settledAbsorbedTurns).toBeUndefined();
    expect(String(res.stderr)).toContain(t('ai.send.after_success_steer_advanced', undefined, 'zh'));
  });

  it('rejects settlement fail-closed when PID marker has corrupted non-null dispatchAttempt or invalid queued turnId', () => {
    const cases: Array<{ name: string; payload: Record<string, unknown> }> = [
      {
        name: 'corrupted queued dispatchAttempt',
        payload: {
          sessionId: 'sid',
          turnId: 'om_A',
          queuedTurns: [{ turnId: 'om_B', dispatchAttempt: '1', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
        },
      },
      {
        name: 'corrupted root dispatchAttempt',
        payload: {
          sessionId: 'sid',
          turnId: 'om_A',
          dispatchAttempt: '2',
          queuedTurns: [{ turnId: 'om_B', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
        },
      },
      {
        name: 'invalid queued turnId containing control char',
        payload: {
          sessionId: 'sid',
          turnId: 'om_A',
          queuedTurns: [{ turnId: 'om_B\nevil', inputConsumed: true, absorbedIntoTurnId: 'om_A' }],
        },
      },
    ];
    for (const tc of cases) {
      const dir = makeTempDir('malformed-marker-');
      const markerDir = join(dir, '.botmux-cli-pids');
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(join(markerDir, String(process.pid)), JSON.stringify(tc.payload));
      const res = advanceAncestorSessionTurn(dir, process.pid, 'om_A', { canSettleAbsorbed: () => true });
      expect(res.advanced, tc.name).toBe(true);
      expect(res.settledAbsorbedTurnIds, tc.name).toBeUndefined();
    }
  });
});
