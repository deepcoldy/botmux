/**
 * `botmux setup` 交互式取凭证：哪条来源算「本次刚创建的应用」。
 *
 * 这个信号只在 `obtainCredentials` 按来源分支置位，下游（promptBotConfig 挂
 * SETUP_APP_JUST_CREATED → finishOpenPlatformSetup 的 appJustCreated → 白名单
 * allowBlindWrite）全是原样透传，所以判定必须在这一层锁住。
 *
 * 曾经的 bug：Web console 建应用失败后退到 SDK 兼容模式，那条成功返回漏了
 * appJustCreated —— 兼容模式建出的**新**应用拿不到盲写授权，safe_setting 读不出来
 * 时按「保护存量用户条目」零写入，可新应用压根没有条目可保护，结果 redirect 白名单
 * 一条没写，用户一点授权就 20029。
 *
 * Run: pnpm vitest run test/cli-setup-app-just-created.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 工厂在文件顶部提升，引用不到普通的顶层 const，用 vi.hoisted 提前建好桩。
const mocks = vi.hoisted(() => ({
  tryRegisterApp: vi.fn(),
  createFeishuOpenPlatformApp: vi.fn(),
  inspectCachedFeishuOpenPlatformSession: vi.fn(),
  readStoredCookiesFromSessionFile: vi.fn(),
  prepareFeishuWebSession: vi.fn(),
  createOpenPlatformApiClient: vi.fn(),
  listOpenPlatformApps: vi.fn(),
  fetchOpenPlatformAppSecret: vi.fn(),
}));

// 只覆盖 obtainCredentials 会打到的那几个出口，其余导出保持真实：这两个模块都被
// 别的模块静态 import，整份替换会让那些模块拿到空导出而在加载时炸掉。
vi.mock('../src/setup/register-app.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tryRegisterApp: mocks.tryRegisterApp,
}));

vi.mock('../src/setup/open-platform-automation.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFeishuOpenPlatformApp: mocks.createFeishuOpenPlatformApp,
  inspectCachedFeishuOpenPlatformSession: mocks.inspectCachedFeishuOpenPlatformSession,
  readStoredCookiesFromSessionFile: mocks.readStoredCookiesFromSessionFile,
  prepareFeishuWebSession: mocks.prepareFeishuWebSession,
  createOpenPlatformApiClient: mocks.createOpenPlatformApiClient,
  listOpenPlatformApps: mocks.listOpenPlatformApps,
  fetchOpenPlatformAppSecret: mocks.fetchOpenPlatformAppSecret,
}));

import { obtainCredentials } from '../src/cli.js';

/**
 * 假 readline：按队列吐答案（队列空了回空串）。vitest 的 stdin/stdout 不是 TTY，
 * pickChoice 走「序号文本输入」回退分支，所以菜单选择也是从这个队列里取。
 * `ask()` 会挂 error 监听，补上 once/off 空实现。
 */
function fakeRl(answers: string[]) {
  const self: any = {
    question(_q: string, cb: (answer: string) => void) { cb(answers.shift() ?? ''); },
    once() { return self; },
    off() { return self; },
    on() { return self; },
  };
  return self;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  // 默认：没有可复用的飞书登录态，也没有旧 cookie —— 建应用分支不会多问一次「重新扫码」。
  mocks.inspectCachedFeishuOpenPlatformSession.mockResolvedValue({ ok: false, reason: 'missing_session', message: 'none' });
  mocks.readStoredCookiesFromSessionFile.mockReturnValue([]);
});

