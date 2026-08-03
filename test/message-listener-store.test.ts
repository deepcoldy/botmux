import { describe, expect, it } from 'vitest';
import { sanitizeMessageListenerUpdate, validateMessageListenerUpdate } from '../src/services/message-listener-store.js';

describe('message listener store', () => {
  it('keeps the custom reply card title from dashboard updates', () => {
    expect(sanitizeMessageListenerUpdate({
      enabled: true,
      name: '告警监听',
      replyCardTitle: '告警自动分析',
      prompt: '分析命中的告警消息',
      senderPolicy: {
        mode: 'include_only',
        includeSenderOpenIds: ['ou_argos'],
        includeSenderTypes: ['bot'],
      },
      messagePolicy: { includeMsgTypes: ['interactive'], scope: 'top_level' },
    })).toMatchObject({
      enabled: true,
      name: '告警监听',
      replyCardTitle: '告警自动分析',
      prompt: '分析命中的告警消息',
    });
  });

  it('drops blank reply card titles', () => {
    expect(sanitizeMessageListenerUpdate({
      enabled: true,
      replyCardTitle: '   ',
      prompt: '分析命中的告警消息',
    })).not.toHaveProperty('replyCardTitle');
  });

  it('rejects enabled include-only listeners without selected senders', () => {
    const update = sanitizeMessageListenerUpdate({
      enabled: true,
      prompt: '分析命中的告警消息',
      senderPolicy: {
        mode: 'include_only',
        includeSenderTypes: ['bot'],
      },
    });

    expect(validateMessageListenerUpdate(update)).toEqual({
      ok: false,
      reason: 'sender_required',
    });
  });
});
