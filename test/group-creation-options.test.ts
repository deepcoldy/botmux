import { describe, expect, it } from 'vitest';
import { parseGroupCreationArgs, parseGroupCreationDefaults, resolveGroupCreationAgents } from '../src/services/group-creation-options.js';

describe('/g customization', () => {
  it('preserves punctuation, spaces and the first non-empty name line', () => {
    expect(parseGroupCreationArgs('\n项目  “A”\nextra').name).toBe('项目  “A”');
  });
  it('accepts quoted flags before/after the name and keeps role profiles', () => {
    expect(parseGroupCreationArgs('--agents="Review,Build" 项目名称 --tag "Project work" --avatar=name --role-profile suite')).toEqual({
      name: '项目名称', agents: ['Review', 'Build'], tag: 'Project work', avatar: 'name', roleProfileId: 'suite',
    });
  });
  it('merges defaults and permits opting out without consuming the name', () => {
    expect(parseGroupCreationArgs('--no-agents Work --no-tag --avatar off', { agents: ['Review'], tag: 'Work', avatar: 'name' })).toEqual({
      name: 'Work', agents: [], tag: '', avatar: 'off', roleProfileId: undefined,
    });
  });
  it.each(['--tag "unclosed', '--agents', '--agents a,,b', '--tag', '--avatar random', '--oops value', '--tag A --no-tag', '--no-agents=x'])('rejects invalid options: %s', raw => {
    expect(() => parseGroupCreationArgs(raw)).toThrow();
  });
  it.each([null, [], { agents: 'Review' }, { agents: [''] }, { avatar: true }, { tag: '字'.repeat(61) }, { typo: 1 }].map(value => ({ value })))('rejects malformed defaults', ({ value }) => {
    expect(() => parseGroupCreationDefaults(value)).toThrow();
  });
  it('uses current config despite removed, missing, duplicate or transportless cached bots', () => {
    const configs = [{ larkAppId: 'cli_current' }, { larkAppId: 'cli_new', displayName: 'Build' }, { larkAppId: 'cli_api', apiOnly: true }];
    const cache = [{ larkAppId: 'cli_retired', botName: 'Review' }, { larkAppId: 'cli_current', botName: 'Review' }, { larkAppId: 'cli_api', botName: 'API' }];
    expect(resolveGroupCreationAgents(['Review', 'cli_new', 'Build'], configs, cache)).toEqual(['cli_current', 'cli_new']);
    expect(resolveGroupCreationAgents(['cli_new'], configs, [])).toEqual(['cli_new']);
    expect(() => resolveGroupCreationAgents(['cli_retired'], configs, cache)).toThrow('Unknown');
    expect(() => resolveGroupCreationAgents(['API'], configs, cache)).toThrow('Unknown');
    expect(() => resolveGroupCreationAgents(['cli_api'], configs, cache)).toThrow('Unknown');
  });
  it('prefers the configured display name over a stale probe name', () => {
    const configs = [{ larkAppId: 'cli_current', displayName: 'Renamed' }];
    const cache = [{ larkAppId: 'cli_current', botName: 'Old' }];
    expect(resolveGroupCreationAgents(['Renamed'], configs, cache)).toEqual(['cli_current']);
    expect(() => resolveGroupCreationAgents(['Old'], configs, cache)).toThrow('Unknown');
  });
  it('resolves peers outside the source chat, deduplicates and rejects ambiguity', () => {
    const bots = [{ larkAppId: 'cli_review', botName: 'Review' }, { larkAppId: 'cli_build', botName: 'Build' }];
    expect(resolveGroupCreationAgents(['review', 'cli_review', 'Build'], bots, bots)).toEqual(['cli_review', 'cli_build']);
    expect(() => resolveGroupCreationAgents(['missing'], bots, bots)).toThrow('Unknown');
    expect(() => resolveGroupCreationAgents(['Review'], [...bots, { larkAppId: 'cli_review2' }], [...bots, { larkAppId: 'cli_review2', botName: 'Review' }])).toThrow('Ambiguous');
  });
});
