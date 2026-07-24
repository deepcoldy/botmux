import type {
  CommandHandlerDeps,
  startCodexAppThreadSession,
} from '../../core/command-handler.js';
import type { DaemonSession } from '../../core/types.js';
import type { CodexAppThreadSummary } from '../../services/codex-app-threads.js';

type CodexAppSessionStarter = typeof startCodexAppThreadSession;

/**
 * 启动完成通知对应的 Codex App 会话，并吞掉 command-handler 自带的成功回执。
 * 卡片回调会直接返回接管结果，不能再向私聊发送一条重复消息。
 */
export async function startCodexNotifierAdoptionSession(
  startSession: CodexAppSessionStarter,
  thread: CodexAppThreadSummary,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId: string,
  cardMessageId: string,
): Promise<void> {
  await startSession(thread, ds, {
    ...deps,
    sessionReply: async () => cardMessageId,
  }, larkAppId);
}
