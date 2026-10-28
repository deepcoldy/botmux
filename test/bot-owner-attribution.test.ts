import { describe, expect, it, vi } from 'vitest';

import { withConfiguredBotOwner } from '../src/core/bot-owner-attribution.js';
import type { BotActorOwnerBinding } from '../src/core/bot-actor-owner-binding.js';
import type { TrustedCaller } from '../src/types.js';

const botCaller: TrustedCaller = {
  requestUserOpenId: 'ou_source_bot',
  requestUserUnionId: 'on_source_bot',
  requestLarkAppId: 'cli_target',
  senderType: 'bot',
};

const binding: BotActorOwnerBinding = {
  sourceBotOpenId: 'ou_source_bot',
  sourceBotUnionId: 'on_source_bot',
  ownerUnionId: 'on_owner',
  ownerEmail: 'owner@bytedance.com',
};

describe('withConfiguredBotOwner', () => {
  it('keeps the Bot caller and attaches a separately verified configured owner', async () => {
    const result = await withConfiguredBotOwner(botCaller, [binding], {
      resolveOwnerIdentity: vi.fn(async () => ({
        openId: 'ou_owner_target_scope',
        unionId: 'on_owner',
        type: 'user' as const,
        email: 'OWNER@BYTEDANCE.COM',
      })),
    });

    expect(result).toEqual({
      ...botCaller,
      botOwner: {
        openId: 'ou_owner_target_scope',
        unionId: 'on_owner',
        email: 'owner@bytedance.com',
        source: 'bot_config',
      },
    });
  });

  it('never attributes a human turn or an unbound Bot', async () => {
    const resolveOwnerIdentity = vi.fn();
    const human = { ...botCaller, senderType: 'user' as const };
    await expect(withConfiguredBotOwner(human, [binding], { resolveOwnerIdentity }))
      .resolves.toBe(human);
    await expect(withConfiguredBotOwner(
      { ...botCaller, requestUserUnionId: 'on_other_bot' },
      [binding],
      { resolveOwnerIdentity },
    )).resolves.toEqual({ ...botCaller, requestUserUnionId: 'on_other_bot' });
    expect(resolveOwnerIdentity).not.toHaveBeenCalled();
  });

  it('requires both Lark-attested source Bot ids to match one binding', async () => {
    const resolveOwnerIdentity = vi.fn();
    await expect(withConfiguredBotOwner(
      { ...botCaller, requestUserOpenId: 'ou_other_bot' },
      [binding],
      { resolveOwnerIdentity },
    )).resolves.not.toHaveProperty('botOwner');
    await expect(withConfiguredBotOwner(
      { ...botCaller, requestUserUnionId: undefined },
      [binding],
      { resolveOwnerIdentity },
    )).resolves.not.toHaveProperty('botOwner');
    expect(resolveOwnerIdentity).not.toHaveBeenCalled();
  });

  it('fails closed when the target app cannot verify owner identity', async () => {
    await expect(withConfiguredBotOwner(botCaller, [binding], {
      resolveOwnerIdentity: vi.fn(async () => undefined),
    })).resolves.toBe(botCaller);
  });

  it('attaches no owner when the Contact API omits a usable email', async () => {
    await expect(withConfiguredBotOwner(botCaller, [binding], {
      resolveOwnerIdentity: vi.fn(async () => ({
        openId: 'ou_owner_target_scope',
        unionId: 'on_owner',
        type: 'user' as const,
      })),
    })).resolves.toBe(botCaller);
  });

  it('attaches no owner when Contact resolves a different union_id or email', async () => {
    await expect(withConfiguredBotOwner(botCaller, [binding], {
      resolveOwnerIdentity: vi.fn(async () => ({
        openId: 'ou_other_target_scope',
        unionId: 'on_other',
        type: 'user' as const,
        email: 'owner@bytedance.com',
      })),
    })).resolves.toBe(botCaller);
    await expect(withConfiguredBotOwner(botCaller, [binding], {
      resolveOwnerIdentity: vi.fn(async () => ({
        openId: 'ou_owner_target_scope',
        unionId: 'on_owner',
        type: 'user' as const,
        email: 'other@bytedance.com',
      })),
    })).resolves.toBe(botCaller);
    await expect(withConfiguredBotOwner(botCaller, [binding], {
      resolveOwnerIdentity: vi.fn(async () => ({
        openId: 'on_wrong_kind',
        unionId: 'on_owner',
        type: 'user' as const,
        email: 'owner@bytedance.com',
      })),
    })).resolves.toBe(botCaller);
  });

  it('resolves the configured owner through the receiving app', async () => {
    const resolveOwnerIdentity = vi.fn(async () => undefined);
    await withConfiguredBotOwner(botCaller, [binding], { resolveOwnerIdentity });
    expect(resolveOwnerIdentity).toHaveBeenCalledWith('cli_target', 'on_owner');
  });
});
