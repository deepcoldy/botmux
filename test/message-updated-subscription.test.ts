import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEventSubscriptionProbeResult } from '../src/setup/open-platform-automation.js';

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  ensureEvents: vi.fn<(...args: unknown[]) => Promise<AppEventSubscriptionProbeResult>>(),
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
  const confirmationLogged = () => mocks.info.mock.calls.some(([message]) => String(message).includes('订阅已确认'));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBot.mockReturnValue({ config: { larkAppId: appId, brand: 'feishu' } });
    mocks.ensureEvents.mockResolvedValue({ ok: true, missingEvents: [], eventModeReady: true });
    mocks.fullSetup.mockRejectedValue(new Error('full setup must never run for edit-event repair'));
  });

  afterEach(() => {
    expect(mocks.fullSetup).not.toHaveBeenCalled();
  });

  it('repairs only the edit event through the narrow helper and confirms verified readiness', async () => {
    await ensureMessageUpdatedEventSubscribed(appId);
    expect(mocks.ensureEvents).toHaveBeenCalledExactlyOnceWith(appId, [MESSAGE_UPDATED_EVENT]);
    expect(confirmationLogged()).toBe(true);
  });

  it.each([
    { missingEvents: [MESSAGE_UPDATED_EVENT], eventModeReady: true },
    { missingEvents: [], eventModeReady: false },
  ])('does not confirm readiness when the readback is incomplete: %j', async (state) => {
    mocks.ensureEvents.mockResolvedValue({ ok: true, ...state });
    await expect(ensureMessageUpdatedEventSubscribed(appId)).resolves.toBeUndefined();
    expect(mocks.ensureEvents).toHaveBeenCalledOnce();
    expect(confirmationLogged()).toBe(false);
    expect(mocks.info).toHaveBeenCalled();
  });

  it.each(['invalid_session', 'api_error'])('degrades without claiming readiness when the helper returns %s', async (reason) => {
    mocks.ensureEvents.mockResolvedValue({ ok: false, reason, message: 'fixture failure' });
    await expect(ensureMessageUpdatedEventSubscribed(appId)).resolves.toBeUndefined();
    expect(confirmationLogged()).toBe(false);
    expect(mocks.info.mock.calls.some(([message]) => String(message).includes(reason))).toBe(true);
  });

  it('contains an unexpected helper exception so ordinary message startup can continue', async () => {
    mocks.ensureEvents.mockRejectedValue(new Error('fixture exception'));
    await expect(ensureMessageUpdatedEventSubscribed(appId)).resolves.toBeUndefined();
    expect(confirmationLogged()).toBe(false);
    expect(mocks.debug.mock.calls.some(([message]) => String(message).includes('fixture exception'))).toBe(true);
  });

  it('skips repair for a Lark application', async () => {
    mocks.getBot.mockReturnValue({ config: { larkAppId: appId, brand: 'lark' } });
    await ensureMessageUpdatedEventSubscribed(appId);
    expect(mocks.ensureEvents).not.toHaveBeenCalled();
    expect(confirmationLogged()).toBe(false);
  });
});
