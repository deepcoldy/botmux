/**
 * The worker records what each turn did for its「本轮回顾」apart from the
 * reply card's activity buffer, and hands it to the daemon just before the
 * turn's completed terminal — so a long turn's last edits and commands, not
 * just its first 60k characters of activity, reach the panel.
 */
import { describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { stripTrailingBridgeSentinelLine } from '../src/services/bridge-fallback-gate.js';
import type { CotEntry } from '../src/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function worker() {
  const scope: Record<string, any> = {
    sessionId: 'sid',
    lastInitConfig: { workingDir: '/work/app' },
    // The reply card's activity buffer, as in worker.ts.
    THINKING_ACCUMULATED_CAP: 60_000,
    thinkingTurnKey: undefined,
    thinkingTurn: undefined,
    thinkingEntries: [],
    thinkingTotalChars: 0,
    thinkingCapNoted: false,
    scheduleThinkingEmit: vi.fn(),
    flushThinkingUpdate: vi.fn(),
    currentBotmuxTurnId: undefined,
    currentBotmuxDispatchAttempt: undefined,
    queuedTypeAheadTurns: [],
    retiredTurnIds: new Set<string>(),
    activeTurnAuthority: new ActiveTurnAuthority(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    submitFailureChains: new Map(),
    cliSpawnGeneration: 1,
    cancelSubmitFailureChainForTerminal: vi.fn(),
    turnExecutionClock: { settle: () => ({ completedAtMs: 1000, durationMs: 5 }), forget: vi.fn() },
    codexBridgeQueue: { dropPendingTurn: () => false },
    sandboxRelayCapability: null,
    completeManagedTurnOriginRevocation: vi.fn(),
    terminalReleasesDurableTurn: () => false,
    remoteRunnerRecoveredTurnInFlight: false,
    flushPending: vi.fn(),
    queueMicrotask: (fn: () => void) => fn(),
    writeCliPidMarker: vi.fn(),
    publishSandboxRelayCapability: vi.fn(),
    syncQueuedTurnsFromMarkerDisk: () => false,
    crossPrincipalIsolationOn: () => false,
    send: vi.fn(),
    log: vi.fn(),
    stripTrailingBridgeSentinelLine,
  };
  scope.markTurnRetired = (turnId?: string) => { if (turnId) scope.retiredTurnIds.add(turnId); };
  for (const name of [
    'cotEntryChars', 'cotEntryWithoutSentinel', 'observeCotEntries',
    'turnAuthorityIdentity', 'adoptActiveTurnWhenIsolationOff', 'activeTurnBlocks', 'markActiveTurnStarted',
    'releaseActiveTurnAuthority', 'releaseTerminatedActiveTurnAuthority', 'retireTerminatedQueuedTurn',
    'advanceQueuedTypeAheadTurn', 'emitTurnTerminal', 'dropQueuedTurnRecord', 'turnTerminalEmitted',
    'retireTerminatedMarkerTurn',
  ]) scope[name] = loadWorkerFunction(name, scope);
  return scope;
}

const sent = (scope: Record<string, any>) => scope.send.mock.calls.map((call: any[]) => call[0]);

/** A turn whose reads alone overflow the reply card's activity buffer before it edits and pushes. */
function longTurn(): CotEntry[] {
  const entries: CotEntry[] = [];
  for (let index = 0; index < 120; index++) {
    entries.push({ kind: 'tool_call', id: `r${index}`, name: 'Read', args: '{}', subject: `/work/app/src/mod${index}.ts` });
    entries.push({ kind: 'tool_result', id: `r${index}`, result: 'x'.repeat(800) });
  }
  entries.push(
    { kind: 'tool_call', id: 'e1', name: 'Edit', args: '{}', subject: '/work/app/src/feature.ts' },
    { kind: 'tool_call', id: 'b1', name: 'Bash', args: '{}', subject: 'git push origin feat/x' },
    { kind: 'text', text: '已推送。\nBOTMUX_NOTHING_TO_SEND' },
  );
  return entries;
}

describe('worker recap input', () => {
  it('reaches the daemon before the completed terminal, with what the turn did last', () => {
    const w = worker();
    for (const entry of longTurn()) w.observeCotEntries([entry], { turnId: 'om_long', dispatchAttempt: 1 });
    // The card's buffer stopped at its cap; the recap kept going.
    expect(w.thinkingCapNoted).toBe(true);
    w.emitTurnTerminal('om_long', 'completed', undefined, 1);
    const [input, terminal] = sent(w).filter((msg: any) => msg.type === 'recap_input' || msg.type === 'turn_terminal');
    expect(terminal).toMatchObject({ type: 'turn_terminal', turnId: 'om_long', status: 'completed' });
    expect(input.type).toBe('recap_input');
    expect(input.turnId).toBe('om_long');
    expect(input.dispatchAttempt).toBe(1);
    expect(input.facts).toEqual({ files: ['src/feature.ts'], commands: 1, lastCommand: 'git push origin feat/x' });
    // The reply's sentinel never reaches the model.
    expect(input.activity.at(-1)).toBe('Assistant: 已推送。');
  });

  it('skips a malformed entry instead of breaking the activity stream', () => {
    const w = worker();
    expect(() => w.observeCotEntries([{ kind: 'text', text: undefined } as any, ...longTurn().slice(-3)], { turnId: 'om_bad' })).not.toThrow();
    expect(w.thinkingEntries.map((entry: CotEntry) => entry.kind)).toEqual(['tool_call', 'tool_call', 'text']);
  });

  it('sends nothing for another turn, a failed terminal, or a turn without activity', () => {
    const w = worker();
    w.observeCotEntries(longTurn().slice(-3), { turnId: 'om_a' });
    w.emitTurnTerminal('om_b', 'completed');
    w.emitTurnTerminal('om_a', 'failed', 'provider_x');
    expect(sent(w).filter((msg: any) => msg.type === 'recap_input')).toEqual([]);
  });
});
