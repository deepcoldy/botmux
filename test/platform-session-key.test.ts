import { describe, expect, it } from 'vitest';
import {
  createPlatformSessionContext,
  platformSessionKey,
  sessionKey,
} from '../src/core/types.js';

describe('platform session identity', () => {
  it('keeps every legacy Lark session key byte-for-byte identical', () => {
    const ref = { platform: 'lark' as const, instanceId: 'cli_app_test' };
    expect(platformSessionKey('om_root', ref)).toBe('om_root::cli_app_test');
    expect(sessionKey('om_root', ref)).toBe(sessionKey('om_root', 'cli_app_test'));
  });

  it('namespaces future platforms so equal anchors and instance ids cannot collide', () => {
    expect(platformSessionKey('root', { platform: 'discord', instanceId: 'same' }))
      .toBe('platform:["discord","same","root"]');
    expect(platformSessionKey('root', { platform: 'discord', instanceId: 'same' }))
      .not.toBe(platformSessionKey('root', { platform: 'lark', instanceId: 'same' }));
  });

  it('captures chat/thread routing without changing persisted Session data', () => {
    const instance = { platform: 'lark' as const, instanceId: 'cli_app_test' };
    const chat = createPlatformSessionContext(instance, 'oc_chat', 'group', 'chat', 'om_seed');
    const thread = createPlatformSessionContext(instance, 'oc_chat', 'group', 'thread', 'om_root');

    expect(chat.conversation).toMatchObject({ scope: 'chat', anchorId: 'oc_chat' });
    expect(chat.conversation.threadRootId).toBeUndefined();
    expect(thread.conversation).toMatchObject({ scope: 'thread', anchorId: 'om_root', threadRootId: 'om_root' });
  });
});
