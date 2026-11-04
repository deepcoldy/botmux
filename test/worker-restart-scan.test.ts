import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { bridgeSpecFor } from '../src/adapters/cli/registry.js';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { hasInterruptedWork, mergeInterruptedWork, structuredTurnOpen, transcriptTailOffset,
  withoutReportedTasks } from '../src/services/restart-interruption.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const beforeMs = Date.parse('2026-01-01T00:00:10Z');
function row(type: string, turnId: string, seconds: number) {
  const payload = type === 'user_message' ? { type, turn_id: turnId, message: `ask ${turnId}` }
    : { type, turn_id: turnId, last_agent_message: 'done', duration_ms: 1000 };
  return JSON.stringify({ type: 'event_msg', timestamp: `2026-01-01T00:00:${String(seconds).padStart(2, '0')}Z`, payload }) + '\n';
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'worker-restart-scan-'));
  roots.push(root);
  const path = join(root, 'rollout-2026-01-01T00-00-00-00000000-0000-7000-8000-000000000555.jsonl');
  const scope = { restartInterruptionScanBeforeMs: beforeMs, lastInitConfig: { cliId: 'traex' },
    pendingRestartInterruption: undefined, reportedInterruptedTaskIds: new Set<string>(),
    transcriptTailOffset, bridgeSpecFor, structuredBridgeIs: () => false, drainTraexRollout,
    structuredTurnOpen, mergeInterruptedWork, withoutReportedTasks, hasInterruptedWork, log: vi.fn() };
  const scan = loadWorkerFunction<(path: string, family: 'structured') => void>('scanRestartInterruption', scope);
  return { path, scope, scan: () => scan(path, 'structured') };
}

describe('Worker TraeX restart interruption scan', () => {
  it('finds an already-consumed open turn after a completed predecessor', () => {
    const f = fixture();
    writeFileSync(f.path, row('user_message', 'first', 1) + row('task_complete', 'first', 2) + row('user_message', 'next', 3));
    const live = drainTraexRollout(f.path, 0);
    expect(live.events.filter(event => event.kind === 'user').map(event => event.sourceTurnId)).toEqual(['first', 'next']);
    f.scan();
    expect(f.scope.pendingRestartInterruption).toEqual({ turnOpen: true, tasks: [] });
    expect(f.scope.restartInterruptionScanBeforeMs).toBeUndefined();
  });

  it('does not consume an unread user boundary needed by the live bridge', () => {
    const f = fixture();
    const prefix = row('user_message', 'first', 1) + row('task_complete', 'first', 2);
    writeFileSync(f.path, prefix);
    const previous = drainTraexRollout(f.path, 0);
    writeFileSync(f.path, prefix + row('user_message', 'next', 3));
    f.scan();
    expect(f.scope.pendingRestartInterruption).toEqual({ turnOpen: true, tasks: [] });
    expect(drainTraexRollout(f.path, previous.newOffset).events.filter(event => event.kind === 'user')
      .map(event => event.sourceTurnId)).toEqual(['next']);
  });

  it('recognizes activity when the bounded tail starts inside an open turn', () => {
    const f = fixture();
    writeFileSync(f.path, JSON.stringify({ type: 'history_mutation', timestamp: '2026-01-01T00:00:03Z',
      payload: { operation: 'append', turn_id: 'next', items: [
        { type: 'function_call', call_id: 'read-next', name: 'read_file', arguments: '{"path":"src/a.ts"}' },
      ] } }) + '\n');
    f.scan();
    expect(f.scope.pendingRestartInterruption).toEqual({ turnOpen: true, tasks: [] });
  });

  it('keeps other structured CLIs on their configured bridge reader', () => {
    const f = fixture();
    writeFileSync(f.path, '');
    f.scope.lastInitConfig.cliId = 'codex';
    const drain = vi.fn(() => ({ events: [{ kind: 'user', timestampMs: beforeMs - 1 }], newOffset: 0 }));
    f.scope.bridgeSpecFor = vi.fn(() => ({ drain }) as any);
    f.scope.drainTraexRollout = vi.fn(() => { throw new Error('TraeX reader must not handle Codex'); });
    f.scan();
    expect(f.scope.pendingRestartInterruption).toEqual({ turnOpen: true, tasks: [] });
    expect(drain).toHaveBeenCalledWith(f.path, 0, { adoptMode: false, state: undefined });
    expect(f.scope.drainTraexRollout).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'completed successor', next: row('user_message', 'next', 3) + row('task_complete', 'next', 4) },
    { name: 'successor belonging to the new process', next: row('user_message', 'next', 11) },
  ])('leaves $name without an interruption', ({ next }) => {
    const f = fixture();
    writeFileSync(f.path, row('user_message', 'first', 1) + row('task_complete', 'first', 2) + next);
    drainTraexRollout(f.path, 0);
    f.scan();
    expect(f.scope.pendingRestartInterruption).toBeUndefined();
  });
});
