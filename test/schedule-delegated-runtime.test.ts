import { describe, expect, it, vi } from 'vitest';
import { authorizeDelegatedScheduleRun } from '../src/core/schedule-delegated-runtime.js';
import type { ScheduleAuthorityRecord } from '../src/services/schedule-authority-store.js';
import type { ScheduledTask } from '../src/types.js';

const task: ScheduledTask = {
  id: 'a1b2c3d4', name: 'poll', schedule: 'every 30m',
  parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
  prompt: 'check', workingDir: '/repo', chatId: 'oc_chat', larkAppId: 'cli_target',
  ownerOpenId: 'ou_should_not_escape', ownerUnionId: 'on_user',
  enabled: true, createdAt: '2026-09-28T00:00:00.000Z',
};
const authority: ScheduleAuthorityRecord = {
  kind: 'delegated', state: 'active', task,
  controlOpenId: 'ou_user_target', controlUnionId: 'on_user', runScopes: [],
};

const deps = () => ({
  runEnabled: true,
  triggerUserAuthEnabled: true,
  adminOpenIds: ['ou_user_target'],
  resolveTargetOpenId: vi.fn(async () => 'ou_user_target'),
  listChatMemberOpenIds: vi.fn(async () => ['ou_user_target']),
});

describe('delegated schedule runtime authorization', () => {
  it('rechecks operator and membership then strips generic human identity', async () => {
    const input = deps();
    await expect(authorizeDelegatedScheduleRun(task, authority, input)).resolves.toEqual({
      ...task, ownerOpenId: undefined, ownerUnionId: undefined,
    });
    expect(input.resolveTargetOpenId).toHaveBeenCalledWith('on_user');
    expect(input.listChatMemberOpenIds).toHaveBeenCalledWith('oc_chat');
  });

  it.each([
    [{ runEnabled: false }, 'revoked by host policy'],
    [{ triggerUserAuthEnabled: false }, 'requires triggerUserAuth isolation'],
    [{ adminOpenIds: [] }, 'no longer an allowed bot operator'],
  ])('fails closed before dispatch for %o', async (patch, message) => {
    await expect(authorizeDelegatedScheduleRun(task, authority, { ...deps(), ...patch }))
      .rejects.toThrow(message);
  });

  it('fails closed when identity resolution or membership changes', async () => {
    await expect(authorizeDelegatedScheduleRun(task, authority, {
      ...deps(), resolveTargetOpenId: async () => undefined,
    })).rejects.toThrow('no longer resolvable');
    await expect(authorizeDelegatedScheduleRun(task, authority, {
      ...deps(), listChatMemberOpenIds: async () => [],
    })).rejects.toThrow('no longer a target chat member');
  });
});
