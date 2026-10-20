import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEventSubscriptionEnsureResult } from '../src/setup/open-platform-automation.js';

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  ensureEvents: vi.fn<(...args: unknown[]) => Promise<AppEventSubscriptionEnsureResult>>(),
  fullSetup: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

// Keep the dispatcher and its imports real, replacing only the startup boundary.
// unit-setup.ts fences any import-time filesystem reads into a temporary home;
// the event helper is mocked, so no real Web session or API is accessed.
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/bot-registry.js')>()),
  getBot: mocks.getBot,
}));
vi.mock('../src/setup/open-platform-automation.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/setup/open-platform-automation.js')>()),
  ensureAppEventSubscriptions: mocks.ensureEvents,
  automateOpenPlatformSetup: mocks.fullSetup,
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: mocks.info, debug: mocks.debug, warn: vi.fn(), error: vi.fn() },
}));

import { ensureMessageUpdatedEventSubscribed } from '../src/im/lark/event-dispatcher.js';
import { MESSAGE_UPDATED_EVENT } from '../src/setup/open-platform-automation.js';

describe('message edit subscription startup repair', () => {
  const appId = 'cli_edit_subscription';
  const infoMessages = () => mocks.info.mock.calls.map(([message]) => String(message)).join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBot.mockReturnValue({ config: { larkAppId: appId, brand: 'feishu' } });
    mocks.ensureEvents.mockResolvedValue({ ok: true, missingEvents: [], eventModeReady: true, updateSubmitted: false });
    mocks.fullSetup.mockRejectedValue(new Error('full setup must never run for edit-event repair'));
  });

  afterEach(() => {
    expect(mocks.fullSetup).not.toHaveBeenCalled();
    expect(infoMessages()).not.toMatch(/订阅已确认|订阅已就绪|草稿已写入/);
  });

  it('checks only the edit event and keeps existing configuration distinct from published delivery', async () => {
    await ensureMessageUpdatedEventSubscribed(appId);
    expect(mocks.ensureEvents).toHaveBeenCalledExactlyOnceWith(appId, [MESSAGE_UPDATED_EVENT]);
    expect(infoMessages()).toContain('已有配置包含事件且为长连接，本次未更新');
    expect(infoMessages()).toContain('发布生效及实际推送未验证');
  });

  it('reports a successful update and complete readback without claiming the application was published', async () => {
    mocks.ensureEvents.mockResolvedValue({ ok: true, missingEvents: [], eventModeReady: true, updateSubmitted: true });
    await ensureMessageUpdatedEventSubscribed(appId);
    expect(infoMessages()).toContain('更新请求已成功返回，配置回读包含事件且为长连接');
    expect(infoMessages()).toContain('启动流程不会自动发布');
    expect(infoMessages()).toContain('请在开放平台检查并发布应用版本');
    expect(infoMessages()).toContain('发布生效及实际推送未验证');
  });

  it.each([
    { missingEvents: [MESSAGE_UPDATED_EVENT], eventModeReady: true, updateSubmitted: true },
    { missingEvents: [], eventModeReady: false, updateSubmitted: true },
    { missingEvents: [MESSAGE_UPDATED_EVENT], eventModeReady: false, updateSubmitted: false },
    { missingEvents: [], eventModeReady: false, updateSubmitted: false },
  ])('prioritizes incomplete readback over a successful update request: %j', async (state) => {
    mocks.ensureEvents.mockResolvedValue({ ok: true, ...state });
    await expect(ensureMessageUpdatedEventSubscribed(appId)).resolves.toBeUndefined();
    expect(mocks.ensureEvents).toHaveBeenCalledOnce();
    expect(infoMessages()).toContain('配置回读不完整');
    expect(infoMessages()).toContain(`longConnection=${state.eventModeReady}, missing=${state.missingEvents.join(',')}`);
    expect(infoMessages()).toContain(state.updateSubmitted ? '更新请求已成功返回' : '无成功返回的更新请求');
    expect(infoMessages()).toContain('发布生效及实际推送未验证');
    expect(infoMessages()).not.toContain('配置回读包含事件且为长连接');
    expect(infoMessages()).not.toContain('已有配置包含事件且为长连接');
  });

  it.each([
    { reason: 'invalid_session', updateSubmitted: false },
    { reason: 'api_error', updateSubmitted: false },
    { reason: 'api_error', updateSubmitted: true },
  ])('keeps failed checks distinct from successful update submissions: %j', async ({ reason, updateSubmitted }) => {
    mocks.ensureEvents.mockResolvedValue({ ok: false, reason, message: 'fixture failure', updateSubmitted });
    await expect(ensureMessageUpdatedEventSubscribed(appId)).resolves.toBeUndefined();
    expect(infoMessages()).toContain(`配置检查未完成（${reason}`);
    expect(infoMessages()).toContain(updateSubmitted ? '更新请求已成功返回' : '无成功返回的更新请求');
    expect(infoMessages()).toContain('发布生效及实际推送未验证');
    expect(infoMessages()).not.toContain('配置回读包含事件且为长连接');
  });

  it('contains an unexpected helper exception so ordinary message startup can continue', async () => {
    mocks.ensureEvents.mockRejectedValue(new Error('fixture exception'));
    await expect(ensureMessageUpdatedEventSubscribed(appId)).resolves.toBeUndefined();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.debug.mock.calls.some(([message]) => String(message).includes('fixture exception'))).toBe(true);
  });

  it('skips repair for a Lark application', async () => {
    mocks.getBot.mockReturnValue({ config: { larkAppId: appId, brand: 'lark' } });
    await ensureMessageUpdatedEventSubscribed(appId);
    expect(mocks.ensureEvents).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
