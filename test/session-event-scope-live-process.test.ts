/**
 * Which binding a restart receipt names.
 *
 * The program-status relay rebinds in process — spawnCli's binding proves the
 * launcher pid, a second binding proves the real CLI behind it — while every
 * callback armed during spawn (the first-prompt timeout among them) keeps the
 * launcher's binding. Judged under that retired runtime the host never hands
 * the receipt to the restart coordinator, and a receipt is sent once: the
 * `/restart` card sat at 重启超时 for forty seconds while the CLI was already at
 * its prompt (2026-11-23).
 *
 * So for THIS statement — the attempt reached a prompt — the live binding of the
 * same physical CLI outranks the one a callback captured. A callback from a
 * REPLACED process keeps its stale fence. Readiness is deliberately NOT routed
 * this way; see session-contract-gateway.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';

const RESTART_OP = 'restart-operation-1';

function scopeWithRelayRebind() {
  const scope = new WorkerSessionEventScope({ appId: 'app', sessionId: 'session' }, { workerId: 'worker-1', generation: 1 });
  // spawnCli's binding: the launcher pid it proved is already history.
  const launcher = scope.beginRuntime(RESTART_OP, 'cli-process');
  scope.assign(launcher.bindingId, { runtimeId: 'runtime-launcher', epoch: 2 });
  launcher.identity = { backend: 'tmux', physicalId: '100:1', proof: 'process_start' } as never;
  // The relay resolves the real CLI behind the launcher: same physical CLI.
  const live = scope.beginRuntime(RESTART_OP, launcher.physicalId);
  scope.assign(live.bindingId, { runtimeId: 'runtime-real-cli', epoch: 3 });
  return { scope, launcher, live };
}

describe('liveProcessOrigin (restart receipts)', () => {
  it('names the live binding for a callback created under the superseded one', () => {
    const { scope, launcher, live } = scopeWithRelayRebind();
    const origin = scope.run(launcher, () => scope.liveProcessOrigin());
    expect(origin?.bindingId).toBe(live.bindingId);
    expect(origin?.runtime).toEqual({ runtimeId: 'runtime-real-cli', epoch: 3 });
    // The receipt still has to satisfy the host's operationId === attemptId fence.
    expect(origin?.operationId).toBe(RESTART_OP);
  });

  it('names the live binding when the callback carries no binding at all', () => {
    const { scope, live } = scopeWithRelayRebind();
    expect(scope.liveProcessOrigin()?.bindingId).toBe(live.bindingId);
  });

  it('refuses a callback from a replaced process, which keeps its stale fence', () => {
    const scope = new WorkerSessionEventScope({ appId: 'app', sessionId: 'session' }, { workerId: 'worker-1', generation: 1 });
    const replaced = scope.beginRuntime(RESTART_OP, 'cli-process-1');
    scope.assign(replaced.bindingId, { runtimeId: 'runtime-replaced', epoch: 1 });
    const respawned = scope.beginRuntime('restart-operation-2', 'cli-process-2');
    scope.assign(respawned.bindingId, { runtimeId: 'runtime-respawned', epoch: 2 });
    expect(scope.run(replaced, () => scope.liveProcessOrigin())).toBeUndefined();
  });

  it('has nothing to name before the first binding exists', () => {
    const scope = new WorkerSessionEventScope({ appId: 'app', sessionId: 'session' }, { workerId: 'worker-1', generation: 1 });
    expect(scope.liveProcessOrigin()).toBeUndefined();
  });
});

describe('physicalExitOrigin (assigned same-process predecessors)', () => {
  it('uses the newest assigned ancestor across multiple pending same-process rebinds', () => {
    const { scope, launcher, live } = scopeWithRelayRebind();
    scope.beginRuntime(RESTART_OP, live.physicalId);
    const pending = scope.beginRuntime(RESTART_OP, live.physicalId);
    expect(scope.run(launcher, () => scope.physicalExitOrigin())?.runtime).toEqual(live.runtime);
    expect(scope.run(launcher, () => scope.liveProcessOrigin())?.bindingId).toBe(pending.bindingId);
    scope.assign(pending.bindingId, { runtimeId: 'latest-runtime', epoch: 4 });
    expect(scope.run(launcher, () => scope.physicalExitOrigin())?.runtime).toEqual(pending.runtime);
  });

  it('keeps an unassigned first process deferred without borrowing a replaced process', () => {
    const { scope, live } = scopeWithRelayRebind();
    scope.beginRuntime(undefined, 'replacement-process');
    const pending = scope.beginRuntime(undefined, 'replacement-process');
    expect(scope.physicalExitOrigin()).toMatchObject({ bindingId: pending.bindingId });
    expect(scope.physicalExitOrigin()?.runtime).toBeUndefined();
    expect(scope.run(live, () => scope.physicalExitOrigin())).toBeUndefined();
  });

  it('does not revive an abandoned ancestor if its assignment arrives late', () => {
    const { scope, live } = scopeWithRelayRebind();
    const refused = scope.beginRuntime(undefined, live.physicalId);
    scope.beginRuntime(undefined, live.physicalId);
    scope.refuseBinding(refused.bindingId);
    scope.assign(refused.bindingId, { runtimeId: 'late-ack', epoch: 4 });
    expect(scope.physicalExitOrigin()?.runtime).toEqual(live.runtime);
  });
});
