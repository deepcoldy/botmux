import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, statSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { CodexBridgeQueue, STRUCTURED_SUBMIT_START_GRACE_MS } from '../src/services/codex-bridge-queue.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';
import { uncollectedTurnsNeedingNotice } from '../src/services/structured-uncollected-notice.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';
import { sameTrustedPrincipal } from '../src/core/active-turn-authority.js';
import { terminalReleasesDurableTurn } from '../src/utils/pending-input-queue.js';
import { bindNativeInstantPendingTurns, checkpointNativeInstantPendingTurn, checkpointCodexAdoptTurns, restoreCodexAdoptTurns } from '../src/services/codex-adopt-recovery.js';
import { planBridgeTurnRecovery, readBridgeTurnJournal, selectRestorableBridgeTurns, writeBridgeTurnJournal } from '../src/services/bridge-turn-journal.js';
import { baselineJsonlCursor } from '../src/services/jsonl-cursor.js';
import { canonicalPathNearest } from '../src/core/cli-identity.js';

const SID = '00000000-0000-7000-8000-000000000001';
const NATIVE = '00000000-0000-7000-8000-000000000002';
const START = Date.parse('2026-01-01T00:00:00.000Z');
let dir: string;
let path: string;

function input(text: string, id: string, at = START, turnId = NATIVE) {
  return {
    timestamp: new Date(at).toISOString(), type: 'history_mutation',
    payload: {
      version: 1, commit_id: id, operation: 'append', turn_id: turnId,
      items: [{ type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] }],
      display_completions: [{ thread_id: SID, turn_id: turnId,
        item: { type: 'UserMessage', id, content: [{ type: 'text', text }] },
        started_at_ms: at, completed_at_ms: at }],
    },
  };
}

function terminal(at = START + 2_000, turnId = NATIVE, aborted = false) {
  return { timestamp: new Date(at).toISOString(), type: 'event_msg',
    payload: aborted ? { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }
      : { type: 'task_complete', turn_id: turnId, last_agent_message: 'Combined answer' } };
}

