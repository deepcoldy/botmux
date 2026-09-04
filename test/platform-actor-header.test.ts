import { describe, it, expect } from 'vitest';
import { resolveDashboardIdentity } from '../src/dashboard/request-identity.js';

/**
 * 平台注入的 `X-Botmux-Actor`（操作者 union_id）。
 *
 * 背景：平台支持「机器协管者」后，同一台机器会有多个人以 owner 角色反代进来。
 * 在加这个头之前，平台身份的 userId 只由「机器 + 角色」构成、**不含人**，于是
 * 两处出问题：审计分不出人；终端租约互斥（按 userId + authSessionId 判「同一个
 * 登录」）把不同人误判为同一人，从而静默复用彼此的写租约。
 */
describe('platform actor header', () => {
  const ACTIVE = 'active-management-token';
  const MACHINE = 'machine-1';

  const resolve = (actorHeader: string | string[] | undefined, role = 'owner') =>
    resolveDashboardIdentity({
      legacyCookie: ACTIVE,
      activeToken: ACTIVE,
      roleHeader: role,
      actorHeader,
      platformMachineId: MACHINE,
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: null,
    });

  it('把操作者拼进 userId 与 authSessionId', () => {
    const id = resolve('ou_alice');
    expect(id?.kind).toBe('platform-dashboard');
    expect(id?.userId).toBe('platform:scope-machine-1:ou_alice:owner');
    expect(id?.authSessionId).toBe('scope-machine-1:ou_alice:owner');
  });

  it('同机不同协管者互不相同 —— 审计能分人、租约不再误判为同一登录', () => {
    const alice = resolve('ou_alice');
    const bob = resolve('ou_bob');
    expect(alice?.userId).not.toBe(bob?.userId);
    expect(alice?.authSessionId).not.toBe(bob?.authSessionId);
  });

  it('平台没注入时退回原行为（老平台 / 免登录只读），不破坏既有部署', () => {
    const id = resolve(undefined);
    expect(id?.userId).toBe('platform:scope-machine-1:owner');
    expect(id?.authSessionId).toBe('scope-machine-1:owner');
  });

  it('空串视为缺失', () => {
    expect(resolve('')?.userId).toBe('platform:scope-machine-1:owner');
    expect(resolve('   ')?.userId).toBe('platform:scope-machine-1:owner');
  });

  it('重复注入（数组头）视为缺失，与 roleHeader 同一 fail-safe', () => {
    expect(resolve(['ou_alice', 'ou_bob'])?.userId).toBe('platform:scope-machine-1:owner');
  });

  it('形状异常的值被丢弃，不进审计行与租约 key', () => {
    // 冒号会破坏 `a:b:c` 的解析、空格与控制字符会污染日志行。
    for (const bad of ['ou:evil', 'ou alice', 'a'.repeat(65), 'ou/../x', '<script>']) {
      expect(resolve(bad)?.userId).toBe('platform:scope-machine-1:owner');
    }
  });

  it('teammate / guest 角色同样带上操作者，且仍是只读', () => {
    const guest = resolve('ou_alice', 'guest');
    expect(guest?.userId).toBe('platform:scope-machine-1:ou_alice:guest');
    expect(guest?.terminalCapability).toBe('readonly');
    expect(guest?.previewCapability).toBe('readonly');
  });

  it('未绑定平台时 actor 头无效（直连伪造拿不到平台身份）', () => {
    const id = resolveDashboardIdentity({
      legacyCookie: ACTIVE,
      activeToken: ACTIVE,
      roleHeader: 'owner',
      actorHeader: 'ou_attacker',
      platformMachineId: null,
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: null,
    });
    // 退回 legacy owner（本机管理 cookie 本身就是 owner），不是平台身份。
    expect(id?.kind).toBe('legacy-dashboard');
    expect(id?.userId).toBe('legacy-owner');
  });

  it('没有活跃管理 cookie 时 actor 头不产生任何平台身份', () => {
    const id = resolveDashboardIdentity({
      legacyCookie: 'not-the-active-token',
      activeToken: ACTIVE,
      roleHeader: 'owner',
      actorHeader: 'ou_attacker',
      platformMachineId: MACHINE,
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: null,
    });
    expect(id).toBeNull();
  });

  it('owner 与 guest 即使同一个人也不共享租约 key（角色变化即换会话）', () => {
    expect(resolve('ou_alice', 'owner')?.authSessionId).not.toBe(
      resolve('ou_alice', 'guest')?.authSessionId,
    );
  });
});