describe('obtainCredentials 的 appJustCreated 信号', () => {
  it('没有登录态时默认走网页扫码创建，不走确认链接 → appJustCreated=true', async () => {
    mocks.createFeishuOpenPlatformApp.mockResolvedValue({ ok: true, appId: 'cli_web_new', appSecret: 'web-secret' });

    const creds = await obtainCredentials(fakeRl(['', '']));

    expect(mocks.tryRegisterApp).not.toHaveBeenCalled();
    expect(mocks.createFeishuOpenPlatformApp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ forceQrLogin: true }));
    expect(creds.ok && creds.appJustCreated).toBe(true);
  });

  it('有效登录态下确认账号即免扫码创建，不弹码也不走确认链接', async () => {
    mocks.inspectCachedFeishuOpenPlatformSession.mockResolvedValue({
      ok: true,
      identity: { userId: 'u_1', userName: '测试用户', tenantId: 't_1', tenantName: '测试企业' },
    });
    mocks.createFeishuOpenPlatformApp.mockResolvedValue({ ok: true, appId: 'cli_web_reuse', appSecret: 'web-secret' });

    // 飞书应用来源默认项 → 名称默认 → 「确认并免扫码添加」默认项
    const creds = await obtainCredentials(fakeRl(['', '', '']));

    expect(mocks.tryRegisterApp).not.toHaveBeenCalled();
    expect(mocks.createFeishuOpenPlatformApp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      disableQrLogin: true,
      expectedIdentity: { userId: 'u_1', tenantId: 't_1' },
    }));
    const options = mocks.createFeishuOpenPlatformApp.mock.calls[0][0];
    expect(options.forceQrLogin).toBeUndefined();
    expect(creds).toMatchObject({ ok: true, appId: 'cli_web_reuse', appJustCreated: true, webSessionReady: true });
  });

  it('网页创建失败后改用飞书确认链接 → 以官方清单注册，标记 appJustCreated 并待回读注册结果', async () => {
    // Web console 建应用失败且没建出半成品（无 appId）→ 才会问是否改用确认链接。
    mocks.createFeishuOpenPlatformApp.mockResolvedValue({ ok: false, reason: 'network', message: 'console 不可达' });
    mocks.tryRegisterApp.mockResolvedValue({
      ok: true,
      appId: 'cli_sdk_new',
      appSecret: crypto.randomUUID(),
      brand: 'feishu',
      userOpenId: 'ou_scanner',
    });

    const creds = await obtainCredentials(fakeRl(['', '我的机器人', '1']));

    expect(mocks.tryRegisterApp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      appPreset: expect.objectContaining({ name: '我的机器人' }),
      addons: expect.objectContaining({ scopes: expect.objectContaining({ tenant: expect.any(Array), user: expect.any(Array) }) }),
    }));
    expect(creds).toMatchObject({ ok: true, appId: 'cli_sdk_new', appJustCreated: true, registeredWithAddons: true });
  });

  it('选择已有应用 → appJustCreated 不置位（存量应用的白名单里有用户自己的条目）', async () => {
    mocks.prepareFeishuWebSession.mockResolvedValue({ ok: true, cookies: [] });
    mocks.createOpenPlatformApiClient.mockResolvedValue({ ok: true, client: {} });
    mocks.listOpenPlatformApps.mockResolvedValue([{ clientId: 'cli_existing', name: '存量应用' }]);
    mocks.fetchOpenPlatformAppSecret.mockResolvedValue('existing-secret');

    const creds = await obtainCredentials(fakeRl([
      '2',  // 飞书应用来源 → 「选择已有应用」
      '1',  // 应用列表 → 第一个（这个菜单没有默认项，空串会当 Esc 退回）
    ]));

    expect(creds.ok).toBe(true);
    if (creds.ok) {
      expect(creds.appId).toBe('cli_existing');
      expect(creds.appJustCreated).toBeFalsy();
    }
  });

  it('手动输入 AppID/Secret → appJustCreated 不置位', async () => {
    const creds = await obtainCredentials(fakeRl([
      '3',            // 飞书应用来源 → 「手动输入 AppID/Secret」
      '',             // 租户类型 → 默认飞书
      'cli_manual',   // AppID
      'manual-secret',// AppSecret
    ]));

    expect(creds.ok).toBe(true);
    if (creds.ok) {
      expect(creds.appId).toBe('cli_manual');
      expect(creds.appJustCreated).toBeFalsy();
    }
  });

  it('网页创建 1.0.0 触发审批兼容时透传 approvalDeferredScopes 与审批人信息给后续 1.0.1', async () => {
    mocks.createFeishuOpenPlatformApp.mockResolvedValue({
      ok: true,
      appId: 'cli_web_compat',
      appSecret: 'web-secret',
      approvalDeferredScopes: [
        { bucket: 'user', name: 'offline_access', isolation: 'exact', group: 'offline_access' },
      ],
      approvalDisabledRefreshToken: true,
      approvalCompatibility: {
        triggered: true,
        resolvedAutoApproved: true,
        deferredScopes: [{ bucket: 'user', name: 'offline_access', isolation: 'exact', group: 'offline_access' }],
        disabledRefreshToken: true,
        initialHumanApprovers: ['张审核'],
        remainingHumanApprovers: [],
        probeCount: 2,
        stopReason: 'resolved_exact',
      },
    });

    const creds = await obtainCredentials(fakeRl(['', '']));
    expect(creds).toMatchObject({
      ok: true,
      appId: 'cli_web_compat',
      appJustCreated: true,
      approvalDeferredScopes: [
        { bucket: 'user', name: 'offline_access', isolation: 'exact', group: 'offline_access' },
      ],
      approvalDisabledRefreshToken: true,
      approvalInitialApprovers: ['张审核'],
    });
  });
});
