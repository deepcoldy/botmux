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

  it('Saved Workflow 的独立 quota 闸把 chatType 传进 canTalk 复查', () => {
    const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function handleV3SavedWorkflowCommandIfAny(');
    const end = source.indexOf('async function replyInvalidWorkingDirs(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).toMatch(
      /consumeMessageQuotaOnce:\s*\(\)\s*=>\s*enforceMessageQuotaForCliInput\([\s\S]*memberUnionId,\s*chatType,\s*\)/,
    );
  });
});
