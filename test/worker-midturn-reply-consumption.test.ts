import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { selectReplyMessageId } from '../src/core/reply-message.js';
import {
  findAncestorSessionMarkerContext,
  markerBelongsToLiveProcess,
  readProcessStartIdentity,
} from '../src/core/session-marker.js';
import { isValidMarkerIdentityTurnId } from '../src/core/turn-id-shape.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { validateCodexAppManagedSendOrigin } from '../src/utils/codex-app-dispatch-ledger.js';
import { withFileLockSync } from '../src/utils/file-lock.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Retained per-message reply contexts, as the daemon records them on arrival:
// A started in a topic, B arrived in the main chat.
const session = {
  sessionId: 'sid',
  turnReplyContexts: {
    om_a: { target: { mode: 'thread', rootMessageId: 'om_topic' } },
    om_b: { target: { mode: 'plain', chatId: 'oc_chat' } },
  },
};

describe('a busy-time write is not proof that the model read the message', () => {
  // CoCo parks a busy-time Enter until the running turn ends (and so does
  // Antigravity's queue mode); writeInput still reports the submit. Moving the
  // default reply location at write time would post A's own answer at B.
  it.each([
    ['coco', undefined],
    ['pi', undefined],
    ['claude-code', '/tmp/claude-data'],
  ] as const)('%s: type-ahead B stays unconsumed after its write while A runs', async (cliId, claudeDataDir) => {
    const { scope, flush } = workerSubmitHarness();
    const published: unknown[] = [];
    Object.assign(scope, {
      lastInitConfig: { cliId },
      isPromptReady: false,
      currentBotmuxTurnId: 'om_a',
      codexRpcEngine: undefined,
      codexBridgeFallbackActive: () => false,
      stampMojoTurnMark: vi.fn(),
      deferTurnInputCommitUntilSubmission: () => false,
      maybeQueuePostSubmitNativeSessionTitle: () => false,
      writeCliPidMarker: vi.fn(() => published.push(structuredClone(scope.queuedTypeAheadTurns))),
    });
    if (claudeDataDir) scope.cliAdapter.claudeDataDir = claudeDataDir;
    scope.pendingMessages.splice(0, 1, { turnId: 'om_b', content: 'B from the main chat' });
    scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));

    await flush();

    expect(scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(scope.currentBotmuxTurnId).toBe('om_a');
    expect(scope.queuedTypeAheadTurns.map((t: { turnId: string }) => t.turnId)).toEqual(['om_b']);
    expect(scope.queuedTypeAheadTurns[0].inputConsumed).toBeUndefined();
    expect(published.length).toBeGreaterThan(0);
    expect(JSON.stringify(published)).not.toContain('inputConsumed');
  });
});

function markerWorker(dataDir: string) {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  mkdirSync(markersDir, { recursive: true });
  // Named for a pid that is alive with a known birth time: this test process.
  const markerPath = join(markersDir, String(process.pid));
  const scope: Record<string, any> = {
    heldPidMarkerPaths: new Set<string>(),
    existsSync, readFileSync, unlinkSync, basename,
    withFileLockSync, atomicWriteFileSync,
    readProcessStartIdentity, markerBelongsToLiveProcess, isValidMarkerIdentityTurnId,
    sessionId: 'sid',
    cliPidMarker: markerPath,
    rpcEnginePidMarker: null,
    currentBotmuxTurnId: 'om_a',
    currentBotmuxDispatchAttempt: undefined,
    currentBotmuxCallerOpenId: undefined,
    currentBotmuxLinkRefMode: undefined,
    currentTurnSteerPromoted: false,
    currentVcMeetingImTurnOrigin: undefined,
    sandboxRelayCapability: null,
    activeTurnAuthority: new ActiveTurnAuthority(),
    retiredTurnIds: new Set<string>(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    queuedTypeAheadTurns: [{ turnId: 'om_b' }],
    markTurnRetired: () => {},
    markActiveTurnStarted: () => {},
    publishActiveTurn: () => {},
    publishSandboxRelayCapability: () => false,
    log: () => {},
    inflightInputs: { onTurnStarted: vi.fn() },
    lastWrittenCliInput: undefined,
    send: vi.fn(),
  };
  for (const name of ['withPidMarkerLock', 'writeCliPidMarker', 'restoreQueuedTurnsFromMarkerDisk',
    'markerIdentityTurnId', 'turnTerminalEmitted', 'retireTerminatedMarkerTurn', 'markerQueuedTurnStillLive',
    'markReplyInputConsumed', 'acknowledgeNativeInputConsumed']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  return { scope, markerPath };
}

describe('native consumption reaches `botmux send` through the PID marker', () => {
  it('moves the default reply location only after the native proof, never the execution turn', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'midturn-marker-'));
    roots.push(dataDir);
    const { scope } = markerWorker(dataDir);
    const select = () => {
      const marker = findAncestorSessionMarkerContext(dataDir, process.pid, 'sid');
      return { marker, reply: selectReplyMessageId(session, marker?.turnId, marker) };
    };

    scope.writeCliPidMarker();
    expect(select()).toMatchObject({ marker: { turnId: 'om_a' }, reply: 'om_a' });

    scope.acknowledgeNativeInputConsumed('om_b', 'claude_transcript_user_record');
    const after = select();
    expect(after.marker?.turnId).toBe('om_a');
    expect(after.marker?.queuedTurns).toEqual([{ turnId: 'om_b', inputConsumed: true }]);
    expect(after.reply).toBe('om_b');
  });

  it('keeps the consumption across a worker restart and a merge from disk', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'midturn-marker-'));
    roots.push(dataDir);
    const first = markerWorker(dataDir);
    first.scope.acknowledgeNativeInputConsumed('om_b', 'codex_history_match');

    // A successor worker restores the queue from the marker its predecessor left.
    const restored = markerWorker(dataDir);
    restored.scope.queuedTypeAheadTurns = [];
    restored.scope.restoreQueuedTurnsFromMarkerDisk(restored.markerPath);
    expect(restored.scope.queuedTypeAheadTurns).toEqual([{ turnId: 'om_b', inputConsumed: true }]);

    // A worker whose memory lost the record merges it back on its next write.
    const merged = markerWorker(dataDir);
    merged.scope.queuedTypeAheadTurns = [];
    merged.scope.writeCliPidMarker();
    expect(merged.scope.queuedTypeAheadTurns).toEqual([{ turnId: 'om_b', inputConsumed: true }]);
    expect(JSON.parse(readFileSync(merged.markerPath, 'utf8')).queuedTurns)
      .toEqual([{ turnId: 'om_b', inputConsumed: true }]);
  });
});

