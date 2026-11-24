import { describe, expect, it, vi } from 'vitest';
import {
  SCHEDULE_TALKER_DEFAULT_MAX_TASKS,
  authorizeTalkerScheduleRun,
  countLiveTalkerTasks,
  isTalkerScheduledTask,
  talkerScheduleChatType,
  talkerSchedulePolicy,
  talkerScheduleScopeError, effectiveTalkerSchedulePolicy } from '../src/core/schedule-talker.js';
import type { ScheduleAuthorityRecord } from '../src/services/schedule-authority-store.js';
import type { ScheduledTask } from '../src/types.js';

function talkerTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'a1b2c3d4', name: 'daily', schedule: '0 9 * * *', prompt: 'summarize',
    parsed: { kind: 'cron', expr: '0 9 * * *', display: '每天 09:00' } as any,
    workingDir: '/repo', chatId: 'oc_chat', chatType: 'topic_group', larkAppId: 'cli_target',
    enabled: true, createdAt: '2026-11-20T00:00:00.000Z',
    ownerOpenId: 'ou_talker', ownerUnionId: 'on_talker', ownerAccess: 'talk',
    ...overrides,
  } as ScheduledTask;
}

function record(task: ScheduledTask, overrides: Partial<ScheduleAuthorityRecord> = {}): ScheduleAuthorityRecord {
  return {
    kind: 'direct', state: 'active', task,
    controlOpenId: task.ownerOpenId, controlUnionId: task.ownerUnionId,
    runScopes: [], selfManage: false,
    ...overrides,
  };
}

function deps(overrides: Partial<Parameters<typeof authorizeTalkerScheduleRun>[2]> = {}) {
  return {
    policy: () => ({ enabled: true, maxTasksPerUser: 5 }),
    canTalk: vi.fn(() => true),
    resolveTargetOpenId: vi.fn(async () => 'ou_talker'),
    listChatMemberOpenIds: vi.fn(async () => ['ou_talker', 'ou_admin']),
    ...overrides,
  };
}

describe('talkerSchedulePolicy', () => {
  it('is off unless the bot explicitly enables it, and keeps the default quota', () => {
    expect(talkerSchedulePolicy(undefined)).toEqual({ enabled: false, maxTasksPerUser: SCHEDULE_TALKER_DEFAULT_MAX_TASKS });
    expect(talkerSchedulePolicy({})).toEqual({ enabled: false, maxTasksPerUser: 5 });
    expect(talkerSchedulePolicy({ scheduleCreateByTalkers: 'true' }).enabled).toBe(false);
    expect(talkerSchedulePolicy({ scheduleCreateByTalkers: true })).toEqual({ enabled: true, maxTasksPerUser: 5 });
  });

  it('accepts an integer quota in 1..100 and falls back to the default otherwise', () => {
    expect(talkerSchedulePolicy({ scheduleTalkerMaxTasks: 1 }).maxTasksPerUser).toBe(1);
    expect(talkerSchedulePolicy({ scheduleTalkerMaxTasks: 100 }).maxTasksPerUser).toBe(100);
    for (const bad of [0, -1, 101, 2.5, '3', NaN, Infinity, null]) {
      expect(talkerSchedulePolicy({ scheduleTalkerMaxTasks: bad }).maxTasksPerUser).toBe(5);
    }
  });
});

describe('isTalkerScheduledTask / talkerScheduleChatType', () => {
  it('recognizes only the exact marker', () => {
    expect(isTalkerScheduledTask({ ownerAccess: 'talk' })).toBe(true);
    expect(isTalkerScheduledTask({})).toBe(false);
    expect(isTalkerScheduledTask({ ownerAccess: 'operate' as any })).toBe(false);
    expect(isTalkerScheduledTask(undefined)).toBe(false);
  });

  it('maps every non-p2p shape to group', () => {
    expect(talkerScheduleChatType({ chatType: 'p2p' })).toBe('p2p');
    expect(talkerScheduleChatType({ chatType: 'group' })).toBe('group');
    expect(talkerScheduleChatType({ chatType: 'topic_group' })).toBe('group');
    expect(talkerScheduleChatType({})).toBe('group');
  });
});

