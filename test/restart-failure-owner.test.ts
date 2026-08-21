/**
 * PR #843 R2 blocker guard: prove the fresh `botmux restart` CLI can actually
 * DM the owner on the MOST COMMON path (persisted ownerOpenId) — i.e. that the
 * owner resolver registers the sending bot so the real
 * `sendUserMessage → getBotClient → getBot` chain does NOT throw
 * `Bot not registered`.
 *
 * Unlike the notification state-machine test, this deliberately does NOT mock
 * getBotClient / sendText: it wires the REAL bot-registry and the REAL
 * client.ts sendUserMessage, mocking only the underlying Lark SDK transport.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only the Lark SDK transport. The Client stores creds and exposes a
// message.create that succeeds — enough for getBotClient to build a client and
// sendUserMessage to complete.
const createCalls: any[] = [];
vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    im = {
      v1: {
        message: {
          create: async (args: any) => {
            createCalls.push(args);
            return { code: 0, data: { message_id: 'om_real_registry_dm' } };
          },
        },
      },
    };
    constructor(opts: Record<string, unknown>) { this.opts = opts; }
    request = async () => ({ code: 0, data: { message_id: 'om_real_registry_dm' } });
  }
  return { Client: FakeClient, defaultHttpInstance: {} };
});

describe('resolveRestartFailureOwner registers the sending app (real registry)', () => {
  beforeEach(() => { createCalls.length = 0; });

  it('ownerOpenId fast path: registerBot runs so a real DM does not throw Bot not registered', async () => {
    vi.resetModules();
    const registry = await import('../src/bot-registry.js');
    const client = await import('../src/im/lark/client.js');
    const { resolveRestartFailureOwner } = await import('../src/cli/restart-failure-owner.js');

    registry.__testOnly_resetBotRegistry();

    const bot = {
      larkAppId: 'cli_owner_fast',
      larkAppSecret: 'secret',
      ownerOpenId: 'ou_owner_scope',
      name: 'relay',
    };

    // BEFORE resolution the app is unregistered: a DM would fail.
    await expect(client.sendUserMessage(bot.larkAppId, 'ou_owner_scope', 'x'))
      .rejects.toThrow(/Bot not registered/);

    // The resolver must register the sending app on the ownerOpenId path.
    const owner = await resolveRestartFailureOwner(bot, {
      registerBot: registry.registerBot,
      resolveAllowedUsers: client.resolveAllowedUsers,
    });
    expect(owner).toBe('ou_owner_scope');

    // AFTER resolution the real chain sends the DM without throwing.
    const messageId = await client.sendUserMessage(bot.larkAppId, owner!, 'notice');
    expect(messageId).toBe('om_real_registry_dm');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].data.receive_id).toBe('ou_owner_scope');
  });

  it('does not resolve (and does not leak an ou_) when only a bare ou_ is in allowedUsers', async () => {
    vi.resetModules();
    const registry = await import('../src/bot-registry.js');
    const client = await import('../src/im/lark/client.js');
    const { resolveRestartFailureOwner } = await import('../src/cli/restart-failure-owner.js');
    registry.__testOnly_resetBotRegistry();

    // No persisted ownerOpenId; allowedUsers holds only a literal ou_ which is
    // NOT app-proven, so it must be ignored (owner security boundary).
    const owner = await resolveRestartFailureOwner(
      { larkAppId: 'cli_no_owner', larkAppSecret: 'secret', allowedUsers: ['ou_from_other_app'] },
      { registerBot: registry.registerBot, resolveAllowedUsers: client.resolveAllowedUsers },
    );
    expect(owner).toBeUndefined();
  });
});
