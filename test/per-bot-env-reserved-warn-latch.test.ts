/**
 * #2007 follow-up: the "reserved key in bots.json env" warning must fire once
 * per (bot, dropped-key set) per PROCESS, not once per config parse — several
 * per-turn code paths call the uncached `loadBotConfigs()`.
 *
 * Run: npx vitest run test/per-bot-env-reserved-warn-latch.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(public opts: Record<string, unknown>) {}
  }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { resetDroppedReservedEnvWarnLatch } from '../src/core/dropped-env-warn-latch.js';
import { logger } from '../src/utils/logger.js';

const MARKER = 'env 中的保留变量';
const entry = (appId: string, env: Record<string, unknown>) =>
  JSON.stringify([{ larkAppId: appId, larkAppSecret: 's', env }]);

describe('reserved per-bot env warning is latched per process (#2007)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetDroppedReservedEnvWarnLatch();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    resetDroppedReservedEnvWarnLatch();
  });

  const reservedWarnings = () =>
    warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(MARKER)).join('\n');
  const warningCount = () => reservedWarnings().split('\n').filter(Boolean).length;

  it('repeated parses of the same bad config warn exactly once', () => {
    for (let turn = 0; turn < 5; turn++) {
      const [bot] = parseBotConfigsFromText(entry('envlatch1', { CODEX_HOME: '/x' }));
      // The strip itself is NOT latched: every parse still cleans the env.
      expect(bot.env).toBeUndefined();
    }
    expect(warningCount()).toBe(1);
  });

  it('warns again when the dropped-key SET changes (config edit, no restart)', () => {
    parseBotConfigsFromText(entry('envlatch2', { CODEX_HOME: '/x' }));
    expect(warningCount()).toBe(1);
    // Same bot, key set changed: operators must see the new mistake too.
    parseBotConfigsFromText(entry('envlatch2', { GROK_HOME: '/g' }));
    expect(warningCount()).toBe(2);
    expect(reservedWarnings()).toContain('CODEX_HOME');
    expect(reservedWarnings()).toContain('GROK_HOME');
    // …and each of those sets is now latched in its own right.
    parseBotConfigsFromText(entry('envlatch2', { GROK_HOME: '/g' }));
    parseBotConfigsFromText(entry('envlatch2', { CODEX_HOME: '/x' }));
    expect(warningCount()).toBe(2);
  });

  it('keeps different bots independent', () => {
    parseBotConfigsFromText(entry('envlatch3a', { CODEX_HOME: '/x' }));
    parseBotConfigsFromText(entry('envlatch3b', { CODEX_HOME: '/x' }));
    expect(warningCount()).toBe(2);
  });

  it('does not suppress a different key set of the same bot seen later', () => {
    parseBotConfigsFromText(entry('envlatch4', { CODEX_HOME: '/a' }));
    parseBotConfigsFromText(entry('envlatch4', { CODEX_HOME: '/a', BOTMUX_SESSION_ID: 'hijack' }));
    expect(warningCount()).toBe(2);
    expect(reservedWarnings()).toContain('BOTMUX_SESSION_ID');
  });

  // Pins the DOCUMENTED, deliberately-accepted limitation (see the module
  // header): the latch has no reload hook, so re-introducing the identical
  // mistake after fixing it stays silent until the process restarts. If someone
  // later keys the latch on a config generation, this case turns red on purpose
  // — that would be a behaviour change, not a bug fix, and the header must be
  // updated with it.
  it('stays silent when an identical mistake is re-introduced after a fix (no reload hook)', () => {
    parseBotConfigsFromText(entry('envlatch5', { CODEX_HOME: '/x' }));
    expect(warningCount()).toBe(1);
    // Operator fixes it: clean env, nothing new to report.
    parseBotConfigsFromText(entry('envlatch5', { HTTPS_PROXY: 'http://127.0.0.1:7890' }));
    expect(warningCount()).toBe(1);
    // Same mistake comes back within the same process: latched, still silent.
    const [bot] = parseBotConfigsFromText(entry('envlatch5', { CODEX_HOME: '/x' }));
    expect(bot.env).toBeUndefined();
    expect(warningCount()).toBe(1);
  });

  // Deliberately the SAME appId as the case below: this is what makes the
  // test-only reset load-bearing. Without it, the latch entry from this `it`
  // would carry into the next one and silence a warning that must be emitted.
  it('re-warns in a later independent observation of the same config', () => {
    parseBotConfigsFromText(entry('envlatch-shared', { CODEX_HOME: '/x' }));
    expect(warningCount()).toBe(1);
  });

  it('emits again after the per-process latch is reset', () => {
    parseBotConfigsFromText(entry('envlatch-shared', { CODEX_HOME: '/x' }));
    expect(warningCount()).toBe(1);
  });
});