describe('talkerScheduleScopeError', () => {
  const turn = { chatId: 'oc_chat', rootMessageId: 'om_root' };
  const base = { chatId: 'oc_chat', executionPosition: 'top-level' };

  it('accepts top level in the own chat and the current topic', () => {
    expect(talkerScheduleScopeError(base, turn)).toBeUndefined();
    expect(talkerScheduleScopeError({ ...base, executionPosition: 'topic', rootMessageId: 'om_root' }, turn)).toBeUndefined();
  });

  it.each([
    ['another chat', { chatId: 'oc_other' }],
    ['multi-chat', { chatIds: ['oc_chat'] }],
    ['new-topic', { executionPosition: 'new-topic' }],
    ['task position', { executionPosition: 'task' }],
    ['local delivery', { deliver: 'local' }],
    ['follow-active', { followActive: true }],
    ['topic title', { topicTitle: 't' }],
    ['until-done', { untilDone: {} }],
    ['notify', { notify: [] }],
  ])('refuses %s', (_label, patch) => {
    expect(talkerScheduleScopeError({ ...base, ...patch }, turn)).toBe('schedule_talker_scope_invalid');
  });

  it('binds a topic task to the turn root and forbids a root at top level', () => {
    expect(talkerScheduleScopeError({ ...base, executionPosition: 'topic', rootMessageId: 'om_other' }, turn))
      .toBe('schedule_talker_root_mismatch');
    expect(talkerScheduleScopeError({ ...base, executionPosition: 'topic', rootMessageId: 'om_root' },
      { chatId: 'oc_chat', rootMessageId: undefined })).toBe('schedule_talker_root_mismatch');
    expect(talkerScheduleScopeError({ ...base, rootMessageId: 'om_root' }, turn)).toBe('schedule_talker_root_forbidden');
  });
});

describe('countLiveTalkerTasks', () => {
  it('counts active and paused talker tasks of the person only', () => {
    const mine = talkerTask();
    const rows: ScheduleAuthorityRecord[] = [
      record(mine), record(mine, { state: 'paused' }),
      record(mine, { state: 'completed' }), record(mine, { state: 'revoked' }),
      record(talkerTask({ ownerOpenId: 'ou_other' })),
      record(talkerTask({ ownerAccess: undefined })),
      record(mine, { kind: 'delegated' }),
      record(mine, { kind: 'legacy' }),
    ];
    expect(countLiveTalkerTasks(rows, 'ou_talker')).toBe(2);
    expect(countLiveTalkerTasks(rows, 'ou_other')).toBe(1);
    expect(countLiveTalkerTasks([], 'ou_talker')).toBe(0);
  });
});

