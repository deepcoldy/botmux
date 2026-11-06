import { describe, expect, it } from 'vitest';
import {
  normalizePassthroughCommand,
  parseCustomPassthroughInput,
} from '../src/core/passthrough-commands.js';

describe('normalizePassthroughCommand', () => {
  it('joins internal whitespace with a hyphen', () => {
    expect(normalizePassthroughCommand('/Ultra Goal')).toBe('/ultra-goal');
    expect(normalizePassthroughCommand('/Ultra   Goal')).toBe('/ultra-goal');
    expect(normalizePassthroughCommand('/ultra\tgoal')).toBe('/ultra-goal');
  });

  it('does not prepend a leading slash (callers do that)', () => {
    expect(normalizePassthroughCommand('Ultra Goal')).toBeNull();
  });

  it('rejects names whose first char after / is a hyphen', () => {
    expect(normalizePassthroughCommand('/ Ultra Goal')).toBeNull();
  });
});

describe('parseCustomPassthroughInput', () => {
  it('keeps a space inside a slash-prefixed name as one hyphen-joined command', () => {
    // 用户在卡片里输入自然语言命令名 /Ultra Goal，实际命令是 /ultra-goal
    expect(parseCustomPassthroughInput('/Ultra Goal')).toEqual(['/ultra-goal']);
    expect(parseCustomPassthroughInput('Ultra Goal')).toEqual(['/ultra-goal']);
  });

  it('still splits on whitespace before the next slash command', () => {
    expect(parseCustomPassthroughInput('/goal /export')).toEqual(['/goal', '/export']);
  });

  it('splits on commas and newlines', () => {
    expect(parseCustomPassthroughInput('/Ultra Goal, /export\n/goal')).toEqual(['/ultra-goal', '/export', '/goal']);
  });

  it('mixes spaced names and slash-separated commands in one segment', () => {
    expect(parseCustomPassthroughInput('/Ultra Goal /export x')).toEqual(['/ultra-goal', '/export-x']);
  });

  it('falls back to per-word parsing of an entry glued by non-separator punctuation', () => {
    expect(parseCustomPassthroughInput('/goal ; /export')).toEqual(['/goal', '/export']);
    expect(parseCustomPassthroughInput('/goal (note)')).toEqual(['/goal']);
    expect(parseCustomPassthroughInput('/a b! c')).toEqual(['/a', '/c']);
  });

  it('fallback runs per greedy token, keeping an already-normalized spaced name', () => {
    expect(parseCustomPassthroughInput('/Ultra Goal /bad (note)')).toEqual(['/ultra-goal', '/bad']);
  });

  it('does not launder an entry with a malformed leader: fallback needs a valid first word', () => {
    expect(parseCustomPassthroughInput('/ Ultra Goal')).toEqual([]);
    expect(parseCustomPassthroughInput('/ goal')).toEqual([]);
  });

  it('dedupes after normalization', () => {
    expect(parseCustomPassthroughInput('/Ultra Goal, /ultra-goal')).toEqual(['/ultra-goal']);
  });

  it('drops daemon-shadowing entries', () => {
    expect(parseCustomPassthroughInput('/Status /Ultra Goal')).toEqual(['/ultra-goal']);
  });

  it('returns [] for empty and fully invalid input', () => {
    expect(parseCustomPassthroughInput('')).toEqual([]);
    expect(parseCustomPassthroughInput('  ,  \n ')).toEqual([]);
    expect(parseCustomPassthroughInput('/@bad')).toEqual([]);
  });
});
