import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getBotAdminOpenIds,
  isBotAdmin,
  resolveGrantApprover,
  clearChatMemberCache,
} from '../src/im/lark/grant-owner.js';
import { registerBot, loadBotConfigs } from '../src/bot-registry.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('grant-owner', () => {
  let configPath: string;

  beforeEach(() => {
    clearChatMemberCache();
    const dir = mkdtempSync(join(tmpdir(), 'botmux-grant-owner-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
    vi.restoreAllMocks();
  });

  describe('getBotAdminOpenIds & isBotAdmin', () => {
    it('returns empty array when bot is unregistered', () => {
      expect(getBotAdminOpenIds('non-existent')).toEqual([]);
      expect(isBotAdmin('non-existent', 'ou_test')).toBe(false);
      expect(isBotAdmin('non-existent', undefined)).toBe(false);
    });

    it('collects ownerOpenId and resolvedAllowedUsers with deduplication', () => {
      const bot = registerBot({
        larkAppId: 'b_multi',
        larkAppSecret: 's',
        cliId: 'claude-code',
        ownerOpenId: 'ou_owner_explicit',
        allowedUsers: ['user@example.com', 'ou_owner_explicit'],
      });
      bot.resolvedAllowedUsers = ['ou_owner_explicit', 'ou_admin_resolved', 'ou_admin_2'];

      const admins = getBotAdminOpenIds('b_multi');
      expect(admins).toEqual(['ou_owner_explicit', 'ou_admin_resolved', 'ou_admin_2']);

      expect(isBotAdmin('b_multi', 'ou_owner_explicit')).toBe(true);
      expect(isBotAdmin('b_multi', 'ou_admin_resolved')).toBe(true);
      expect(isBotAdmin('b_multi', 'ou_stranger')).toBe(false);
    });

    it('fails closed when raw allowedUsers failed contact resolution', () => {
      const bot = registerBot({
        larkAppId: 'b_fail_closed',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_unresolved_cross_app'],
      });
      // applyAllowedUsersResolve drops unresolved/invalid ou_ from runtime resolvedAllowedUsers
      bot.resolvedAllowedUsers = [];

      expect(getBotAdminOpenIds('b_fail_closed')).toEqual([]);
      expect(isBotAdmin('b_fail_closed', 'ou_unresolved_cross_app')).toBe(false);
    });

    it('handles bot without ownerOpenId (legacy config style)', () => {
      const bot = registerBot({
        larkAppId: 'b_legacy',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_first', 'tengdianjiang@bytedance.com'],
      });
      bot.resolvedAllowedUsers = ['ou_first', 'ou_second'];

      const admins = getBotAdminOpenIds('b_legacy');
      expect(admins).toEqual(['ou_first', 'ou_second']);
      expect(isBotAdmin('b_legacy', 'ou_first')).toBe(true);
      expect(isBotAdmin('b_legacy', 'ou_second')).toBe(true);
      expect(isBotAdmin('b_legacy', 'ou_other')).toBe(false);
    });
  });

  describe('resolveGrantApprover', () => {
    it('returns undefined if no admins exist', async () => {
      registerBot({
        larkAppId: 'b_empty',
        larkAppSecret: 's',
        cliId: 'claude-code',
      });
      const approver = await resolveGrantApprover('b_empty', 'oc_chat_1');
      expect(approver).toBeUndefined();
    });

    it('returns the single admin immediately without calling listMembers', async () => {
      const bot = registerBot({
        larkAppId: 'b_single',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_sole_owner'],
      });
      bot.resolvedAllowedUsers = ['ou_sole_owner'];

      const listMembers = vi.fn(async () => ['ou_other']);
      const approver = await resolveGrantApprover('b_single', 'oc_chat_1', undefined, {
        listChatMemberOpenIds: listMembers,
      });

      expect(approver).toBe('ou_sole_owner');
      expect(listMembers).not.toHaveBeenCalled();
    });

    it('returns first candidate if chatId is missing or not a Lark chat', async () => {
      const bot = registerBot({
        larkAppId: 'b_dual',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_owner_1', 'ou_owner_2'],
      });
      bot.resolvedAllowedUsers = ['ou_owner_1', 'ou_owner_2'];

      const listMembers = vi.fn(async () => ['ou_owner_2']);
      const approverNoChat = await resolveGrantApprover('b_dual', undefined, undefined, {
        listChatMemberOpenIds: listMembers,
      });
      expect(approverNoChat).toBe('ou_owner_1');
      expect(listMembers).not.toHaveBeenCalled();
    });

    it('prefers admin explicitly mentioned in the message', async () => {
      const bot = registerBot({
        larkAppId: 'b_mention',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_owner_1', 'ou_owner_2'],
      });
      bot.resolvedAllowedUsers = ['ou_owner_1', 'ou_owner_2'];

      const listMembers = vi.fn(async () => ['ou_owner_1', 'ou_owner_2']);
      const messageWithMention = {
        mentions: [
          { id: { open_id: 'ou_bot' }, name: 'Bot' },
          { id: { open_id: 'ou_owner_2' }, name: 'Dianjiang' },
        ],
      };

      const approver = await resolveGrantApprover('b_mention', 'oc_chat_1', messageWithMention, {
        listChatMemberOpenIds: listMembers,
      });

      // Directly picks ou_owner_2 without calling listMembers API
      expect(approver).toBe('ou_owner_2');
      expect(listMembers).not.toHaveBeenCalled();
    });

    it('picks the in-chat admin when global owner is not in chat', async () => {
      // Yuanhong is allowedUsers[0], but Teng Dianjiang (allowedUsers[1]) is the one in this chat
      const bot = registerBot({
        larkAppId: 'b_inchat',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_yuanhong', 'ou_dianjiang'],
      });
      bot.resolvedAllowedUsers = ['ou_yuanhong', 'ou_dianjiang'];

      const listMembers = vi.fn(async () => ['ou_dianjiang', 'ou_stranger_user']);

      const approver = await resolveGrantApprover('b_inchat', 'oc_chat_1', {}, {
        listChatMemberOpenIds: listMembers,
      });

      expect(approver).toBe('ou_dianjiang');
      expect(listMembers).toHaveBeenCalledWith('b_inchat', 'oc_chat_1');
    });

    it('picks the first admin in priority order when multiple admins are in chat', async () => {
      const bot = registerBot({
        larkAppId: 'b_both_inchat',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_yuanhong', 'ou_dianjiang'],
      });
      bot.resolvedAllowedUsers = ['ou_yuanhong', 'ou_dianjiang'];

      const listMembers = vi.fn(async () => ['ou_dianjiang', 'ou_yuanhong']);

      const approver = await resolveGrantApprover('b_both_inchat', 'oc_chat_1', {}, {
        listChatMemberOpenIds: listMembers,
      });

      // Both are in chat, but ou_yuanhong has higher priority in allowedUsers
      expect(approver).toBe('ou_yuanhong');
    });

    it('falls back to global owner if NO admin is in chat', async () => {
      const bot = registerBot({
        larkAppId: 'b_none_inchat',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_yuanhong', 'ou_dianjiang'],
      });
      bot.resolvedAllowedUsers = ['ou_yuanhong', 'ou_dianjiang'];

      const listMembers = vi.fn(async () => ['ou_stranger_1', 'ou_stranger_2']);

      const approver = await resolveGrantApprover('b_none_inchat', 'oc_chat_1', {}, {
        listChatMemberOpenIds: listMembers,
      });

      expect(approver).toBe('ou_yuanhong');
    });

    it('falls back to global owner if listChatMemberOpenIds throws', async () => {
      const bot = registerBot({
        larkAppId: 'b_error',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_yuanhong', 'ou_dianjiang'],
      });
      bot.resolvedAllowedUsers = ['ou_yuanhong', 'ou_dianjiang'];

      const listMembers = vi.fn(async () => {
        throw new Error('API network failure');
      });

      const approver = await resolveGrantApprover('b_error', 'oc_chat_1', {}, {
        listChatMemberOpenIds: listMembers,
      });

      expect(approver).toBe('ou_yuanhong');
    });

    it('caches member list and deduplicates in-flight calls', async () => {
      const bot = registerBot({
        larkAppId: 'b_cache',
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: ['ou_yuanhong', 'ou_dianjiang'],
      });
      bot.resolvedAllowedUsers = ['ou_yuanhong', 'ou_dianjiang'];

      const listMembers = vi.fn(async () => {
        return ['ou_dianjiang'];
      });

      // Call concurrently
      const [res1, res2] = await Promise.all([
        resolveGrantApprover('b_cache', 'oc_chat_cache', {}, { listChatMemberOpenIds: listMembers }),
        resolveGrantApprover('b_cache', 'oc_chat_cache', {}, { listChatMemberOpenIds: listMembers }),
      ]);

      expect(res1).toBe('ou_dianjiang');
      expect(res2).toBe('ou_dianjiang');
      expect(listMembers).toHaveBeenCalledTimes(1);

      // Subsequent call uses cache
      const res3 = await resolveGrantApprover('b_cache', 'oc_chat_cache', {}, { listChatMemberOpenIds: listMembers });
      expect(res3).toBe('ou_dianjiang');
      expect(listMembers).toHaveBeenCalledTimes(1);

      // Clear cache and call again
      clearChatMemberCache();
      const res4 = await resolveGrantApprover('b_cache', 'oc_chat_cache', {}, { listChatMemberOpenIds: listMembers });
      expect(res4).toBe('ou_dianjiang');
      expect(listMembers).toHaveBeenCalledTimes(2);
    });
  });
});
