// test/platform-browser-authorities.test.ts
// #933 回归修复：平台隧道反代不透传 X-Forwarded-Host、且把 Host 改写成回环上游，
// 于是浏览器管理类 WS 携带的 `Origin: https://<前缀>-<machineId>.<平台域名>` 在
// dashboard 同源校验里找不到候选 authority → 判跨站 403 → 平台浏览器终端 disconnected。
// 修法：由本机 platform.json 派生 {m-,t-}<machineId>.<平台host> 精确前缀并入候选。
// 两个子域按用途分档（见 platformBrowserAuthorities 的 surface 参数）：终端 WS 升级
// 认 m-/t-（终端页就住在 t-，#960 的首开可写链路依赖它）；有副作用的管理类 POST 只
// 认 m-（SPA 与 CSRF 票据只在那张壳页里）。本文件两组用例分别钉住这两档。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readSecureHostFileSync = vi.fn();
vi.mock('../src/platform/secure-host-file.js', () => ({
  readSecureHostFileSync: (...a: unknown[]) => readSecureHostFileSync(...a),
  writeSecureHostFileSync: vi.fn(),
  unlinkSecureHostFileSync: vi.fn(),
  UnsafeHostAuthorityFileError: class extends Error {},
}));

import { platformBrowserAuthorities } from '../src/platform/binding.js';
import {
  ControlCsrfTokens,
  classifyManagementUpgrade,
  guardControlRequest,
  managementUpgradeOrigin,
} from '../src/dashboard/control-csrf.js';

const MACHINE_ID = 'ff27a1b1e45b4504';
function bindTo(platformUrl: string | null): void {
  readSecureHostFileSync.mockReset();
  readSecureHostFileSync.mockReturnValue(
    platformUrl === null
      ? null
      : JSON.stringify({ platformUrl, machineId: MACHINE_ID, machineToken: 'tkn' }),
  );
}

describe('platformBrowserAuthorities', () => {
  beforeEach(() => readSecureHostFileSync.mockReset());

  it('终端 WS 升级派生 m-/t- 两个精确前缀 authority（host 形式，含平台 host）', () => {
    bindTo('https://botmux.example.com');
    // 平台分享出去的终端页挂在 `t-` 子域，它的 WS 握手 Origin 就是 `t-`——#933/#960
    // 修的正是这一条，缺了它平台浏览器终端整片 disconnected。
    expect(platformBrowserAuthorities('terminal-upgrade')).toEqual([
      `m-${MACHINE_ID}.botmux.example.com`,
      `t-${MACHINE_ID}.botmux.example.com`,
    ]);
  });

  it('管理类请求只派生 m- 机器子域（缺省档），`t-` 不进候选', () => {
    bindTo('https://botmux.example.com');
    // Dashboard SPA 只在 `m-` 子域下渲染，CSRF 票据也只注入那张壳页；`t-` 上的终端
    // 页既没有票据也没有任何管理请求要发。把它算进「同源」只是白白多给一条子域
    // 发起写操作的资格。缺省档必须是窄的那一档（漏传参数不会 fail-open）。
    expect(platformBrowserAuthorities('management')).toEqual([`m-${MACHINE_ID}.botmux.example.com`]);
    expect(platformBrowserAuthorities()).toEqual([`m-${MACHINE_ID}.botmux.example.com`]);
  });

  it('未绑定平台 → 空数组（fail-closed，不放行任何平台 authority）', () => {
    bindTo(null);
    expect(platformBrowserAuthorities()).toEqual([]);
    expect(platformBrowserAuthorities('terminal-upgrade')).toEqual([]);
  });

  it('platformUrl 不可解析 → 空数组，不抛', () => {
    readSecureHostFileSync.mockReset();
    readSecureHostFileSync.mockReturnValue(
      JSON.stringify({ platformUrl: 'not a url', machineId: MACHINE_ID, machineToken: 'tkn' }),
    );
    expect(platformBrowserAuthorities()).toEqual([]);
  });

  it('每次调用都重读 platform.json（不缓存）：解绑后当次即空 = 无 fail-open', () => {
    bindTo('https://botmux.example.com');
    expect(platformBrowserAuthorities('terminal-upgrade')).toHaveLength(2);
    // 解绑（unbind 热重载不重启 daemon）：下一次调用必须当场读到「没绑定」。
    bindTo(null);
    expect(platformBrowserAuthorities('terminal-upgrade')).toEqual([]);
  });
});

