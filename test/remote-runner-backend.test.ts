import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteRunnerBackend } from '../src/adapters/backend/remote-runner-backend.js';
import type { RemoteRunnerBackendState } from '../src/adapters/backend/remote-runner-protocol.js';

const referenceRunner = resolve('examples/remote-runner/reference-runner.mjs');
const children: RemoteRunnerBackend[] = [];

function createBackend(initialState?: RemoteRunnerBackendState): RemoteRunnerBackend {
  const backend = new RemoteRunnerBackend({ expectedProvider: 'reference' }, 'session-1', initialState);
  children.push(backend);
  return backend;
}

function spawnBackend(backend: RemoteRunnerBackend): void {
  backend.spawn(process.execPath, [referenceRunner], {
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
    backend.onBackendState(state => states.push(state));
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
      taskId: 'reference-thread:turn-detach',
    });
    backend.commitShutdownDetach();
  });

  it('fails closed when persisted state belongs to another provider', () => {
    expect(() => new RemoteRunnerBackend({ expectedProvider: 'reference' }, 'session-1', {
      version: 1,
      provider: 'other',
      generation: 1,
    })).toThrow(/does not match/);
  });
});
