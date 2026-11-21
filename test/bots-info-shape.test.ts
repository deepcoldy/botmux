import { describe, expect, it } from 'vitest';
import {
  botsInfoObjectEntries,
  isBotsInfoNameEntry,
  isBotsInfoRouteEntry,
  normalizeBotsInfoRouteEntries,
} from '../src/services/bots-info-shape.js';

describe('bots-info runtime shapes', () => {
  it('drops null, scalar and array rows before any reader touches fields', () => {
    const valid = { larkAppId: 'cli_valid', botName: 'Valid' };
    expect(botsInfoObjectEntries([null, 42, 'x', true, [], valid])).toEqual([valid]);
  });

  it.each([42, {}, true])('rejects truthy non-string botName values: %j', botName => {
    const entry = botsInfoObjectEntries([{ larkAppId: 'cli_bad', botName }])[0];
    expect(isBotsInfoNameEntry(entry)).toBe(false);
    expect(isBotsInfoRouteEntry(entry)).toBe(false);
  });

  it('keeps name-only rows in the wide contract but not the routing contract', () => {
    const [nameOnly] = botsInfoObjectEntries([{ botName: 'NameOnly' }]);
    expect(isBotsInfoNameEntry(nameOnly)).toBe(true);
    expect(isBotsInfoRouteEntry(nameOnly)).toBe(false);
  });

  it('requires a non-empty app id and rejects only truthy non-string names for routing rows', () => {
    const entries = botsInfoObjectEntries([
      { larkAppId: '', botName: 'Empty App' },
      { larkAppId: '   ', botName: 'Blank App' },
      { larkAppId: 'cli_missing_name' },
      { larkAppId: 'cli_null_name', botName: null },
      { larkAppId: 'cli_named', botName: 'Named' },
    ]);
    expect(entries.filter(isBotsInfoRouteEntry)).toEqual([
      { larkAppId: 'cli_missing_name' },
      { larkAppId: 'cli_null_name', botName: null },
      { larkAppId: 'cli_named', botName: 'Named' },
    ]);
  });

  it('normalizes optional route fields without dropping later valid rows', () => {
    expect(normalizeBotsInfoRouteEntries([
      null,
      { larkAppId: 'cli_bad_name', botName: 42, botOpenId: 'ou_bad' },
      {
        larkAppId: 'cli_valid',
        botOpenId: 7,
        botName: 'Valid',
        botAvatarUrl: {},
        cliId: ['codex'],
      },
      {
        larkAppId: 'cli_complete',
        botOpenId: 'ou_complete',
        botName: null,
        botAvatarUrl: 'https://example.com/avatar.png',
        cliId: 'codex',
      },
    ])).toEqual([
      {
        larkAppId: 'cli_valid',
        botOpenId: null,
        botName: 'Valid',
        botAvatarUrl: null,
        cliId: null,
      },
      {
        larkAppId: 'cli_complete',
        botOpenId: 'ou_complete',
        botName: null,
        botAvatarUrl: 'https://example.com/avatar.png',
        cliId: 'codex',
      },
    ]);
  });
});
