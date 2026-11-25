import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  countAntigravityUserInputMatches,
  findCompletedAntigravityTurnIds,
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
  createSibling?: boolean;
}) {
  const compactPath = join(opts.transcriptPath, '..', 'transcript.jsonl');
  if (opts.createSibling !== false && basename(opts.transcriptPath) === 'transcript_full.jsonl') {
    writeFileSync(compactPath, readFileSync(opts.transcriptPath));
  }
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

describe('findCompletedAntigravityTurnIds', () => {
  it('proves folded message_location and schedule inputs completed before PLANNER_RESPONSE DONE', () => {
    withTempWorkspace(dir => {
      const transcript = join(dir, 'transcript_full.jsonl');
      const scheduleText = '<session_id>sid-agy</session_id>\n\n[定时任务] 巡检 PR 状态';
      writeFileSync(transcript, [
        userInputRecord(1, larkEnvelope('om_A', 'first')),
        userInputRecord(2, scheduleText),
        userInputRecord(3, larkEnvelope('om_B', 'follow up')),
        plannerToolCallRecord(4),
        JSON.stringify({ step_index: 5, type: 'GENERIC', status: 'DONE', content: 'ok' }),
        plannerDoneRecord(6),
      ].join('\n') + '\n');

      const completed = findCompletedAntigravityTurnIds(transcript, [
        { turnId: 'om_B' },
        { turnId: 'schedule:check:1', submittedText: scheduleText },
        { turnId: 'om_unconsumed' },
      ]);
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
      expect([...findCompletedAntigravityTurnIds(busyTranscript, [{ turnId: 'om_A' }, { turnId: 'om_B' }])]).toEqual([]);

      const emptyPlannerTranscript = join(dir, 'empty-planner.jsonl');
      writeFileSync(emptyPlannerTranscript, [
        userInputRecord(1, larkEnvelope('om_B', 'in retry')),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '' }),
      ].join('\n') + '\n');
      expect([...findCompletedAntigravityTurnIds(emptyPlannerTranscript, [{ turnId: 'om_B' }])]).toEqual([]);

      // Waiting narration after launching a non-daemon background task is NOT turn completion.
      const bgTaskTranscript = join(dir, 'bg-task.jsonl');
      writeFileSync(bgTaskTranscript, [
        userInputRecord(1, larkEnvelope('om_B', 'run bg task')),
        plannerToolCallRecord(2),
        JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'RUNNING', content: 'Command running as a background task (task-1)' }),
        plannerDoneRecord(4, 'Waiting for background task to finish.'),
      ].join('\n') + '\n');
      expect([...findCompletedAntigravityTurnIds(bgTaskTranscript, [{ turnId: 'om_B' }])]).toEqual([]);
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
      expect([...findCompletedAntigravityTurnIds(transcript, [{ turnId: 'om_victim' }])]).toEqual([]);
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
        ...findCompletedAntigravityTurnIds(transcript, [
          { turnId: 'schedule:check:2', submittedText: staticPrompt, minByteOffset: offsetBeforeSecondSubmit },
        ]),
      ]).toEqual([]);

      // Once the second fire lands at >= minByteOffset and finishes, it IS proven completed.
      writeFileSync(transcript, firstRun + [
        userInputRecord(3, staticPrompt),
        plannerDoneRecord(4),
      ].join('\n') + '\n');
      expect([
        ...findCompletedAntigravityTurnIds(transcript, [
          { turnId: 'schedule:check:2', submittedText: staticPrompt, minByteOffset: offsetBeforeSecondSubmit },
        ]),
      ]).toEqual(['schedule:check:2']);
    });
  });

  it('prevents a delayed flush of an earlier identical-text turn from impersonating a newer candidate (P1-A)', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const transcript = join(dir, 'transcript_full.jsonl');
      writeFileSync(transcript, '');
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
      writeFileSync(transcript, firstRun);

      expect([
        ...findCompletedAntigravityTurnIds(transcript, [{
          turnId: 'schedule:new',
          submittedText: staticPrompt,
          sampledTranscriptPath: newHint.sampledTranscriptPath,
          minByteOffset: newHint.minByteOffset,
          skipPriorMatches: newHint.skipPriorMatches,
        }]),
      ]).toEqual([]);

      // Also verify 1-to-1 occurrence ownership: a single USER_INPUT cannot satisfy two identical candidates.
      expect([
        ...findCompletedAntigravityTurnIds(transcript, [
          { turnId: 'schedule:old', submittedText: staticPrompt, minByteOffset: 0 },
          { turnId: 'schedule:new', submittedText: staticPrompt, minByteOffset: 0 },
        ]),
      ]).toEqual(['schedule:old']);

      // Once schedule:new's own independent occurrence lands and finishes, it IS completed.
      writeFileSync(transcript, firstRun + [
        userInputRecord(3, staticPrompt),
        plannerDoneRecord(4),
      ].join('\n') + '\n');
      expect([
        ...findCompletedAntigravityTurnIds(transcript, [{
          turnId: 'schedule:new',
          submittedText: staticPrompt,
          sampledTranscriptPath: newHint.sampledTranscriptPath,
          minByteOffset: newHint.minByteOffset,
          skipPriorMatches: newHint.skipPriorMatches,
        }]),
      ]).toEqual(['schedule:new']);
    });
  });

  it('maps compact minByteOffset to full coordinates when transcript switches from compact to full (P1-B)', () => {
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
        ...findCompletedAntigravityTurnIds(fullPath, [{
          turnId: 'schedule:sibling',
          submittedText: staticPrompt,
          sampledTranscriptPath: compactPath,
          minByteOffset: compactOffset,
        }]),
      ]).toEqual([]);

      // After a genuinely new occurrence lands in full, it IS proven completed.
      writeFileSync(fullPath, fullPrior + [
        userInputRecord(3, staticPrompt),
        plannerDoneRecord(4, 'new run done'),
      ].join('\n') + '\n');
      expect([
        ...findCompletedAntigravityTurnIds(fullPath, [{
          turnId: 'schedule:sibling',
          submittedText: staticPrompt,
          sampledTranscriptPath: compactPath,
          minByteOffset: compactOffset,
        }]),
      ]).toEqual(['schedule:sibling']);
    });
  });
});

