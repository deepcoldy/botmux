import { describe, expect, it } from 'vitest';
import { messageListenerConfigFromUpdate, sanitizeMessageListenerUpdate, validateMessageListenerUpdate } from '../src/services/message-listener-store.js';

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

describe('messageListenerConfigFromUpdate — disabled drafts persist', () => {
  const update = (over: Partial<Parameters<typeof messageListenerConfigFromUpdate>[0]> = {}) => ({
    enabled: false,
    prompt: '分析命中的告警消息',
    ...over,
  });

  it('persists a disabled listener that still has a prompt (draft), keeping enabled:false', () => {
    const config = messageListenerConfigFromUpdate(update({ enabled: false, name: '告警监听草稿' }));
    // The exact bug: saving with the toggle OFF used to discard the whole entry,
    // so the typed prompt vanished on the next reload. It must now round-trip.
    expect(config).not.toBeNull();
    expect(config?.enabled).toBe(false);
    expect(config?.prompt).toBe('分析命中的告警消息');
    expect(config?.name).toBe('告警监听草稿');
    // Runtime still gates on enabled===true elsewhere, so a persisted off draft
    // never matches live messages — it only survives for the editor.
  });

  it('treats a disabled + blank-prompt update as a clear (returns null → delete)', () => {
    expect(messageListenerConfigFromUpdate(update({ enabled: false, prompt: '   ' }))).toBeNull();
    expect(messageListenerConfigFromUpdate(update({ enabled: false, prompt: '' }))).toBeNull();
  });

  it('persists an enabled listener normally', () => {
    const config = messageListenerConfigFromUpdate(update({ enabled: true }));
    expect(config?.enabled).toBe(true);
    expect(config?.prompt).toBe('分析命中的告警消息');
  });

  it('always stamps the fixed messagePolicy scope + replyPolicy', () => {
    const config = messageListenerConfigFromUpdate(update({ enabled: false }));
    expect(config?.messagePolicy?.scope).toBe('top_level');
    expect(config?.replyPolicy).toEqual({ mode: 'thread', sessionMode: 'per_message' });
  });
});
