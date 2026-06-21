import { describe, expect, it } from 'vitest';
import {
  applyBotConfigEdits,
  assertUniqueBotProcessNames,
  assertOwnerWhenChatGroups,
  botProcessEnv,
  botProcessName,
  findInvalidAllowedUserEntries,
  hasOwnerEntry,
  isValidAllowedUserEntry,
  normalizeBotConfig,
  parseBotConfigsJson,
  parseBotSelection,
  removeBotConfig,
  resolveCliId,
} from '../src/setup/bot-config-editor.js';

describe('botProcessEnv', () => {
  it('keeps valid process env keys and stringifies primitive values', () => {
    expect(botProcessEnv({
      env: {
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        OPENAI_TIMEOUT_MS: 30000,
        FEATURE_FLAG: true,
        EMPTY_VALUE: '',
      },
    })).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      OPENAI_TIMEOUT_MS: '30000',
      FEATURE_FLAG: 'true',
      EMPTY_VALUE: '',
    });
  });

  it('drops invalid keys and non-primitive values', () => {
    expect(botProcessEnv({
      env: {
        '1BAD': 'x',
        'BAD-NAME': 'x',
        OK_NAME: ['x'],
        ALSO_OK: { nested: true },
        NULLISH: null,
        VALID_NAME: false,
      },
    })).toEqual({ VALID_NAME: 'false' });
  });

  it('returns an empty object when env is missing or not an object', () => {
    expect(botProcessEnv({})).toEqual({});
    expect(botProcessEnv({ env: [] })).toEqual({});
    expect(botProcessEnv({ env: 'HTTPS_PROXY=x' })).toEqual({});
  });
});

