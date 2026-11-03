import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/types.js';

vi.mock('../src/im/lark/client.js', () => ({
  sendUserMessage: vi.fn(async () => 'om_private'),
  replyMessage: vi.fn(async () => 'om_notice'),
}));

import { config } from '../src/config.js';
import { sendUserMessage, replyMessage } from '../src/im/lark/client.js';
import { privateReplyEnabled, sendPrivateReply } from '../src/core/private-reply.js';
import { readRoleReplyPrivately, writeRoleReplyPrivately, readRolePrivateReplyNotice,
  writeRolePrivateReplyNotice, writeRoleInjectMode, readRoleInjectMode } from '../src/core/role-resolver.js';

const APP = 'cli_private';
const GROUP = 'oc_group';
const session = (): Session => ({
  sessionId: 'session_group', larkAppId: APP, chatId: GROUP, chatType: 'group', scope: 'thread',
  rootMessageId: 'om_question', title: 'question', status: 'active', createdAt: '2026-09-09T00:00:00Z',
  quoteTargetId: 'turn_b', quoteTargetSenderOpenId: 'ou_b',
  replyTargets: {
    turn_a: { senderOpenId: 'ou_a', updatedAt: '2026-09-09T00:00:00Z' },
    turn_b: { senderOpenId: 'ou_b', updatedAt: '2026-09-09T00:00:01Z' },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  config.session.dataDir = mkdtempSync(join(tmpdir(), 'botmux-private-'));
  vi.mocked(sendUserMessage).mockResolvedValue('om_private');
  vi.mocked(replyMessage).mockResolvedValue('om_notice');
});

describe('private delivery with the existing group session', () => {
  it('defaults off and keeps bot/group settings independent', async () => {
    expect(readRoleReplyPrivately(APP, GROUP)).toBe(false);
    expect(readRolePrivateReplyNotice(APP, GROUP)).toBe('');
    expect(await sendPrivateReply(session(), 'turn_a', 'answer')).toBeUndefined();
    writeRoleInjectMode(APP, GROUP, 'once');
    writeRolePrivateReplyNotice(APP, GROUP, '  已私聊发送  ');
    writeRoleReplyPrivately(APP, GROUP, true);
    expect(readRolePrivateReplyNotice(APP, GROUP)).toBe('已私聊发送');
    expect(readRolePrivateReplyNotice(APP, 'oc_other')).toBe('');
    expect(readRoleReplyPrivately('cli_other', GROUP)).toBe(false);
    writeRoleReplyPrivately(APP, GROUP, false);
    expect(readRolePrivateReplyNotice(APP, GROUP)).toBe('已私聊发送');
    expect(readRoleInjectMode(APP, GROUP)).toBe('once');
    writeRolePrivateReplyNotice(APP, GROUP, '  ');
    expect(readRolePrivateReplyNotice(APP, GROUP)).toBe('');
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('rejects an oversized notice without overwriting the saved value', () => {
    writeRolePrivateReplyNotice(APP, GROUP, 'saved');
    expect(() => writeRolePrivateReplyNotice(APP, GROUP, 'x'.repeat(501))).toThrow();
    expect(readRolePrivateReplyNotice(APP, GROUP)).toBe('saved');
  });

  it('leaves ordinary DM and chat-scope routing unchanged', async () => {
    writeRoleReplyPrivately(APP, GROUP, true);
    expect(privateReplyEnabled({ ...session(), chatType: 'p2p' })).toBe(false);
    expect(await sendPrivateReply({ ...session(), scope: 'chat' }, 'turn_a', 'answer')).toBeUndefined();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('sends delayed turn A to A after B has asked, without mutating the group session', async () => {
    writeRoleReplyPrivately(APP, GROUP, true);
    const s = session();
    const original = structuredClone(s);
    await sendPrivateReply(s, 'turn_a', 'answer A', 'text', 'uuid_a');
    await sendPrivateReply(s, 'turn_b', '{"file_key":"file"}', 'file');
    expect(sendUserMessage).toHaveBeenNthCalledWith(1, APP, 'ou_a', 'answer A', 'text', 'uuid_a');
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, APP, 'ou_b', '{"file_key":"file"}', 'file', undefined);
    expect(replyMessage).not.toHaveBeenCalled();
    expect(s).toEqual(original);
  });

  it.each([undefined, 'evicted_turn'])('uses ordinary delivery for %s instead of borrowing the last user', async turn => {
    writeRoleReplyPrivately(APP, GROUP, true);
    expect(await sendPrivateReply(session(), turn, 'answer')).toBeUndefined();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it.each(['turn_a', 'turn_b'])('keeps a bot-originated %s in the group even after a later human turn', async turn => {
    writeRoleReplyPrivately(APP, GROUP, true);
    const s = session();
    s.turnReplyContexts = {
      turn_a: { target: { mode: 'thread', rootMessageId: s.rootMessageId }, replyTargetSenderIsBot: true },
    };
    s.quoteTargetSenderIsBot = turn === 'turn_b';
    expect(await sendPrivateReply(s, turn, 'answer')).toBeUndefined();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('only posts the configured notice after private delivery succeeds', async () => {
    writeRoleReplyPrivately(APP, GROUP, true);
    writeRolePrivateReplyNotice(APP, GROUP, '为避免打扰，已经私聊发送');
    await sendPrivateReply(session(), 'turn_a', 'private answer');
    expect(replyMessage).toHaveBeenCalledWith(APP, 'om_question', '为避免打扰，已经私聊发送',
      'text', true, undefined, undefined, { suppressHook: true });
    expect(vi.mocked(sendUserMessage).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(replyMessage).mock.invocationCallOrder[0]);
  });

  it.each(['permission denied', 'network timeout'])('resumes ordinary delivery without a success notice after %s', async error => {
    writeRoleReplyPrivately(APP, GROUP, true);
    writeRolePrivateReplyNotice(APP, GROUP, 'sent');
    vi.mocked(sendUserMessage).mockRejectedValueOnce(new Error(error));
    expect(await sendPrivateReply(session(), 'turn_a', 'answer')).toBeUndefined();
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('keeps successful private delivery successful if the group notice fails', async () => {
    writeRoleReplyPrivately(APP, GROUP, true);
    writeRolePrivateReplyNotice(APP, GROUP, 'sent');
    vi.mocked(replyMessage).mockRejectedValueOnce(new Error('notice failed'));
    expect(await sendPrivateReply(session(), 'turn_a', 'answer')).toBe('om_private');
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });
});
