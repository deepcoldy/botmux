import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBJECT_FALLBACK_MESSAGES,
  MAX_SUBJECT_FALLBACK_MESSAGES,
} from '../src/bot-registry.js';
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

describe('message listener store — Subject', () => {
  it('round-trips an enabled Subject with empty optional focus and explicit fallbackMessages', () => {
    const update = sanitizeMessageListenerUpdate({
      enabled: true,
      behavior: 'subject',
      prompt: '   ',
      subjectPolicy: {
        context: { source: 'lark', fallbackMessages: 30 },
      },
    });

    expect(update).toEqual({
      enabled: true,
      behavior: 'subject',
      prompt: '',
      subjectPolicy: {
        context: { source: 'lark', fallbackMessages: 30 },
      },
      messagePolicy: { scope: 'top_level' },
    });
    expect(validateMessageListenerUpdate(update)).toEqual({ ok: true });
    expect(messageListenerConfigFromUpdate(update!)).toMatchObject({
      enabled: true,
      behavior: 'subject',
      prompt: '',
      subjectPolicy: {
        context: { source: 'lark', fallbackMessages: 30 },
      },
      messagePolicy: { scope: 'top_level' },
      replyPolicy: { mode: 'thread', sessionMode: 'per_message' },
    });
  });

  it('uses the documented Subject fallback default when policy is omitted', () => {
    const update = sanitizeMessageListenerUpdate({
      enabled: false,
      behavior: 'subject',
      prompt: '',
    });

    expect(validateMessageListenerUpdate(update)).toEqual({ ok: true });
    expect(messageListenerConfigFromUpdate(update!)).toMatchObject({
      enabled: false,
      behavior: 'subject',
      prompt: '',
      subjectPolicy: {
        context: {
          source: 'lark',
          fallbackMessages: DEFAULT_SUBJECT_FALLBACK_MESSAGES,
        },
      },
    });
  });
});

describe('message listener store — 旧监听', () => {
  it('keeps a missing behavior as the legacy prompt listener shape', () => {
    const update = sanitizeMessageListenerUpdate({
      enabled: true,
      prompt: '保持原来的提示词行为',
    });

    expect(update).not.toHaveProperty('behavior');
    expect(validateMessageListenerUpdate(update)).toEqual({ ok: true });
    const persisted = messageListenerConfigFromUpdate(update!);
    expect(persisted).not.toHaveProperty('behavior');
    expect(persisted).not.toHaveProperty('subjectPolicy');
    expect(persisted).toMatchObject({
      enabled: true,
      prompt: '保持原来的提示词行为',
    });
  });
});

describe('message listener store — 非法 Subject 配置', () => {
  it.each([
    {
      label: 'unknown behavior',
      patch: { behavior: 'ambient' },
      reason: 'unknown_behavior',
    },
    {
      label: 'non-Lark source',
      patch: { behavior: 'subject', subjectPolicy: { context: { source: 'cli', fallbackMessages: 20 } } },
      reason: 'subject_source_must_be_lark',
    },
    {
      label: 'non-integer fallbackMessages',
      patch: { behavior: 'subject', subjectPolicy: { context: { source: 'lark', fallbackMessages: 1.5 } } },
      reason: 'invalid_fallback_messages',
    },
    {
      label: 'zero fallbackMessages',
      patch: { behavior: 'subject', subjectPolicy: { context: { source: 'lark', fallbackMessages: 0 } } },
      reason: 'invalid_fallback_messages',
    },
    {
      label: 'fallbackMessages above the maximum',
      patch: { behavior: 'subject', subjectPolicy: { context: { source: 'lark', fallbackMessages: MAX_SUBJECT_FALLBACK_MESSAGES + 1 } } },
      reason: 'invalid_fallback_messages',
    },
  ])('rejects $label instead of coercing it', ({ patch, reason }) => {
    const update = sanitizeMessageListenerUpdate({
      enabled: true,
      prompt: '',
      ...patch,
    });
    expect(validateMessageListenerUpdate(update)).toEqual({ ok: false, reason });
  });
});