describe('parseBotSelection', () => {
  const bots = [
    { larkAppId: 'app_a', name: 'claude-main' },
    { larkAppId: 'app_b' },
  ];

  it('rejects bare-digit input now that the list shows no row numbers', () => {
    expect(parseBotSelection('0', bots)).toBeUndefined();
    expect(parseBotSelection('1', bots)).toBeUndefined();
    expect(parseBotSelection('2', bots)).toBeUndefined();
  });

  it('selects by process name', () => {
    expect(parseBotSelection('botmux-1', bots)).toBe(1);
  });

  it('does not select botmux-N when that bot has a custom process name', () => {
    expect(parseBotSelection('botmux-1', [
      { larkAppId: 'app_a', name: 'claude-main' },
      { larkAppId: 'app_b', name: 'codex-main' },
    ])).toBeUndefined();
  });

  it('selects a custom numeric process name even when it belongs to a different index', () => {
    expect(parseBotSelection('botmux-1', [
      { larkAppId: 'app_a', name: '1' },
      { larkAppId: 'app_b', name: 'codex-main' },
    ])).toBe(0);
  });

  it('selects by custom process name', () => {
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
      model: 'sonnet',
      workingDir: '~/old',
      oncallChats: [{ chatId: 'oc_1', workingDir: '~/repo' }],
    }, {
      name: 'codex-main',
      larkAppId: 'new_app',
      larkAppSecret: 'new_secret',
      cliChoice: '4',
      cliPathOverride: '/opt/new/codex',
      model: 'gpt-5-codex',
      workingDir: '~/new',
      allowedUsers: 'alice@example.com,ou_bob',
    });

    expect(updated).toEqual({
      larkAppId: 'new_app',
      name: 'codex-main',
      larkAppSecret: 'new_secret',
      cliId: 'codex',
      cliPathOverride: '/opt/new/codex',
      model: 'gpt-5-codex',
      workingDir: '~/new',
      allowedUsers: ['alice@example.com', 'ou_bob'],
      oncallChats: [{ chatId: 'oc_1', workingDir: '~/repo' }],
    });
  });

  it('sets wrapperCli (aiden gateway) and clears it when switching to a plain CLI', () => {
    const gateway = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
    }, {
      cliChoice: 'claude-code',
      wrapperCli: 'aiden x claude',
    });
    expect(gateway.cliId).toBe('claude-code');
    expect(gateway.wrapperCli).toBe('aiden x claude');

    // Switching to a plain CLI passes wrapperCli: null → the stale prefix is dropped.
    const plain = applyBotConfigEdits(gateway, { cliChoice: '4', wrapperCli: null });
    expect(plain.cliId).toBe('codex');
    expect(plain.wrapperCli).toBeUndefined();
  });

  it('leaves wrapperCli untouched when the field is undefined', () => {
    const out = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      wrapperCli: 'aiden x claude',
    }, { workingDir: '~/x' });
    expect(out.wrapperCli).toBe('aiden x claude');
  });

  it('edits and clears allowedChatGroups', () => {
    const edited = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedChatGroups: ['oc_old'],
    }, {
      allowedChatGroups: 'oc_team, oc_project',
    });
    expect(edited.allowedChatGroups).toEqual(['oc_team', 'oc_project']);

    const cleared = applyBotConfigEdits(edited, { allowedChatGroups: '-' });
    expect(cleared.allowedChatGroups).toBeUndefined();
  });

  it('rejects bare email prefixes in allowedUsers (only full email or ou_ accepted)', () => {
    expect(() => applyBotConfigEdits({
      larkAppId: 'app', larkAppSecret: 'secret', cliId: 'claude-code',
    }, { allowedUsers: 'alice' })).toThrow(/完整邮箱|open_id/);

    expect(() => applyBotConfigEdits({
      larkAppId: 'app', larkAppSecret: 'secret', cliId: 'claude-code',
    }, { allowedUsers: 'ou_abc, bob' })).toThrow(/bob/);
  });

  it('accepts full emails and open_ids in allowedUsers', () => {
    const edited = applyBotConfigEdits({
      larkAppId: 'app', larkAppSecret: 'secret', cliId: 'claude-code',
    }, { allowedUsers: 'alice@example.com, ou_abc' });
    expect(edited.allowedUsers).toEqual(['alice@example.com', 'ou_abc']);
  });

  it('keeps fields unchanged on empty input and clears optional fields with dash', () => {
    const updated = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      name: 'old-name',
      cliPathOverride: '/opt/legacy/claude',
      model: 'opus',
      backendType: 'tmux',
      allowedUsers: ['alice'],
    }, {
      larkAppId: '',
      larkAppSecret: '',
      cliChoice: '',
      name: '-',
      cliPathOverride: '-',
      model: '-',
      backendType: '-',
      allowedUsers: '-',
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

  it('accepts cliChoice as a literal cliId', () => {
    const updated = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
    }, { cliChoice: 'codex' });

    expect(updated.cliId).toBe('codex');
  });

  it('trims and clears the optional model field', () => {
    const updated = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
    }, { model: '  opus  ' });
    expect(updated.model).toBe('opus');

    const cleared = applyBotConfigEdits(updated, { model: '-' });
    expect(cleared.model).toBeUndefined();
  });

  // 防回归：cli.ts 的 promptEditBotConfig 在切换 CLI 时会把 input.model 设成
  // null 强制清空旧 model — 这里只测 applyBotConfigEdits 把 null 解释为
  // "删字段"的契约，覆盖"切 CLI 后旧 model 残留"边界。
  it('input.model === null clears the field even when cliChoice also changes', () => {
    const updated = applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      model: 'opus',
    }, { cliChoice: 'aiden', model: null });
    expect(updated.cliId).toBe('aiden');
    expect(updated.model).toBeUndefined();
  });

  it('rejects unknown cliChoice instead of silently storing typos', () => {
    expect(() => applyBotConfigEdits({
      larkAppId: 'app',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
    }, { cliChoice: 'claud-code' })).toThrow(/Unknown CLI 适配器 "claud-code"/);
  });
});

