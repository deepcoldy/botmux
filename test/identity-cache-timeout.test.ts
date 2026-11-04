import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({ getBotClient: () => ({}) }));
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '' } } }));
vi.mock('../src/im/lark/client.js', () => ({
  larkGet: vi.fn(),
  getMessageDetail: vi.fn(),
  getLarkErrorCode: vi.fn(),
}));

import { config } from '../src/config.js';
import { getMessageDetail, larkGet } from '../src/im/lark/client.js';
import {
  flushIdentityCacheSync,
  resolveSender,
  resolveVerifiedUserIdentityByUnionId,
} from '../src/im/lark/identity-cache.js';

/** Signal readiness only after the response timer is installed, on both runners. */
function mockMessageLookup(delayMs?: number): Promise<void> {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(getMessageDetail).mockImplementationOnce(() => new Promise(resolve => {
    if (delayMs !== undefined) {
      setTimeout(() => resolve({ items: [{ sender: { sender_name: 'Lookup Sender' } }] }), delayMs);
    }
    started();
  }));
  return ready;
}

describe('sender identity lookup timeout', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-identity-timeout-'));
    config.session.dataDir = dataDir;
    vi.useFakeTimers();
    vi.stubEnv('BOTMUX_SENDER_RESOLVE_TIMEOUT_MS', undefined);
    vi.mocked(larkGet).mockReset();
    vi.mocked(larkGet).mockResolvedValue({ code: 41050 });
    vi.mocked(getMessageDetail).mockReset();
  });

  afterEach(() => {
    flushIdentityCacheSync();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts a slow message lookup within the configured budget and caches its name', async () => {
    vi.stubEnv('BOTMUX_SENDER_RESOLVE_TIMEOUT_MS', '3000');
    const ready = mockMessageLookup(1100);

    const pending = resolveSender('cli_extended_budget', 'ou_slow_sender', 'user', { messageId: 'om_slow' });
    await ready;
    await vi.advanceTimersByTimeAsync(1100);
    await expect(pending).resolves.toMatchObject({ name: 'Lookup Sender' });

    await expect(resolveSender('cli_extended_budget', 'ou_slow_sender', 'user', { messageId: 'om_next' }))
      .resolves.toMatchObject({ name: 'Lookup Sender' });
    expect(getMessageDetail).toHaveBeenCalledOnce();
  });

  it('also gives contact profile lookups the configured budget', async () => {
    vi.stubEnv('BOTMUX_SENDER_RESOLVE_TIMEOUT_MS', '3000');
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(larkGet).mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve({ code: 0, data: { user: { name: 'Contact Sender' } } }), 1100);
      started();
    }));

    const pending = resolveSender('cli_contact_budget', 'ou_contact_sender', 'user', { messageId: 'om_contact' });
    await ready;
    await vi.advanceTimersByTimeAsync(1100);

    await expect(pending).resolves.toMatchObject({ name: 'Contact Sender' });
    expect(getMessageDetail).not.toHaveBeenCalled();
  });

  it('gives the message fallback its own budget after a contact timeout', async () => {
    vi.stubEnv('BOTMUX_SENDER_RESOLVE_TIMEOUT_MS', '3000');
    vi.mocked(larkGet).mockImplementationOnce(() => new Promise(() => {}));
    const ready = mockMessageLookup(1100);

    const pending = resolveSender('cli_independent_budgets', 'ou_fallback_sender', 'user', { messageId: 'om_fallback' });
    await vi.advanceTimersByTimeAsync(3000);
    await ready;
    expect(getMessageDetail).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1100);

    await expect(pending).resolves.toMatchObject({ name: 'Lookup Sender' });
  });

  it('bounds a hung message lookup by the configured budget', async () => {
    vi.stubEnv('BOTMUX_SENDER_RESOLVE_TIMEOUT_MS', '50');
    const ready = mockMessageLookup();

    let settled = false;
    const pending = resolveSender('cli_short_budget', 'ou_hung_sender', 'app', { messageId: 'om_hung' })
      .then(sender => { settled = true; return sender; });
    await ready;
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ name: undefined });
  });

  it.each([undefined, '', '0', '-1', '1.5', 'invalid', '2147483648'])(
    'keeps the default cutoff when the override is %s', async raw => {
      vi.stubEnv('BOTMUX_SENDER_RESOLVE_TIMEOUT_MS', raw);
      const ready = mockMessageLookup();

      let settled = false;
      const pending = resolveSender(`cli_default_${raw}`, 'ou_hung_default', 'app', { messageId: 'om_default' })
        .then(sender => { settled = true; return sender; });
      await ready;
      await vi.advanceTimersByTimeAsync(799);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toMatchObject({ name: undefined });
    },
  );

  it('does not change the strict owner-verification budget', async () => {
    vi.stubEnv('BOTMUX_SENDER_RESOLVE_TIMEOUT_MS', '50');
    vi.mocked(larkGet).mockImplementationOnce(() => new Promise(() => {}));

    let settled = false;
    const pending = resolveVerifiedUserIdentityByUnionId('cli_strict_budget', 'on_owner')
      .then(identity => { settled = true; return identity; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeUndefined();
  });
});
