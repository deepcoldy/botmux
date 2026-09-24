import { describe, expect, it, vi } from 'vitest';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { logger } from '../src/utils/logger.js';
import {
  DEFAULT_QUOTA_FALLBACK_MESSAGE,
  MAX_QUOTA_FALLBACK_MESSAGE_LENGTH,
  QUOTA_FALLBACK_DEDUPE_WINDOW_MS,
  __testOnly_resetQuotaFallbackEvents,
  assertQuotaFallbackGraphAcyclic,
  claimQuotaFallbackEvent,
  findQuotaFallbackCycle,
  findQuotaFallbackCycles,
  normalizeQuotaFallbackBotConfig,
  resolveQuotaFallbackTarget,
  type QuotaFallbackTargetDeps,
} from '../src/services/quota-fallback.js';

describe('quota fallback config normalization', () => {
  it('is default-off and gives an enabled block safe defaults', () => {
    expect(normalizeQuotaFallbackBotConfig(undefined, 'cli_source')).toEqual({});
    expect(normalizeQuotaFallbackBotConfig({ enabled: false }, 'cli_source')).toEqual({});
    expect(normalizeQuotaFallbackBotConfig({
      enabled: true,
      targetAppId: ' cli_target ',
    }, 'cli_source')).toEqual({
      config: {
        enabled: true,
        targetAppId: 'cli_target',
        kinds: ['usage', 'rate'],
        message: DEFAULT_QUOTA_FALLBACK_MESSAGE,
      },
    });
  });

  it('keeps independent kind selection and deduplicates it', () => {
    expect(normalizeQuotaFallbackBotConfig({
      enabled: true,
      targetAppId: 'cli_target',
      kinds: ['rate', 'rate'],
      message: '  fixed handoff  ',
    }, 'cli_source')).toEqual({
      config: {
        enabled: true,
        targetAppId: 'cli_target',
        kinds: ['rate'],
        message: 'fixed handoff',
      },
    });
  });

  it.each([
    [{ enabled: true, targetAppId: 'ou_wrong_scope' }, /targetAppId/],
    [{ enabled: true, targetAppId: 'cli_source' }, /current bot/],
    [{ enabled: true, targetAppId: 'cli_target', kinds: [] }, /at least one/],
    [{ enabled: true, targetAppId: 'cli_target', kinds: ['daily'] }, /usage and rate/],
    [{ enabled: true, targetAppId: 'cli_target', message: '   ' }, /non-blank/],
    [{ enabled: true, targetAppId: 'cli_target', message: '<at id=ou_x></at> hi' }, /native <at>/],
    [{ enabled: true, targetAppId: 'cli_target', message: 'x'.repeat(MAX_QUOTA_FALLBACK_MESSAGE_LENGTH + 1) }, /at most/],
  ])('fails an unsafe enabled block closed: %o', (raw, error) => {
    const result = normalizeQuotaFallbackBotConfig(raw, 'cli_source');
    expect(result.config).toBeUndefined();
    expect(result.error).toMatch(error);
  });
});

describe('quota fallback bots.json parsing', () => {
  const base = { larkAppId: 'cli_source', larkAppSecret: 'secret', cliId: 'codex' };

  it('persists a normalized enabled block in the runtime config', () => {
    const [config] = parseBotConfigsFromText(JSON.stringify([{
      ...base,
      quotaFallbackBot: {
        enabled: true,
        targetAppId: ' cli_target ',
        kinds: ['rate'],
        message: ' fixed ',
      },
    }]));
    expect(config.quotaFallbackBot).toEqual({
      enabled: true,
      targetAppId: 'cli_target',
      kinds: ['rate'],
      message: 'fixed',
    });
  });

  it('keeps missing, disabled, and invalid blocks inert', () => {
    const [missing, disabled, invalid] = parseBotConfigsFromText(JSON.stringify([
      base,
      { ...base, larkAppId: 'cli_disabled', quotaFallbackBot: { enabled: false, targetAppId: 'cli_target' } },
      { ...base, larkAppId: 'cli_invalid', quotaFallbackBot: { enabled: true, targetAppId: 'ou_wrong' } },
    ]));
    expect(missing.quotaFallbackBot).toBeUndefined();
    expect(disabled.quotaFallbackBot).toBeUndefined();
    expect(invalid.quotaFallbackBot).toBeUndefined();
  });
});

