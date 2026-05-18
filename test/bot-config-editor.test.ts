import { describe, expect, it } from 'vitest';
import {
  applyBotConfigEdits,
  assertUniqueBotProcessNames,
  botProcessName,
  normalizeBotConfig,
  parseBotConfigsJson,
  parseBotSelection,
  removeBotConfig,
} from '../src/setup/bot-config-editor.js';

describe('parseBotSelection', () => {
  const bots = [
    { larkAppId: 'app_a', name: 'claude-main' },
    { larkAppId: 'app_b' },
  ];

  it('selects by one-based setup index', () => {
    expect(parseBotSelection('2', bots)).toBe(1);
  });

  it('selects by pm2 status name', () => {
    expect(parseBotSelection('botmux-1', bots)).toBe(1);
  });

  it('does not select botmux-N when that bot has a custom pm2 status name', () => {
    expect(parseBotSelection('botmux-1', [
      { larkAppId: 'app_a', name: 'claude-main' },
      { larkAppId: 'app_b', name: 'codex-main' },
    ])).toBeUndefined();
  });

  it('selects a custom numeric pm2 status name even when it belongs to a different index', () => {
    expect(parseBotSelection('botmux-1', [
      { larkAppId: 'app_a', name: '1' },
      { larkAppId: 'app_b', name: 'codex-main' },
    ])).toBe(0);
  });

  it('selects by custom pm2 status name', () => {
    expect(parseBotSelection('botmux-claude-main', bots)).toBe(0);
  });

  it('selects by app id', () => {
    expect(parseBotSelection('app_b', bots)).toBe(1);
  });

  it('rejects unknown selections', () => {
    expect(parseBotSelection('botmux-9', bots)).toBeUndefined();
    expect(parseBotSelection('missing', bots)).toBeUndefined();
  });
});

describe('applyBotConfigEdits', () => {
  it('normalizes the custom bot status name', () => {
    expect(botProcessName({ name: 'botmux-Codex Main' }, 0)).toBe('botmux-Codex-Main');
    expect(botProcessName({ name: '中文 名称' }, 1)).toBe('botmux-中文-名称');
    expect(botProcessName({}, 2)).toBe('botmux-2');
  });

  it('updates existing bot fields and preserves unrelated config', () => {
    const updated = applyBotConfigEdits({
      larkAppId: 'old_app',
      larkAppSecret: 'old_secret',
      cliId: 'claude-code',
      cliPathOverride: '/opt/old/claude',
      workingDir: '~/old',
      oncallChats: [{ chatId: 'oc_1', workingDir: '~/repo' }],
    }, {
      name: 'codex-main',
      larkAppId: 'new_app',
      larkAppSecret: 'new_secret',
      cliChoice: '4',
      cliPathOverride: '/opt/new/codex',
      workingDir: '~/new',
      allowedUsers: 'alice,bob',
    });

    expect(updated).toEqual({
      larkAppId: 'new_app',
      name: 'codex-main',
      larkAppSecret: 'new_secret',
      cliId: 'codex',
      cliPathOverride: '/opt/new/codex',
      workingDir: '~/new',
      allowedUsers: ['alice', 'bob'],
      oncallChats: [{ chatId: 'oc_1', workingDir: '~/repo' }],
    });
  });

  it('keeps fields unchanged on empty input and clears optional fields with dash', () => {
    const updated = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      name: 'old-name',
      cliPathOverride: '/opt/legacy/claude',
      backendType: 'tmux',
      allowedUsers: ['alice'],
      projectScanDir: '~/repos',
    }, {
      larkAppId: '',
      larkAppSecret: '',
      cliChoice: '',
      name: '-',
      cliPathOverride: '-',
      backendType: '-',
      allowedUsers: '-',
      projectScanDir: '-',
    });

    expect(updated).toEqual({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
    });
  });

  it('normalizes an existing custom name when editing other fields', () => {
    const updated = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      name: 'Codex Main',
      workingDir: '~/old',
    }, {
      workingDir: '~/new',
    });

    expect(updated).toEqual({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      name: 'Codex-Main',
      workingDir: '~/new',
    });
  });
});

describe('normalizeBotConfig', () => {
  it('normalizes custom names before add or reconfigure writes bots.json', () => {
    expect(normalizeBotConfig({
      larkAppId: 'app',
      name: 'Codex Main',
    })).toEqual({
      larkAppId: 'app',
      name: 'Codex-Main',
    });
  });

  it('drops custom names that normalize to empty', () => {
    expect(normalizeBotConfig({
      larkAppId: 'app',
      name: '...',
    })).toEqual({
      larkAppId: 'app',
    });
  });
});

describe('parseBotConfigsJson', () => {
  it('parses a valid bots.json array', () => {
    expect(parseBotConfigsJson('[{"larkAppId":"app"}]', '/tmp/bots.json')).toEqual([
      { larkAppId: 'app' },
    ]);
  });

  it('throws a clear error for invalid JSON', () => {
    expect(() => parseBotConfigsJson('{bad json', '/tmp/bots.json'))
      .toThrow(/Failed to parse \/tmp\/bots\.json/);
  });

  it('throws a clear error when bots.json is not an array', () => {
    expect(() => parseBotConfigsJson('{"larkAppId":"app"}', '/tmp/bots.json'))
      .toThrow(/must contain a JSON array/);
  });
});

describe('assertUniqueBotProcessNames', () => {
  it('rejects duplicate names after normalization', () => {
    expect(() => assertUniqueBotProcessNames([
      { larkAppId: 'app_a', name: 'Codex Main' },
      { larkAppId: 'app_b', name: 'Codex-Main' },
    ])).toThrow(/botmux-Codex-Main.*entries 1 and 2/);
  });

  it('rejects collisions between custom numeric names and unnamed index names', () => {
    expect(() => assertUniqueBotProcessNames([
      { larkAppId: 'app_a', name: '1' },
      { larkAppId: 'app_b' },
    ])).toThrow(/botmux-1.*entries 1 and 2/);
  });

  it('rejects the reserved dashboard pm2 process name', () => {
    expect(() => assertUniqueBotProcessNames([
      { larkAppId: 'app_a', name: 'dashboard' },
    ])).toThrow(/botmux-dashboard.*reserved/);
  });

  it('allows unique pm2 process names', () => {
    expect(() => assertUniqueBotProcessNames([
      { larkAppId: 'app_a', name: 'claude-main' },
      { larkAppId: 'app_b' },
    ])).not.toThrow();
  });
});

describe('removeBotConfig', () => {
  it('removes the selected bot without mutating the original list', () => {
    const bots = [
      { larkAppId: 'app_a', name: 'claude-main' },
      { larkAppId: 'app_b', name: 'codex-main' },
      { larkAppId: 'app_c' },
    ];

    const result = removeBotConfig(bots, 'botmux-codex-main');

    expect(result).toEqual({
      index: 1,
      removed: { larkAppId: 'app_b', name: 'codex-main' },
      bots: [
        { larkAppId: 'app_a', name: 'claude-main' },
        { larkAppId: 'app_c' },
      ],
    });
    expect(bots).toHaveLength(3);
  });

  it('returns undefined for an unknown selection', () => {
    expect(removeBotConfig([{ larkAppId: 'app_a' }], 'missing')).toBeUndefined();
  });

  it('allows removing the final bot config', () => {
    const result = removeBotConfig([{ larkAppId: 'app_a' }], '1');

    expect(result).toEqual({
      index: 0,
      removed: { larkAppId: 'app_a' },
      bots: [],
    });
  });
});
