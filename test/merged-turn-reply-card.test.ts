import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import { getBot, registerBot } from '../src/bot-registry.js';
import { updateMessage, MessageWithdrawnError } from '../src/im/lark/client.js';
import {
  absorbedHostForTurn,
  absorbedMembersOfHost,
  canonicalMergedHostTurnId,
  clearTurnAbsorption,
  recordTurnAbsorbedMembers,
  recordTurnAbsorption,
  resolveAbsorbedTurnCoverage,
  sameChatReplyDestination,
  sameMergedTurnGroup,
  samePrivateReplySender,
  shouldFoldAbsorbedTurnReplyCard,
} from '../src/core/turn-absorption.js';
import {
  cardTerminalForHistoricalReply,
  cardTerminalForRequiredReply,
  readHistoricalSink,
  replyCardDispatchAttempt,
  replyCardKey,
  replyCardModeFor,
  retireReplyCardDisplay,
  settleTurnReplyCardTerminal,
  updateTurnReplyCard,
  __testOnlyDrainTurnReplyTools,
} from '../src/core/turn-reply-card.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import { normaliseForFingerprint } from '../src/services/claude-transcript.js';
import {
  attributableSupersededFinalMarkers,
  bridgeGateInputForTurn,
  bridgePostText,
  isBridgeNothingToSendFinal,
  isFinalBridgeSendMarker,
  shouldSuppressBridgeEmit,
  type BridgeSendMarker,
} from '../src/services/bridge-fallback-gate.js';
import {
  nextStepIdle,
  noteNextStepCard,
  noteNextStepSuggestion,
  noteNextStepTurnStarted,
  type NextStepIo,
} from '../src/core/next-step-suggestion.js';
import {
  noteCliRecap,
  noteRecapCard,
  noteRecapTurnStarted,
  recapIdle,
  type RecapIo,
} from '../src/core/turn-recap-state.js';
import { noteFinalReplyText, noteLateFinalReply, noteTurnStarted, recordTurnOutcome } from '../src/core/turn-outcome.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { drainTranscript, joinAssistantText, trailingAssistantText } from '../src/services/claude-transcript.js';

vi.mock('../src/config.js', () => ({
  config: {
    session: { dataDir: '' },
    web: { externalHost: 'localhost' },
    dashboard: { externalHost: 'localhost', port: 7891 },
  },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(),
  registerBot: vi.fn(),
  normalizeUsageDisplay: () => 'off',
}));
vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionUsageSnapshot: vi.fn(() => ({ context: null, tokens: null })),
}));
vi.mock('../src/im/lark/card-handler.js', () => ({
  resolveCardOperatorUnionId: vi.fn(),
}));
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  uploadFile: vi.fn(),
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));
vi.mock('../src/services/session-store.js', () => ({
  getSession: vi.fn((sessionId: string) => ({ sessionId, status: 'active' } as any)),
  updateSession: vi.fn(),
}));

const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 60));
};

// The terminal handler notes the next-step/recap card inside an async
// `.then(settleCard)` chain. A fixed `settle()` timer does not guarantee that
// chain has run on a loaded runner, so these poll the persisted card instead of
// racing the timer. They still drain the module's own promise chain each round.
async function waitForNextStepText(
  ds: DaemonSession,
  store: TurnReplyCardStore,
  turnId: string,
  expected: string,
  timeoutMs = 2_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let text: string | undefined;
  while (Date.now() < deadline) {
    await nextStepIdle(ds);
    text = store.read(replyCardKey(ds, turnId))?.nextStep?.text;
    if (text === expected) return text;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return text;
}

async function waitForRecapMarkdown(
  ds: DaemonSession,
  store: TurnReplyCardStore,
  turnId: string,
  expectedPart: string,
  timeoutMs = 2_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let markdown: string | undefined;
  while (Date.now() < deadline) {
    await recapIdle(ds);
    markdown = store.read(replyCardKey(ds, turnId))?.recap?.markdown;
    if (markdown?.includes(expectedPart)) return markdown;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return markdown;
}

function makeSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    larkAppId: 'app_3908',
    chatId: 'oc_3908',
    chatType: 'p2p',
    scope: 'thread',
    currentTurnId: 'om_m1',
    workerGeneration: 1,
    session: {
      sessionId: 'sid_3908',
      chatId: 'oc_3908',
      rootMessageId: 'om_m1',
      scope: 'thread',
      status: 'active',
      cliId: 'claude-code',
      backendType: 'tmux',
      workerGeneration: 1,
    },
    ...overrides,
  } as unknown as DaemonSession;
}