function append(...records: unknown[]) {
  appendFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

function event(text: string, id: string, at = START): CodexBridgeEvent {
  return { kind: 'user', text, uuid: `event-${id}`, timestampMs: at,
    sourceSessionId: SID, sourceTurnId: NATIVE, sourceMessageId: id };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-same-turn-'));
  path = join(dir, `rollout-2026-01-01T00-00-00-${SID}.jsonl`);
  writeFileSync(path, '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function nativeMarkHarness() {
  const h = workerSubmitHarness();
  const owner = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
  const journal = join(dir, 'native-journal.json');
  Object.assign(h.scope, {
    structuredBridgeIs: (cli: string) => cli === 'traex', structuredTurnsWithSubmitNotice: new Set(),
    structuredBridgeRecoveryCursorAtMark: () => ({ jsonlPath: path, offsetAtMark: 0 }),
    checkpointCodexAdoptRecovery: vi.fn(), checkpointCodexAdoptTurns,
    checkpointNativeInstantPendingTurn, bindNativeInstantPendingTurns, readBridgeTurnJournal, restoreCodexAdoptTurns,
    planBridgeTurnRecovery, statSync, drainTraexRollout, canonicalPathNearest,
    structuredBridgeJournalPath: () => journal, structuredBridgeRecoveryAttempted: false,
    codexBridgeRolloutPath: undefined, codexBridgeOffset: 0, traexQuotaPending: undefined,
    lastSpawnPersistentReattach: false, traexNativeInstantInputEnabled: () => true,
    cliLifetimeNonce: 1, cliInterruptGeneration: 1,
    currentTraexObservedPid: () => 100, readProcessStartIdentity: () => '1000',
    findTraexRolloutSetByPid: () => new Set([SID]),
    findTraexRolloutByPid: () => ({ path, cliSessionId: SID }),
    nativeSessionForkPending: () => false, codexSubagentLimitTracker: { clear: vi.fn() },
    fsWatch: vi.fn(), codexBridgeStartTimer: vi.fn(),
  });
  h.scope.checkpointStructuredBridgeRecovery = loadWorkerFunction('checkpointStructuredBridgeRecovery', h.scope);
  h.scope.bindNativeInstantPendingRecovery = loadWorkerFunction('bindNativeInstantPendingRecovery', h.scope);
  h.scope.nativeInstantRolloutFileIdentity = loadWorkerFunction('nativeInstantRolloutFileIdentity', h.scope);
  h.scope.codexBridgeAttach = loadWorkerFunction('codexBridgeAttach', h.scope);
  const mark = loadWorkerFunction('codexBridgeMarkPendingTurn', h.scope);
  return { ...h, owner, journal, mark };
}

describe('TRAE messages merged into one native turn', () => {
  it.each(['same file alias', 'different inode'] as const)('binds the actual owned rollout through %s without relaxing native identity', variant => {
    const h = nativeMarkHarness();
    h.scope.findTraexRolloutSetByPid = () => new Set();
    h.scope.findTraexRolloutByPid = () => undefined;
    h.scope.structuredBridgeRecoveryCursorAtMark = () => undefined;
    h.mark('Task', 'om_first', undefined, START, undefined, undefined, h.owner);
    h.scope.codexBridgeQueue = new CodexBridgeQueue(() => START + 1_000);
    append(input('Task', 'first'));
    const aliasDir = join(dir, 'alias');
    const otherDir = join(dir, 'other');
    symlinkSync(dir, aliasDir, 'dir');
    mkdirSync(otherDir);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const ownedPath = variant === 'same file alias' ? join(aliasDir, name) : join(otherDir, name);
    if (variant === 'different inode') writeFileSync(ownedPath, '');
    h.scope.findTraexRolloutSetByPid = () => new Set([SID]);
    h.scope.findTraexRolloutByPid = () => ({ path: ownedPath, cliSessionId: SID });
    vi.spyOn(Date, 'now').mockReturnValue(START + 1_000);
    try { h.scope.bindNativeInstantPendingRecovery(path); } finally { vi.restoreAllMocks(); }
    const [entry] = readBridgeTurnJournal(h.journal);
    expect(entry.jsonlPath).toBe(variant === 'same file alias' ? path : '');
    expect(h.scope.codexBridgeQueue.peek()[0]?.exactUserInputMatch).toBe(variant === 'same file alias' ? true : undefined);
  });

  it('retains a pre-path root through actual empty attach checkpoint and binds its later User before the correction mark', () => {
    const h = nativeMarkHarness();
    h.scope.findTraexRolloutSetByPid = () => new Set();
    h.scope.findTraexRolloutByPid = () => undefined;
    h.scope.structuredBridgeRecoveryCursorAtMark = () => undefined;
    h.mark('Task', 'om_first', undefined, START, undefined, undefined, h.owner);
    h.scope.codexBridgeQueue = new CodexBridgeQueue(() => START + 1_000);
    h.scope.lastSpawnPersistentReattach = true;
    h.scope.lastInitConfig = { cliId: 'traex', resume: true };
    h.scope.findTraexRolloutSetByPid = () => new Set([SID]);
    h.scope.findTraexRolloutByPid = () => ({ path, cliSessionId: SID });
    Object.assign(h.scope, { existsSync, baselineJsonlCursor, selectRestorableBridgeTurns,
      restoreCodexAdoptTurns, codexAdoptJournalPath: () => undefined, scanRestartInterruption: vi.fn(),
      publishActiveRuntime: vi.fn(), readLatestTraexRuntime: () => undefined });
    h.scope.codexBridgeAttach(path, 'baseline-existing');
    expect(readBridgeTurnJournal(h.journal)[0].nativeInstantPendingProcess).toBeDefined();
    append(input('Task', 'first'));
    vi.spyOn(Date, 'now').mockReturnValue(START + 1_000);
    try { h.mark('Correction', 'om_second', undefined, START + 1_000, undefined, undefined, h.owner); }
    finally { vi.restoreAllMocks(); }
    const queue = h.scope.codexBridgeQueue as CodexBridgeQueue;
    expect(queue.peek().find(turn => turn.turnId === 'om_first')?.exactUserInputMatch).toBe(true);
    queue.ingest([event('Correction', 'second', START + 1_000), { kind: 'assistant_final', text: 'answer', uuid: 'terminal',
      timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
    const [final] = queue.drainEmittable();
    const scope = { traexNativeInstantInputEnabled: () => true, sameTrustedPrincipal, emitTurnTerminal: vi.fn() };
    loadWorkerFunction('settleNativeInstantSupersededTurns', scope)(final);
    expect(scope.emitTurnTerminal).toHaveBeenCalledTimes(1);
  });

  it.each(['valid', 'no user', 'wrong input', 'wrong pid', 'wrong birth', 'disabled', 'wrong sid'] as const)(
    'binds a lazy first native rollout only with %s pre-path admission and real User proof', mode => {
      const h = nativeMarkHarness();
      h.scope.findTraexRolloutSetByPid = () => new Set();
      h.scope.findTraexRolloutByPid = () => undefined;
      h.scope.structuredBridgeRecoveryCursorAtMark = () => undefined;
      h.mark('Task', 'om_first', undefined, START, undefined, undefined, h.owner);
      const [pending] = readBridgeTurnJournal(h.journal);
      expect(pending.nativeInstantPendingProcess).toEqual({ pid: 100, birth: '1000' });
      expect(pending.jsonlPath).toBe('');
      expect(selectRestorableBridgeTurns([pending], { currentJsonlPath: '', nowMs: START + 1_000 })).toEqual([]);
      // Replacement has no live queue/caller. The journal owns the admission.
      h.scope.codexBridgeQueue = new CodexBridgeQueue(() => START + 1_000);
      if (mode !== 'no user') append(input(mode === 'wrong input' ? 'Other' : 'Task', 'first'));
      h.scope.findTraexRolloutSetByPid = () => new Set([SID]);
      h.scope.findTraexRolloutByPid = () => ({ path, cliSessionId: SID });
      if (mode === 'wrong pid') h.scope.currentTraexObservedPid = () => 101;
      if (mode === 'wrong birth') h.scope.readProcessStartIdentity = () => '1001';
      if (mode === 'disabled') h.scope.traexNativeInstantInputEnabled = () => false;
      if (mode === 'wrong sid') h.scope.findTraexRolloutByPid = () => ({ path, cliSessionId: 'other-sid' });
      vi.spyOn(Date, 'now').mockReturnValue(START + 1_000);
      try { h.scope.bindNativeInstantPendingRecovery(path); } finally { vi.restoreAllMocks(); }
      const [bound] = readBridgeTurnJournal(h.journal);
      if (mode !== 'valid') {
        expect(bound.nativeInstantPendingProcess).toBeDefined();
        expect(selectRestorableBridgeTurns([bound], { currentJsonlPath: path, nowMs: START + 1_000 })).toEqual([]);
        return;
      }
      expect(bound.jsonlPath).toBe(path);
      expect(bound.nativeInstantPendingProcess).toBeUndefined();
      const restored = h.scope.codexBridgeQueue as CodexBridgeQueue;
      const recovery = restoreCodexAdoptTurns(h.journal, path, restored, drainTraexRollout(path, 0, { probe: true }).events, START - 5_000, START + 1_000);
      restored.absorb(recovery.history); restored.ingest(recovery.live);
      restored.mark('om_second', 'Correction', START + 1_000, undefined, { nativeInstantInputCaller: h.owner });
      restored.ingest([event('Correction', 'second', START + 1_000), { kind: 'assistant_final', text: 'answer', uuid: 'terminal',
        timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
      const scope = { traexNativeInstantInputEnabled: () => true, sameTrustedPrincipal, emitTurnTerminal: vi.fn() };
      const [final] = restored.drainEmittable();
      loadWorkerFunction('settleNativeInstantSupersededTurns', scope)(final);
      expect(scope.emitTurnTerminal).toHaveBeenCalledTimes(1);
    });

  it('checkpoints a fresh native mark before rollout discovery and restores its accepted predecessor at the final', () => {
    const { owner, journal, mark } = nativeMarkHarness();
    mark('Task', 'om_first', undefined, START, undefined, undefined, owner);
    expect(readBridgeTurnJournal(journal)).toHaveLength(1);
    const restored = new CodexBridgeQueue(() => START + 1_000);
    const recovery = restoreCodexAdoptTurns(journal, path, restored, [event('Task', 'first')], START - 5_000, START + 1_000);
    restored.absorb(recovery.history); restored.ingest(recovery.live);
    restored.mark('om_second', 'Correction', START + 1_000, undefined, { nativeInstantInputCaller: owner });
    restored.ingest([event('Correction', 'second', START + 1_000)]);
    const settleScope = { traexNativeInstantInputEnabled: () => true, sameTrustedPrincipal, emitTurnTerminal: vi.fn() };
    const settle = loadWorkerFunction('settleNativeInstantSupersededTurns', settleScope);
    expect(restored.drainEmittable()).toEqual([]);
    restored.ingest([{ kind: 'assistant_final', text: 'answer', uuid: 'terminal',
      timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
    const final = restored.drainEmittable();
    expect(final.map(turn => turn.turnId)).toEqual(['om_second']);
    settle(final[0]);
    expect(settleScope.emitTurnTerminal).toHaveBeenCalledExactlyOnceWith(
      'om_first', 'completed', undefined, undefined, undefined, undefined, undefined, undefined,
    );
  });

  it.each(['pid', 'birth', 'sid', 'interrupt'] as const)('refuses the first mark when %s changes during native rollout binding', change => {
    const h = nativeMarkHarness();
    const attach = h.scope.codexBridgeAttach;
    h.scope.codexBridgeAttach = (...args: unknown[]) => {
      attach(...args);
      if (change === 'pid') h.scope.currentTraexObservedPid = () => 101;
      if (change === 'birth') h.scope.readProcessStartIdentity = () => 'replaced-birth';
      if (change === 'sid') h.scope.findTraexRolloutByPid = () => ({ path, cliSessionId: 'other-sid' });
      if (change === 'interrupt') h.scope.cliInterruptGeneration++;
    };
    expect(() => h.mark('Task', 'om_first', undefined, START, undefined, undefined, h.owner)).toThrow('identity changed');
    expect(h.queue.peek()).toEqual([]);
    expect(readBridgeTurnJournal(h.journal)).toEqual([]);
  });

  it('keeps a pre-Enter journaled mark unaccepted when the worker dies before any native User record', () => {
    const h = nativeMarkHarness();
    h.mark('Task', 'om_first', undefined, START, undefined, undefined, h.owner);
    const restored = new CodexBridgeQueue(() => START + 1_000);
    restoreCodexAdoptTurns(h.journal, path, restored, [], START - 5_000, START + 1_000);
    restored.mark('om_second', 'Correction', START + 1_000, undefined, { nativeInstantInputCaller: h.owner });
    restored.ingest([event('Correction', 'second', START + 1_000), { kind: 'assistant_final', text: 'answer', uuid: 'terminal',
      timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
    const scope = { traexNativeInstantInputEnabled: () => true, sameTrustedPrincipal, emitTurnTerminal: vi.fn() };
    for (const final of restored.drainEmittable()) loadWorkerFunction('settleNativeInstantSupersededTurns', scope)(final);
    expect(scope.emitTurnTerminal).not.toHaveBeenCalled();
    expect(restored.peek().find(turn => turn.turnId === 'om_first')?.exactUserInputMatch).not.toBe(true);
  });

  it.each(['valid', 'missing', 'wrong hash', 'wrong uuid', 'wrong task', 'wrong sid'] as const)(
    'rechecks the %s saved predecessor against owned native user records after both inputs merged', proofCase => {
      const h = nativeMarkHarness();
      h.mark('Task', 'om_first', undefined, START, undefined, undefined, h.owner);
      append(input('Task', 'first'));
      const first = drainTraexRollout(path, 0);
      h.queue.ingest(first.events);
      h.scope.structuredBridgeRecoveryCursorAtMark = () => ({ jsonlPath: path, offsetAtMark: first.newOffset });
      h.mark('Correction', 'om_second', undefined, START + 1_000, undefined, undefined, h.owner);
      append(input('Correction', 'second', START + 1_000));
      h.queue.ingest(drainTraexRollout(path, first.newOffset).events);
      checkpointCodexAdoptTurns(h.journal, path, h.queue, first.newOffset);
      const entries = readBridgeTurnJournal(h.journal);
      expect(entries).toHaveLength(1);
      expect(entries[0].offsetAtMark).toBe(0);
      expect(entries[0].mergedExecution?.nativeInstantSupersededTurns).toHaveLength(1);
      const events = drainTraexRollout(path, 0, { probe: true }).events.flatMap(ev => {
        if (ev.kind !== 'user' || ev.sourceMessageId !== 'first') return [ev];
        if (proofCase === 'missing') return [];
        if (proofCase === 'wrong hash') return [{ ...ev, text: 'unrelated input' }];
        if (proofCase === 'wrong uuid') return [{ ...ev, uuid: 'wrong' }];
        if (proofCase === 'wrong task') return [{ ...ev, sourceTurnId: 'other-native' }];
        if (proofCase === 'wrong sid') return [{ ...ev, sourceSessionId: 'other-sid' }];
        return [ev];
      });
      const restored = new CodexBridgeQueue(() => START + 2_000);
      const recovery = restoreCodexAdoptTurns(h.journal, path, restored, events, START - 5_000, START + 2_000);
      expect(recovery.restored).toBe(1);
      restored.absorb(recovery.history); restored.ingest(recovery.live);
      expect(restored.peek()).toEqual([expect.objectContaining({ turnId: 'om_second', started: true })]);
      const settleScope = { traexNativeInstantInputEnabled: () => true, sameTrustedPrincipal, emitTurnTerminal: vi.fn() };
      const settle = loadWorkerFunction('settleNativeInstantSupersededTurns', settleScope);
      expect(restored.drainEmittable()).toEqual([]);
      restored.ingest([{ kind: 'assistant_final', text: 'answer', uuid: 'terminal',
        timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
      const final = restored.drainEmittable();
      expect(final.map(turn => turn.turnId)).toEqual(['om_second']);
      settle(final[0]);
      expect(settleScope.emitTurnTerminal).toHaveBeenCalledTimes(proofCase === 'valid' ? 1 : 0);
    });

  it.each(['legacy', 'foreign', 'durable'] as const)('does not borrow the correction caller for a %s restored first mark', mode => {
    const h = nativeMarkHarness();
    h.mark('Task', 'om_first', undefined, START, undefined, undefined, h.owner);
    const [entry] = readBridgeTurnJournal(h.journal);
    if (mode === 'legacy') delete entry.nativeInstantInputCaller;
    if (mode === 'foreign') entry.nativeInstantInputCaller = { ...h.owner, requestUserOpenId: 'other' };
    if (mode === 'durable') entry.dispatchAttempt = 1;
    writeBridgeTurnJournal(h.journal, [entry]);
    const restored = new CodexBridgeQueue(() => START + 1_000);
    const recovery = restoreCodexAdoptTurns(h.journal, path, restored, [event('Task', 'first')], START - 5_000, START + 1_000);
    restored.absorb(recovery.history); restored.ingest(recovery.live);
    restored.mark('om_second', 'Correction', START + 1_000, undefined, { nativeInstantInputCaller: h.owner });
    restored.ingest([event('Correction', 'second', START + 1_000), { kind: 'assistant_final', text: 'answer', uuid: 'terminal',
      timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
    const [final] = restored.drainEmittable();
    const settleScope = { traexNativeInstantInputEnabled: () => true, sameTrustedPrincipal, emitTurnTerminal: vi.fn() };
    loadWorkerFunction('settleNativeInstantSupersededTurns', settleScope)(final);
    expect(settleScope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('passes the accepted native-mode caller through the real Worker mark before buffered receipts replay', () => {
    const h = workerSubmitHarness();
    const owner = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
    Object.assign(h.scope, { structuredBridgeIs: () => false, structuredTurnsWithSubmitNotice: new Set(),
      structuredBridgeRecoveryCursorAtMark: () => ({ jsonlPath: 'fixture', offsetAtMark: 0 }),
      checkpointCodexAdoptRecovery: vi.fn(), checkpointStructuredBridgeRecovery: vi.fn() });
    const mark = loadWorkerFunction('codexBridgeMarkPendingTurn', h.scope);
    mark('Task', 'om_first', undefined, START, undefined, undefined, owner);
    expect(h.queue.peek()[0].nativeInstantInputCaller).toEqual(owner);
  });

  it('settles both accepted native-mode logical inputs only at their combined final', () => {
    const h = workerSubmitHarness();
    const owner = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
    h.queue.mark('om_first', 'Task', START, undefined, { nativeInstantInputCaller: owner });
    h.queue.mark('om_second', 'Correction', START + 1_000, undefined, { nativeInstantInputCaller: owner });
    h.queue.ingest([event('Task', 'first'), event('Correction', 'second', START + 1_000)]);
    expect(h.queue.peek()[0].supersededTurns).toHaveLength(1);
    const scope = h.scope;
    Object.assign(scope, {
      sessionId: 'native-settlement', sameTrustedPrincipal, lastInitConfig: { cliId: 'traex' },
      codexRpcEngine: undefined, traexNativeInstantInputEnabled: () => true,
      emittedTurnTerminals: new TurnTerminalDeduper(), turnExecutionClock: new TurnExecutionClock(),
      cancelSubmitFailureChainForTerminal: vi.fn(),
      terminalReleasesDurableTurn,
      releaseActiveTurnAuthority: vi.fn(),
      releaseTerminatedActiveTurnAuthority: vi.fn(), retireTerminatedQueuedTurn: vi.fn(),
      scheduleConsumedQueuedTurnAdvance: vi.fn(), captureTurnFailureDiagnostics: false,
      universalOutputHandoff: false, checkpointCodexAdoptRecovery: vi.fn(), checkpointStructuredBridgeRecovery: vi.fn(),
      armPostTerminalInputFence: vi.fn(), recoverTraexQuotaTurn: () => false,
      isExistingAppServerSharedBridge: () => false, zeroPromptTerminalSync: () => false,
      structuredBridgeIs: (cli: string) => cli === 'traex',
      bridgeGateInputForTurn: (_id: string, turn: unknown) => turn, structuredFallbackKind: () => 'final',
      bridgeTurnOutcome: () => 'answered', replyDeliveryMode: () => 'fallback',
      attributableExplicitReplyMarkersForTurnWindow: () => [], notifyExplicitRepliesObserved: vi.fn(),
      shouldSuppressStructuredFallback: () => false, deliveredFinalFailureNoticeSuppressed: () => false,
      bridgePostText: (content: string) => content, releaseInputDeliveryQuarantineForStructuredTerminal: vi.fn(),
      retireStructuredTurnAttribution: vi.fn(), retireRpcLifecycleFromStructuredTerminal: vi.fn(),
    });
    scope.usageLimitTracker.noteTurnCompleted = vi.fn();
    scope.emitTurnTerminal = loadWorkerFunction('emitTurnTerminal', scope);
    const emit = loadWorkerFunction('emitReadyCodexTurns', scope);
    emit();
    expect(scope.send.mock.calls.map(([m]) => m).filter(m => m.type === 'turn_terminal')).toHaveLength(0);
    h.queue.ingest([{ kind: 'assistant_final', text: 'Combined answer', uuid: 'terminal',
      timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
    emit(); emit();
    const sent = scope.send.mock.calls.map(([m]) => m);
    expect(sent.filter(m => m.type === 'final_output').map(m => m.turnId)).toEqual(['om_second']);
    expect(sent.filter(m => m.type === 'turn_terminal').map(m => [m.turnId, m.status])).toEqual([
      ['om_first', 'completed'], ['om_second', 'completed'],
    ]);
    h.queue.ingest([{ kind: 'assistant_final', text: 'Combined answer', uuid: 'late-terminal',
      timestampMs: START + 2_100, sourceSessionId: SID, sourceTurnId: NATIVE }]);
    emit();
    expect(scope.send.mock.calls.map(([m]) => m).filter(m => m.type === 'turn_terminal')).toHaveLength(2);
  });

  it.each([
    ['missing accepted caller', { nativeInstantInputCaller: undefined }],
    ['foreign caller', { nativeInstantInputCaller: { requestUserOpenId: 'other', requestLarkAppId: 'app', senderType: 'user' } }],
    ['durable', { dispatchAttempt: 1 }],
    ['different native task', { sourceTurnId: 'other-native' }],
    ['prefix-only input', { exactUserInputMatch: false }],
  ])('does not complete a superseded %s member from the current native final', (_label, patch) => {
    const owner = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
    const proof = { uuid: 'receipt', hash: 'exact-input', timestampMs: START };
    const previous = { turnId: 'om_first', sourceSessionId: SID, sourceTurnId: NATIVE,
      nativeInstantInputCaller: owner, exactUserInputMatch: true, nativeUserProof: proof, ...patch };
    const scope = { traexNativeInstantInputEnabled: () => true, sameTrustedPrincipal, emitTurnTerminal: vi.fn() };
    loadWorkerFunction('settleNativeInstantSupersededTurns', scope)({ turnId: 'om_second',
      sourceSessionId: SID, sourceTurnId: NATIVE, nativeInstantInputCaller: owner, exactUserInputMatch: true,
      nativeUserProof: { ...proof, timestampMs: START + 1_000 }, finalText: 'answer', supersededTurns: [previous] });
    expect(scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('propagates a failed shared native task to an accepted predecessor instead of marking it completed', () => {
    const owner = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
    const proof = { uuid: 'receipt', hash: 'exact-input', timestampMs: START };
    const scope = { traexNativeInstantInputEnabled: () => true, sameTrustedPrincipal, emitTurnTerminal: vi.fn() };
    loadWorkerFunction('settleNativeInstantSupersededTurns', scope)({ turnId: 'om_second',
      sourceSessionId: SID, sourceTurnId: NATIVE, nativeInstantInputCaller: owner, exactUserInputMatch: true,
      nativeUserProof: { ...proof, timestampMs: START + 1_000 }, finalText: '',
      terminalStatus: 'failed', terminalErrorCode: 'provider_failed', terminalErrorSummary: 'fixture failure',
      supersededTurns: [{ turnId: 'om_first', sourceSessionId: SID, sourceTurnId: NATIVE,
        nativeInstantInputCaller: owner, exactUserInputMatch: true, nativeUserProof: proof }] });
    expect(scope.emitTurnTerminal).toHaveBeenCalledExactlyOnceWith(
      'om_first', 'failed', 'provider_failed', undefined, undefined, undefined, undefined, 'fixture failure',
    );
  });

  for (const identicalText of [false, true]) {
    for (const incremental of [false, true]) {
      it(`recognizes distinct messages (${identicalText ? 'same' : 'different'} text, ${incremental ? 'incremental' : 'one'} drain)`, () => {
        const second = identicalText ? 'Continue the task' : 'Use the correction';
        append(input('Continue the task', 'first'));
        let events: CodexBridgeEvent[] = [];
        let offset = 0;
        if (incremental) {
          const first = drainTraexRollout(path, offset);
          events.push(...first.events); offset = first.newOffset;
        }
        append(input(second, 'second', START + 1_000), terminal());
        events.push(...drainTraexRollout(path, offset).events);
        expect(events.filter(ev => ev.kind === 'user').map(ev => ev.sourceMessageId)).toEqual(['first', 'second']);

        let now = START + 2_000;
        const queue = new CodexBridgeQueue(() => now);
        const receipts: string[] = [];
        const superseded: string[] = [];
        queue.setTurnStartObserver(turn => receipts.push(turn.turnId));
        queue.setCotSupersededObserver(turn => superseded.push(turn.turnId));
        queue.mark('lark-first', 'Continue the task', START);
        queue.mark('lark-second', second, START + 1_000);
        queue.ingest(events);
        expect(receipts).toEqual(['lark-first', 'lark-second']);
        expect(superseded).toEqual(['lark-first']);
        expect(queue.drainEmittable()).toEqual([expect.objectContaining({
          turnId: 'lark-second', finalText: 'Combined answer', sourceTurnId: NATIVE,
        })]);
        now += STRUCTURED_SUBMIT_START_GRACE_MS + 1;
        expect(queue.pruneExpiredPreStartHeads()).toEqual([]);
        expect(queue.size()).toBe(0);
      });
    }
  }

  it('deduplicates display and event mirrors by message id across incremental drains', () => {
    const first = input('Continue', 'first');
    append(first);
    const initial = drainTraexRollout(path, 0);
    append({ timestamp: new Date(START + 500).toISOString(), type: 'event_msg',
      payload: { type: 'item_completed', thread_id: SID, turn_id: NATIVE,
        item: first.payload.display_completions[0].item } },
    input('Continue', 'first', START + 700), input('Continue', 'second', START + 1_000));
    const later = drainTraexRollout(path, initial.newOffset);
    expect([...initial.events, ...later.events].filter(ev => ev.kind === 'user')
      .map(ev => ev.sourceMessageId)).toEqual(['first', 'second']);
  });

  it('a submit probe does not consume the production reader receipts', () => {
    append(input('Task', 'first'), input('Correction', 'second', START + 1_000));
    expect(drainTraexRollout(path, 0, { probe: true }).events.filter(ev => ev.kind === 'user')).toHaveLength(2);
    expect(drainTraexRollout(path, 0).events.filter(ev => ev.kind === 'user')).toHaveLength(2);
  });

  it('retired mirror state does not swallow an identical legacy input in the next turn', () => {
    append(input('Continue', 'first'), input('Continue', 'second', START + 1_000), terminal());
    const initial = drainTraexRollout(path, 0);
    append({ timestamp: new Date(START + 2_100).toISOString(), type: 'event_msg',
      payload: { type: 'user_message', message: 'Continue' } });
    expect(drainTraexRollout(path, initial.newOffset).events.filter(ev => ev.kind === 'user')
      .map(ev => ev.text)).toEqual(['Continue']);
  });

  it('the legacy first-message mirror binds without becoming an extra steering input', () => {
    append({ timestamp: new Date(START).toISOString(), type: 'event_msg',
      payload: { type: 'user_message', message: 'Task' } });
    const first = drainTraexRollout(path, 0);
    append(input('Task', 'first', START + 100), input('Correction', 'second', START + 1_000), terminal());
    const later = drainTraexRollout(path, first.newOffset);
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest([...first.events, ...later.events]);
    expect(later.events.filter(ev => ev.kind === 'user').map(ev => ev.text)).toEqual(['Correction']);
    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-second']);
    expect(queue.size()).toBe(0);
  });

  it('a turn-bound id-less adopt turn ignores the same message replayed from another rollout path', () => {
    // Late attach replays an id-less legacy user record first; its UserMessage
    // mirror arrives in a later drain as a turn_bind that establishes the
    // native (turn, message) identity. A resumed/rotated rollout segment then
    // replays the SAME native message under a fresh uuid — the queue's
    // logical-message dedup (shared across rollout paths, unlike the per-path
    // drainer receipts) must suppress it instead of synthesizing a duplicate
    // local turn that supersedes the bound one.
    const queue = new CodexBridgeQueue();
    queue.setLocalTurns(true, START);
    const superseded: string[] = [];
    queue.setCotSupersededObserver(turn => superseded.push(turn.turnId));
    queue.ingest([{ kind: 'user', text: 'Task', uuid: 'legacy-user', timestampMs: START,
      sourceSessionId: SID }]);
    queue.ingest([{ kind: 'turn_bind', text: '', uuid: 'delayed-bind', timestampMs: START + 100,
      sourceSessionId: SID, sourceTurnId: NATIVE, sourceMessageId: 'first' }]);
    queue.ingest([{ kind: 'user', text: 'Task', uuid: 'replayed-from-next-segment',
      timestampMs: START + 200, sourceSessionId: SID, sourceTurnId: NATIVE,
      sourceMessageId: 'first' }]);
    expect(queue.peek().map(turn => turn.turnId)).toEqual(['codex-local-legacy-user']);
    expect(queue.peek()[0]).toEqual(expect.objectContaining({
      sourceTurnId: NATIVE, sourceMessageId: 'first',
    }));
    expect(superseded).toEqual([]);
  });

  it('a resumed segment replaying the same message does not synthesize a second local turn', () => {
    // TraeX writes a resumed session as a new rollout segment that replays the
    // copied user record under a fresh path (hence a fresh event uuid). The
    // (turn, message) identity is unchanged, so adopt-mode synthesis must not
    // open a second local turn that supersedes the still-open first one.
    const resumed = join(dir, `rollout-2026-01-01T00-00-00-${SID}_${NATIVE}.jsonl`);
    writeFileSync(resumed, '');
    append(input('Task', 'first'));
    appendFileSync(resumed, JSON.stringify(input('Task', 'first')) + '\n');
    const queue = new CodexBridgeQueue();
    queue.setLocalTurns(true, START);
    const superseded: string[] = [];
    queue.setCotSupersededObserver(turn => superseded.push(turn.turnId));
    queue.ingest(drainTraexRollout(path, 0, { adoptMode: true }).events);
    queue.ingest(drainTraexRollout(resumed, 0, { adoptMode: true }).events);
    expect(queue.peek()).toHaveLength(1);
    expect(superseded).toEqual([]);
  });

  it('an interrupted merged turn settles the latest input as ambiguous', () => {
    append(input('Task', 'first'), input('Correction', 'second', START + 1_000), terminal(START + 2_000, NATIVE, true));
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest(drainTraexRollout(path, 0).events);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({
      turnId: 'lark-second', terminalStatus: 'ambiguous', finalText: '',
    })]);
    expect(queue.size()).toBe(0);
  });

  it('a mirrored superseded message cannot consume a third identical queued input', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Continue', START);
    queue.mark('lark-second', 'Continue', START);
    queue.mark('lark-third', 'Continue', START);
    queue.ingest([event('Continue', 'first'), event('Continue', 'second', START + 1_000),
      { ...event('Continue', 'first', START + 1_500), uuid: 'late-first-mirror' }]);
    expect(queue.peek().map(turn => [turn.turnId, turn.started])).toEqual([
      ['lark-second', true], ['lark-third', false],
    ]);
  });

  it('an unmatched or stale message cannot supersede a running task', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest([event('Task', 'first'), event('Unrelated', 'stray', START + 1_000),
      event('Correction', 'stale', START - 10_000)]);
    expect(queue.peek().map(turn => [turn.turnId, turn.started])).toEqual([
      ['lark-first', true], ['lark-second', false],
    ]);
  });

  it('an early transcript receipt remains available until its pending message is marked', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Task', START);
    queue.ingest([event('Task', 'first'), event('Correction', 'second', START + 1_000)]);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest([{ kind: 'assistant_final', text: 'Combined answer', uuid: 'terminal',
      timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-second']);
    expect(queue.size()).toBe(0);
  });

  it('adopted local corrections receive the single combined final', () => {
    append(input('Task', 'first'), input('Correction', 'second', START + 1_000), terminal());
    const queue = new CodexBridgeQueue();
    queue.setLocalTurns(true, START);
    queue.ingest(drainTraexRollout(path, 0, { adoptMode: true }).events);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({
      isLocal: true, userText: 'Correction', finalText: 'Combined answer',
    })]);
    expect(queue.size()).toBe(0);
  });

  it('thinking after a correction belongs to the latest accepted message', () => {
    const queue = new CodexBridgeQueue();
    const thinking: string[] = [];
    queue.setCotObserver((_entries, turn) => thinking.push(turn.turnId));
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest([event('Task', 'first'), event('Correction', 'second', START + 1_000),
      { kind: 'cot', text: '', uuid: 'thinking', timestampMs: START + 1_500,
        sourceSessionId: SID, sourceTurnId: NATIVE, cotEntries: [{ kind: 'thinking', text: 'Working' }] }]);
    expect(thinking).toEqual(['lark-second']);
  });

  it('an input without any native receipt still produces the missing-transcript notice', () => {
    let now = START + 2_000;
    const queue = new CodexBridgeQueue(() => now);
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-missing', 'Missing correction', START + 1_000);
    append(input('Task', 'first'), terminal());
    queue.ingest(drainTraexRollout(path, 0).events);
    queue.drainEmittable();
    now += STRUCTURED_SUBMIT_START_GRACE_MS + 1;
    const expired = queue.pruneExpiredPreStartHeads();
    expect(uncollectedTurnsNeedingNotice(expired, { settledByTerminal: new Set(), hasOwnNotice: () => false })
      .map(turn => turn.turnId)).toEqual(['lark-missing']);
  });
});
