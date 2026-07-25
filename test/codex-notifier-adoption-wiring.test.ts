import { describe, expect, it, vi } from 'vitest';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import type { DaemonSession } from '../src/core/types.js';
import { startCodexNotifierAdoptionSession } from '../src/features/codex-notifier/adoption.js';
import type { CodexAppThreadSummary } from '../src/services/codex-app-threads.js';

describe('Codex notifier adoption wiring', () => {
  it('用原通知卡消息 ID 消化成功回执，不额外发送飞书消息', async () => {
    const outboundReply = vi.fn(async () => 'om_duplicate');
    const deps = {
      activeSessions: new Map(),
      sessionReply: outboundReply,
      getActiveCount: () => 1,
      lastRepoScan: new Map(),
    } satisfies CommandHandlerDeps;
    const thread = {
      threadId: 'thread-1',
      preview: '完成结果',
      cwd: '/tmp/project',
    } satisfies CodexAppThreadSummary;
    const ds = {} as DaemonSession;
    const startSession = vi.fn(async (
      receivedThread: CodexAppThreadSummary,
      receivedDs: DaemonSession,
      receivedDeps: CommandHandlerDeps,
      larkAppId?: string,
    ) => {
      expect(receivedThread).toBe(thread);
      expect(receivedDs).toBe(ds);
      expect(receivedDeps.activeSessions).toBe(deps.activeSessions);
      expect(receivedDeps.getActiveCount).toBe(deps.getActiveCount);
      expect(receivedDeps.lastRepoScan).toBe(deps.lastRepoScan);
      expect(larkAppId).toBe('cli_a');
      expect(await receivedDeps.sessionReply('om_card', '接管成功')).toBe('om_card');
    });

    await startCodexNotifierAdoptionSession(
      startSession,
      thread,
      ds,
      deps,
      'cli_a',
      'om_card',
    );

    expect(startSession).toHaveBeenCalledOnce();
    expect(outboundReply).not.toHaveBeenCalled();
  });
});