describe('merged/absorbed turn membership and deterministic coverage rules', () => {
  it('tracks transitive absorption under one canonical host and isolates independent turns', () => {
    const ds = makeSession();
    expect(recordTurnAbsorption(ds, 'om_m1', 'om_m1')).toBe(false);
    expect(recordTurnAbsorption(ds, 'om_m2', 'om_m1')).toBe(true);
    expect(recordTurnAbsorption(ds, 'om_m3', 'om_m2')).toBe(true);
    // Reject cycle back to an ancestor.
    expect(recordTurnAbsorption(ds, 'om_m1', 'om_m3')).toBe(false);

    expect(absorbedHostForTurn(ds, 'om_m2')).toEqual({ hostTurnId: 'om_m1' });
    expect(absorbedHostForTurn(ds, 'om_m3')).toEqual({ hostTurnId: 'om_m1' });
    expect(canonicalMergedHostTurnId(ds, 'om_m3')).toBe('om_m1');
    expect(sameMergedTurnGroup(ds, 'om_m1', 'om_m3')).toBe(true);
    expect(sameMergedTurnGroup(ds, 'om_m2', 'om_m3')).toBe(true);

    // Independent turn M4 is strictly isolated.
    expect(sameMergedTurnGroup(ds, 'om_m1', 'om_m4')).toBe(false);
    expect(sameMergedTurnGroup(ds, 'om_m3', 'om_m4')).toBe(false);

    clearTurnAbsorption(ds, 'om_m2');
    expect(sameMergedTurnGroup(ds, 'om_m1', 'om_m2')).toBe(false);
    expect(sameMergedTurnGroup(ds, 'om_m1', 'om_m3')).toBe(true);
  });

  it('classifies absorbed turn coverage deterministically while failing closed on TOCTOU and #3880 refusals', () => {
    // 1. Settled by host explicit final (#3880).
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2',
      turnMarkTimeMs: 1_000,
      hostTurnId: 'om_m1',
      hasOwnFinal: false,
      hostHasExplicitFinal: true,
      settledByHostFinal: true,
      ledgerKind: 'ledger',
      hostFinalSentAtMs: 5_000,
    })).toBe('settled');

    // 2. Host without explicit final (transcript / silence / failure).
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2',
      turnMarkTimeMs: 1_000,
      hostTurnId: 'om_m1',
      hasOwnFinal: false,
      hostHasExplicitFinal: false,
      settledByHostFinal: false,
    })).toBe('host_execution');

    // 3. Poll-lag / truncation-bind before send (marker lacked absorbedIntoTurnId at send time).
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2',
      turnMarkTimeMs: 1_000,
      hostTurnId: 'om_m1',
      hasOwnFinal: false,
      hostHasExplicitFinal: true,
      settledByHostFinal: false,
      ledgerKind: 'ledger',
      hostFinalSentAtMs: 5_000,
      hostFinalDeliveryKind: 'current_session_send',
      absorbedMarkerWrittenAtMs: 5_200,
    })).toBe('pre_send_unmarked');

    // 4. Fail closed when #3880 gate ALREADY saw the marker before send and refused settlement.
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2',
      turnMarkTimeMs: 1_000,
      hostTurnId: 'om_m1',
      hasOwnFinal: false,
      hostHasExplicitFinal: true,
      settledByHostFinal: false,
      ledgerKind: 'ledger',
      hostFinalSentAtMs: 5_000,
      hostFinalDeliveryKind: 'current_session_send',
      absorbedMarkerWrittenAtMs: 2_000,
    })).toBeUndefined();

    // 5. Fail closed on TOCTOU (absorbed AFTER host sent final).
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2',
      turnMarkTimeMs: 6_000,
      hostTurnId: 'om_m1',
      hasOwnFinal: false,
      hostHasExplicitFinal: true,
      settledByHostFinal: false,
      ledgerKind: 'ledger',
      hostFinalSentAtMs: 5_000,
      hostFinalDeliveryKind: 'current_session_send',
    })).toBeUndefined();

    // 6. Never fold an absorbed turn that produced its own final.
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2',
      turnMarkTimeMs: 1_000,
      hostTurnId: 'om_m1',
      hasOwnFinal: true,
      hostHasExplicitFinal: true,
      settledByHostFinal: true,
      ledgerKind: 'ledger',
      hostFinalSentAtMs: 5_000,
    })).toBeUndefined();

    // 7. Fail closed on unreadable ledger, detoured send, ineligible send flags, local/non-Lark host, durable attempt, or XPI mismatch (even without explicit final).
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2', turnMarkTimeMs: 1_000, hostTurnId: 'om_m1',
      hasOwnFinal: false, hostHasExplicitFinal: true, settledByHostFinal: false,
      ledgerKind: 'unknown', hostFinalSentAtMs: 5_000,
    })).toBeUndefined();
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2', turnMarkTimeMs: 1_000, hostTurnId: 'om_m1',
      hasOwnFinal: false, hostHasExplicitFinal: true, settledByHostFinal: false,
      ledgerKind: 'ledger', hostFinalSentAtMs: 5_000, hostFinalDeliveryKind: 'detoured_send',
    })).toBeUndefined();
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2', turnMarkTimeMs: 1_000, hostTurnId: 'om_m1',
      hasOwnFinal: false, hostHasExplicitFinal: true, settledByHostFinal: false,
      ledgerKind: 'ledger', hostFinalSentAtMs: 5_000, hostFinalSettlementIneligible: true,
    })).toBeUndefined();
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2', turnMarkTimeMs: 1_000, hostTurnId: 'local-abc', hostIsLocal: true,
      hasOwnFinal: false, hostHasExplicitFinal: false, settledByHostFinal: false,
    })).toBeUndefined();
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2', turnMarkTimeMs: 1_000, hostTurnId: 'om_m1', turnDispatchAttempt: 1,
      hasOwnFinal: false, hostHasExplicitFinal: false, settledByHostFinal: false,
    })).toBeUndefined();
    expect(resolveAbsorbedTurnCoverage({
      turnId: 'om_m2', turnMarkTimeMs: 1_000, hostTurnId: 'om_m1',
      hasOwnFinal: false, hostHasExplicitFinal: false, settledByHostFinal: false, crossPrincipalMismatch: true,
    })).toBeUndefined();
  });

  it('enforces destination, privateReply, cross-chat, and #3911 requiresReply guards in shouldFoldAbsorbedTurnReplyCard', () => {
    const base = {
      turnId: 'om_m2',
      absorbedIntoTurnId: 'om_m1',
      absorbedCoverage: 'settled' as const,
      scope: 'thread' as const,
      privateReply: false,
      samePrivateReplyRecipient: true,
      memberHasCrossChatOrigin: false,
      hasOwnFinal: false,
      requiresReplyUnanswered: false,
      sameDestination: true,
    };
    expect(shouldFoldAbsorbedTurnReplyCard(base)).toBe(true);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, hasOwnFinal: true })).toBe(false);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, requiresReplyUnanswered: true })).toBe(false);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, sameDestination: false })).toBe(false);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, privateReply: true, samePrivateReplyRecipient: false })).toBe(false);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, memberHasCrossChatOrigin: true })).toBe(false);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, absorbedCoverage: 'pre_send_unmarked', scope: 'chat' })).toBe(false);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, absorbedCoverage: 'pre_send_unmarked', privateReply: true, samePrivateReplyRecipient: false })).toBe(false);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, absorbedCoverage: 'host_execution', sameDestination: false })).toBe(false);
    expect(shouldFoldAbsorbedTurnReplyCard({ ...base, absorbedCoverage: 'host_execution', memberHasCrossChatOrigin: true })).toBe(false);

    // Chat-scope destination and private-reply sender checks fail closed on mismatch or missing metadata.
    const chatDs = makeSession({
      scope: 'chat',
      session: {
        sessionId: 'sid_chat',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        scope: 'chat',
        status: 'active',
        turnReplyContexts: {
          om_m1: { target: { mode: 'thread', rootMessageId: 'om_topic_1' }, replyTargetSenderOpenId: 'ou_alice' },
          om_m2: { target: { mode: 'thread', rootMessageId: 'om_topic_1' }, replyTargetSenderOpenId: 'ou_alice' },
          om_m3: { target: { mode: 'thread', rootMessageId: 'om_topic_2' }, replyTargetSenderOpenId: 'ou_bob' },
        },
      } as any,
    });
    expect(sameChatReplyDestination(chatDs, 'om_m1', 'om_m2')).toBe(true);
    expect(sameChatReplyDestination(chatDs, 'om_m1', 'om_m3')).toBe(false);
    expect(samePrivateReplySender(chatDs, 'om_m1', 'om_m2')).toBe(true);
    expect(samePrivateReplySender(chatDs, 'om_m1', 'om_m3')).toBe(false);
  });
});

