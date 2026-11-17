import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testOnly_resetBotRegistry, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import {
  assertSessionLaunchModelChoiceAllowed,
  isSessionLaunchModelBlockedError,
  resolveSessionLaunchModelChoice,
} from '../src/core/session-model.js';
import { __testOnly_sessionAgentConfig, latestModelForRespawn } from '../src/core/worker-pool.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';

const roots: string[] = [];
let previousBotsConfig: string | undefined;
afterEach(() => {
  __testOnly_resetBotRegistry();
  if (previousBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = previousBotsConfig;
  previousBotsConfig = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'traex-launch-blocked-'));
  roots.push(root);
  previousBotsConfig = process.env.BOTS_CONFIG;
  const path = join(root, 'bots.json');
  const tombstone = { enabled: true as const, models: [], catalogUnavailable: true as const };
  writeFileSync(path, JSON.stringify([{ larkAppId: 'cli_launch_blocked', larkAppSecret: 'synthetic',
    cliId: 'traex', model: 'auto', traexAutoModel: tombstone, apiOnly: true }]));
  process.env.BOTS_CONFIG = path;
  __testOnly_resetBotRegistry();
  loadBotConfigs().forEach(registerBot);
  const bot = { cliId: 'traex' as const, model: 'auto', traexAutoModel: tombstone };
  const ds: any = { larkAppId: 'cli_launch_blocked', session: {
    sessionId: 'launch-blocked', cliId: 'traex', agentFrozen: true,
    cliPathOverride: '/synthetic/traex',
    cliRuntime: { id: 'traex', displayName: 'TraeX', executable: '/synthetic/traex', source: 'legacy-path', update: {} },
  } };
  return { bot, ds, tombstone };
}

describe('TraeX empty-pool launch block without module mocks', () => {
  it('rejects sessionAgentConfig and preserves only the no-launch reattach exception', () => {
    const { bot, ds, tombstone } = fixture();
    expect(resolveSessionLaunchModelChoice(ds, bot)).toEqual({ traexAutoModel: tombstone, blocked: 'catalog_empty' });
    expect(() => __testOnly_sessionAgentConfig(ds, bot)).toThrow('catalog_empty');
    expect(__testOnly_sessionAgentConfig(ds, bot, { allowTraexCatalogEmptyReattach: true }))
      .toMatchObject({ model: undefined, traexAutoModel: undefined });
  });

  it('rejects latest model, auto policy and RPC carriers with the same blocked error', () => {
    const { bot, ds } = fixture();
    expect(() => latestModelForRespawn(ds)).toThrow('catalog_empty');
    const scope = {
      getBot: () => ({ config: bot }), resolveSessionLaunchModelChoice,
      assertSessionLaunchModelChoiceAllowed, isSessionLaunchModelBlockedError,
      sessionCliId: () => 'traex', resolveCodexRpcInput: () => false,
      config: { codexRpcInputDefault: false },
    };
    expect(() => loadWorkerPoolFunction('latestTraexAutoModelForRespawn', scope)(ds)).toThrow('catalog_empty');
    expect(() => loadWorkerPoolFunction('latestCodexRpcInputForRespawn', scope)(ds)).toThrow('catalog_empty');
  });
});
