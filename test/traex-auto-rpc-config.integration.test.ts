import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  __testOnly_resetBotRegistry, getBot, loadBotConfigs, parseBotConfigsFromText, registerBot,
} from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer } from '../src/core/dashboard-ipc-server.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { config } from '../src/config.js';
import { resolveBotCodexRpcInput, resolveCodexRpcInput } from '../src/services/codex-rpc-input-policy.js';
import { botDefaultsPayload } from '../src/dashboard/bot-payload.js';
import { applyConfigField, findConfigField } from '../src/services/bot-config-store.js';

describe('Auto and global RPC configuration compatibility', () => {
  it.each([
    { global: false, override: undefined }, { global: false, override: false }, { global: false, override: true },
    { global: true, override: undefined }, { global: true, override: false }, { global: true, override: true },
  ])('enables and disables Auto with global=$global / override=$override without changing stored input preferences', async ({ global, override }) => {
    const root = mkdtempSync(join(tmpdir(), 'auto-rpc-config-'));
    const oldBots = process.env.BOTS_CONFIG;
    const oldGlobal = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    const botsPath = join(root, 'bots.json');
    const globalPath = join(root, 'global.json');
    process.env.BOTS_CONFIG = botsPath;
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = globalPath;
    const globalText = JSON.stringify({ dashboard: { codexRpcInput: global } });
    writeFileSync(globalPath, globalText);
    const peer = { larkAppId: 'rpc_peer', larkAppSecret: 'fixture', cliId: 'codex' };
    const traexPeer = { larkAppId: 'traex_peer', larkAppSecret: 'fixture', cliId: 'traex' };
    writeFileSync(botsPath, JSON.stringify([
      { larkAppId: 'auto_target', larkAppSecret: 'fixture', cliId: 'traex',
        ...(override === undefined ? {} : { codexRpcInput: override }) }, peer, traexPeer,
    ]));
    invalidateGlobalConfigCache();
    __testOnly_resetBotRegistry();
    loadBotConfigs().forEach(registerBot);
    setLarkAppId('auto_target');
    const server = await startIpcServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const pool = { enabled: true, models: ['first', 'backup'], queueTimeoutMs: 30_000 };
    const save = (extra: object = {}) => fetch(`${base}/api/bot-agent`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliId: 'traex', model: 'auto', traexAutoModel: pool, ...extra }),
    });
    try {
      const accepted = await save();
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        ok: true, codexRpcInput: override ?? null, codexRpcInputDefault: global, codexRpcInputEffective: false,
      });
      const persisted = JSON.parse(readFileSync(botsPath, 'utf8'));
      expect(persisted).toEqual([expect.objectContaining({ traexAutoModel: pool }), peer, traexPeer]);
      expect(persisted[0].codexRpcInput).toBe(override);
      expect(Object.hasOwn(persisted[0], 'codexRpcInput')).toBe(override !== undefined);
      const loaded = loadBotConfigs();
      expect(loaded[0].codexRpcInput).toBe(override);
      expect(resolveBotCodexRpcInput(loaded[0], config.codexRpcInputDefault)).toBe(false);
      expect(loaded.slice(1).map(bot => resolveBotCodexRpcInput(bot, config.codexRpcInputDefault))).toEqual([global, global]);
      // Saving again, including from an older client, preserves the original preference.
      expect((await save()).status).toBe(200);
      const defaults = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(defaults).toMatchObject({
        codexRpcInput: override ?? null, codexRpcInputDefault: global, codexRpcInputEffective: false,
        traexAutoModelBlockedReason: null,
      });
      const spec = findConfigField('codexRpcInput')!;
      // /config edits remain valid; Auto derives terminal mode until disabled.
      for (const value of [true, false, null]) {
        expect((await applyConfigField('auto_target', spec, value)).ok).toBe(true);
        expect(resolveBotCodexRpcInput(getBot('auto_target').config, global)).toBe(false);
      }
      expect((await applyConfigField('auto_target', spec, override ?? null)).ok).toBe(true);
      const disabled = await save({ model: 'first', traexAutoModel: null });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toMatchObject({
        codexRpcInput: override ?? null, codexRpcInputEffective: override ?? global,
      });
      const reloaded = loadBotConfigs();
      expect(reloaded[0].codexRpcInput).toBe(override);
      expect(Object.hasOwn(JSON.parse(readFileSync(botsPath, 'utf8'))[0], 'codexRpcInput')).toBe(override !== undefined);
      expect(resolveBotCodexRpcInput(reloaded[0], global)).toBe(override ?? global);
      expect(reloaded[0].traexAutoModel).toBeUndefined();
      const disabledDefaults = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(disabledDefaults.codexRpcInputEffective).toBe(override ?? global);
      expect(JSON.parse(readFileSync(botsPath, 'utf8')).slice(1)).toEqual([peer, traexPeer]);
      expect(readFileSync(globalPath, 'utf8')).toBe(globalText);
    } finally {
      await server.close();
      setLarkAppId('');
      __testOnly_resetBotRegistry();
      if (oldBots === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = oldBots;
      if (oldGlobal === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE; else process.env.BOTMUX_GLOBAL_CONFIG_FILE = oldGlobal;
      invalidateGlobalConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('adapts legacy Auto after global changes and leaves explicit models and unsupported launch modes alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-rpc-legacy-'));
    const previous = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(root, 'global.json');
    const descriptor = { larkAppId: 'legacy_auto', cliId: 'traex', model: 'auto',
      traexAutoModel: { enabled: true as const, models: ['first'], queueTimeoutMs: 30_000 } };
    try {
      writeFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE, JSON.stringify({ dashboard: { codexRpcInput: false } }));
      invalidateGlobalConfigCache();
      expect(botDefaultsPayload(descriptor, {})).toMatchObject({ traexAutoModelBlockedReason: null });
      writeFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE, JSON.stringify({ dashboard: { codexRpcInput: true } }));
      invalidateGlobalConfigCache();
      expect(botDefaultsPayload(descriptor, {})).toMatchObject({
        codexRpcInputEffective: false, traexAutoModelBlockedReason: null,
      });
      expect(botDefaultsPayload({ ...descriptor, codexRpcInput: false }, {})).toMatchObject({
        codexRpcInputEffective: false, traexAutoModelBlockedReason: null,
      });
      const loaded = parseBotConfigsFromText(JSON.stringify([
        { ...descriptor, larkAppSecret: 'fixture' },
        { larkAppId: 'off', larkAppSecret: 'fixture', cliId: 'traex', codexRpcInput: false },
        { larkAppId: 'on', larkAppSecret: 'fixture', cliId: 'codex', codexRpcInput: true },
      ]));
      expect(loaded.map(bot => bot.codexRpcInput)).toEqual([undefined, false, true]);
      expect(botDefaultsPayload({ ...descriptor, codexRpcInput: true }, {})).toMatchObject({
        codexRpcInput: true, codexRpcInputEffective: false,
      });
      for (const changed of [{ model: 'first' }, { wrapperCli: 'gateway' }, { cliLaunchMode: 'remote' }]) {
        expect(botDefaultsPayload(descriptor, { ...changed, codexRpcInput: true }).codexRpcInputEffective).toBe(true);
      }
      expect(resolveCodexRpcInput('claude-code', undefined, true)).toBe(false);
      expect(resolveCodexRpcInput('codex', true, true, 'external-server')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE; else process.env.BOTMUX_GLOBAL_CONFIG_FILE = previous;
      invalidateGlobalConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
