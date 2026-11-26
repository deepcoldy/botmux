import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  countAntigravityUserInputMatches,
  findCompletedAntigravityTurnIdsPaired,
  hashAntigravitySubmittedText,
  resolveAntigravityCandidateMinByteOffset,
  resolveAntigravityTranscriptPath,
} from '../src/services/antigravity-transcript.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { isValidMarkerIdentityTurnId } from '../src/core/turn-id-shape.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { isAntigravityInterruptedScreen, parseAntigravityFooterBackgroundTasks } from '../src/adapters/cli/antigravity.js';
import { PtyOutputGeneration } from '../src/utils/runtime-screen-status.js';

function withTempWorkspace(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agy-folded-turn-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function larkEnvelope(turnId: string, body: string): string {
  return [
    '<session_id>sid-agy</session_id>',
    `<message_location message_id="${turnId}" placement="thread" root_message_id="om_root" />`,
    `<user_message>\n${body}\n</user_message>`,
  ].join('\n\n');
}

function userInputRecord(stepIndex: number, payload: string, source = 'USER_EXPLICIT'): string {
  return JSON.stringify({
    step_index: stepIndex,
    source,
    type: 'USER_INPUT',
    status: 'DONE',
    content: `<USER_REQUEST>\n${payload}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>`,
  });
}

function plannerDoneRecord(stepIndex: number, content = 'BOTMUX_NOTHING_TO_SEND'): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content,
  });
}

function plannerToolCallRecord(stepIndex: number): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: '',
    tool_calls: [{ name: 'run_command', args: { CommandLine: '"echo hi"' } }],
  });
}