describe('#933 managementUpgradeOrigin 认平台子域', () => {
  it('平台 t- 子域 Origin 在 Host 被改写成回环、无 XFH 时仍判同源（disconnected 修复）', () => {
    bindTo('https://botmux.example.com');
    const verdict = managementUpgradeOrigin({
      origin: `https://t-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891', // 平台隧道裸桥接后 daemon 看到的 Host
      // 注意：无 x-forwarded-host —— 正是线上的实况
      // surface 必须显式给 `terminal-upgrade`：这一档才含 `t-`，而缺省是窄档。
    }, 'terminal-upgrade');
    expect(verdict.ok).toBe(true);
  });

  it('平台 m- 机器子域 Origin 同样判同源', () => {
    bindTo('https://botmux.example.com');
    const verdict = managementUpgradeOrigin({
      origin: `https://m-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891',
    }, 'terminal-upgrade');
    expect(verdict.ok).toBe(true);
  });

  it('反向变异守卫：未绑定平台时，同一 t- Origin 必被判跨站拒（证明放行确实来自派生而非放水）', () => {
    bindTo(null);
    const verdict = managementUpgradeOrigin({
      origin: `https://t-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891',
    }, 'terminal-upgrade');
    expect(verdict.ok).toBe(false);
  });

  it('负向：别的 machineId 的平台子域仍判跨站拒（白名单精确到本机、不越界）', () => {
    bindTo('https://botmux.example.com');
    const verdict = managementUpgradeOrigin({
      origin: 'https://t-deadbeefdeadbeef.botmux.example.com',
      host: '127.0.0.1:7891',
    }, 'terminal-upgrade');
    expect(verdict.ok).toBe(false);
  });

  it('负向：本机 machineId 但挂在别的平台域名下仍判跨站拒（host 精确相等）', () => {
    bindTo('https://botmux.example.com');
    const verdict = managementUpgradeOrigin({
      origin: `https://t-${MACHINE_ID}.evil.example.com`,
      host: '127.0.0.1:7891',
    }, 'terminal-upgrade');
    expect(verdict.ok).toBe(false);
  });
});

/**
 * 独立安全边界：WS 升级过去在「这是 /s 还是 /debug-terminal」分流**之前**就统一按
 * `terminal-upgrade` 档跑同源判定，于是平台分享出去的终端子域 `t-` 连带成了调试终端
 * WS 的可信来源——而那条 WS 的另一头是宿主的裸 bash。两条路径的信任面本来就不同：
 *   • `/s/<id>`：终端页住在 `t-`，必须继续认 m-+t-（否则平台浏览器终端整片断线）；
 *   • `/debug-terminal/<id>/ws`：只有管理壳页会开它，只认 management 档（m- / 本机 Host）。
 * 未知升级路径同样落窄档：漏加一条前缀的失败方向是「连不上」，而不是静默放行。
 */