describe('sandbox relay authorization supplies reply addressing only for the live ordinary turn', () => {
  const token = 'c'.repeat(64);
  function authorize(opts: {
    capabilityTurnId?: string;
    cliId?: string;
    ledger?: Array<{ turnId: string; dispatchAttempt: number }>;
    dispatchAttempt?: number;
    vcOrigin?: boolean;
    queue?: Array<{ turnId: string; inputConsumed?: true }>;
  } = {}) {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = '/tmp/midturn-authorize-unused';
    try {
      const capabilityTurnId = opts.capabilityTurnId ?? 'om_a';
      const scope: Record<string, any> = {
        sessionId: 'sid',
        sandboxRelayCapability: { token, turnId: capabilityTurnId, dispatchAttempt: opts.dispatchAttempt },
        sessionStore: { getSessionFresh: () => ({ cliId: opts.cliId ?? 'claude-code', codexAppDispatchLedger: opts.ledger ?? [] }) },
        lastInitConfig: { cliId: opts.cliId ?? 'claude-code' },
        isCodexAppCliId: (id?: string) => id === 'codex-app',
        validateCodexAppManagedSendOrigin,
        currentVcMeetingImTurnOrigin: opts.vcOrigin
          ? { larkMessageId: capabilityTurnId, receiverSessionId: 'sid' } : undefined,
        // The VC meeting policy itself is covered elsewhere; this pins only the addressing guard.
        evaluateVcMeetingManagedSend: () => ({ ok: true }),
        currentBotmuxTurnId: 'om_a',
        queuedTypeAheadTurns: opts.queue ?? [{ turnId: 'om_b', inputConsumed: true }, { turnId: 'om_c' }],
      };
      const result = loadWorkerFunction<(claim: { capability?: string }) => any>('authorizeManagedSend', scope)({ capability: token });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result.origin as { turnId?: string; replyMessageId?: string; requiresCodexAppLedger?: boolean };
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
    }
  }

  it('names the latest consumed queued message for the current turn', () => {
    expect(authorize()).toMatchObject({ turnId: 'om_a', replyMessageId: 'om_b' });
    expect(authorize({ queue: [{ turnId: 'om_b' }] }).replyMessageId).toBeUndefined();
  });

  it('withholds it from a capability minted for another turn', () => {
    const origin = authorize({ capabilityTurnId: 'om_older' });
    expect(origin.turnId).toBe('om_older');
    expect(origin.replyMessageId).toBeUndefined();
  });

  it('withholds it from a frozen Codex App dispatch', () => {
    const origin = authorize({ cliId: 'codex-app', dispatchAttempt: 1, ledger: [{ turnId: 'om_a', dispatchAttempt: 1 }] });
    expect(origin.requiresCodexAppLedger).toBe(true);
    expect(origin.replyMessageId).toBeUndefined();
  });

  it('withholds it from a VC meeting IM turn', () => {
    expect(authorize({ vcOrigin: true }).replyMessageId).toBeUndefined();
  });
});