describe('worker emitReadyTurns & acknowledgeNativeInputConsumed absorption protocol', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-3908-worker-'));
    vi.stubEnv('SESSION_DATA_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeJsonl(path: string, events: Record<string, unknown>[]): void {
    writeFileSync(path, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  function runEmitReadyTurns(opts: {
    jsonlEvents: Record<string, unknown>[];
    marks: Array<{ turnId: string; text: string; atMs: number }>;
    sendMarkers?: BridgeSendMarker[];
    absorbedMarkerWrittenAtMs?: Record<string, number>;
    settledAbsorbedTurnsByKey?: Map<string, { turnId: string; hostTurnId: string; dispatchAttempt?: number; hostDispatchAttempt?: number }>;
    xpiOn?: boolean;
    activeAuthority?: ActiveTurnAuthority;
    queuedTypeAheadTurns?: Array<{ turnId: string; dispatchAttempt?: number; trustedCaller?: any }>;
    replyDelivery?: 'send' | 'transcript';
  }) {
    const jsonlPath = join(dir, 'claude-session.jsonl');
    writeJsonl(jsonlPath, opts.jsonlEvents);
    const queue = new BridgeTurnQueue();
    for (const m of opts.marks) {
      queue.mark(m.turnId, makeFingerprint(m.text), m.atMs, normaliseForFingerprint(m.text));
    }
    const drained = drainTranscript(jsonlPath, 0);
    queue.ingest(drained.events, jsonlPath);

    const emittedTerminals: Array<Record<string, unknown>> = [];
    const ipcSent: Array<Record<string, unknown>> = [];
    const writtenAtMap = new Map<string, number>(
      Object.entries(opts.absorbedMarkerWrittenAtMs ?? {}).map(([turnId, atMs]) => [`${turnId}\0`, atMs]),
    );
    const scope: Record<string, unknown> = {
      sessionId: 'sid_3908',
      lastInitConfig: { larkAppId: 'app_3908', chatId: 'oc_3908', rootMessageId: 'om_m1', adoptMode: false },
      bridgeQueue: queue,
      bridgeJsonlPath: jsonlPath,
      readSendMarkers: () => opts.sendMarkers ?? [],
      replyDeliveryMode: () => opts.replyDelivery ?? 'send',
      zeroPromptTerminalSync: () => false,
      foldBackgroundUpdatesEnabled: () => false,
      foldReplyEnabled: () => false,
      isSuppressedNonTerminalMonitorWake: () => false,
      isClaudeMemoryToolUse: () => false,
      hasTrailingBridgeSentinelLine: () => false,
      rememberTurnLinkRefMode: () => {},
      clearSubmittedClaudeTurnIf: () => {},
      journalBridgeTurnClear: () => {},
      universalOutputHandoff: false,
      finalHandoffAdmissionEnabled: false,
      workerFinalOutputHandoff: undefined,
      handoffTurnIds: new Set<string>(),
      bridgeFingerprintScanLastMs: new Map<string, number>(),
      noteHostFinalCarried: () => {},
      drainTranscript,
      joinAssistantText,
      trailingAssistantText,
      bridgeGateInputForTurn,
      bridgePostText,
      isBridgeNothingToSendFinal,
      isFinalBridgeSendMarker,
      shouldSuppressBridgeEmit,
      attributableExplicitReplyMarkersForTurnWindow: (
        turnId: string,
        turn: { markTimeMs: number | undefined; isLocal: boolean | undefined },
        nextBoundaryMs: number | undefined,
        markers: readonly BridgeSendMarker[],
        adoptMode: boolean,
      ) => {
        if (adoptMode || turn.isLocal || turn.markTimeMs === undefined) return [];
        const upper = nextBoundaryMs ?? Number.POSITIVE_INFINITY;
        return markers.filter(m => m.sentAtMs >= turn.markTimeMs! && m.sentAtMs < upper && m.turnId === turnId);
      },
      notifyExplicitRepliesObserved: (turnId: string, markers: readonly BridgeSendMarker[]) => {
        for (const m of markers) ipcSent.push({ type: 'explicit_reply_observed', turnId, messageId: m.messageId, responseKind: m.responseKind });
      },
      send: (msg: Record<string, unknown>) => { ipcSent.push(msg); },
      log: () => {},
      usageLimitTracker: { noteTurnCompleted: () => {} },
      activeTurnAuthority: opts.activeAuthority ?? new ActiveTurnAuthority(),
      crossPrincipalIsolationOn: () => opts.xpiOn === true,
      queuedTypeAheadTurns: opts.queuedTypeAheadTurns ?? [],
      settledAbsorbedTurnsByKey: opts.settledAbsorbedTurnsByKey ?? new Map(),
      settledAbsorbedKey: (turnId: string, attempt?: number) => `${turnId}\0${attempt ?? ''}`,
      absorbedMarkerWrittenAtMsByKey: writtenAtMap,
      emitTurnTerminal: (
        turnId: string,
        status: string,
        errorCode?: string,
        dispatchAttempt?: number,
        outputDisposition?: string,
        retryable?: boolean,
        _completedAtMs?: number,
        _errorDetail?: string,
        _continuationFailure?: unknown,
        _providerTiming?: unknown,
        _composerRefusal?: unknown,
        mergedTurnMeta?: Record<string, unknown>,
      ) => {
        emittedTerminals.push({
          turnId,
          status,
          ...(errorCode ? { errorCode } : {}),
          ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
          ...(outputDisposition ? { outputDisposition } : {}),
          ...(retryable !== undefined ? { retryable } : {}),
          ...(mergedTurnMeta ?? {}),
        });
      },
    };
    const emitReadyTurns = loadWorkerFunction('emitReadyTurns', scope);
    emitReadyTurns({ explicitTerminalOnly: true });
    return { emittedTerminals, ipcSent };
  }

  it('propagates absorbedTurnIds on host M1 and absorbedCoverage=settled on absorbed M2/M3 when botmux send settles them', async () => {
    const t0 = Date.UTC(2026, 10, 28, 5, 0, 52);
    const t1 = Date.UTC(2026, 10, 28, 5, 1, 9);
    const t2 = Date.UTC(2026, 10, 28, 5, 1, 22);
    const tSend = Date.UTC(2026, 10, 28, 5, 8, 48);
    const tEnd = Date.UTC(2026, 10, 28, 5, 8, 49);

    const ledger = new TurnSendLedger(dir);
    await ledger.execute(
      { larkAppId: 'app_3908', sessionId: 'sid_3908', turnId: 'om_m1' },
      'final',
      'fp-final',
      async () => 'om_final_msg',
      {
        sentAtMs: tSend,
        marker: () => ({
          deliveryKind: 'current_session_send',
          content: 'Merged final answer',
          responseKind: 'final',
          targetChatId: 'oc_3908',
          targetRootMessageId: 'om_m1',
          targetSessionId: 'sid_3908',
        }),
        resolveSettledAbsorbedTurnIds: () => ['om_m2', 'om_m3'],
      },
    );

    const { emittedTerminals } = runEmitReadyTurns({
      marks: [
        { turnId: 'om_m1', text: 'first request part one', atMs: t0 },
        { turnId: 'om_m2', text: 'second follow up detail', atMs: t1 },
        { turnId: 'om_m3', text: 'third extra constraint', atMs: t2 },
      ],
      jsonlEvents: [
        { uuid: 'u1', type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'first request part one' } },
        { uuid: 'a1', type: 'assistant', timestamp: new Date(t0 + 2_000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] } },
        { uuid: 'q2', type: 'attachment', renderedRole: 'system', timestamp: new Date(t1).toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'second follow up detail' } },
        { uuid: 'q3', type: 'attachment', renderedRole: 'system', timestamp: new Date(t2).toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'third extra constraint' } },
        { uuid: 'a2', type: 'assistant', timestamp: new Date(tSend + 500).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '已发送最终答复。' }] } },
        { uuid: 'd1', type: 'system', subtype: 'turn_duration', timestamp: new Date(tEnd).toISOString(), durationMs: 358_200 },
      ],
      sendMarkers: [{
        sentAtMs: tSend,
        messageId: 'om_final_msg',
        turnId: 'om_m1',
        responseKind: 'final',
        deliveryKind: 'current_session_send',
        contentLength: 19,
        previewText: 'Merged final answer',
        terminalCarrier: 'standard_reply_card',
      }],
      absorbedMarkerWrittenAtMs: { om_m2: t1 + 100, om_m3: t2 + 100 },
    });

    expect(emittedTerminals).toEqual([
      expect.objectContaining({ turnId: 'om_m1', status: 'completed', absorbedTurnIds: ['om_m2', 'om_m3'] }),
      expect.objectContaining({ turnId: 'om_m2', status: 'completed', absorbedIntoTurnId: 'om_m1', absorbedCoverage: 'settled' }),
      expect.objectContaining({ turnId: 'om_m3', status: 'completed', absorbedIntoTurnId: 'om_m1', absorbedCoverage: 'settled' }),
    ]);
  });

  it('refuses to mark absorbedCoverage on TOCTOU (follow-up absorbed after host sent final)', async () => {
    const t0 = Date.UTC(2026, 10, 28, 5, 0, 0);
    const tSend = Date.UTC(2026, 10, 28, 5, 1, 0);
    const tLate = Date.UTC(2026, 10, 28, 5, 1, 5);
    const tEnd = Date.UTC(2026, 10, 28, 5, 1, 10);

    const ledger = new TurnSendLedger(dir);
    await ledger.execute(
      { larkAppId: 'app_3908', sessionId: 'sid_3908', turnId: 'om_m1' },
      'final',
      'fp-toctou',
      async () => 'om_final_msg',
      {
        sentAtMs: tSend,
        marker: () => ({
          deliveryKind: 'current_session_send',
          content: 'Early final before M2',
          responseKind: 'final',
          targetChatId: 'oc_3908',
          targetRootMessageId: 'om_m1',
          targetSessionId: 'sid_3908',
        }),
      },
    );

    const { emittedTerminals } = runEmitReadyTurns({
      marks: [
        { turnId: 'om_m1', text: 'initial request prompt', atMs: t0 },
        { turnId: 'om_m2', text: 'late followup after final', atMs: tLate },
      ],
      jsonlEvents: [
        { uuid: 'u1', type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'initial request prompt' } },
        { uuid: 'q2', type: 'attachment', renderedRole: 'system', timestamp: new Date(tLate).toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'late followup after final' } },
        { uuid: 'a2', type: 'assistant', timestamp: new Date(tLate + 1_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
        { uuid: 'd1', type: 'system', subtype: 'turn_duration', timestamp: new Date(tEnd).toISOString(), durationMs: 70_000 },
      ],
      sendMarkers: [{
        sentAtMs: tSend,
        messageId: 'om_final_msg',
        turnId: 'om_m1',
        responseKind: 'final',
        deliveryKind: 'current_session_send',
      }],
    });

    const m1 = emittedTerminals.find(t => t.turnId === 'om_m1')!;
    const m2 = emittedTerminals.find(t => t.turnId === 'om_m2')!;
    expect(m1.absorbedTurnIds).toBeUndefined();
    expect(m2.absorbedIntoTurnId).toBe('om_m1');
    expect(m2.absorbedCoverage).toBeUndefined();
  });

  it('includes absorbedIntoTurnId on native_input_consumed IPC when worker observes mid-turn absorption', () => {
    const sent: Array<Record<string, unknown>> = [];
    const scope: Record<string, unknown> = {
      sessionId: 'sid_3908',
      cliSpawnGeneration: 1,
      acknowledgedAntigravityConsumption: new Set<string>(),
      startupNativeInputSeen: false,
      lastWrittenCliInput: undefined,
      markReplyInputConsumed: vi.fn(),
      inflightInputs: { onTurnStarted: vi.fn() },
      send: (msg: Record<string, unknown>) => { sent.push(msg); },
      log: () => {},
    };
    const acknowledgeNativeInputConsumed = loadWorkerFunction('acknowledgeNativeInputConsumed', scope);
    acknowledgeNativeInputConsumed('om_m2', 'claude_transcript_user_record', 'native-sid', undefined, undefined, { hostTurnId: 'om_m1' });
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'native_input_consumed',
        turnId: 'om_m2',
        proofKind: 'claude_transcript_user_record',
        absorbedIntoTurnId: 'om_m1',
      }),
    ]);
  });

  it('samples absorbedMarkerWrittenAtMs BEFORE writeCliPidMarker executes so concurrent botmux send never outruns the timestamp', () => {
    const order: string[] = [];
    let recordedAt: number | undefined;
    let clock = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const queued = [{ turnId: 'om_m2' }] as any[];
      const scope: Record<string, unknown> = {
        queuedTypeAheadTurns: queued,
        isValidMarkerIdentityTurnId: (id: string) => id.startsWith('om_'),
        writeCliPidMarker: () => {
          order.push('write');
          // Advance wall-clock inside writeCliPidMarker to simulate slow disk I/O
          // where a concurrent `botmux send` runs at clock=10_050.
          clock = 10_100;
        },
        noteAbsorbedMarkerWritten: (_turnId: string, _attempt: number | undefined, atMs: number) => {
          order.push('note');
          recordedAt = atMs;
        },
        scheduleConsumedQueuedTurnAdvance: () => {},
      };
      const markReplyInputConsumed = loadWorkerFunction('markReplyInputConsumed', scope);
      markReplyInputConsumed('om_m2', undefined, { hostTurnId: 'om_m1' });
      expect(order).toEqual(['write', 'note']);
      expect(recordedAt).toBe(10_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('fails closed in worker emitReadyTurns on ledger refusal (even with stale settledAbsorbedTurnsByKey), ineligible send flags, local host, and XPI without proof', async () => {
    const t0 = Date.UTC(2026, 10, 28, 5, 0, 0);
    const t1 = Date.UTC(2026, 10, 28, 5, 0, 20);
    const tSend = Date.UTC(2026, 10, 28, 5, 1, 0);
    const tEnd = Date.UTC(2026, 10, 28, 5, 1, 5);

    // 1. Ledger explicitly omitted om_m2 (gate refused) AND stale in-memory settledAbsorbedTurnsByKey holds om_m2.
    const ledger = new TurnSendLedger(dir);
    await ledger.execute(
      { larkAppId: 'app_3908', sessionId: 'sid_3908', turnId: 'om_m1' },
      'final',
      'fp-refused-e2e',
      async () => 'om_final_msg',
      {
        sentAtMs: tSend,
        absorbedSettlementIneligible: true,
        marker: () => ({
          deliveryKind: 'current_session_send',
          content: 'Host only final',
          responseKind: 'final',
          targetChatId: 'oc_3908',
          targetRootMessageId: 'om_m1',
          targetSessionId: 'sid_3908',
        }),
        resolveSettledAbsorbedTurnIds: () => undefined,
      },
    );
    const staleSettled = new Map([['om_m2\0', { turnId: 'om_m2', hostTurnId: 'om_m1' }]]);
    const refused = runEmitReadyTurns({
      marks: [
        { turnId: 'om_m1', text: 'host request one', atMs: t0 },
        { turnId: 'om_m2', text: 'absorbed followup two', atMs: t1 },
      ],
      jsonlEvents: [
        { uuid: 'u1', type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'host request one' } },
        { uuid: 'q2', type: 'attachment', renderedRole: 'system', timestamp: new Date(t1).toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'absorbed followup two' } },
        { uuid: 'a2', type: 'assistant', timestamp: new Date(tSend + 500).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
        { uuid: 'd1', type: 'system', subtype: 'turn_duration', timestamp: new Date(tEnd).toISOString(), durationMs: 65_000 },
      ],
      sendMarkers: [{
        sentAtMs: tSend,
        messageId: 'om_final_msg',
        turnId: 'om_m1',
        responseKind: 'final',
        deliveryKind: 'current_session_send',
      }],
      settledAbsorbedTurnsByKey: staleSettled,
      // Even without absorbedMarkerWrittenAtMs, absorbedSettlementIneligible=true blocks pre_send_unmarked.
    });
    expect(refused.emittedTerminals.find(t => t.turnId === 'om_m1')?.absorbedTurnIds).toBeUndefined();
    expect(refused.emittedTerminals.find(t => t.turnId === 'om_m2')?.absorbedCoverage).toBeUndefined();

    // 2. XPI enabled without proven compatible callers fails closed even without explicit final (transcript mode).
    const xpiFailClosed = runEmitReadyTurns({
      replyDelivery: 'transcript',
      xpiOn: true,
      marks: [
        { turnId: 'om_m1', text: 'host request xpi', atMs: t0 },
        { turnId: 'om_m2', text: 'followup xpi unverified', atMs: t1 },
      ],
      jsonlEvents: [
        { uuid: 'u1x', type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'host request xpi' } },
        { uuid: 'q2x', type: 'attachment', renderedRole: 'system', timestamp: new Date(t1).toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'followup xpi unverified' } },
        { uuid: 'a2x', type: 'assistant', timestamp: new Date(tEnd - 500).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'transcript reply' }] } },
        { uuid: 'd1x', type: 'system', subtype: 'turn_duration', timestamp: new Date(tEnd).toISOString(), durationMs: 65_000 },
      ],
    });
    expect(xpiFailClosed.emittedTerminals.find(t => t.turnId === 'om_m2')?.absorbedCoverage).toBeUndefined();

    // 3. Local terminal host (`local-*`) must never fold a real Lark turn (`om_m2`).
    const localHost = runEmitReadyTurns({
      replyDelivery: 'transcript',
      marks: [
        { turnId: 'om_m2', text: 'real lark message folded into local', atMs: t1 },
      ],
      jsonlEvents: [
        { uuid: 'u_local', type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'typed locally in terminal' } },
        { uuid: 'q_lark', type: 'attachment', renderedRole: 'system', timestamp: new Date(t1).toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'real lark message folded into local' } },
        { uuid: 'a_local', type: 'assistant', timestamp: new Date(tEnd - 500).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'local answer' }] } },
        { uuid: 'd_local', type: 'system', subtype: 'turn_duration', timestamp: new Date(tEnd).toISOString(), durationMs: 10_000 },
      ],
    });
    const larkTerm = localHost.emittedTerminals.find(t => t.turnId === 'om_m2')!;
    expect(larkTerm.absorbedIntoTurnId).toBe('local-u_local');
    expect(larkTerm.absorbedCoverage).toBeUndefined();
  });
});

