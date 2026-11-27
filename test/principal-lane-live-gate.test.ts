import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testOnly_dispatchHumanMessageViaHandlers,
  type EventHandlers,
  type RoutingContext,
} from '../src/im/lark/event-dispatcher.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';

const ctx: RoutingContext = {
  chatId: 'oc_group', messageId: 'om_1', chatType: 'group', scope: 'chat',
  anchor: 'oc_group', larkAppId: 'app',
};

function handlers(laneResult: boolean): EventHandlers & {
  handlePrincipalLaneMessage: ReturnType<typeof vi.fn>;
  handleThreadReply: ReturnType<typeof vi.fn>;
  handleNewTopic: ReturnType<typeof vi.fn>;
} {
  return {
    handleCardAction: vi.fn(async () => undefined),
    handlePrincipalLaneMessage: vi.fn(async () => laneResult),
    handleThreadReply: vi.fn(async () => undefined),
    handleNewTopic: vi.fn(async () => undefined),
  };
}

describe('principal lane live dispatch gate', () => {
  beforeEach(() => {
    __testOnly_resetBotRegistry();
  });

  afterEach(() => {
    __testOnly_resetBotRegistry();
  });

  it('bypasses the visible-anchor serializer path when the lane owns the turn', async () => {
    const h = handlers(true);
    await __testOnly_dispatchHumanMessageViaHandlers('app', h, {
      data: {}, ctx, ownsSession: true,
    }, 0);
    expect(h.handlePrincipalLaneMessage).toHaveBeenCalledOnce();
    expect(h.handleThreadReply).not.toHaveBeenCalled();
    expect(h.handleNewTopic).not.toHaveBeenCalled();
  });

  it('preserves legacy routing when the lane adapter declines', async () => {
    const h = handlers(false);
    await __testOnly_dispatchHumanMessageViaHandlers('app', h, {
      data: {}, ctx: { ...ctx, messageId: 'om_2' }, ownsSession: true,
    }, 0);
    expect(h.handleThreadReply).toHaveBeenCalledOnce();
  });

  it('does not require a registered bot to evaluate the private Oncall intake guard', async () => {
    const h = handlers(true);
    await expect(__testOnly_dispatchHumanMessageViaHandlers('app', h, {
      data: {}, ctx: { ...ctx, messageId: 'om_3' }, ownsSession: true,
    }, 0)).resolves.toBeUndefined();
    expect(h.handlePrincipalLaneMessage).toHaveBeenCalledOnce();
  });

  it('suppresses group dispatch for a chat configured as private Oncall intake', async () => {
    registerBot({
      larkAppId: 'app', larkAppSecret: 's', cliId: 'claude-code',
      oncallGroup: { enabled: true, chatIds: ['oc_group'], privateIntakeChatIds: ['oc_group'] },
    } as any);
    const h = handlers(true);
    await __testOnly_dispatchHumanMessageViaHandlers('app', h, {
      data: {}, ctx: { ...ctx, messageId: 'om_4' }, ownsSession: true,
    }, 0);
    expect(h.handlePrincipalLaneMessage).not.toHaveBeenCalled();
    expect(h.handleThreadReply).not.toHaveBeenCalled();
    expect(h.handleNewTopic).not.toHaveBeenCalled();
  });
});
