/**
 * Message quota enforcement wiring.
 * Run: pnpm vitest run test/message-quota-enforcement.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeQuota: vi.fn(),
  removeChatGrant: vi.fn(),
  removeGlobalGrant: vi.fn(),
  beginCharge: vi.fn(),
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
  beginCharge: mocks.beginCharge,
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
    mocks.beginCharge.mockReturnValue('fresh');
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
    expect(mocks.beginCharge).not.toHaveBeenCalled();
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

    // 含 `/foo:bar`（冒号）与 `/1cmd`（首位数字）—— 它们是合法的 custom passthrough
    // 形状，受限闸的 shape 正则必须与 passthrough 同口径才拦得住，否则 grant-only
    // 用户能借已配置的此类命令绕过 restrictGrantCommands 直达 raw passthrough。
    for (const content of ['/clear', '/btw note', '/somecliskill arg', '/foo:bar x', '/1cmd y']) {
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
    expect(mocks.beginCharge).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it('allows the exhausting chat-grant message but defers revoke/notify to the next message', async () => {
    // exhausted=true 表示「本条刚好用完额度」——依旧放行给 AI 处理，但不在此时 revoke/notify
    // （避免给用户「本条已被拒绝」的错觉）；revoke + 通知推迟到下一条被 allow=false 拦截时再做。
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: true, exhausted: true, used: 5, limit: 5 });
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_2', 'om_anchor'))
      .resolves.toBe(true);
    expect(mocks.consumeQuota).toHaveBeenCalledWith('quota_app', 'chat:oc_1:ou_chat', undefined);
    expect(mocks.commitCharge).toHaveBeenCalledWith('quota_app', 'om_2');
    // 延迟通知：耗尽这一条不再立即 revoke / 发卡 / 通知
    expect(mocks.removeChatGrant).not.toHaveBeenCalled();
    expect(mocks.removeGlobalGrant).not.toHaveBeenCalled();
    expect(mocks.buildQuotaExhaustedCard).not.toHaveBeenCalled();
    expect(mocks.replyMessage).not.toHaveBeenCalled();
  });

  it('drops already-exhausted global-grant messages and self-heals the grant', async () => {
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: false, used: 5, limit: 5 });
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_9', 'ou_global', 'om_3', 'om_anchor'))
      .resolves.toBe(false);
    expect(mocks.consumeQuota).toHaveBeenCalledWith('quota_app', 'global:ou_global', undefined);
    expect(mocks.removeGlobalGrant).toHaveBeenCalledWith('quota_app', 'ou_global');
    expect(mocks.replyMessage).toHaveBeenCalled();
  });

  // Regression (codex round-2 blocker): a denied (allow=false) message must ABORT the dedup
  // entry, never commit it to `done`. Committing a denied id would let a redelivery skip the
  // quota check and slip into the CLI when self-heal revoke fails/races → hard-cap bypass.
  it('a denied message aborts the dedup entry instead of committing it to done', async () => {
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: false, used: 5, limit: 5 });
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_denied', 'om_anchor'))
      .resolves.toBe(false);
    expect(mocks.abortCharge).toHaveBeenCalledWith('quota_app', 'om_denied');
    expect(mocks.commitCharge).not.toHaveBeenCalled();
  });

  it('allows a done-deduped redelivery without re-charging (same message already charged)', async () => {
    mocks.beginCharge.mockReturnValue('done');
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_dup', 'om_anchor'))
      .resolves.toBe(true);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  // Regression (codex round-2): a redelivery that races an in-flight charge (pending) must be
  // dropped fail-closed — NOT allowed through uncharged before the first charge settles.
  it('drops a pending-dedup redelivery fail-closed without consuming or committing', async () => {
    mocks.beginCharge.mockReturnValue('pending');
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_inflight', 'om_anchor'))
      .resolves.toBe(false);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.commitCharge).not.toHaveBeenCalled();
    expect(mocks.abortCharge).not.toHaveBeenCalled();
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

    expect(mocks.beginCharge).toHaveBeenCalledTimes(2);
    expect(mocks.consumeQuota).toHaveBeenCalledTimes(2);
    expect(mocks.abortCharge).toHaveBeenCalledWith('quota_app', 'om_retry');
    expect(mocks.commitCharge).toHaveBeenCalledWith('quota_app', 'om_retry');
  });
});
