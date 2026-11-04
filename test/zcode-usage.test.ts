import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { readZcodeUsage, zcodeContextWindow } from '../src/services/zcode-usage.js';

const NATIVE = 'sess_11522b53-2e0b-453a-8547-bbd59971caed';
const PROVIDER = '93c45030-2f68-4023-a6c4-d2cdf04543c3';

describe('ZCode usage ledger reader', () => {
  let root: string;
  let dbPath: string;
  let configPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-zcode-usage-'));
    dbPath = join(root, 'native.sqlite');
    configPath = join(root, 'provider_config.json');
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: {
          providerModelRules: [
            { providerId: PROVIDER, modelId: 'deepseek-v4-flash-vision-exp', config: { properties: { contextWindow: 1_000_000 } } },
          ],
          manualProviderModelRules: [],
        },
      },
    }));
    env = { ...process.env, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: configPath };
    const db = openDatabaseSyncOrThrow(dbPath);
    db.exec(`CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, variant TEXT,
      status TEXT, query_source TEXT, started_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER)`);
    const insert = db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    // turn-1: two calls (the second is the latest of that turn)
    insert.run(NATIVE, 'turn-1', PROVIDER, 'deepseek-v4-flash-vision-exp', 'max', 'completed', 'main_turn', 1, 15_000, 100, 50, 14_000, 0);
    insert.run(NATIVE, 'turn-1', PROVIDER, 'deepseek-v4-flash-vision-exp', 'max', 'completed', 'main_turn', 2, 16_000, 200, 0, 15_000, 0);
    // turn-2 (newest): the live context is THIS prompt size
    insert.run(NATIVE, 'turn-2', PROVIDER, 'deepseek-v4-flash-vision-exp', 'max', 'completed', 'main_turn', 3, 17_618, 11, 7, 17_024, 0);
    // must be ignored: a failed call, and non-main-turn (title / subagent) calls
    insert.run(NATIVE, 'turn-1', PROVIDER, 'deepseek-v4-flash-vision-exp', 'max', 'error', 'main_turn', 4, 99_999, 99_999, 0, 0, 0);
    insert.run(NATIVE, 'turn-2', PROVIDER, 'deepseek-v4-flash-vision-exp', 'max', 'completed', 'session_title', 5, 5_000, 5_000, 0, 0, 0);
    db.close();
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('counts only successful main-turn calls and takes context from the newest prompt', () => {
    const usage = readZcodeUsage(NATIVE, dbPath, env);
    expect(usage).toMatchObject({
      turns: 3,
      inputTokens: 15_000 + 16_000 + 17_618,
      // reasoning tokens are billed output and reported separately
      outputTokens: 100 + 200 + 11 + 50 + 7,
      cacheReadTokens: 14_000 + 15_000 + 17_024,
      // NOT the sum over turns: the newest call's prompt size is the live context
      contextUsed: 17_618,
      contextWindow: 1_000_000,
      modelId: 'deepseek-v4-flash-vision-exp',
      reasoningLevel: 'max',
    });
    // Turn delta covers the newest turn only (turn-2 has a single call).
    expect(usage).toMatchObject({ turnInputTokens: 17_618, turnOutputTokens: 18 });
  });

  it('flags a ledger with calls but no reported token counts', () => {
    const empty = join(root, 'empty.sqlite');
    const db = openDatabaseSyncOrThrow(empty);
    db.exec('CREATE TABLE model_usage (session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, variant TEXT, status TEXT, query_source TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER)');
    db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(NATIVE, 'turn-9', PROVIDER, 'gpt-5.6-terra', 'max', 'completed', 'main_turn', 1, 0, 0, 0, 0, 0);
    db.close();
    // The model is still known, but there is no measurement to show.
    const usage = readZcodeUsage(NATIVE, empty, env);
    expect(usage).toMatchObject({ turns: 1, modelId: 'gpt-5.6-terra', hasTokenEvidence: false });
  });

  it('reports no window (and therefore no percentage) when the model declares none', () => {
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }));
    expect(zcodeContextWindow(PROVIDER, 'deepseek-v4-flash-vision-exp', env)).toBeUndefined();
    expect(readZcodeUsage(NATIVE, dbPath, env)?.contextWindow).toBeUndefined();
  });

  it('returns null for an unknown session, a missing database, or a missing file', () => {
    expect(readZcodeUsage('sess_00000000-0000-0000-0000-000000000000', dbPath, env)).toBeNull();
    expect(readZcodeUsage(NATIVE, join(root, 'absent.sqlite'), env)).toBeNull();
    expect(readZcodeUsage('', dbPath, env)).toBeNull();
  });
});
