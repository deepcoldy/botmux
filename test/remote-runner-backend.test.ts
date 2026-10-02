import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRunnerBackend } from '../src/adapters/backend/remote-runner-backend.js';
import type {
  RemoteRunnerBackendState,
  RemoteRunnerUsageReport,
} from '../src/adapters/backend/remote-runner-protocol.js';

const referenceRunner = resolve('examples/remote-runner/reference-runner.mjs');
const stalledCloseRunner = resolve('test/fixtures/remote-runner-stalled-close.mjs');
const stalledReattachRunner = resolve('test/fixtures/remote-runner-stalled-reattach.mjs');
const preAckFailureRunner = resolve('test/fixtures/remote-runner-pre-ack-failure.mjs');
const children: RemoteRunnerBackend[] = [];

function createBackend(initialState?: RemoteRunnerBackendState): RemoteRunnerBackend {
  const backend = new RemoteRunnerBackend({ expectedProvider: 'reference' }, 'session-1', initialState);
  children.push(backend);
  return backend;
}

function spawnBackend(backend: RemoteRunnerBackend, runner = referenceRunner): void {
  backend.spawn(process.execPath, [runner], {
    cwd: process.cwd(),
    cols: 120,
    rows: 40,
    env: { ...process.env } as Record<string, string>,
  });
}

function once<T>(subscribe: (cb: (value: T) => void) => void): Promise<T> {
  return new Promise(resolveValue => subscribe(resolveValue));
}

afterEach(() => {
  for (const backend of children.splice(0)) backend.kill();
});

