import { describe, expect, it } from 'vitest';

import {
  CLI_SELECT_OPTIONS,
  CLI_SELECT_TREE,
  resolveCliSelection,
  lookupCliSelection,
  selectionKeyForBot,
  stripSettingsArgs,
  buildWrappedLaunch,
  parseWrapperCli,
  decorateResumeForWrapper,
  wrapperStripsSettings,
} from '../src/setup/cli-selection.js';

describe('CLI_SELECT_OPTIONS / CLI_SELECT_TREE', () => {
  it('includes the two aiden gateway options right after native aiden', () => {
    const keys = CLI_SELECT_OPTIONS.map((o) => o.key);
    expect(keys).toContain('aiden');
    expect(keys).toContain('aiden-x-claude');
    expect(keys).toContain('aiden-x-codex');
    const i = keys.indexOf('aiden');
    expect(keys[i + 1]).toBe('aiden-x-claude');
    expect(keys[i + 2]).toBe('aiden-x-codex');
  });

  it('keeps every plain CliId selectable by its own key', () => {
    expect(lookupCliSelection('claude-code')?.cliId).toBe('claude-code');
    expect(lookupCliSelection('codex')?.cliId).toBe('codex');
    expect(lookupCliSelection('codex')?.wrapperCli).toBeUndefined();
  });

  it('cascades Aiden into a submenu of three variants', () => {
    const aiden = CLI_SELECT_TREE.find((g) => g.key === 'aiden');
    expect(aiden?.children?.map((c) => c.key)).toEqual(['aiden', 'aiden-x-claude', 'aiden-x-codex']);
    // every non-aiden top entry is a directly-selectable leaf
    const codex = CLI_SELECT_TREE.find((g) => g.key === 'codex');
    expect(codex?.option?.cliId).toBe('codex');
    expect(codex?.children).toBeUndefined();
  });
});

describe('resolveCliSelection', () => {
  it('maps a plain cli key to just its cliId', () => {
    expect(resolveCliSelection('claude-code')).toEqual({ cliId: 'claude-code' });
    expect(resolveCliSelection('gemini')).toEqual({ cliId: 'gemini' });
  });

  it('maps aiden×claude to claude-code + wrapperCli "aiden x claude"', () => {
    expect(resolveCliSelection('aiden-x-claude')).toEqual({ cliId: 'claude-code', wrapperCli: 'aiden x claude' });
  });

  it('maps aiden×codex to codex + wrapperCli "aiden x codex"', () => {
    expect(resolveCliSelection('aiden-x-codex')).toEqual({ cliId: 'codex', wrapperCli: 'aiden x codex' });
  });

  it('maps native aiden to plain aiden (no wrapper)', () => {
    expect(resolveCliSelection('aiden')).toEqual({ cliId: 'aiden' });
  });

  it('throws on an unknown key', () => {
    expect(() => resolveCliSelection('nope')).toThrow(/未知 CLI 选择项/);
  });
});

describe('selectionKeyForBot', () => {
  it('round-trips aiden gateway bots back to their selection key', () => {
    expect(selectionKeyForBot('claude-code', 'aiden x claude')).toBe('aiden-x-claude');
    expect(selectionKeyForBot('codex', 'aiden x codex')).toBe('aiden-x-codex');
  });

  it('falls back to cliId for plain bots or unrecognised prefixes', () => {
    expect(selectionKeyForBot('codex')).toBe('codex');
    expect(selectionKeyForBot('claude-code', '')).toBe('claude-code');
    expect(selectionKeyForBot('claude-code', 'ccr')).toBe('claude-code');
  });
});

describe('stripSettingsArgs', () => {
  it('drops --settings <value> (two tokens)', () => {
    expect(stripSettingsArgs(['--session-id', 'x', '--settings', '{"a":1}', '--model', 'm']))
      .toEqual(['--session-id', 'x', '--model', 'm']);
  });

  it('drops --settings=<value> (single token)', () => {
    expect(stripSettingsArgs(['--settings={"a":1}', '--plugin-dir', '/p']))
      .toEqual(['--plugin-dir', '/p']);
  });

  it('leaves args untouched when there is no --settings', () => {
    expect(stripSettingsArgs(['--resume', 'id', '--model', 'm'])).toEqual(['--resume', 'id', '--model', 'm']);
  });
});

describe('parseWrapperCli', () => {
  it('splits on whitespace and drops blanks', () => {
    expect(parseWrapperCli('  aiden   x claude ')).toEqual(['aiden', 'x', 'claude']);
    expect(parseWrapperCli('')).toEqual([]);
  });
});

describe('buildWrappedLaunch', () => {
  it('prepends the prefix and strips --settings for aiden x claude', () => {
    const out = buildWrappedLaunch('aiden x claude', ['--session-id', 'sid', '--settings', '{}', '--plugin-dir', '/p']);
    expect(out.bin).toBe('aiden');
    expect(out.args).toEqual(['x', 'claude', '--session-id', 'sid', '--plugin-dir', '/p']);
  });

  it('prepends the prefix but keeps args verbatim for aiden x codex', () => {
    const out = buildWrappedLaunch('aiden x codex', ['resume', 'cid', '--model', 'm']);
    expect(out.bin).toBe('aiden');
    expect(out.args).toEqual(['x', 'codex', 'resume', 'cid', '--model', 'm']);
  });

  it('works for a generic single-token prefix (ccr) without stripping --settings', () => {
    const out = buildWrappedLaunch('ccr', ['--settings', '{}', '--resume', 'x']);
    expect(out.bin).toBe('ccr');
    expect(out.args).toEqual(['--settings', '{}', '--resume', 'x']);
  });

  it('resolves the bin via the provided resolver', () => {
    const out = buildWrappedLaunch('aiden x claude', ['--resume', 'x'], (b) => `/abs/${b}`);
    expect(out.bin).toBe('/abs/aiden');
  });

  it('returns empty bin for a blank prefix so callers can skip', () => {
    expect(buildWrappedLaunch('   ', ['--resume', 'x'])).toEqual({ bin: '', args: ['--resume', 'x'] });
  });
});

describe('wrapperStripsSettings', () => {
  it('is true only for aiden x claude (the prefix that rejects --settings)', () => {
    expect(wrapperStripsSettings('aiden x claude')).toBe(true);
  });

  it('is false for aiden x codex, generic launchers, and unset', () => {
    expect(wrapperStripsSettings('aiden x codex')).toBe(false);
    expect(wrapperStripsSettings('ccr')).toBe(false);
    expect(wrapperStripsSettings('')).toBe(false);
    expect(wrapperStripsSettings(undefined)).toBe(false);
  });
});

describe('decorateResumeForWrapper', () => {
  it('rewrites the leading bin to the wrapper prefix', () => {
    expect(decorateResumeForWrapper('claude --resume ID', 'aiden x claude')).toBe('aiden x claude --resume ID');
    expect(decorateResumeForWrapper('codex resume ID', 'aiden x codex')).toBe('aiden x codex resume ID');
  });

  it('returns the command unchanged when no wrapper is set', () => {
    expect(decorateResumeForWrapper('claude --resume ID', undefined)).toBe('claude --resume ID');
    expect(decorateResumeForWrapper('claude --resume ID', '   ')).toBe('claude --resume ID');
  });
});
