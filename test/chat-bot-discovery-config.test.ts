import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalConfigPath } from '../src/global-config.js';
import { resolveChatBotDiscoveryConfig } from '../src/config.js';

/**
 * `resolveChatBotDiscoveryConfig` precedence:
 *   explicit BOTMUX_LARK_LIST_BOTS_API_ENABLED env  >  dashboard.chatBotDiscovery
 *   (persisted in ~/.botmux/config.json)            >  default ON.
 * The env override is how the worker keeps child panes in sync with the daemon
 * and doubles as an escape hatch.
 */
describe('resolveChatBotDiscoveryConfig', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-chatbot-discovery-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('defaults ON when neither env nor config sets it', () => {
    expect(resolveChatBotDiscoveryConfig({}).listBotsApiEnabled).toBe(true);
  });

  it('is OFF when the dashboard toggle persists chatBotDiscovery=false', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { chatBotDiscovery: false } }));
    expect(resolveChatBotDiscoveryConfig({}).listBotsApiEnabled).toBe(false);
  });

  it('env=false overrides a default/enabled config', () => {
    expect(resolveChatBotDiscoveryConfig({ BOTMUX_LARK_LIST_BOTS_API_ENABLED: 'false' }).listBotsApiEnabled).toBe(false);
  });

  it('env=true overrides a persisted chatBotDiscovery=false', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { chatBotDiscovery: false } }));
    expect(resolveChatBotDiscoveryConfig({ BOTMUX_LARK_LIST_BOTS_API_ENABLED: 'true' }).listBotsApiEnabled).toBe(true);
  });

  it('an empty env value is ignored (falls through to the config default)', () => {
    expect(resolveChatBotDiscoveryConfig({ BOTMUX_LARK_LIST_BOTS_API_ENABLED: '' }).listBotsApiEnabled).toBe(true);
  });

  it('timeout falls back to 3000ms and honors a valid override', () => {
    expect(resolveChatBotDiscoveryConfig({}).listBotsApiTimeoutMs).toBe(3000);
    expect(resolveChatBotDiscoveryConfig({ BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS: '5000' }).listBotsApiTimeoutMs).toBe(5000);
  });
});