describe('RemoteRunnerBackend', () => {
  it('handshakes, starts, streams a turn, and publishes provider-neutral state', async () => {
    const backend = createBackend();
    const ready = once<void>(cb => backend.onReady(cb));
    const states: RemoteRunnerBackendState[] = [];
    const progress: string[] = [];
    const usage: RemoteRunnerUsageReport[] = [];
    backend.onBackendState(state => states.push(state));
    backend.onUsageSnapshot(snapshot => usage.push(snapshot));
    backend.onData(data => progress.push(data));
    spawnBackend(backend);
    await ready;

    const final = once<{ text: string; turnId?: string }>(cb => {
      backend.onTurnFinal((text, turnId) => cb({ text, turnId }));
    });
    await expect(backend.submitTurn({
      turnId: 'turn-1',
      content: 'hello',
      trustedCaller: {
        requestUserOpenId: 'ou_test',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
      },
    })).resolves.toEqual({ submitted: true });

    await expect(final).resolves.toEqual({ text: 'hello', turnId: 'turn-1' });
    expect(progress.join('')).toContain('reference: hello');
    expect(states.at(-1)).toMatchObject({
      provider: 'reference',
      generation: 1,
      remoteSessionId: 'reference:session-1',
      agentThreadId: 'reference-thread:turn-1',
    });
    expect(usage).toEqual([expect.objectContaining({
      generation: 1,
      snapshot: expect.objectContaining({
        context: { usedTokens: 11, windowTokens: 1000, percentUsed: 1.1 },
        tokens: { in: 8, out: 3 },
        model: 'reference-model',
      }),
    })]);
  });

  it('projects remote terminal snapshots and forwards input and resize', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'reference',
      requiredCapabilities: [
        'start', 'resume', 'turn', 'cancel', 'detach', 'status',
        'terminal_screen', 'terminal_input', 'terminal_resize',
      ],
    }, 'session-terminal');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const output: string[] = [];
    const snapshots: string[] = [];
    backend.onData(data => output.push(data));
    backend.onScreenResync(snapshot => snapshots.push(snapshot));
    spawnBackend(backend);
    await ready;

    const initialDeadline = Date.now() + 3_000;
    while (!backend.captureCurrentScreen().includes('reference runner ready')
      && Date.now() < initialDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    }
    expect(backend.captureCurrentScreen()).toContain('reference runner ready');
    expect(backend.captureCurrentScreen()).toContain('ready\r\nline two');
    expect(backend.write('typed remotely')).toBe(true);
    backend.resize(132, 48);

    const deadline = Date.now() + 3_000;
    while ((!backend.captureCurrentScreen().includes('typed remotely')
      || backend.getPaneSize()?.cols !== 132) && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    }
    expect(backend.captureCurrentScreen()).toContain('typed remotely');
    expect(backend.getPaneSize()).toEqual({ cols: 132, rows: 48 });
    expect(snapshots).toContain('reference runner ready\r\nline two');
    expect(snapshots.at(-1)).toContain('typed remotely');
    expect(output.join('')).not.toContain('\u001b[2J\u001b[H');
    expect(output.join('')).not.toContain('ready\r\nline two');
  });

  it('resumes an existing state instead of creating a fresh remote lineage', async () => {
    const initialState: RemoteRunnerBackendState = {
      version: 1,
      provider: 'reference',
      generation: 7,
      remoteSessionId: 'reference:old',
      agentThreadId: 'reference-thread:old',
      providerState: { runtimeSubpath: 'sessions/one' },
    };
    const backend = createBackend(initialState);
    const ready = once<void>(cb => backend.onReady(cb));
    spawnBackend(backend);
    await ready;
    expect(backend.getBackendState()).toEqual(initialState);
  });

  it('confirms provider cancellation before reporting a successful close', async () => {
    const backend = createBackend();
    const ready = once<void>(cb => backend.onReady(cb));
    spawnBackend(backend);
    await ready;
    await expect(backend.destroySession()).resolves.toMatchObject({ ok: true });
    backend.commitDestroySession();
  });

  it('drains a completed turn and confirms detach without cancelling state', async () => {
    const backend = createBackend();
    const ready = once<void>(cb => backend.onReady(cb));
    const final = once<{ text: string }>(cb => backend.onTurnFinal(text => cb({ text })));
    spawnBackend(backend);
    await ready;
    await backend.submitTurn({ turnId: 'turn-detach', content: 'keep me' });
    await final;
    await expect(backend.prepareShutdownDetach()).resolves.toMatchObject({
      ok: true,
      taskId: null,
    });
    backend.commitShutdownDetach();
  });

  it('reattaches the provider before restoring admission after an aborted detach', async () => {
    const backend = createBackend();
    const ready = once<void>(cb => backend.onReady(cb));
    spawnBackend(backend);
    await ready;

    await expect(backend.prepareShutdownDetach()).resolves.toMatchObject({ ok: true });
    await expect(backend.abortShutdownDetach()).resolves.toEqual({ ok: true, taskId: null });

    const final = once<{ text: string }>(cb => backend.onTurnFinal(text => cb({ text })));
    await expect(backend.submitTurn({ turnId: 'turn-after-abort', content: 'still live' }))
      .resolves.toEqual({ submitted: true });
    await expect(final).resolves.toEqual({ text: 'still live' });
  });

  it('refuses transactional detach before touching a provider without reattach', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'stalled-close',
      requiredCapabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'status'],
      operationTimeoutMs: 100,
    }, 'session-no-reattach');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    spawnBackend(backend, stalledCloseRunner);
    await ready;

    await expect(backend.prepareShutdownDetach()).resolves.toEqual({
      ok: false,
      taskId: null,
      error: 'remote runner does not support transactional detach',
    });
    await expect(backend.abortShutdownDetach()).resolves.toEqual({ ok: true, taskId: null });
  });

  it('keeps admission fenced when provider reattach is not acknowledged', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'stalled-reattach',
      operationTimeoutMs: 100,
    }, 'session-stalled-reattach');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    spawnBackend(backend, stalledReattachRunner);
    await ready;

    await expect(backend.prepareShutdownDetach()).resolves.toMatchObject({ ok: true });
    await expect(backend.abortShutdownDetach()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('reattach timed out'),
    });
    await expect(backend.submitTurn({ turnId: 'turn-must-stay-fenced', content: 'blocked' }))
      .resolves.toMatchObject({ submitted: false, submissionDisposition: 'untouched' });
  });

  it('fails closed when persisted state belongs to another provider', () => {
    expect(() => new RemoteRunnerBackend({ expectedProvider: 'reference' }, 'session-1', {
      version: 1,
      provider: 'other',
      generation: 1,
    })).toThrow(/does not match/);
  });

  it('keeps admission fenced when cancellation has no confirmed outcome', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'stalled-close',
      requiredCapabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'status'],
      operationTimeoutMs: 100,
    }, 'session-stalled');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    backend.spawn(process.execPath, [stalledCloseRunner], {
      cwd: process.cwd(),
      cols: 120,
      rows: 40,
      env: { ...process.env } as Record<string, string>,
    });
    await ready;

    await expect(backend.destroySession()).resolves.toMatchObject({
      ok: false,
      recovery: 'uncertain',
      admission: 'fenced',
    });
    await expect(backend.abortDestroySession()).resolves.toEqual({
      admissionRestored: false,
      reason: 'remote runner close outcome is not reversible',
    });
  });

  it('classifies a missing turn ACK as ambiguous and retires the provider', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'stalled-close',
      requiredCapabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'status'],
      operationTimeoutMs: 100,
    }, 'session-stalled-turn');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const failure = once<{ status: string; turnId: string }>(cb => {
      backend.onTurnFailure(value => cb(value));
    });
    spawnBackend(backend, stalledCloseRunner);
    await ready;

    await expect(backend.submitTurn({
      turnId: 'turn-stalled',
      content: 'may have crossed the pipe',
    })).resolves.toMatchObject({
      submitted: false,
      submissionDisposition: 'dirty_unknown',
    });
    await expect(failure).resolves.toMatchObject({
      turnId: 'turn-stalled',
      status: 'ambiguous',
    });
  });

  it('correlates a provider failure before the busy ACK and keeps the generation usable', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'pre-ack-failure',
      operationTimeoutMs: 100,
    }, 'session-pre-ack-failure');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const failures: Array<{ turnId: string; code: string; status: string }> = [];
    const order: string[] = [];
    backend.onTurnFailure(failure => {
      failures.push(failure);
      order.push('failure');
    });
    spawnBackend(backend, preAckFailureRunner);
    await ready;

    await expect(backend.submitTurn({ turnId: 'turn-rejected', content: 'reject me' }))
      .resolves.toEqual({ submitted: true });
    order.push('submitted');
    await vi.waitFor(() => expect(failures).toEqual([expect.objectContaining({
      turnId: 'turn-rejected',
      code: 'provider_rejected',
      status: 'failed',
    })]));
    expect(order).toEqual(['submitted', 'failure']);

    const final = once<{ text: string }>(cb => backend.onTurnFinal(text => cb({ text })));
    await expect(backend.submitTurn({ turnId: 'turn-recovered', content: 'continue' }))
      .resolves.toEqual({ submitted: true });
    await expect(final).resolves.toEqual({ text: 'recovered' });
  });
});
