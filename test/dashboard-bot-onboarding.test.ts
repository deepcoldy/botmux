import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotOnboardingManager } from '../src/dashboard/bot-onboarding.js';
import type { RegisterAppOptions, RegisterAppResult } from '../src/setup/register-app.js';
import type { OpenPlatformAutomationResult } from '../src/setup/open-platform-automation.js';

const { userGetMock, batchGetIdMock } = vi.hoisted(() => ({
  userGetMock: vi.fn(),
  batchGetIdMock: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    contact = {
      v3: {
        user: {
          get: userGetMock,
          batchGetId: batchGetIdMock,
        },
      },
    };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

// 默认注入的 automation 桩: 缓存命中 → 静默成功, 不出第二个二维码.
const autoOk = (): OpenPlatformAutomationResult => ({
  ok: true,
  sessionFile: '/tmp/feishu-session.json',
  sessionSource: 'botmux_cache',
  cookieCount: 3,
  scopeCount: 9,
  skippedScopeCount: 0,
});

describe('BotOnboardingManager', () => {
  beforeEach(() => {
    userGetMock.mockReset();
    userGetMock.mockResolvedValue({ code: 99992361, msg: 'user is not visible to this app' });
    batchGetIdMock.mockReset();
    batchGetIdMock.mockResolvedValue({ code: 0, data: { user_list: [] } });
  });

  it('publishes a scannable QR status while registration is waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const pending = deferred<RegisterAppResult>();
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async (opts?: RegisterAppOptions) => {
        opts?.onQRCodeReady?.({ url: 'https://open.feishu.cn/scan-me', expireIn: 600 });
        return pending.promise;
      },
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: (url) => `data:image/svg+xml;base64,${Buffer.from(url).toString('base64')}`,
    });

    const job = manager.start();
    await Promise.resolve();

    const status = manager.get(job.id);
    expect(status?.status).toBe('waiting_for_scan');
    expect(status?.qrUrl).toBe('https://open.feishu.cn/scan-me');
    expect(status?.qrDataUrl).toContain('data:image/svg+xml;base64,');

    pending.resolve({ ok: false, error: 'aborted', message: 'cancelled' });
    await job.done;
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses one Feishu Web QR as the primary path and carries the chosen app name through the job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-web-'));
    const pending = deferred<any>();
    const registerApp = vi.fn(async () => ({ ok: false as const, error: 'unknown' as const, message: 'must not run' }));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      createApp: async (opts) => {
        expect(opts.forceQrLogin).toBe(true);
        expect(opts.disableBytedcliFallback).toBe(true);
        await opts.onQrCode?.({ qrText: 'ascii', qrPayload: '{"qrlogin":{"token":"one-scan"}}' });
        return pending.promise;
      },
      registerApp,
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async opts => {
        expect(opts.disableQrLogin).toBe(true);
        expect(opts.disableBytedcliFallback).toBe(true);
        return autoOk();
      },
      renderQrDataUrl: (payload) => `data:image/svg+xml;base64,${Buffer.from(payload).toString('base64')}`,
    });

    const job = manager.start({ appName: '研发助手', sessionMode: 'qr' });
    await Promise.resolve();
    expect(manager.get(job.id)).toMatchObject({
      status: 'waiting_for_scan',
      appName: '研发助手',
      qrDataUrl: expect.stringContaining('data:image/svg+xml;base64,'),
    });

    pending.resolve({
      ok: true,
      appId: 'cli_web',
      appSecret: 'web-secret',
      brand: 'feishu',
      sessionFile: '/tmp/feishu-session.json',
      sessionSource: 'qr_login',
      sessionIdentity: { userId: 'u_1', userName: 'Alice', tenantId: 't_1', tenantName: 'Example' },
    });
    await job.done;

    expect(registerApp).not.toHaveBeenCalled();
    expect(manager.get(job.id)).toMatchObject({ status: 'needs_owner', appId: 'cli_web', appName: '研发助手' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-confirms the owner from the web session email and completes without needs_owner', async () => {
    // Web 主路径没有 device-flow 的 userOpenId, 但 session identity 里有创建者邮箱——
    // 能解析成 union_id 时直接落 on_ 完成, 不再让用户手填一遍 owner。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-web-owner-'));
    batchGetIdMock.mockResolvedValueOnce({
      code: 0,
      data: { user_list: [{ email: 'creator@corp.com', user_id: 'on_creator' }] },
    });
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      createApp: async () => ({
        ok: true,
        appId: 'cli_web_owner',
        appSecret: 'web-secret',
        brand: 'feishu',
        sessionFile: '/tmp/feishu-session.json',
        sessionSource: 'botmux_cache',
        sessionIdentity: { userId: 'u_1', userName: 'Alice', email: 'creator@corp.com', tenantId: 't_1', tenantName: 'Example' },
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
    });

    const job = manager.start({ sessionMode: 'reuse', expectedIdentity: { userId: 'u_1', tenantId: 't_1' } });
    await job.done;

    expect(manager.get(job.id)?.status).toBe('completed');
    expect(batchGetIdMock).toHaveBeenCalledWith({
      params: { user_id_type: 'union_id' },
      data: { emails: ['creator@corp.com'], include_resigned: false },
    });
    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({ larkAppId: 'cli_web_owner', allowedUsers: ['on_creator'] });
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the raw session email when union_id resolution is inconclusive', async () => {
    // scope 未生效 / 网络错误等无法证伪 → 直接落邮箱, 运行时 resolveAllowedUsers 再解析。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-web-email-'));
    batchGetIdMock.mockRejectedValueOnce(new Error('scope not effective yet'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      createApp: async () => ({
        ok: true,
        appId: 'cli_web_email',
        appSecret: 'web-secret',
        brand: 'feishu',
        sessionFile: '/tmp/feishu-session.json',
        sessionSource: 'botmux_cache',
        sessionIdentity: { userId: 'u_1', userName: 'Alice', email: 'creator@corp.com', tenantId: 't_1', tenantName: 'Example' },
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
    });

    const job = manager.start({ sessionMode: 'reuse' });
    await job.done;

    expect(manager.get(job.id)?.status).toBe('completed');
    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({ larkAppId: 'cli_web_email', allowedUsers: ['creator@corp.com'] });
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps needs_owner with a prefill suggestion when the session email is conclusively unusable', async () => {
    // 确凿不在本企业（成功响应但查不到 user_id, 如个人邮箱）→ 不落盘, 回落 needs_owner
    // 并把邮箱作为 suggestedOwner 预填给前端复核。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-web-unusable-'));
    // 默认 batchGetIdMock 即 code 0 + 空 user_list（见 beforeEach）。
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      createApp: async () => ({
        ok: true,
        appId: 'cli_web_unusable',
        appSecret: 'web-secret',
        brand: 'feishu',
        sessionFile: '/tmp/feishu-session.json',
        sessionSource: 'botmux_cache',
        sessionIdentity: { userId: 'u_1', userName: 'Alice', email: 'personal@gmail.com', tenantId: 't_1', tenantName: 'Example' },
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
    });

    const job = manager.start({ sessionMode: 'reuse' });
    await job.done;

    const status = manager.get(job.id);
    expect(status?.status).toBe('needs_owner');
    expect(status?.suggestedOwner).toBe('personal@gmail.com');
    expect(JSON.stringify(status)).not.toContain('web-secret');
    expect(existsSync(join(dir, 'bots.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reuses a UI-confirmed session without a QR and binds creation to that account and tenant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-reuse-'));
    const createApp = vi.fn(async (opts) => {
      expect(opts.forceQrLogin).toBeUndefined();
      expect(opts.disableQrLogin).toBe(true);
      expect(opts.expectedIdentity).toEqual({ userId: 'u_1', tenantId: 't_1' });
      return {
        ok: false as const,
        reason: 'api_error' as const,
        message: 'stop after checking options',
      };
    });
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      createApp,
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
    });

    const job = manager.start({
      appName: '免扫机器人',
      sessionMode: 'reuse',
      expectedIdentity: { userId: 'u_1', tenantId: 't_1' },
    });
    await job.done;

    expect(createApp).toHaveBeenCalledOnce();
    expect(manager.get(job.id)).toMatchObject({ status: 'failed', appName: '免扫机器人' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults the app name to the next botmux process index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-name-'));
    const botsJsonPath = join(dir, 'bots.json');
    writeFileSync(botsJsonPath, JSON.stringify([{ larkAppId: 'cli_0' }, { larkAppId: 'cli_1' }]));
    const manager = new BotOnboardingManager({ botsJsonPath, registerApp: async () => ({ ok: false, error: 'aborted', message: 'stop' }) });
    expect(manager.suggestedAppName()).toBe('botmux-2');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the cached account and tenant for explicit pre-create confirmation', async () => {
    const manager = new BotOnboardingManager({
      botsJsonPath: '/tmp/botmux-session-status-bots.json',
      inspectSession: async () => ({
        ok: true,
        source: 'botmux_cache',
        sessionFile: '/tmp/feishu-session.json',
        identity: {
          userId: 'u_1',
          userName: 'Alice',
          email: 'alice@example.com',
          tenantId: 't_1',
          tenantName: 'Example',
        },
      }),
    });

    await expect(manager.sessionStatus()).resolves.toEqual({
      status: 'ready',
      source: 'botmux_cache',
      identity: {
        userId: 'u_1',
        userName: 'Alice',
        email: 'alice@example.com',
        tenantId: 't_1',
        tenantName: 'Example',
      },
    });
  });

  it('does not invoke the SDK fallback when Web creation already returned an app id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-orphan-'));
    const registerApp = vi.fn(async () => ({ ok: false as const, error: 'unknown' as const, message: 'must not run' }));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      createApp: async () => ({ ok: false, reason: 'api_error', message: 'secret failed', appId: 'cli_kept' }),
      registerApp,
    });
    const job = manager.start();
    await job.done;
    expect(registerApp).not.toHaveBeenCalled();
    expect(manager.get(job.id)).toMatchObject({ status: 'failed', appId: 'cli_kept', error: 'api_error' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not silently fall back to a second QR when Web creation fails before creating an app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-no-fallback-'));
    const registerApp = vi.fn(async () => ({ ok: false as const, error: 'unknown' as const, message: 'must not run' }));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      createApp: async () => ({ ok: false, reason: 'network', message: 'console unavailable' }),
      registerApp,
    });
    const job = manager.start({ appName: 'One Scan' });
    await job.done;
    expect(registerApp).not.toHaveBeenCalled();
    expect(manager.get(job.id)).toMatchObject({
      status: 'failed', error: 'network', appName: 'One Scan', registrationMode: 'web',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the SDK only after compatibility mode is explicitly selected and does not claim a custom app name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-compat-'));
    const createApp = vi.fn();
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      createApp,
      registerApp: async () => ({ ok: false, error: 'aborted', message: 'cancelled' }),
    });
    const job = manager.start({ appName: 'Cannot Apply', registrationMode: 'compat' });
    await job.done;
    expect(createApp).not.toHaveBeenCalled();
    expect(manager.get(job.id)).toMatchObject({ status: 'failed', registrationMode: 'compat' });
    expect(manager.get(job.id)?.appName).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not write a startable empty-allowlist bot when the scanner cannot be verified', async () => {
    // 回归：扫码人身份验证不了时绝不在磁盘留下「空 allowedUsers 的可启动 bot」——
    // 它一旦被 botmux start/restart 读到, 运行时按无白名单全开放, 任何人可 operate。
    // 改走 needs_owner, 且 bots.json 此刻根本没有这个 bot（待手动填 owner 后才落盘）。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({
        ok: true,
        appId: 'cli_new',
        appSecret: 'super-secret-value',
        brand: 'feishu',
        userOpenId: 'ou_owner',
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    const job = manager.start();
    await job.done;

    const status = manager.get(job.id);
    expect(status).toMatchObject({
      status: 'needs_owner',
      appId: 'cli_new',
      // 权限摘要照常附带, 只是没进 completed。
      permission: { ok: true, scopeCount: 9 },
    });
    // needs_owner 尚未落盘, 没有行号, 也绝不泄漏 secret。
    expect(status?.addedBotIndex).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain('super-secret-value');

    // 核心回归：磁盘上没有这个 bot（不存在「空 allowlist 可启动 bot」）。
    expect(existsSync(join(dir, 'bots.json'))).toBe(false);
    expect(userGetMock).toHaveBeenCalledWith({
      path: { user_id: 'ou_owner' },
      params: { user_id_type: 'open_id' },
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('submitOwner writes a usable email owner and only then completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({
        ok: true,
        appId: 'cli_new',
        appSecret: 'super-secret-value',
        brand: 'feishu',
        userOpenId: 'ou_owner',
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });
    const job = manager.start();
    await job.done;
    expect(manager.get(job.id)?.status).toBe('needs_owner');
    // 提交前：磁盘上没有这个 bot。
    expect(existsSync(join(dir, 'bots.json'))).toBe(false);

    // 该邮箱在本企业可解析 → usable → 通过。
    batchGetIdMock.mockResolvedValueOnce({
      code: 0,
      data: { user_list: [{ email: 'owner@corp.com', user_id: 'ou_resolved' }] },
    });
    const r = await manager.submitOwner(job.id, ['owner@corp.com']);
    expect(r.ok).toBe(true);

    expect(manager.get(job.id)?.status).toBe('completed');
    // 提交后才第一次落盘, 且带着非空 allowedUsers + 完整配置。
    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({ larkAppId: 'cli_new', cliId: 'claude-code', allowedUsers: ['owner@corp.com'] });

    rmSync(dir, { recursive: true, force: true });
  });

  it('restores a needs_owner job after a dashboard restart and then completes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-restart-'));
    const botsJsonPath = join(dir, 'bots.json');
    const pendingStorePath = `${botsJsonPath}.onboarding-pending.json`;
    const firstManager = new BotOnboardingManager({
      botsJsonPath,
      registerApp: async () => ({
        ok: true,
        appId: 'cli_restart',
        appSecret: 'restart-secret',
        brand: 'feishu',
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });
    const job = firstManager.start({ cliId: 'codex', workingDir: dir });
    await job.done;

    expect(firstManager.get(job.id)?.status).toBe('needs_owner');
    expect(existsSync(botsJsonPath)).toBe(false);
    expect(statSync(pendingStorePath).mode & 0o777).toBe(0o600);

    // 模拟 Dashboard 进程重启：新 manager 从私有恢复文件拿回同一个 job 与待落盘配置。
    const restartedManager = new BotOnboardingManager({
      botsJsonPath,
      registerApp: async () => ({ ok: false, error: 'unknown', message: 'must not create again' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
    });
    expect(restartedManager.get(job.id)).toMatchObject({
      status: 'needs_owner',
      appId: 'cli_restart',
      cliId: 'codex',
      workingDir: dir,
    });

    batchGetIdMock.mockResolvedValueOnce({
      code: 0,
      data: { user_list: [{ email: 'owner@corp.com', user_id: 'ou_owner' }] },
    });
    expect(await restartedManager.submitOwner(job.id, ['owner@corp.com'])).toEqual({ ok: true });
    expect(restartedManager.get(job.id)?.status).toBe('completed');
    expect(existsSync(pendingStorePath)).toBe(false);
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))[0]).toMatchObject({
      larkAppId: 'cli_restart',
      cliId: 'codex',
      workingDir: dir,
      allowedUsers: ['owner@corp.com'],
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('submitOwner rejects a cross-app open_id and stays in needs_owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({
        ok: true,
        appId: 'cli_new',
        appSecret: 'super-secret-value',
        brand: 'feishu',
        userOpenId: 'ou_owner',
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });
    const job = manager.start();
    await job.done;
    expect(manager.get(job.id)?.status).toBe('needs_owner');

    // 跨 app open_id：本 app 查返 99992361 → unusable → 拒绝。
    const r = await manager.submitOwner(job.id, ['ou_from_other_app']);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unusable_owner');

    // 仍是 needs_owner, 且磁盘上没有落下任何 bot（更没有空 allowlist 的）。
    expect(manager.get(job.id)?.status).toBe('needs_owner');
    expect(existsSync(join(dir, 'bots.json'))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('submitOwner rejects malformed entries (bare email prefix)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({
        ok: true,
        appId: 'cli_new',
        appSecret: 'super-secret-value',
        brand: 'feishu',
        userOpenId: 'ou_owner',
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });
    const job = manager.start();
    await job.done;

    const r = await manager.submitOwner(job.id, ['alice']);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_entries');
    expect(manager.get(job.id)?.status).toBe('needs_owner');

    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the scanner union_id to allowedUsers when the new app can resolve it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    userGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        user: {
          union_id: 'on_scanner',
          name: 'Scanner',
        },
      },
    });
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({
        ok: true,
        appId: 'cli_new',
        appSecret: 'super-secret-value',
        brand: 'feishu',
        userOpenId: 'ou_scanner',
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    const job = manager.start({ cliId: 'traex', workingDir: dir });
    await job.done;

    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({
      larkAppId: 'cli_new',
      cliId: 'traex',
      allowedUsers: ['on_scanner'],
    });
    expect(userGetMock).toHaveBeenCalledWith({
      path: { user_id: 'ou_scanner' },
      params: { user_id_type: 'open_id' },
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the CLI / workingDir / model chosen in the form', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_x', appSecret: 's', brand: 'feishu' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    // 工作目录用 tmp 目录的真实路径——manager 本身不校验存在性 (dashboard 层校验),
    // 但用真实目录更贴近实际写入的样子.
    const job = manager.start({ cliId: 'codex', workingDir: dir, model: 'gpt-5' });
    await job.done;

    const status = manager.get(job.id);
    // 无扫码人身份 → 不能自动定 owner → needs_owner (此刻尚未落盘)。
    expect(status?.status).toBe('needs_owner');
    expect(status).toMatchObject({ cliId: 'codex', workingDir: dir });
    expect(existsSync(join(dir, 'bots.json'))).toBe(false);

    // 手动填一个可解析的 owner 后, 表单选的字段才随 bot 一起落盘。
    batchGetIdMock.mockResolvedValueOnce({
      code: 0,
      data: { user_list: [{ email: 'admin@corp.com', user_id: 'ou_admin' }] },
    });
    const r = await manager.submitOwner(job.id, ['admin@corp.com']);
    expect(r.ok).toBe(true);

    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({
      larkAppId: 'cli_x',
      cliId: 'codex',
      workingDir: dir,
      model: 'gpt-5',
      allowedUsers: ['admin@corp.com'],
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('dirMode=fixed persists defaultWorkingDir (direct start) instead of workingDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_x', appSecret: 's', brand: 'feishu' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    const job = manager.start({ cliId: 'codex', workingDir: dir, dirMode: 'fixed' });
    await job.done;

    batchGetIdMock.mockResolvedValueOnce({
      code: 0,
      data: { user_list: [{ email: 'admin@corp.com', user_id: 'ou_admin' }] },
    });
    const r = await manager.submitOwner(job.id, ['admin@corp.com']);
    expect(r.ok).toBe(true);

    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({ larkAppId: 'cli_x', defaultWorkingDir: dir });
    // 弹卡扫描根不落盘（回退默认 ~），bots.json 只留固定目录一个字段。
    expect(bots[0].workingDir).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the second (open-platform) QR and finishes with a permission summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const gate = deferred<void>();
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_q', appSecret: 's', brand: 'feishu' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async (opts) => {
        // 模拟无缓存会话 → 先抛第二个二维码, 再发轮询进度, 最后被 gate 放行才完成.
        await opts.onQrCode?.({ qrText: 'ascii', qrPayload: '{"qrlogin":{"token":"tok"}}' });
        await opts.onStatus?.('等待飞书扫码');
        await gate.promise;
        return { ...autoOk(), sessionSource: 'qr_login', scopeCount: 7, skippedScopeCount: 2, versionId: '0.0.1' };
      },
      renderQrDataUrl: (payload) => `data:image/svg+xml;base64,${Buffer.from(payload).toString('base64')}`,
    });

    const job = manager.start({ cliId: 'claude-code', workingDir: '~' });
    // onQrCode + onStatus 都跑过后的中间态: 第二个二维码必须还在 (onStatus 不能盖掉它).
    await new Promise(r => setTimeout(r, 0));
    const mid = manager.get(job.id);
    expect(mid?.status).toBe('waiting_for_platform_scan');
    expect(mid?.platformQrDataUrl).toContain('data:image/svg+xml;base64,');
    expect(mid?.permissionStatusMsg).toBe('等待飞书扫码');

    gate.resolve();
    await job.done;

    const status = manager.get(job.id);
    expect(status).toMatchObject({
      status: 'needs_owner',
      permission: { ok: true, scopeCount: 7, skippedScopeCount: 2, versionId: '0.0.1' },
    });
    // 终态清掉第二个二维码, 不残留在页面.
    expect(status?.platformQrDataUrl).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('still adds the bot but falls back to manual steps when auto-permission fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_f', appSecret: 's', brand: 'feishu' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => ({ ok: false, reason: 'missing_csrf', message: 'no csrf' }),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    const job = manager.start();
    await job.done;

    const status = manager.get(job.id);
    // 权限自动配置失败仍给出手动深链步骤; 无扫码人身份故 needs_owner（尚未落盘）。
    expect(status?.status).toBe('needs_owner');
    expect(status?.permission).toMatchObject({ ok: false, reason: 'missing_csrf' });
    expect(Array.isArray(status?.remainingSteps)).toBe(true);
    expect(status!.remainingSteps!.length).toBeGreaterThan(0);
    expect(status!.remainingSteps!.every(s => typeof s.url === 'string' && s.url.includes('cli_f'))).toBe(true);
    expect(existsSync(join(dir, 'bots.json'))).toBe(false);

    // 手动填 owner 后才落盘——权限手动步骤不影响 bot 最终被加入（带 owner）。
    batchGetIdMock.mockResolvedValueOnce({
      code: 0,
      data: { user_list: [{ email: 'admin@corp.com', user_id: 'ou_admin' }] },
    });
    expect((await manager.submitOwner(job.id, ['admin@corp.com'])).ok).toBe(true);
    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({ larkAppId: 'cli_f', cliId: 'claude-code', allowedUsers: ['admin@corp.com'] });

    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-owner completion calls startBotLive and records liveStarted on the snapshot', async () => {
    // 免重启：落盘后自动拉起新 bot 的 daemon，把结果记进快照供前端展示。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    userGetMock.mockResolvedValueOnce({
      code: 0,
      data: { user: { union_id: 'on_scanner', name: 'Scanner' } },
    });
    const startBotLive = vi.fn(async () => ({ ok: true, message: 'botmux-1 已上线' }));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_live', appSecret: 's', brand: 'feishu', userOpenId: 'ou_scanner' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
      startBotLive,
    });

    const job = manager.start();
    await job.done;

    const status = manager.get(job.id);
    expect(status?.status).toBe('completed');
    // 落盘后才拉起（此刻 bots.json 已有该 bot）。
    expect(startBotLive).toHaveBeenCalledWith('cli_live');
    expect(status?.liveStarted).toBe(true);
    expect(status?.liveStartMessage).toBe('botmux-1 已上线');

    rmSync(dir, { recursive: true, force: true });
  });

  it('submitOwner calls startBotLive; a throwing hook still completes with liveStarted=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const startBotLive = vi.fn(async () => { throw new Error('pm2 down'); });
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_live2', appSecret: 's', brand: 'feishu', userOpenId: 'ou_owner' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
      startBotLive,
    });
    const job = manager.start();
    await job.done;
    expect(manager.get(job.id)?.status).toBe('needs_owner');

    batchGetIdMock.mockResolvedValueOnce({
      code: 0,
      data: { user_list: [{ email: 'owner@corp.com', user_id: 'ou_resolved' }] },
    });
    const r = await manager.submitOwner(job.id, ['owner@corp.com']);
    expect(r.ok).toBe(true);

    const status = manager.get(job.id);
    // 拉起失败绝不阻断完成——只是回退到「请重启」提示。
    expect(status?.status).toBe('completed');
    expect(startBotLive).toHaveBeenCalledWith('cli_live2');
    expect(status?.liveStarted).toBe(false);
    expect(status?.liveStartMessage).toBe('pm2 down');

    rmSync(dir, { recursive: true, force: true });
  });
});