describe('quota fallback graph validation', () => {
  const bot = (larkAppId: string, targetAppId?: string) => ({
    larkAppId,
    larkAppSecret: 'secret',
    ...(targetAppId ? {
      quotaFallbackBot: { enabled: true, targetAppId },
    } : {}),
  });

  it('returns the complete cycle and accepts an acyclic chain', () => {
    expect(findQuotaFallbackCycle([
      bot('cli_a', 'cli_b'),
      bot('cli_b', 'cli_c'),
      bot('cli_c', 'cli_a'),
    ])).toEqual(['cli_a', 'cli_b', 'cli_c', 'cli_a']);
    expect(findQuotaFallbackCycle([
      bot('cli_a', 'cli_b'),
      bot('cli_b', 'cli_c'),
      bot('cli_c'),
    ])).toBeNull();
  });

  it('finds every independent cycle so loading can disable only its members', () => {
    expect(findQuotaFallbackCycles([
      bot('cli_a', 'cli_b'),
      bot('cli_b', 'cli_a'),
      bot('cli_c', 'cli_d'),
      bot('cli_d', 'cli_e'),
      bot('cli_e', 'cli_c'),
      bot('cli_safe'),
    ])).toEqual([
      ['cli_a', 'cli_b', 'cli_a'],
      ['cli_c', 'cli_d', 'cli_e', 'cli_c'],
    ]);
  });

  it('rejects self cycles and ignores non-executable onboarding/api-only rows', () => {
    expect(() => assertQuotaFallbackGraphAcyclic([bot('cli_a', 'cli_a')]))
      .toThrow('cli_a -> cli_a');
    expect(findQuotaFallbackCycle([
      { ...bot('cli_a', 'cli_b'), activationPending: true },
      { ...bot('cli_b', 'cli_c'), apiOnly: true },
      { ...bot('cli_c', 'cli_d'), activationStarting: { jobId: 'start-c' } },
      { ...bot('cli_d', 'cli_e'), activationCommitted: { jobId: 'start-d' } },
      { ...bot('cli_e', 'cli_a'), activationDeactivating: { jobId: 'stop-e' } },
    ])).toBeNull();
  });

  it('degrades only cycle members while loading and keeps unrelated bots available', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const unrelated = Array.from({ length: 48 }, (_, index) => bot(
      `cli_safe${String(index).padStart(2, '0')}`,
      index === 0 ? 'cli_safe01' : undefined,
    ));
    const configs = parseBotConfigsFromText(JSON.stringify([
      bot('cli_a', 'cli_b'),
      bot('cli_b', 'cli_a'),
      ...unrelated,
    ]));
    expect(configs).toHaveLength(50);
    expect(configs.map(config => config.larkAppId)).toEqual([
      'cli_a',
      'cli_b',
      ...unrelated.map(entry => entry.larkAppId),
    ]);
    expect(configs[0].quotaFallbackBot).toBeUndefined();
    expect(configs[1].quotaFallbackBot).toBeUndefined();
    expect(configs[2].quotaFallbackBot?.targetAppId).toBe('cli_safe01');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'cli_a -> cli_b -> cli_a; unrelated bots remain available',
    ));
    warn.mockRestore();
  });
});

describe('quota fallback event dedupe', () => {
  it('deduplicates one source bot and limit kind for five minutes', () => {
    __testOnly_resetQuotaFallbackEvents();
    expect(claimQuotaFallbackEvent('cli_a', 'rate', 10_000)).toBe(true);
    expect(claimQuotaFallbackEvent('cli_a', 'rate', 10_001)).toBe(false);
    expect(claimQuotaFallbackEvent('cli_a', 'usage', 10_001)).toBe(true);
    expect(claimQuotaFallbackEvent('cli_b', 'rate', 10_001)).toBe(true);
    expect(claimQuotaFallbackEvent(
      'cli_a',
      'rate',
      10_000 + QUOTA_FALLBACK_DEDUPE_WINDOW_MS,
    )).toBe(true);
  });
});

function targetDeps(overrides: Partial<QuotaFallbackTargetDeps> = {}): QuotaFallbackTargetDeps {
  return {
    isLocalConfigured: vi.fn(() => false),
    resolveLocal: vi.fn(async () => ({ ok: false as const, detail: 'not local' })),
    ...overrides,
  };
}

describe('quota fallback target resolution', () => {
  it('uses the authorization-grade local peer resolver', async () => {
    const deps = targetDeps({
      isLocalConfigured: vi.fn(() => true),
      resolveLocal: vi.fn(async () => ({ ok: true as const, openId: 'ou_target' })),
    });
    await expect(resolveQuotaFallbackTarget('cli_source', 'oc_chat', 'cli_target', deps))
      .resolves.toEqual({ ok: true, openId: 'ou_target', source: 'local-peer' });
  });

  it('fails local membership / ambiguity errors closed without a text fallback', async () => {
    const deps = targetDeps({
      isLocalConfigured: vi.fn(() => true),
      resolveLocal: vi.fn(async () => ({ ok: false as const, detail: 'subject_lark_app_ambiguous' })),
    });
    await expect(resolveQuotaFallbackTarget('cli_source', 'oc_chat', 'cli_target', deps))
      .resolves.toMatchObject({ ok: false, reason: 'local_resolution_failed' });
  });

  it('fails a remote target closed even when an unrelated live bot has the same display name', async () => {
    const listTrustedTeamBots = vi.fn(async () => [
      { larkAppId: 'cli_target', botName: 'Backup' },
    ]);
    const listLiveChatBots = vi.fn(async () => [
      { openId: 'ou_IMPOSTOR', displayName: 'Backup' },
    ]);
    const deps = {
      isLocalConfigured: vi.fn(() => false),
      resolveLocal: vi.fn(async () => ({ ok: false as const, detail: 'not local' })),
      // Keep the old remote inputs in the fixture so this exact exploit stays
      // pinned: neither a trusted team row nor a same-name live row may be used.
      listTrustedTeamBots,
      listLiveChatBots,
    };
    await expect(resolveQuotaFallbackTarget('cli_source', 'oc_chat', 'cli_target', deps))
      .resolves.toEqual({ ok: false, reason: 'target_not_local' });
    expect(deps.resolveLocal).not.toHaveBeenCalled();
    expect(listTrustedTeamBots).not.toHaveBeenCalled();
    expect(listLiveChatBots).not.toHaveBeenCalled();
  });
});