function workerHarness(opts: {
  markerPath: string;
  transcriptPath: string;
  cliSessionId: string;
  xpiOn?: boolean;
  reattach?: boolean;
}) {
  const scope: Record<string, any> = {
    sessionId: 'sid-agy',
    lastInitConfig: { cliId: 'antigravity', cliSessionId: opts.cliSessionId },
    inputDeliveryObservedCliSessionId: undefined,
    lastSpawnEffectiveCliSessionId: opts.cliSessionId,
    effectiveBackendType: 'tmux',
    isRemoteBackendType: () => false,
    backend: opts.reattach ? { isReattach: true } : { isReattach: false },
    cliPidMarker: opts.markerPath,
    rpcEnginePidMarker: undefined,
    currentBotmuxTurnId: undefined,
    currentBotmuxDispatchAttempt: undefined,
    currentBotmuxCallerOpenId: undefined,
    currentBotmuxLinkRefMode: undefined,
    currentVcMeetingImTurnOrigin: undefined,
    currentTurnSteerPromoted: false,
    queuedTurnAdvanceConsumedForPrompt: undefined,
    queuedTypeAheadTurns: [],
    retiredTurnIds: new Set<string>(),
    recentSubmittedTurnTexts: new Map<string, any>(),
    activeTurnAuthority: new ActiveTurnAuthority(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    ptyOutputGeneration: { value: 10, snapshot() { return this.value; } },
    sandboxRelayCapability: null,
    completeManagedTurnOriginRevocation: vi.fn(),
    flushPending: vi.fn(),
    queueMicrotask: (fn: () => void) => fn(),
    publishSandboxRelayCapability: vi.fn(),
    publishActiveTurn: vi.fn(),
    readProcessStartIdentity: () => undefined,
    crossPrincipalIsolationOn: () => opts.xpiOn === true,
    send: vi.fn(),
    log: vi.fn(),
    existsSync,
    readFileSync,
    statSync,
    basename,
    atomicWriteFileSync,
    withPidMarkerLock: (_path: string, fn: () => void) => fn(),
    resolveAntigravityTranscriptPath: (cid: string) => (cid === opts.cliSessionId ? opts.transcriptPath : null),
    findCompletedAntigravityTurnIdsPaired,
    hashAntigravitySubmittedText,
    resolveAntigravityCandidateMinByteOffset,
    countAntigravityUserInputMatches,
    markerIdentityTurnId: loadWorkerFunction('markerIdentityTurnId', { isValidMarkerIdentityTurnId }),
  };
  scope.markTurnRetired = (turnId?: string) => { if (turnId) scope.retiredTurnIds.add(turnId); };
  scope.setCaptureIdentity = (turnId?: string, dispatchAttempt?: number, caller?: string) => {
    scope.currentBotmuxTurnId = turnId;
    scope.currentBotmuxDispatchAttempt = dispatchAttempt;
    scope.currentBotmuxCallerOpenId = caller;
  };
  scope.rememberQueuedTurnAdvanceForPendingReady = (predecessorTurnId?: string) => {
    scope.queuedTurnAdvanceConsumedForPrompt = {
      outputGeneration: scope.ptyOutputGeneration.snapshot(),
      ...(predecessorTurnId ? { predecessorTurnId } : {}),
      ...(scope.currentBotmuxTurnId ? { promotedTurnId: scope.currentBotmuxTurnId } : {}),
    };
  };
  scope.adoptInitialActiveTurn = (parsed: any) => {
    scope.setCaptureIdentity(parsed.turnId, typeof parsed.dispatchAttempt === 'number' ? parsed.dispatchAttempt : undefined, parsed.callerOpenId);
    scope.markActiveTurnStarted({
      turnId: parsed.turnId,
      ...(typeof parsed.dispatchAttempt === 'number' ? { dispatchAttempt: parsed.dispatchAttempt } : {}),
      ...(parsed.trustedCaller ? { trustedCaller: parsed.trustedCaller } : {}),
    });
  };
  scope.adoptDisplacedActiveTurn = vi.fn();

  const names = [
    'turnAuthorityIdentity',
    'adoptActiveTurnWhenIsolationOff',
    'activeTurnBlocks',
    'markActiveTurnStarted',
    'releaseActiveTurnAuthority',
    'dropQueuedTurnRecord',
    'turnTerminalEmitted',
    'retireTerminatedMarkerTurn',
    'markerQueuedTurnStillLive',
    'activeAuthorityMatchesMarker',
    'writeCliPidMarker',
    'syncQueuedTurnsFromMarkerDisk',
    'advanceQueuedTypeAheadTurn',
    'rememberSubmittedTurnText',
    'reconcileCompletedAntigravityTurnsAtPromptReady',
  ];
  for (const name of names) scope[name] = loadWorkerFunction(name, scope);
  return scope;
}

function runPromptReadySettlement(h: Record<string, any>): void {
  h.reconcileCompletedAntigravityTurnsAtPromptReady();
  const observedQueuedAdvanceGeneration = h.queuedTurnAdvanceConsumedForPrompt?.outputGeneration;
  const readyTransition = (syncedFromDisk: boolean) => decideQueuedReadyTransition({
    observedOutputGeneration: observedQueuedAdvanceGeneration,
    currentOutputGeneration: h.ptyOutputGeneration.snapshot(),
    durableTurnInFlight: false,
    preserveActiveTurnAuthority: false,
    syncedFromDisk,
    hasQueuedTurn: h.queuedTypeAheadTurns.length > 0,
  });
  if (readyTransition(false).releaseActiveTurnAuthority) {
    h.releaseActiveTurnAuthority('prompt_ready');
  }
  const syncedFromDisk = h.syncQueuedTurnsFromMarkerDisk();
  if (readyTransition(syncedFromDisk).advanceQueuedTurn) {
    h.advanceQueuedTypeAheadTurn('prompt_ready');
  }
  h.queuedTurnAdvanceConsumedForPrompt = undefined;
}

describe('findCompletedAntigravityTurnIdsPaired', () => {
  it('proves folded message_location and schedule inputs completed before PLANNER_RESPONSE DONE', () => {
    withTempWorkspace(dir => {
      const scheduleText = '<session_id>sid-agy</session_id>\n\n[定时任务] 巡检 PR 状态';
      const transcript = writePairedTranscript(dir, [
        userInputRecord(1, larkEnvelope('om_A', 'first')),
        userInputRecord(2, scheduleText),
        userInputRecord(3, larkEnvelope('om_B', 'follow up')),
        plannerToolCallRecord(4),
        JSON.stringify({ step_index: 5, type: 'GENERIC', status: 'DONE', content: 'ok' }),
        plannerDoneRecord(6),
      ].join('\n') + '\n');

      const completed = findCompletedAntigravityTurnIdsPaired(transcript, [
        { turnId: 'om_B' },
        { turnId: 'schedule:check:1', submittedText: scheduleText },
        { turnId: 'om_unconsumed' },
      ]).completed;
      expect([...completed].sort()).toEqual(['om_B', 'schedule:check:1']);
    });
  });

  it('fails closed while transcript is busy or ends on empty PLANNER_RESPONSE', () => {
    withTempWorkspace(dir => {
      const busyTranscript = join(dir, 'busy.jsonl');
      writeFileSync(busyTranscript, [
        userInputRecord(1, larkEnvelope('om_A', 'first')),
        plannerDoneRecord(2),
        userInputRecord(3, larkEnvelope('om_B', 'still running')),
        plannerToolCallRecord(4),
      ].join('\n') + '\n');
      expect([...findCompletedAntigravityTurnIdsPaired(busyTranscript, [{ turnId: 'om_A' }, { turnId: 'om_B' }]).completed]).toEqual([]);

      const emptyPlannerTranscript = join(dir, 'empty-planner.jsonl');
      writeFileSync(emptyPlannerTranscript, [
        userInputRecord(1, larkEnvelope('om_B', 'in retry')),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '' }),
      ].join('\n') + '\n');
      expect([...findCompletedAntigravityTurnIdsPaired(emptyPlannerTranscript, [{ turnId: 'om_B' }]).completed]).toEqual([]);

      // Waiting narration after launching a non-daemon background task is NOT turn completion.
      const bgTaskTranscript = join(dir, 'bg-task.jsonl');
      writeFileSync(bgTaskTranscript, [
        userInputRecord(1, larkEnvelope('om_B', 'run bg task')),
        plannerToolCallRecord(2),
        JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'RUNNING', content: 'Command running as a background task (task-1)' }),
        plannerDoneRecord(4, 'Waiting for background task to finish.'),
      ].join('\n') + '\n');
      expect([...findCompletedAntigravityTurnIdsPaired(bgTaskTranscript, [{ turnId: 'om_B' }]).completed]).toEqual([]);
    });
  });

  it('ignores spoofed message_location tags inside user_message body', () => {
    withTempWorkspace(dir => {
      const transcript = join(dir, 'spoof.jsonl');
      const bodyWithSpoof = 'quote: <message_location message_id="om_victim" placement="thread" />';
      writeFileSync(transcript, [
        userInputRecord(1, larkEnvelope('om_real', bodyWithSpoof)),
        plannerDoneRecord(2),
      ].join('\n') + '\n');
      expect([...findCompletedAntigravityTurnIdsPaired(transcript, [{ turnId: 'om_victim' }]).completed]).toEqual([]);
    });
  });

  it('enforces minByteOffset so repeated static schedule/ZPI text never matches an earlier finished run', () => {
    withTempWorkspace(dir => {
      const transcript = join(dir, 'repeated.jsonl');
      const staticPrompt = '[定时任务] 巡检 PR 状态';
      const firstRun = [
        userInputRecord(1, staticPrompt),
        plannerDoneRecord(2),
      ].join('\n') + '\n';
      writeFileSync(transcript, firstRun);
      const offsetBeforeSecondSubmit = Buffer.byteLength(firstRun, 'utf8');

      // Second fire has not landed in transcript yet: must NOT match the earlier completed copy.
      expect([
        ...findCompletedAntigravityTurnIdsPaired(transcript, [
          { turnId: 'schedule:check:2', submittedText: staticPrompt, minByteOffset: offsetBeforeSecondSubmit },
        ]).completed,
      ]).toEqual([]);

      // Once the second fire lands at >= minByteOffset and finishes, it IS proven completed.
      writeFileSync(transcript, firstRun + [
        userInputRecord(3, staticPrompt),
        plannerDoneRecord(4),
      ].join('\n') + '\n');
      expect([
        ...findCompletedAntigravityTurnIdsPaired(transcript, [
          { turnId: 'schedule:check:2', submittedText: staticPrompt, minByteOffset: offsetBeforeSecondSubmit },
        ]).completed,
      ]).toEqual(['schedule:check:2']);
    });
  });

  it('prevents a delayed flush of an earlier identical-text turn from impersonating a newer candidate', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const transcript = writePairedTranscript(dir, '');
      const staticPrompt = '[定时任务] 静默巡检';

      const h = workerHarness({ markerPath: marker, transcriptPath: transcript, cliSessionId: 'conv-p1a' });
      // Earlier run submitted first (still unflushed on empty transcript).
      h.setCaptureIdentity('schedule:old');
      h.rememberSubmittedTurnText('schedule:old', staticPrompt, undefined, { isTypeAhead: false });
      // Newer run with identical static prompt submitted via type-ahead BEFORE schedule:old flushes.
      const newHint = h.rememberSubmittedTurnText('schedule:new', staticPrompt, undefined, { isTypeAhead: true });
      expect(newHint.skipPriorMatches).toBe(1);

      // Only schedule:old's USER_INPUT + DONE flushes to disk; schedule:new has NOT been written.
      const firstRun = [
        userInputRecord(1, staticPrompt),
        plannerDoneRecord(2),
      ].join('\n') + '\n';
      writePairedTranscript(dir, firstRun);

      expect([
        ...findCompletedAntigravityTurnIdsPaired(transcript, [{
          turnId: 'schedule:new',
          submittedText: staticPrompt,
          sampledTranscriptPath: newHint.sampledTranscriptPath,
          minByteOffset: newHint.minByteOffset,
          skipPriorMatches: newHint.skipPriorMatches,
        }]).completed,
      ]).toEqual([]);

      // Also verify 1-to-1 occurrence ownership: a single USER_INPUT cannot satisfy two identical candidates.
      expect([
        ...findCompletedAntigravityTurnIdsPaired(transcript, [
          { turnId: 'schedule:old', submittedText: staticPrompt, minByteOffset: 0 },
          { turnId: 'schedule:new', submittedText: staticPrompt, minByteOffset: 0 },
        ]).completed,
      ]).toEqual(['schedule:old']);

      // Once schedule:new's own independent occurrence lands and finishes, it IS completed.
      writePairedTranscript(dir, firstRun + [
        userInputRecord(3, staticPrompt),
        plannerDoneRecord(4),
      ].join('\n') + '\n');
      expect([
        ...findCompletedAntigravityTurnIdsPaired(transcript, [{
          turnId: 'schedule:new',
          submittedText: staticPrompt,
          sampledTranscriptPath: newHint.sampledTranscriptPath,
          minByteOffset: newHint.minByteOffset,
          skipPriorMatches: newHint.skipPriorMatches,
        }]).completed,
      ]).toEqual(['schedule:new']);
    });
  });

  it('maps compact minByteOffset to full coordinates when transcript switches from compact to full', () => {
    withTempWorkspace(dir => {
      const compactPath = join(dir, 'transcript.jsonl');
      const fullPath = join(dir, 'transcript_full.jsonl');
      const staticPrompt = '[定时任务] 相同静态巡检提示词';
      const fillerCompact = JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', content: 'short' });
      const fillerFull = JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', content: 'x'.repeat(4000) });
      const compactPrior = [
        fillerCompact,
        userInputRecord(1, staticPrompt),
        plannerDoneRecord(2, 'compact done'),
      ].join('\n') + '\n';
      const fullPrior = [
        fillerFull,
        userInputRecord(1, staticPrompt),
        plannerDoneRecord(2, 'full done ' + 'y'.repeat(500)),
      ].join('\n') + '\n';
      writeFileSync(compactPath, compactPrior);

      // Sampled while only compact exists (small byte offset).
      const compactOffset = Buffer.byteLength(compactPrior, 'utf8');
      // Full sibling appears later with much larger offsets for the exact same historical records.
      writeFileSync(fullPath, fullPrior);

      // Must NOT falsely match the historical USER_INPUT in full even though its byte offset > compactOffset.
      expect([
        ...findCompletedAntigravityTurnIdsPaired(fullPath, [{
          turnId: 'schedule:sibling',
          submittedText: staticPrompt,
          sampledTranscriptPath: compactPath,
          minByteOffset: compactOffset,
        }]).completed,
      ]).toEqual([]);

      // After a genuinely new occurrence lands in both siblings, it IS proven completed.
      const newRun = [
        userInputRecord(3, staticPrompt),
        plannerDoneRecord(4, 'new run done'),
      ].join('\n') + '\n';
      writeFileSync(compactPath, compactPrior + newRun);
      writeFileSync(fullPath, fullPrior + newRun);
      expect([
        ...findCompletedAntigravityTurnIdsPaired(fullPath, [{
          turnId: 'schedule:sibling',
          submittedText: staticPrompt,
          sampledTranscriptPath: compactPath,
          minByteOffset: compactOffset,
        }]).completed,
      ]).toEqual(['schedule:sibling']);
    });
  });
});

