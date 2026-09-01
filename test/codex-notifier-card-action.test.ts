import { describe, expect, it, vi } from 'bun:test';
import {
  createCodexNotifierCardActionHandler,
  type CodexNotifierCardActionDeps,
} from '../src/features/codex-notifier/card-action.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import type { CodexNotifierEventRecord } from '../src/features/codex-notifier/types.js';

const APP_ID = 'cli_notifier';
const EVENT_ID = 'a'.repeat(64);
const MESSAGE_ID = 'om_completion';
const OWNER_OPEN_ID = 'ou_owner';

const record: CodexNotifierEventRecord = {
  event: {
    schemaVersion: 1,
    eventId: EVENT_ID,
    type: 'task.completed',
    source: 'codex-desktop',
    clientSurface: 'codex-app',
    threadId: '019f8d92-df7c-7572-83ca-b1e99f20204c',
    nativeTurnId: 'turn-1',
    status: 'completed',
    cwd: '/tmp/example',
    completedAt: '2026-07-24T08:00:00.000Z',
  },
  receivedAt: '2026-07-24T08:00:00.000Z',
  delivery: {
    status: 'delivered',
    attempts: 1,
    updatedAt: '2026-07-24T08:00:01.000Z',
    messageId: MESSAGE_ID,
  },
};

async function runImmediately<T>(
  _label: string,
  timeoutMs: number,
  task: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
): Promise<T> {
  return task(new AbortController().signal, Date.now() + timeoutMs);
}

function action(
  type: 'codex_notifier_continue' | 'codex_notifier_open_app',
  overrides: Partial<CardActionData> = {},
): CardActionData {
  return {
    operator: { open_id: OWNER_OPEN_ID },
    action: { value: { action: type, event_id: EVENT_ID } },
    context: { open_message_id: MESSAGE_ID },
    ...overrides,
  };
}

function makeHandler(overrides: Partial<CodexNotifierCardActionDeps> = {}) {
  const adoptEvent = vi.fn(async () => ({ adopted: true }));
  const openAppThread = vi.fn(async () => ({ ok: true } as const));
  const deps: CodexNotifierCardActionDeps = {
    getExpectedOwnerOpenId: () => OWNER_OPEN_ID,
    getEventRecord: () => structuredClone(record),
    readConfig: () => ({ enabled: true, targetBotAppId: APP_ID }),
    openAppThread,
    adoptEvent,
    runWithAbortDeadline: runImmediately,
    isAbortDeadlineError: () => false,
    ...overrides,
  };
  return {
    handler: createCodexNotifierCardActionHandler(deps),
    adoptEvent,
    openAppThread,
  };
}

