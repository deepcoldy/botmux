import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { normalizeGroupSerialInput, parseGroupSerialInput } from '../src/core/group-serial-input.js';

it('rejects malformed writes and ignores malformed hand-edited settings', () => {
  for (const value of [null, [], true, {}, {enabled:'true'}, {enabled:1}]) {
    expect(() => parseGroupSerialInput(value)).toThrow('enabled_must_be_boolean');
  }
  expect(parseGroupSerialInput({enabled:false})).toBe(false);
  expect(normalizeGroupSerialInput({oc_a:true, oc_b:false, oc_c:'true', bad:true})).toEqual({oc_a:true,oc_b:false});
});

it('serializes writes, preserves other settings and restores exact per-bot/group switches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'group-serial-'));
  const configPath = join(dir, 'bots.json');
  const previous = process.env.BOTS_CONFIG;
  process.env.BOTS_CONFIG = configPath;
  try {
    writeFileSync(configPath, JSON.stringify([
      {larkAppId:'app-a',larkAppSecret:'test',cliId:'codex',groupSerialInput:{oc_existing:true},groupDefaultModels:{oc_a:{codex:'custom'}}},
      {larkAppId:'app-b',larkAppSecret:'test',cliId:'codex'},
    ]));
    vi.resetModules();
    const registry = await import('../src/bot-registry.js');
    const {setGroupSerialInput} = await import('../src/services/group-serial-input-store.js');
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    await Promise.all([
      setGroupSerialInput('app-a','oc_a',true), setGroupSerialInput('app-a','oc_b',true),
      setGroupSerialInput('app-b','oc_a',true), setGroupSerialInput('app-a','oc_a',false),
    ]);
    const disk = () => JSON.parse(readFileSync(configPath,'utf8'));
    expect(disk()[0].groupSerialInput).toEqual({oc_existing:true,oc_a:false,oc_b:true});
    expect(disk()[1].groupSerialInput).toEqual({oc_a:true});
    expect(disk()[0].groupDefaultModels).toEqual({oc_a:{codex:'custom'}});
    expect(registry.getBot('app-a').config.groupSerialInput).toEqual(disk()[0].groupSerialInput);
    expect(registry.loadBotConfigs()[0].groupSerialInput).toEqual(disk()[0].groupSerialInput);
    const before = readFileSync(configPath,'utf8');
    await expect(setGroupSerialInput('app-a','not_a_chat',true)).rejects.toThrow('invalid_chat_id');
    await expect(setGroupSerialInput('app-a','oc_a','true' as any)).rejects.toThrow('enabled_must_be_boolean');
    expect(readFileSync(configPath,'utf8')).toBe(before);
  } finally {
    if (previous === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = previous;
    rmSync(dir,{recursive:true,force:true});
  }
});