describe('daemon unified reply-card, next-step, recap, and outcome coordination for merged turns (#3908)', () => {
  let dir: string;
  let bot: ReturnType<typeof getBot>;

  beforeEach(() => {
    vi.stubEnv('BOTMUX_SANDBOX', undefined);
    dir = mkdtempSync(join(tmpdir(), 'botmux-3908-daemon-'));
    config.session.dataDir = dir;
    bot = {
      config: {
        larkAppId: 'app_3908',
        cliId: 'claude-code',
        replyCardMode: 'unified',
        replyCardNextStep: true,
        replyCardRecap: true,
      },
    } as unknown as ReturnType<typeof getBot>;
    vi.mocked(getBot).mockReturnValue(bot);
    vi.mocked(updateMessage).mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await __testOnlyDrainTurnReplyTools();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeNextStepIo() {
    const infos: string[] = [];
    const io: NextStepIo = {
      enabled: () => true,
      locale: () => 'zh',
      issue: (_ds, prompt) => ({ payload: `p:${prompt}`, sig: 'sig' }),
      readCard: async () => undefined,
      cardId: async () => 'card_id',
      insert: vi.fn(async () => {}),
      replace: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      now: () => Date.now(),
      warn: vi.fn(),
      info: msg => { infos.push(msg); },
    };
    return { io, infos };
  }

  function makeRecapIo() {
    const awayRequests: string[] = [];
    const infos: string[] = [];
    const io: RecapIo = {
      enabled: () => true,
      awaySummaryWanted: () => true,
      requestAwaySummary: (_ds, turnId) => { awayRequests.push(turnId); },
      locale: () => 'zh',
      readCard: async () => undefined,
      cardId: async () => 'card_id',
      insert: vi.fn(async () => {}),
      replace: vi.fn(async () => {}),
      now: () => Date.now(),
      warn: vi.fn(),
      info: msg => { infos.push(msg); },
    };
    return { io, awayRequests, infos };
  }

  function buildDaemonTerminalHarness(ds: DaemonSession, opts: {
    nextStepIo: NextStepIo;
    turnRecapIo: RecapIo;
    journalSink?: (sid: string, turnId: string) => any;
    onScopedReply?: (turnId: string, body: string) => string;
    onFinishReaction?: (turnId: string, delivered: boolean) => void;
  }) {
    const worker = { connected: true, killed: false, send: vi.fn() };
    ds.worker = worker as any;
    const deferredUnified = new Set<string>();
    const postedByTurn: Array<{ turnId: string; body: string }> = [];
    let replySeq = 0;

    const scope: Record<string, unknown> = {
      ds,
      worker,
      workerGeneration: 1,
      t: 'test-3908',
      effectiveCliId: 'claude-code',
      terminalCliId: 'claude-code',
      botCfg: bot.config,
      config,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      getBot,
      sessionCliId: () => 'claude-code',
      isCodexFamilyCliId: () => false,
      codexCapacityRecoveryCli: () => false,
      privateReplyEnabled: () => false,
      absorbedMembersOfHost,
      recordTurnAbsorption,
      clearTurnAbsorption,
      sameChatReplyDestination,
      samePrivateReplySender,
      sameMergedTurnGroup,
      shouldFoldAbsorbedTurnReplyCard,
      TurnSendLedger,
      TurnReplyCardStore,
      replyCardKey,
      replyCardModeFor,
      retireReplyCardDisplay,
      settleTurnReplyCardTerminal,
      updateTurnReplyCard,
      cardTerminalForRequiredReply,
      cardTerminalForHistoricalReply,
      readHistoricalSink,
      isFinalTurnTerminalCarrier: (carrier: any) => !!carrier && (carrier.responseKind === 'final' || carrier.responseKind === undefined),
      ownsLifecycleMutation: () => true,
      managedAuxUiSuppressed: () => false,
      unifiedReplyTurnNotCapturing: (_d: DaemonSession, turnId: string) => turnId !== 'om_m1',
      rememberDeferredUnifiedReply: (_d: DaemonSession, turnId: string) => { deferredUnified.add(turnId); },
      forgetDeferredUnifiedReply: (_d: DaemonSession, turnId: string) => { deferredUnified.delete(turnId); },
      noteNativeAcceptedInputTurn: vi.fn(),
      reconcileFoldedOrSteeredStartingCard: vi.fn(),
      commitTriggerStreamingCard: vi.fn(),
      recordDispatchInputCommit: () => false,
      recordWorkerCommittedTurn: vi.fn(),
      noteAcceptedInputTurn: vi.fn(),
      completeOrdinaryImDelivery: vi.fn(),
      observeTurnResultTerminal: vi.fn(),
      settleAutoCompactSafeComposerRefusal: () => false,
      holdLastTurnThroughExcludedTerminal: vi.fn(),
      virtualDeliverySinkForChatId: () => undefined,
      rememberHttpTerminal: vi.fn(),
      turnFailureDiagnostics: () => ({}),
      silentTurnReceiptUuid: () => 'silent-uuid',
      beginFinalOutputDelivery: () => () => {},
      SILENT_RECEIPT_DEDUPE_MAX: 256,
      shouldNotifyTurnFailure: () => false,
      takeTurnExplicitMention: () => false,
      releaseActiveIdentityTurn: vi.fn(),
      collectSessionTurnGarbage: vi.fn(),
      markMessageListenerRunPreviewFailed: vi.fn(),
      awaitFinalForReplyCardRows: vi.fn(),
      ownsWorkerSession: () => true,
      runPendingSuspendIfSettled: vi.fn(),
      emitSessionLifecycleHook: vi.fn(),
      workersWithLiveWorkingStatus: new WeakMap(),
      postTerminalDirectSubmitSessions: new WeakSet(),
      settleScheduledRunBinding: vi.fn(),
      schedulePostTerminalStatusSettle: vi.fn(),
      currentCaptureIdentity: () => ({ turnId: 'om_m1' }),
      recordCompletedTerminalTurn: vi.fn(),
      turnDispatchAttemptHighWaterTransition: () => 0,
      closePostTerminalLiveWorkEpisode: vi.fn(),
      workerCliId: () => 'claude-code',
      turnTerminalReportingCliIds: new Set<string>(),
      requestLiveSessionCapAfterTurnSettled: vi.fn(),
      getLinkRefRuntime: () => undefined,
      cliNotices: { finish: vi.fn(), reply: vi.fn() },
      forgetScheduledTurnCaller: vi.fn(),
      trimOldest: vi.fn(),
      TERMINAL_RECEIPT_DEDUPE_MAX: 256,
      noteTurnDispatchAttempt: vi.fn(),
      markFailedTurnIdle: vi.fn(),
      unboundInputCommitLogLevel: () => 'debug',
      frozenReplyContextForTurn: () => undefined,
      sessionStore: { updateSession: vi.fn() },
      journal: opts.journalSink ? { sink: opts.journalSink } : undefined,
      settleAcceptedInputTurn: vi.fn(),
      closeStartingCardHealth: vi.fn(),
      settleTurnTerminalHealth: vi.fn(),
      settleIdleTerminal: vi.fn(),
      noteIdleAutoCompactTurnEnded: () => false,
      isAutoCompactTerminalRefusal: () => undefined,
      noteIdleAutoCompactRefusal: () => undefined,
      persistStreamCardState: vi.fn(),
      scheduleActiveRuntimePatch: () => false,
      finalizeOrHoldCotMessage: vi.fn(),
      readonlyTaskContinuationHandlesTerminal: () => false,
      ordinaryTurnRecoveryEligible: () => false,
      disposeIneligibleOrdinaryTurnRecovery: vi.fn(),
      ordinaryTurnRecoveryHandlesTerminal: () => false,
      handleOrdinaryTurnRecoveryTerminal: vi.fn(),
      handleReadonlyTaskContinuationTerminal: vi.fn(),
      publishTurnFinished: vi.fn(),
      isTurnOutcomeExcluded: () => false,
      recordTurnOutcome,
      usesOutcomeBasedTurnReactions: () => true,
      finishTurnReactions: async (_d: DaemonSession, info: { turnId: string; delivered: boolean }) => {
        opts.onFinishReaction?.(info.turnId, info.delivered);
      },
      waitForTurnFinalOutputDeliveryDrain: async () => {},
      noteNextStepCard,
      noteRecapCard,
      nextStepIo: opts.nextStepIo,
      turnRecapIo: opts.turnRecapIo,
      tr: (key: string) => key,
      localeForBot: () => 'zh',
      streamingCardDisabled: () => false,
      effectiveReplyDelivery: () => 'send',
      sessionPromptInjection: () => 'full',
      cb: {},
      callbacks: {},
      terminateProgressDelivery: vi.fn(),
      cancelOrdinaryRecoveryForUserInput: vi.fn(),
      isTerminalTypedTurnId: () => false,
      cancelOrdinaryRecoveryWaitForTerminalTurn: vi.fn(),
      TRAEX_QUOTA_ERROR_CODE: 'traex_quota',
      CODEX_CAPACITY_ERROR_CODE: 'codex_capacity',
      IDLE_AUTO_COMPACT_TURN_PREFIX: 'auto-compact:',
      isSilentMessageListenerSession: () => false,
      markMessageListenerRunPreviewCompleted: vi.fn(),
      markMessageListenerRunPreviewRunning: vi.fn(),
      failCloseSessionAfterAsyncPersistFailure: vi.fn(),
      TURN_ENDED_UNOBSERVED: 'turn_ended_unobserved',
      asyncTriggerStore: { recordCompleted: vi.fn() },
      retireReplyExecutionStarts: vi.fn(),
      noteTurnTerminalObserved: vi.fn(),
      noteFinalTurnTerminalObserved: vi.fn(),
      scopedReply: async (body: string, _type: string, turnId?: string) => {
        const tid = turnId ?? 'unknown';
        postedByTurn.push({ turnId: tid, body });
        return opts.onScopedReply ? opts.onScopedReply(tid, body) : `om_card_${++replySeq}`;
      },
    };
    const handle = loadWorkerPoolMessageHandlers(
      ['turn_input_committed', 'native_input_consumed', 'turn_terminal'],
      scope,
      true,
    );
    return { handle, postedByTurn, deferredUnified };
  }

  it('reproduces #3908 end-to-end: M1 final card settles cleanly, M2/M3 post zero spurious cards, and next-step/recap/DONE converge on M1', async () => {
    const ds = makeSession({ currentTurnId: 'om_m1' });
    const store = new TurnReplyCardStore(dir);
    const ledger = new TurnSendLedger(dir);
    const { io: nextStepIo, infos: nextStepInfos } = makeNextStepIo();
    const { io: turnRecapIo, awayRequests } = makeRecapIo();
    const finishedReactions: Array<{ turnId: string; delivered: boolean }> = [];

    const { handle, postedByTurn } = buildDaemonTerminalHarness(ds, {
      nextStepIo,
      turnRecapIo,
      onFinishReaction: (turnId, delivered) => { finishedReactions.push({ turnId, delivered }); },
    });

    // 1. User sends M1 -> M2 -> M3 within 30s; daemon prepares all three unified records and advances latest turn to M3.
    noteNextStepTurnStarted(ds, 'om_m1', nextStepIo);
    noteRecapTurnStarted(ds, 'om_m1');
    expect(replyCardModeFor(ds, 'om_m1')).toBe('unified');
    await handle({ type: 'turn_input_committed', turnId: 'om_m1' });
    await settle();
    expect(ds.replyCardRunningTurnId).toBe('om_m1');

    ds.currentTurnId = 'om_m2';
    noteNextStepTurnStarted(ds, 'om_m2', nextStepIo);
    noteRecapTurnStarted(ds, 'om_m2');
    expect(replyCardModeFor(ds, 'om_m2')).toBe('unified');
    await handle({ type: 'turn_input_committed', turnId: 'om_m2' });
    // Deferred queued turn M2 must NOT steal replyCardRunningTurnId from M1.
    expect(ds.replyCardRunningTurnId).toBe('om_m1');

    ds.currentTurnId = 'om_m3';
    noteNextStepTurnStarted(ds, 'om_m3', nextStepIo);
    noteRecapTurnStarted(ds, 'om_m3');
    expect(replyCardModeFor(ds, 'om_m3')).toBe('unified');
    await handle({ type: 'turn_input_committed', turnId: 'om_m3' });
    expect(ds.replyCardRunningTurnId).toBe('om_m1');

    // 2. Claude absorbs M2 & M3 mid-turn; worker notifies daemon.
    await handle({ type: 'native_input_consumed', turnId: 'om_m2', proofKind: 'claude_transcript_user_record', absorbedIntoTurnId: 'om_m1' });
    await handle({ type: 'native_input_consumed', turnId: 'om_m3', proofKind: 'claude_transcript_user_record', absorbedIntoTurnId: 'om_m1' });

    // 3. Model sends final answer via `botmux send --card-file ... --response-kind final` under host M1.
    const finalCardJson = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true },
      body: { elements: [{ tag: 'markdown', content: '这是三条合并后的完整最终答复。' }] },
    });
    await updateTurnReplyCard(
      ds,
      'om_m1',
      { kind: 'final', text: '这是三条合并后的完整最终答复。', card: finalCardJson, source: 'explicit' },
      async (body) => { postedByTurn.push({ turnId: 'om_m1', body }); return 'om_card_m1'; },
    );
    await ledger.execute(
      { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_m1' },
      'final',
      'fp-3908',
      async () => 'om_card_m1',
      {
        sentAtMs: Date.now(),
        resolveSettledAbsorbedTurnIds: () => ['om_m2', 'om_m3'],
      },
    );
    ds.turnTerminalCarriers = new Map([
      ['om_m1', { messageId: 'om_card_m1', kind: 'standard_reply_card', responseKind: 'final' }],
    ]);
    noteFinalReplyText(ds, 'om_m1', '这是三条合并后的完整最终答复。');
    postedByTurn.length = 0;

    // 4. Turn ends: worker emits turn_terminal for M1 (host) and M2, M3 (absorbed).
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m1',
      status: 'completed',
      durationMs: 358_200,
      absorbedTurnIds: ['om_m2', 'om_m3'],
    });
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m2',
      status: 'completed',
      absorbedIntoTurnId: 'om_m1',
      absorbedCoverage: 'settled',
    });
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m3',
      status: 'completed',
      absorbedIntoTurnId: 'om_m1',
      absorbedCoverage: 'settled',
    });
    await settle();

    // ZERO spurious cards were posted for M2 or M3!
    expect(postedByTurn.filter(p => p.turnId === 'om_m2' || p.turnId === 'om_m3')).toEqual([]);
    expect(store.read(replyCardKey(ds, 'om_m2'))).toMatchObject({ phase: 'completed', displayRetired: true });
    expect(store.read(replyCardKey(ds, 'om_m2'))?.messageId).toBeUndefined();
    expect(store.read(replyCardKey(ds, 'om_m3'))).toMatchObject({ phase: 'completed', displayRetired: true });
    expect(store.read(replyCardKey(ds, 'om_m3'))?.messageId).toBeUndefined();

    // M1's card holds the completed final answer.
    const m1Record = store.read(replyCardKey(ds, 'om_m1'))!;
    expect(m1Record.phase).toBe('completed');
    expect(m1Record.finalDelivered).toBe(true);
    expect(m1Record.finalText).toBe('这是三条合并后的完整最终答复。');

    // Next-step card was NOT ignored, and prompt_suggestion stamped with M3 lands on M1's card!
    expect(nextStepInfos.some(line => line.includes('ignored'))).toBe(false);
    noteNextStepSuggestion(ds, 'om_m3', '顺便跑一下回归测试', nextStepIo);
    expect(await waitForNextStepText(ds, store, 'om_m1', '顺便跑一下回归测试')).toBe('顺便跑一下回归测试');

    // Recap requested under M3 and CLI recap stamped with M3 lands on M1's card!
    expect(awayRequests).toEqual(['om_m3']);
    noteCliRecap(ds, 'om_m3', '已合并处理三条消息并输出答复。', turnRecapIo);
    expect(await waitForRecapMarkdown(ds, store, 'om_m1', '已合并处理三条消息并输出答复'))
      .toContain('已合并处理三条消息并输出答复');

    // All three messages classified delivered with DONE reactions, and session.lastTurn keeps delivered + M1 summary!
    expect(finishedReactions).toEqual(expect.arrayContaining([
      { turnId: 'om_m1', delivered: true },
      { turnId: 'om_m2', delivered: true },
      { turnId: 'om_m3', delivered: true },
    ]));
    expect(ds.session.lastTurn?.outcome).toBe('delivered');
    expect(ds.session.lastTurn?.summary).toContain('这是三条合并后的完整最终答复');

    // 5. Cross-turn isolation: independent turn M4 starts -> removes next-step row from M1, and late M1/M3 events are ignored!
    ds.currentTurnId = 'om_m4';
    noteNextStepTurnStarted(ds, 'om_m4', nextStepIo);
    noteRecapTurnStarted(ds, 'om_m4');
    await nextStepIdle(ds);
    expect(store.read(replyCardKey(ds, 'om_m1'))?.nextStep).toBeUndefined();

    noteNextStepSuggestion(ds, 'om_m1', '旧轮迟到建议', nextStepIo);
    noteNextStepSuggestion(ds, 'om_m3', '旧轮迟到建议2', nextStepIo);
    await nextStepIdle(ds);
    expect(store.read(replyCardKey(ds, 'om_m1'))?.nextStep).toBeUndefined();
    expect(nextStepInfos.some(line => line.includes('ignored'))).toBe(true);

    // Independent turn M4 finishes WITHOUT a final answer -> must NOT inherit M1's final; creates its own terminal card!
    expect(replyCardModeFor(ds, 'om_m4')).toBe('unified');
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m4',
      status: 'completed',
    });
    await settle();
    expect(postedByTurn.some(p => p.turnId === 'om_m4')).toBe(true);
    const m4Record = store.read(replyCardKey(ds, 'om_m4'))!;
    expect(m4Record.phase).toBe('completed');
    expect(m4Record.finalCard).toBeUndefined();
    expect(m4Record.displayRetired).toBeUndefined();
  });

  it('preserves #3911 externalFinal and silentTurn on host M1 while silently retiring absorbed M2 without extra cards', async () => {
    const ds = makeSession({ currentTurnId: 'om_m2' });
    const store = new TurnReplyCardStore(dir);
    const { io: nextStepIo } = makeNextStepIo();
    const { io: turnRecapIo } = makeRecapIo();
    const { handle, postedByTurn } = buildDaemonTerminalHarness(ds, { nextStepIo, turnRecapIo });

    expect(replyCardModeFor(ds, 'om_m1')).toBe('unified');
    expect(replyCardModeFor(ds, 'om_m2')).toBe('unified');

    // Host M1 ends with deliberate silence (nothing_to_send) and M2 folded into host execution.
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m1',
      status: 'completed',
      outputDisposition: 'nothing_to_send',
      absorbedTurnIds: ['om_m2'],
    });
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m2',
      status: 'completed',
      absorbedIntoTurnId: 'om_m1',
      absorbedCoverage: 'host_execution',
    });
    await settle();

    expect(store.read(replyCardKey(ds, 'om_m1'))?.silentTurn).toBe(true);
    expect(postedByTurn.filter(p => p.turnId === 'om_m2')).toEqual([]);
    expect(store.read(replyCardKey(ds, 'om_m2'))).toMatchObject({ phase: 'completed', displayRetired: true });
  });

  it('preserves #3911 fail-closed requiresReply when absorbed M2 required an answer and neither M1 nor M2 answered', async () => {
    const ds = makeSession({ currentTurnId: 'om_m2' });
    const store = new TurnReplyCardStore(dir);
    const { io: nextStepIo } = makeNextStepIo();
    const { io: turnRecapIo } = makeRecapIo();
    const { handle, postedByTurn } = buildDaemonTerminalHarness(ds, {
      nextStepIo,
      turnRecapIo,
      journalSink: () => ({
        kind: 'im',
        answerRequired: true,
        context: { target: { mode: 'thread', rootMessageId: 'om_m1' } },
      }),
    });

    expect(replyCardModeFor(ds, 'om_m1')).toBe('unified');
    expect(replyCardModeFor(ds, 'om_m2')).toBe('unified');

    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m2',
      status: 'completed',
      outputDisposition: 'nothing_to_send',
      absorbedIntoTurnId: 'om_m1',
      absorbedCoverage: 'host_execution',
    });
    await settle();

    // Must NOT silently fold: #3911 fail-closed rewrites required unanswered nothing_to_send to failed.
    const m2Record = store.read(replyCardKey(ds, 'om_m2'))!;
    expect(m2Record.phase).toBe('failed');
    expect(m2Record.displayRetired).toBeUndefined();
    expect(postedByTurn.some(p => p.turnId === 'om_m2')).toBe(true);
  });

  it('keeps promoted M2 with its own finalCard intact and gives M2 priority over late-settling M1 for next-step', async () => {
    const ds = makeSession({ currentTurnId: 'om_m2' });
    const store = new TurnReplyCardStore(dir);
    const { io: nextStepIo } = makeNextStepIo();
    const { io: turnRecapIo } = makeRecapIo();
    const { handle } = buildDaemonTerminalHarness(ds, { nextStepIo, turnRecapIo });

    noteNextStepTurnStarted(ds, 'om_m1', nextStepIo);
    noteNextStepTurnStarted(ds, 'om_m2', nextStepIo);
    expect(replyCardModeFor(ds, 'om_m1')).toBe('unified');
    expect(replyCardModeFor(ds, 'om_m2')).toBe('unified');

    // Mid-turn absorption observed first, then #3880 promotes M2 and Claude sends separate finals for M1 and M2.
    await handle({ type: 'native_input_consumed', turnId: 'om_m2', proofKind: 'claude_transcript_user_record', absorbedIntoTurnId: 'om_m1' });
    const card1 = JSON.stringify({ schema: '2.0', config: { update_multi: true }, body: { elements: [{ tag: 'markdown', content: 'Answer 1' }] } });
    const card2 = JSON.stringify({ schema: '2.0', config: { update_multi: true }, body: { elements: [{ tag: 'markdown', content: 'Answer 2' }] } });
    await updateTurnReplyCard(ds, 'om_m1', { kind: 'final', text: 'Answer 1', card: card1, source: 'explicit' }, async () => 'om_c1');
    await updateTurnReplyCard(ds, 'om_m2', { kind: 'final', text: 'Answer 2', card: card2, source: 'explicit' }, async () => 'om_c2');

    // M2 settles first (with absorbedCoverage omitted because M2 produced its own final), then M1 settles.
    await handle({ type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_m2', status: 'completed', absorbedIntoTurnId: 'om_m1' });
    await handle({ type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_m1', status: 'completed' });
    await settle();

    expect(store.read(replyCardKey(ds, 'om_m2'))?.finalText).toBe('Answer 2');
    expect(store.read(replyCardKey(ds, 'om_m2'))?.displayRetired).toBeUndefined();

    noteNextStepSuggestion(ds, 'om_m2', '基于 M2 继续', nextStepIo);
    expect(await waitForNextStepText(ds, store, 'om_m2', '基于 M2 继续')).toBe('基于 M2 继续');
    expect(store.read(replyCardKey(ds, 'om_m1'))?.nextStep).toBeUndefined();
  });

  it('handles Codex/TraeX supersededFinalDelivered without posting a missing-answer card on unshown successor M2', async () => {
    const ds = makeSession({ currentTurnId: 'om_m2' });
    const store = new TurnReplyCardStore(dir);
    const { io: nextStepIo } = makeNextStepIo();
    const { io: turnRecapIo } = makeRecapIo();
    const { handle, postedByTurn } = buildDaemonTerminalHarness(ds, { nextStepIo, turnRecapIo });

    // Verify bridge-fallback-gate detects completed same-thread superseded final,
    // and rejects detoured or non-completed terminals fail-closed.
    const markers: BridgeSendMarker[] = [{
      sentAtMs: 2_000,
      messageId: 'om_m1_final',
      sessionId: 'sid_3908',
      turnId: 'om_m1',
      responseKind: 'final',
      deliveryKind: 'current_session_send',
      targetChatId: 'oc_3908',
      targetRootMessageId: 'om_m1',
      terminalCarrier: 'standard_reply_card',
    }];
    const gateInput = bridgeGateInputForTurn('sid_3908', {
      turnId: 'om_m2',
      supersededTurns: [{ turnId: 'om_m1' }],
    }, { markTimeMs: 1_500, finalText: '', terminalStatus: 'completed' }, 'oc_3908', 'om_m1');
    expect(attributableSupersededFinalMarkers(gateInput, undefined, markers)).toHaveLength(1);
    expect(attributableSupersededFinalMarkers({ ...gateInput, terminalStatus: 'failed' }, undefined, markers)).toEqual([]);
    expect(attributableSupersededFinalMarkers(gateInput, undefined, [{ ...markers[0], deliveryKind: 'detoured_send', targetChatId: 'oc_other' }])).toEqual([]);
    expect(attributableSupersededFinalMarkers(gateInput, undefined, [{ ...markers[0], terminalIndependent: true }])).toEqual([]);

    expect(replyCardModeFor(ds, 'om_m2')).toBe('unified');
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m2',
      status: 'completed',
      supersededFinalDelivered: true,
    });
    await settle();

    expect(postedByTurn.filter(p => p.turnId === 'om_m2')).toEqual([]);
    expect(store.read(replyCardKey(ds, 'om_m2'))).toMatchObject({ phase: 'completed', displayRetired: true });

    // Non-completed terminal with supersededFinalDelivered must NOT be silently retired as completed.
    expect(replyCardModeFor(ds, 'om_m3')).toBe('unified');
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m3',
      status: 'failed',
      supersededFinalDelivered: true,
    });
    await settle();
    expect(store.read(replyCardKey(ds, 'om_m3'))?.phase).toBe('failed');
    expect(store.read(replyCardKey(ds, 'om_m3'))?.displayRetired).toBeUndefined();
  });

  it('keeps #3911 requiresReply fail-closed on Codex supersededFinalDelivered when unanswered', async () => {
    const ds = makeSession({ currentTurnId: 'om_m2' });
    const store = new TurnReplyCardStore(dir);
    const { io: nextStepIo } = makeNextStepIo();
    const { io: turnRecapIo } = makeRecapIo();
    const { handle } = buildDaemonTerminalHarness(ds, {
      nextStepIo,
      turnRecapIo,
      journalSink: () => ({
        kind: 'im',
        answerRequired: true,
        context: { target: { mode: 'thread', rootMessageId: 'om_m1' } },
      }),
    });

    expect(replyCardModeFor(ds, 'om_m2')).toBe('unified');
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m2',
      status: 'completed',
      outputDisposition: 'empty_answer',
      supersededFinalDelivered: true,
    });
    await settle();

    // Unanswered requiresReply must fail closed as failed, never silently retire as completed.
    expect(store.read(replyCardKey(ds, 'om_m2'))?.phase).toBe('failed');
    expect(store.read(replyCardKey(ds, 'om_m2'))?.displayRetired).toBeUndefined();
  });

  it('keeps #3911 externalFinal on host M1 clean while retiring absorbed M2/M3 with zero extra cards', async () => {
    const ds = makeSession({ currentTurnId: 'om_m3' });
    const store = new TurnReplyCardStore(dir);
    const ledger = new TurnSendLedger(dir);
    const { io: nextStepIo } = makeNextStepIo();
    const { io: turnRecapIo } = makeRecapIo();
    const { handle, postedByTurn } = buildDaemonTerminalHarness(ds, { nextStepIo, turnRecapIo });

    expect(replyCardModeFor(ds, 'om_m1')).toBe('unified');
    expect(replyCardModeFor(ds, 'om_m2')).toBe('unified');
    expect(replyCardModeFor(ds, 'om_m3')).toBe('unified');

    // M1 already posted its working card, then standalone `botmux send --card-file ... --response-kind final`
    // (outside unified card, e.g. with @mention) marked M1 externalFinal and settled M2/M3.
    await updateTurnReplyCard(ds, 'om_m1', { kind: 'start' }, async () => 'om_m1_status_card');
    await store.noteExternalFinal(replyCardKey(ds, 'om_m1'), ds.chatId);
    await ledger.execute(
      { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_m1' },
      'final',
      'fp-ext-final',
      async () => 'om_standalone_final',
      { sentAtMs: Date.now(), resolveSettledAbsorbedTurnIds: () => ['om_m2', 'om_m3'] },
    );
    ds.turnTerminalCarriers = new Map([
      ['om_m1', { messageId: 'om_standalone_final', kind: 'standard_reply_card', responseKind: 'final' }],
    ]);
    postedByTurn.length = 0;

    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m1',
      status: 'completed',
      absorbedTurnIds: ['om_m2', 'om_m3'],
    });
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m2',
      status: 'completed',
      absorbedIntoTurnId: 'om_m1',
      absorbedCoverage: 'settled',
    });
    await handle({
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_m3',
      status: 'completed',
      absorbedIntoTurnId: 'om_m1',
      absorbedCoverage: 'settled',
    });
    await settle();

    // Host M1 settles with externalFinal=true (no missing-answer body), and M2/M3 post zero cards.
    const m1 = store.read(replyCardKey(ds, 'om_m1'))!;
    expect(m1.phase).toBe('completed');
    expect(m1.externalFinal).toBe(true);
    expect(m1.lastCard).not.toContain('本轮没有提供最终答复');
    expect(m1.lastCard).not.toContain('No final answer');
    expect(postedByTurn.filter(p => p.turnId === 'om_m2' || p.turnId === 'om_m3')).toEqual([]);
    expect(store.read(replyCardKey(ds, 'om_m2'))).toMatchObject({ phase: 'completed', displayRetired: true });
    expect(store.read(replyCardKey(ds, 'om_m3'))).toMatchObject({ phase: 'completed', displayRetired: true });
  });

  it('upgrades merged M3 no_output to delivered when host M1 final arrives late (noteLateFinalReply)', async () => {
    const ds = makeSession({ currentTurnId: 'om_m3' });
    const t0 = Date.now() - 30_000;
    noteTurnStarted(ds, 'om_m1', t0);
    noteTurnStarted(ds, 'om_m3', t0 + 10_000);
    recordTurnAbsorbedMembers(ds, 'om_m1', ['om_m2', 'om_m3']);
    // Simulate drain timeout before host M1 final landed: M1 completed, then M3 committed no_output.
    await recordTurnOutcome(ds, { turnId: 'om_m1', status: 'completed' }, {
      recoveryHandled: false,
      isFinalDelivered: () => false,
      drainTimeoutMs: 0,
      dataDir: dir,
    });
    await recordTurnOutcome(ds, { turnId: 'om_m3', status: 'completed' }, {
      recoveryHandled: false,
      isFinalDelivered: () => false,
      fallbackTurnId: 'om_m1',
      drainTimeoutMs: 0,
      dataDir: dir,
    });
    expect(ds.session.lastTurn).toMatchObject({ turnId: 'om_m3', outcome: 'no_output' });

    noteFinalReplyText(ds, 'om_m1', '迟到送达的合并最终答复');
    const upgraded = noteLateFinalReply(ds, 'om_m1', { dataDir: dir });
    expect(upgraded).toMatchObject({
      turnId: 'om_m3',
      outcome: 'delivered',
      summary: '迟到送达的合并最终答复',
    });
  });
});

