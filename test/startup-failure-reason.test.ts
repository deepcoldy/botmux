import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chatSafeFatalErrorMessage } from '../src/core/startup-failure-reason.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/** A real execFileSync failure, so the message shape is the runtime's own. */
function execFailure(args: string[]): unknown {
  try {
    execFileSync('/bin/sh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return err;
  }
  throw new Error('expected the command to fail');
}

describe('chatSafeFatalErrorMessage', () => {
  it('drops the echoed command, keeps the program, exit status and stderr', () => {
    const err = execFailure(['-c', 'echo "tmux said no" >&2; exit 3', '_', '--rules', '系统提示词\n第二行', 'PROVIDER_TOKEN=secret-value']);
    // Precondition: the runtime really echoes the arguments.
    expect((err as Error).message).toContain('secret-value');
    const message = chatSafeFatalErrorMessage(err);
    expect(message).toBe('sh 执行失败（退出码 3），完整命令只写入本机日志：\ntmux said no');
    expect(message).not.toContain('secret-value');
    expect(message).not.toContain('系统提示词');
  });

  it('keeps only the stderr tail', () => {
    const err = execFailure(['-c', 'for i in 1 2 3 4 5 6 7 8; do echo "line $i" >&2; done; exit 1']);
    expect(chatSafeFatalErrorMessage(err).split('\n').slice(1)).toEqual(['line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
  });

  it('passes other errors through unchanged', () => {
    expect(chatSafeFatalErrorMessage(new Error('spawnSync tmux ETIMEDOUT'))).toBe('spawnSync tmux ETIMEDOUT');
    expect(chatSafeFatalErrorMessage(new Error('tmux 创建会话失败：error connecting to /tmp/x'))).toBe('tmux 创建会话失败：error connecting to /tmp/x');
    expect(chatSafeFatalErrorMessage('plain string')).toBe('plain string');
  });
});

describe('worker fatal error report', () => {
  it('sends the daemon the chat-safe text and keeps the full one in the local log', async () => {
    const err = execFailure(['-c', 'echo "tmux said no" >&2; exit 1', '_', 'PROVIDER_TOKEN=secret-value']);
    const sent: unknown[] = [];
    const logged: string[] = [];
    const scope: Record<string, unknown> = {
      fatalWorkerErrorPending: false, pendingLaunchConvergence: undefined, activeRestartAttemptId: undefined,
      currentBotmuxTurnId: 'turn-1', currentBotmuxDispatchAttempt: undefined,
      sendAndFlush: async (message: unknown) => { sent.push(message); },
      log: (line: string) => { logged.push(line); },
      chatSafeFatalErrorMessage,
      process: { exit: vi.fn() },
    };
    await loadWorkerFunction<(e: unknown) => Promise<void>>('sendFatalWorkerErrorAndExit', scope)(err);
    expect(sent).toEqual([{ type: 'error', message: 'sh 执行失败（退出码 1），完整命令只写入本机日志：\ntmux said no', turnId: 'turn-1' }]);
    expect(logged.some(line => line.includes('PROVIDER_TOKEN=secret-value'))).toBe(true);
    expect((scope.process as { exit: ReturnType<typeof vi.fn> }).exit).toHaveBeenCalledWith(1);
  });
});
