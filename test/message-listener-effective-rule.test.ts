import { describe, expect, it } from 'vitest';
import { resolveEffectiveMessageListener } from '../src/services/message-listener.js';

const global = { enabled: true, prompt: 'global', replyPolicy: { mode: 'chat' as const, sessionMode: 'per_message' as const } };
const custom = { enabled: true, prompt: 'custom', replyPolicy: { mode: 'thread' as const, sessionMode: 'per_message' as const } };

function bot(config: Record<string, unknown>): any {
  return { botOpenId: 'ou_self', config: { larkAppId: 'app', ...config } };
}

describe('resolveEffectiveMessageListener', () => {
  it('uses the global listener for a group with no override', () => {
    expect(resolveEffectiveMessageListener(bot({ globalMessageListener: global }), 'oc_new')).toBe(global);
  });

  it('fails closed for a disabled group override', () => {
    expect(resolveEffectiveMessageListener(bot({ globalMessageListener: global, groupMessageListenerOverrides: { oc_off: { mode: 'disabled' } } }), 'oc_off')).toBeUndefined();
  });

  it('uses a custom rule including its reply placement', () => {
    const effective = resolveEffectiveMessageListener(bot({ globalMessageListener: global, groupMessageListenerOverrides: { oc_custom: { mode: 'custom', listener: custom } } }), 'oc_custom');
    expect(effective).toBe(custom);
    expect(effective?.replyPolicy?.mode).toBe('thread');
  });

  it('keeps legacy per-chat rules available during rolling migration', () => {
    expect(resolveEffectiveMessageListener(bot({ messageListeners: { oc_old: custom } }), 'oc_old')).toBe(custom);
  });

  it('lets an explicit new disabled override beat a stale legacy shadow after reload', () => {
    const effective = resolveEffectiveMessageListener(bot({
      globalMessageListener: global,
      messageListeners: { oc_changed: custom },
      groupMessageListenerOverrides: { oc_changed: { mode: 'disabled' } },
    }), 'oc_changed');
    expect(effective).toBeUndefined();
  });
});
