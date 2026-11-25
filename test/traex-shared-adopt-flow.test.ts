import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { drainTraexRollout, splitTraexAdoptEvents } from '../src/services/traex-transcript.js';
import { bridgeGateInputForTurn, bridgePostText, structuredFallbackKind, shouldSuppressStructuredFallback } from '../src/services/bridge-fallback-gate.js';
import { bridgeTurnOutcome } from '../src/utils/usage-limit-tracker.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { traexTerminalSessionIsBound } from '../src/services/traex-terminal-session.js';

afterEach(() => vi.useRealTimers());

function outputScope(queue: CodexBridgeQueue) {
  const scope: Record<string, any> = {
    sessionId: 'adopt-fixture', lastInitConfig: { cliId: 'traex', adoptMode: true },
    codexBridgeQueue: queue, recoverTraexQuotaTurn: () => false,
    checkpointCodexAdoptRecovery: vi.fn(), checkpointStructuredBridgeRecovery: vi.fn(),
    armPostTerminalInputFence: vi.fn(), isExistingAppServerSharedBridge: () => false,
    zeroPromptTerminalSync: () => false, structuredBridgeIs: (id: string) => id === 'traex',
    bridgeGateInputForTurn, structuredFallbackKind, bridgePostText, bridgeTurnOutcome,
    replyDeliveryMode: () => 'transcript', shouldSuppressStructuredFallback,
    deliveredFinalFailureNoticeSuppressed: () => false,
    notifyExplicitRepliesObserved: vi.fn(), attributableExplicitReplyMarkersForTurnWindow: () => [],
    usageLimitTracker: { noteTurnCompleted: vi.fn() }, send: vi.fn(),
    releaseInputDeliveryQuarantineForStructuredTerminal: vi.fn(), retireRpcLifecycleFromStructuredTerminal: vi.fn(),
    emitTurnTerminal: vi.fn(), retireStructuredTurnAttribution: vi.fn(),
    truncatePreambleText: (text: string, length: number) => text.slice(0, length),
    LOCAL_TURN_USER_MAX: 1000, LOCAL_TURN_ASSISTANT_MAX: 6000,
  };
  scope.formatLocalTurnFields = loadWorkerFunction('formatLocalTurnFields', scope);
  scope.emit = loadWorkerFunction('emitReadyCodexTurns', scope);
  return scope;
}

