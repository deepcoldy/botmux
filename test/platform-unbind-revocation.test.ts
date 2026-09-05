import { describe, it, expect } from 'vitest';
import { AuthSessionConnectionRegistry } from '../src/dashboard/auth-session-connections.js';
import { ControlCsrfTokens } from '../src/dashboard/control-csrf.js';
import { PreviewInteractionManager } from '../src/dashboard/preview-interaction.js';
import { TerminalControlManager } from '../src/dashboard/terminal-control.js';
import {
  isPlatformDashboardAuthSessionId,
  platformAuthSessionsToRevoke,
  resolveDashboardIdentity,
} from '../src/dashboard/request-identity.js';

/**
 * 解绑吊销（`dashboard.ts:syncPlatformBindingRevocation`）必须扫到**协管者**。
 *
 * 原实现硬枚举 `${scope}:owner|teammate|guest` 三个字面量。平台注入
 * `X-Botmux-Actor` 之后协管者的 authSessionId 变成 `<scope>:<actor>:<role>`，
 * 三个字面量一个都对不上 —— 于是 `botmux unbind` 之后**协管者已建立的写连接不会
 * 被断开**，机器已经从平台摘下来了，人还连着。那个函数的注释自己写着「少走一条
 * 就等于留一扇后窗」，硬枚举正好开了一扇。
 *
 * 「有哪些协管者」本进程不可能预先知道（union_id 来自平台），所以正确做法是反向
 * 枚举：把四个注册表里在册的认证会话取并集，按本机 scope 筛出平台身份。本文件用
 * 真实的注册表复现这个流程。
 */
