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
  it('merges defaults; --no-tag/--no-agents drop defaults without producing a tombstone', () => {
    expect(parseGroupCreationArgs('--no-agents Work --no-tag --avatar off', { agents: ['Review'], tag: 'Work', avatar: 'name' })).toEqual({
      name: 'Work', agents: [], avatar: 'off', roleProfileId: undefined,
    });
  });
  it('normalizes whitespace-only default tags to absent (opt-in requires real content)', () => {
    expect(parseGroupCreationArgs('Hello', { tag: '   ' })).toEqual({ name: 'Hello', roleProfileId: undefined });
    expect(parseGroupCreationDefaults({ tag: '   ' })).toEqual({});
  });
  it('keeps unknown --flags as group-name content and does not raise', () => {
    expect(parseGroupCreationArgs('/g 架构 --v2'.replace(/^\/g\s*/, '')).name).toBe('架构 --v2');
    expect(parseGroupCreationArgs('项目\n正文 --rfc 建议').name).toBe('项目');
    expect(parseGroupCreationArgs('--oops value Project').name).toBe('--oops value Project');
    expect(parseGroupCreationArgs('--notaknownflag Work --tag Keep')).toEqual({
      name: '--notaknownflag Work', tag: 'Keep', roleProfileId: undefined,
    });
  });
  it('does not treat known-flag prefixes fused with other characters as flags', () => {
    // Known-flag name must end on `=`, whitespace or EOF — otherwise it is unknown content.
    expect(parseGroupCreationArgs('Project --tag.foo').name).toBe('Project --tag.foo');
    expect(parseGroupCreationArgs('Project --avatar:off').name).toBe('Project --avatar:off');
    expect(parseGroupCreationArgs('Project --no-tag.foo').name).toBe('Project --no-tag.foo');
    expect(parseGroupCreationArgs('Project --no-agents.x').name).toBe('Project --no-agents.x');
    expect(parseGroupCreationArgs('Project --tagged')).toEqual({ name: 'Project --tagged', roleProfileId: undefined });
  });
  it('rejects malformed values that fuse into the next token (no partial consumption)', () => {
    expect(() => parseGroupCreationArgs('Project --tag="A"suffix')).toThrow(/Malformed value for --tag/);
    expect(() => parseGroupCreationArgs('Project --tag "A"suffix')).toThrow(/Malformed value for --tag/);
    expect(() => parseGroupCreationArgs('Project --tag=A--avatar=name')).not.toThrow();
    // The last case is intentional: `A--avatar=name` is a legal unquoted value
    // ending on EOF, so it is accepted whole and preserved as tag content.
    expect(parseGroupCreationArgs('Project --tag=A--avatar=name')).toEqual({
      name: 'Project', tag: 'A--avatar=name', roleProfileId: undefined,
    });
  });
  it('treats bare -- as end-of-options but preserves --=xxx and --<nonboundary>', () => {
    expect(parseGroupCreationArgs('-- 项目名 --tag Keep').name).toBe('项目名 --tag Keep');
    expect(parseGroupCreationArgs('--tag Keep -- 项目 --avatar name')).toEqual({
      name: '项目 --avatar name', tag: 'Keep', roleProfileId: undefined,
    });
    // `--=foo` and `--=` are NOT the sentinel; they stay in the body.
    expect(parseGroupCreationArgs('Project --=foo').name).toBe('Project --=foo');
    expect(parseGroupCreationArgs('Project --=').name).toBe('Project --=');
  });
  it.each([
    '--tag "unclosed', '--agents', '--agents a,,b', '--tag', '--avatar random',
    '--tag A --no-tag', '--no-agents=x', '--tag --avatar name',
  ])('still rejects malformed known flags: %s', raw => {
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