describe('resolveCliId', () => {
  it('returns undefined for empty input so callers can preserve current cliId', () => {
    expect(resolveCliId('')).toBeUndefined();
    expect(resolveCliId('   ')).toBeUndefined();
    expect(resolveCliId(undefined)).toBeUndefined();
  });

  it('maps setup menu indices to cliIds', () => {
    expect(resolveCliId('1')).toBe('claude-code');
    expect(resolveCliId('4')).toBe('codex');
    expect(resolveCliId('7')).toBe('opencode');
    expect(resolveCliId('9')).toBe('mtr');
    expect(resolveCliId('10')).toBe('hermes');
    expect(resolveCliId('11')).toBe('codex-app');
    expect(resolveCliId('12')).toBe('mira');
    expect(resolveCliId('13')).toBe('seed');
    expect(resolveCliId('14')).toBe('traex');
    expect(resolveCliId('15')).toBe('pi');
    expect(resolveCliId('16')).toBe('copilot');
  });

  it('passes through literal cliIds unchanged', () => {
    expect(resolveCliId('codex')).toBe('codex');
    expect(resolveCliId('codex-app')).toBe('codex-app');
    expect(resolveCliId('opencode')).toBe('opencode');
    expect(resolveCliId('mtr')).toBe('mtr');
    expect(resolveCliId('hermes')).toBe('hermes');
    expect(resolveCliId('mira')).toBe('mira');
    expect(resolveCliId('pi')).toBe('pi');
    expect(resolveCliId('copilot')).toBe('copilot');
  });

  it('throws on typos so they do not leak into bots.json', () => {
    expect(() => resolveCliId('claud-code')).toThrow(/Unknown CLI 适配器 "claud-code"/);
    expect(() => resolveCliId('99')).toThrow(/Unknown CLI 适配器 "99"/);
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
    ])).toThrow(/botmux-Codex-Main.*第 1 条和第 2 条重复/);
  });

  it('rejects collisions between custom numeric names and unnamed index names', () => {
    expect(() => assertUniqueBotProcessNames([
      { larkAppId: 'app_a', name: '1' },
      { larkAppId: 'app_b' },
    ])).toThrow(/botmux-1.*第 1 条和第 2 条重复/);
  });

  it('rejects the reserved dashboard process name', () => {
    expect(() => assertUniqueBotProcessNames([
      { larkAppId: 'app_a', name: 'dashboard' },
    ])).toThrow(/botmux-dashboard.*保留名/);
  });

  it('allows unique process names', () => {
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

  it('allows removing the final bot config by process name', () => {
    const result = removeBotConfig([{ larkAppId: 'app_a' }], 'botmux-0');

    expect(result).toEqual({
      index: 0,
      removed: { larkAppId: 'app_a' },
      bots: [],
    });
  });
});

describe('allowedUsers entry validation', () => {
  it('isValidAllowedUserEntry accepts ou_ open_ids and full emails, rejects prefixes', () => {
    expect(isValidAllowedUserEntry('ou_abc123')).toBe(true);
    expect(isValidAllowedUserEntry('alice@example.com')).toBe(true);
    expect(isValidAllowedUserEntry('alice')).toBe(false);
    expect(isValidAllowedUserEntry('alice@company')).toBe(false); // no TLD
    expect(isValidAllowedUserEntry('')).toBe(false);
  });

  it('findInvalidAllowedUserEntries surfaces only the bad entries', () => {
    expect(findInvalidAllowedUserEntries(['ou_a', 'alice@example.com', 'bob', 'carol']))
      .toEqual(['bob', 'carol']);
    expect(findInvalidAllowedUserEntries(['ou_a', 'alice@example.com'])).toEqual([]);
  });

  it('hasOwnerEntry is true only when an ou_/email entry exists', () => {
    expect(hasOwnerEntry(['ou_a'])).toBe(true);
    expect(hasOwnerEntry(['alice@example.com'])).toBe(true);
    expect(hasOwnerEntry(['alice'])).toBe(false);
    expect(hasOwnerEntry([])).toBe(false);
    expect(hasOwnerEntry(undefined)).toBe(false);
  });
});

describe('assertOwnerWhenChatGroups', () => {
  it('throws when allowedChatGroups is set but no owner in allowedUsers', () => {
    expect(() => assertOwnerWhenChatGroups({ allowedChatGroups: ['oc_team'] }))
      .toThrow(/owner/);
    expect(() => assertOwnerWhenChatGroups({ allowedChatGroups: ['oc_team'], allowedUsers: [] }))
      .toThrow(/owner/);
  });

  it('passes when an owner exists or no chat groups configured', () => {
    expect(() => assertOwnerWhenChatGroups({ allowedChatGroups: ['oc_team'], allowedUsers: ['ou_admin'] }))
      .not.toThrow();
    expect(() => assertOwnerWhenChatGroups({ allowedChatGroups: ['oc_team'], allowedUsers: ['admin@example.com'] }))
      .not.toThrow();
    expect(() => assertOwnerWhenChatGroups({})).not.toThrow();
    expect(() => assertOwnerWhenChatGroups({ allowedUsers: [] })).not.toThrow();
  });
});
