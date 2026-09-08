import { describe, it, expect } from 'vitest';
import {
  isPlatformDashboardAuthSessionId,
  resolveDashboardIdentity,
  resolveDashboardRequestGate,
} from '../src/dashboard/request-identity.js';

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
      scopesHeader: undefined,
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
      scopesHeader: undefined,
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
      scopesHeader: undefined,
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

  /**
   * 回归：actor 段一加进来就改了 authSessionId 的分段数，而 dashboard.ts 有两个
   * 消费方（读能力存活判定 `terminalAuthSessionLive`、解绑吊销
   * `syncPlatformBindingRevocation`）曾各自硬枚举 `${scope}:owner|teammate|guest`
   * 三个字面量。这组用例把「产出」直接喂回「识别」，钉住两侧不再漂移 —— 上面那些
   * 只断言字符串长什么样的用例，是抓不到这类漏判的。
   */
  describe('authSessionId 的产出与识别必须同源', () => {
    const SCOPE = `scope-${MACHINE}`;

    it('带 actor 的协管者会话能被认出来 —— 否则终端只读链接 403「认证已结束」', () => {
      const id = resolve('ou_alice');
      expect(id?.authSessionId).toBeTruthy();
      expect(isPlatformDashboardAuthSessionId(id!.authSessionId, SCOPE)).toBe(true);
    });

    it('不带 actor 的老平台会话同样能被认出来（不回归）', () => {
      const id = resolve(undefined);
      expect(isPlatformDashboardAuthSessionId(id!.authSessionId, SCOPE)).toBe(true);
    });

    it('三种角色 × 有无 actor 六种组合全部可识别', () => {
      for (const role of ['owner', 'teammate', 'guest'] as const) {
        for (const actor of ['ou_alice', undefined]) {
          const id = resolve(actor, role);
          expect(isPlatformDashboardAuthSessionId(id!.authSessionId, SCOPE), `${role}/${actor}`).toBe(true);
        }
      }
    });

    it('别的机器的 scope 认不出来 —— 解绑吊销不能误伤其它机器的会话', () => {
      const id = resolve('ou_alice');
      expect(isPlatformDashboardAuthSessionId(id!.authSessionId, 'scope-other-machine')).toBe(false);
    });

    it('legacy 与 H5 的 authSessionId 不会被误认成平台身份', () => {
      expect(isPlatformDashboardAuthSessionId(`legacy-${ACTIVE}`, SCOPE)).toBe(false);
      expect(isPlatformDashboardAuthSessionId('random-h5-session-id', SCOPE)).toBe(false);
    });

    it('前缀相同但结构不对的串一律不认（fail closed）', () => {
      for (const bad of [
        SCOPE,                              // 只有 scope，没有角色
        `${SCOPE}:`,                        // 空角色
        `${SCOPE}:admin`,                   // 不是三种角色之一
        `${SCOPE}:ou_alice`,                // 有 actor 但没角色
        `${SCOPE}:ou_alice:admin`,          // 角色非法
        `${SCOPE}:ou_alice:owner:extra`,    // 段数超了
        `${SCOPE}-not-a-separator:owner`,   // 前缀只是字面相似
      ]) {
        expect(isPlatformDashboardAuthSessionId(bad, SCOPE), bad).toBe(false);
      }
    });
  });
});

/**
 * 二期：平台授予 `dashboard:manage` 的协管者可以改本机配置，
 * 但**绝不能**碰 debug shell / write-link / spawn-command。
 */