describe('Codex notifier card action', () => {
  it('rejects an operator who is not the bot administrator', async () => {
    const { handler, adoptEvent } = makeHandler();

    await expect(handler(action('codex_notifier_continue', {
      operator: { open_id: 'ou_other' },
    }), APP_ID)).resolves.toEqual({
      toast: { type: 'error', content: '只有机器人管理员可以接管此 Codex 任务' },
    });
    expect(adoptEvent).not.toHaveBeenCalled();
  });

  it('rejects a callback that is not bound to the delivered card message', async () => {
    const { handler, adoptEvent } = makeHandler({
      getEventRecord: () => ({
        ...structuredClone(record),
        delivery: { ...record.delivery, messageId: 'om_other' },
      }),
    });

    await expect(handler(action('codex_notifier_continue'), APP_ID)).resolves.toEqual({
      toast: { type: 'error', content: '此完成通知已失效或来源不可信' },
    });
    expect(adoptEvent).not.toHaveBeenCalled();
  });

  it('rejects Side Chat adoption', async () => {
    const { handler, adoptEvent } = makeHandler({
      getEventRecord: () => ({
        ...structuredClone(record),
        event: { ...record.event, conversationKind: 'side' },
      }),
    });

    await expect(handler(action('codex_notifier_continue'), APP_ID)).resolves.toEqual({
      toast: {
        type: 'error',
        content: 'Side Chat 是临时会话，暂不支持接管或回到原会话',
      },
    });
    expect(adoptEvent).not.toHaveBeenCalled();
  });

  it('does not open the app after notification is disabled', async () => {
    const { handler, openAppThread } = makeHandler({
      readConfig: () => ({ enabled: false, targetBotAppId: APP_ID }),
    });

    await expect(handler(action('codex_notifier_open_app'), APP_ID)).resolves.toEqual({
      toast: {
        type: 'error',
        content: 'Codex 完成通知功能已关闭或已切换目标机器人',
      },
    });
    expect(openAppThread).not.toHaveBeenCalled();
  });

  it('only opens events from a trusted Codex App source', async () => {
    const { handler, openAppThread } = makeHandler({
      getEventRecord: () => ({
        ...structuredClone(record),
        event: { ...record.event, clientSurface: 'codex-cli' },
      }),
    });

    await expect(handler(action('codex_notifier_open_app'), APP_ID)).resolves.toEqual({
      toast: { type: 'error', content: '此任务不是可信的 Codex App 会话' },
    });
    expect(openAppThread).not.toHaveBeenCalled();
  });

  it('opens a delivered trusted Codex App event', async () => {
    const { handler, openAppThread } = makeHandler();

    await expect(handler(action('codex_notifier_open_app'), APP_ID)).resolves.toEqual({
      toast: {
        type: 'success',
        content: '已请求运行 BotMux 的电脑打开原 Codex App 会话',
      },
    });
    expect(openAppThread).toHaveBeenCalledWith(record.event.threadId);
  });

  it('adopts a trusted completion event', async () => {
    const successCard = { adopted: true, card: 'success' };
    const adoptEvent = vi.fn(async () => successCard);
    const { handler } = makeHandler({ adoptEvent });

    await expect(handler(action('codex_notifier_continue'), APP_ID))
      .resolves.toBe(successCard);
    expect(adoptEvent).toHaveBeenCalledWith(
      APP_ID,
      record.event,
      MESSAGE_ID,
      OWNER_OPEN_ID,
      expect.any(AbortSignal),
      expect.any(Number),
    );
  });

  it('keeps the completion card retryable when adoption reaches its deadline', async () => {
    class TestDeadlineError extends Error {}
    const timeoutError = new TestDeadlineError('deadline');
    const successCard = { adopted: true };
    const adoptEvent = vi.fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(successCard);
    const { handler } = makeHandler({
      adoptEvent,
      isAbortDeadlineError: error => error instanceof TestDeadlineError,
    });

    await expect(handler(action('codex_notifier_continue'), APP_ID)).resolves.toEqual({
      toast: { type: 'error', content: '接管超时，请再次点击按钮重试' },
    });
    await expect(handler(action('codex_notifier_continue'), APP_ID))
      .resolves.toBe(successCard);
    expect(adoptEvent).toHaveBeenCalledTimes(2);
  });

  it('keeps the completion card retryable after an adoption error', async () => {
    const adoptEvent = vi.fn(async () => {
      throw new Error('worker unavailable');
    });
    const { handler } = makeHandler({ adoptEvent });

    await expect(handler(action('codex_notifier_continue'), APP_ID)).resolves.toEqual({
      toast: {
        type: 'error',
        content: '接管失败，请再次点击按钮重试。原因：worker unavailable',
      },
    });
  });

  it('deduplicates concurrent adoption and releases the event afterwards', async () => {
    const successCard = { adopted: true };
    let releaseFirst!: (value: Record<string, unknown>) => void;
    const firstAdoption = new Promise<Record<string, unknown>>(resolve => {
      releaseFirst = resolve;
    });
    const adoptEvent = vi.fn()
      .mockImplementationOnce(async () => firstAdoption)
      .mockResolvedValueOnce(successCard);
    const { handler } = makeHandler({ adoptEvent });

    const first = handler(action('codex_notifier_continue'), APP_ID);
    const second = handler(action('codex_notifier_continue'), APP_ID);
    expect(adoptEvent).toHaveBeenCalledTimes(1);

    releaseFirst(successCard);
    await expect(Promise.all([first, second])).resolves.toEqual([
      successCard,
      successCard,
    ]);

    await expect(handler(action('codex_notifier_continue'), APP_ID))
      .resolves.toBe(successCard);
    expect(adoptEvent).toHaveBeenCalledTimes(2);
  });
});