describe('平台解绑时的协管者会话吊销', () => {
  const ACTIVE = 'active-management-token';
  const MACHINE = 'machine-1';
  const SCOPE = `scope-${MACHINE}`;

  function identityOf(actor: string | undefined, role = 'owner') {
    const id = resolveDashboardIdentity({
      legacyCookie: ACTIVE,
      activeToken: ACTIVE,
      roleHeader: role,
      actorHeader: actor,
      scopesHeader: undefined,
      platformMachineId: MACHINE,
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: null,
    });
    if (!id) throw new Error('identity did not resolve');
    return id;
  }

  /**
   * 「该吊销哪些会话」直调**生产实现** `platformAuthSessionsToRevoke`
   *（在 request-identity），吊销动作本身照 dashboard.ts 的写法逐个调
   * `endDashboardAuthSession` 的等价物（这里就是四个注册表的 end/清理）。
   *
   * 刻意不复刻「四表并集 + 筛选」那段算法：此前测试自己抄了一份，于是把生产代码
   * 改回硬枚举时 5 个用例仍全绿 —— 锁的是复刻品不是生产逻辑（复审实测证伪了我
   * 原先「改回硬枚举 → 5 个全红」的说法）。现在改回硬枚举会真的红。
   */
  function revokeOnUnbind(
    scope: string,
    registries: {
      terminalControl: TerminalControlManager;
      previewInteraction: PreviewInteractionManager;
      connections: AuthSessionConnectionRegistry;
      csrf: ControlCsrfTokens;
    },
  ): string[] {
    const toRevoke = platformAuthSessionsToRevoke(scope, [
      registries.terminalControl,
      registries.previewInteraction,
      registries.connections,
      registries.csrf,
    ]);
    // 与 dashboard.ts 的 endDashboardAuthSession 逐字对应的同一组副作用。
    for (const id of toRevoke) {
      registries.terminalControl.releaseByAuthSession(id);
      registries.previewInteraction.relockAuthSession(id);
      registries.connections.closeAuthSession(id);
      registries.csrf.revokeAuthSession(id);
    }
    return toRevoke;
  }

  function freshRegistries() {
    return {
      terminalControl: new TerminalControlManager({ secret: 'unbind-secret', audit: { append() {} } }),
      previewInteraction: new PreviewInteractionManager({ audit: { append() {} } }),
      connections: new AuthSessionConnectionRegistry(),
      csrf: new ControlCsrfTokens(),
    };
  }

  it('三个协管者各自的连接与票据都被吊销 —— 一个都不能漏', () => {
    const r = freshRegistries();
    const admins = ['ou_alice', 'ou_bob', 'ou_carol'].map(a => identityOf(a));
    const closed: string[] = [];
    for (const id of admins) {
      // 平台 owner 身份走 registerReadSocket / 长连接 / CSRF 票据这几条路
      // （terminalCapability='owner' 的 takeover 直接返回 reused，不建租约，
      //  所以租约表里本来就可能没有它 —— 这正是要取四表并集的原因）。
      r.terminalControl.registerReadSocket(id.authSessionId, { destroyed: false, destroy() { /* noop */ } } as never);
      r.connections.register(id.authSessionId, () => { closed.push(id.authSessionId); });
      r.csrf.mint(id.authSessionId);
    }
    expect(r.csrf.size()).toBe(3);

    const revoked = revokeOnUnbind(SCOPE, r);

    expect(revoked.sort()).toEqual(admins.map(a => a.authSessionId).sort());
    expect(closed.sort()).toEqual(admins.map(a => a.authSessionId).sort());
    expect(r.csrf.size()).toBe(0);
    expect(r.connections.authSessionIds()).toEqual([]);
    expect(r.terminalControl.authSessionIds()).toEqual([]);
  });

  it('不带 actor 的老平台会话仍被吊销（不回归）', () => {
    const r = freshRegistries();
    const legacyPlatform = identityOf(undefined);
    let closed = false;
    r.connections.register(legacyPlatform.authSessionId, () => { closed = true; });
    r.csrf.mint(legacyPlatform.authSessionId);

    expect(revokeOnUnbind(SCOPE, r)).toEqual([legacyPlatform.authSessionId]);
    expect(closed).toBe(true);
    expect(r.csrf.size()).toBe(0);
  });

  it('非平台身份不被误伤：legacy owner 与 H5 会话的连接照旧存活', () => {
    const r = freshRegistries();
    const platform = identityOf('ou_alice');
    let platformClosed = false;
    let bystanderClosed = false;
    r.connections.register(platform.authSessionId, () => { platformClosed = true; });
    r.connections.register(`legacy-${ACTIVE}`, () => { bystanderClosed = true; });
    r.connections.register('h5-session-abc', () => { bystanderClosed = true; });
    r.csrf.mint(platform.authSessionId);
    r.csrf.mint(`legacy-${ACTIVE}`);

    expect(revokeOnUnbind(SCOPE, r)).toEqual([platform.authSessionId]);
    expect(platformClosed).toBe(true);
    expect(bystanderClosed).toBe(false);
    // legacy 的票据还在（它由 token rotation 那条路管，不由解绑管）。
    expect(r.csrf.size()).toBe(1);
  });

  it('别的机器的平台会话不被误伤（多机场景）', () => {
    const r = freshRegistries();
    const mine = identityOf('ou_alice');
    const theirs = 'scope-machine-2:ou_alice:owner';
    let mineClosed = false;
    let theirsClosed = false;
    r.connections.register(mine.authSessionId, () => { mineClosed = true; });
    r.connections.register(theirs, () => { theirsClosed = true; });

    expect(revokeOnUnbind(SCOPE, r)).toEqual([mine.authSessionId]);
    expect(mineClosed).toBe(true);
    expect(theirsClosed).toBe(false);
  });

  it('只在其中一个表里有状态的会话也会被扫到（四表取并集的意义）', () => {
    const r = freshRegistries();
    const onlyCsrf = identityOf('ou_dave');
    const onlySocket = identityOf('ou_erin');
    r.csrf.mint(onlyCsrf.authSessionId);
    r.terminalControl.registerReadSocket(
      onlySocket.authSessionId,
      { destroyed: false, destroy() { /* noop */ } } as never,
    );

    expect(revokeOnUnbind(SCOPE, r).sort()).toEqual(
      [onlyCsrf.authSessionId, onlySocket.authSessionId].sort(),
    );
  });
});
