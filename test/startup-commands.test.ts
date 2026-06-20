import { describe, it, expect } from 'vitest';
import {
  normalizeStartupCommand,
  normalizeStartupCommandList,
  parseStartupCommandsInput,
} from '../src/core/startup-commands.js';

describe('normalizeStartupCommand', () => {
  it('trims, adds a leading slash, and preserves argument spaces', () => {
    expect(normalizeStartupCommand('  effort ultracode ')).toBe('/effort ultracode');
    expect(normalizeStartupCommand('/effort ultracode')).toBe('/effort ultracode');
    expect(normalizeStartupCommand('/model opus')).toBe('/model opus');
  });

  it('collapses embedded newlines so a command submits as one line', () => {
    expect(normalizeStartupCommand('/effort\nultracode')).toBe('/effort ultracode');
  });

  it('rejects empty / non-string / over-long input', () => {
    expect(normalizeStartupCommand('   ')).toBeNull();
    expect(normalizeStartupCommand('')).toBeNull();
    expect(normalizeStartupCommand(42 as any)).toBeNull();
    expect(normalizeStartupCommand('/' + 'x'.repeat(300))).toBeNull();
  });
});

describe('parseStartupCommandsInput', () => {
  it('splits on comma OR newline (NOT space) so arguments survive', () => {
    expect(parseStartupCommandsInput('/effort ultracode, /model opus'))
      .toEqual(['/effort ultracode', '/model opus']);
    expect(parseStartupCommandsInput('/effort ultracode\n/model opus'))
      .toEqual(['/effort ultracode', '/model opus']);
  });

  it('adds missing leading slashes and dedupes in order', () => {
    expect(parseStartupCommandsInput('effort ultracode, /effort ultracode, mcp'))
      .toEqual(['/effort ultracode', '/mcp']);
  });

  it('drops empty tokens and tolerates trailing separators', () => {
    expect(parseStartupCommandsInput('/effort ultracode,,\n,')).toEqual(['/effort ultracode']);
    expect(parseStartupCommandsInput('')).toEqual([]);
    expect(parseStartupCommandsInput('   ')).toEqual([]);
  });
});

describe('normalizeStartupCommandList', () => {
  it('normalizes a bots.json array, dropping junk and deduping', () => {
    expect(normalizeStartupCommandList(['/effort ultracode', 'model opus', '', 42, '/effort ultracode']))
      .toEqual(['/effort ultracode', '/model opus']);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeStartupCommandList(undefined)).toEqual([]);
    expect(normalizeStartupCommandList('/effort ultracode' as any)).toEqual([]);
  });
});
