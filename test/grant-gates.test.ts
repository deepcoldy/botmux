/**
 * 闸门接入：chatGrant 仅放行 canTalk，不放行 canOperate。
 * Run: pnpm vitest run test/grant-gates.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { canTalk, canOperate, evaluateTalk, grantCommandRestriction } from '../src/im/lark/event-dispatcher.js';

describe('grant gates', () => {
  beforeEach(() => {
    const bot = registerBot({ larkAppId: 'g1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.allowedChatGroups = ['oc_team'];
    bot.config.chatGrants = { oc_1: ['ou_guest', 'ou_both'], oc_team: ['ou_guest'] };
    bot.config.globalGrants = ['ou_global', 'ou_both'];
  });

  it('chatGrant grants canTalk in that chat only', () => {
    expect(canTalk('g1', 'oc_1', 'ou_guest')).toBe(true);
    expect(canTalk('g1', 'oc_2', 'ou_guest')).toBe(false);
  });

  it('chatGrant does NOT grant canOperate', () => {
    expect(canOperate('g1', 'oc_1', 'ou_guest')).toBe(false);
    expect(canOperate('g1', 'oc_1', 'ou_owner')).toBe(true);
  });

  it('allowed user still talks & operates everywhere', () => {
    expect(canTalk('g1', 'oc_9', 'ou_owner')).toBe(true);
    expect(canOperate('g1', 'oc_9', 'ou_owner')).toBe(true);
  });

  it('evaluateTalk exempts allowedUsers before quota-bearing grants', () => {
    getBot('g1').config.chatGrants = { oc_1: ['ou_owner'] };
    expect(evaluateTalk('g1', 'oc_1', 'ou_owner')).toEqual({ allowed: true, reason: 'allowedUser' });
  });

  it('evaluateTalk prefers allowedChatGroup over per-user grants', () => {
    expect(evaluateTalk('g1', 'oc_team', 'ou_guest')).toEqual({ allowed: true, reason: 'allowedChatGroup' });
  });

  it('evaluateTalk prefers oncall over per-user grants', () => {
    const bot = getBot('g1');
    bot.config.oncallChats = [{ chatId: 'oc_oncall_quota', workingDir: '/tmp' }];
    bot.config.chatGrants = { oc_oncall_quota: ['ou_guest'] };
    expect(evaluateTalk('g1', 'oc_oncall_quota', 'ou_guest')).toEqual({ allowed: true, reason: 'oncall' });
  });

  it('scopes oncall talk access to the bot that owns the binding', () => {
    const botA = registerBot({
      larkAppId: 'oncall_scope_a',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner_a'],
      oncallChats: [{ chatId: 'oc_shared_oncall', workingDir: '/repo/a' }],
    });
    botA.resolvedAllowedUsers = ['ou_owner_a'];

    const botB = registerBot({
      larkAppId: 'oncall_scope_b',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner_b'],
    });
    botB.resolvedAllowedUsers = ['ou_owner_b'];

    expect(canTalk('oncall_scope_a', 'oc_shared_oncall', 'ou_external')).toBe(true);
    expect(canTalk('oncall_scope_b', 'oc_shared_oncall', 'ou_external')).toBe(false);
    expect(canTalk('oncall_scope_b', 'oc_shared_oncall', 'ou_owner_b')).toBe(true);
  });

  it('evaluateTalk prefers chat grant over global grant and emits a chat quota key', () => {
    expect(evaluateTalk('g1', 'oc_1', 'ou_both')).toEqual({
      allowed: true,
      reason: 'chatGrant',
      quotaKey: 'chat:oc_1:ou_both',
    });
  });

  it('evaluateTalk emits a global quota key for global grants', () => {
    expect(evaluateTalk('g1', 'oc_9', 'ou_global')).toEqual({
      allowed: true,
      reason: 'globalGrant',
      quotaKey: 'global:ou_global',
    });
  });

  it('evaluateTalk keeps legacy open mode ahead of chat grants when no allowlist exists', () => {
    const bot = registerBot({ larkAppId: 'g_open', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [] });
    bot.resolvedAllowedUsers = [];
    bot.config.chatGrants = { oc_open: ['ou_guest'] };
    expect(evaluateTalk('g_open', 'oc_open', 'ou_guest')).toEqual({ allowed: true, reason: 'open' });
  });

  it('grantCommandRestriction only blocks chat/global grantees when the bot switch is on', () => {
    expect(grantCommandRestriction('g1', 'oc_1', 'ou_guest')).toEqual({ blocked: false });
    getBot('g1').config.restrictGrantCommands = true;
    expect(grantCommandRestriction('g1', 'oc_1', 'ou_guest')).toEqual({ blocked: true, reason: 'chatGrant' });
    expect(grantCommandRestriction('g1', 'oc_9', 'ou_global')).toEqual({ blocked: true, reason: 'globalGrant' });
    expect(grantCommandRestriction('g1', 'oc_1', 'ou_owner')).toEqual({ blocked: false });
    expect(grantCommandRestriction('g1', 'oc_team', 'ou_guest')).toEqual({ blocked: false });
  });
});
