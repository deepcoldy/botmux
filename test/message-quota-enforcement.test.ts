/**
 * Message quota enforcement wiring.
 * Run: pnpm vitest run test/message-quota-enforcement.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeQuota: vi.fn(),
  removeChatGrant: vi.fn(),
  removeGlobalGrant: vi.fn(),
  markChargedOnce: vi.fn(),
  commitCharge: vi.fn(),
  abortCharge: vi.fn(),
  buildQuotaExhaustedCard: vi.fn(),
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/services/grant-store.js', () => ({
  chatQuotaKey: (chatId: string, openId: string) => `chat:${chatId}:${openId}`,
  globalQuotaKey: (openId: string) => `global:${openId}`,
  addAllowedChatGroup: vi.fn(),
  addChatGrant: vi.fn(),
  addGlobalGrant: vi.fn(),
  consumeQuota: mocks.consumeQuota,
  removeAllowedChatGroup: vi.fn(),
  removeChatGrant: mocks.removeChatGrant,
  removeGlobalGrant: mocks.removeGlobalGrant,
  revokeGrant: vi.fn(),
}));

vi.mock('../src/services/quota-dedup.js', () => ({
  abortCharge: mocks.abortCharge,
  commitCharge: mocks.commitCharge,
  markChargedOnce: mocks.markChargedOnce,
}));

vi.mock('../src/im/lark/card-builder.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/card-builder.js');
  return { ...actual, buildQuotaExhaustedCard: mocks.buildQuotaExhaustedCard };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 1 })),
    getChatMode: vi.fn(async () => 'group'),
    listChatBotMembers: vi.fn(async () => []),
    replyMessage: mocks.replyMessage,
    resolveAllowedUsersWithMap: vi.fn(async (_appId: string, users: string[]) => ({ resolved: users, map: new Map() })),
    sendMessage: mocks.sendMessage,
    sendUserMessage: vi.fn(async () => 'om_dm'),
    updateMessage: vi.fn(async () => undefined),
  };
});

import { registerBot } from '../src/bot-registry.js';
import { parseSlashCommandInvocation } from '../src/core/command-handler.js';
import { enforceMessageQuotaForCliInput, grantRestrictedCommandText, grantRestrictedSlashCommandText } from '../src/daemon.js';

function registerQuotaBot() {
  const bot = registerBot({
    larkAppId: 'quota_app',
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: ['ou_owner'],
  });
  bot.resolvedAllowedUsers = ['ou_owner'];
  bot.config.chatGrants = { oc_1: ['ou_chat', 'ou_both'] };
  bot.config.globalGrants = ['ou_global', 'ou_both'];
}

describe('message quota enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markChargedOnce.mockReturnValue(true);
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: true });
    mocks.removeChatGrant.mockResolvedValue({ ok: true, removed: true });
    mocks.removeGlobalGrant.mockResolvedValue({ ok: true, removed: true });
    mocks.buildQuotaExhaustedCard.mockReturnValue('quota-card');
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_send');
    registerQuotaBot();
  });

  it('does not charge exempt allowedUsers', async () => {
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_owner', 'om_1', 'om_anchor'))
      .resolves.toBe(true);
    expect(mocks.markChargedOnce).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it('renders grant restriction text only for restricted per-user grantees', () => {
    expect(grantRestrictedCommandText('quota_app', 'oc_1', 'ou_chat', '/clear')).toBeUndefined();
    registerBot({
      larkAppId: 'quota_restrict',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      restrictGrantCommands: true,
    }).config.chatGrants = { oc_1: ['ou_chat'] };
    expect(grantRestrictedCommandText('quota_restrict', 'oc_1', 'ou_chat', '/clear')).toContain('/clear');
    expect(grantRestrictedCommandText('quota_restrict', 'oc_1', 'ou_owner', '/clear')).toBeUndefined();
  });

  it('blocks recognized slash-command shapes for restricted grantees only', () => {
    const bot = registerBot({
      larkAppId: 'quota_slash_restrict',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      allowedChatGroups: ['oc_team'],
      oncallChats: [{ chatId: 'oc_oncall', workingDir: '/tmp' }],
      restrictGrantCommands: true,
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.chatGrants = {
      oc_1: ['ou_chat'],
      oc_team: ['ou_team'],
      oc_oncall: ['ou_oncall'],
    };

    for (const content of ['/clear', '/btw note', '/somecliskill arg']) {
      const invocation = parseSlashCommandInvocation(content);
      expect(invocation).not.toBeNull();
      expect(grantRestrictedSlashCommandText('quota_slash_restrict', 'oc_1', 'ou_chat', invocation!.cmd)).toContain(invocation!.cmd);
    }
    const pathInvocation = parseSlashCommandInvocation('/etc/hosts 坏了');
    expect(pathInvocation).not.toBeNull();
    expect(grantRestrictedSlashCommandText('quota_slash_restrict', 'oc_1', 'ou_chat', pathInvocation!.cmd)).toBeUndefined();
    expect(grantRestrictedSlashCommandText('quota_slash_restrict', 'oc_1', 'ou_chat', '/路径')).toBeUndefined();
    expect(grantRestrictedSlashCommandText('quota_slash_restrict', 'oc_1', 'ou_chat', '/*note*/')).toBeUndefined();
    expect(grantRestrictedSlashCommandText('quota_slash_restrict', 'oc_1', 'ou_owner', '/clear')).toBeUndefined();
    expect(grantRestrictedSlashCommandText('quota_slash_restrict', 'oc_team', 'ou_team', '/clear')).toBeUndefined();
    expect(grantRestrictedSlashCommandText('quota_slash_restrict', 'oc_oncall', 'ou_oncall', '/clear')).toBeUndefined();
  });

  it('drops non-allowed senders when a caller bypassed dispatcher canTalk', async () => {
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_stranger', 'om_nope', 'om_anchor'))
      .resolves.toBe(false);
    expect(mocks.markChargedOnce).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it('allows the exhausting chat-grant message, then removes chat grant and notifies', async () => {
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: true, exhausted: true, used: 5, limit: 5 });
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_2', 'om_anchor'))
      .resolves.toBe(true);
    expect(mocks.consumeQuota).toHaveBeenCalledWith('quota_app', 'chat:oc_1:ou_chat');
    expect(mocks.commitCharge).toHaveBeenCalledWith('quota_app', 'om_2');
    expect(mocks.removeChatGrant).toHaveBeenCalledWith('quota_app', 'oc_1', 'ou_chat');
    expect(mocks.removeGlobalGrant).not.toHaveBeenCalled();
    expect(mocks.buildQuotaExhaustedCard).toHaveBeenCalledWith('ou_chat', 5, expect.any(String));
    expect(mocks.replyMessage).toHaveBeenCalledWith('quota_app', 'om_anchor', 'quota-card', 'interactive', true);
  });

  it('drops already-exhausted global-grant messages and self-heals the grant', async () => {
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: false, used: 5, limit: 5 });
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_9', 'ou_global', 'om_3', 'om_anchor'))
      .resolves.toBe(false);
    expect(mocks.consumeQuota).toHaveBeenCalledWith('quota_app', 'global:ou_global');
    expect(mocks.removeGlobalGrant).toHaveBeenCalledWith('quota_app', 'ou_global');
    expect(mocks.replyMessage).toHaveBeenCalled();
  });

  it('does not double-charge duplicate message ids', async () => {
    mocks.markChargedOnce.mockReturnValue(false);
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_dup', 'om_anchor'))
      .resolves.toBe(true);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it('fails closed when consume throws', async () => {
    mocks.consumeQuota.mockRejectedValue(new Error('lock timeout'));
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_4', 'om_anchor'))
      .resolves.toBe(false);
    expect(mocks.abortCharge).toHaveBeenCalledWith('quota_app', 'om_4');
    expect(mocks.commitCharge).not.toHaveBeenCalled();
  });

  it('aborts pending dedup on consume failure so a retry can charge again', async () => {
    mocks.consumeQuota
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockResolvedValueOnce({ tracked: true, allow: true, exhausted: false, used: 1, limit: 2 });

    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_retry', 'om_anchor'))
      .resolves.toBe(false);
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_retry', 'om_anchor'))
      .resolves.toBe(true);

    expect(mocks.markChargedOnce).toHaveBeenCalledTimes(2);
    expect(mocks.consumeQuota).toHaveBeenCalledTimes(2);
    expect(mocks.abortCharge).toHaveBeenCalledWith('quota_app', 'om_retry');
    expect(mocks.commitCharge).toHaveBeenCalledWith('quota_app', 'om_retry');
  });
});