describe('authorizeTalkerScheduleRun', () => {
  it('admits the creator while the switch is on, they resolve, may talk and are a member', async () => {
    const task = talkerTask();
    const d = deps();
    await expect(authorizeTalkerScheduleRun(task, record(task), d)).resolves.toEqual({ openId: 'ou_talker', unionId: 'on_talker' });
    expect(d.resolveTargetOpenId).toHaveBeenCalledWith('on_talker');
    expect(d.canTalk).toHaveBeenCalledWith('oc_chat', 'ou_talker', 'on_talker', 'group');
    expect(d.listChatMemberOpenIds).toHaveBeenCalledWith('oc_chat');
  });

  it('checks the live target the caller names (the firing session), not only the stored chat', async () => {
    const task = talkerTask();
    const d = deps();
    await authorizeTalkerScheduleRun(task, record(task), d, { chatId: 'oc_live', chatType: 'group' });
    expect(d.canTalk).toHaveBeenCalledWith('oc_live', 'ou_talker', 'on_talker', 'group');
    expect(d.listChatMemberOpenIds).toHaveBeenCalledWith('oc_live');
  });

  it('skips the membership lookup for a private chat but still requires talk access', async () => {
    const task = talkerTask({ chatType: 'p2p' });
    const d = deps();
    await authorizeTalkerScheduleRun(task, record(task), d);
    expect(d.canTalk).toHaveBeenCalledWith('oc_chat', 'ou_talker', 'on_talker', 'p2p');
    expect(d.listChatMemberOpenIds).not.toHaveBeenCalled();
    const denied = deps({ canTalk: vi.fn(() => false) });
    await expect(authorizeTalkerScheduleRun(task, record(task), denied)).rejects.toThrow(/can no longer talk/);
  });

  it('refuses when the bot switch is off', async () => {
    const task = talkerTask();
    await expect(authorizeTalkerScheduleRun(task, record(task), deps({ policy: () => ({ enabled: false, maxTasksPerUser: 5 }) })))
      .rejects.toThrow(/disabled/);
  });

  it('refuses a record that is not a talker direct task', async () => {
    const task = talkerTask();
    await expect(authorizeTalkerScheduleRun(task, record(task, { kind: 'delegated' }), deps())).rejects.toThrow(/not a talker/);
    const admin = talkerTask({ ownerAccess: undefined });
    await expect(authorizeTalkerScheduleRun(admin, record(admin), deps())).rejects.toThrow(/not a talker/);
  });

  it.each([
    ['missing controller open_id', (r: ScheduleAuthorityRecord) => { delete r.controlOpenId; }],
    ['missing controller union_id', (r: ScheduleAuthorityRecord) => { delete r.controlUnionId; }],
    ['controller differs from the recorded owner', (r: ScheduleAuthorityRecord) => { r.controlOpenId = 'ou_other'; }],
    ['owner union differs from the controller', (r: ScheduleAuthorityRecord) => { r.task = { ...r.task, ownerUnionId: 'on_other' }; }],
  ])('refuses an inconsistent identity: %s', async (_label, mutate) => {
    const task = talkerTask();
    const r = record(task);
    mutate(r);
    await expect(authorizeTalkerScheduleRun(task, r, deps())).rejects.toThrow(/identity is missing or inconsistent/);
  });

  it('refuses when the task handed in differs from the authority\'s owner', async () => {
    const task = talkerTask();
    await expect(authorizeTalkerScheduleRun({ ...task, ownerOpenId: 'ou_other' }, record(task), deps()))
      .rejects.toThrow(/identity is missing or inconsistent/);
  });

  it('never runs as a claimant', async () => {
    const task = talkerTask();
    const claimed = record(talkerTask({ runAsClaim: { openId: 'ou_admin', unionId: 'on_admin', larkAppId: 'cli_target', claimedAt: 'x' } as any }));
    await expect(authorizeTalkerScheduleRun(task, claimed, deps())).rejects.toThrow(/claimant/);
    await expect(authorizeTalkerScheduleRun(claimed.task, record(task), deps())).rejects.toThrow(/claimant/);
  });

  it('refuses unexpected delegated authority on the record', async () => {
    const task = talkerTask();
    await expect(authorizeTalkerScheduleRun(task, record(task, { runScopes: ['bytedcli'] }), deps())).rejects.toThrow(/delegated authority/);
    await expect(authorizeTalkerScheduleRun(task, record(task, { selfManage: true }), deps())).rejects.toThrow(/delegated authority/);
  });

  it('refuses when the union_id no longer resolves to the recorded open_id', async () => {
    const task = talkerTask();
    await expect(authorizeTalkerScheduleRun(task, record(task), deps({ resolveTargetOpenId: vi.fn(async () => 'ou_reissued') })))
      .rejects.toThrow(/no longer resolvable/);
    await expect(authorizeTalkerScheduleRun(task, record(task), deps({ resolveTargetOpenId: vi.fn(async () => undefined) })))
      .rejects.toThrow(/no longer resolvable/);
  });

  it('refuses when the creator can no longer talk, or left the group', async () => {
    const task = talkerTask();
    await expect(authorizeTalkerScheduleRun(task, record(task), deps({ canTalk: vi.fn(() => false) })))
      .rejects.toThrow(/can no longer talk/);
    await expect(authorizeTalkerScheduleRun(task, record(task), deps({ listChatMemberOpenIds: vi.fn(async () => ['ou_admin']) })))
      .rejects.toThrow(/no longer a target chat member/);
  });

  it('re-reads the switch after asynchronous admission checks', async () => {
    const task = talkerTask();
    let enabled = true;
    const d = deps({
      policy: () => ({ enabled, maxTasksPerUser: 5 }),
      listChatMemberOpenIds: vi.fn(async () => {
        enabled = false;
        return ['ou_talker'];
      }),
    });
    await expect(authorizeTalkerScheduleRun(task, record(task), d)).rejects.toThrow(/disabled/);
  });

  it('re-checks talk access after the membership wait', async () => {
    const task = talkerTask();
    let checks = 0;
    const d = deps({
      canTalk: vi.fn(() => ++checks === 1),
      listChatMemberOpenIds: vi.fn(async () => ['ou_talker']),
    });
    await expect(authorizeTalkerScheduleRun(task, record(task), d)).rejects.toThrow(/can no longer talk/);
    expect(checks).toBe(2);
  });
});

describe('effectiveTalkerSchedulePolicy', () => {
  it('turns the policy on for an assistant owner only, keeping the quota', () => {
    const off = { enabled: false, maxTasksPerUser: 3 };
    expect(effectiveTalkerSchedulePolicy(off, false)).toEqual(off);
    expect(effectiveTalkerSchedulePolicy(off, true)).toEqual({ enabled: true, maxTasksPerUser: 3 });
    const on = { enabled: true, maxTasksPerUser: 5 };
    expect(effectiveTalkerSchedulePolicy(on, false)).toEqual(on);
  });
});
