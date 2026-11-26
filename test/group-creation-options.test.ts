import { describe, expect, it } from 'vitest';
import { formatSlashGroupName, groupCommandStartsTask, groupCommandStartsTaskForRouting, parseGroupCreationArgs, parseGroupCreationDefaults, resolveGroupCreationAgents, resolveGroupDecorations, shouldOpenGroupCreateCard } from '../src/services/group-creation-options.js';

describe('/g customization', () => {
  it('preserves punctuation, spaces and the first non-empty name line', () => {
    expect(parseGroupCreationArgs('\n项目  “A”\nextra').name).toBe('项目  “A”');
  });
  it('accepts quoted flags before/after the name and keeps role profiles', () => {
    expect(parseGroupCreationArgs('--agents="Review,Build" 项目名称 --tag "Project work" --avatar=name --role-profile suite')).toEqual({
      name: '项目名称', body: '项目名称', agents: ['Review', 'Build'], tag: 'Project work', avatar: 'name', roleProfileId: 'suite',
    });
  });
  it('merges defaults; --no-tag/--no-agents drop defaults without producing a tombstone', () => {
    expect(parseGroupCreationArgs('--no-agents Work --no-tag --avatar off', { agents: ['Review'], tag: 'Work', avatar: 'name' })).toEqual({
      name: 'Work', body: 'Work', agents: [], avatar: 'off', roleProfileId: undefined,
    });
  });
  it('normalizes whitespace-only default tags to absent (opt-in requires real content)', () => {
    expect(parseGroupCreationArgs('Hello', { tag: '   ' })).toEqual({ name: 'Hello', body: 'Hello', roleProfileId: undefined });
    expect(parseGroupCreationDefaults({ tag: '   ' })).toEqual({});
  });
  it('keeps unknown --flags as group-name content and does not raise', () => {
    expect(parseGroupCreationArgs('/g 架构 --v2'.replace(/^\/g\s*/, '')).name).toBe('架构 --v2');
    expect(parseGroupCreationArgs('项目\n正文 --rfc 建议').name).toBe('项目');
    expect(parseGroupCreationArgs('--oops value Project').name).toBe('--oops value Project');
    expect(parseGroupCreationArgs('--notaknownflag Work --tag Keep')).toEqual({
      name: '--notaknownflag Work', body: '--notaknownflag Work', tag: 'Keep', roleProfileId: undefined,
    });
  });
  it('does not treat known-flag prefixes fused with other characters as flags', () => {
    // Known-flag name must end on `=`, whitespace or EOF — otherwise it is unknown content.
    expect(parseGroupCreationArgs('Project --tag.foo').name).toBe('Project --tag.foo');
    expect(parseGroupCreationArgs('Project --avatar:off').name).toBe('Project --avatar:off');
    expect(parseGroupCreationArgs('Project --no-tag.foo').name).toBe('Project --no-tag.foo');
    expect(parseGroupCreationArgs('Project --no-agents.x').name).toBe('Project --no-agents.x');
    expect(parseGroupCreationArgs('Project --tagged')).toEqual({ name: 'Project --tagged', body: 'Project --tagged', roleProfileId: undefined });
  });
  it('rejects malformed values that fuse into the next token (no partial consumption)', () => {
    expect(() => parseGroupCreationArgs('Project --tag="A"suffix')).toThrow(/Malformed value for --tag/);
    expect(() => parseGroupCreationArgs('Project --tag "A"suffix')).toThrow(/Malformed value for --tag/);
    expect(() => parseGroupCreationArgs('Project --tag=A--avatar=name')).not.toThrow();
    // The last case is intentional: `A--avatar=name` is a legal unquoted value
    // ending on EOF, so it is accepted whole and preserved as tag content.
    expect(parseGroupCreationArgs('Project --tag=A--avatar=name')).toEqual({
      name: 'Project', body: 'Project', tag: 'A--avatar=name', roleProfileId: undefined,
    });
  });
  it('treats bare -- as end-of-options but preserves --=xxx and --<nonboundary>', () => {
    expect(parseGroupCreationArgs('-- 项目名 --tag Keep').name).toBe('项目名 --tag Keep');
    expect(parseGroupCreationArgs('--tag Keep -- 项目 --avatar name')).toEqual({
      name: '项目 --avatar name', body: '项目 --avatar name', tag: 'Keep', roleProfileId: undefined,
    });
    // `--=foo` and `--=` are NOT the sentinel; they stay in the body.
    expect(parseGroupCreationArgs('Project --=foo').name).toBe('Project --=foo');
    expect(parseGroupCreationArgs('Project --=').name).toBe('Project --=');
  });
  it('accepts --avatar logo and logo defaults', () => {
    expect(parseGroupCreationArgs('Project --avatar logo')).toEqual({ name: 'Project', body: 'Project', avatar: 'logo', roleProfileId: undefined });
    expect(parseGroupCreationDefaults({ avatar: 'logo' })).toEqual({ avatar: 'logo' });
  });
  it.each([
    '--tag "unclosed', '--agents', '--agents a,,b', '--tag', '--avatar random',
    '--tag A --no-tag', '--no-agents=x', '--tag --avatar name',
  ])('still rejects malformed known flags: %s', raw => {
    expect(() => parseGroupCreationArgs(raw)).toThrow();
  });
  it.each([null, [], { agents: 'Review' }, { agents: [''] }, { avatar: true }, { avatar: 'emoji' }, { auto: true }, { tag: '字'.repeat(61) }, { typo: 1 }].map(value => ({ value })))('rejects malformed defaults', ({ value }) => {
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

describe('/g decorations', () => {
  it('defaults to the session-group logo and AI-titles only unnamed groups', () => {
    expect(resolveGroupDecorations({ name: '' })).toEqual({ avatar: 'logo', autoTitle: true });
    expect(resolveGroupDecorations({ name: '项目讨论' })).toEqual({ avatar: 'logo', autoTitle: false });
  });
  it('lets an explicit avatar decide, and off means none', () => {
    expect(resolveGroupDecorations({ name: '', avatar: 'name' })).toEqual({ avatar: 'name', autoTitle: true });
    expect(resolveGroupDecorations({ name: '', avatar: 'off' })).toEqual({ avatar: undefined, autoTitle: true });
  });
});

describe('formatSlashGroupName', () => {
  it('prefixes once and truncates by code point within 50 UTF-16 units', () => {
    expect(formatSlashGroupName('修复登录', 'AI·')).toBe('AI·修复登录');
    expect(formatSlashGroupName('AI·修复登录', 'AI·')).toBe('AI·修复登录');
    const long = formatSlashGroupName('😀'.repeat(60));
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(51);
  });
});

describe('/g task mode (opt-in: --start / autoStart: true; --no-start overrides)', () => {
  it('keeps the whole multi-line body without the options', () => {
    const args = parseGroupCreationArgs('修复价格展示 --tag Work\n第二行细节');
    expect(args.autoStart).toBeUndefined();
    expect(args.tag).toBe('Work');
    expect(args.body).toBe('修复价格展示\n第二行细节');
  });
  it('--no-start turns task mode off for one command and takes no value', () => {
    expect(parseGroupCreationArgs('--no-start 项目群', { autoStart: true })).toMatchObject({ autoStart: false, name: '项目群' });
    expect(() => parseGroupCreationArgs('--no-start=yes 任务')).toThrow(/takes no value/);
    expect(() => parseGroupCreationArgs('--no-start --no-start 任务')).toThrow(/Duplicate option/);
  });
  it('reads options from the first line only; later task lines stay verbatim', () => {
    const task = '排查镜像构建失败\n复现：docker build --tag app:dev .\n还原：git checkout -- src/foo.ts\n对比 --tag 和 --tag=x、--avatar off、--agents a,b、--no-start';
    const args = parseGroupCreationArgs(task);
    expect(args).toMatchObject({ name: '排查镜像构建失败', body: task });
    expect(args.tag).toBeUndefined();
    expect(args.avatar).toBeUndefined();
    expect(args.agents).toBeUndefined();
    expect(args.autoStart).toBeUndefined();
    expect(parseGroupCreationArgs(`--tag Work ${task}`)).toMatchObject({ tag: 'Work', body: task });
    // Options-only first line: the name falls through to the task's first line.
    expect(parseGroupCreationArgs('--no-start\n项目群\n--tag x')).toMatchObject({ autoStart: false, name: '项目群', body: '项目群\n--tag x' });
  });
  it('task mode stays off unless asked for: no default, --start opts one command in', () => {
    expect(parseGroupCreationArgs('支付排障').autoStart).toBeUndefined();
    expect(parseGroupCreationArgs('--start 任务')).toMatchObject({ autoStart: true, name: '任务', body: '任务' });
    expect(parseGroupCreationArgs('任务 --start', { autoStart: false }).autoStart).toBe(true);
    expect(() => parseGroupCreationArgs('--start=yes 任务')).toThrow(/takes no value/);
    expect(() => parseGroupCreationArgs('--start --no-start 任务')).toThrow(/Duplicate option/);
  });
  it('groupCommandStartsTask: only a /g that will start a task (routing accepts multi-line only then)', () => {
    expect(groupCommandStartsTask('/g 修复价格\n第二行', undefined)).toBe(false);
    expect(groupCommandStartsTask('/g 修复价格\n第二行', { avatar: 'name' })).toBe(false);
    expect(groupCommandStartsTask('/g --start 修复价格\n第二行', undefined)).toBe(true);
    expect(groupCommandStartsTask('/GROUP 修复价格 --start', undefined)).toBe(true);
    expect(groupCommandStartsTask('/g 修复价格\n第二行', { autoStart: true })).toBe(true);
    expect(groupCommandStartsTask('/g --no-start 项目群\n说明', { autoStart: true })).toBe(false);
    // Options live on the first line only, so a later `--start` is task text.
    expect(groupCommandStartsTask('/g 修复价格\n--start', undefined)).toBe(false);
    expect(groupCommandStartsTask('/gx --start 任务', undefined)).toBe(false);
    expect(groupCommandStartsTask('修复 /g --start', undefined)).toBe(false);
    // Unparseable options or defaults fall back to the legacy routing.
    expect(groupCommandStartsTask('/g --start --start 任务', undefined)).toBe(false);
    expect(groupCommandStartsTask('/g 任务\n细节', { autoStart: 'yes' })).toBe(false);
  });
  it('validates autoStart in bot defaults', () => {
    expect(parseGroupCreationDefaults({ autoStart: false })).toEqual({ autoStart: false });
    expect(() => parseGroupCreationDefaults({ autoStart: 'yes' })).toThrow(/autoStart/);
  });
});

describe('/g multiline routing uses the shared first-mentioned creator, never receiver defaults', () => {
  const text = '/g 排查价格\n第二行细节';
  const A = { botName: 'A', groupCreation: { autoStart: false } };
  const B = { botName: 'B', groupCreation: { autoStart: true } };
  const route = (ownDefaults: unknown, mentions: Array<Record<string, string>>, knownBots = [A, B], commandText = text) =>
    groupCommandStartsTaskForRouting({ commandText, ownDefaults, mentions, knownBots });

  it('is identical with opposite receiver defaults in either creator order', () => {
    for (const own of [{ autoStart: false }, { autoStart: true }]) {
      expect(route(own, [{ name: 'A', openId: 'ou_A_receiver_1' }, { name: 'B' }])).toBe(false);
      expect(route(own, [{ name: 'B', openId: 'ou_B_receiver_2' }, { name: 'A' }])).toBe(true);
    }
  });

  it('honors explicit switches and preserves no-mention behavior', () => {
    expect(route({ autoStart: false }, [{ name: 'A' }, { name: 'B' }], [A, B], '/g --start 任务\n细节')).toBe(true);
    expect(route({ autoStart: true }, [{ name: 'B' }], [A, B], '/g --no-start 群名\n说明')).toBe(false);
    expect(route({ autoStart: true }, [])).toBe(true);
    expect(route({ autoStart: false }, [])).toBe(false);
    // Human mentions do not displace the first known bot; human-only mentions
    // leave this daemon as creator, matching handleCommand's election input.
    expect(route({ autoStart: false }, [{ name: 'human' }, { name: 'B' }])).toBe(true);
    expect(route({ autoStart: true }, [{ name: 'human' }])).toBe(true);
  });

  it('fails closed for implicit task mode with an empty registry or ambiguous duplicate names', () => {
    for (const own of [{ autoStart: false }, { autoStart: true }]) {
      expect(route(own, [{ name: 'A' }], [])).toBe(false);
      expect(route(own, [{ name: 'A' }], [], '/g --start 任务\n细节')).toBe(true);
      expect(route(own, [{ name: 'A' }], [A, { botName: 'a', groupCreation: { autoStart: true } }])).toBe(false);
      expect(route(own, [{ name: 'A' }], [
        { botName: 'A', groupCreation: { autoStart: true } },
        { botName: 'a', groupCreation: { autoStart: true } },
      ])).toBe(true);
    }
  });

  it('does not reinterpret non-/g text', () => {
    expect(route({ autoStart: true }, [], [A, B], '/gx --start 任务\n细节')).toBe(false);
    expect(route({ autoStart: true }, [], [A, B], '普通文本')).toBe(false);
  });
});

describe('/g directory, branch, and opt-in form card (--dir, --branch, --card, --no-card, groupCreation.card)', () => {
  it('parses --dir and --branch alongside the group name', () => {
    expect(parseGroupCreationArgs('项目讨论 --dir /work/app --branch feat/demo')).toMatchObject({
      name: '项目讨论',
      workingDir: '/work/app',
      branch: 'feat/demo',
    });
    expect(parseGroupCreationArgs('--dir="/work/my app" --branch=fix/a')).toMatchObject({
      name: '',
      workingDir: '/work/my app',
      branch: 'fix/a',
    });
  });

  it('validates card in defaults and parses --card / --no-card switches', () => {
    expect(parseGroupCreationDefaults({ card: true })).toEqual({ card: true });
    expect(parseGroupCreationDefaults({ card: false })).toEqual({ card: false });
    expect(() => parseGroupCreationDefaults({ card: 'yes' })).toThrow(/card/);

    expect(parseGroupCreationArgs('--card')).toMatchObject({ card: true, cardExplicit: true, name: '' });
    expect(parseGroupCreationArgs('--card 项目名 --dir /repo')).toMatchObject({
      card: true,
      cardExplicit: true,
      name: '项目名',
      workingDir: '/repo',
    });
    expect(parseGroupCreationArgs('--no-card', { card: true })).toMatchObject({ card: false, name: '' });
    expect(parseGroupCreationArgs('--no-card', { card: true }).cardExplicit).toBeUndefined();
    expect(() => parseGroupCreationArgs('--card=yes')).toThrow(/takes no value/);
    expect(() => parseGroupCreationArgs('--no-card=no')).toThrow(/takes no value/);
    expect(() => parseGroupCreationArgs('--card --no-card')).toThrow(/Duplicate option/);
  });

  it('shouldOpenGroupCreateCard keeps bare /g backward-compatible by default and honors opt-in + explicit overrides', () => {
    // Default (card unset/false): bare /g stays direct, --card opens the form card.
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs(''), { autoStart: false })).toBe('direct');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('项目名'), { autoStart: false })).toBe('direct');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--card'), { autoStart: false })).toBe('card');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--card 项目名'), { autoStart: false })).toBe('card');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--card --start 修复 bug'), { autoStart: true })).toBe('conflict_with_start');
    // --card with autoStart default but NO task text/quote has autoStart=false → opens form card cleanly.
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--card', { autoStart: true }), { autoStart: false })).toBe('card');

    // Opt-in groupCreation.card: true: bare /g opens card; explicit name/dir/branch/task or --no-card stays direct.
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('', { card: true }), { autoStart: false })).toBe('card');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--avatar name', { card: true }), { autoStart: false })).toBe('card');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--no-card', { card: true }), { autoStart: false })).toBe('direct');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('项目名', { card: true }), { autoStart: false })).toBe('direct');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--dir /repo', { card: true }), { autoStart: false })).toBe('direct');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--start 修 bug', { card: true }), { autoStart: true })).toBe('direct');
    expect(shouldOpenGroupCreateCard(parseGroupCreationArgs('--card 项目名', { card: true }), { autoStart: false })).toBe('card');
  });
});