describe('WS 升级按 path 分流 authority 档位（调试终端不认 t-）', () => {
  it('/s/<id> 落 terminal-upgrade 档，/debug-terminal/<id>/ws 落 management 档', () => {
    expect(classifyManagementUpgrade('/s/s1?token=abc'))
      .toEqual({ route: 'session-terminal', surface: 'terminal-upgrade' });
    expect(classifyManagementUpgrade('/s'))
      .toEqual({ route: 'session-terminal', surface: 'terminal-upgrade' });
    expect(classifyManagementUpgrade('/debug-terminal/xyz/ws'))
      .toEqual({ route: 'debug-terminal', surface: 'management' });
  });

  it('未知升级路径落窄档且标 unknown（fail-closed，不给平台 t- 背书）', () => {
    expect(classifyManagementUpgrade('/whatever'))
      .toEqual({ route: 'unknown', surface: 'management' });
    // 前缀相近但不是终端路径：`/sneaky` 不能被 `/s` 前缀匹配吃掉。
    expect(classifyManagementUpgrade('/sneaky/ws'))
      .toEqual({ route: 'unknown', surface: 'management' });
  });

  it('缺省 surface 是窄档：调用方漏传参数也不会把 t- 放进候选', () => {
    bindTo('https://botmux.example.com');
    expect(managementUpgradeOrigin({
      origin: `https://t-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891',
    })).toEqual({ ok: false, error: 'upgrade_origin_forbidden' });
  });

  it('平台 t- 终端子域：/s 升级仍放行（不回退 #960），/debug-terminal 升级被拒', () => {
    bindTo('https://botmux.example.com');
    const headers = {
      origin: `https://t-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891',
    };
    expect(managementUpgradeOrigin(headers, classifyManagementUpgrade('/s/s1').surface))
      .toEqual({ ok: true });
    expect(managementUpgradeOrigin(headers, classifyManagementUpgrade('/debug-terminal/t1/ws').surface))
      .toEqual({ ok: false, error: 'upgrade_origin_forbidden' });
  });

  it('平台 m- 机器子域：两条路径都放行（管理壳页本来就住在 m-）', () => {
    bindTo('https://botmux.example.com');
    const headers = {
      origin: `https://m-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891',
    };
    expect(managementUpgradeOrigin(headers, classifyManagementUpgrade('/s/s1').surface))
      .toEqual({ ok: true });
    expect(managementUpgradeOrigin(headers, classifyManagementUpgrade('/debug-terminal/t1/ws').surface))
      .toEqual({ ok: true });
  });
});

/**
 * 同一份 requestAuthorities 还喂着「有副作用 POST」的 CSRF/同源门，工作台行内
 * 「接管」发出的 POST /api/sessions/:id/control/takeover 走的正是它。
 *
 * 之前这条腿没有用例：只钉住 WS 那半边的话，谁把平台 authority 收窄成「只给
 * WS 升级用」都不会转红，而用户看到的会是「终端连上了、点接管却 403，面板停在
 * 只读」——终端能看不能操作，比整片 disconnected 更难定位。
 */
describe('#933 平台子域下「接管」POST 的同源门', () => {
  const AUTH_SESSION = 'platform:machine-scope:owner';
  const tokens = new ControlCsrfTokens();
  const csrf = tokens.mint(AUTH_SESSION);
  /** 平台隧道裸桥接后 daemon 看到的请求形状：Host 已被改写成回环、无 XFH。 */
  const headersFrom = (origin: string) => ({ origin, host: '127.0.0.1:7891', 'x-botmux-csrf': csrf });
  const guard = (origin: string) => guardControlRequest({
    headers: headersFrom(origin),
    authSessionId: AUTH_SESSION,
    tokens,
  });

  it('已绑定平台：m- 机器子域发起的接管 POST 判同源并放行', () => {
    bindTo('https://botmux.example.com');
    expect(guard(`https://m-${MACHINE_ID}.botmux.example.com`)).toEqual({ ok: true });
  });

  it('已绑定平台：t- 终端子域发起的接管 POST 仍判跨站拒（管理面只信 m-）', () => {
    bindTo('https://botmux.example.com');
    // 这一条与上面那组 WS 用例刻意方向相反，两者不是矛盾而是分工：
    //   • 终端页住在 `t-`，它的 **WS 升级**必须放行（#933/#960，见
    //     `managementUpgradeOrigin` 那组用例里 t- 仍判同源）；
    //   • 但它没有 CSRF 票据、也不发管理请求，**管理类 POST** 没有任何理由从
    //     那个子域打进来。之前把 t- 一并算作管理面同源，等于凭空多给一条子域
    //     发起「接管/释放」的资格。
    expect(guard(`https://t-${MACHINE_ID}.botmux.example.com`))
      .toEqual({ ok: false, status: 403, error: 'control_origin_forbidden' });
  });

  it('反向变异守卫：未绑定平台时同一 Origin 必 403（放行确实来自派生而非放水）', () => {
    bindTo(null);
    expect(guard(`https://m-${MACHINE_ID}.botmux.example.com`))
      .toEqual({ ok: false, status: 403, error: 'control_origin_forbidden' });
  });

  it('负向：别的 machineId 的平台子域仍判跨站拒', () => {
    bindTo('https://botmux.example.com');
    expect(guard('https://m-deadbeefdeadbeef.botmux.example.com'))
      .toEqual({ ok: false, status: 403, error: 'control_origin_forbidden' });
  });

  it('负向：本机 machineId 但挂在别的平台域名下仍判跨站拒', () => {
    bindTo('https://botmux.example.com');
    expect(guard(`https://m-${MACHINE_ID}.evil.example.com`))
      .toEqual({ ok: false, status: 403, error: 'control_origin_forbidden' });
  });
});