describe('platform dashboard:manage scope', () => {
  const ACTIVE = 'active-management-token';
  const MACHINE = 'machine-1';

  const resolve = (scopesHeader: string | string[] | undefined, role = 'owner') =>
    resolveDashboardIdentity({
      legacyCookie: ACTIVE,
      activeToken: ACTIVE,
      roleHeader: role,
      actorHeader: 'ou_alice',
      scopesHeader,
      platformMachineId: MACHINE,
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: null,
    });

  it('带 dashboard:manage 时拿到管理面能力', () => {
    expect(resolve('machines:read,sessions:open,terminal:control,dashboard:manage')?.canManageHost).toBe(true);
  });

  it('默认档（无 dashboard:manage）拿不到管理面', () => {
    expect(resolve('machines:read,sessions:open,terminal:control')?.canManageHost).toBe(false);
    expect(resolve(undefined)?.canManageHost).toBe(false);
    expect(resolve('')?.canManageHost).toBe(false);
  });

  it('guest 角色即使带 dashboard:manage 也不放行（fail-closed 的乘法）', () => {
    // 平台侧一个组合失误不该把只读访客提成配置管理员。
    expect(resolve('dashboard:manage', 'guest')?.canManageHost).toBe(false);
  });

  it('数组头视为缺失', () => {
    expect(resolve(['dashboard:manage'])?.canManageHost).toBe(false);
  });

  it('容忍空格与多余分隔符', () => {
    expect(resolve(' dashboard:manage , terminal:control ')?.canManageHost).toBe(true);
  });

  it('未知 scope 不影响判定，也不越权', () => {
    expect(resolve('some:future-scope')?.canManageHost).toBe(false);
    expect(resolve('some:future-scope,dashboard:manage')?.canManageHost).toBe(true);
  });

  it('本机管理 cookie 恒有管理面能力', () => {
    const legacy = resolveDashboardIdentity({
      legacyCookie: ACTIVE,
      activeToken: ACTIVE,
      roleHeader: undefined,
      actorHeader: undefined,
      scopesHeader: undefined,
      platformMachineId: null,
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: null,
    });
    expect(legacy?.kind).toBe('legacy-dashboard');
    expect(legacy?.canManageHost).toBe(true);
  });
});

describe('gate: dashboard:manage 开管理面但不开整机', () => {
  const ACTIVE = 'active-management-token';

  const managingCoManager = resolveDashboardIdentity({
    legacyCookie: ACTIVE,
    activeToken: ACTIVE,
    roleHeader: 'owner',
    actorHeader: 'ou_alice',
    scopesHeader: 'terminal:control,dashboard:manage',
    platformMachineId: 'machine-1',
    platformActorScope: machineId => `scope-${machineId}`,
    legacyAuthSessionId: token => `legacy-${token}`,
    h5: null,
  });

  const gateFor = (pathname: string, method = 'GET') =>
    resolveDashboardRequestGate({
      method,
      pathname,
      hasTokenParam: false,
      identity: managingCoManager,
      tokenFromRequest: undefined,
      activeToken: ACTIVE,
      publicReadOnly: false,
    });

  it('管理面路由放行（原本会被 workbench 窄门禁 401 挡死）', () => {
    for (const p of ['/api/settings', '/api/schedules', '/api/groups']) {
      const g = gateFor(p);
      expect(g.canManageHost, p).toBe(true);
      expect(g.decision.kind, p).toBe('allow');
    }
    expect(gateFor('/api/settings', 'PUT').decision.kind).toBe('allow');
  });

  it('但仍不是本机 owner —— 三个「拿到就等于拿到整机」的面照旧关着', () => {
    const g = gateFor('/api/settings');
    // dashboard.ts 里 debug-terminal / write-link / spawn-command 三处直接查
    // legacyAuthed，不看 decision，所以这个 false 就是那三处的拒绝依据。
    expect(g.legacyAuthed).toBe(false);
  });

  it('没有 dashboard:manage 的协管者仍走 workbench 窄门禁', () => {
    const plain = resolveDashboardIdentity({
      legacyCookie: ACTIVE,
      activeToken: ACTIVE,
      roleHeader: 'owner',
      actorHeader: 'ou_bob',
      scopesHeader: 'terminal:control',
      platformMachineId: 'machine-1',
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: null,
    });
    const g = resolveDashboardRequestGate({
      method: 'GET',
      pathname: '/api/settings',
      hasTokenParam: false,
      identity: plain,
      tokenFromRequest: undefined,
      activeToken: ACTIVE,
      publicReadOnly: false,
    });
    expect(g.canManageHost).toBe(false);
    expect(g.workbenchOnlyIdentity).toBe(true);
    expect(g.decision.kind).toBe('deny401');
  });
});

