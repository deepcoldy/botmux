import { describe, expect, it, vi } from 'vitest';

import { withPlatformBotOwner } from '../src/core/bot-owner-attribution.js';
import type { TrustedCaller } from '../src/types.js';

const botCaller: TrustedCaller = {
  requestUserOpenId: 'ou_source_bot',
  requestUserUnionId: 'on_source_bot',
  requestLarkAppId: 'cli_target',
  senderType: 'bot',
};

describe('withPlatformBotOwner', () => {
  it('keeps the bot caller and attaches a separately verified owner', async () => {
    const result = await withPlatformBotOwner(botCaller, '/tmp/data', {
      resolveOwnerUnionId: () => ({ status: 'resolved', ownerUnionId: 'on_owner' }),
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
        source: 'platform_team',
      },
    });
  });

  it('never attributes a human turn or an unresolved bot', async () => {
    const resolveOwnerIdentity = vi.fn();
    const human = { ...botCaller, senderType: 'user' as const };
    await expect(withPlatformBotOwner(human, '/tmp/data', {
      resolveOwnerUnionId: () => ({ status: 'resolved', ownerUnionId: 'on_owner' }),
      resolveOwnerIdentity,
    })).resolves.toBe(human);
    await expect(withPlatformBotOwner(botCaller, '/tmp/data', {
      resolveOwnerUnionId: () => ({ status: 'conflict' }),
      resolveOwnerIdentity,
    })).resolves.toBe(botCaller);
    expect(resolveOwnerIdentity).not.toHaveBeenCalled();
  });

  it('fails closed when the target app cannot verify owner identity', async () => {
    await expect(withPlatformBotOwner(botCaller, '/tmp/data', {
      resolveOwnerUnionId: () => ({ status: 'resolved', ownerUnionId: 'on_owner' }),
      resolveOwnerIdentity: vi.fn(async () => undefined),
    })).resolves.toBe(botCaller);
  });

  it('attaches no owner when the Contact API omits a usable email', async () => {
    await expect(withPlatformBotOwner(botCaller, '/tmp/data', {
      resolveOwnerUnionId: () => ({ status: 'resolved', ownerUnionId: 'on_owner' }),
      resolveOwnerIdentity: vi.fn(async () => ({
        openId: 'ou_owner_target_scope',
        unionId: 'on_owner',
        type: 'user' as const,
      })),
    })).resolves.toBe(botCaller);
  });

  it('attaches no owner when the Contact API resolves a different union_id', async () => {
    await expect(withPlatformBotOwner(botCaller, '/tmp/data', {
      resolveOwnerUnionId: () => ({ status: 'resolved', ownerUnionId: 'on_owner' }),
      resolveOwnerIdentity: vi.fn(async () => ({
        openId: 'ou_other_target_scope',
        unionId: 'on_other',
        type: 'user' as const,
        email: 'other@bytedance.com',
      })),
    })).resolves.toBe(botCaller);
  });

  it('looks up the roster owner with (dataDir, target appId, source bot unionId) in that order', async () => {
    const resolveOwnerUnionId = vi.fn(() => ({ status: 'missing' as const }));
    await withPlatformBotOwner(botCaller, '/tmp/data', {
      resolveOwnerUnionId,
      resolveOwnerIdentity: vi.fn(),
    });
    // A swapped argument order passes the bot union as the app id and silently
    // disables the whole feature (it then always returns 'missing').
    expect(resolveOwnerUnionId).toHaveBeenCalledWith('/tmp/data', 'cli_target', 'on_source_bot');
  });
});
