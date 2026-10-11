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
    expect(normalizeRemoteRunnerBackendState({
      version: 1,
      provider: 'reference',
      generation: 1,
      providerState: { nested: { accessToken: 'must-not-persist' } },
    })).toBeUndefined();
  });

  it('keeps event types closed while accepting additive provider capabilities', () => {
    const event = parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'hello-1',
      provider: 'reference',
      capabilities: [...REMOTE_RUNNER_CAPABILITIES, 'provider_future_feature'],
    }));
    expect(event).toMatchObject({ type: 'hello', requestId: 'hello-1', provider: 'reference' });
    expect(event?.type === 'hello' ? event.capabilities : []).toContain('provider_future_feature');
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'hello-invalid-capability',
      provider: 'reference',
      capabilities: ['start', 'INVALID CAPABILITY'],
    }))).toBeUndefined();
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'ready',
      state: { version: 1, provider: 'reference', generation: 1 },
    }))).toBeUndefined();
    const preAckFailure = parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'failure',
      requestId: 'turn-request-1',
      code: 'provider_rejected',
      message: 'rejected before busy acknowledgement',
      status: 'failed',
      retryable: true,
    }));
    expect(preAckFailure).toMatchObject({
      type: 'failure',
      requestId: 'turn-request-1',
    });
    expect(preAckFailure).not.toHaveProperty('turnId');
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'surprise',
    }))).toBeUndefined();
  });

  it('carries an explicit rebuild intent on closed-session resume', () => {
    expect(remoteRunnerCommand('resume', {
      requestId: 'resume-1',
      sessionId: 'session-1',
      cwd: '/tmp/work',
      state: { version: 1, provider: 'reference', generation: 7 },
      resumeMode: 'rebuild',
    })).toMatchObject({
      type: 'resume',
      requestId: 'resume-1',
      resumeMode: 'rebuild',
      state: { generation: 7 },
    });
  });

  it('validates generation-fenced terminal screen snapshots', () => {
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'terminal_screen',
      generation: 2,
      sequence: 7,
      cols: 120,
      rows: 40,
      snapshot: '\u001b[32mremote tmux\u001b[0m',
    }))).toMatchObject({
      type: 'terminal_screen',
      generation: 2,
      sequence: 7,
      cols: 120,
      rows: 40,
    });
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'terminal_screen',
      generation: 2,
      sequence: -1,
      cols: 120,
      rows: 40,
      snapshot: 'invalid',
    }))).toBeUndefined();
  });

  it('accepts only bounded non-terminal outbound message intents', () => {
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-1',
      turnId: 'turn-1',
      generation: 3,
      content: 'still working',
      responseKind: 'progress',
      mention: 'requester',
    }))).toMatchObject({
      type: 'outbound_message',
      operationId: 'outbound-1',
      generation: 3,
      responseKind: 'progress',
      mention: 'requester',
    });
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-2',
      turnId: 'turn-1',
      generation: 3,
      content: 'not allowed',
      responseKind: 'final',
      mention: 'none',
    }))).toBeUndefined();
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-3',
      turnId: 'turn-1',
      generation: 3,
      content: 'x'.repeat(33 * 1024),
      responseKind: 'auxiliary',
      mention: 'none',
    }))).toBeUndefined();
  });

  it('accepts only structured, read-only session tool requests', () => {
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'session_tool',
      operationId: 'session-tool-1',
      turnId: 'turn-1',
      generation: 3,
      request: {
        tool: 'history',
        limit: 20,
        scope: 'thread',
        withCardJson: true,
      },
    }))).toMatchObject({
      type: 'session_tool',
      operationId: 'session-tool-1',
      request: { tool: 'history', limit: 20, scope: 'thread', withCardJson: true },
    });
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'session_tool',
      operationId: 'session-tool-2',
      turnId: 'turn-1',
      generation: 3,
      request: { tool: 'skill.read', name: 'demo', path: '../secret' },
    }))).toBeUndefined();
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'session_tool',
      operationId: 'session-tool-3',
      turnId: 'turn-1',
      generation: 3,
      request: { tool: 'schedule.add', prompt: 'not read only' },
    }))).toBeUndefined();
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'session_tool',
      operationId: 'session-tool-4',
      turnId: 'turn-1',
      generation: 3,
      request: { tool: 'history', limit: 101 },
    }))).toBeUndefined();
  });

  it('accepts authoritative usage on final and rejects malformed metrics', () => {
    const base = {
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'final',
      turnId: 'turn-usage',
      content: 'done',
    } as const;
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      ...base,
      usage: {
        generation: 3,
        snapshot: {
          context: { usedTokens: 7274, windowTokens: 258400, percentUsed: 2.815 },
          tokens: { in: 7230, out: 44 },
          turnTokens: { in: 7230, out: 44 },
          model: 'GPT-5.4',
          reasoningEffort: 'high',
        },
      },
    }))).toMatchObject({
      type: 'final',
      usage: {
        generation: 3,
        snapshot: {
          context: { usedTokens: 7274, windowTokens: 258400 },
          tokens: { in: 7230, out: 44 },
          model: 'GPT-5.4',
        },
      },
    });
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      ...base,
      usage: {
        generation: 3,
        snapshot: { context: { usedTokens: -1 }, tokens: null },
      },
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
        usage: {
          generation: 1,
          snapshot: { model: 'reference-model' },
        },
      });

      send(remoteRunnerCommand('status', { requestId: 'status-1' }));
      await waitFor(() => events.some(event => event.type === 'status' && event.requestId === 'status-1'));
      send(remoteRunnerCommand('detach', { requestId: 'detach-1' }));
      await waitFor(() => events.some(event => event.type === 'status' && event.status === 'detached'));
      send(remoteRunnerCommand('reattach', { requestId: 'reattach-1' }));
      await waitFor(() => events.some(event => event.type === 'status'
        && event.requestId === 'reattach-1'
        && event.status === 'ready'));
    } finally {
      child.kill('SIGTERM');
    }
  });
});
