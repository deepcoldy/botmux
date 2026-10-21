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

  it('validates a generation-fenced recovered turn on ready', () => {
    const recovered = parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'ready',
      requestId: 'resume-recovery-1',
      state: { version: 1, provider: 'reference', generation: 7 },
      recoveredTurn: {
        turnId: 'turn-survived',
        generation: 7,
        dispatchAttempt: 3,
        startedAtMs: 1234,
        trustedCaller: {
          requestUserOpenId: 'ou_actor',
          requestUserUnionId: 'on_bot',
          requestLarkAppId: 'cli_app',
          senderType: 'bot',
          botOwner: {
            openId: 'ou_owner',
            unionId: 'on_owner',
            email: 'owner@bytedance.com',
            source: 'platform_team',
          },
        },
      },
    }));
    expect(recovered).toMatchObject({
      type: 'ready',
      recoveredTurn: { turnId: 'turn-survived', generation: 7, dispatchAttempt: 3 },
    });
    // botOwner is host-attested on outbound turn commands only. A provider
    // reporting one back during recovery gets the shape validated but the field
    // is stripped — it must never become the recovered turn's caller owner.
    expect(recovered?.recoveredTurn?.trustedCaller).toEqual({
      requestUserOpenId: 'ou_actor',
      requestLarkAppId: 'cli_app',
      senderType: 'bot',
    });
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'ready',
      requestId: 'resume-recovery-bad',
      state: { version: 1, provider: 'reference', generation: 7 },
      recoveredTurn: { turnId: 'turn-survived', generation: -1 },
    }))).toBeUndefined();
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'ready',
      requestId: 'resume-recovery-forged-owner',
      state: { version: 1, provider: 'reference', generation: 7 },
      recoveredTurn: {
        turnId: 'turn-survived',
        generation: 7,
        trustedCaller: {
          requestUserOpenId: 'ou_human',
          requestLarkAppId: 'cli_app',
          senderType: 'user',
          botOwner: {
            openId: 'ou_owner',
            unionId: 'on_owner',
            email: 'owner@bytedance.com',
            source: 'platform_team',
          },
        },
      },
    }))).toBeUndefined();
    // A well-formed bot caller still rejects the whole event when the owner's
    // source tag is not the single host-minted value.
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'ready',
      requestId: 'resume-recovery-forged-owner-source',
      state: { version: 1, provider: 'reference', generation: 7 },
      recoveredTurn: {
        turnId: 'turn-survived',
        generation: 7,
        trustedCaller: {
          requestUserOpenId: 'ou_bot',
          requestLarkAppId: 'cli_app',
          senderType: 'bot',
          botOwner: {
            openId: 'ou_owner',
            unionId: 'on_owner',
            email: 'owner@bytedance.com',
            source: 'provider_self',
          },
        },
      },
    }))).toBeUndefined();
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

  it('accepts only bounded outbound message intents', () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]).toString('base64');
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
      images: [{ name: 'proof.png', mimeType: 'image/png', dataBase64: png }],
    }))).toMatchObject({
      type: 'outbound_message',
      operationId: 'outbound-1',
      generation: 3,
      responseKind: 'progress',
      mention: 'requester',
      images: [{ name: 'proof.png', mimeType: 'image/png', dataBase64: png }],
    });
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-explicit',
      turnId: 'turn-1',
      generation: 3,
      content: 'notify another participant',
      responseKind: 'auxiliary',
      mention: 'explicit',
      mentions: ['ou_target:Target', 'target@example.com:Target by email'],
    }))).toMatchObject({
      type: 'outbound_message',
      mention: 'explicit',
      mentions: ['ou_target:Target', 'target@example.com:Target by email'],
    });
    for (const invalidMention of [
      { mention: 'explicit' },
      { mention: 'explicit', mentions: [] },
      { mention: 'none', mentions: ['ou_target:Target'] },
      { mention: 'requester', mentions: ['ou_target:Target'] },
      { mention: 'explicit', mentions: [42] },
      { mention: 'explicit', mentions: [''] },
      { mention: 'explicit', mentions: ['   '] },
      { mention: 'explicit', mentions: ['ou_target:Target', ''] },
      { mention: 'explicit', mentions: ['ou_target\0Target'] },
      { mention: 'explicit', mentions: ['x'.repeat(33 * 1024)] },
    ]) {
      expect(parseRemoteRunnerEventLine(JSON.stringify({
        protocol: REMOTE_RUNNER_PROTOCOL,
        version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'outbound_message',
        operationId: 'outbound-invalid-mention',
        turnId: 'turn-1',
        generation: 3,
        content: 'invalid mention shape',
        responseKind: 'auxiliary',
        ...invalidMention,
      }))).toBeUndefined();
    }
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-2',
      turnId: 'turn-1',
      generation: 3,
      content: 'final answer',
      responseKind: 'final',
      mention: 'none',
    }))).toMatchObject({
      type: 'outbound_message',
      operationId: 'outbound-2',
      responseKind: 'final',
    });
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
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-4',
      turnId: 'turn-1',
      generation: 3,
      content: 'bad image',
      responseKind: 'auxiliary',
      mention: 'none',
      images: [{ name: 'proof.png', mimeType: 'image/jpeg', dataBase64: png }],
    }))).toBeUndefined();
    for (const image of [
      { name: '截图.png', mimeType: 'image/png', dataBase64: png },
      { name: 'proof.png', mimeType: 'image/png', dataBase64: `${png}\n` },
      { name: 'proof.jpg', mimeType: 'image/png', dataBase64: png },
    ]) {
      expect(parseRemoteRunnerEventLine(JSON.stringify({
        protocol: REMOTE_RUNNER_PROTOCOL,
        version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'outbound_message',
        operationId: 'outbound-image-invalid',
        turnId: 'turn-1',
        generation: 3,
        content: 'bad image',
        responseKind: 'auxiliary',
        mention: 'none',
        images: [image],
      }))).toBeUndefined();
    }
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-too-many-images',
      turnId: 'turn-1',
      generation: 3,
      content: 'too many images',
      responseKind: 'auxiliary',
      mention: 'none',
      images: Array.from({ length: 5 }, (_, index) => ({
        name: `proof-${index}.png`, mimeType: 'image/png', dataBase64: png,
      })),
    }))).toBeUndefined();
    const oneMiBImage = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(1024 * 1024),
    ]).toString('base64');
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-images-too-large',
      turnId: 'turn-1',
      generation: 3,
      content: 'images exceed the aggregate limit',
      responseKind: 'auxiliary',
      mention: 'none',
      images: [0, 1].map(index => ({
        name: `large-${index}.png`, mimeType: 'image/png', dataBase64: oneMiBImage,
      })),
    }))).toBeUndefined();
  });

  it('rejects isolated image magic, duplicate-name, and extra-field violations', () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]).toString('base64');
    const event = (operationId: string, images: unknown[]) => JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId,
      turnId: 'turn-1',
      generation: 3,
      content: 'bad image',
      responseKind: 'auxiliary',
      mention: 'none',
      images,
    });

    expect(parseRemoteRunnerEventLine(event('outbound-magic-mismatch', [
      { name: 'proof.jpg', mimeType: 'image/jpeg', dataBase64: png },
    ]))).toBeUndefined();
    expect(parseRemoteRunnerEventLine(event('outbound-duplicate-image-name', [
      { name: 'proof.png', mimeType: 'image/png', dataBase64: png },
      { name: 'proof.png', mimeType: 'image/png', dataBase64: png },
    ]))).toBeUndefined();
    expect(parseRemoteRunnerEventLine(event('outbound-image-extra-field', [
      { name: 'proof.png', mimeType: 'image/png', dataBase64: png, size: 12 },
    ]))).toBeUndefined();
  });

  it('accepts only the structured session tool surface', () => {
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
      controllerOpenId: 'ou_developer',
      request: {
        tool: 'schedule.add',
        schedule: '10m',
        prompt: '提醒我复查构建',
        name: '--chat-id=oc_other',
        position: 'topic',
        silent: true,
        reasoningEffort: 'high',
      },
    }))).toMatchObject({
      type: 'session_tool',
      controllerOpenId: 'ou_developer',
      request: {
        tool: 'schedule.add',
        schedule: '10m',
        prompt: '提醒我复查构建',
        position: 'topic',
      },
    });
    for (const controllerOpenId of ['ou_', 'ou_bad value', 'developer', 42]) {
      expect(parseRemoteRunnerEventLine(JSON.stringify({
        protocol: REMOTE_RUNNER_PROTOCOL,
        version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'session_tool',
        operationId: 'session-tool-invalid-controller',
        turnId: 'turn-1',
        generation: 3,
        controllerOpenId,
        request: { tool: 'schedule.add', schedule: '10m', prompt: 'x' },
      }))).toBeUndefined();
    }
    expect(parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'session_tool',
      operationId: 'session-tool-4',
      turnId: 'turn-1',
      generation: 3,
      request: { tool: 'history', limit: 101 },
    }))).toBeUndefined();
    for (const request of [
      { tool: 'schedule.list' },
      { tool: 'schedule.update', taskId: 'deadbeef', prompt: '新提示' },
      { tool: 'schedule.remove', taskId: 'deadbeef' },
      { tool: 'schedule.pause', taskId: 'self' },
      { tool: 'schedule.resume', taskId: 'deadbeef' },
      { tool: 'schedule.run', taskId: 'deadbeef' },
    ]) {
      expect(parseRemoteRunnerEventLine(JSON.stringify({
        protocol: REMOTE_RUNNER_PROTOCOL,
        version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'session_tool',
        operationId: `session-tool-${request.tool}`,
        turnId: 'turn-1',
        generation: 3,
        request,
      }))).toMatchObject({ type: 'session_tool', request });
    }
    for (const request of [
      { tool: 'schedule.list', chatId: 'oc_escape' },
      { tool: 'schedule.add', schedule: '10m', prompt: 'x', chatId: 'oc_escape' },
      { tool: 'schedule.add', schedule: '10m', prompt: 'x', workdir: '/tmp' },
      { tool: 'schedule.add', schedule: '10m', prompt: 'x', position: 'topic', topicTitle: 'bad' },
      { tool: 'schedule.add', schedule: '10m', prompt: 'x', position: 'top-level', followActive: true },
      { tool: 'schedule.add', schedule: '10m', prompt: 'x', position: 'new-topic', topicTitle: 'x'.repeat(201) },
      { tool: 'schedule.update', taskId: 'deadbeef' },
      { tool: 'schedule.remove', taskId: 'not-an-id' },
      { tool: 'schedule.resume', taskId: 'self' },
    ]) {
      expect(parseRemoteRunnerEventLine(JSON.stringify({
        protocol: REMOTE_RUNNER_PROTOCOL,
        version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'session_tool',
        operationId: 'session-tool-invalid',
        turnId: 'turn-1',
        generation: 3,
        request,
      }))).toBeUndefined();
    }
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
