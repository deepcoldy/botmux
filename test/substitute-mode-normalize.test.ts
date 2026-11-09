import { describe, expect, it, vi } from 'vitest';
import { normalizeSubstituteMode } from '../src/services/substitute-mode-normalize.js';

describe('normalizeSubstituteMode', () => {
  it('trims keyword strings, removes empty/invalid entries and deduplicates ignoring case', () => {
    expect(normalizeSubstituteMode({
      enabled: false, targets: [{ openId: 'ou_sub' }],
      keywords: [' 独立卡 ', '', '  ', 'Oncall', 'oncall', '独立卡', null, 42],
    })).toMatchObject({ enabled: false, keywords: ['独立卡', 'oncall'] });
  });

  it.each([undefined, [' ', null], 'incident'])('omits empty or invalid keywords: %j', keywords => {
    expect(normalizeSubstituteMode({
      enabled: true, targets: [{ openId: 'ou_sub' }], keywords,
    })).not.toHaveProperty('keywords');
  });

  it('omits keywords when the value is an empty array', () => {
    expect(normalizeSubstituteMode({
      enabled: true, targets: [{ openId: 'ou_sub' }], keywords: [],
    })).not.toHaveProperty('keywords');
  });

  it('returns undefined for empty / non-object inputs', () => {
    expect(normalizeSubstituteMode(undefined)).toBeUndefined();
    expect(normalizeSubstituteMode(null)).toBeUndefined();
    expect(normalizeSubstituteMode([])).toBeUndefined();
    expect(normalizeSubstituteMode('')).toBeUndefined();
  });

  it('normalizes and deduplicates the chats whitelist', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      disclosure: 'prefix',
      chats: ['oc_a', ' oc_b ', '', 'oc_a', 'oc_b'],
    });
    expect(cfg).toMatchObject({
      enabled: true,
      disclosure: 'prefix',
      targets: [{ openId: 'ou_alice' }],
      chats: ['oc_a', 'oc_b'],
    });
  });

  it('omits chats when the list is empty', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      chats: [],
    });
    expect(cfg).not.toHaveProperty('chats');
  });

  it('omits chats when not an array', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      chats: 'oc_a',
    });
    expect(cfg).not.toHaveProperty('chats');
  });

  it('normalizes and deduplicates the excludedChats blocklist', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      excludedChats: ['oc_x', ' oc_y ', '', 'oc_x', 'oc_y'],
    });
    expect(cfg).toMatchObject({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      excludedChats: ['oc_x', 'oc_y'],
    });
  });

  it('omits excludedChats when the list is empty', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      excludedChats: [],
    });
    expect(cfg).not.toHaveProperty('excludedChats');
  });

  it('omits excludedChats when not an array', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      excludedChats: 'oc_x',
    });
    expect(cfg).not.toHaveProperty('excludedChats');
  });

  it('keeps excludedChats on a disabled config with targets', () => {
    const cfg = normalizeSubstituteMode({
      enabled: false,
      targets: [{ openId: 'ou_alice' }],
      excludedChats: ['oc_x'],
    });
    expect(cfg).toMatchObject({ enabled: false, excludedChats: ['oc_x'] });
  });

  it('defaults replyMode to thread and omits it from output', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
    });
    expect(cfg).toMatchObject({ enabled: true, targets: [{ openId: 'ou_alice' }] });
    expect(cfg).not.toHaveProperty('replyMode');
  });

  it('preserves replyMode=quote', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      replyMode: 'quote',
    });
    expect(cfg).toMatchObject({ enabled: true, replyMode: 'quote' });
  });

  it('coerces invalid replyMode to thread', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      replyMode: 'invalid',
    });
    expect(cfg).not.toHaveProperty('replyMode');
  });

  it('omits disableControlCard when false or undefined', () => {
    const cfg1 = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], disableControlCard: false });
    expect(cfg1).not.toHaveProperty('disableControlCard');
    const cfg2 = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }] });
    expect(cfg2).not.toHaveProperty('disableControlCard');
  });

  it('preserves disableControlCard when true', () => {
    const cfg = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], disableControlCard: true });
    expect(cfg).toMatchObject({ enabled: true, disableControlCard: true });
  });
});

describe('App ID configuration reload', () => {
  it('retains the App ID alone and never carries a stale Open ID or bot chat scope', () => {
    const cfg = normalizeSubstituteMode({ enabled: true, targets: [{ appId: ' cli_external ', openId: 'ou_stale', botChatId: 'oc_old', userId: 'u_old' }] });
    expect(cfg?.targets).toEqual([{ appId: 'cli_external' }]);
    expect(normalizeSubstituteMode(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
  });
  it('does not fall back to a person when the App ID is malformed', () => {
    expect(normalizeSubstituteMode({ enabled: true, targets: [{ appId: 'bad', openId: 'ou_stale' }] })).toBeUndefined();
  });
  it('lowercases an App ID so a hand-written uppercase value still matches', () => {
    expect(normalizeSubstituteMode({ enabled: true, targets: [{ appId: ' CLI_External9 ' }] })?.targets)
      .toEqual([{ appId: 'cli_external9' }]);
  });
  it('reports each dropped App ID target', () => {
    const onInvalidAppId = vi.fn();
    const cfg = normalizeSubstituteMode({
      enabled: true, targets: [{ appId: 'bad' }, { appId: 42 }, { appId: 'cli_ok' }],
    }, onInvalidAppId);
    expect(cfg?.targets).toEqual([{ appId: 'cli_ok' }]);
    expect(onInvalidAppId.mock.calls).toEqual([['bad'], [42]]);
  });
});
