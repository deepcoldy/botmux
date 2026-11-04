/**
 * The card's usage snapshot for ZCode must read the SAME state the worker
 * writes/reads:
 *   1. the native-session marker lives under `config.session.dataDir`, so a
 *      custom SESSION_DATA_DIR must still resolve the native id;
 *   2. the `model_usage` ledger path comes from ZCODE_SESSION_DB_PATH /
 *      ZCODE_SESSION_DB resolved against the BOT's env, exactly like
 *      worker.ts's `zcodeResumeDbPath`. Neither key is reserved, so a bot can
 *      point its ledger somewhere else; reading ambient env alone would find
 *      the session but show no model/tokens, with no error.
 *
 * These walk the real getSessionUsageSnapshot (real fs, real sqlite, real bot
 * registry) rather than the individual readers, because the regression is in
 * the wiring, not in readZcodeUsage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { zcodeSessionMarkerPath } from '../src/services/zcode-session.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import { getSessionUsageSnapshot } from '../src/core/cost-calculator.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const SID = 'a5d0cf1b-efc8-4c55-9302-c9568c5fa7c0';
const NATIVE = 'sess_303c5971-88e9-4204-b396-d6309beb0aac';
const PROVIDER = '93c45030-2f68-4023-a6c4-d2cdf04543c3';
const MODEL = 'deepseek-v4-flash-vision-exp';
const APP = 'cli_zcode_usage_test';

function writeLedger(
  path: string,
  options: { modelId?: string; inputTokens?: number } = {},
): void {
  const db = openDatabaseSyncOrThrow(path);
  db.exec(`CREATE TABLE model_usage (
    session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, variant TEXT,
    status TEXT, query_source TEXT, started_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER)`);
  const inputTokens = options.inputTokens ?? 21_500;
  db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(NATIVE, 'turn-1', PROVIDER, options.modelId ?? MODEL, 'high', 'completed', 'main_turn', 1,
      inputTokens, 240, 60, Math.min(20_000, inputTokens), 0);
  db.close();
}

describe('ZCode usage snapshot wiring', () => {
  let root: string;
  let dataDir: string;
  let botLedger: string;
  let ambientLedger: string;
  let botProviderConfig: string;
  // These are the path inputs consumed by config.session.dataDir,
  // zcodeSessionDbPath and personalProviderConfigPath. Capture per test, not at
  // module evaluation, and restore even when an assertion fails.
  const pathEnvKeys = [
    'SESSION_DATA_DIR', 'ZCODE_SESSION_DB_PATH', 'ZCODE_SESSION_DB',
    'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_DATA_BASE_DIR', 'BOTMUX_GLOBAL_CONFIG_FILE',
  ] as const;
  let saved: Map<string, string | undefined>;

  function register(overrides: Partial<Parameters<typeof registerBot>[0]> = {}): void {
    registerBot({
      larkAppId: APP, larkAppSecret: '', apiOnly: true, cliId: 'zcode', allowedUsers: [],
      env: { ZCODE_SESSION_DB_PATH: botLedger, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: botProviderConfig },
      ...overrides,
    });
  }

  function expectBotUsage(snapshot: ReturnType<typeof getSessionUsageSnapshot>): void {
    expect(snapshot.model).toBe(MODEL);
    expect(snapshot.reasoningEffort).toBe('high');
    expect(snapshot.context).toMatchObject({ usedTokens: 21_500, windowTokens: 1_000_000, percentUsed: 2 });
    expect(snapshot.turnTokens).toEqual({ in: 21_500, out: 300 });
  }

  beforeEach(() => {
    saved = new Map(pathEnvKeys.map(key => [key, process.env[key]]));
    root = mkdtempSync(join(tmpdir(), 'botmux-zcode-snapshot-'));
    dataDir = join(root, 'session-data');
    botLedger = join(root, 'bot-ledger.sqlite');
    ambientLedger = join(root, 'ambient-ledger.sqlite');
    botProviderConfig = join(root, 'bot-providers.json');
    __testOnly_resetBotRegistry();
    // A real but DISTINCT ambient ledger detects accidental fallback without
    // ever inspecting a developer's ~/.zcode database or provider config.
    process.env.SESSION_DATA_DIR = dataDir;
    process.env.ZCODE_SESSION_DB_PATH = ambientLedger;
    process.env.ZCODE_SESSION_DB = join(root, 'missing-alias.sqlite');
    process.env.ZCODE_DATA_BASE_DIR = root;
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(root, 'ambient-providers.json');
    // botOneShotEnv composes the global session-env layer from this file.
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(root, 'global-config.json');
    writeFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE, '{}');
    writeFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, '{}');
    writeFileSync(botProviderConfig, JSON.stringify({ config: { modelConfigRules: {
      providerModelRules: [{ providerId: PROVIDER, modelId: MODEL, config: { properties: { contextWindow: 1_000_000 } } }],
      manualProviderModelRules: [],
    } } }));
    writeLedger(botLedger);
    writeLedger(ambientLedger, { modelId: 'ambient-distractor', inputTokens: 700 });
    const marker = zcodeSessionMarkerPath(SID, { dataDir });
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({
      version: 1, botmuxSessionId: SID, cliSessionId: NATIVE, updatedAt: Date.now(),
    }));
    register();
  });

  afterEach(() => {
    try {
      __testOnly_resetBotRegistry();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the marker from SESSION_DATA_DIR and the ledger and provider config from the bot env', () => {
    expectBotUsage(getSessionUsageSnapshot({ cliId: 'zcode', sessionId: SID, larkAppId: APP }));
  });

  it('reads the per-bot ZCODE_SESSION_DB alias when DB_PATH is absent', () => {
    delete process.env.ZCODE_SESSION_DB_PATH;
    register({ env: { ZCODE_SESSION_DB: botLedger, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: botProviderConfig } });
    expectBotUsage(getSessionUsageSnapshot({ cliId: 'zcode', sessionId: SID, larkAppId: APP }));
  });

  it('applies envUnset before resolving the per-bot ledger alias', () => {
    // The real CLI removes the higher-priority inherited path before applying
    // bot env. A read-side resolver must not keep that distractor path alive.
    register({
      envUnset: ['ZCODE_SESSION_DB_PATH'],
      env: { ZCODE_SESSION_DB: botLedger, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: botProviderConfig },
    });
    expectBotUsage(getSessionUsageSnapshot({ cliId: 'zcode', sessionId: SID, larkAppId: APP }));
  });

  it('reads a controlled ambient ledger for an unregistered bot', () => {
    const snapshot = getSessionUsageSnapshot({ cliId: 'zcode', sessionId: SID, larkAppId: 'cli_elsewhere' });
    expect(snapshot.model).toBe('ambient-distractor');
    expect(snapshot.context).toMatchObject({ usedTokens: 700 });
    expect(snapshot.turnTokens).toEqual({ in: 700, out: 300 });
  });

  it('does not throw when an unregistered bot has no ambient ledger', () => {
    process.env.ZCODE_SESSION_DB_PATH = join(root, 'missing-ledger.sqlite');
    const snapshot = getSessionUsageSnapshot({ cliId: 'zcode', sessionId: SID, larkAppId: 'cli_elsewhere' });
    expect(snapshot.model).toBeUndefined();
    expect(snapshot.context).toBeNull();
  });

  it('strict policy rejects the ambient distractor and reads the same default ledger as its worker', () => {
    // Bun freezes homedir() at process birth. Give a small runtime-aware child
    // its fixture HOME at spawn; never mutate HOME in-process or touch real home.
    const home = join(root, 'strict-home');
    const defaultLedger = join(home, '.zcode', 'cli', 'db', 'db.sqlite');
    mkdirSync(dirname(defaultLedger), { recursive: true });
    writeLedger(defaultLedger);
    const defaultProviderConfig = join(home, '.zcode', 'v2', 'provider_config.json');
    mkdirSync(dirname(defaultProviderConfig), { recursive: true });
    writeFileSync(defaultProviderConfig, JSON.stringify({ config: { modelConfigRules: {
      providerModelRules: [{ providerId: PROVIDER, modelId: MODEL, config: { properties: { contextWindow: 1_000_000 } } }],
    } } }));
    const registryUrl = new URL('../src/bot-registry.ts', import.meta.url).href;
    const calculatorUrl = new URL('../src/core/cost-calculator.ts', import.meta.url).href;
    const result = spawnSyncTsEvalWithRepoImports(`
      const { registerBot } = await import(${JSON.stringify(registryUrl)});
      const { getSessionUsageSnapshot } = await import(${JSON.stringify(calculatorUrl)});
      registerBot({ larkAppId: ${JSON.stringify(APP)}, larkAppSecret: '', apiOnly: true,
        cliId: 'zcode', allowedUsers: [], envPolicy: { mode: 'strict' } });
      const snapshot = getSessionUsageSnapshot({ cliId: 'zcode', sessionId: ${JSON.stringify(SID)},
        larkAppId: ${JSON.stringify(APP)} });
      process.stdout.write('SNAPSHOT_JSON=' + JSON.stringify(snapshot) + '\\n');
    `, {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, String(result.stderr)).toBe(0);
    const match = String(result.stdout).match(/SNAPSHOT_JSON=(.+)/);
    expect(match).not.toBeNull();
    expectBotUsage(JSON.parse(match![1]!));
  });
});