describe('Antigravity prompt_ready folded-turn reconciliation', () => {
  it('clears authority after late disk marker for already-completed B so queued schedules run (XPI off & on)', () => {
    for (const xpiOn of [false, true]) {
      withTempWorkspace(dir => {
        const marker = join(dir, 'marker.json');
        const transcript = join(dir, 'transcript_full.jsonl');
        writeFileSync(transcript, [
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
      const transcript = join(dir, 'transcript_full.jsonl');
      writeFileSync(transcript, [
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

  it.each(['full-progress', 'compact-progress', 'missing', 'partial'] as const)('keeps B authority and C queued unless both transcript siblings prove completion (%s)', variant => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const fullPath = join(dir, 'transcript_full.jsonl');
      const compactPath = join(dir, 'transcript.jsonl');
      const user = userInputRecord(1, larkEnvelope('om_B', 'folded B'));
      const completed = `${user}\n${plannerDoneRecord(2)}\n`;
      const progress = `${user}\n${plannerToolCallRecord(2)}\n`;
      if (variant === 'full-progress') {
        writeFileSync(fullPath, completed);
        writeFileSync(compactPath, progress);
      } else if (variant === 'compact-progress') {
        writeFileSync(fullPath, progress);
        writeFileSync(compactPath, completed);
      } else if (variant === 'partial') {
        writeFileSync(fullPath, completed);
        writeFileSync(compactPath, user);
      } else {
        writeFileSync(fullPath, completed);
      }

      const h = workerHarness({
        markerPath: marker, transcriptPath: fullPath, cliSessionId: 'conv-paired', createSibling: false,
      });
      h.setCaptureIdentity('om_B');
      h.markActiveTurnStarted({ turnId: 'om_B' });
      h.queuedTypeAheadTurns.push({ turnId: 'om_C' });
      h.rememberQueuedTurnAdvanceForPendingReady('om_A');
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid-agy', turnId: 'om_B', queuedTurns: [{ turnId: 'om_C' }] }));

      runPromptReadySettlement(h);

      expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_B');
      expect(h.currentBotmuxTurnId).toBe('om_B');
      expect(h.queuedTypeAheadTurns.map((t: any) => t.turnId)).toEqual(['om_C']);
      expect(h.retiredTurnIds.has('om_B')).toBe(false);
    });
  });

  it('advances past completed B to still-unconsumed C', () => {
    withTempWorkspace(dir => {
      const marker = join(dir, 'marker.json');
      const transcript = join(dir, 'transcript_full.jsonl');
      writeFileSync(transcript, [
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
      const transcript = join(dir, 'transcript_full.jsonl');
      writeFileSync(transcript, [
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
      const transcript = join(dir, 'transcript_full.jsonl');
      const staticSchedulePrompt = '[定时任务] 每 15 分钟检查上游 PR';
      const initialTranscript = [
        userInputRecord(1, larkEnvelope('om_host', 'initial human turn')),
      ].join('\n') + '\n';
      writeFileSync(transcript, initialTranscript);

      // Worker 1 submits a static scheduled turn via type-ahead and persists its reconcileHint in PID marker.
      const h1 = workerHarness({ markerPath: marker, transcriptPath: transcript, cliSessionId: 'conv-reattach-sched' });
      h1.setCaptureIdentity('om_host');
      h1.markActiveTurnStarted({ turnId: 'om_host' });
      const hint = h1.rememberSubmittedTurnText('schedule:poll:reattach', staticSchedulePrompt, undefined, { isTypeAhead: true });
      h1.queuedTypeAheadTurns.push({ turnId: 'schedule:poll:reattach', antigravityReconcileHint: hint });
      h1.writeCliPidMarker();

      // Both turns fold and finish in transcript while worker restarts/reattaches.
      writeFileSync(transcript, initialTranscript + [
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
      writeFileSync(fullPath, `${userInputRecord(1, larkEnvelope('om_X', 'hi'))}\n${plannerDoneRecord(2)}\n`);
      const resolved = resolveAntigravityTranscriptPath('conv-real', { brainDir: dir });
      expect(resolved).toBe(fullPath);
      expect([...findCompletedAntigravityTurnIds(resolved!, [{ turnId: 'om_X' }])]).toEqual(['om_X']);
    });
  });
});
