import { describe, expect, it, vi } from 'vitest';
import { resolveNativeScheduledControlActor } from '../src/core/scheduled-control-actor.js';
import type { ScheduleAuthorityRecord } from '../src/services/schedule-authority-store.js';

function fixture() {
  const turnId = 'schedule:abcd1234:12345678-1234-1234-1234-123456789abc';
  const native = { larkToolBinding: false, triggerUserAuth: { enabled: false, tools: [] } };
  const authority: ScheduleAuthorityRecord = { kind: 'delegated', state: 'active',
    controlOpenId: 'ou_controller', controlUnionId: 'on_controller',
    runScopes: [], selfManage: false,
    task: { id: 'abcd1234', name: 'check', prompt: 'work', workingDir: '/repo',
      larkAppId: 'cli_a', chatId: 'oc_chat', schedule: 'every 30m',
      parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
      enabled: true, createdAt: '2026-01-01T00:00:00.000Z' } };
  const input = { turnId, appId: 'cli_a', chatId: 'oc_chat', authority,
    cliConfig: () => native, assertCurrent: vi.fn(),
    resolveDirectActor: () => ({ ok: true as const, openId: 'ou_direct', unionId: 'on_direct', source: 'creator' as const }),
    deps: { ...native, runEnabled: true, hostRunScopes: [], adminOpenIds: ['ou_controller'],
      resolveTargetOpenId: async () => 'ou_controller', listChatMemberOpenIds: async () => ['ou_controller'] } };
  return { input, native, authority };
}

describe('native scheduled control actor', () => {
  it('returns the host-revalidated controller without acquiring task ownership', async () => {
    const { input, authority } = fixture(); const before = JSON.stringify(authority);
    expect(await resolveNativeScheduledControlActor(input)).toEqual({ openId: 'ou_controller', unionId: 'on_controller' });
    expect(JSON.stringify(authority)).toBe(before);
    expect(authority.task.ownerOpenId).toBeUndefined();
    expect(input.assertCurrent).toHaveBeenCalledTimes(4);
  });

  it.each(['turn', 'app', 'chat', 'managed'] as const)('does not publish an actor for mismatched %s', async kind => {
    const { input } = fixture();
    if (kind === 'turn') input.turnId = input.turnId.replace('abcd1234', '1234abcd');
    if (kind === 'app') input.appId = 'cli_other';
    if (kind === 'chat') input.chatId = 'oc_other';
    if (kind === 'managed') input.cliConfig = () => ({ larkToolBinding: true, triggerUserAuth: { enabled: false, tools: [] } });
    expect(await resolveNativeScheduledControlActor(input)).toBeUndefined();
  });

  it('refuses paused or revoked authority and late policy changes', async () => {
    const { input } = fixture(); input.authority.state = 'paused';
    await expect(resolveNativeScheduledControlActor(input)).rejects.toThrow('paused');
    input.authority.state = 'revoked';
    await expect(resolveNativeScheduledControlActor(input)).rejects.toThrow('revoked');
    input.authority.state = 'active';
    input.deps.listChatMemberOpenIds = async () => {
      input.cliConfig = () => ({ larkToolBinding: true, triggerUserAuth: { enabled: false, tools: [] } });
      return ['ou_controller'];
    };
    expect(await resolveNativeScheduledControlActor(input)).toBeUndefined();
  });

  it('uses the resolved direct task actor rather than the session owner', async () => {
    const { input } = fixture(); input.authority.kind = 'direct';
    expect(await resolveNativeScheduledControlActor(input)).toEqual({ openId: 'ou_direct', unionId: 'on_direct' });
  });
});
