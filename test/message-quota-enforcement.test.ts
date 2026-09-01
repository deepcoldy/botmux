/**
 * Message quota enforcement wiring.
 * Run: pnpm vitest run test/message-quota-enforcement.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeQuota: vi.fn(),
  removeChatGrant: vi.fn(),
  removeGlobalGrant: vi.fn(),
  getGrantExpiresAt: vi.fn(),
  removeExpiredGrant: vi.fn(),
  beginCharge: vi.fn(),
  commitCharge: vi.fn(),
  abortCharge: vi.fn(),
  buildQuotaExhaustedCard: vi.fn(),
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
  // 路由级用例（p2pMode='group' 建群前扣费点）用：建群这一外部副作用换成 spy，
  // 既能断言「扣费在建群之前」，又不把整条新会话链路拖进这个配额单测。
  maybeBirthSessionGroup: vi.fn(),
  resolveSender: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/services/grant-store.js', () => ({
  chatQuotaKey: (chatId: string, openId: string) => `chat:${chatId}:${openId}`,
  globalQuotaKey: (openId: string) => `global:${openId}`,
  getGrantExpiresAt: mocks.getGrantExpiresAt,
  addAllowedChatGroup: vi.fn(),
  addChatGrant: vi.fn(),
  addGlobalGrant: vi.fn(),
  consumeQuota: mocks.consumeQuota,
  removeAllowedChatGroup: vi.fn(),
  removeChatGrant: mocks.removeChatGrant,
  removeGlobalGrant: mocks.removeGlobalGrant,
  removeExpiredGrant: mocks.removeExpiredGrant,
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

// 建群副作用替身。斜杠命令判定谓词
// （declinesSessionGroupBirthAsSlashCommand）保持真身——它正是被测对象之一：
// daemon 与 birth 必须用同一个谓词，才不会一边扣费一边拒绝建群。
vi.mock('../src/core/session-group-birth.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-group-birth.js');
  return { ...actual, maybeBirthSessionGroup: (...args: any[]) => mocks.maybeBirthSessionGroup(...args) };
});

// 私聊路径会解析发送者显示名；这里不做联系人 API 调用。
vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

// 团队拉群（bot 免 /grant 的信任根）。只把 oc_team_group 标成拉群，其余不变。
vi.mock('../src/services/team-groups-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/team-groups-store.js');
  return { ...actual, isTeamGroupChat: (_dataDir: string, chatId?: string) => chatId === 'oc_team_group' };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { parseSlashCommandInvocation } from '../src/core/command-handler.js';
import {
  enforceMessageQuotaForCliInput,
  grantRestrictedCommandText,
  grantRestrictedSlashCommandText,
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

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
    mocks.getGrantExpiresAt.mockReturnValue(undefined);
    mocks.removeExpiredGrant.mockResolvedValue({ ok: true, removed: true });
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

  it('checks talk permission but does not charge a setup-only message', async () => {
    await expect(enforceMessageQuotaForCliInput(
      'quota_app', 'oc_1', 'ou_chat', 'om_setup', 'om_anchor',
      undefined, undefined, 'group', false, { skipCharge: true },
    )).resolves.toBe(true);
    expect(mocks.beginCharge).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();

    await expect(enforceMessageQuotaForCliInput(
      'quota_app', 'oc_1', 'ou_stranger', 'om_setup_denied', 'om_anchor',
      undefined, undefined, 'group', false, { skipCharge: true },
    )).resolves.toBe(false);
    expect(mocks.beginCharge).not.toHaveBeenCalled();
  });

  it('bot 发送方走 evaluateBotTalk：团队拉群里没带 union_id 也不被这道复查丢掉', async () => {
    // 端到端断点（#332 同款的最后一截）：dispatcher 外层用 evaluateBotTalk 放行了
    // 「团队拉群 + sender 没带 union_id」的 bot，这里若仍用 evaluateTalk 就会静默丢弃
    // ——比弹授权卡更糟，owner 以为放行了、消息凭空消失。两道闸必须同一个谓词。
    await expect(
      enforceMessageQuotaForCliInput(
        'quota_app', 'oc_team_group', 'ou_foreign_bot', 'om_bot_no_union', 'om_anchor',
        undefined, undefined, 'group', true,
      ),
    ).resolves.toBe(true);
  });

  it('同一条消息不标 bot（人的路径）仍按 evaluateTalk 拦下——团队拉群不放行真人', async () => {
    // 反向锁：证明放行来自 botSender 这一腿，而不是把闸门整体放宽了。
    // 团队拉群对真人不是 talk 来源（真人走 teamMember 腿，要 union 在团队成员名单里）。
    await expect(
      enforceMessageQuotaForCliInput(
        'quota_app', 'oc_team_group', 'ou_human', 'om_human_no_union', 'om_anchor',
        undefined, undefined, 'group',
      ),
    ).resolves.toBe(false);
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

  it('rejects an expired grant before quota charging and schedules conditional cleanup', async () => {
    const expiredAt = Date.now() - 1;
    mocks.getGrantExpiresAt.mockReturnValue(expiredAt);
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_expired', 'om_anchor'))
      .resolves.toBe(false);
    expect(mocks.beginCharge).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.removeExpiredGrant).toHaveBeenCalledWith(
      'quota_app',
      'chat',
      'oc_1',
      'ou_chat',
      expiredAt,
    );
  });

  it('allows a sender already authorized by a message listener match', async () => {
    await expect(enforceMessageQuotaForCliInput(
      'quota_app',
      'oc_1',
      undefined,
      'om_listener',
      'om_anchor',
      undefined,
      undefined,
      'group',
      undefined,
      { listenerAuthorized: true },
    )).resolves.toBe(true);
    expect(mocks.beginCharge).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it('allows the exhausting chat-grant message but defers revoke/notify to the next message', async () => {
    // exhausted=true 表示「本条刚好用完额度」——依旧放行给 AI 处理，但不在此时 revoke/notify
    // （避免给用户「本条已被拒绝」的错觉）；revoke + 通知推迟到下一条被 allow=false 拦截时再做。
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: true, exhausted: true, used: 5, limit: 5 });
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_2', 'om_anchor'))
      .resolves.toBe(true);
    expect(mocks.consumeQuota).toHaveBeenCalledWith('quota_app', 'chat:oc_1:ou_chat', undefined, undefined);
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
    expect(mocks.consumeQuota).toHaveBeenCalledWith('quota_app', 'global:ou_global', undefined, undefined);
    expect(mocks.removeGlobalGrant).toHaveBeenCalledWith('quota_app', 'ou_global');
    expect(mocks.replyMessage).toHaveBeenCalled();
  });

  it('P1: explicit-unlimited grant is NOT re-capped by messageQuota.defaultLimit', async () => {
    // 复现 codex 抓的回归：配了默认额度时，卡片选「不限」/裸 /grant 授的授权在磁盘上无
    // quota 记录（= 显式不限）。enforce 绝不能把 defaultLimit 传给 consumeQuota，否则首条
    // 消息会 lazy-init 出 {limit:def} 把「不限」静默限成 def 条。断言：grant 路径下 def=undefined。
    getBot('quota_app').config.messageQuota = { defaultLimit: 7 };
    mocks.consumeQuota.mockResolvedValue({ tracked: false, allow: true }); // 无记录 → 不限放行
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_unlim', 'om_anchor'))
      .resolves.toBe(true);
    // 关键断言：即便配了 defaultLimit=7，grant 路径仍传 undefined（不 lazy-init）
    expect(mocks.consumeQuota).toHaveBeenCalledWith('quota_app', 'chat:oc_1:ou_chat', undefined, undefined);
  });

  it('oncall still lazy-inits with messageQuota.defaultLimit (fix does not touch oncall)', async () => {
    // 反向保护：oncall 命中时没有预落库的额度记录，defaultLimit 的 lazy-init 必须仍然生效，
    // 否则本次 P1 修复会误伤 oncall 默认额度。断言：oncall 路径把 def=7 传给 consumeQuota。
    const oncall = registerBot({
      larkAppId: 'oncall_app',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      oncallChats: [{ chatId: 'oc_oncall', workingDir: '/tmp' }],
      messageQuota: { defaultLimit: 7 },
    });
    oncall.resolvedAllowedUsers = ['ou_owner'];
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: true });
    await expect(enforceMessageQuotaForCliInput('oncall_app', 'oc_oncall', 'ou_visitor', 'om_oncall', 'om_anchor'))
      .resolves.toBe(true);
    expect(mocks.consumeQuota).toHaveBeenCalledWith('oncall_app', 'chat:oc_oncall:ou_visitor', 7, undefined);
  });

  it('P1 intersection: oncall ∩ explicit-unlimited chatGrant is NOT re-capped by defaultLimit', async () => {
    // codex delta round-2 抓的交集角落：群同时是 oncallChat + 配了 defaultLimit，且用户还持有
    // 一条显式不限 chatGrant。evaluateTalk 先命中 oncall（reason='oncall'），与 chatGrant 共用
    // 同一把 chat quotaKey。只看 reason 的 gate 会误传 def → 把「显式不限」lazy-init 回 default。
    // 断言：explicitGrantOverride 令交集也传 def=undefined。
    const bot = registerBot({
      larkAppId: 'isect_app',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      oncallChats: [{ chatId: 'oc_isect', workingDir: '/tmp' }],
      messageQuota: { defaultLimit: 7 },
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    // 显式不限 chatGrant：有 chatGrants 成员但无 quotaState 记录
    bot.config.chatGrants = { oc_isect: ['ou_x'] };
    mocks.consumeQuota.mockResolvedValue({ tracked: false, allow: true });
    await expect(enforceMessageQuotaForCliInput('isect_app', 'oc_isect', 'ou_x', 'om_isect', 'om_anchor'))
      .resolves.toBe(true);
    // 关键断言：交集下也不兜 default（否则「显式不限」被套回 7）
    expect(mocks.consumeQuota).toHaveBeenCalledWith('isect_app', 'chat:oc_isect:ou_x', undefined, undefined);
  });

  it('P1 expired intersection: oncall ∩ EXPIRED chatGrant passes expiredGrant descriptor + default into consumeQuota (one atomic call)', async () => {
    // 清理+额度决策收口进 consumeQuota 同一把锁。daemon 不单独 await removeExpiredGrant，
    // 而是把 expiredGrant 描述符 + 拟回落 def 一起传给 consumeQuota，由它锁内以当前 expiry 定夺。
    // 断言：consume 收到 (quotaKey, def=7, expiredGrant{scope,chatId,openId})。
    const bot = registerBot({
      larkAppId: 'exp_app',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      oncallChats: [{ chatId: 'oc_exp', workingDir: '/tmp' }],
      messageQuota: { defaultLimit: 7 },
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.chatGrants = { oc_exp: ['ou_x'] };            // 成员仍在
    const expiredAt = Date.now() - 1;
    mocks.getGrantExpiresAt.mockReturnValue(expiredAt);       // evaluateTalk 观察到过期
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: true, used: 1, limit: 7 });

    await expect(enforceMessageQuotaForCliInput('exp_app', 'oc_exp', 'ou_x', 'om_exp', 'om_anchor'))
      .resolves.toBe(true);
    // 不再单独调 removeExpiredGrant；清理描述符随 consumeQuota 一把锁传入
    expect(mocks.removeExpiredGrant).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).toHaveBeenCalledWith(
      'exp_app', 'chat:oc_exp:ou_x', 7,
      { scope: 'chat', chatId: 'oc_exp', openId: 'ou_x' },
    );
  });

  it('P1 fail-closed: consumeQuota throwing (RMW/cleanup infra failure) drops the message + aborts charge', async () => {
    // codex delta round-5：清理+扣费收口进 consumeQuota，其 RMW 失败会 throw；enforce 必须
    // catch→abortCharge→返回 false（fail-closed），绝不因基础设施失败继续放行。
    const bot = registerBot({
      larkAppId: 'fc_app',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      oncallChats: [{ chatId: 'oc_fc', workingDir: '/tmp' }],
      messageQuota: { defaultLimit: 7 },
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.chatGrants = { oc_fc: ['ou_x'] };
    mocks.getGrantExpiresAt.mockReturnValue(Date.now() - 1);   // 过期 → 走 expiredGrant 路径
    mocks.consumeQuota.mockRejectedValue(new Error('RMW failed'));
    await expect(enforceMessageQuotaForCliInput('fc_app', 'oc_fc', 'ou_x', 'om_fc', 'om_anchor'))
      .resolves.toBe(false);
    expect(mocks.abortCharge).toHaveBeenCalledWith('fc_app', 'om_fc');
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

  // ─── 任务模式：bot↔bot 编排流量旁路消息额度 ───────────────────────────────
  // 监管者↔worker 的派活/回报/对账/求助/升级是系统编排流量；能不能发由授权闸控制，
  // 但不该被「按条扣的人类消息额度」烧穿导致 worker 中途被收回授权、任务卡死。
  it('bot/app orchestration traffic bypasses message quota (chat grant)', async () => {
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_chat', 'om_bot1', 'om_anchor', undefined, undefined, undefined, true))
      .resolves.toBe(true);
    // 旁路发生在扣费之前：beginCharge / consumeQuota 都不应触发
    expect(mocks.beginCharge).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it('bot-sender bypass also covers oncall chats carrying a default quota', async () => {
    const bot = registerBot({
      larkAppId: 'quota_oncall',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      oncallChats: [{ chatId: 'oc_oncall', workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.messageQuota = { defaultLimit: 5 };
    // 真人在 oncall 群（配了 defaultLimit）→ 照常按条扣额度
    await expect(enforceMessageQuotaForCliInput('quota_oncall', 'oc_oncall', 'ou_human', 'om_h', 'om_anchor'))
      .resolves.toBe(true);
    expect(mocks.consumeQuota).toHaveBeenCalledWith('quota_oncall', 'chat:oc_oncall:ou_human', 5, undefined);
    mocks.consumeQuota.mockClear();
    // 同一 oncall 群里的 bot worker → 旁路，不扣额度
    await expect(enforceMessageQuotaForCliInput('quota_oncall', 'oc_oncall', 'ou_botworker', 'om_b', 'om_anchor', undefined, undefined, undefined, true))
      .resolves.toBe(true);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });

  it('a bot sender that cannot talk is still dropped (bypass skips quota, not the talk gate)', async () => {
    await expect(enforceMessageQuotaForCliInput('quota_app', 'oc_1', 'ou_stranger', 'om_botnope', 'om_anchor', undefined, undefined, undefined, true))
      .resolves.toBe(false);
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
  });
});

/**
 * 路由级回归：p2pMode='group' 的「建群前扣费点」必须在**识别斜杠命令之后**才扣。
 *
 * 这个扣费点的存在理由是「扣费被拒必须零外部副作用」——所以它刻意排在
 * createGroupWithBots 之前，也就远在路由自己的 parseSlashCommandInvocation 之前。
 * 于是私聊 group 模式下 /help、/login、/close 这类**根本不进 CLI**的 daemon 命令
 * 会被白扣一次额度；额度耗尽时更糟：这道闸直接 return，命令连执行都执行不到
 * （p2pMode='thread' 默认模式没有这个问题，它的扣费点本来就在命令分支之后）。
 *
 * 修法是把 birth 自己的「斜杠命令不建群」判定提到扣费之前（同一个谓词，
 * declinesSessionGroupBirthAsSlashCommand），命令因此既不扣费也不受额度拦截；
 * 真正会注入 CLI 的消息扣费行为一字不变。
 */
