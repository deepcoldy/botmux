import { describe, expect, it } from 'vitest';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { nativeGoalControlView, prepareNativeGoalCommand } from '../src/core/native-goal-control.js';

describe('native agent goal capability', () => {
  it.each(['claude-code', 'codex', 'traex', 'seed', 'relay'] as const)('%s exposes native goal start and status', cliId => {
    const adapter = createCliAdapterSync(cliId, '/bin/sh');
    expect(nativeGoalControlView(adapter, { live: true })).toEqual({ actions: expect.arrayContaining(['start', 'status']) });
    expect(prepareNativeGoalCommand(adapter.nativeGoal, { action: 'start', objective: 'Fix login\nPass tests' }))
      .toEqual({ ok: true, command: '/goal Fix login Pass tests' });
  });
  it('shows only operations declared by the agent', () => {
    const commands = createCliAdapterSync('traex', '/bin/sh').nativeGoal;
    expect(prepareNativeGoalCommand(commands, { action: 'pause' })).toEqual({ ok: true, command: '/goal pause' });
    expect(prepareNativeGoalCommand(createCliAdapterSync('codex', '/bin/sh').nativeGoal, { action: 'pause' }))
      .toEqual({ ok: false, error: 'goal_action_unsupported' });
  });
  it.each([
    [{ live: true, rpc: true }, 'goal_input_unsupported'],
    [{ live: true, remote: true }, 'goal_input_unsupported'],
    [{ live: true, adopted: true }, 'adopt_goal_unsupported'],
    [{ live: false }, 'no_live_worker'],
  ] as const)('refuses unsupported runtime %j', (runtime, blockedReason) => {
    expect(nativeGoalControlView(createCliAdapterSync('traex', '/bin/sh'), runtime)).toMatchObject({ blockedReason });
  });
  it('does not invent goal capability for another agent', () => {
    expect(nativeGoalControlView(createCliAdapterSync('cursor', '/bin/sh'), { live: true }))
      .toEqual({ actions: [], blockedReason: 'goal_unsupported' });
  });
  it.each(['', 'pause', 'resume work', 'clear target', 'edit target', 'run\u001b[31m', 'x'.repeat(16_001)])('rejects invalid or ambiguous objective', objective => {
    expect(prepareNativeGoalCommand({ start: '/goal' }, { action: 'start', objective }).ok).toBe(false);
  });
  it.each(['constructor', '__proto__', 'toString', 'shutdown'])('rejects undeclared action %s', action => {
    expect(prepareNativeGoalCommand({ start: '/goal' }, { action, objective: 'fix tests' }).ok).toBe(false);
  });
});
