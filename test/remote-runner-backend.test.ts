import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRunnerBackend } from '../src/adapters/backend/remote-runner-backend.js';
import type {
  RemoteRunnerBackendState,
  RemoteRunnerUsageReport,
} from '../src/adapters/backend/remote-runner-protocol.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';

const referenceRunner = resolve('examples/remote-runner/reference-runner.mjs');
const stalledCloseRunner = resolve('test/fixtures/remote-runner-stalled-close.mjs');
const stalledReattachRunner = resolve('test/fixtures/remote-runner-stalled-reattach.mjs');
const preAckFailureRunner = resolve('test/fixtures/remote-runner-pre-ack-failure.mjs');
const outboundRunner = resolve('test/fixtures/remote-runner-outbound.mjs');
const delayedTurnRunner = resolve('test/fixtures/remote-runner-delayed-turn.mjs');
const reviewCasesRunner = resolve('test/fixtures/remote-runner-review-cases.mjs');
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

  it('returns a host-governed result for provider-requested outbound messages', async () => {
    const backend = createBackend();
    const ready = once<void>(cb => backend.onReady(cb));
    const requested: Array<{ operationId: string; content: string }> = [];
    backend.onOutboundMessage(async message => {
      requested.push({ operationId: message.operationId, content: message.content });
      return { outcome: 'delivered', messageId: 'om_reference_progress' };
    });
    spawnBackend(backend);
    await ready;

    const final = once<{ text: string; turnId?: string }>(cb => {
      backend.onTurnFinal((text, turnId) => cb({ text, turnId }));
    });
    await expect(backend.submitTurn({
      turnId: 'turn-outbound',
      content: 'request-outbound',
    })).resolves.toEqual({ submitted: true });

    await expect(final).resolves.toEqual({
      text: JSON.stringify({ outcome: 'delivered', messageId: 'om_reference_progress' }),
      turnId: 'turn-outbound',
    });
    expect(requested).toEqual([{
      operationId: 'reference-outbound-1',
      content: 'reference progress',
    }]);
  });

  it('deduplicates one outbound operation id and rejects payload conflicts', async () => {
    const backend = new RemoteRunnerBackend({ expectedProvider: 'outbound-test' }, 'session-outbound-dedupe');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const delivery = vi.fn(async () => ({
      outcome: 'delivered' as const,
      messageId: 'om_deduped',
    }));
    backend.onOutboundMessage(delivery);
    spawnBackend(backend, outboundRunner);
    await ready;

    const duplicateFinal = once<string>(cb => backend.onTurnFinal(cb));
    await backend.submitTurn({ turnId: 'turn-duplicate', content: 'duplicate' });
    const duplicateResults = JSON.parse(await duplicateFinal) as Array<{ result: { outcome: string } }>;
    expect(duplicateResults.map(item => item.result.outcome)).toEqual(['delivered', 'delivered']);
    expect(delivery).toHaveBeenCalledTimes(1);

    const conflictFinal = once<string>(cb => backend.onTurnFinal(cb));
    await backend.submitTurn({ turnId: 'turn-conflict', content: 'conflict' });
    const conflictResults = JSON.parse(await conflictFinal) as Array<{ result: { outcome: string; code?: string } }>;
    expect(conflictResults.map(item => item.result.outcome).sort()).toEqual(['delivered', 'rejected']);
    expect(conflictResults).toContainEqual(expect.objectContaining({
      result: expect.objectContaining({ code: 'operation_id_conflict' }),
    }));
    expect(delivery).toHaveBeenCalledTimes(2);
  });

  it('limits unique outbound messages per turn before invoking the host', async () => {
    const backend = new RemoteRunnerBackend({ expectedProvider: 'outbound-test' }, 'session-outbound-rate');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const delivery = vi.fn(async message => ({
      outcome: 'delivered' as const,
      messageId: `om_${message.operationId}`,
    }));
    backend.onOutboundMessage(delivery);
    spawnBackend(backend, outboundRunner);
    await ready;

    const final = once<string>(cb => backend.onTurnFinal(cb));
    await backend.submitTurn({ turnId: 'turn-rate', content: 'rate' });
    const results = JSON.parse(await final) as Array<{ result: { outcome: string; code?: string } }>;
    expect(delivery).toHaveBeenCalledTimes(10);
    expect(results.filter(item => item.result.outcome === 'delivered')).toHaveLength(10);
    expect(results).toContainEqual(expect.objectContaining({
      result: expect.objectContaining({ outcome: 'rejected', code: 'outbound_rate_limited' }),
    }));
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

  it('normalizes provider progress newlines to PTY CRLF across event boundaries', async () => {
    const backend = new RemoteRunnerBackend(
      { expectedProvider: 'review-cases' },
      'session-progress-newlines',
    );
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const output: string[] = [];
    backend.onData(data => output.push(data));
    spawnBackend(backend, reviewCasesRunner);
    await ready;

    const final = once<string>(cb => backend.onTurnFinal(cb));
    await expect(backend.submitTurn({
      turnId: 'turn-progress-newlines',
      content: 'progress-newlines',
    })).resolves.toEqual({ submitted: true });
    await expect(final).resolves.toBe('done');

    expect(output).toEqual([
      'line one\r\nline two\r\nline three\r',
      '\nline four',
    ]);
    expect(output.join('')).toBe('line one\r\nline two\r\nline three\r\nline four');
    expect(backend.captureCurrentScreen()).toBe(output.join(''));

    const renderer = new TerminalRenderer(80, 10);
    try {
      await renderer.writeAndFlush(output.join(''));
      expect(renderer.rawSnapshot({ preserveFormatting: true }))
        .toBe('line one\nline two\nline three\nline four');
    } finally {
      renderer.dispose();
    }
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

  it('requires an explicit closed-session rebuild to advance the remote generation', async () => {
    const initialState: RemoteRunnerBackendState = {
      version: 1,
      provider: 'reference',
      generation: 7,
      remoteSessionId: 'reference:cancelled',
      agentThreadId: 'reference-thread:old',
    };
    const backend = createBackend(initialState);
    const ready = once<void>(cb => backend.onReady(cb));
    backend.spawn(process.execPath, [referenceRunner], {
      cwd: process.cwd(),
      cols: 120,
      rows: 40,
      env: { ...process.env } as Record<string, string>,
      remoteResumeMode: 'rebuild',
    });
    await ready;

    expect(backend.getBackendState()).toMatchObject({
      generation: 8,
      remoteSessionId: 'reference:session-1:generation-8',
      agentThreadId: 'reference-thread:old',
    });
  });

  it('fails closed when a rebuild provider reports the cancelled generation as ready', async () => {
    const initialState: RemoteRunnerBackendState = {
      version: 1,
      provider: 'review-cases',
      generation: 7,
      remoteSessionId: 'review-cases:cancelled',
    };
    const backend = new RemoteRunnerBackend({ expectedProvider: 'review-cases' }, 'session-stale-rebuild', initialState);
    children.push(backend);
    const exited = once<void>(cb => backend.onExit(() => cb()));
    backend.spawn(process.execPath, [reviewCasesRunner], {
      cwd: process.cwd(),
      cols: 120,
      rows: 40,
      env: { ...process.env } as Record<string, string>,
      remoteResumeMode: 'rebuild',
    });

    await exited;
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

  it('lets the shutdown drain deadline outlive the ordinary operation timeout', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'delayed-turn',
      operationTimeoutMs: 100,
    }, 'session-delayed-turn');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    spawnBackend(backend, delayedTurnRunner);
    await ready;

    await expect(backend.submitTurn({ turnId: 'turn-delayed', content: 'wait' }))
      .resolves.toEqual({ submitted: true });
    await expect(backend.prepareShutdownDetach(1_000)).resolves.toEqual({
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

  it.each(['post-ack-failure-both', 'post-ack-failure-turn'])(
    'delivers an acknowledged %s as the provider terminal failure',
    async content => {
      const backend = new RemoteRunnerBackend({ expectedProvider: 'review-cases' }, `session-${content}`);
      children.push(backend);
      const ready = once<void>(cb => backend.onReady(cb));
      const failures: Array<{ turnId: string; code: string }> = [];
      backend.onTurnFailure(failure => failures.push(failure));
      spawnBackend(backend, reviewCasesRunner);
      await ready;

      await expect(backend.submitTurn({ turnId: `turn-${content}`, content }))
        .resolves.toEqual({ submitted: true });
      await vi.waitFor(() => expect(failures).toEqual([expect.objectContaining({
        turnId: `turn-${content}`,
        code: 'provider_failed',
      })]));
    },
  );

  it('rejects a post-ACK failure that omits turnId', async () => {
    const backend = new RemoteRunnerBackend({ expectedProvider: 'review-cases' }, 'session-request-only');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const failures: Array<{ code: string }> = [];
    backend.onTurnFailure(failure => failures.push(failure));
    spawnBackend(backend, reviewCasesRunner);
    await ready;

    await expect(backend.submitTurn({ turnId: 'turn-request-only', content: 'post-ack-failure-request' }))
      .resolves.toEqual({ submitted: true });
    await vi.waitFor(() => expect(failures).toEqual([expect.objectContaining({
      code: 'remote_runner_protocol_error',
    })]));
  });

  it.each(['pre-busy-progress', 'pre-busy-outbound', 'pre-busy-final'])(
    'fails closed on %s before the provider accepts the turn',
    async content => {
      const backend = new RemoteRunnerBackend({ expectedProvider: 'review-cases' }, `session-${content}`);
      children.push(backend);
      const ready = once<void>(cb => backend.onReady(cb));
      const progress: string[] = [];
      const outbound = vi.fn(async () => ({ outcome: 'delivered' as const, messageId: 'om_too_early' }));
      const failures: Array<{ code: string }> = [];
      backend.onData(value => progress.push(value));
      backend.onOutboundMessage(outbound);
      backend.onTurnFailure(failure => failures.push(failure));
      spawnBackend(backend, reviewCasesRunner);
      await ready;

      await expect(backend.submitTurn({ turnId: `turn-${content}`, content }))
        .resolves.toMatchObject({ submitted: false, submissionDisposition: 'dirty_unknown' });
      await vi.waitFor(() => expect(failures).toEqual([expect.objectContaining({
        code: 'remote_runner_protocol_error',
      })]));
      expect(progress).toEqual([]);
      expect(outbound).not.toHaveBeenCalled();
    },
  );

  it('fences duplicate, stale, and future terminal snapshots', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'review-cases',
      requiredCapabilities: [
        'start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status', 'terminal_screen',
      ],
    }, 'session-screen-fences');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const failures: Array<{ code: string }> = [];
    backend.onTurnFailure(failure => failures.push(failure));
    spawnBackend(backend, reviewCasesRunner);
    await ready;

    let final = once<string>(cb => backend.onTurnFinal(cb));
    await backend.submitTurn({ turnId: 'turn-sequence', content: 'screen-sequence' });
    await final;
    expect(backend.captureCurrentScreen()).toBe('fresh');

    final = once<string>(cb => backend.onTurnFinal(cb));
    await backend.submitTurn({ turnId: 'turn-stale', content: 'screen-stale-generation' });
    await final;
    expect(backend.captureCurrentScreen()).toBe('fresh');

    await backend.submitTurn({ turnId: 'turn-future', content: 'screen-future-generation' });
    await vi.waitFor(() => expect(failures).toEqual([expect.objectContaining({
      code: 'remote_runner_protocol_error',
    })]));
  });

  it('fails closed when final usage belongs to a future generation', async () => {
    const backend = new RemoteRunnerBackend({ expectedProvider: 'review-cases' }, 'session-usage-fence');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const usage: RemoteRunnerUsageReport[] = [];
    const failures: Array<{ code: string }> = [];
    backend.onUsageSnapshot(value => usage.push(value));
    backend.onTurnFailure(failure => failures.push(failure));
    spawnBackend(backend, reviewCasesRunner);
    await ready;

    await backend.submitTurn({ turnId: 'turn-usage', content: 'usage-future-generation' });
    await vi.waitFor(() => expect(failures).toEqual([expect.objectContaining({
      code: 'remote_runner_protocol_error',
    })]));
    expect(usage).toEqual([]);
  });

  it.each([
    ['session-no-outbound', 'unadvertised-outbound'],
    ['session-outbound-generation', 'outbound-future-generation'],
    ['session-final-before-result', 'final-before-result'],
  ])('fails closed for outbound protocol guard %s', async (sessionId, content) => {
    const backend = new RemoteRunnerBackend({ expectedProvider: 'review-cases' }, sessionId);
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const failures: Array<{ code: string }> = [];
    const delivery = vi.fn(() => new Promise<never>(() => {}));
    backend.onTurnFailure(failure => failures.push(failure));
    backend.onOutboundMessage(delivery);
    spawnBackend(backend, reviewCasesRunner);
    await ready;

    await backend.submitTurn({ turnId: `turn-${content}`, content });
    await vi.waitFor(() => expect(failures).toEqual([expect.objectContaining({
      code: 'remote_runner_protocol_error',
    })]));
    if (content !== 'final-before-result') expect(delivery).not.toHaveBeenCalled();
  });

  it('keeps outbound result accounting scoped to its originating turn', async () => {
    const backend = new RemoteRunnerBackend({ expectedProvider: 'review-cases' }, 'session-cross-turn');
    children.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const resolvers = new Map<string, (value: { outcome: 'delivered'; messageId: string }) => void>();
    const failures: Array<{ turnId: string; code: string }> = [];
    const finals: string[] = [];
    backend.onOutboundMessage(message => new Promise(resolveValue => {
      resolvers.set(message.operationId, resolveValue);
    }));
    backend.onTurnFailure(failure => failures.push(failure));
    backend.onTurnFinal(text => finals.push(text));
    spawnBackend(backend, reviewCasesRunner);
    await ready;

    await backend.submitTurn({ turnId: 'turn-old', content: 'cross-turn-one' });
    await vi.waitFor(() => expect(failures).toContainEqual(expect.objectContaining({ code: 'first_failed' })));
    await backend.submitTurn({ turnId: 'turn-new', content: 'cross-turn-two' });
    await vi.waitFor(() => expect(resolvers.has('new-operation')).toBe(true));
    resolvers.get('old-operation')?.({ outcome: 'delivered', messageId: 'om_old' });

    await vi.waitFor(() => expect(failures).toContainEqual(expect.objectContaining({
      turnId: 'turn-new',
      code: 'remote_runner_protocol_error',
    })));
    expect(finals).toEqual([]);
  });
});