describe("p2pMode='group' 建群前扣费点：命令判定必须早于扣费", () => {
  const APP = 'quota_p2p_group_app';
  const DM_CHAT = 'oc_dm_quota';
  const GRANTEE = 'ou_grantee';

  function dmEvent(text: string, messageId: string): any {
    return {
      sender: { sender_id: { open_id: GRANTEE }, sender_type: 'user' },
      message: {
        message_id: messageId,
        chat_id: DM_CHAT,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: String(Date.now()),
      },
    };
  }

  /** 建群种子形状：顶层新私聊消息（thread scope 且 anchor === messageId、无 thread_id）。 */
  function dmCtx(messageId: string): RoutingContext {
    return {
      chatId: DM_CHAT,
      messageId,
      chatType: 'p2p',
      scope: 'thread',
      anchor: messageId,
      larkAppId: APP,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginCharge.mockReturnValue('fresh');
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: true, exhausted: false, used: 1, limit: 3 });
    mocks.getGrantExpiresAt.mockReturnValue(undefined);
    mocks.buildQuotaExhaustedCard.mockReturnValue('quota-card');
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_send');
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      p2pMode: 'group',
    } as any);
    bot.resolvedAllowedUsers = ['ou_owner'];
    // 全局对话授权 → 有 quotaKey（allowedUsers 是免额度的，测不到扣费）。
    bot.config.globalGrants = [GRANTEE];
    // 把 /help 降到 canTalk，否则 grant-only 用户会先被 canRunDaemonCommand 拦掉，
    // 「额度耗尽仍能执行命令」这一半就测不出来。
    bot.config.canTalkDaemonCommands = ['/help'];
    activeSessions.clear();
    mocks.maybeBirthSessionGroup.mockResolvedValue(null);
    mocks.resolveSender.mockImplementation(async (_appId: string, openId?: string) => (
      openId ? { openId, type: 'user' as const } : undefined
    ));
  });

  it('/help 不扣额度、也不触发建群（命令本来不进 CLI）', async () => {
    await handleNewTopic(dmEvent('/help', 'om_help'), dmCtx('om_help'));

    expect(mocks.beginCharge).not.toHaveBeenCalled();
    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    expect(mocks.maybeBirthSessionGroup).not.toHaveBeenCalled();
    // 命令确实被执行了（回了帮助文本），不是被静默吞掉。
    expect(mocks.replyMessage).toHaveBeenCalled();
  });

  it('额度耗尽时 /help 依然可执行，不被这道闸拦掉', async () => {
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: false, exhausted: true, used: 3, limit: 3 });

    await handleNewTopic(dmEvent('/help', 'om_help_exhausted'), dmCtx('om_help_exhausted'));

    expect(mocks.consumeQuota).not.toHaveBeenCalled();
    // 没有弹「额度已用完」卡 → 说明命令没被当成 CLI 输入拦下。
    expect(mocks.buildQuotaExhaustedCard).not.toHaveBeenCalled();
    expect(mocks.replyMessage).toHaveBeenCalled();
  });

  it('普通消息照常扣费，且扣费仍排在建群这个外部副作用之前', async () => {
    // 建群之后是整条新会话链路（repo 卡 / spawn），不是本用例的被测对象：
    // 让替身在扣费点之后立刻断流，用例只盯「扣了费、且扣在建群前」。
    mocks.maybeBirthSessionGroup.mockRejectedValue(new Error('stop-after-charge'));

    await expect(handleNewTopic(dmEvent('帮我看下这个报错', 'om_plain'), dmCtx('om_plain')))
      .rejects.toThrow('stop-after-charge');

    expect(mocks.beginCharge).toHaveBeenCalledTimes(1);
    expect(mocks.consumeQuota).toHaveBeenCalledTimes(1);
    expect(mocks.consumeQuota.mock.calls[0][1]).toBe(`global:${GRANTEE}`);
    expect(mocks.maybeBirthSessionGroup).toHaveBeenCalledTimes(1);
    expect(mocks.consumeQuota.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.maybeBirthSessionGroup.mock.invocationCallOrder[0]);
  });

  it('普通消息额度耗尽 → 拦下且不建群（扣费被拒零外部副作用）', async () => {
    mocks.consumeQuota.mockResolvedValue({ tracked: true, allow: false, exhausted: true, used: 3, limit: 3 });

    await handleNewTopic(dmEvent('继续', 'om_plain_exhausted'), dmCtx('om_plain_exhausted'));

    expect(mocks.consumeQuota).toHaveBeenCalledTimes(1);
    expect(mocks.maybeBirthSessionGroup).not.toHaveBeenCalled();
    expect(mocks.buildQuotaExhaustedCard).toHaveBeenCalled();
  });
});
