import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  normalizeBotActorOwnerBindings,
  readCanonicalBotActorOwnerBindings,
} from '../src/core/bot-actor-owner-binding.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { coerceConfigValue, findConfigField } from '../src/services/bot-config-store.js';

const binding = {
  sourceBotOpenId: 'ou_source',
  sourceBotUnionId: 'on_source',
  ownerUnionId: 'on_owner',
  ownerEmail: 'owner@bytedance.com',
};

describe('botActorOwnerBindings', () => {
  it('parses an exact binding into the target Bot config', () => {
    expect(normalizeBotActorOwnerBindings([binding])).toEqual([binding]);
    const [config] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_target',
      larkAppSecret: 'secret',
      cliId: 'codex',
      botActorOwnerBindings: [binding],
    }]));
    expect(config?.botActorOwnerBindings).toEqual([binding]);
  });

  it('uses the same strict parser on the audited hot-update path', () => {
    const spec = findConfigField('botActorOwnerBindings');
    expect(spec).toBeDefined();
    expect(coerceConfigValue(spec!, JSON.stringify([binding])))
      .toEqual({ ok: true, value: [binding] });
    expect(coerceConfigValue(spec!, JSON.stringify([{ ...binding, extra: 'forged' }])))
      .toEqual({ ok: false, reason: 'invalid_json' });
  });

  it.each([
    [{ ...binding, ownerEmail: 'OWNER@BYTEDANCE.COM' }, 'canonical lowercase email'],
    [{ ...binding, sourceBotOpenId: 'on_wrong_kind' }, 'sourceBotOpenId is invalid'],
    [{ ...binding, sourceBotUnionId: 'ou_wrong_kind' }, 'sourceBotUnionId is invalid'],
    [{ ...binding, ownerUnionId: 'ou_wrong_kind' }, 'ownerUnionId is invalid'],
    [{ ...binding, extra: 'forged' }, 'must contain exactly'],
  ])('rejects malformed security input %#', (invalid, message) => {
    expect(() => normalizeBotActorOwnerBindings([invalid]))
      .toThrow(message);
  });

  it('rejects conflicting aliases instead of choosing by order', () => {
    expect(() => normalizeBotActorOwnerBindings([
      binding,
      { ...binding, sourceBotOpenId: 'ou_other', ownerUnionId: 'on_other' },
    ])).toThrow(/duplicates a source Bot identity/);
    expect(() => normalizeBotActorOwnerBindings([
      binding,
      { ...binding, sourceBotUnionId: 'on_other', ownerUnionId: 'on_other' },
    ])).toThrow(/duplicates a source Bot identity/);
  });

  it('treats an absent or empty policy as disabled', () => {
    expect(normalizeBotActorOwnerBindings(undefined)).toBeUndefined();
    expect(normalizeBotActorOwnerBindings([])).toBeUndefined();
  });

  it('treats a hand-written JSON null as disabled instead of rejecting startup', () => {
    expect(normalizeBotActorOwnerBindings(null)).toBeUndefined();
    // The fleet-startup path parses the whole bots.json top level: a null
    // spelling on any one Bot must not throw and take every daemon down.
    const multi = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_other', larkAppSecret: 's', cliId: 'codex' },
      { larkAppId: 'cli_target', larkAppSecret: 's', cliId: 'codex', botActorOwnerBindings: null },
    ]));
    expect(multi).toHaveLength(2);
    expect(multi[1]?.botActorOwnerBindings).toBeUndefined();
    const [single] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_target',
      larkAppSecret: 'secret',
      cliId: 'codex',
      botActorOwnerBindings: null,
    }]));
    expect(single?.botActorOwnerBindings).toBeUndefined();
  });

  it('re-reads the canonical target policy on every call instead of caching one Pod snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'botmux-owner-bindings-'));
    const configPath = join(dir, 'bots.json');
    try {
      await writeFile(configPath, JSON.stringify([{
        larkAppId: 'cli_target',
        botActorOwnerBindings: [{ ...binding, sourceBotOpenId: 'ou_old' }],
      }]));
      await expect(readCanonicalBotActorOwnerBindings(configPath, 'cli_target'))
        .resolves.toEqual({
          ok: true,
          bindings: [{ ...binding, sourceBotOpenId: 'ou_old' }],
        });

      await writeFile(configPath, JSON.stringify([{
        larkAppId: 'cli_target',
        botActorOwnerBindings: [{ ...binding, sourceBotOpenId: 'ou_new' }],
      }]));
      await expect(readCanonicalBotActorOwnerBindings(configPath, 'cli_target'))
        .resolves.toEqual({
          ok: true,
          bindings: [{ ...binding, sourceBotOpenId: 'ou_new' }],
        });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [undefined, 'config_path_unavailable'],
    ['missing.json', 'config_read_failed'],
  ] as const)('fails closed when canonical config is unavailable (%s)', async (path, reason) => {
    await expect(readCanonicalBotActorOwnerBindings(path, 'cli_target'))
      .resolves.toEqual({ ok: false, reason });
  });

  it('fails closed on invalid JSON, duplicate target rows, and malformed bindings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'botmux-owner-bindings-invalid-'));
    const configPath = join(dir, 'bots.json');
    try {
      await writeFile(configPath, '{');
      await expect(readCanonicalBotActorOwnerBindings(configPath, 'cli_target'))
        .resolves.toEqual({ ok: false, reason: 'config_invalid_json' });

      await writeFile(configPath, JSON.stringify([
        { larkAppId: 'cli_target', botActorOwnerBindings: [binding] },
        { larkAppId: 'cli_target', botActorOwnerBindings: [binding] },
      ]));
      await expect(readCanonicalBotActorOwnerBindings(configPath, 'cli_target'))
        .resolves.toEqual({ ok: false, reason: 'target_ambiguous' });

      await writeFile(configPath, JSON.stringify([{
        larkAppId: 'cli_target',
        botActorOwnerBindings: [{ ...binding, source: 'forged' }],
      }]));
      await expect(readCanonicalBotActorOwnerBindings(configPath, 'cli_target'))
        .resolves.toEqual({ ok: false, reason: 'bindings_invalid' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