function nativeEvents(inputAt: number, completeAt: number, text: string, answer: string) {
  const root = mkdtempSync(join(tmpdir(), 'traex-adopt-flow-'));
  const path = join(root, 'rollout-00000000-0000-7000-8000-000000000001.jsonl');
  const line = (at: number, payload: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
  writeFileSync(path, line(inputAt, { type: 'user_message', message: text, turn_id: 'native-turn' })
    + line(completeAt, { type: 'task_complete', turn_id: 'native-turn', last_agent_message: answer }));
  try { return drainTraexRollout(path, 0, { adoptMode: true }).events; }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe('TRAE adopted shared-daemon result flow', () => {
  it.each(['plain', 'skill-legacy', 'skill-display', 'skill-canonical'])(
    'keeps the actual correlated %s submit and its answer on the original Lark turn', async kind => {
      const root = mkdtempSync(join(tmpdir(), 'traex-marker-flow-'));
      const previousHome = process.env.TRAE_HOME;
      const id = '00000000-0000-7000-8000-000000000001';
      const original = kind === 'plain' ? 'continue checking' : '/fixture inspect every argument';
      const now = Date.now();
      try {
        process.env.TRAE_HOME = root;
        mkdirSync(join(root, 'cli'), { recursive: true });
        const history = join(root, 'cli', 'history.jsonl');
        let pasted = '';
        const terminal = {
          cliPid: process.pid, write: vi.fn(), pasteText: (text: string) => { pasted = text; },
          sendSpecialKeys: () => writeFileSync(history, JSON.stringify({ session_id: id, text: pasted }) + '\n'),
        };
        const queue = new CodexBridgeQueue(() => Date.now());
        queue.setLocalTurns(true, now); queue.mark('om-marker', original, now);
        const result = await createTraexAdapter().writeInput(terminal, original, { correlateTranscript: true });
        expect(result).toMatchObject({ submitted: true, cliSessionId: id, ownershipProven: true });
        expect(traexTerminalSessionIsBound(terminal, id)).toBe(true);
        queue.confirmPendingTurn('om-marker');
        const recorded = JSON.parse(readFileSync(history, 'utf8')).text;
        expect(recorded).toMatch(/botmux_input_id: [0-9a-f]{32}/);
        const expanded = kind === 'plain' ? recorded
          : recorded.replace(/^\/fixture/, '[$fixture](/tmp/fixture/SKILL.md)');
        const content = [{ type: 'text', text: expanded }];
        const user = kind === 'skill-display'
          ? { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'native-marker', item: { type: 'UserMessage', content } } }
          : kind === 'skill-canonical'
            ? { type: 'history_mutation', payload: { operation: 'append', turn_id: 'native-marker', items: [{
              type: 'message', role: 'user', content: [{ type: 'input_text', text: expanded }],
              internal_chat_message_metadata_passthrough: { turn_id: 'native-marker', content_item_kinds: ['user.text'] },
            }] } }
            : { type: 'event_msg', payload: { type: 'user_message', turn_id: 'native-marker', message: expanded } };
        const rollout = join(root, `rollout-${id}.jsonl`);
        const line = (record: object) => JSON.stringify({ timestamp: new Date(Date.now()).toISOString(), ...record }) + '\n';
        writeFileSync(rollout, line(user) + line({ type: 'event_msg', payload: {
          type: 'task_complete', turn_id: 'native-marker', last_agent_message: 'correlated answer',
        } }));
        const events = drainTraexRollout(rollout, 0, { adoptMode: true }).events;
        expect(events.find(event => event.kind === 'user')?.text).not.toContain('botmux_input_id:');
        queue.ingest(events);
        expect(queue.drainEmittable()).toEqual([expect.objectContaining({ turnId: 'om-marker', finalText: 'correlated answer' })]);
        expect(queue.peek()).toEqual([]);
      } finally {
        if (previousHome === undefined) delete process.env.TRAE_HOME; else process.env.TRAE_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('forwards a terminal task that was running before adopt exactly once, without replaying completed history', () => {
    const cutoff = 946684900000;
    const old = nativeEvents(cutoff - 120000, cutoff - 110000, 'old input', 'old answer');
    const current = nativeEvents(cutoff - 60000, cutoff + 10000, 'terminal task', 'terminal answer');
    // Use distinct native turns, as the real CLI does across user submissions.
    old.forEach(event => { event.sourceTurnId = 'old'; event.uuid = `old-${event.uuid}`; });
    const split = splitTraexAdoptEvents([...old, ...current], cutoff);
    const queue = new CodexBridgeQueue(() => cutoff + 10000);
    queue.setLocalTurns(true, split.localSinceMs);
    queue.absorb(split.history); queue.ingest(split.live);
    queue.setLocalTurns(true, cutoff);
    const scope = outputScope(queue);
    scope.emit(); scope.emit();
    expect(scope.send.mock.calls.map(([message]: any[]) => message)).toEqual([
      expect.objectContaining({ type: 'final_output', kind: 'local-turn', userText: 'terminal task', content: 'terminal answer' }),
    ]);
    expect(scope.emitTurnTerminal).toHaveBeenCalledTimes(1);
  });

  it('forwards a confirmed Lark task without waiting for a human draft or a subsequent task to finish', () => {
    const cutoff = 946684900000;
    const queue = new CodexBridgeQueue(() => cutoff + 10000);
    queue.mark('om-fixture', 'Lark continuation', cutoff);
    queue.confirmPendingTurn('om-fixture');
    queue.ingest(nativeEvents(cutoff + 1, cutoff + 1000, 'Lark continuation', 'continuation answer'));
    const scope = outputScope(queue);
    // A terminal draft/busy state must not hold a durable completed reply.
    scope.backend = { captureInputState: () => ({ viewport: 'human draft / next task', cursor: { x: 10, y: 0 } }) };
    scope.adapterInputHandle = (value: any) => value;
    scope.traexTerminalIdentityNeedsRefresh = () => true;
    scope.emit();
    expect(scope.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'final_output', turnId: 'om-fixture', content: 'continuation answer' }));
  });

  it('keeps the original timestamp of an admitted running task and restores the history watermark afterward', () => {
    const cutoff = 946684900000;
    const current = nativeEvents(cutoff - 60000, cutoff + 10000, 'running', 'done');
    const split = splitTraexAdoptEvents(current, cutoff);
    expect(split.live.find(event => event.kind === 'user')?.timestampMs).toBe(cutoff - 60000);
    const queue = new CodexBridgeQueue(() => cutoff + 10000);
    queue.setLocalTurns(true, split.localSinceMs); queue.absorb(split.history); queue.ingest(split.live);
    queue.setLocalTurns(true, cutoff); queue.drainEmittable();
    const unrelated = nativeEvents(cutoff - 30000, cutoff - 20000, 'historical task', 'historical answer');
    queue.ingest(unrelated);
    expect(queue.drainEmittable()).toEqual([]);
  });
});
