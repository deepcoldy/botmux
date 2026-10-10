/**
 * im.message.recalled_v1 订阅：新应用随 BOT_OPTIONAL_APP_EVENTS 一起订阅；存量应用由
 * ensureMessageRecalledEventSubscribed 在启动时经缓存开放平台登录态增量补齐，并把
 * 「撤回有没有覆盖」作为状态返回——群聊上下文共享据此标记记录是否完整，不能装作撤回已同步。
 *
 * Run: bun run vitest run test/message-recalled-subscription.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEventSubscriptionEnsureResult } from '../src/setup/open-platform-automation.js';

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  ensureEvents: vi.fn<(...args: unknown[]) => Promise<AppEventSubscriptionEnsureResult>>(),
  fullSetup: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

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

import { ensureMessageRecalledEventSubscribed } from '../src/im/lark/event-dispatcher.js';
import {
  BOT_OPTIONAL_APP_EVENTS,
  BOT_BASELINE_APP_EVENTS,
  BOT_CRITICAL_APP_EVENTS,
  MESSAGE_RECALLED_EVENT,
  MESSAGE_UPDATED_EVENT,
} from '../src/setup/open-platform-automation.js';

describe('im.message.recalled_v1 在应用事件清单中的位置', () => {
  it('新应用随 OPTIONAL 清单订阅；不进 BASELINE / CRITICAL（缺订阅只影响撤回 tombstone，不 fail-closed）', () => {
    expect(MESSAGE_RECALLED_EVENT).toBe('im.message.recalled_v1');
    expect(BOT_OPTIONAL_APP_EVENTS).toContain(MESSAGE_RECALLED_EVENT);
    expect(BOT_OPTIONAL_APP_EVENTS).toContain(MESSAGE_UPDATED_EVENT);
    expect(BOT_BASELINE_APP_EVENTS as readonly string[]).not.toContain(MESSAGE_RECALLED_EVENT);
    expect(BOT_CRITICAL_APP_EVENTS as readonly string[]).not.toContain(MESSAGE_RECALLED_EVENT);
  });
});

describe('ensureMessageRecalledEventSubscribed — 存量应用启动补齐', () => {
  const appId = 'cli_recall_subscription';
  const infoMessages = () => mocks.info.mock.calls.map(([message]) => String(message)).join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBot.mockReturnValue({ config: { larkAppId: appId, brand: 'feishu' } });
    mocks.ensureEvents.mockResolvedValue({ ok: true, missingEvents: [], eventModeReady: true, updateSubmitted: false });
    mocks.fullSetup.mockRejectedValue(new Error('full setup must never run for recall-event repair'));
  });

  afterEach(() => {
    expect(mocks.fullSetup).not.toHaveBeenCalled();
    expect(infoMessages()).not.toMatch(/订阅已确认|订阅已就绪|草稿已写入/);
  });

  it('只检查撤回事件；已有配置 → covered=true / subscribed，不宣称已发布', async () => {
    const status = await ensureMessageRecalledEventSubscribed(appId);
    expect(mocks.ensureEvents).toHaveBeenCalledExactlyOnceWith(appId, [MESSAGE_RECALLED_EVENT]);
    expect(status).toEqual({ covered: true, reason: 'subscribed', updateSubmitted: false, missingEvents: [] });
    expect(infoMessages()).toContain('已有配置包含事件且为长连接，本次未更新');
    expect(infoMessages()).toContain('发布生效及实际推送未验证');
  });

  it('本次补订阅成功且回读完整 → covered=true / update_submitted，提醒需发布版本', async () => {
    mocks.ensureEvents.mockResolvedValue({ ok: true, missingEvents: [], eventModeReady: true, updateSubmitted: true });
    const status = await ensureMessageRecalledEventSubscribed(appId);
    expect(status).toEqual({ covered: true, reason: 'update_submitted', updateSubmitted: true, missingEvents: [] });
    expect(infoMessages()).toContain('启动流程不会自动发布');
    expect(infoMessages()).toContain('请在开放平台检查并发布应用版本');
  });

  it.each([
    { missingEvents: [MESSAGE_RECALLED_EVENT], eventModeReady: true, updateSubmitted: true },
    { missingEvents: [], eventModeReady: false, updateSubmitted: true },
    { missingEvents: [MESSAGE_RECALLED_EVENT], eventModeReady: false, updateSubmitted: false },
    { missingEvents: [], eventModeReady: false, updateSubmitted: false },
  ])('回读不完整 → covered=false / readback_incomplete，哪怕更新请求成功: %j', async (state) => {
    mocks.ensureEvents.mockResolvedValue({ ok: true, ...state });
    const status = await ensureMessageRecalledEventSubscribed(appId);
    expect(status.covered).toBe(false);
    expect(status.reason).toBe('readback_incomplete');
    expect(status.updateSubmitted).toBe(state.updateSubmitted);
    expect(status.missingEvents).toEqual(state.missingEvents);
    expect(infoMessages()).toContain('配置回读不完整');
    expect(infoMessages()).toContain('收不到撤回事件');
  });

  it('开放平台登录态 / API 不可用 → covered=false / session_unavailable，带原因', async () => {
    mocks.ensureEvents.mockResolvedValue({ ok: false, reason: 'session_expired', message: 'x', sessionFile: '/tmp/s', updateSubmitted: false });
    const status = await ensureMessageRecalledEventSubscribed(appId);
    expect(status).toMatchObject({ covered: false, reason: 'session_unavailable', updateSubmitted: false, missingEvents: [MESSAGE_RECALLED_EVENT], detail: 'session_expired' });
    expect(infoMessages()).toContain('配置检查未完成');
    expect(infoMessages()).toContain('被撤回的消息会留在记录里');
  });

  it('helper 抛错 → covered=false / error，不向上抛', async () => {
    mocks.ensureEvents.mockRejectedValue(new Error('network down'));
    const status = await ensureMessageRecalledEventSubscribed(appId);
    expect(status).toMatchObject({ covered: false, reason: 'error', detail: 'network down' });
    expect(mocks.debug).toHaveBeenCalled();
  });

  it('非 feishu 品牌 → skipped_brand，不碰开放平台', async () => {
    mocks.getBot.mockReturnValue({ config: { larkAppId: appId, brand: 'lark' } });
    const status = await ensureMessageRecalledEventSubscribed(appId);
    expect(status).toEqual({ covered: false, reason: 'skipped_brand', updateSubmitted: false, missingEvents: [MESSAGE_RECALLED_EVENT] });
    expect(mocks.ensureEvents).not.toHaveBeenCalled();
  });
});
