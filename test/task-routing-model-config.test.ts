import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeBotTaskRoutingConfig,
  readGlobalTaskRoutingConfigFromRaw,
  validateGlobalTaskRoutingConfig,
} from '../src/core/task-routing/model.js';
import {
  invalidateGlobalConfigCache,
  isTaskRoutingEnabled,
  readGlobalTaskRoutingConfig,
  writeGlobalTaskRoutingConfig,
} from '../src/global-config.js';
import { coerceConfigValue, findConfigField } from '../src/services/bot-config-store.js';

describe('task-routing config model and persistence', () => {
  const savedEnv = { ...process.env };
  const tempDirs: string[] = [];

  function makeTempConfigFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-tr-cfg-'));
    tempDirs.push(dir);
    const file = join(dir, 'config.json');
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = file;
    invalidateGlobalConfigCache();
    return file;
  }

  afterEach(() => {
    if (savedEnv.BOTMUX_GLOBAL_CONFIG_FILE === undefined) {
      delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    } else {
      process.env.BOTMUX_GLOBAL_CONFIG_FILE = savedEnv.BOTMUX_GLOBAL_CONFIG_FILE;
    }
    invalidateGlobalConfigCache();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps task routing disabled by default when global config is absent', () => {
    const cfgFile = makeTempConfigFile();
    expect(existsSync(cfgFile)).toBe(false);
    expect(isTaskRoutingEnabled()).toBe(false);
    expect(readGlobalTaskRoutingConfig()).toBeUndefined();
  });

  it('rejects external http matcher and apiKey fields on global config write', () => {
    // Rejects bare mode:'http' even without unknown keys like apiKey/baseUrl.
    expect(validateGlobalTaskRoutingConfig({
      enabled: true,
      matcher: { mode: 'http' },
    }).ok).toBe(false);

    expect(validateGlobalTaskRoutingConfig({
      enabled: true,
      matcher: { mode: 'http', baseUrl: 'https://example.com', apiKey: 'sk-secret' },
    }).ok).toBe(false);

    expect(validateGlobalTaskRoutingConfig({
      enabled: true,
      matcher: { mode: 'bot', botAppId: 'cli_bot1', apiKey: 'sk-secret' },
    }).ok).toBe(false);

    expect(validateGlobalTaskRoutingConfig({
      enabled: true,
      matcher: { mode: 'bot' },
    }).ok).toBe(false);

    expect(validateGlobalTaskRoutingConfig({
      enabled: true,
      matcher: { mode: 'bot', botAppId: 'not_a_cli_id' },
    }).ok).toBe(false);

    expect(validateGlobalTaskRoutingConfig({
      enabled: true,
      matcher: { mode: 'bot', botAppId: 'cli_bot1', timeoutMs: 200 },
    }).ok).toBe(false);
  });

  it('forgivingly ignores hand-edited http matcher on read without breaking enabled flag', () => {
    const parsed = readGlobalTaskRoutingConfigFromRaw({
      enabled: true,
      policy: '优先选便宜的',
      matcher: { mode: 'http', apiKey: 'sk-ignored' },
    });
    expect(parsed).toEqual({ enabled: true, policy: '优先选便宜的' });
  });

  it('round-trips global rule and bot matcher configs and clears cleanly', () => {
    makeTempConfigFile();

    const saved = writeGlobalTaskRoutingConfig({
      enabled: true,
      policy: '简单任务选低成本，复杂重构选强模型',
      matcher: { mode: 'bot', botAppId: 'cli_judge01', timeoutMs: 12_000 },
    });
    expect(saved.ok).toBe(true);
    expect(isTaskRoutingEnabled()).toBe(true);
    expect(readGlobalTaskRoutingConfig()).toEqual({
      enabled: true,
      policy: '简单任务选低成本，复杂重构选强模型',
      matcher: { mode: 'bot', botAppId: 'cli_judge01', timeoutMs: 12_000 },
    });

    const cleared = writeGlobalTaskRoutingConfig(null);
    expect(cleared.ok).toBe(true);
    expect(isTaskRoutingEnabled()).toBe(false);
    expect(readGlobalTaskRoutingConfig()).toBeUndefined();
  });

  it('normalizes per-bot taskRouting sparsely and rejects invalid fields', () => {
    expect(normalizeBotTaskRoutingConfig(null)).toEqual({ ok: true, value: null });
    expect(normalizeBotTaskRoutingConfig({ enabled: false })).toEqual({ ok: true, value: null });

    const valid = normalizeBotTaskRoutingConfig({
      enabled: true,
      costTier: 'low',
      strengths: '  改文案、小修、单测  ',
      limitations: '不擅长跨模块架构重构',
    });
    expect(valid).toEqual({
      ok: true,
      value: {
        enabled: true,
        costTier: 'low',
        strengths: '改文案、小修、单测',
        limitations: '不擅长跨模块架构重构',
      },
    });

    expect(normalizeBotTaskRoutingConfig({ enabled: true, costTier: 'ultra' }).ok).toBe(false);
    expect(normalizeBotTaskRoutingConfig({ enabled: true, unknownKey: 1 }).ok).toBe(false);
    expect(normalizeBotTaskRoutingConfig({ enabled: true, strengths: 'bad\0text' }).ok).toBe(false);
  });

  it('coerces taskRouting through bot-config-store CONFIG_FIELDS', () => {
    const spec = findConfigField('taskRouting');
    expect(spec).toBeDefined();
    expect(spec?.configKey).toBe('taskRouting');

    const okRes = coerceConfigValue(
      spec!,
      JSON.stringify({ enabled: true, costTier: 'high', strengths: '架构重构' }),
    );
    expect(okRes).toEqual({
      ok: true,
      value: { enabled: true, costTier: 'high', strengths: '架构重构' },
    });

    const badRes = coerceConfigValue(spec!, JSON.stringify({ enabled: true, costTier: 'invalid' }));
    expect(badRes.ok).toBe(false);
  });

  it('reflects cross-process config.json kill-switch flips immediately without waiting for 2s TTL cache', () => {
    const cfgFile = makeTempConfigFile();
    writeFileSync(cfgFile, JSON.stringify({ taskRouting: { enabled: true, matcher: { mode: 'rule' } } }));
    expect(isTaskRoutingEnabled()).toBe(true);

    // Simulate another process (Dashboard / manual edit) disabling taskRouting immediately after.
    writeFileSync(cfgFile, JSON.stringify({ taskRouting: { enabled: false } }, null, 2));
    expect(isTaskRoutingEnabled()).toBe(false);
  });
});
