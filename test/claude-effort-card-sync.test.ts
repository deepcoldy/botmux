import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { applyClaudeEffortObservation } from '../src/core/claude-effort-observation.js';
import { withCardRuntimeIdentity } from '../src/core/card-runtime-identity.js';
import { cardUsageRuntimeSegment } from '../src/im/lark/md-card.js';
import { ClaudeEffortObserver } from '../src/services/claude-effort-observer.js';
import { parseStatuslinePayload, statuslineFilePath, writeStatuslineSnapshot } from '../src/services/statusline-snapshot.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';

const NOW = 1_799_000_000_000;
const NATIVE = 'native-claude-session';
const worker = {} as NonNullable<DaemonSession['worker']>;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-effort-sync-')); vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function session(): DaemonSession {
  return {
    worker, workerGeneration: 4, activeModel: 'claude-opus-5-5',
    session: { sessionId: 'botmux-sid', cliSessionId: NATIVE, cliId: 'claude-code',
      model: 'launch-model', reasoningEffort: 'high', workerGeneration: 4 },
  } as DaemonSession;
}
const usage = (ds: DaemonSession) => withCardRuntimeIdentity(ds, { context: null, tokens: null });

describe('Claude effort worker → daemon → card', () => {
  it('updates the visible runtime segment after a native statusline change and preserves model/launch preferences', () => {
    const ds = session();
    const patched: ReturnType<typeof usage>[] = [];
    const handler = loadWorkerPoolMessageHandlers(['claude_effort'], {
      ds, worker, workerGeneration: 4, effectiveCliId: 'claude-code', applyClaudeEffortObservation,
      scheduleActiveRuntimePatch: () => patched.push(usage(ds)),
    });
    const scope = {
      backend: {}, closeRequested: false,
      lastInitConfig: { cliId: 'claude-code', sessionId: 'botmux-sid', cliSessionId: NATIVE },
      config: { session: { dataDir: dir } }, bridgeObservedCliSessionId: NATIVE, bridgeJsonlPath: undefined,
      claudeEffortObserver: new ClaudeEffortObserver(), claudeEffortNotBeforeMs: NOW - 1,
      workerSessionEventScope: undefined, send: (message: WorkerToDaemon) => handler(message),
    };
    const poll = loadWorkerFunction<() => void>('publishClaudeEffortObservation', scope);
    for (const [offset, level] of [[0, 'high'], [1, 'medium']] as const) {
      vi.setSystemTime(NOW + offset);
      writeStatuslineSnapshot(dir, 'botmux-sid', parseStatuslinePayload({ session_id: NATIVE,
        model: { id: 'claude-opus-5-5' }, effort: { level } }, NOW + offset)!);
      poll();
    }
    expect(patched.map(p => p.reasoningEffort)).toEqual(['high', 'medium']);
    expect(cardUsageRuntimeSegment(patched[1]!)).toMatch(/claude-opus-5-5.*medium/);
    expect(cardUsageRuntimeSegment(patched[1]!)).not.toContain('high');
    expect(ds.session.reasoningEffort).toBe('high');
    expect(ds.activeModel).toBe('claude-opus-5-5');
    poll();
    expect(patched).toHaveLength(2);
    vi.setSystemTime(NOW + 2);
    writeStatuslineSnapshot(dir, 'botmux-sid', parseStatuslinePayload({ session_id: NATIVE,
      model: { id: 'claude-opus-5-5' } }, NOW + 2)!);
    poll();
    expect(ds.activeReasoningEffort).toBeUndefined();
    expect(cardUsageRuntimeSegment(patched[2]!)).not.toMatch(/high|medium/);
    expect(ds.activeModel).toBe('claude-opus-5-5');
  });

  it('omits unobserved Claude effort, including a previously frozen card snapshot value', () => {
    const ds = session();
    const snapshot = withCardRuntimeIdentity(ds, { context: null, tokens: null, reasoningEffort: 'high' });
    expect(snapshot.reasoningEffort).toBeUndefined();
    expect(cardUsageRuntimeSegment(snapshot)).not.toContain('high');
  });

  it('follows the primary transcript after /clear despite a stale pid-state session id', () => {
    const send = vi.fn();
    writeStatuslineSnapshot(dir, 'botmux-sid', parseStatuslinePayload({ session_id: NATIVE,
      model: { id: 'claude-opus-5-5' }, effort: { level: 'medium' } }, NOW)!);
    const poll = loadWorkerFunction<() => void>('publishClaudeEffortObservation', {
      backend: {}, closeRequested: false,
      lastInitConfig: { cliId: 'claude-code', sessionId: 'botmux-sid', cliSessionId: 'old-launch-session' },
      config: { session: { dataDir: dir } }, bridgeObservedCliSessionId: 'old-pid-state-session',
      bridgeJsonlPath: '/fixture/current.jsonl', sessionIdFromJsonlPath: () => NATIVE,
      claudeEffortObserver: new ClaudeEffortObserver(), claudeEffortNotBeforeMs: NOW - 1,
      workerSessionEventScope: undefined, send,
    });
    poll();
    expect(send).toHaveBeenCalledWith({ type: 'claude_effort', claudeSessionId: NATIVE, reasoningEffort: 'medium' });
  });

  it('catches up from a reading refused while the daemon was binding the new native session', () => {
    const ds = session(); ds.session.cliSessionId = 'old-native-session';
    const observer = new ClaudeEffortObserver();
    const source = { worker, workerGeneration: 4, cliId: 'claude-code' };
    for (const offset of [0, 1]) {
      writeStatuslineSnapshot(dir, 'botmux-sid', parseStatuslinePayload({ session_id: NATIVE,
        effort: { level: 'medium' } }, NOW + offset)!);
      utimesSync(statuslineFilePath(dir, 'botmux-sid'), new Date(NOW + offset), new Date(NOW + offset));
      if (offset) ds.session.cliSessionId = NATIVE;
      const reading = observer.observe(dir, 'botmux-sid', { claudeSessionId: NATIVE, notBefore: NOW - 1, now: NOW + offset });
      expect(reading).toBeDefined();
      expect(applyClaudeEffortObservation(ds, reading!, source)).toBe(Boolean(offset));
    }
    expect(usage(ds).reasoningEffort).toBe('medium');
  });

  it.each(['codex', 'traex', 'grok'] as const)('omits %s launch effort while keeping observed effort and rejecting Claude events', cliId => {
    const ds = session(); ds.session.cliId = cliId;
    expect(usage(ds).reasoningEffort).toBeUndefined();
    ds.activeReasoningEffort = 'medium';
    expect(usage(ds).reasoningEffort).toBe(cliId === 'grok' ? undefined : 'medium');
    expect(applyClaudeEffortObservation(ds, { claudeSessionId: NATIVE, reasoningEffort: 'low' },
      { worker, workerGeneration: 4, cliId })).toBe(false);
    expect(ds.activeReasoningEffort).toBe('medium');
  });

  it('rejects a different worker, generation, or native session without changing the card', () => {
    const ds = session(); ds.activeReasoningEffort = 'high';
    const message = { claudeSessionId: NATIVE, reasoningEffort: 'medium' as const };
    const source = { worker, workerGeneration: 4, cliId: 'claude-code' };
    expect(applyClaudeEffortObservation(ds, message, { ...source, worker: {} as typeof worker })).toBe(false);
    expect(applyClaudeEffortObservation(ds, message, { ...source, workerGeneration: 3 })).toBe(false);
    expect(applyClaudeEffortObservation(ds, message, { ...source, worker: undefined })).toBe(false);
    expect(applyClaudeEffortObservation(ds, { ...message, reasoningEffort: 'invalid' } as any, source)).toBe(false);
    expect(applyClaudeEffortObservation(ds, { ...message, claudeSessionId: 'previous-native-session' }, source)).toBe(false);
    ds.session.workerGeneration = 5;
    expect(applyClaudeEffortObservation(ds, message, source)).toBe(false);
    expect(ds.activeReasoningEffort).toBe('high');
  });

  it.each(['codex', undefined])('does not read or publish Claude statusline for another CLI (%s)', cliId => {
    const send = vi.fn();
    const observe = vi.fn();
    const poll = loadWorkerFunction<() => void>('publishClaudeEffortObservation', {
      backend: {}, closeRequested: false, lastInitConfig: { cliId }, claudeEffortObserver: { observe }, send,
    });
    poll(); expect(observe).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it.each([{ backend: null, closeRequested: false }, { backend: {}, closeRequested: true }])(
    'stops observing a detached or closing CLI (%j)', state => {
      const observe = vi.fn(); const send = vi.fn();
      const poll = loadWorkerFunction<() => void>('publishClaudeEffortObservation', {
        ...state, lastInitConfig: { cliId: 'claude-code' }, claudeEffortObserver: { observe }, send,
      });
      poll(); expect(observe).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    },
  );
});
