import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBotConfigAtIndex, loadBotConfigs, parseBotConfigsFromText } from '../src/bot-registry.js';
import { resolveFleetBotsFromEntries } from '../src/core/fleet-runtime.js';
import { resolveCliId } from '../src/setup/bot-config-editor.js';
import { findRetiredCliBots, retiredCliNotice } from '../src/adapters/cli/retired-cli.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';

// A bots.json written before the Gemini CLI adapter was removed: one row still
// on gemini (with the Gemini-only wrapper and model), between two live bots.
const ROWS = [
  { larkAppId: 'cli_before', larkAppSecret: 's1', cliId: 'claude-code' },
  { larkAppId: 'cli_gemini', larkAppSecret: 's2', name: 'Gem', cliId: 'gemini', model: 'gemini-2.5-pro', wrapperCli: 'ttadk gemini' },
  { larkAppId: 'cli_after', larkAppSecret: 's3', cliId: 'antigravity' },
];

describe('bots.json rows on a removed CLI (gemini)', () => {
  let dir: string;
  let prevBotsConfig: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retired-cli-'));
    writeFileSync(join(dir, 'bots.json'), JSON.stringify(ROWS));
    prevBotsConfig = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = join(dir, 'bots.json');
  });
  afterEach(() => {
    if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = prevBotsConfig;
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads every other Bot and leaves the gemini row out instead of failing the whole file', () => {
    expect(parseBotConfigsFromText(JSON.stringify(ROWS)).map(bot => bot.larkAppId)).toEqual(['cli_before', 'cli_after']);
    expect(loadBotConfigs().map(bot => bot.cliId)).toEqual(['claude-code', 'antigravity']);
  });

  it('the daemon for the gemini slot refuses with the migration notice; neighbours keep their slots', () => {
    expect(() => loadBotConfigAtIndex(1)).toThrow(/Gemini CLI.*已移除.*"antigravity"/);
    expect(loadBotConfigAtIndex(0).larkAppId).toBe('cli_before');
    expect(loadBotConfigAtIndex(2).larkAppId).toBe('cli_after');
  });

  it('the fleet does not start the gemini Bot and keeps raw indexes for the rest', () => {
    expect(resolveFleetBotsFromEntries(ROWS).map(spec => [spec.appId, spec.botIndex])).toEqual([
      ['cli_before', 0],
      ['cli_after', 2],
    ]);
  });

  it('start/restart and the Dashboard find the row with its raw index and a readable label', () => {
    expect(findRetiredCliBots(ROWS)).toEqual([{ index: 1, appId: 'cli_gemini', cliId: 'gemini', label: 'Gem（cli_gemini）' }]);
    const notice = retiredCliNotice('gemini', 'Gem（cli_gemini）');
    expect(notice).toContain('Gem（cli_gemini）');
    expect(notice).toContain('"antigravity"');
    expect(notice).toContain('botmux restart');
    expect(retiredCliNotice('antigravity')).toBe('');
  });

  it('setup rejects gemini and its old menu number instead of picking another CLI', () => {
    expect(() => resolveCliId('gemini')).toThrow(/Gemini CLI/);
    expect(() => resolveCliId('6')).toThrow(/Gemini CLI/);
    expect(resolveCliId('5')).toBe('cursor');
    expect(resolveCliId('7')).toBe('opencode');
    expect(resolveCliId('8')).toBe('antigravity');
  });

  it('a session persisted on gemini (e.g. after `/cli gemini`) fails with the notice, not a bare unknown adapter', () => {
    expect(() => createCliAdapterSync('gemini' as CliId)).toThrow(/Gemini CLI.*"antigravity"/);
    expect(() => createCliAdapterSync('no-such-cli' as CliId)).toThrow(/Unknown CLI adapter/);
  });
});
