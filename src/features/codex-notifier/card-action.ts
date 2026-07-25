import type { CardActionData } from '../../im/lark/card-handler.js';
import type { CodexAppOpenResult } from './app-opener.js';
import type { CodexNotifierEventRecord, CodexTaskCompletedEvent } from './types.js';

const EVENT_ID_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_ADOPTION_TIMEOUT_MS = 2_200;

type CardResult = Record<string, unknown>;

export interface CodexNotifierCardActionDeps {
  getExpectedOwnerOpenId: (larkAppId: string) => string | undefined;
  getEventRecord: (
    larkAppId: string,
    eventId: string,
  ) => CodexNotifierEventRecord | undefined;
  readConfig: () => {
    enabled?: boolean;
    targetBotAppId?: string;
  } | undefined;
  openAppThread: (threadId: string) => Promise<CodexAppOpenResult>;
  adoptEvent: (
    larkAppId: string,
    event: CodexTaskCompletedEvent,
    cardMessageId: string,
    ownerOpenId: string,
    signal: AbortSignal,
    deadlineAt: number,
  ) => Promise<CardResult>;
  runWithAbortDeadline: <T>(
    label: string,
    timeoutMs: number,
    task: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
  ) => Promise<T>;
  isAbortDeadlineError: (error: unknown) => boolean;
  adoptionTimeoutMs?: number;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
  logError?: (message: string) => void;
}

function toast(type: 'success' | 'error', content: string): CardResult {
  return { toast: { type, content } };
}

/**
 * 创建完成通知卡片回调处理器。账本绑定、管理员鉴权和接管去重在同一处完成，
 * daemon 只负责注入实际存储、网络和会话启动能力。
 */
export function createCodexNotifierCardActionHandler(
  deps: CodexNotifierCardActionDeps,
): (data: CardActionData, larkAppId: string) => Promise<CardResult> {
  const adoptions = new Map<string, Promise<CardResult>>();
  const adoptionTimeoutMs = deps.adoptionTimeoutMs ?? DEFAULT_ADOPTION_TIMEOUT_MS;

  return async (data, larkAppId) => {
    const actionType = data.action?.value?.action;
    const eventId = data.action?.value?.event_id;
    const cardMessageId = data.context?.open_message_id ?? data.open_message_id;
    const ownerOpenId = data.operator?.open_id;
    if (
      (actionType !== 'codex_notifier_continue'
        && actionType !== 'codex_notifier_open_app')
      || !eventId
      || !EVENT_ID_PATTERN.test(eventId)
      || !cardMessageId
      || !ownerOpenId
    ) {
      return toast('error', '完成通知缺少必要信息，请等待下一条通知');
    }

    const expectedOwnerOpenId = deps.getExpectedOwnerOpenId(larkAppId);
    if (!expectedOwnerOpenId || ownerOpenId !== expectedOwnerOpenId) {
      return toast('error', '只有机器人管理员可以接管此 Codex 任务');
    }

    const record = deps.getEventRecord(larkAppId, eventId);
    if (!record || record.delivery.messageId !== cardMessageId) {
      return toast('error', '此完成通知已失效或来源不可信');
    }
    if (record.event.conversationKind === 'side') {
      return toast('error', 'Side Chat 是临时会话，暂不支持接管或回到原会话');
    }

    if (actionType === 'codex_notifier_open_app') {
      const notifierConfig = deps.readConfig();
      if (
        notifierConfig?.enabled !== true
        || notifierConfig.targetBotAppId !== larkAppId
      ) {
        return toast('error', 'Codex 完成通知功能已关闭或已切换目标机器人');
      }
      if (record.delivery.status !== 'delivered') {
        return toast('error', '此完成通知尚未成功送达');
      }
      if (record.event.clientSurface !== 'codex-app') {
        return toast('error', '此任务不是可信的 Codex App 会话');
      }

      const opened = await deps.openAppThread(record.event.threadId);
      if (!opened.ok) {
        deps.logWarn?.(
          `[codex-notifier] open app failed event=${eventId.slice(0, 12)} `
          + `error=${opened.error} detail=${opened.detail ?? ''}`,
        );
        const content = opened.error === 'unsupported_platform'
          ? '运行 BotMux 的电脑暂不支持打开 Codex App'
          : opened.error === 'invalid_thread_id'
          ? '此 Codex App 会话标识无效'
          : 'Codex App 打开失败，请确认已安装在运行 BotMux 的电脑上';
        return toast('error', content);
      }
      deps.logInfo?.(`[codex-notifier] open app requested event=${eventId.slice(0, 12)}`);
      return toast('success', '已请求运行 BotMux 的电脑打开原 Codex App 会话');
    }

    const adoptionKey = `${larkAppId}:${eventId}`;
    let adoption = adoptions.get(adoptionKey);
    if (!adoption) {
      adoption = deps.runWithAbortDeadline(
        'codex_notifier_adoption',
        adoptionTimeoutMs,
        (signal, deadlineAt) => deps.adoptEvent(
          larkAppId,
          record.event,
          cardMessageId,
          ownerOpenId,
          signal,
          deadlineAt,
        ),
      )
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          deps.logError?.(
            `[codex-notifier] adopt failed event=${eventId.slice(0, 12)}: ${detail}`,
          );
          const timedOut = deps.isAbortDeadlineError(error);
          const reason = timedOut
            ? '接管超时，请再次点击按钮重试'
            : detail.slice(0, 300);
          return toast(
            'error',
            timedOut
              ? reason
              : `接管失败，请再次点击按钮重试。原因：${reason}`,
          );
        })
        .finally(() => adoptions.delete(adoptionKey));
      adoptions.set(adoptionKey, adoption);
    }
    return adoption;
  };
}
