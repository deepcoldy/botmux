import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