/**
 * F1（外仓复审 · 严重）：带 `dashboard:manage` 的协管者若在 URL 上随便带一个 `?t=`，
 * 会被回吐**本机真实管理 token**。
 *
 * 成因是 `1b47dd5` 为了让管理面路由走宽门禁，把活跃 token 代填进 `presentedToken`，
 * 却没同时压掉 `hasTokenParam`。`decideDashboardAuth` 有一条「首次带正确 ?t= →
 * allow+set-cookie，把 token 回写浏览器」的分支（auth.ts 的
 * `hasTokenParam && authed && presentedToken`），于是 `?t=任意值` 就能命中。
 *
 * 危害不是「多一次越权读」：泄漏的是**长期落盘凭证**，撤销协管授权也不失效，
 * 而 `config.dashboard.host` 默认 `0.0.0.0`（不是 loopback-only），拿到 token
 * 的人网络够得着 dashboard 端口就能直连本机、绕开平台的一切判权。
 */
describe('F1: 协管者不得拿到本机管理 token', () => {
  const ACTIVE = 'REAL-ACTIVE-TOKEN';

  const managing = () => resolveDashboardIdentity({
    legacyCookie: ACTIVE,
    activeToken: ACTIVE,
    roleHeader: 'owner',
    actorHeader: 'ou_comanager',
    scopesHeader: 'terminal:control,dashboard:manage',
    platformMachineId: 'm1',
    platformActorScope: m => `scope-${m}`,
    legacyAuthSessionId: t => `legacy-${t}`,
    h5: null,
  });

  const gate = (identity: ReturnType<typeof managing>, hasTokenParam: boolean, tokenFromRequest?: string) =>
    resolveDashboardRequestGate({
      method: 'GET',
      pathname: '/api/settings',
      hasTokenParam,
      identity,
      tokenFromRequest,
      activeToken: ACTIVE,
      publicReadOnly: false,
    });

  it('带任意 ?t= 也绝不回吐 token（allow 但不 set-cookie）', () => {
    const d = gate(managing(), true, 'whatever-garbage').decision;
    expect(d.kind).toBe('allow');
    expect((d as { token?: string }).token).toBeUndefined();
  });

  it('即便 ?t= 恰好是正确的活跃 token 也不下发 cookie', () => {
    // 协管者不该持有这个值；万一从别处得知，也不能借这条路把它固化成本机 cookie。
    const d = gate(managing(), true, ACTIVE).decision;
    expect((d as { token?: string }).token).toBeUndefined();
  });

  it('管理面可达性不受影响（修复没有把功能一起关掉）', () => {
    const g = gate(managing(), false, undefined);
    expect(g.canManageHost).toBe(true);
    expect(g.decision.kind).toBe('allow');
  });

  it('legacy owner 带正确 ?t= 仍然 allow+set-cookie —— 不能连坐', () => {
    const legacy = resolveDashboardIdentity({
      legacyCookie: ACTIVE,
      activeToken: ACTIVE,
      roleHeader: undefined,
      actorHeader: undefined,
      scopesHeader: undefined,
      platformMachineId: null,
      platformActorScope: m => `scope-${m}`,
      legacyAuthSessionId: t => `legacy-${t}`,
      h5: null,
    });
    const d = resolveDashboardRequestGate({
      method: 'GET',
      pathname: '/api/settings',
      hasTokenParam: true,
      identity: legacy,
      tokenFromRequest: ACTIVE,
      activeToken: ACTIVE,
      publicReadOnly: false,
    }).decision;
    expect(d.kind).toBe('allow+set-cookie');
    expect((d as { token?: string }).token).toBe(ACTIVE);
  });
});
