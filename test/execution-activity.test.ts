import { describe, it, expect } from 'vitest';
import { projectExecutionActivity, normalizeExecutionActivity } from '../src/core/execution-activity.js';
import { sessionExecutionActivity } from '../src/core/session-execution-activity.js';
import { normalizeSessionRow } from '../src/services/session-observe.js';
import type { DaemonSession } from '../src/core/types.js';

const execution = { startedAtMs: 1000, workerGeneration: 2, lastProgressAtMs: 2000 };
const input = { status: 'working', workerGeneration: 2, nowMs: 5000, execution };
describe('shared execution observations', () => {
  it('preserves unknown phase while exposing measured waiting and last activity', () => {
    expect(projectExecutionActivity(input)).toMatchObject({ phase: 'unknown', elapsedSeconds: 4, progressAgeSeconds: 3 });
    expect(projectExecutionActivity({ ...input, nowMs: 65000 })).toMatchObject({ phase: 'unknown', elapsedSeconds: 64 });
  });
  it('prefers a real tool-start event over an older capacity banner', () => {
    expect(projectExecutionActivity({ ...input, capacityQueued: true, execution: { ...execution, stage: 'tool_started' } })).toMatchObject({ phase: 'tool', source: 'cli-event' });
    expect(projectExecutionActivity({ ...input, capacityQueued: true })).toMatchObject({ phase: 'model_queue', source: 'capacity-banner' });
  });
  it.each([{ workerGeneration: 3 }, { execution: undefined }, { execution: { ...execution, completed: true } }, { execution: { ...execution, startedAtMs: 6000 } }])('drops unproven timing: %j', override => {
    expect(projectExecutionActivity({ ...input, ...override })).toEqual({ phase: 'unknown', source: 'unavailable', measuredAtMs: 5000 });
  });
  it('does not publish active execution facts after the turn settles', () => {
    expect(projectExecutionActivity({ ...input, status: 'idle' })).toBeUndefined();
  });
  it('validates source/phase consistency and recomputes derived durations', () => {
    expect(normalizeExecutionActivity({ ...projectExecutionActivity(input), elapsedSeconds: 99999 })).toMatchObject({ elapsedSeconds: 4 });
    expect(normalizeExecutionActivity({ phase: 'tool', source: 'capacity-banner', measuredAtMs: 5000, startedAtMs: 1000 })).toBeUndefined();
  });
  it('fences stale capture attempts and shares exact facts with observe', () => {
    const ds = { session: { cliId: 'traex' }, worker: { killed: false }, workerReady: true, workerGeneration: 2,
      currentTurnId: 'turn', captureIdentity: { turnId: 'turn', dispatchAttempt: 1, workerGeneration: 2 },
      replyExecutionStarts: new Map([[JSON.stringify(['turn', 1]), { ...execution, stage: 'tool_started' }]]) } as unknown as DaemonSession;
    const activity = sessionExecutionActivity(ds, 5000)!;
    expect(activity.phase).toBe('tool');
    const row = normalizeSessionRow({ sessionId: 'session', status: 'working', executionActivity: activity }, { observedAt: 5000 });
    expect(row.executionActivity).toEqual(activity);
    ds.turnDispatchAttemptHighWater = { turnId: 'turn', dispatchAttempt: 2 };
    expect(sessionExecutionActivity(ds, 5000)).toMatchObject({ phase: 'unknown', source: 'unavailable' });
  });
  it.each([
    ['idle', { status: 'idle' }], ['limited', { status: 'limited' }], ['stalled', { status: 'stalled' }],
    ['queued', { status: 'working', queued: true }], ['dormant', { status: 'dormant' }], ['closed', { status: 'closed' }],
  ] as const)('a reachable session that is not working (%s) carries no execution facts', (_name, facts) => {
    const activity = projectExecutionActivity(input);
    const row = normalizeSessionRow({ sessionId: 'session', ...facts, executionActivity: activity }, { observedAt: 5000 });
    expect(row.probe.status).toBe('ok');
    expect(row.executionActivity).toBeUndefined();
  });
  it('advances durations to a live render clock without letting a slower viewer clock rewind them', () => {
    const activity = projectExecutionActivity({ ...input, execution: { ...execution, stage: 'tool_started' } });
    expect(normalizeExecutionActivity(activity, 65_000)).toMatchObject({ phase: 'tool', measuredAtMs: 65_000, elapsedSeconds: 64, progressAgeSeconds: 63 });
    expect(normalizeExecutionActivity(activity, 1_000)).toMatchObject({ measuredAtMs: 5000, elapsedSeconds: 4, progressAgeSeconds: 3 });
    expect(normalizeExecutionActivity({ ...activity, lastProgressAtMs: 6000 }, 65_000)).not.toHaveProperty('progressAgeSeconds');
    expect(normalizeExecutionActivity(activity)).toMatchObject({ measuredAtMs: 5000, elapsedSeconds: 4 });
  });
  it('probe failure cannot revive old execution facts', () => {
    const activity = projectExecutionActivity(input);
    expect(normalizeSessionRow({ sessionId: 'session', status: 'working', executionActivity: activity },
      { observedAt: 5000, probe: { status: 'unreachable', source: 'daemon-ipc' } }).executionActivity).toBeUndefined();
  });
});
