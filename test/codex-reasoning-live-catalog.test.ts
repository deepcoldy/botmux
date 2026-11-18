/**
 * Codex reasoning levels follow the live model catalogue of the runtime that
 * launches the model (`codex debug models`), with the static table as the
 * fallback when there is none — and every path that offers, saves, keeps or
 * launches a level agrees with that one judgment.
 *
 * `gpt-6.3-sol` below stands for "a model released after the static table";
 * catalogue fixtures copy the shape of real `codex debug models` output (the
 * gateway rows are what a non-OpenAI provider returned on a dev host).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_REASONING_EFFORTS,
  cliModelMayKeepReasoningEffort,
  codexAppResumeRestoresReasoningEffort,
  codexReasoningEffortDroppedNotice,
  codexReasoningEffortsForModel,
  reasoningEffortsForCliModel,
  resolveCodexLaunchReasoningEffort,
  type ReasoningCatalog,
} from '../src/services/codex-reasoning-effort.js';
import { buildModelChoicesResponse, createModelCatalog } from '../src/services/model-catalog.js';
import { codexLaunchCatalogEnv } from '../src/services/codex-launch-catalog-env.js';
import { clearCodexServiceTierCatalogCache } from '../src/services/codex-service-tier-catalog.js';
import { __testOnly_resetBotRegistry, loadBotConfigs, parseBotConfigsFromText, registerBot } from '../src/bot-registry.js';
import { __testOnly_sessionAgentConfig } from '../src/core/worker-pool.js';
import { modelPinView, validateModelPin, type ModelPin } from '../src/core/model-pin.js';
import { resolveSessionLaunchEffort } from '../src/core/session-model.js';
import { resolveDispatchLaunchSpec } from '../src/core/dispatch-launch-spec.js';
import { resolveDispatchLaunchOverride } from '../src/core/dispatch-launch-contract.js';
import { isRemoteBackendType } from '../src/core/persistent-backend.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as sessionStore from '../src/services/session-store.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const SIX = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const FOUR = ['low', 'medium', 'high', 'xhigh'];
const FUTURE = 'gpt-6.3-sol';

const officialCatalog: ReasoningCatalog = [
  { slug: FUTURE, reasoningEfforts: SIX },
  { slug: 'gpt-6-luna', reasoningEfforts: SIX }, // claims more than its verified row
  { slug: 'gpt-5.5', reasoningEfforts: SIX },
];
const gatewayCatalog: ReasoningCatalog = [
  { slug: 'gpt-5.6-sol', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { slug: 'GPT-6.1-Sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'kimi-k2.5-2026-03-05' },
  { slug: 'none-only', reasoningEfforts: ['none'] },
];

describe('Codex reasoning judgment: live catalogue first, static table as fallback', () => {
  it('carries the rows verified from the codex-cli 0.170.0 bundled catalogue', () => {
    for (const model of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra']) {
      expect(codexReasoningEffortsForModel(model)).toEqual(SIX);
    }
  });

  it('gives a model outside the table exactly what its catalogue advertises, on both Codex clients', () => {
    for (const cliId of ['codex', 'codex-app']) {
      expect(reasoningEffortsForCliModel(cliId, FUTURE, officialCatalog)).toEqual(SIX);
      expect(reasoningEffortsForCliModel(cliId, FUTURE, [{ slug: FUTURE, reasoningEfforts: ['max', 'low'] }]))
        .toEqual(['low', 'max']);
    }
    // Older models without a row follow their catalogue too, in both directions.
    expect(codexReasoningEffortsForModel('gpt-5.5', officialCatalog)).toEqual(SIX);
  });

  it('stays on the common four without a catalogue, or when it has no level for the model', () => {
    expect(codexReasoningEffortsForModel(FUTURE)).toEqual(FOUR);
    expect(codexReasoningEffortsForModel(FUTURE, null)).toEqual(FOUR);
    expect(codexReasoningEffortsForModel(FUTURE, gatewayCatalog)).toEqual(FOUR);
    expect(codexReasoningEffortsForModel('kimi-k2.5-2026-03-05', gatewayCatalog)).toEqual(FOUR);
    expect(codexReasoningEffortsForModel('none-only', gatewayCatalog)).toEqual(FOUR);
  });

  it('lets a catalogue that advertises fewer levels than the table narrow the choice', () => {
    expect(codexReasoningEffortsForModel('gpt-5.6-sol')).toEqual(SIX);
    expect(codexReasoningEffortsForModel('gpt-5.6-sol', gatewayCatalog)).toEqual(FOUR);
    // Slugs match case-insensitively, as `codex --model` names do.
    expect(codexReasoningEffortsForModel('gpt-6.1-sol', gatewayCatalog)).toEqual(SIX.slice(0, 5));
  });

  it('never lets a catalogue widen a verified table row', () => {
    expect(codexReasoningEffortsForModel('gpt-6-luna', officialCatalog)).toEqual(SIX.slice(0, 5));
  });

  it('leaves every other CLI on its own contract', () => {
    expect(reasoningEffortsForCliModel('grok', 'grok-4.7', officialCatalog))
      .toEqual(reasoningEffortsForCliModel('grok', 'grok-4.7'));
    expect(reasoningEffortsForCliModel('traex', FUTURE, officialCatalog))
      .toEqual(reasoningEffortsForCliModel('traex', FUTURE));
  });
});

describe('paths without a catalogue keep what the table cannot refute', () => {
  it('keeps any level on a model outside the table and enforces verified rows', () => {
    for (const effort of CODEX_REASONING_EFFORTS) {
      expect(cliModelMayKeepReasoningEffort('codex', FUTURE, effort)).toBe(true);
    }
    expect(cliModelMayKeepReasoningEffort('codex', 'gpt-6-luna', 'ultra')).toBe(false);
    expect(cliModelMayKeepReasoningEffort('codex-app', 'gpt-5.6-luna', 'ultra')).toBe(false);
    expect(cliModelMayKeepReasoningEffort('codex', undefined, 'max')).toBe(false);
    expect(cliModelMayKeepReasoningEffort('codex', undefined, 'xhigh')).toBe(true);
    expect(cliModelMayKeepReasoningEffort('grok', 'grok-4.6', 'max'))
      .toBe(reasoningEffortsForCliModel('grok', 'grok-4.6').includes('max'));
  });

  it('config load keeps a catalogue-only level and still drops levels a verified row refutes', () => {
    const configs = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'future-max', larkAppSecret: 's', cliId: 'codex', model: FUTURE, reasoningEffort: 'max' },
      { larkAppId: 'future-ultra-app', larkAppSecret: 's', cliId: 'codex-app', model: FUTURE, reasoningEffort: 'ultra' },
      { larkAppId: 'luna-ultra', larkAppSecret: 's', cliId: 'codex', model: 'gpt-6-luna', reasoningEffort: 'ultra' },
      { larkAppId: 'default-max', larkAppSecret: 's', cliId: 'codex', reasoningEffort: 'max' },
    ]));
    const effort = (id: string) => configs.find(config => config.larkAppId === id)?.reasoningEffort;
    expect(effort('future-max')).toBe('max');
    expect(effort('future-ultra-app')).toBe('ultra');
    expect(effort('luna-ultra')).toBeUndefined();
    expect(effort('default-max')).toBeUndefined();
  });

  it('the daemon launch config passes the kept level through to the worker', () => {
    const [parsed] = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'future-launch', larkAppSecret: 's', cliId: 'codex', model: FUTURE, reasoningEffort: 'max' },
    ]));
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    try {
      for (const frozen of [false, true]) {
        const ds = {
          larkAppId: 'future-launch',
          session: { cliId: 'codex', ...(frozen ? { agentFrozen: true, reasoningEffort: 'max' } : {}) },
        } as Parameters<typeof __testOnly_sessionAgentConfig>[0];
        expect(__testOnly_sessionAgentConfig(ds, parsed!)).toMatchObject({ model: FUTURE, reasoningEffort: 'max' });
        expect(ds.session.reasoningEffort).toBe('max');
      }
    } finally {
      update.mockRestore();
    }
  });

  it('a pinned level on a model outside the table is kept and shown without a downgrade note', () => {
    const pin: ModelPin = { model: FUTURE, effort: 'ultra', source: 'command', setBy: 'owner', setAt: '2026-11-19T00:00:00.000Z' };
    const bot = { cliId: 'codex' as const, model: 'gpt-6.1-sol' };
    const ds = { session: { cliId: 'codex' as const, chatType: 'group' as const, modelPin: pin } };
    expect(resolveSessionLaunchEffort(ds as any, bot, FUTURE, 'low')).toBe('ultra');
    expect(modelPinView(ds.session, bot)?.effortDowngradeNote).toBeUndefined();
  });

  it('/modelpin validation uses the catalogue when the writer has one', () => {
    const cfg = { cliId: 'codex' as const };
    expect(validateModelPin({ model: FUTURE, effort: 'ultra' }, cfg, officialCatalog)).toBeUndefined();
    expect(validateModelPin({ model: FUTURE, effort: 'ultra' }, cfg)).toBeTruthy();
    expect(validateModelPin({ model: 'gpt-5.6-sol', effort: 'max' }, cfg, gatewayCatalog)).toBeTruthy();
    expect(validateModelPin({ model: 'gpt-5.6-sol', effort: 'max' }, cfg)).toBeUndefined();
  });

  it('dispatch accepts the target bot\'s own saved pair on both sides and still rejects a refuted override', async () => {
    const target = { cliId: 'codex' as const, model: FUTURE, reasoningEffort: 'max' as const };
    const detectModels = async () => [FUTURE, 'gpt-5.5'];
    // Dispatching CLI.
    await expect(resolveDispatchLaunchSpec({ requested: { model: FUTURE }, target, detectModels }))
      .resolves.toMatchObject({ ok: true, effective: { model: FUTURE, reasoningEffort: 'max' } });
    await expect(resolveDispatchLaunchSpec({ requested: { model: 'gpt-5.5' }, target, detectModels }))
      .resolves.toMatchObject({ ok: false });
    await expect(resolveDispatchLaunchSpec({ requested: { reasoningEffort: 'ultra' }, target: { ...target, model: 'gpt-5.5' }, detectModels }))
      .resolves.toMatchObject({ ok: false });
    // Target daemon.
    const override = (requested: { model?: string; reasoningEffort?: 'ultra' }) => resolveDispatchLaunchOverride({
      cliId: 'codex', requested, targetModel: FUTURE, targetReasoningEffort: 'max',
    });
    expect(override({ model: FUTURE })).toMatchObject({ ok: true, effective: { model: FUTURE, reasoningEffort: 'max' } });
    expect(override({ model: 'gpt-5.5' })).toMatchObject({ ok: false, errorCode: 'INVALID_MODEL_EFFORT_COMBINATION' });
    expect(override({ reasoningEffort: 'ultra' })).toMatchObject({ ok: false, errorCode: 'INVALID_MODEL_EFFORT_COMBINATION' });
  });
});

describe('launch-time gate', () => {
  it('skips only an effective Codex App thread resume, never a demoted fresh start', () => {
    expect(codexAppResumeRestoresReasoningEffort({
      cliId: 'codex-app', resume: true, cliSessionId: 'thread-1',
    })).toBe(true);
    // init asked to resume, but the worker's probe/tier-2 demotion made the
    // actual launch fresh: the worker must still gate this thread/start.
    expect(codexAppResumeRestoresReasoningEffort({
      cliId: 'codex-app', resume: false, cliSessionId: 'thread-1',
    })).toBe(false);
    expect(codexAppResumeRestoresReasoningEffort({
      cliId: 'codex-app', resume: true, cliSessionId: undefined,
    })).toBe(false);
    expect(codexAppResumeRestoresReasoningEffort({
      cliId: 'codex', resume: true, cliSessionId: 'thread-1',
    })).toBe(false);
  });

  it('passes the common four through without asking the catalogue', async () => {
    const loadCatalog = vi.fn(async () => officialCatalog);
    for (const effort of FOUR) {
      await expect(resolveCodexLaunchReasoningEffort({ cliId: 'codex', model: FUTURE, effort: effort as any, loadCatalog }))
        .resolves.toEqual({ effort });
    }
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it('launches a catalogue-only level and drops it when nothing vouches for it', async () => {
    const launch = (loadCatalog: (() => Promise<ReasoningCatalog | null>) | null, model = FUTURE) =>
      resolveCodexLaunchReasoningEffort({ cliId: 'codex', model, effort: 'max', loadCatalog });
    await expect(launch(async () => officialCatalog)).resolves.toEqual({ effort: 'max' });
    await expect(launch(async () => null)).resolves.toMatchObject({ dropped: { effort: 'max', supported: FOUR, catalog: false } });
    await expect(launch(null)).resolves.toMatchObject({ dropped: { effort: 'max', catalog: false } });
    await expect(launch(async () => { throw new Error('exec failed'); })).resolves.toMatchObject({ dropped: { effort: 'max' } });
    // Catalogue narrower than the table: the catalogue wins at launch too.
    await expect(launch(async () => gatewayCatalog, 'gpt-5.6-sol'))
      .resolves.toMatchObject({ dropped: { effort: 'max', supported: FOUR, catalog: true } });
    // A verified row needs no catalogue.
    await expect(launch(null, 'gpt-6.2-sol')).resolves.toEqual({ effort: 'max' });
  });

  it('the worker asks the catalogue of this launch only when it can speak for the provider', async () => {
    const loadCodexServiceTierCatalog = vi.fn(async () => officialCatalog);
    const log = vi.fn();
    const send = vi.fn();
    const gate = loadWorkerFunction<(cfg: any, cliBin: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>>(
      'codexLaunchReasoningEffort',
      { resolveCodexLaunchReasoningEffort, codexReasoningEffortDroppedNotice, loadCodexServiceTierCatalog, isRemoteBackendType, log, send, currentBotmuxTurnId: 'om_turn' },
    );
    const cfg = { cliId: 'codex', model: FUTURE, reasoningEffort: 'max', backendType: 'tmux' };
    const env = { CODEX_HOME: '/fixture/codex-home' };
    await expect(gate(cfg, '/fixture/codex', env)).resolves.toBe('max');
    expect(loadCodexServiceTierCatalog).toHaveBeenCalledWith({ cliBin: '/fixture/codex', env });

    loadCodexServiceTierCatalog.mockClear();
    for (const blind of [{ wrapperCli: 'aiden x codex' }, { codexProfile: 'work' }, { backendType: 'remote-runner' }]) {
      await expect(gate({ ...cfg, ...blind }, '/fixture/codex', env)).resolves.toBeUndefined();
    }
    expect(loadCodexServiceTierCatalog).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('launching without it'));
    // The saved setting is kept, so the user is told why this launch differs.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_notify', turnId: 'om_turn', message: expect.stringContaining('max'),
    }));
    send.mockClear();
    await gate(cfg, '/fixture/codex', env);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the launch probe reads the catalogue under the CODEX_HOME the CLI starts on', () => {
  it('applies the read-isolation home, then the instance-pool binding, over the session and bot env', () => {
    const base = { PATH: '/usr/bin', CODEX_HOME: '/host/.codex', OPENAI_API_KEY: 'session-key' };
    const botEnv = { CODEX_HOME: '/bot/codex', OPENAI_BASE_URL: 'https://relay.example' };
    expect(codexLaunchCatalogEnv({ base, botEnv })).toMatchObject({ CODEX_HOME: '/bot/codex', PATH: '/usr/bin' });
    expect(codexLaunchCatalogEnv({ base, botEnv, isolatedCodexHome: '/bots/b1/codex' }).CODEX_HOME).toBe('/bots/b1/codex');
    const legacy = { version: 1 as const, source: 'legacy' as const, instanceId: null, cliId: 'codex' as const, codexHome: '/pool/legacy', authMode: 'shared' as const };
    expect(codexLaunchCatalogEnv({ base, botEnv, isolatedCodexHome: '/bots/b1/codex', instanceBinding: legacy }).CODEX_HOME).toBe('/pool/legacy');
    expect(base.CODEX_HOME).toBe('/host/.codex');
  });
});

describe('Dashboard catalogue cache follows CODEX_HOME/config.toml', () => {
  it('re-probes after the config the catalogue is read under changes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-cfg-identity-'));
    try {
      writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\n');
      let levels = SIX;
      const catalog = createModelCatalog();
      const opts = {
        runtimeContext: 'config-identity',
        probeEnv: { ...process.env, CODEX_HOME: home },
        adapterFactory: () => ({
          detectModelCapabilities: async () => [{ slug: FUTURE, serviceTiers: [], reasoningEfforts: [...levels] }],
        }) as unknown as CliAdapter,
      };
      expect((await catalog.detectModelCatalog('codex', opts))?.modelCapabilities?.[0]?.reasoningEfforts).toEqual(SIX);
      levels = FOUR;
      expect((await catalog.detectModelCatalog('codex', opts))?.modelCapabilities?.[0]?.reasoningEfforts).toEqual(SIX);
      writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_provider = "relay"\n');
      expect((await catalog.detectModelCatalog('codex', opts))?.modelCapabilities?.[0]?.reasoningEfforts).toEqual(FOUR);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Dashboard offers, saves and keeps catalogue levels', () => {
  it('offers per-model levels from the same judgment', async () => {
    const body = await buildModelChoicesResponse('codex', {
      runtimeContext: 'codex-reasoning-live-catalog',
      adapterFactory: () => ({
        detectModelCapabilities: async () => [...officialCatalog.slice(0, 1), ...gatewayCatalog]
          .map(entry => ({ ...entry, serviceTiers: [], reasoningEfforts: entry.reasoningEfforts ? [...entry.reasoningEfforts] : undefined })),
      }) as unknown as CliAdapter,
    });
    expect(body.reasoningEffortsByModel).toEqual({
      [FUTURE]: SIX,
      'gpt-5.6-sol': FOUR,
      'GPT-6.1-Sol': SIX.slice(0, 5),
    });
  });

  describe('save through the real IPC route against a fake `codex debug models`', () => {
    const appId = 'cli_codex_live_catalog';
    let dir: string;
    let configPath: string;
    let server: IpcServerHandle | undefined;

    const writeCatalog = (models: Array<{ slug: string; levels: string[] }>) => writeFileSync(join(dir, 'bin', 'catalog.json'), JSON.stringify({
      models: models.map(model => ({
        slug: model.slug,
        visibility: 'list',
        supported_reasoning_levels: model.levels.map(effort => ({ effort })),
        service_tiers: [],
      })),
    }));

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'codex-live-catalog-'));
      mkdirSync(join(dir, 'bin'));
      const fake = join(dir, 'bin', 'codex');
      writeFileSync(fake, [
        '#!/bin/sh',
        'if [ "$1" = debug ] && [ "$2" = models ]; then cat "$(dirname "$0")/catalog.json"; exit 0; fi',
        'exit 1',
        '',
      ].join('\n'));
      chmodSync(fake, 0o755);
      configPath = join(dir, 'bots.json');
      vi.stubEnv('BOTS_CONFIG', configPath);
      vi.stubEnv('PATH', `${join(dir, 'bin')}:${process.env.PATH ?? ''}`);
      clearCodexServiceTierCatalogCache();
      writeFileSync(configPath, JSON.stringify([
        { larkAppId: appId, larkAppSecret: 'fixture', cliId: 'codex', model: 'gpt-6.1-sol' },
      ]));
      loadBotConfigs().forEach(registerBot);
      setLarkAppId(appId);
    });

    afterEach(async () => {
      if (server) await server.close();
      server = undefined;
      setLarkAppId('');
      __testOnly_resetBotRegistry();
      clearCodexServiceTierCatalogCache();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    });

    async function save(body: Record<string, unknown>) {
      server ??= await startIpcServer({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`http://127.0.0.1:${server.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    it('saves a level the catalogue advertises for a model outside the table, and config load keeps it', async () => {
      writeCatalog([{ slug: FUTURE, levels: SIX }]);
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 200, body: { ok: true } });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0]).toMatchObject({ model: FUTURE, reasoningEffort: 'max' });
      expect(loadBotConfigs()[0]).toMatchObject({ model: FUTURE, reasoningEffort: 'max' });
    });

    it('/botconfig field writes judge the pair against the same catalogue and keep it on unrelated saves', async () => {
      const store = await import('../src/services/bot-config-store.js');
      const field = (key: string) => store.findConfigField(key)!;
      writeCatalog([{ slug: FUTURE, levels: SIX }]);
      expect(await store.applyConfigField(appId, field('model'), FUTURE)).toMatchObject({ ok: true });
      expect(await store.applyConfigField(appId, field('reasoningEffort'), 'ultra')).toMatchObject({ ok: true });
      expect(loadBotConfigs()[0]).toMatchObject({ model: FUTURE, reasoningEffort: 'ultra' });

      // The catalogue stops vouching: a new pair write is refused, an
      // unrelated field still saves without dropping the kept level.
      writeCatalog([{ slug: FUTURE, levels: FOUR }]);
      clearCodexServiceTierCatalogCache();
      expect(await store.applyConfigField(appId, field('reasoningEffort'), 'max'))
        .toMatchObject({ ok: false, reason: 'reasoning_effort_not_supported_by_model' });
      expect(await store.applyConfigField(appId, field('lang'), 'en')).toMatchObject({ ok: true });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0]).toMatchObject({ lang: 'en', reasoningEffort: 'ultra' });
    });

    it('/botconfig switching to Codex asks the Codex binary, not the previous CLI\'s runtime path', async () => {
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId, larkAppSecret: 'fixture', cliId: 'claude-code', model: FUTURE, reasoningEffort: 'max',
        cliPathOverride: join(dir, 'bin', 'not-codex'),
      }]));
      __testOnly_resetBotRegistry();
      loadBotConfigs().forEach(registerBot);
      writeCatalog([{ slug: FUTURE, levels: SIX }]);
      const store = await import('../src/services/bot-config-store.js');
      expect(await store.applyConfigField(appId, store.findConfigField('cli')!, 'codex')).toMatchObject({ ok: true });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0]).toMatchObject({ cliId: 'codex', reasoningEffort: 'max' });
    });

    it('the daemon-side loader never asks a bare catalogue for a wrapper or Codex profile', async () => {
      const { loadBotCodexReasoningCatalog } = await import('../src/services/codex-bot-reasoning-catalog.js');
      writeCatalog([{ slug: FUTURE, levels: SIX }]);
      const bot = loadBotConfigs()[0]!;
      await expect(loadBotCodexReasoningCatalog(bot)).resolves.toEqual([expect.objectContaining({ slug: FUTURE, reasoningEfforts: SIX })]);
      await expect(loadBotCodexReasoningCatalog({ ...bot, wrapperCli: 'aiden x codex' })).resolves.toBeNull();
      await expect(loadBotCodexReasoningCatalog({ ...bot, codexProfile: 'work' })).resolves.toBeNull();
      await expect(loadBotCodexReasoningCatalog({ ...bot, cliId: 'claude-code' })).resolves.toBeNull();
      // A session created without a profile (null) launches without one, even
      // after the bot gains a profile; a frozen profile blinds the catalogue.
      const { loadSessionCodexReasoningCatalog } = await import('../src/services/codex-bot-reasoning-catalog.js');
      await expect(loadSessionCodexReasoningCatalog({ cliId: 'codex', codexProfile: null }, { ...bot, codexProfile: 'work' }))
        .resolves.toEqual([expect.objectContaining({ slug: FUTURE })]);
      await expect(loadSessionCodexReasoningCatalog({ cliId: 'codex', agentFrozen: true, codexProfile: 'work' }, bot))
        .resolves.toBeNull();
    });

    it('re-saving the saved pair unchanged survives an unreachable catalogue; a changed pair does not', async () => {
      writeFileSync(configPath, JSON.stringify([
        { larkAppId: appId, larkAppSecret: 'fixture', cliId: 'codex', model: FUTURE, reasoningEffort: 'max' },
      ]));
      __testOnly_resetBotRegistry();
      loadBotConfigs().forEach(registerBot);
      // No catalog.json: the fake `codex debug models` fails.
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 200, body: { ok: true } });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0]).toMatchObject({ model: FUTURE, reasoningEffort: 'max' });
      await expect(save({ cliId: 'codex', model: 'gpt-6.4-sol', reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 400, body: { error: 'reasoning_effort_not_supported_by_model' } });
    });

    it('an edit to CODEX_HOME/config.toml is not answered from a catalogue cached before it', async () => {
      const { loadCodexServiceTierCatalog } = await import('../src/services/codex-service-tier-catalog.js');
      const home = join(dir, 'codex-home');
      mkdirSync(home);
      writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\n');
      const env = { ...process.env, CODEX_HOME: home };
      const cliBin = join(dir, 'bin', 'codex');
      writeCatalog([{ slug: FUTURE, levels: SIX }]);
      expect((await loadCodexServiceTierCatalog({ cliBin, env }))?.[0]?.reasoningEfforts).toEqual(SIX);
      writeCatalog([{ slug: FUTURE, levels: FOUR }]);
      expect((await loadCodexServiceTierCatalog({ cliBin, env }))?.[0]?.reasoningEfforts).toEqual(SIX); // cached
      writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_catalog_json = "catalog.json"\n');
      expect((await loadCodexServiceTierCatalog({ cliBin, env }))?.[0]?.reasoningEfforts).toEqual(FOUR);
    });

    it('a wrapper selection is judged by the static table even when its binary answers a catalogue', async () => {
      writeCatalog([{ slug: FUTURE, levels: SIX }]);
      const wrapper = join(dir, 'bin', 'cjadk');
      writeFileSync(wrapper, readFileSync(join(dir, 'bin', 'codex'), 'utf8'));
      chmodSync(wrapper, 0o755);
      await expect(save({ cliId: 'cjadk-x-codex', model: FUTURE, reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 400, body: { error: 'reasoning_effort_not_supported_by_model' } });
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 200 });
    });

    it('a re-save that switches runtime, or meets an explicit catalogue answer, is judged strictly', async () => {
      writeFileSync(configPath, JSON.stringify([
        { larkAppId: appId, larkAppSecret: 'fixture', cliId: 'codex', model: FUTURE, reasoningEffort: 'max' },
      ]));
      __testOnly_resetBotRegistry();
      loadBotConfigs().forEach(registerBot);
      writeCatalog([{ slug: FUTURE, levels: SIX }]);
      // The new runtime cannot answer a catalogue: nothing vouches for max there.
      const alt = join(dir, 'bin', 'alt-codex');
      writeFileSync(alt, [
        '#!/bin/sh',
        'if [ "$1" = --version ]; then echo "codex-cli 0.170.0"; exit 0; fi',
        'exit 1',
        '',
      ].join('\n'));
      chmodSync(alt, 0o755);
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'max', cliRuntime: { id: 'alt-codex', executable: alt } }))
        .resolves.toMatchObject({ status: 400, body: { error: 'reasoning_effort_not_supported_by_model' } });
      // Same runtime, but its catalogue now answers four levels for the model.
      writeCatalog([{ slug: FUTURE, levels: FOUR }]);
      clearCodexServiceTierCatalogCache();
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 400, body: { error: 'reasoning_effort_not_supported_by_model' } });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0]).toMatchObject({ reasoningEffort: 'max' });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0]).not.toHaveProperty('cliRuntime');
    });

    it('adding a Codex profile in the same save leaves the catalogue behind and is judged by the table', async () => {
      const home = join(dir, 'codex-home');
      mkdirSync(home);
      writeFileSync(join(home, 'work.config.toml'), 'model = "fixture"');
      vi.stubEnv('CODEX_HOME', home);
      const runtime = join(dir, 'bin', 'codex-fixture');
      writeFileSync(runtime, [
        '#!/bin/sh',
        'case "$1" in',
        '--version) echo "codex-cli 0.170.0";;',
        '--help) echo "--profile PROFILE";;',
        'debug) cat "$(dirname "$0")/catalog.json";;',
        '*) exit 91;;',
        'esac',
        '',
      ].join('\n'));
      chmodSync(runtime, 0o755);
      writeFileSync(configPath, JSON.stringify([{ larkAppId: appId, larkAppSecret: 'fixture', cliId: 'codex',
        cliRuntime: { id: 'fixture', executable: runtime }, cliPathOverride: runtime, model: FUTURE, reasoningEffort: 'max' }]));
      __testOnly_resetBotRegistry();
      loadBotConfigs().forEach(registerBot);
      writeCatalog([{ slug: FUTURE, levels: SIX }]);
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 200 });
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'max', codexProfile: 'work' }))
        .resolves.toMatchObject({ status: 400, body: { error: 'reasoning_effort_not_supported_by_model' } });
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'xhigh', codexProfile: 'work' }))
        .resolves.toMatchObject({ status: 200 });
    });

    it('rejects it when the catalogue does not vouch for it', async () => {
      writeCatalog([{ slug: 'gpt-6.1-sol', levels: SIX }]);
      await expect(save({ cliId: 'codex', model: FUTURE, reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 400, body: { error: 'reasoning_effort_not_supported_by_model' } });
      writeCatalog([{ slug: 'gpt-5.6-sol', levels: FOUR }]);
      clearCodexServiceTierCatalogCache();
      await expect(save({ cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'max' }))
        .resolves.toMatchObject({ status: 400, body: { error: 'reasoning_effort_not_supported_by_model' } });
    });
  });
});
