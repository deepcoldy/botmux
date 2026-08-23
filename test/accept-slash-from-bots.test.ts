/**
 * Unit tests for the `acceptSlashFromBots` per-bot switch (default ON):
 *   - parse round-trip through parseBotConfigsFromText (only explicit false persists)
 *   - botAcceptsSlashFromBots accessor (default on; explicit false off; unknown bot on)
 *
 * The switch gates whether a bot-sent native slash command (botmux send --slash)
 * is routed as a command; human senders are never gated by it. See daemon.ts's
 * two invocation-parse sites.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return { ...orig, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => ''), statSync: vi.fn(() => ({ mtimeMs: 0 })) };
});

async function freshImport() {
  vi.resetModules();
  return await import('../src/bot-registry.js');
}

function baseEntry(overrides: Record<string, unknown> = {}) {
  return { larkAppId: 'app_slash_001', larkAppSecret: 'secret', cliId: 'claude-code', ...overrides };
}

describe('acceptSlashFromBots parse', () => {
  it('defaults to undefined (= ON) when unset', async () => {
    const mod = await freshImport();
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([baseEntry()]));
    expect(cfg.acceptSlashFromBots).toBeUndefined();
  });

  it('persists only explicit false (bots.json stays clean)', async () => {
    const mod = await freshImport();
    const [off] = mod.parseBotConfigsFromText(JSON.stringify([baseEntry({ acceptSlashFromBots: false })]));
    expect(off.acceptSlashFromBots).toBe(false);
    // explicit true is the default → normalized away (undefined), like autoGrantRequestCards
    const [on] = mod.parseBotConfigsFromText(JSON.stringify([baseEntry({ acceptSlashFromBots: true })]));
    expect(on.acceptSlashFromBots).toBeUndefined();
  });
});

describe('botAcceptsSlashFromBots accessor', () => {
  it('returns true by default (unset)', async () => {
    const mod = await freshImport();
    mod.registerBot(baseEntry() as any);
    expect(mod.botAcceptsSlashFromBots('app_slash_001')).toBe(true);
  });

  it('returns false only when explicitly disabled', async () => {
    const mod = await freshImport();
    mod.registerBot(baseEntry({ acceptSlashFromBots: false }) as any);
    expect(mod.botAcceptsSlashFromBots('app_slash_001')).toBe(false);
  });

  it('returns true for an unknown bot (default-on, never fail-closed to all-reject)', async () => {
    const mod = await freshImport();
    expect(mod.botAcceptsSlashFromBots('app_never_registered')).toBe(true);
  });
});
