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
  triggerUserAuth: { enabled: true, tools: ['lark-cli', 'bytedcli'] as const },
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
      usesControllerToolActor: false,
    });
    expect(input.resolveTargetOpenId).toHaveBeenCalledWith('on_user');
    expect(input.listChatMemberOpenIds).toHaveBeenCalledWith('oc_chat');
  });

  it('publishes the exact controller only as the tool actor of an ownerless bounded child', async () => {
    const childTask = {
      ...task,
      ownerOpenId: undefined,
      ownerUnionId: undefined,
    };
    const childAuthority: ScheduleAuthorityRecord = {
      ...authority,
      task: childTask,
      grantId: 'schedule-child:cli_target:parent01:schedule:parent01:run-1',
      credentialOpenId: 'ou_user_target',
      runScopes: [],
      selfManage: false,
    };
    await expect(authorizeDelegatedScheduleRun(childTask, childAuthority, deps()))
      .resolves.toEqual({
        task: childTask,
        targetOpenId: 'ou_user_target',
        usesControllerToolActor: true,
      });

    await expect(authorizeDelegatedScheduleRun(childTask, {
      ...childAuthority,
      grantId: 'dispatch:delivery-1:cli_target',
    }, deps())).resolves.toEqual({
      task: { ...childTask, ownerOpenId: undefined, ownerUnionId: undefined },
      targetOpenId: 'ou_user_target',
      usesControllerToolActor: false,
    });

    const ownedChildTask = {
      ...childTask,
      ownerOpenId: 'ou_user_target',
      ownerUnionId: 'on_user',
    };
    await expect(authorizeDelegatedScheduleRun(ownedChildTask, {
      ...childAuthority,
      task: ownedChildTask,
    }, deps())).resolves.toMatchObject({ usesControllerToolActor: false });
  });

  it.each([
    [{ runEnabled: false }, 'revoked by host policy'],
    [{ triggerUserAuth: { enabled: true, tools: ['bytedcli'] } }, 'requires triggerUserAuth isolation'],
    [{ triggerUserAuth: { enabled: true, tools: [], capabilities: ['lark-user', 'meego'] } },
      'requires triggerUserAuth isolation'],
    [{ hostRunScopes: [] }, 'run scope is no longer allowed'],
    [{ adminOpenIds: [] }, 'no longer an allowed bot operator'],
  ])('fails closed before dispatch for %o', async (patch, message) => {
    await expect(authorizeDelegatedScheduleRun(task, authority, { ...deps(), ...patch }))
      .rejects.toThrow(message);
  });

  it('re-resolves an admitted completed one-shot only when the caller is re-preparing that turn', async () => {
    const once = { ...task, parsed: { kind: 'once' as const, runAt: '2026-11-16T12:00:00.000Z', display: 'once' } };
    const completed: ScheduleAuthorityRecord = {
      ...authority, state: 'completed',
      task: { ...once, enabled: false, disabledReason: 'once_completed' },
    };
    await expect(authorizeDelegatedScheduleRun(completed.task, completed, deps()))
      .rejects.toThrow('schedule authority state is completed');
    await expect(authorizeDelegatedScheduleRun(completed.task, completed, { ...deps(), allowCompletedOnce: true }))
      .resolves.toMatchObject({ targetOpenId: 'ou_user_target' });
    // The live controller check still applies to the re-preparation.
    await expect(authorizeDelegatedScheduleRun(completed.task, completed, {
      ...deps(), allowCompletedOnce: true, adminOpenIds: [],
    })).rejects.toThrow('no longer an allowed bot operator');
    // A person's pause is not an auto-completion.
    const paused: ScheduleAuthorityRecord = {
      ...authority, state: 'paused', task: { ...once, enabled: false, disabledReason: 'manual' },
    };
    await expect(authorizeDelegatedScheduleRun(paused.task, paused, { ...deps(), allowCompletedOnce: true }))
      .rejects.toThrow('schedule authority state is paused');
    // A completed row without the auto-completion marker (manual disable or a
    // malformed projection) is not the admitted one-shot replay either.
    const completedWithoutMarker: ScheduleAuthorityRecord = {
      ...authority, state: 'completed', task: { ...once, enabled: false },
    };
    await expect(authorizeDelegatedScheduleRun(completedWithoutMarker.task, completedWithoutMarker,
      { ...deps(), allowCompletedOnce: true }))
      .rejects.toThrow('schedule authority state is completed');
  });

  it('accepts a capabilities policy that isolates lark-user and bytecloud', async () => {
    await expect(authorizeDelegatedScheduleRun(task, authority, {
      ...deps(), triggerUserAuth: { enabled: true, tools: [], capabilities: ['lark-user', 'bytecloud'] },
    })).resolves.toMatchObject({ targetOpenId: 'ou_user_target' });
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

  it('lets a host-terminal task without any controller stop itself', async () => {
    const hostTask = {
      ...authority,
      kind: 'direct' as const,
      task: { ...task, ownerOpenId: undefined, ownerUnionId: undefined },
      controlOpenId: undefined,
      controlUnionId: undefined,
      credentialOpenId: undefined,
      runScopes: [],
      selfManage: false,
    };
    const lookups = {
      resolveTargetOpenId: vi.fn(async () => undefined),
      listChatMemberOpenIds: vi.fn(async () => []),
    };
    await expect(authorizeScheduleSelfManage(hostTask, {
      selfManageEnabled: false,
      targetChatId: 'oc_chat',
      adminOpenIds: [],
      ...lookups,
    })).resolves.toBeUndefined();
    expect(lookups.resolveTargetOpenId).not.toHaveBeenCalled();
    expect(lookups.listChatMemberOpenIds).not.toHaveBeenCalled();

    // Still bound to the live states: a paused or removed host task stays put.
    for (const state of ['paused', 'revoked'] as const) {
      await expect(authorizeScheduleSelfManage({ ...hostTask, state }, {
        selfManageEnabled: false, targetChatId: 'oc_chat', adminOpenIds: [], ...lookups,
      })).rejects.toThrow(`schedule authority state is ${state}`);
    }

    // A naturally completed until-done task keeps one live cleanup turn; the
    // completedRunStillLive state gate is evaluated before the exemption and
    // no controller lookup may happen.
    await expect(authorizeScheduleSelfManage({
      ...hostTask, state: 'completed',
      task: { ...hostTask.task, enabled: false, disabledReason: 'once_completed' as const },
    }, {
      selfManageEnabled: false, targetChatId: 'oc_chat', adminOpenIds: [], ...lookups,
    })).resolves.toBeUndefined();
    expect(lookups.resolveTargetOpenId).not.toHaveBeenCalled();
    expect(lookups.listChatMemberOpenIds).not.toHaveBeenCalled();
  });

  it.each([
    [{ controlOpenId: 'ou_gone', controlUnionId: undefined }, 'no longer an allowed bot operator'],
    [{ controlOpenId: undefined, controlUnionId: 'on_gone' }, 'no longer an allowed bot operator'],
    [{ controlOpenId: 'ou_gone', controlUnionId: 'on_gone' }, 'no longer an allowed bot operator'],
    // A sender whose open_id Lark left empty is recorded, not absent.
    [{ controlOpenId: '', controlUnionId: undefined }, 'no longer an allowed bot operator'],
    [{ controlOpenId: '', controlUnionId: '' }, 'no longer an allowed bot operator'],
  ])('keeps the live controller check for a direct task recording %o', async (control, message) => {
    await expect(authorizeScheduleSelfManage({
      ...authority, kind: 'direct', selfManage: false, credentialOpenId: undefined, runScopes: [], ...control,
    }, {
      selfManageEnabled: false,
      targetChatId: 'oc_chat',
      adminOpenIds: ['ou_user_target'],
      resolveTargetOpenId: async () => 'ou_user_target',
      listChatMemberOpenIds: async () => ['ou_user_target'],
    })).rejects.toThrow(message);
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
