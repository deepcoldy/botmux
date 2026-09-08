/**
 * p2pOpen：私聊对话全开（talk-only），管理权仍限 allowedUsers。
 * Run: pnpm vitest run test/p2p-open.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { canTalk, canOperate, evaluateTalk } from '../src/im/lark/event-dispatcher.js';

describe('p2pOpen', () => {
  beforeEach(() => {
    const bot = registerBot({ larkAppId: 'p1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.allowedChatGroups = undefined;
    bot.config.chatGrants = undefined;
    bot.config.globalGrants = undefined;
    bot.config.p2pOpen = true;
  });

  it('陌生人在私聊里可以对话', () => {
    expect(canTalk('p1', 'oc_dm', 'ou_stranger', undefined, undefined, 'p2p')).toBe(true);
    expect(evaluateTalk('p1', 'oc_dm', 'ou_stranger', undefined, undefined, 'p2p').reason).toBe('p2pOpen');
  });

  it('但陌生人拿不到任何管理权（canOperate 不读 p2pOpen）', () => {
    expect(canOperate('p1', 'oc_dm', 'ou_stranger')).toBe(false);
    expect(canOperate('p1', 'oc_dm', 'ou_owner')).toBe(true);
  });

  it('p2pOpen 不放开群聊：同一个人在群里仍被挡', () => {
    expect(canTalk('p1', 'oc_group', 'ou_stranger', undefined, undefined, 'group')).toBe(false);
  });

  it('chatType 缺省时按原语义（不放行）——保证未接入 chatType 的调用点不 fail-open', () => {
    expect(canTalk('p1', 'oc_dm', 'ou_stranger')).toBe(false);
  });

  it('owner 不受影响：私聊仍可对话并操作', () => {
    expect(canTalk('p1', 'oc_dm', 'ou_owner', undefined, undefined, 'p2p')).toBe(true);
    expect(canOperate('p1', 'oc_dm', 'ou_owner')).toBe(true);
  });

  it('未配 p2pOpen 的 bot：私聊仍按白名单挡人（存量零影响）', () => {
    getBot('p1').config.p2pOpen = undefined;
    expect(canTalk('p1', 'oc_dm', 'ou_stranger', undefined, undefined, 'p2p')).toBe(false);
    expect(canTalk('p1', 'oc_dm', 'ou_owner', undefined, undefined, 'p2p')).toBe(true);
  });

  it('未配 p2pOpen 且三张名单全空 → 仍是既有的「开放模式」（存量语义，不在本 PR 改）', () => {
    const bot = registerBot({ larkAppId: 'p2', larkAppSecret: 's', cliId: 'claude-code' });
    bot.resolvedAllowedUsers = [];
    expect(canTalk('p2', 'oc_x', 'ou_anyone', undefined, undefined, 'group')).toBe(true);
    expect(canOperate('p2', 'oc_x', 'ou_anyone')).toBe(true);
  });

  // 最危险的配置：只写了 p2pOpen，忘了配 allowedUsers。p2pOpen 必须本身就算「已配权限边界」，
  // 否则会 fall through 到开放模式 —— 群聊被放开、陌生人还能 /restart /cd（提权），
  // 与 p2pOpen「只开私聊 talk」的语义完全相反。
  it('只配 p2pOpen、没配 allowedUsers：私聊开、群聊仍关、任何人都不能 operate（fail-closed）', () => {
    const bot = registerBot({ larkAppId: 'p3', larkAppSecret: 's', cliId: 'claude-code', p2pOpen: true });
    bot.resolvedAllowedUsers = [];
    expect(canTalk('p3', 'oc_dm', 'ou_anyone', undefined, undefined, 'p2p')).toBe(true);
    expect(canTalk('p3', 'oc_group', 'ou_anyone', undefined, undefined, 'group')).toBe(false);
    expect(canOperate('p3', 'oc_dm', 'ou_anyone')).toBe(false);
    expect(canOperate('p3', 'oc_group', 'ou_anyone')).toBe(false);
  });

  // /quote 的 confirm 按钮能触发真实 CLI turn（sendWorkerInput / forkWorker），
  // 所以点击时要现场复查权限。这里钉住 chatType 被传进那道复查：漏了它，
  // canRunDaemonCommand 的 p2pOpen 腿失效（docstring 明写 chatType 省略即 fail-closed），
  // 配了 p2pOpen 的 bot 在私聊里会变成「卡片能召唤、点确认永远被拒」。
  // 与上面「chatType 缺省时按原语义（不放行）」是同一道防线在新调用点上的延续。
  it('/quote confirm 的权限复查把 chatType 传进 canRunDaemonCommand', () => {
    const source = readFileSync(new URL('../src/im/lark/card-handler.ts', import.meta.url), 'utf8');
    const start = source.indexOf("if (value?.action === 'quote_confirm'");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, start + 4000);
    // 闸必须在，且必须真的是「取反后守卫一个 return」的形状。
    // 只断言 `canRunDaemonCommand(` 出现是不够的：我实测把条件改成
    // `if (false && !canRunDaemonCommand(...))` 时那种断言照样绿——调用还在，
    // 但闸已失效。所以这里钉住 `if (!canRunDaemonCommand(` 这个开头，
    // 并要求它后面紧跟着拒绝分支。
    expect(block).toMatch(/if \(!canRunDaemonCommand\(/);
    // chatType 实参必须是 ds.chatType，不能省（省了 p2pOpen 腿失效）
    expect(block).toMatch(/if \(!canRunDaemonCommand\([\s\S]*?ds\.chatType,\s*\)\) \{/);
    // 命中时必须拒绝（返回 toast），不能只记日志放行
    const gateBody = block.slice(block.indexOf('if (!canRunDaemonCommand('));
    expect(gateBody.slice(0, 600)).toMatch(/return \{ toast:/);
  });

  // operator 缺失时必须拒绝。re-render 分支已经是 fail-closed（要求 operatorOpenId），
  // 而 confirm 是真正触发 CLI turn 的那条，不能比它更松。
  it('/quote confirm 的 invoker 校验在 operator 缺失时 fail-closed', () => {
    const source = readFileSync(new URL('../src/im/lark/card-handler.ts', import.meta.url), 'utf8');
    const start = source.indexOf("if (value?.action === 'quote_confirm'");
    const block = source.slice(start, start + 4000);
    // 必须以 !operatorOpenId 起头短路；旧形状 `invokerOpenId && operatorOpenId && …`
    // 在 operator 缺失时整个条件为 false，等于放行。
    expect(block).toMatch(/if \(!operatorOpenId \|\| \(invokerOpenId && invokerOpenId !== operatorOpenId\)\)/);
    expect(block).not.toMatch(/if \(invokerOpenId && operatorOpenId && invokerOpenId !== operatorOpenId\)/);
  });

  it('/quote confirm 用命令入口的同一个谓词，不是硬 canOperate', () => {
    // canRunDaemonCommand = canOperate ∪ (cmd ∈ canTalkDaemonCommands && canTalk)。
    // /quote 可以被 owner 配进 canTalkDaemonCommands 交给 talk-only 用户，此时若
    // confirm 处用硬 canOperate，这类 bot 上会「能召唤、点确认必拒」。
    const source = readFileSync(new URL('../src/im/lark/card-handler.ts', import.meta.url), 'utf8');
    const start = source.indexOf("if (value?.action === 'quote_confirm'");
    const block = source.slice(start, start + 4000);
    const gate = block.slice(block.indexOf('canRunDaemonCommand('));
    // 判据是 '/quote'（与命令入口同一条命令），而不是别的命令名
    expect(gate).toMatch(/'\/quote'/);
  });

  it('Saved Workflow 的独立 quota 闸把 chatType 传进 canTalk 复查', () => {
    const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function handleV3SavedWorkflowCommandIfAny(');
    const end = source.indexOf('async function replyInvalidWorkingDirs(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    // 只钉住 chatType 确实被传进这道复查（漏了它，p2pOpen 放行的私聊会在这里被丢掉）。
    // 不锁它是不是最后一个实参——后面又追加了 botSender（bot 发送方走 evaluateBotTalk），
    // 把「参数列表到此为止」写进断言只会让每次加参数都误报。
    expect(block).toMatch(
      /consumeMessageQuotaOnce:\s*\(\)\s*=>\s*enforceMessageQuotaForCliInput\([\s\S]*memberUnionId,\s*chatType,/,
    );
  });
});