function writePairedTranscript(dir: string, fullContent: string, compactContent = fullContent): string {
  const fullPath = join(dir, 'transcript_full.jsonl');
  const compactPath = join(dir, 'transcript.jsonl');
  writeFileSync(fullPath, fullContent);
  writeFileSync(compactPath, compactContent);
  return fullPath;
}

describe('Antigravity prompt_ready folded-turn reconciliation', () => {
  it('clears authority after late disk marker for already-completed B so queued schedules run (XPI off & on)', () => {
    for (const xpiOn of [false, true]) {
      withTempWorkspace(dir => {
        const marker = join(dir, 'marker.json');
        const transcript = writePairedTranscript(dir, [
          userInputRecord(1, larkEnvelope('schedule:host:1', 'host')),
          userInputRecord(2, larkEnvelope('om_B', 'folded reply')),
          plannerDoneRecord(3),
        ].join('\n') + '\n');

        const h = workerHarness({ markerPath: marker, transcriptPath: transcript, cliSessionId: 'conv-1', xpiOn });
        const callerA = { requestUserOpenId: 'ou_a', requestLarkAppId: 'app', senderType: 'user' as const };
        const callerB = { requestUserOpenId: 'ou_b', requestLarkAppId: 'app', senderType: 'user' as const };
        h.setCaptureIdentity('schedule:host:1', undefined, callerA.requestUserOpenId);
        h.markActiveTurnStarted({ turnId: 'schedule:host:1', trustedCaller: callerA });
        h.queuedTypeAheadTurns.push({ turnId: 'om_B', trustedCaller: callerB });
        // `botmux send --response-kind final` promoted B on disk while A+B ran.
        writeFileSync(marker, JSON.stringify({
          sessionId: 'sid-agy',
          turnId: 'om_B',
          trustedCaller: callerB,
          queuedTurns: [],
        }));

        runPromptReadySettlement(h);

        expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
        expect(h.queuedTypeAheadTurns).toEqual([]);
        expect(h.retiredTurnIds.has('om_B')).toBe(true);
        expect(h.activeTurnBlocks({ turnId: 'schedule:next:2', queueAfterActiveTurn: true })).toBe(false);
        expect(h.activeTurnBlocks({ turnId: 'om_other_user', trustedCaller: callerB })).toBe(false);
      });
    }
  });

  it('releases already-synced B on same PTY generation when transcript proves B completed', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const transcript = writePairedTranscript(dir, [
        userInputRecord(1, larkEnvelope('om_A', 'first')),
        userInputRecord(2, larkEnvelope('om_B', 'folded B')),
        userInputRecord(3, larkEnvelope('om_C', 'folded C')),
        plannerDoneRecord(4),
      ].join('\n') + '\n');

      const h = workerHarness({ markerPath: marker, transcriptPath: transcript, cliSessionId: 'conv-2' });
      h.setCaptureIdentity('om_B');
      h.markActiveTurnStarted({ turnId: 'om_B' });
      h.queuedTypeAheadTurns.push({ turnId: 'om_C' });
      // Lagging disk read promoted A -> B at the same PTY output generation.
      h.rememberQueuedTurnAdvanceForPendingReady('om_A');
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid-agy', turnId: 'om_B', queuedTurns: [{ turnId: 'om_C' }] }));

      runPromptReadySettlement(h);

      expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
      expect(h.queuedTypeAheadTurns).toEqual([]);
      expect(h.activeTurnBlocks({ turnId: 'schedule:next:3', queueAfterActiveTurn: true })).toBe(false);
    });
  });

  it('preserves B authority and queued C when A ready is late and B is still executing', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const transcript = join(dir, 'transcript_full.jsonl');
      writeFileSync(transcript, [
        userInputRecord(1, larkEnvelope('om_A', 'first')),
        plannerDoneRecord(2),
        userInputRecord(3, larkEnvelope('om_B', 'still running B')),
        plannerToolCallRecord(4),
      ].join('\n') + '\n');

      const h = workerHarness({ markerPath: marker, transcriptPath: transcript, cliSessionId: 'conv-3' });
      h.setCaptureIdentity('om_B');
      h.markActiveTurnStarted({ turnId: 'om_B' });
      h.queuedTypeAheadTurns.push({ turnId: 'om_C' });
      h.rememberQueuedTurnAdvanceForPendingReady('om_A');
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid-agy', turnId: 'om_B', queuedTurns: [{ turnId: 'om_C' }] }));

      runPromptReadySettlement(h);

      expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_B');
      expect(h.currentBotmuxTurnId).toBe('om_B');
      expect(h.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['om_C']);
    });
  });

  it('advances past completed B to still-unconsumed C', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const transcript = writePairedTranscript(dir, [
        userInputRecord(1, larkEnvelope('om_A', 'first')),
        userInputRecord(2, larkEnvelope('om_B', 'folded B')),
        plannerDoneRecord(3),
      ].join('\n') + '\n');

      const h = workerHarness({ markerPath: marker, transcriptPath: transcript, cliSessionId: 'conv-4' });
      h.setCaptureIdentity('om_A');
      h.markActiveTurnStarted({ turnId: 'om_A' });
      h.queuedTypeAheadTurns.push({ turnId: 'om_B' }, { turnId: 'om_C' });
      writeFileSync(marker, JSON.stringify({
        sessionId: 'sid-agy',
        turnId: 'om_B',
        queuedTurns: [{ turnId: 'om_C' }],
      }));

      runPromptReadySettlement(h);

      expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_C');
      expect(h.currentBotmuxTurnId).toBe('om_C');
      expect(h.queuedTypeAheadTurns).toEqual([]);
      expect(h.retiredTurnIds.has('om_B')).toBe(true);
    });
  });

  it('preserves a live durable retry of the same turnId under another dispatchAttempt', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const transcript = join(dir, 'transcript_full.jsonl');
      writeFileSync(transcript, [
        userInputRecord(1, larkEnvelope('om_retry', 'first non-durable run')),
        plannerDoneRecord(2),
      ].join('\n') + '\n');

      const h = workerHarness({ markerPath: marker, transcriptPath: transcript, cliSessionId: 'conv-5' });
      h.setCaptureIdentity('om_host');
      h.markActiveTurnStarted({ turnId: 'om_host' });
      h.queuedTypeAheadTurns.push({ turnId: 'om_retry', dispatchAttempt: 2 });
      writeFileSync(marker, JSON.stringify({
        sessionId: 'sid-agy',
        turnId: 'om_retry',
        queuedTurns: [{ turnId: 'om_retry', dispatchAttempt: 2 }],
      }));

      runPromptReadySettlement(h);

      // Non-durable disk head must not tombstone the durable attempt=2 retry.
      expect(h.retiredTurnIds.has('om_retry')).toBe(false);
      expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_retry');
      expect(h.activeTurnAuthority.snapshot()?.dispatchAttempt).toBe(2);
    });
  });

  it('reconciles folded turns after reattach without in-memory submittedText', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const transcript = writePairedTranscript(dir, [
        userInputRecord(1, larkEnvelope('om_B', 'before reattach')),
        userInputRecord(2, larkEnvelope('om_C', 'folded before reattach')),
        plannerDoneRecord(3),
      ].join('\n') + '\n');

      const h = workerHarness({
        markerPath: marker,
        transcriptPath: transcript,
        cliSessionId: 'conv-reattach',
        reattach: true,
      });
      h.setCaptureIdentity('om_B');
      h.markActiveTurnStarted({ turnId: 'om_B' });
      h.queuedTypeAheadTurns.push({ turnId: 'om_C' });
      writeFileSync(marker, JSON.stringify({
        sessionId: 'sid-agy',
        turnId: 'om_B',
        queuedTurns: [{ turnId: 'om_C' }],
      }));

      runPromptReadySettlement(h);

      expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
      expect(h.queuedTypeAheadTurns).toEqual([]);
      expect(JSON.parse(readFileSync(marker, 'utf8')).queuedTurns).toBeUndefined();
      expect(h.activeTurnBlocks({ turnId: 'schedule:after-reattach:1', queueAfterActiveTurn: true })).toBe(false);
    });
  });

  it('reconciles static scheduled turns without message_location after worker reattach via persisted marker hint (P2)', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const staticSchedulePrompt = '[定时任务] 每 15 分钟检查上游 PR';
      const initialTranscript = [
        userInputRecord(1, larkEnvelope('om_host', 'initial human turn')),
      ].join('\n') + '\n';
      const transcript = writePairedTranscript(dir, initialTranscript);

      // Worker 1 submits a static scheduled turn via type-ahead and persists its reconcileHint in PID marker.
      const h1 = workerHarness({ markerPath: marker, transcriptPath: transcript, cliSessionId: 'conv-reattach-sched' });
      h1.setCaptureIdentity('om_host');
      h1.markActiveTurnStarted({ turnId: 'om_host' });
      const hint = h1.rememberSubmittedTurnText('schedule:poll:reattach', staticSchedulePrompt, undefined, { isTypeAhead: true });
      h1.queuedTypeAheadTurns.push({ turnId: 'schedule:poll:reattach', antigravityReconcileHint: hint });
      h1.writeCliPidMarker();

      // Both turns fold and finish in transcript while worker restarts/reattaches.
      writePairedTranscript(dir, initialTranscript + [
        userInputRecord(2, staticSchedulePrompt),
        plannerDoneRecord(3),
      ].join('\n') + '\n');

      // Worker 2 reattaches with empty in-memory recentSubmittedTurnTexts.
      const h2 = workerHarness({
        markerPath: marker,
        transcriptPath: transcript,
        cliSessionId: 'conv-reattach-sched',
        reattach: true,
      });
      h2.setCaptureIdentity('om_host');
      h2.markActiveTurnStarted({ turnId: 'om_host' });
      h2.syncQueuedTurnsFromMarkerDisk();
      expect(h2.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['schedule:poll:reattach']);

      runPromptReadySettlement(h2);

      expect(h2.activeTurnAuthority.snapshot()).toBeUndefined();
      expect(h2.queuedTypeAheadTurns).toEqual([]);
      expect(h2.retiredTurnIds.has('schedule:poll:reattach')).toBe(true);
      expect(h2.activeTurnBlocks({ turnId: 'schedule:next:reattach', queueAfterActiveTurn: true })).toBe(false);
    });
  });

  it('resolves brain transcript path helper for real directory layout', () => {
    withTempWorkspace(dir => {
      const logs = join(dir, 'conv-real', '.system_generated', 'logs');
      mkdirSync(logs, { recursive: true });
      const fullPath = join(logs, 'transcript_full.jsonl');
      const compactPath = join(logs, 'transcript.jsonl');
      const done = `${userInputRecord(1, larkEnvelope('om_X', 'hi'))}\n${plannerDoneRecord(2)}\n`;
      writeFileSync(fullPath, done);
      writeFileSync(compactPath, done);
      const resolved = resolveAntigravityTranscriptPath('conv-real', { brainDir: dir });
      expect(resolved).toBe(fullPath);
      expect([...findCompletedAntigravityTurnIdsPaired(resolved!, [{ turnId: 'om_X' }]).completed]).toEqual(['om_X']);
    });
  });

  it.each(['full-progress', 'compact-progress', 'missing-compact', 'partial-compact'] as const)(
    'holds folded-turn B authority and keeps C queued on paired skew/gap (%s)',
    mode => {
      withTempWorkspace(dir => {
        const marker = join(dir, 'marker.json');
        const fullPath = join(dir, 'transcript_full.jsonl');
        const compactPath = join(dir, 'transcript.jsonl');
        const doneLines = [
          userInputRecord(1, larkEnvelope('om_A', 'first')),
          userInputRecord(2, larkEnvelope('om_B', 'folded B')),
          plannerDoneRecord(3),
        ].join('\n') + '\n';
        const busyLines = [
          userInputRecord(1, larkEnvelope('om_A', 'first')),
          userInputRecord(2, larkEnvelope('om_B', 'folded B')),
          plannerToolCallRecord(3),
        ].join('\n') + '\n';

        if (mode === 'full-progress') {
          writeFileSync(fullPath, busyLines);
          writeFileSync(compactPath, doneLines);
        } else if (mode === 'compact-progress') {
          writeFileSync(fullPath, doneLines);
          writeFileSync(compactPath, busyLines);
        } else if (mode === 'missing-compact') {
          writeFileSync(fullPath, doneLines);
        } else {
          writeFileSync(fullPath, doneLines);
          writeFileSync(compactPath, doneLines + '{"step_index":4,"type":"PLANNER_RESPONSE"');
        }

        const h = workerHarness({ markerPath: marker, transcriptPath: fullPath, cliSessionId: `conv-skew-${mode}` });
        h.setCaptureIdentity('om_B');
        h.markActiveTurnStarted({ turnId: 'om_B' });
        h.queuedTypeAheadTurns.push({ turnId: 'om_C' });
        h.rememberQueuedTurnAdvanceForPendingReady('om_A');
        writeFileSync(marker, JSON.stringify({ sessionId: 'sid-agy', turnId: 'om_B', queuedTurns: [{ turnId: 'om_C' }] }));

        runPromptReadySettlement(h);

        expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_B');
        expect(h.currentBotmuxTurnId).toBe('om_B');
        expect(h.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['om_C']);
      });
    },
  );

  it('self-heals folded-turn authority when a transiently missing compact sibling arrives (via retry timer and markPromptReady re-entry) without leaking across generations', async () => {
    vi.useFakeTimers();
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          withTempWorkspace(dir => {
            const marker = join(dir, 'marker.json');
            const fullPath = join(dir, 'transcript_full.jsonl');
            const compactPath = join(dir, 'transcript.jsonl');
            const doneLines = [
              userInputRecord(1, larkEnvelope('om_A', 'first')),
              userInputRecord(2, larkEnvelope('om_B', 'folded B')),
              plannerDoneRecord(3),
            ].join('\n') + '\n';

            const idleFooter = '────────\n>\n────────\n? for shortcuts';
            const pendingFooter = `${idleFooter} · gemini-4-neon · 1 task(s) · /tasks`;
            const interruptedFooter = [
              '  ⎿  Interrupted · What should Antigravity CLI do instead?',
              '────────',
              '>',
              '────────',
              '? for shortcuts · gemini-4-neon · 1 task(s) · /tasks',
            ].join('\n');

            // Compact sibling is transiently missing on first ready.
            writeFileSync(fullPath, doneLines);

            const makeReadyScope = (liveScreen?: () => string) => {
              const h = workerHarness({ markerPath: marker, transcriptPath: fullPath, cliSessionId: 'conv-heal' });
              Object.assign(h, {
                isPromptReady: false,
                cliSpawnGeneration: 1,
                cliRestartInProgress: false,
                durableTurnInFlight: false,
                pendingMessages: [],
                pendingAdoptMessages: [],
                pendingRawInputs: [],
                pendingInjections: [],
                shouldFlushInjectionsFirst: () => false,
                flushPendingInjections: async () => {},
                pendingSessionRename: null,
                isFlushing: false,
                webTerminalInputGeneration: 0,
                webTerminalSubmitGeneration: 0,
                renderer: undefined,
                publishScreenStatus: vi.fn(),
                idleDetector: undefined,
                stuckDetector: undefined,
                awaitingFirstPrompt: false,
                consecutiveInWorkerRestarts: 0,
                spawnArgvInitialPromptBusy: false,
                spawnArgvNeedsWorkingSeed: false,
                promptReadyEdges: 0,
                reattachOpenTurnGate: false,
                sandboxWrapperAwaitingFirstPrompt: undefined,
                kimiActivityObserver: undefined,
                codexAutoUpgrade: undefined,
                codexUpgradeTimer: undefined,
                persistCodexRunnerBuildOnReady: false,
                currentPostTerminalInputFence: () => false,
                traexFirstPromptViewportRejects: () => false,
                currentInputDeliveryQuarantine: () => undefined,
                remoteRunnerRecoveredTurnInFlight: false,
                bareShellLaunchBlocked: false,
                workerSessionEventScope: undefined,
                cliAdapter: { id: 'antigravity' },
                holdForNativeSessionFork: () => false,
                refreshSandboxedCliLeafAttestation: undefined,
                probeStartupBlocker: () => false,
                stopBusyPatternIdleProbe: () => {},
                readyGate: { shouldHold: () => false },
                awaitingPostSessionStartPromptEvidence: false,
                isSettlingFirstFlush: false,
                freshnessInputQueue: { onPromptReady: () => 'continue' },
                backgroundTaskTracker: { backgroundWait: () => 0, pendingTurnAgents: () => 0 },
                spawnArgvTurnStartGateHolds: () => false,
                forceReadyAfterTurnTerminal: false,
                structuredRejectedReadyEvidenceGeneration: undefined,
                stopStructuredStartGraceRecheck: () => {},
                releaseInterruptedStructuredBridgeOnFirstPrompt: () => {},
                hasStructuredLifecycleBlock: () => false,
                isCodexAppCliId: () => false,
                cliSubmissionInFlight: null,
                preserveActiveTurnAuthorityForReady: false,
                hasLiveAntigravityPendingTasks: () => false,
                judgeClaudeBridgeTurn: () => {},
                bridgeQueue: { cliQueueDrained: () => {} },
                settleSessionRenameOnPrompt: () => {},
                releaseRawInputRestartGate: () => {},
                inflightInputs: { onTurnComplete: () => {} },
                maybeEmitWorkflowTranscriptOutput: () => {},
                observeAntigravityFooterBackgroundTasks: () => {},
                refreshBackgroundWait: () => {},
                settleRestartAttemptOnReady: () => {},
                decideQueuedReadyTransition,
              });
              if (liveScreen) {
                Object.assign(h, {
                  structuredBridgeIs: (id: string) => id === 'antigravity',
                  backendScreenEvidenceIsAuthoritativeForMutation: () => true,
                  captureBackendScreen: () => liveScreen(),
                  isAntigravityInterruptedScreen,
                  parseAntigravityFooterBackgroundTasks,
                  codexBridgeFallbackActive: () => false,
                  resolveLiveAntigravityTranscriptPath: () => undefined,
                });
                h.cliAdapter.runnerFramedInput = false;
                h.ptyOutputGeneration = new PtyOutputGeneration();
                h.hasLiveAntigravityPendingTasks = loadWorkerFunction('hasLiveAntigravityPendingTasks', h);
                h.observeAntigravityFooterBackgroundTasks = loadWorkerFunction('observeAntigravityFooterBackgroundTasks', h);
              }
              h.armAntigravityFoldedReconcilePending = loadWorkerFunction('armAntigravityFoldedReconcilePending', h);
              h.tryReconcilePendingAntigravityFoldedTurns = loadWorkerFunction('tryReconcilePendingAntigravityFoldedTurns', h);
              h.cancelAntigravityFoldedReconcilePending = loadWorkerFunction('cancelAntigravityFoldedReconcilePending', h);
              h.trySettleAntigravityFoldedBackgroundHold = loadWorkerFunction('trySettleAntigravityFoldedBackgroundHold', h);
              h.markPromptReady = loadWorkerFunction('markPromptReady', h);
              h.setCaptureIdentity('om_B');
              h.markActiveTurnStarted({ turnId: 'om_B' });
              h.queuedTypeAheadTurns.push({ turnId: 'om_C' });
              h.rememberQueuedTurnAdvanceForPendingReady('om_A');
              writeFileSync(marker, JSON.stringify({ sessionId: 'sid-agy', turnId: 'om_B', queuedTurns: [{ turnId: 'om_C' }] }));
              return h;
            };

            // Experiment A: timer retry heals automatically once compact sibling lands.
            const hTimer = makeReadyScope(() => idleFooter);
            hTimer.markPromptReady();
            expect(hTimer.isPromptReady).toBe(true);
            expect(hTimer.currentBotmuxTurnId).toBe('om_B');
            expect(hTimer.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['om_C']);
            expect(hTimer.antigravityFoldedReconcilePending).toBeDefined();

            writeFileSync(compactPath, doneLines);
            vi.advanceTimersByTime(60);
            expect(hTimer.currentBotmuxTurnId).toBe('om_C');
            expect(hTimer.activeTurnAuthority.snapshot()?.turnId).toBe('om_C');
            expect(hTimer.queuedTypeAheadTurns).toEqual([]);
            expect(hTimer.retiredTurnIds.has('om_B')).toBe(true);
            expect(hTimer.antigravityFoldedReconcilePending).toBeUndefined();
            hTimer.cancelAntigravityFoldedReconcilePending();

            // Footer-only background work keeps a spawn/turn-scoped hold across
            // real output-generation advances and repeated ready/fs-watch edges.
            // Its clear redraw needs no transcript write and may arrive after the
            // folded reconcile window has ended.
            let liveScreen = idleFooter;
            rmSync(compactPath, { force: true });
            const hBackground = makeReadyScope(() => liveScreen);
            const feedBackground = (screen: string) => {
              liveScreen = screen;
              hBackground.ptyOutputGeneration.observe();
            };
            hBackground.markPromptReady();
            expect(hBackground.antigravityFoldedReconcilePending).toMatchObject({ attempts: 0 });
            feedBackground(pendingFooter);
            writeFileSync(compactPath, doneLines);
            vi.advanceTimersByTime(60);
            expect(hBackground.currentBotmuxTurnId).toBe('om_B');
            expect(hBackground.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['om_C']);
            expect(hBackground.antigravityFoldedReconcilePending).toBeUndefined();
            expect(hBackground.antigravityFoldedBackgroundHold).toMatchObject({
              cliSpawnGeneration: 1,
              turnId: 'om_B',
            });
            expect(hBackground.antigravityFoldedBackgroundHold?.timer).toBeUndefined();
            expect(hBackground.isPromptReady).toBe(true);
            expect(hBackground.publishScreenStatus).toHaveBeenCalledWith('working');

            // Later transcript activity cannot retract the already-proven B
            // completion or cancel the independent background hold.
            writeFileSync(compactPath, doneLines + JSON.stringify({
              step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'background output',
            }) + '\n');
            expect(hBackground.tryReconcilePendingAntigravityFoldedTurns('fs_watch')).toBe(false);
            hBackground.trySettleAntigravityFoldedBackgroundHold('fs_watch');
            expect(hBackground.antigravityFoldedBackgroundHold?.turnId).toBe('om_B');
            writeFileSync(compactPath, doneLines);

            feedBackground(pendingFooter);
            hBackground.markPromptReady();
            expect({
              current: hBackground.currentBotmuxTurnId,
              queued: hBackground.queuedTypeAheadTurns.map((t: any) => t.turnId),
              authority: hBackground.activeTurnAuthority.snapshot()?.turnId,
              ready: hBackground.isPromptReady,
              hold: hBackground.antigravityFoldedBackgroundHold?.turnId,
            }).toEqual({ current: 'om_B', queued: ['om_C'], authority: 'om_B', ready: true, hold: 'om_B' });

            vi.advanceTimersByTime(30_000);
            expect(hBackground.currentBotmuxTurnId).toBe('om_B');
            expect(hBackground.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['om_C']);

            feedBackground(idleFooter);
            hBackground.observeAntigravityFooterBackgroundTasks(liveScreen);
            expect(hBackground.antigravityFoldedBackgroundHold?.timer).toBeDefined();
            // Ordinary Web Terminal typing is not a new turn and must not cancel
            // the already-queued clear settlement.
            hBackground.webTerminalInputGeneration++;
            vi.advanceTimersByTime(0);
            expect(hBackground.currentBotmuxTurnId).toBe('om_C');
            expect(hBackground.activeTurnAuthority.snapshot()?.turnId).toBe('om_C');
            expect(hBackground.queuedTypeAheadTurns).toEqual([]);
            expect(hBackground.retiredTurnIds.has('om_B')).toBe(true);
            expect(hBackground.antigravityFoldedBackgroundHold).toBeUndefined();
            hBackground.cancelAntigravityFoldedReconcilePending();

            // A footer-clear timer already queued for the old CLI generation
            // must cancel itself rather than release/advance the replaced turn.
            let generationScreen = idleFooter;
            rmSync(compactPath, { force: true });
            const hHeldGeneration = makeReadyScope(() => generationScreen);
            const feedGeneration = (screen: string) => {
              generationScreen = screen;
              hHeldGeneration.ptyOutputGeneration.observe();
            };
            hHeldGeneration.markPromptReady();
            feedGeneration(pendingFooter);
            writeFileSync(compactPath, doneLines);
            vi.advanceTimersByTime(60);
            expect(hHeldGeneration.antigravityFoldedBackgroundHold?.turnId).toBe('om_B');
            feedGeneration(idleFooter);
            hHeldGeneration.observeAntigravityFooterBackgroundTasks(generationScreen);
            expect(hHeldGeneration.antigravityFoldedBackgroundHold?.timer).toBeDefined();
            hHeldGeneration.cliSpawnGeneration = 2;
            vi.advanceTimersByTime(0);
            expect(hHeldGeneration.currentBotmuxTurnId).toBe('om_B');
            expect(hHeldGeneration.activeTurnAuthority.snapshot()?.turnId).toBe('om_B');
            expect(hHeldGeneration.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['om_C']);
            expect(hHeldGeneration.antigravityFoldedBackgroundHold).toBeUndefined();
            hHeldGeneration.cancelAntigravityFoldedReconcilePending();

            // A direct Web submit, unlike ordinary typing, starts new local work
            // and must invalidate the old hold before its clear timer fires.
            let submitScreen = idleFooter;
            rmSync(compactPath, { force: true });
            const hHeldSubmit = makeReadyScope(() => submitScreen);
            hHeldSubmit.markPromptReady();
            submitScreen = pendingFooter;
            hHeldSubmit.ptyOutputGeneration.observe();
            writeFileSync(compactPath, doneLines);
            vi.advanceTimersByTime(60);
            expect(hHeldSubmit.antigravityFoldedBackgroundHold?.turnId).toBe('om_B');
            submitScreen = idleFooter;
            hHeldSubmit.ptyOutputGeneration.observe();
            hHeldSubmit.observeAntigravityFooterBackgroundTasks(submitScreen);
            expect(hHeldSubmit.antigravityFoldedBackgroundHold?.timer).toBeDefined();
            hHeldSubmit.webTerminalSubmitGeneration++;
            vi.advanceTimersByTime(0);
            expect(hHeldSubmit.currentBotmuxTurnId).toBe('om_B');
            expect(hHeldSubmit.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['om_C']);
            expect(hHeldSubmit.antigravityFoldedBackgroundHold).toBeUndefined();
            hHeldSubmit.cancelAntigravityFoldedReconcilePending();

            // Explicit interruption is fresh terminal evidence even though its
            // redraw advances output generation and still shows a task count.
            let interruptedScreen = idleFooter;
            rmSync(compactPath, { force: true });
            const hHeldInterrupt = makeReadyScope(() => interruptedScreen);
            hHeldInterrupt.markPromptReady();
            interruptedScreen = pendingFooter;
            hHeldInterrupt.ptyOutputGeneration.observe();
            writeFileSync(compactPath, doneLines);
            vi.advanceTimersByTime(60);
            expect(hHeldInterrupt.antigravityFoldedBackgroundHold?.turnId).toBe('om_B');
            interruptedScreen = interruptedFooter;
            hHeldInterrupt.ptyOutputGeneration.observe();
            hHeldInterrupt.markPromptReady();
            expect(hHeldInterrupt.currentBotmuxTurnId).toBe('om_C');
            expect(hHeldInterrupt.queuedTypeAheadTurns).toEqual([]);
            expect(hHeldInterrupt.antigravityFoldedBackgroundHold).toBeUndefined();
            hHeldInterrupt.cancelAntigravityFoldedReconcilePending();

            // Experiment B: markPromptReady() re-entry while isPromptReady===true reconciles immediately.
            rmSync(compactPath, { force: true });
            const hReentry = makeReadyScope();
            hReentry.markPromptReady();
            expect(hReentry.currentBotmuxTurnId).toBe('om_B');
            writeFileSync(compactPath, doneLines);
            hReentry.markPromptReady();
            expect(hReentry.currentBotmuxTurnId).toBe('om_C');
            expect(hReentry.queuedTypeAheadTurns).toEqual([]);
            expect(hReentry.antigravityFoldedReconcilePending).toBeUndefined();
            hReentry.cancelAntigravityFoldedReconcilePending();

            // Negative control: cliSpawnGeneration bump cancels pending reconciliation without advancing.
            rmSync(compactPath, { force: true });
            const hFenced = makeReadyScope();
            hFenced.markPromptReady();
            expect(hFenced.antigravityFoldedReconcilePending).toBeDefined();
            hFenced.cliSpawnGeneration = 2;
            writeFileSync(compactPath, doneLines);
            vi.advanceTimersByTime(100);
            expect(hFenced.currentBotmuxTurnId).toBe('om_B');
            expect(hFenced.antigravityFoldedReconcilePending).toBeUndefined();
            hFenced.cancelAntigravityFoldedReconcilePending();

            // Event-driven prompt_ready_reentry wakeups (>20 bursts) must NOT burn the retry cap or cancel healing.
            rmSync(compactPath, { force: true });
            const hBurst = makeReadyScope();
            hBurst.markPromptReady();
            for (let i = 0; i < 25; i++) {
              hBurst.markPromptReady();
            }
            expect(hBurst.antigravityFoldedReconcilePending).toBeDefined();
            expect(hBurst.antigravityFoldedReconcilePending.attempts).toBe(0);
            writeFileSync(compactPath, doneLines);
            vi.advanceTimersByTime(60);
            expect(hBurst.currentBotmuxTurnId).toBe('om_C');
            hBurst.cancelAntigravityFoldedReconcilePending();

            // Incremental compact flush (om_B DONE first, om_C DONE second) re-arms and clears om_C too.
            rmSync(compactPath, { force: true });
            const bothDoneFull = [
              userInputRecord(1, larkEnvelope('om_A', 'first')),
              userInputRecord(2, larkEnvelope('om_B', 'folded B')),
              plannerDoneRecord(3),
              userInputRecord(4, larkEnvelope('om_C', 'folded C')),
              plannerDoneRecord(5),
            ].join('\n') + '\n';
            writeFileSync(fullPath, bothDoneFull);
            let partialScreen = idleFooter;
            const hPartial = makeReadyScope(() => partialScreen);
            hPartial.markPromptReady();
            // Step 1: compact only flushed through om_B DONE. Footer work holds B
            // without consuming C's later sibling reconciliation.
            partialScreen = pendingFooter;
            hPartial.ptyOutputGeneration.observe();
            writeFileSync(compactPath, doneLines);
            vi.advanceTimersByTime(60);
            expect(hPartial.currentBotmuxTurnId).toBe('om_B');
            expect(hPartial.antigravityFoldedBackgroundHold?.turnId).toBe('om_B');
            partialScreen = idleFooter;
            hPartial.ptyOutputGeneration.observe();
            hPartial.observeAntigravityFooterBackgroundTasks(partialScreen);
            vi.advanceTimersByTime(0);
            expect(hPartial.currentBotmuxTurnId).toBe('om_C');
            expect(hPartial.antigravityFoldedReconcilePending).toBeDefined();
            // Step 2: compact flushes om_C DONE -> releases authority completely!
            writeFileSync(compactPath, bothDoneFull);
            vi.advanceTimersByTime(60);
            expect(hPartial.activeTurnAuthority.snapshot()).toBeUndefined();
            expect(hPartial.antigravityFoldedReconcilePending).toBeUndefined();
            hPartial.cancelAntigravityFoldedReconcilePending();
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
