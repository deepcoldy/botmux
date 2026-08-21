// test/platform-browser-authorities.test.ts
// #933 回归修复：平台隧道反代不透传 X-Forwarded-Host、且把 Host 改写成回环上游，
// 于是浏览器管理类 WS 携带的 `Origin: https://<前缀>-<machineId>.<平台域名>` 在
// dashboard 同源校验里找不到候选 authority → 判跨站 403 → 平台浏览器终端 disconnected。
// 修法：由本机 platform.json 派生 {m-,t-}<machineId>.<平台host> 精确前缀并入候选。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readSecureHostFileSync = vi.fn();
vi.mock('../src/platform/secure-host-file.js', () => ({
  readSecureHostFileSync: (...a: unknown[]) => readSecureHostFileSync(...a),
  writeSecureHostFileSync: vi.fn(),
  unlinkSecureHostFileSync: vi.fn(),
  UnsafeHostAuthorityFileError: class extends Error {},
}));

import { platformBrowserAuthorities } from '../src/platform/binding.js';
import { managementUpgradeOrigin } from '../src/dashboard/control-csrf.js';

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

  it('绑定平台时派生 m-/t- 两个精确前缀 authority（host 形式，含平台 host）', () => {
    bindTo('https://botmux.example.com');
    expect(platformBrowserAuthorities()).toEqual([
      `m-${MACHINE_ID}.botmux.example.com`,
      `t-${MACHINE_ID}.botmux.example.com`,
    ]);
  });

  it('未绑定平台 → 空数组（fail-closed，不放行任何平台 authority）', () => {
    bindTo(null);
    expect(platformBrowserAuthorities()).toEqual([]);
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
    expect(platformBrowserAuthorities()).toHaveLength(2);
    // 解绑（unbind 热重载不重启 daemon）：下一次调用必须当场读到「没绑定」。
    bindTo(null);
    expect(platformBrowserAuthorities()).toEqual([]);
  });
});

describe('#933 managementUpgradeOrigin 认平台子域', () => {
  it('平台 t- 子域 Origin 在 Host 被改写成回环、无 XFH 时仍判同源（disconnected 修复）', () => {
    bindTo('https://botmux.example.com');
    const verdict = managementUpgradeOrigin({
      origin: `https://t-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891', // 平台隧道裸桥接后 daemon 看到的 Host
      // 注意：无 x-forwarded-host —— 正是线上的实况
    });
    expect(verdict.ok).toBe(true);
  });

  it('平台 m- 机器子域 Origin 同样判同源', () => {
    bindTo('https://botmux.example.com');
    const verdict = managementUpgradeOrigin({
      origin: `https://m-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891',
    });
    expect(verdict.ok).toBe(true);
  });

  it('反向变异守卫：未绑定平台时，同一 t- Origin 必被判跨站拒（证明放行确实来自派生而非放水）', () => {
    bindTo(null);
    const verdict = managementUpgradeOrigin({
      origin: `https://t-${MACHINE_ID}.botmux.example.com`,
      host: '127.0.0.1:7891',
    });
    expect(verdict.ok).toBe(false);
  });

  it('负向：别的 machineId 的平台子域仍判跨站拒（白名单精确到本机、不越界）', () => {
    bindTo('https://botmux.example.com');
    const verdict = managementUpgradeOrigin({
      origin: 'https://t-deadbeefdeadbeef.botmux.example.com',
      host: '127.0.0.1:7891',
    });
    expect(verdict.ok).toBe(false);
  });

  it('负向：本机 machineId 但挂在别的平台域名下仍判跨站拒（host 精确相等）', () => {
    bindTo('https://botmux.example.com');
    const verdict = managementUpgradeOrigin({
      origin: `https://t-${MACHINE_ID}.evil.example.com`,
      host: '127.0.0.1:7891',
    });
    expect(verdict.ok).toBe(false);
  });
});
