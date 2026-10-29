/**
 * #2007: 在 bots.json 的 env 里写保留变量（CLAUDE_CONFIG_DIR / CODEX_HOME 等）
 * 以前会被 sanitizePerBotEnv 静默剥离，没有任何提示。加载配置时应显式告警，
 * 对 CLI 配置目录类键还要指出正确的顶层 cliConfigDir 字段。
 *
 * Run: npx vitest run test/per-bot-env-reserved-warn.test.ts
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

describe('reserved per-bot env warning on config load (#2007)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The warning is latched per process (core/dropped-env-warn-latch.ts);
    // start every case from a clean latch so file order cannot hide a warning.
    resetDroppedReservedEnvWarnLatch();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    resetDroppedReservedEnvWarnLatch();
  });

  const reservedWarnings = () =>
    warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes(MARKER))
      .join('\n');

  it('warns naming the dropped CLI-home keys, points at cliConfigDir, and still strips them', () => {
    const [bot] = parseBotConfigsFromText(
      JSON.stringify([
        {
          larkAppId: 'envwarn1',
          larkAppSecret: 's',
          env: {
            CLAUDE_CONFIG_DIR: '/x/claude',
            CODEX_HOME: '/x/codex',
            HTTPS_PROXY: 'http://127.0.0.1:7890',
          },
        },
      ]),
    );

    expect(bot.env).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    const msg = reservedWarnings();
    expect(msg).toContain('envwarn1');
    expect(msg).toContain('CLAUDE_CONFIG_DIR');
    expect(msg).toContain('CODEX_HOME');
    expect(msg).toContain('cliConfigDir');
  });

  it('stays silent when env only contains ordinary keys', () => {
    parseBotConfigsFromText(
      JSON.stringify([
        { larkAppId: 'envok', larkAppSecret: 's', env: { HTTPS_PROXY: 'http://p' } },
      ]),
    );
    expect(reservedWarnings()).toBe('');
  });

  it('does not point a codex bot at cliConfigDir (it only applies to claude-code)', () => {
    parseBotConfigsFromText(
      JSON.stringify([{ larkAppId: 'envcx', larkAppSecret: 's', cliId: 'codex', env: { CODEX_HOME: '/c' } }]),
    );
    const msg = reservedWarnings();
    expect(msg).toContain('CODEX_HOME');
    expect(msg).not.toContain('cliConfigDir');
  });

  it('warns for other reserved keys but without the cliConfigDir hint', () => {
    parseBotConfigsFromText(
      JSON.stringify([{ larkAppId: 'envr', larkAppSecret: 's', env: { GROK_HOME: '/g' } }]),
    );
    const msg = reservedWarnings();
    expect(msg).toContain('GROK_HOME');
    expect(msg).not.toContain('cliConfigDir');
  });
});
