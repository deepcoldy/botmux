import { describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../src/types.js';
import type { MessageListenerMatch } from '../src/services/message-listener.js';
import {
  prepareSubjectListenerTurn,
  type PrepareSubjectListenerTurnDependencies,
  type PrepareSubjectListenerTurnInput,
} from '../src/services/subject-listener-turn.js';
import type { SubjectListenerMessageScanOptions } from '../src/services/subject-listener-context.js';

function message(messageId: string, createTime: number, text: string) {
  return {
    message_id: messageId,
    create_time: String(createTime),
    chat_id: 'oc_subject',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text }),
  };
}

function subjectMatch(overrides: Partial<MessageListenerMatch> = {}): MessageListenerMatch {
  return {
    behavior: 'subject',
    subjectPolicy: { context: { source: 'lark', fallbackMessages: 20 } },
    prompt: '只在能推进协作时介入',
    messageText: '需要判断是否介入',
    msgType: 'text',
    senderOpenId: 'ou_trigger',
    senderType: 'user',
    trigger: { messageId: 'om_trigger', createTime: '400' },
    ...overrides,
  };
}

function input(overrides: Partial<PrepareSubjectListenerTurnInput> = {}): PrepareSubjectListenerTurnInput {
  return {
    larkAppId: 'app_subject',
    chatId: 'oc_subject',
    chatType: 'group',
    messageId: 'om_trigger',
    triggerMessage: message('om_trigger', 400, '精确事件原文'),
    messageListener: subjectMatch(),
    senderOpenId: 'ou_trigger',
    senderType: 'user',
    dataDir: '/tmp/botmux-subject-turn-test',
    ...overrides,
  };
}

function dependencies(): PrepareSubjectListenerTurnDependencies {
  const newestFirst = [
    message('om_future', 500, '触发后的消息不得读入'),
    message('om_trigger', 400, 'REST 延迟副本'),
    message('om_middle', 300, '游标后的飞书历史'),
    message('om_previous', 200, '已提交的旧消息'),
  ];
  return {
    resolveSender: vi.fn(async () => ({
      openId: 'ou_trigger',
      type: 'user',
      name: '解析后的发送者',
      email: 'sender@example.com',
    })),
    getChatContext: vi.fn(async (): Promise<ChatContext> => ({
      chatId: 'oc_subject',
      name: '事故协作群',
      description: '先了解现场，再决定是否介入',
      mode: 'group',
      fetchStatus: 'ok',
    })),
    readSubjectListenerCursor: vi.fn(() => ({
      messageId: 'om_previous',
      createTime: '200',
    })),
    listChatMessagesUntil: vi.fn(async (
      _appId: string,
      _chatId: string,
      options: SubjectListenerMessageScanOptions = {},
    ) => {
      const scanned: any[] = [];
      for (const item of newestFirst) {
        scanned.push(item);
        if (options.stopAfter?.(item, scanned.length)) break;
      }
      return scanned.reverse();
    }),
  };
}

describe('prepareSubjectListenerTurn', () => {
  it('完整飞书现场：未被 @ 的群消息从持久化游标后准备现有 CLI 首轮', async () => {
    const deps = dependencies();

    const prepared = await prepareSubjectListenerTurn(input(), deps);

    expect(deps.resolveSender).toHaveBeenCalledWith(
      'app_subject',
      'ou_trigger',
      'user',
      { messageId: 'om_trigger' },
    );
    expect(deps.getChatContext).toHaveBeenCalledWith('app_subject', 'oc_subject');
    expect(deps.readSubjectListenerCursor).toHaveBeenCalledWith(
      '/tmp/botmux-subject-turn-test',
      'app_subject',
      'oc_subject',
    );
    expect(deps.listChatMessagesUntil).toHaveBeenCalledWith(
      'app_subject',
      'oc_subject',
      expect.objectContaining({ pageSize: 50, stopAfter: expect.any(Function) }),
    );
    expect(prepared).toMatchObject({
      chatContext: {
        chatId: 'oc_subject',
        name: '事故协作群',
        description: '先了解现场，再决定是否介入',
      },
      resolvedSender: {
        openId: 'ou_trigger',
        type: 'user',
        name: '解析后的发送者',
      },
      candidateCursor: { messageId: 'om_trigger', createTime: '400' },
    });
    expect(prepared.prompt).toContain('<subject_protocol trusted="true">');
    expect(prepared.prompt).toContain('<subject_lark_context trusted="false">');
    expect(prepared.prompt).toContain('name="事故协作群"');
    expect(prepared.prompt).toContain('sender_name="解析后的发送者"');
    expect(prepared.prompt).toContain('游标后的飞书历史');
    expect(prepared.prompt).toContain('精确事件原文');
    expect(prepared.prompt).not.toContain('触发后的消息不得读入');
    expect(prepared.prompt).not.toContain('已提交的旧消息');
  });

  it.each([
    {
      name: '不是群消息',
      mutate: (value: PrepareSubjectListenerTurnInput) => ({ ...value, chatType: 'p2p' }),
    },
    {
      name: '不是 Subject behavior',
      mutate: (value: PrepareSubjectListenerTurnInput) => ({
        ...value,
        messageListener: subjectMatch({ behavior: 'prompt' }),
      }),
    },
    {
      name: 'match message id 与当前事件入口不一致',
      mutate: (value: PrepareSubjectListenerTurnInput) => ({
        ...value,
        messageListener: subjectMatch({
          trigger: { messageId: 'om_other', createTime: '400' },
        }),
      }),
    },
    {
      name: '原始事件缺少 message id',
      mutate: (value: PrepareSubjectListenerTurnInput) => ({
        ...value,
        triggerMessage: { ...value.triggerMessage, message_id: undefined },
      }),
    },
    {
      name: '原始事件 message id 与 match 不一致',
      mutate: (value: PrepareSubjectListenerTurnInput) => ({
        ...value,
        triggerMessage: { ...value.triggerMessage, message_id: 'om_other' },
      }),
    },
    {
      name: 'match createTime 不是整数串',
      mutate: (value: PrepareSubjectListenerTurnInput) => ({
        ...value,
        messageListener: subjectMatch({
          trigger: { messageId: 'om_trigger', createTime: 'not-a-time' },
        }),
      }),
    },
    {
      name: '原始事件缺少 createTime',
      mutate: (value: PrepareSubjectListenerTurnInput) => ({
        ...value,
        triggerMessage: { ...value.triggerMessage, create_time: undefined },
      }),
    },
    {
      name: '原始事件 createTime 与 match 不一致',
      mutate: (value: PrepareSubjectListenerTurnInput) => ({
        ...value,
        triggerMessage: { ...value.triggerMessage, create_time: '401' },
      }),
    },
  ])('无效的 Subject trigger：$name 时在任何现场读取前拒绝', async ({ mutate }) => {
    const deps = dependencies();

    await expect(prepareSubjectListenerTurn(mutate(input()), deps))
      .rejects.toThrow(/Subject listener/);

    expect(deps.resolveSender).not.toHaveBeenCalled();
    expect(deps.getChatContext).not.toHaveBeenCalled();
    expect(deps.readSubjectListenerCursor).not.toHaveBeenCalled();
    expect(deps.listChatMessagesUntil).not.toHaveBeenCalled();
  });
});
