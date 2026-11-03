import { describe, expect, it, vi } from 'vitest';
import { authorizeDelegatedScheduleRun, authorizeScheduleSelfManage } from '../src/core/schedule-delegated-runtime.js';
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
  controlOpenId: 'ou_user_target', controlUnionId: 'on_user',
  credentialOpenId: 'ou_user_source', runScopes: ['bytedcli'], selfManage: true,
};

const deps = () => ({
  runEnabled: true,
  hostRunScopes: ['bytedcli'] as const,
  triggerUserAuthTools: ['lark-cli', 'bytedcli'] as const,
  adminOpenIds: ['ou_user_target'],
  resolveTargetOpenId: vi.fn(async () => 'ou_user_target'),
  listChatMemberOpenIds: vi.fn(async () => ['ou_user_target']),
});

describe('delegated schedule runtime authorization', () => {
  it('rechecks operator and membership then strips generic human identity', async () => {
    const input = deps();
    await expect(authorizeDelegatedScheduleRun(task, authority, input)).resolves.toEqual({
      task: { ...task, ownerOpenId: undefined, ownerUnionId: undefined },
      targetOpenId: 'ou_user_target',
    });
    expect(input.resolveTargetOpenId).toHaveBeenCalledWith('on_user');
    expect(input.listChatMemberOpenIds).toHaveBeenCalledWith('oc_chat');
  });

  it.each([
    [{ runEnabled: false }, 'revoked by host policy'],
    [{ triggerUserAuthTools: ['bytedcli'] }, 'requires triggerUserAuth isolation'],
    [{ hostRunScopes: [] }, 'run scope is no longer allowed'],
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

  it('allows only explicitly enabled delegated self-management after live controller checks', async () => {
    await expect(authorizeScheduleSelfManage(authority, {
      selfManageEnabled: true,
      targetChatId: 'oc_chat',
      adminOpenIds: ['ou_user_target'],
      resolveTargetOpenId: async () => 'ou_user_target',
      listChatMemberOpenIds: async () => ['ou_user_target'],
    })).resolves.toBeUndefined();
    await expect(authorizeScheduleSelfManage(authority, {
      selfManageEnabled: false,
      targetChatId: 'oc_chat',
      adminOpenIds: ['ou_user_target'],
      resolveTargetOpenId: async () => 'ou_user_target',
      listChatMemberOpenIds: async () => ['ou_user_target'],
    })).rejects.toThrow('self-management is not allowed');
  });

  it('lets a direct task stop itself without the delegation opt-in', async () => {
    await expect(authorizeScheduleSelfManage({
      ...authority,
      kind: 'direct',
      selfManage: false,
      credentialOpenId: undefined,
      runScopes: [],
    }, {
      selfManageEnabled: false,
      targetChatId: 'oc_chat',
      adminOpenIds: ['ou_user_target'],
      resolveTargetOpenId: async () => 'ou_user_target',
      listChatMemberOpenIds: async () => ['ou_user_target'],
    })).resolves.toBeUndefined();
  });

  it('keeps legacy tasks outside scheduled self-management', async () => {
    await expect(authorizeScheduleSelfManage({ ...authority, kind: 'legacy' }, {
      selfManageEnabled: true,
      targetChatId: 'oc_chat',
      adminOpenIds: ['ou_user_target'],
      resolveTargetOpenId: async () => 'ou_user_target',
      listChatMemberOpenIds: async () => ['ou_user_target'],
    })).rejects.toThrow('self-management is not allowed');
  });

  it('allows the exact final live turn to remove a naturally completed task', async () => {
    await expect(authorizeScheduleSelfManage({
      ...authority,
      kind: 'direct',
      state: 'completed',
      task: {
        ...authority.task,
        enabled: false,
        disabledReason: 'once_completed',
      },
    }, {
      selfManageEnabled: false,
      targetChatId: 'oc_target',
      adminOpenIds: ['ou_user_target'],
      resolveTargetOpenId: async () => 'ou_user_target',
      listChatMemberOpenIds: async chatId => chatId === 'oc_target' ? ['ou_user_target'] : [],
    })).resolves.toBeUndefined();
  });

  it.each(['paused', 'revoked'] as const)(
    'keeps a manually %s direct task outside scheduled self-management',
    async state => {
      await expect(authorizeScheduleSelfManage({
        ...authority,
        kind: 'direct',
        state,
        task: {
          ...authority.task,
          enabled: false,
          disabledReason: 'manual',
        },
      }, {
        selfManageEnabled: false,
        targetChatId: 'oc_chat',
        adminOpenIds: ['ou_user_target'],
        resolveTargetOpenId: async () => 'ou_user_target',
        listChatMemberOpenIds: async () => ['ou_user_target'],
      })).rejects.toThrow(`schedule authority state is ${state}`);
    },
  );

  it('checks self-management against the chat hosting the current scheduled turn', async () => {
    await expect(authorizeScheduleSelfManage({
      ...authority,
      kind: 'direct',
    }, {
      selfManageEnabled: false,
      targetChatId: 'oc_other_target',
      adminOpenIds: ['ou_user_target'],
      resolveTargetOpenId: async () => 'ou_user_target',
      listChatMemberOpenIds: async chatId => chatId === 'oc_chat' ? ['ou_user_target'] : [],
    })).rejects.toThrow('no longer a target chat member');
  });
});
