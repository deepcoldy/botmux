import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_RUNNER_CAPABILITIES,
  REMOTE_RUNNER_PROTOCOL,
  REMOTE_RUNNER_PROTOCOL_VERSION,
  encodeRemoteRunnerCommand,
  normalizeRemoteRunnerBackendState,
  parseRemoteRunnerEventLine,
  remoteRunnerCommand,
  type RemoteRunnerEvent,
} from '../src/adapters/backend/remote-runner-protocol.js';

describe('remote runner protocol', () => {
  it('keeps remote compute and native agent lineage as separate state', () => {
    expect(normalizeRemoteRunnerBackendState({
      version: 1,
      provider: 'reference',
      generation: 2,
      remoteSessionId: 'remote-2',
      agentThreadId: 'thread-1',
      providerState: { runtimeSubpath: 'sessions/a' },
    })).toEqual({
      version: 1,
      provider: 'reference',
      generation: 2,
      remoteSessionId: 'remote-2',
      agentThreadId: 'thread-1',
      providerState: { runtimeSubpath: 'sessions/a' },
    });
  });

  it('rejects malformed, oversized, and version-skewed state', () => {
    expect(normalizeRemoteRunnerBackendState({
      version: 1,
      provider: 'reference',
      generation: -1,
    })).toBeUndefined();
    expect(normalizeRemoteRunnerBackendState({
      version: 2,
      provider: 'reference',
      generation: 1,
    })).toBeUndefined();
    expect(normalizeRemoteRunnerBackendState({
      version: 1,
      provider: 'reference',
      generation: 1,
      providerState: { value: 'x'.repeat(70 * 1024) },
    })).toBeUndefined();
  });

  it('parses only the closed event vocabulary', () => {
    const event = parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'hello-1',
      provider: 'reference',
      capabilities: [...REMOTE_RUNNER_CAPABILITIES],
    }));
    expect(event).toMatchObject({ type: 'hello', requestId: 'hello-1', provider: 'reference' });
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'surprise',
    }))).toBeUndefined();
  });

  it('ships a runnable reference provider covering hello/start/turn/status/detach', async () => {
    const child = spawn(process.execPath, [resolve('examples/remote-runner/reference-runner.mjs')], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const events: RemoteRunnerEvent[] = [];
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const event = parseRemoteRunnerEventLine(line);
        if (event) events.push(event);
      }
    });

    const send = (command: Parameters<typeof encodeRemoteRunnerCommand>[0]) => {
      child.stdin.write(encodeRemoteRunnerCommand(command));
    };
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`timed out; events=${JSON.stringify(events)}`);
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      }
    };

    try {
      send(remoteRunnerCommand('hello', {
        requestId: 'hello-1',
        sessionId: 'session-1',
        requiredCapabilities: [...REMOTE_RUNNER_CAPABILITIES],
      }));
      await waitFor(() => events.some(event => event.type === 'hello'));

      send(remoteRunnerCommand('start', {
        requestId: 'start-1',
        sessionId: 'session-1',
        cwd: '/tmp',
      }));
      await waitFor(() => events.some(event => event.type === 'ready'));

      send(remoteRunnerCommand('turn', {
        requestId: 'turn-request-1',
        turnId: 'turn-1',
        content: 'hello',
      }));
      await waitFor(() => events.some(event => event.type === 'final'));
      expect(events.find(event => event.type === 'lineage_changed')).toMatchObject({
        state: {
          remoteSessionId: 'reference:session-1',
        },
      });
      expect(events.find(event => event.type === 'final')).toMatchObject({
        turnId: 'turn-1',
        content: 'hello',
        state: {
          agentThreadId: 'reference-thread:turn-1',
        },
      });

      send(remoteRunnerCommand('status', { requestId: 'status-1' }));
      await waitFor(() => events.some(event => event.type === 'status' && event.requestId === 'status-1'));
      send(remoteRunnerCommand('detach', { requestId: 'detach-1' }));
      await waitFor(() => events.some(event => event.type === 'status' && event.status === 'detached'));
    } finally {
      child.kill('SIGTERM');
    }
  });
});
