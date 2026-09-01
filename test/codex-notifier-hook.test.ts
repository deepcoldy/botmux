import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'bun:test';
import {
  codexNotifierEventId,
  detectScreenLock,
  parseCodexTurnContext,
  parseMacScreenLock,
  processCodexNotifierHookPayload,
  readCodexTurnContext,
  runCodexNotifierHookCli,
  shouldNotifyForLockState,
} from '../src/features/codex-notifier/index.js';

function stopPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'Stop',
    session_id: 'thread-1',
    turn_id: 'turn-1',
    cwd: '/workspace/project',
    transcript_path: '/tmp/rollout.jsonl',
    last_assistant_message: 'Hook 返回的完整最终回复',
    ...overrides,
  };
}

function userPromptPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'thread-1',
    turn_id: 'turn-1',
    cwd: '/workspace/project',
    transcript_path: '/tmp/rollout.jsonl',
    prompt: '修复通知链路',
    ...overrides,
  };
}

const enabledConfig = {
  enabled: true,
  targetBotAppId: 'cli_target',
  notifyWhen: 'locked_only' as const,
};

describe('Codex turn context', () => {
  it('extracts only the requested turn prompt and final response', () => {
    const text = [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-old' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: '旧任务', client_id: 'old-client' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      }),
      '{broken-json',
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '  修复通知\n链路  ',
          client_id: 'codex-app',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: '最终回复',
        },
      }),
    ].join('\n');

    expect(parseCodexTurnContext(text, 'turn-1')).toEqual({
      prompt: '修复通知 链路',
      lastAssistantMessage: '最终回复',
    });
  });

  it('does not leak context from a different turn', () => {
    const text = [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-2' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: '另一个任务', client_id: 'another-client' },
      }),
    ].join('\n');

    expect(parseCodexTurnContext(text, 'turn-1')).toEqual({});
  });

  it.each([
    ['vscode', 'Codex Desktop', 'codex-app'],
    ['exec', 'Codex Desktop', 'codex-cli'],
    ['cli', 'codex-tui', 'codex-cli'],
  ] as const)('maps session source %s to %s', (source, originator, clientSurface) => {
    const text = JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: 'thread-1',
        id: 'thread-1',
        source,
        originator,
      },
    });

    expect(parseCodexTurnContext(text, 'turn-1', 'thread-1')).toEqual({ clientSurface });
    expect(parseCodexTurnContext(text, 'turn-1', 'another-thread')).toEqual({});
  });

  it('fails closed for a mismatched App originator or conflicting session identities', () => {
    const metadata = (overrides: Record<string, unknown>) => JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: 'thread-1',
        id: 'thread-1',
        source: 'vscode',
        originator: 'Codex Desktop',
        ...overrides,
      },
    });

    expect(parseCodexTurnContext(
      metadata({ originator: 'unknown-client' }),
      'turn-1',
      'thread-1',
    )).toEqual({});
    expect(parseCodexTurnContext(
      metadata({ id: 'another-thread' }),
      'turn-1',
      'thread-1',
    )).toEqual({});
  });

  it('marks Codex internal and subagent session sources as internal', () => {
    const transcript = (source: unknown) => JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: 'thread-1',
        id: 'thread-1',
        source,
      },
    });

    expect(parseCodexTurnContext(
      transcript({ internal: 'memory_writing' }),
      'turn-1',
      'thread-1',
    )).toEqual({ internal: true });
    expect(parseCodexTurnContext(
      transcript({ subagent: { other: 'guardian' } }),
      'turn-1',
      'thread-1',
    )).toEqual({ internal: true });
  });

  it('recognizes an internal prompt before truncating its display title', () => {
    const titlePrompt = [
      'You are a helpful assistant. You will be presented with a user prompt,',
      'and your job is to provide a short title for a task that will be created from that prompt.',
      'User prompt:',
      '历史任务',
    ].join(' ');
    const text = [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: titlePrompt },
      }),
    ].join('\n');

    expect(parseCodexTurnContext(text, 'turn-1')).toMatchObject({
      internal: true,
    });
  });

  it('does not trust session metadata appended after the first transcript record', () => {
    const text = [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      }),
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: 'thread-1',
          id: 'thread-1',
          source: 'vscode',
          originator: 'Codex Desktop',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: '当前任务' },
      }),
    ].join('\n');

    expect(parseCodexTurnContext(text, 'turn-1', 'thread-1')).toEqual({
      prompt: '当前任务',
    });
  });

  it('reads app provenance from the bounded head of a transcript larger than the tail window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-context-'));
    const file = join(dir, 'rollout.jsonl');
    const threadId = '019f8d92-df7c-7572-83ca-b1e99f20204c';
    try {
      writeFileSync(file, [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            session_id: threadId,
            id: threadId,
            source: 'vscode',
            originator: 'Codex Desktop',
          },
        }),
        JSON.stringify({ type: 'response_item', payload: 'x'.repeat(4 * 1024 * 1024 + 1024) }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-1' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: '大文件中的当前任务' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '完成' },
        }),
      ].join('\n'));

      expect(readCodexTurnContext(file, 'turn-1', threadId)).toEqual({
        clientSurface: 'codex-app',
        prompt: '大文件中的当前任务',
        lastAssistantMessage: '完成',
      });
      expect(readCodexTurnContext(file, 'turn-1', 'another-thread')).toEqual({
        prompt: '大文件中的当前任务',
        lastAssistantMessage: '完成',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a complete task_started record at the exact tail boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-context-boundary-'));
    const file = join(dir, 'rollout.jsonl');
    const taskStarted = `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    })}\n`;
    const suffix = [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: '边界任务' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '完成' },
      }),
    ].join('\n');
    const tailPrefix = `${taskStarted}${suffix}\n`;
    const tailPadding = 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(tailPrefix));
    try {
      writeFileSync(file, `ignored\n${tailPrefix}${tailPadding}`);

      expect(readCodexTurnContext(file, 'turn-1')).toEqual({
        prompt: '边界任务',
        lastAssistantMessage: '完成',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Codex screen lock detection', () => {
  it.each([
    ['"IOConsoleLocked" = Yes', 'locked'],
    ['"CGSSessionScreenIsLocked" = true', 'locked'],
    ['"IOConsoleLocked" = No', 'unlocked'],
    ['"CGSSessionScreenIsLocked" = false', 'unlocked'],
    ['"IOConsoleUsers" = ({"kCGSSessionUserNameKey"="tester"})', 'unlocked'],
    ['unrelated output', 'unknown'],
  ] as const)('parses %s as %s', (output, expected) => {
    expect(parseMacScreenLock(output)).toBe(expected);
  });

  it('returns unsupported outside macOS without spawning ioreg', () => {
    const execFile = vi.fn();
    expect(detectScreenLock({
      platform: 'linux',
      execFile: execFile as never,
    })).toBe('unsupported');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('prefers the root IOConsoleLocked value when nested sessions conflict', () => {
    expect(parseMacScreenLock([
      '"IOConsoleLocked" = No',
      '"IOConsoleUsers" = ({"CGSSessionScreenIsLocked"=Yes})',
    ].join('\n'))).toBe('unlocked');
  });

  it('maps ioreg failures to unknown', () => {
    const execFile = vi.fn(() => {
      throw new Error('ioreg failed');
    });
    expect(detectScreenLock({
      platform: 'darwin',
      execFile: execFile as never,
    })).toBe('unknown');
  });

  it('fails open only for an unknown macOS lock state', () => {
    expect(shouldNotifyForLockState('locked_only', 'locked')).toBe(true);
    expect(shouldNotifyForLockState('locked_only', 'unknown')).toBe(true);
    expect(shouldNotifyForLockState('locked_only', 'unlocked')).toBe(false);
    expect(shouldNotifyForLockState('locked_only', 'unsupported')).toBe(false);
    expect(shouldNotifyForLockState('always', 'unlocked')).toBe(true);
    expect(shouldNotifyForLockState('always', 'unsupported')).toBe(true);
  });
});

describe('Codex notifier Stop Hook', () => {
  it('tracks UserPromptSubmit and uses the exact turn proof when Stop has no transcript', () => {
    const confirmTurn = vi.fn(() => ({
      sessionId: 'thread-1',
      turnId: 'turn-1',
      prompt: '修复通知链路',
    }));
    expect(processCodexNotifierHookPayload(userPromptPayload(), {
      env: {},
      config: { ...enabledConfig, notifyWhen: 'always' },
      readContext: () => ({}),
      confirmTurn,
    })).toBe('tracked');
    expect(confirmTurn).toHaveBeenCalledWith(
      expect.any(String),
      'thread-1',
      'turn-1',
      '修复通知链路',
    );

    const enqueue = vi.fn();
    const removeConfirmedTurn = vi.fn();
    expect(processCodexNotifierHookPayload(stopPayload(), {
      env: {},
      dataDir: '/tmp/botmux-data',
      config: { ...enabledConfig, notifyWhen: 'always' },
      lockState: 'unlocked',
      readContext: () => ({}),
      readConfirmedTurn: () => ({
        sessionId: 'thread-1',
        turnId: 'turn-1',
        prompt: '修复通知链路',
      }),
      removeConfirmedTurn,
      enqueue,
    })).toBe('enqueued');
    expect(enqueue.mock.calls[0][2]).toMatchObject({ title: '修复通知链路' });
    expect(removeConfirmedTurn).toHaveBeenCalledWith('/tmp/botmux-data', 'thread-1', 'turn-1');
  });

  it('rejects a subagent UserPromptSubmit before persisting a turn proof', () => {
    const confirmTurn = vi.fn();
    expect(processCodexNotifierHookPayload(userPromptPayload({
      agent_id: 'subagent-1',
    }), {
      env: {},
      config: { ...enabledConfig, notifyWhen: 'always' },
      readContext: () => ({ prompt: '子代理内部问题' }),
      confirmTurn,
    })).toBe('subagent');
    expect(confirmTurn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'title generator',
      'You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.',
    ],
    [
      'approval reviewer',
      'The following is the Codex agent history added since your last approval assessment. Continue the same review conversation.',
    ],
    [
      'memory writer',
      '## Memory Writing Agent: update the durable memory',
    ],
    [
      'summary generator',
      'You are writing a short summary of a final assistant message for display.',
    ],
  ])('does not confirm the %s UserPromptSubmit turn', (_label, prompt) => {
    const confirmTurn = vi.fn();
    expect(processCodexNotifierHookPayload(userPromptPayload({ prompt }), {
      env: {},
      config: { ...enabledConfig, notifyWhen: 'always' },
      readContext: () => ({}),
      confirmTurn,
    })).toBe('internal');
    expect(confirmTurn).not.toHaveBeenCalled();
  });

  it('drops an unconfirmed Stop even when its JSON resembles a historical task result', () => {
    const enqueue = vi.fn();
    expect(processCodexNotifierHookPayload(stopPayload({
      last_assistant_message: '{"description":"盛夏内推季 有奖竞答 完整答题 参与抽奖 B. 4000 元"}',
    }), {
      env: {},
      config: { ...enabledConfig, notifyWhen: 'always' },
      lockState: 'unlocked',
      readContext: () => ({}),
      readConfirmedTurn: () => undefined,
      enqueue,
    })).toBe('internal');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues a stable event whose title contains only the native prompt', () => {
    const enqueue = vi.fn();
    const readContext = vi.fn(() => ({
      clientSurface: 'codex-app' as const,
      prompt: '修复通知链路',
      lastAssistantMessage: 'Transcript 兜底回复',
    }));
    const payload = stopPayload();
    const outcome = processCodexNotifierHookPayload(payload, {
      env: {},
      dataDir: '/tmp/botmux-data',
      config: enabledConfig,
      lockState: 'locked',
      readContext,
      enqueue,
    });

    expect(outcome).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [dataDir, targetBotAppId, event] = enqueue.mock.calls[0];
    expect(dataDir).toBe('/tmp/botmux-data');
    expect(targetBotAppId).toBe('cli_target');
    expect(event).toMatchObject({
      source: 'codex-desktop',
      clientSurface: 'codex-app',
      threadId: 'thread-1',
      nativeTurnId: 'turn-1',
      title: '修复通知链路',
      cwd: '/workspace/project',
      finalPreview: 'Hook 返回的完整最终回复',
    });
    expect(event.title).not.toContain('project');
    expect(readContext).toHaveBeenCalledWith('/tmp/rollout.jsonl', 'turn-1', 'thread-1');
    expect(event.eventId).toBe(codexNotifierEventId({
      source: 'codex-desktop',
      threadId: 'thread-1',
      nativeTurnId: 'turn-1',
      status: 'completed',
    }));
  });

  it.each([
    [
      'disabled',
      { config: { ...enabledConfig, enabled: false } },
    ],
    [
      'misconfigured',
      { config: { ...enabledConfig, targetBotAppId: undefined } },
    ],
    [
      'managed',
      { env: { BOTMUX_SESSION_ID: 'managed-session' } },
    ],
    [
      'screen_unlocked',
      { lockState: 'unlocked' },
    ],
    [
      'platform_unsupported',
      { lockState: 'unsupported' },
    ],
  ] as const)('returns %s without enqueuing', (expected, custom) => {
    const enqueue = vi.fn();
    expect(processCodexNotifierHookPayload(
      stopPayload('payload' in custom ? custom.payload : {}),
      {
        env: 'env' in custom ? custom.env : {},
        config: 'config' in custom ? custom.config : enabledConfig,
        lockState: 'lockState' in custom ? custom.lockState : 'locked',
        readContext: 'readContext' in custom ? custom.readContext : () => ({}),
        enqueue,
      },
    )).toBe(expected);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', { ...enabledConfig, enabled: false }, 'locked'],
    ['misconfigured', { ...enabledConfig, targetBotAppId: undefined }, 'locked'],
    ['screen_unlocked', enabledConfig, 'unlocked'],
    ['platform_unsupported', enabledConfig, 'unsupported'],
  ] as const)('discards the exact turn proof after a terminal %s skip', (expected, config, lockState) => {
    const removeConfirmedTurn = vi.fn();
    expect(processCodexNotifierHookPayload(stopPayload(), {
      env: {},
      dataDir: '/tmp/botmux-data',
      config,
      lockState,
      readContext: () => ({}),
      removeConfirmedTurn,
    })).toBe(expected);
    expect(removeConfirmedTurn).toHaveBeenCalledWith('/tmp/botmux-data', 'thread-1', 'turn-1');
  });

  it('keeps the turn proof when enqueue fails so a Stop retry can recover', () => {
    const removeConfirmedTurn = vi.fn();
    expect(() => processCodexNotifierHookPayload(stopPayload(), {
      env: {},
      dataDir: '/tmp/botmux-data',
      config: { ...enabledConfig, notifyWhen: 'always' },
      lockState: 'unlocked',
      readContext: () => ({ prompt: '真实用户任务' }),
      enqueue: () => {
        throw new Error('enqueue failed');
      },
      removeConfirmedTurn,
    })).toThrow('enqueue failed');
    expect(removeConfirmedTurn).not.toHaveBeenCalled();
  });

  it('does not treat a native Codex App client_id as a BotMux session marker', () => {
    const transcript = [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '桌面端原生问题',
          client_id: '4b92663c-e47f-4aa3-81d3-65b09b3c195e',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1' },
      }),
    ].join('\n');
    const enqueue = vi.fn();

    expect(processCodexNotifierHookPayload(stopPayload(), {
      env: {},
      config: enabledConfig,
      lockState: 'locked',
      readContext: () => parseCodexTurnContext(transcript, 'turn-1'),
      enqueue,
    })).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'missing transcript',
      {},
      '{"suggestions":[]}',
    ],
    [
      'non-empty result',
      {},
      '{"suggestions":[{"title":"继续处理"}]}',
    ],
    [
      'generator transcript',
      {
        clientSurface: 'codex-app' as const,
        prompt: '# Overview Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex',
      },
      '{"suggestions":[]}',
    ],
    [
      'safety transcript',
      {
        clientSurface: 'codex-app' as const,
        prompt: 'You are an expert at upholding safety and compliance standards for Codex ambient suggestions.',
      },
      '{"suggestions":[]}',
    ],
  ] as const)('filters the Codex ambient suggestion turn with %s', (_label, context, finalMessage) => {
    const enqueue = vi.fn();

    expect(processCodexNotifierHookPayload(stopPayload({
      last_assistant_message: finalMessage,
    }), {
      env: {},
      config: { ...enabledConfig, notifyWhen: 'always' },
      lockState: 'unlocked',
      readContext: () => context,
      enqueue,
    })).toBe('internal');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps a real user turn whose requested output also contains suggestions JSON', () => {
    const enqueue = vi.fn();

    expect(processCodexNotifierHookPayload(stopPayload({
      last_assistant_message: '{"suggestions":[]}',
    }), {
      env: {},
      config: { ...enabledConfig, notifyWhen: 'always' },
      lockState: 'unlocked',
      readContext: () => ({
        clientSurface: 'codex-app',
        prompt: '请按 JSON 输出建议列表',
      }),
      enqueue,
    })).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('allows always mode on unsupported platforms', () => {
    const enqueue = vi.fn();
    expect(processCodexNotifierHookPayload(stopPayload(), {
      env: {},
      config: { ...enabledConfig, notifyWhen: 'always' },
      lockState: 'unsupported',
      readContext: () => ({ prompt: '真实用户任务' }),
      enqueue,
    })).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('keeps malformed stdin from blocking Codex', async () => {
    expect(await runCodexNotifierHookCli(
      Readable.from(['{broken']),
      { config: enabledConfig },
    )).toBe('error');
  });
});
