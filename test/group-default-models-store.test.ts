import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dir: string;
let configPath: string;
let previousConfig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-group-models-'));
  configPath = join(dir, 'bots.json');
  previousConfig = process.env.BOTS_CONFIG;
  process.env.BOTS_CONFIG = configPath;
  writeFileSync(configPath, JSON.stringify([
    { larkAppId: 'app-a', larkAppSecret: 'test-secret', cliId: 'codex', model: 'global', groupDefaultModels: { oc_existing: { codex: 'existing' } } },
    { larkAppId: 'app-b', larkAppSecret: 'test-secret', cliId: 'claude-code' },
  ]));
});
afterEach(() => {
  if (previousConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = previousConfig;
  rmSync(dir, { recursive: true, force: true });
});

it('persists per-bot/per-group changes, reloads them, and clears without affecting other groups', async () => {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const { setGroupDefaultModels } = await import('../src/services/group-default-models-store.js');
  registry.loadBotConfigs().forEach(cfg => registry.registerBot(cfg));
  await Promise.all([
    setGroupDefaultModels('app-a', 'oc_a', { codex: 'model-a', 'claude-code': 'sonnet' }),
    setGroupDefaultModels('app-a', 'oc_b', { codex: 'model-b' }),
    setGroupDefaultModels('app-b', 'oc_a', { 'claude-code': 'opus' }),
  ]);
  const disk = () => JSON.parse(readFileSync(configPath, 'utf8'));
  expect(registry.getBot('app-a').config.groupDefaultModels).toEqual(disk()[0].groupDefaultModels);
  expect(registry.loadBotConfigs()[0].groupDefaultModels).toEqual(disk()[0].groupDefaultModels);
  expect(disk()[0].groupDefaultModels.oc_existing).toEqual({ codex: 'existing' });
  expect(disk()[1].groupDefaultModels.oc_a).toEqual({ 'claude-code': 'opus' });
  await setGroupDefaultModels('app-a', 'oc_a', { codex: '', 'claude-code': '' });
  expect(disk()[0].groupDefaultModels.oc_a).toBeUndefined();
  expect(disk()[0].groupDefaultModels.oc_b).toEqual({ codex: 'model-b' });
  expect(disk()[0].model).toBe('global');
  await expect(setGroupDefaultModels('app-a', 'oc_a', {codex:{model:'gpt-5.6-sol',reasoningEffort:'ultra'}})).resolves.toMatchObject({ok:true});
  expect(registry.getBot('app-a').config.cliId).toBe('codex');
  await expect(setGroupDefaultModels('app-b', 'oc_a', {'claude-code':{model:'haiku',reasoningEffort:'high'}})).resolves.toEqual({ok:false,reason:'unsupported_reasoning_effort'});
  const before = readFileSync(configPath, 'utf8');
  await expect(setGroupDefaultModels('app-a', 'oc_b', { codex: 123 })).rejects.toThrow();
  expect(readFileSync(configPath, 'utf8')).toBe(before);
});
