import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_LISTENER_PROMPT_BYTES,
  evaluateMessageListener,
  normalizeMessageListenerPreviewLimit,
  previewMessageListenerMatches,
  renderMessageListenerPrompt,
} from '../src/services/message-listener.js';

function bot(config: any = {}, botOpenId = 'ou_self'): any {
  return { botOpenId, config: { larkAppId: 'app_listener', ...config } };
}

function textMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 'om_msg',
    chat_id: 'oc_chat',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: 'CPU 告警持续 5 分钟' }),
    ...overrides,
  };
}

function interactiveMessage(overrides: Record<string, unknown> = {}) {
  return textMessage({
    message_type: 'interactive',
    content: JSON.stringify({
      title: 'Argos平台报警',
      elements: [
        [
          { tag: 'text', text: '规则名称：成片任务执行成功率 < 90%' },
        ],
        [
          { tag: 'text', text: 'PSM：ecom.alliance.ai' },
        ],
      ],
    }),
    ...overrides,
  });
}

describe('message listener evaluation', () => {
  it('matches enabled top-level non-mention messages after deterministic filters', () => {
    const state = bot({
      messageListeners: {
        oc_chat: {
          enabled: true,
          prompt: '判断是否需要响应告警',
          replyCardTitle: '告警自动分析',
          senderPolicy: {
            includeSenderOpenIds: ['ou_allowed'],
            includeSenderTypes: ['user'],
          },
          messagePolicy: { includeMsgTypes: ['text'], scope: 'top_level' },
          replyPolicy: { mode: 'thread', sessionMode: 'per_message' },
        },
      },
    });

    const match = evaluateMessageListener({
      bot: state,
      chatId: 'oc_chat',
      message: textMessage(),
      senderOpenId: 'ou_allowed',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: false,
    });

    expect(match).toMatchObject({
      prompt: '判断是否需要响应告警',
      replyCardTitle: '告警自动分析',
      messageText: 'CPU 告警持续 5 分钟',
      msgType: 'text',
      senderOpenId: 'ou_allowed',
      senderType: 'user',
    });
  });

  it('previews only the newest matching listener messages and caps the count at twenty', () => {
    const state = bot({
      messageListeners: {
        oc_chat: {
          enabled: true,
          prompt: 'listener',
          senderPolicy: {
            mode: 'include_only',
            includeSenderOpenIds: ['ou_allowed'],
            includeSenderTypes: ['user'],
          },
          messagePolicy: { includeMsgTypes: ['text'], scope: 'top_level' },
        },
      },
    });

    const messages = Array.from({ length: 25 }, (_, index) => textMessage({
      message_id: `om_${index}`,
      create_time: String(1000 + index),
      content: JSON.stringify({ text: `告警 ${index}` }),
    }));

    const matches = previewMessageListenerMatches({
      bot: state,
      chatId: 'oc_chat',
      messages,
      limit: 99,
      senderForMessage: () => ({ senderOpenId: 'ou_allowed', senderTypeRaw: 'user' }),
    });

    expect(normalizeMessageListenerPreviewLimit(99)).toBe(20);
    expect(matches).toHaveLength(20);
    expect(matches[0].messageId).toBe('om_5');
    expect(matches.at(-1)?.messageText).toBe('告警 24');
  });

  it('does not hijack explicit mentions or existing topics', () => {
    const state = bot({
      messageListeners: {
        oc_chat: { enabled: true, prompt: 'listener' },
      },
    });

    expect(evaluateMessageListener({
      bot: state,
      chatId: 'oc_chat',
      message: textMessage(),
      senderOpenId: 'ou_user',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: true,
    })).toBeUndefined();

    expect(evaluateMessageListener({
      bot: state,
      chatId: 'oc_chat',
      message: textMessage({ root_id: 'om_root', thread_id: 'omt_thread' }),
      senderOpenId: 'ou_user',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: false,
    })).toBeUndefined();
  });

  it('filters excluded senders and bot sender types before any session starts', () => {
    const state = bot({
      messageListeners: {
        oc_chat: {
          enabled: true,
          prompt: 'listener',
          senderPolicy: {
            excludeSenderOpenIds: ['ou_noise'],
            includeSenderTypes: ['user'],
          },
        },
      },
    });

    expect(evaluateMessageListener({
      bot: state,
      chatId: 'oc_chat',
      message: textMessage(),
      senderOpenId: 'ou_noise',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: false,
    })).toBeUndefined();

    expect(evaluateMessageListener({
      bot: state,
      chatId: 'oc_chat',
      message: textMessage(),
      senderOpenId: 'ou_bot',
      senderTypeRaw: 'bot',
      explicitlyMentionedThisBot: false,
    })).toBeUndefined();
  });

  it('does not fall back to listening to everyone when include-only mode has no selected senders', () => {
    const state = bot({
      messageListeners: {
        oc_chat: {
          enabled: true,
          prompt: 'listener',
          senderPolicy: {
            mode: 'include_only',
            includeSenderOpenIds: [],
            includeSenderTypes: ['user'],
          },
        },
      },
    });

    expect(evaluateMessageListener({
      bot: state,
      chatId: 'oc_chat',
      message: textMessage(),
      senderOpenId: 'ou_anyone',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: false,
    })).toBeUndefined();
  });

  it('matches allowed interactive alert cards and extracts readable card text', () => {
    const state = bot({
      messageListeners: {
        oc_chat: {
          enabled: true,
          prompt: '分析告警卡片',
          senderPolicy: {
            mode: 'include_only',
            includeSenderOpenIds: ['ou_argos'],
            includeSenderTypes: ['bot'],
          },
          messagePolicy: { includeMsgTypes: ['interactive'], scope: 'top_level' },
        },
      },
    });

    const match = evaluateMessageListener({
      bot: state,
      chatId: 'oc_chat',
      message: interactiveMessage(),
      senderOpenId: 'ou_argos',
      senderTypeRaw: 'app',
      explicitlyMentionedThisBot: false,
    });

    expect(match).toMatchObject({
      prompt: '分析告警卡片',
      msgType: 'interactive',
      senderOpenId: 'ou_argos',
      senderType: 'bot',
    });
    expect(match?.messageText).toContain('[卡片: Argos平台报警]');
    expect(match?.messageText).toContain('规则名称：成片任务执行成功率 < 90%');
    expect(match?.messageText).toContain('PSM：ecom.alliance.ai');
  });

  it('extracts rendered interactive alert cards from message history format', () => {
    const state = bot({
      messageListeners: {
        oc_chat: {
          enabled: true,
          prompt: '分析告警卡片',
          senderPolicy: {
            mode: 'include_only',
            includeSenderOpenIds: ['cli_argos'],
            includeSenderTypes: ['bot'],
          },
          messagePolicy: { includeMsgTypes: ['interactive'], scope: 'top_level' },
        },
      },
    });

    const match = evaluateMessageListener({
      bot: state,
      chatId: 'oc_chat',
      message: interactiveMessage({
        content: [
          '<card title="[critical] abase2 写流量使用率超过阈值">',
          '服务: bytedance.abase2.ecom_alliance_ai',
          '集群: China-North: ecom_alliance_ai',
          'WriteRUUsage: 88.677',
          '<font color="grey">botmux https://github.com/deepcoldy/botmux</font>',
          '</card>',
        ].join('\n'),
      }),
      senderOpenId: 'cli_argos',
      senderTypeRaw: 'app',
      explicitlyMentionedThisBot: false,
    });

    expect(match?.messageText).toContain('[卡片: [critical] abase2 写流量使用率超过阈值]');
    expect(match?.messageText).toContain('服务: bytedance.abase2.ecom_alliance_ai');
    expect(match?.messageText).toContain('WriteRUUsage: 88.677');
    expect(match?.messageText).not.toContain('github.com/deepcoldy/botmux');
  });

  it('renders listener prompt with separate instruction and observed message blocks', () => {
    const rendered = renderMessageListenerPrompt({
      name: '告警监听',
      prompt: '只在需要处理时回答。',
      messageText: '磁盘使用率 95%',
      msgType: 'text',
      senderOpenId: 'ou_user',
      senderType: 'user',
    });

    expect(rendered).toContain('<message_listener>');
    expect(rendered).toContain('<instruction>');
    expect(rendered).toContain('只在需要处理时回答。');
    expect(rendered).toContain('sender_open_id="ou_user"');
    expect(rendered).toContain('磁盘使用率 95%');
  });

  it('truncates observed message at utf-8 character boundaries', () => {
    const rendered = renderMessageListenerPrompt({
      prompt: 'summarize',
      messageText: `${'a'.repeat(MAX_MESSAGE_LISTENER_PROMPT_BYTES - 1)}中文`,
      msgType: 'text',
      senderType: 'user',
    });

    expect(rendered).not.toContain('\uFFFD');
    expect(rendered).toContain('a'.repeat(MAX_MESSAGE_LISTENER_PROMPT_BYTES - 1));
    expect(rendered).not.toContain('中');
  });
});