describe('next-step and recap state machines with merged turns and cross-turn isolation', () => {
  it('accepts host M1 card when latest turn is absorbed M3, and keeps M3 exact card priority when both exist', async () => {
    const ds = makeSession({ currentTurnId: 'om_m3' });
    const publishedM1: Array<string | undefined> = [];
    const publishedM3: Array<string | undefined> = [];
    const infos: string[] = [];
    const io: NextStepIo = {
      enabled: () => true,
      locale: () => 'zh',
      issue: (_d, prompt) => ({ payload: prompt, sig: 'sig' }),
      readCard: async () => undefined,
      cardId: async () => 'cid',
      insert: vi.fn(async () => {}),
      replace: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      now: () => Date.now(),
      warn: vi.fn(),
      info: msg => { infos.push(msg); },
    };

    noteNextStepTurnStarted(ds, 'om_m1', io);
    noteNextStepTurnStarted(ds, 'om_m2', io);
    noteNextStepTurnStarted(ds, 'om_m3', io);
    recordTurnAbsorbedMembers(ds, 'om_m1', ['om_m2', 'om_m3']);

    // Host card M1 settles while latest is M3 -> accepted!
    noteNextStepCard(ds, 'om_m1', { kind: 'unified', publish: async next => { publishedM1.push(next?.text); } }, io);
    noteNextStepSuggestion(ds, 'om_m3', '继续验证', io);
    await nextStepIdle(ds);
    expect(publishedM1).toEqual(['继续验证']);

    // If M3 later settles its own card, M3 takes over cleanly; then a late M1 card cannot clobber M3.
    noteNextStepCard(ds, 'om_m3', { kind: 'unified', publish: async next => { publishedM3.push(next?.text); } }, io);
    await nextStepIdle(ds);
    expect(publishedM1).toEqual(['继续验证', undefined]);
    expect(publishedM3).toEqual(['继续验证']);

    noteNextStepCard(ds, 'om_m1', { kind: 'unified', publish: async next => { publishedM1.push(next?.text); } }, io);
    await nextStepIdle(ds);
    expect(publishedM1).toEqual(['继续验证', undefined]);
    expect(infos.some(line => line.includes('already owns the latest card'))).toBe(true);
  });

  it('rejects unrelated older turn T1 card when independent T2 is latest', async () => {
    const ds = makeSession({ currentTurnId: 'om_t2' });
    const publishedT1: Array<string | undefined> = [];
    const io: NextStepIo = {
      enabled: () => true,
      locale: () => 'zh',
      issue: (_d, prompt) => ({ payload: prompt, sig: 'sig' }),
      readCard: async () => undefined,
      cardId: async () => 'cid',
      insert: vi.fn(async () => {}),
      replace: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      now: () => Date.now(),
      warn: vi.fn(),
    };
    noteNextStepTurnStarted(ds, 'om_t1', io);
    noteNextStepTurnStarted(ds, 'om_t2', io);
    noteNextStepCard(ds, 'om_t1', { kind: 'unified', publish: async next => { publishedT1.push(next?.text); } }, io);
    noteNextStepSuggestion(ds, 'om_t2', '新轮建议', io);
    await nextStepIdle(ds);
    expect(publishedT1).toEqual([]);
  });

  it('supports merged-turn recap attachment on host M1 and freezes it once independent M4 starts', async () => {
    const ds = makeSession({ currentTurnId: 'om_m3' });
    const recapsM1: string[] = [];
    const awayRequests: string[] = [];
    const io: RecapIo = {
      enabled: () => true,
      awaySummaryWanted: () => true,
      requestAwaySummary: (_d, turnId) => { awayRequests.push(turnId); },
      locale: () => 'zh',
      readCard: async () => undefined,
      cardId: async () => 'cid',
      insert: vi.fn(async () => {}),
      replace: vi.fn(async () => {}),
      now: () => Date.now(),
      warn: vi.fn(),
    };
    noteRecapTurnStarted(ds, 'om_m1');
    noteRecapTurnStarted(ds, 'om_m3');
    recordTurnAbsorption(ds, 'om_m3', 'om_m1');

    noteRecapCard(ds, 'om_m1', { kind: 'unified', publish: async md => { recapsM1.push(md); } }, io);
    expect(awayRequests).toEqual(['om_m3']);
    noteCliRecap(ds, 'om_m3', '本轮已完成全部改动。', io);
    await recapIdle(ds);
    expect(recapsM1).toHaveLength(1);
    expect(recapsM1[0]).toContain('本轮已完成全部改动');

    // New independent turn M4 isolates recap state.
    ds.currentTurnId = 'om_m4';
    noteRecapTurnStarted(ds, 'om_m4');
    noteCliRecap(ds, 'om_m3', '迟到的旧轮回顾', io);
    await recapIdle(ds);
    expect(recapsM1).toHaveLength(1);
  });

  it('prevents a detached absorbed turn (clearTurnAbsorption) from leaking next-step or recap onto host M1', async () => {
    const ds = makeSession({ currentTurnId: 'om_m3' });
    const nextWrites: Array<string | undefined> = [];
    const recapWrites: string[] = [];
    const nextIo: NextStepIo = {
      enabled: () => true,
      locale: () => 'zh',
      issue: (_d, prompt) => ({ payload: prompt, sig: 'sig' }),
      readCard: async () => undefined,
      cardId: async () => 'cid',
      insert: vi.fn(async () => {}),
      replace: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      now: () => Date.now(),
      warn: vi.fn(),
    };
    const recapIo: RecapIo = {
      enabled: () => true,
      awaySummaryWanted: () => false,
      requestAwaySummary: vi.fn(),
      locale: () => 'zh',
      readCard: async () => undefined,
      cardId: async () => 'cid',
      insert: vi.fn(async () => {}),
      replace: vi.fn(async () => {}),
      now: () => Date.now(),
      warn: vi.fn(),
    };

    noteNextStepTurnStarted(ds, 'om_m1', nextIo);
    noteNextStepTurnStarted(ds, 'om_m3', nextIo);
    noteRecapTurnStarted(ds, 'om_m1');
    noteRecapTurnStarted(ds, 'om_m3');
    // Temporary mid-turn link established before settlement rejects M3.
    recordTurnAbsorption(ds, 'om_m3', 'om_m1');
    noteNextStepCard(ds, 'om_m1', { kind: 'unified', publish: async next => { nextWrites.push(next?.text); } }, nextIo);
    noteRecapCard(ds, 'om_m1', { kind: 'unified', publish: async md => { recapWrites.push(md); } }, recapIo);

    // M3 is detached (TOCTOU / #3880 refusal) before suggestion/recap arrives.
    clearTurnAbsorption(ds, 'om_m3');
    noteNextStepSuggestion(ds, 'om_m3', '不该落到 M1 上', nextIo);
    noteCliRecap(ds, 'om_m3', '不该写进 M1 回顾', recapIo);
    await nextStepIdle(ds);
    await recapIdle(ds);

    expect(nextWrites).toEqual([]);
    expect(recapWrites).toEqual([]);
  });
});
