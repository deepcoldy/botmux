import { describe, expect, it, vi } from 'vitest';
import { runWecomQrSetup, WECOM_START_UNCONFIRMED, type WecomSetupPicker } from '../src/cli/wecom/setup-wizard.js';
import { WecomSetupRejectedError, type WecomSetupClient } from '../src/cli/wecom/onboarding-client.js';
import type { WecomOnboardingSnapshot } from '../src/im/wecom/contract/dashboard-dto.js';
import type { PickChoiceOptions } from '../src/setup/interactive-select.js';
import { t } from '../src/i18n/index.js';

const id = 'wecom-11111111-1111-4111-8111-111111111111';
const job = (status: WecomOnboardingSnapshot['status'], extra = {}): WecomOnboardingSnapshot => ({ id, platform: 'wecom', status, createdAt: 1, updatedAt: 2, resumeUntil: 3, cliId: 'codex', workingDir: '/tmp', externalBotCreated: false, saved: false, retryable: false, ...extra });

/** Labels the confirmation selector offers, looked up from the call itself. */
const CONTINUE = '继续';
const CANCEL = '取消';

/**
 * Text answers come from `answers`; every selector answer is chosen by `pick`
 * from the question it was asked (a label to pick, or null for Esc), so the
 * tests never depend on item order. The CLI selector answers from `cli`.
 */
function fixture(options: {
  answers?: (string | null)[];
  picks?: Array<string | null>;
  cli?: Array<string | null>;
} = {}) {
  const answers = [...(options.answers ?? [])];
  const picks = [...(options.picks ?? [])];
  const cliPicks = [...(options.cli ?? [])];
  const output: string[] = [];
  const asked: Array<{ question: string; hidden?: boolean }> = [];
  const chosen: PickChoiceOptions[] = [];
  const client: WecomSetupClient = {
    list: vi.fn(async () => []), start: vi.fn(async () => job('starting')), get: vi.fn(async () => job('completed')),
    action: vi.fn(async () => job('cancelled')),
  };
  const connect = vi.fn(async () => client);
  const picker: WecomSetupPicker & { choose: ReturnType<typeof vi.fn>; chooseCli: ReturnType<typeof vi.fn> } = {
    choose: vi.fn(async (question: PickChoiceOptions) => {
      chosen.push(question);
      if (picks.length === 0) throw new Error(`no answer scripted for selector「${question.title}」`);
      const label = picks.shift()!;
      if (label === null) return null;
      const index = question.items.findIndex(item => item.label === label);
      if (index < 0) throw new Error(`selector「${question.title}」has no item「${label}」`);
      return index;
    }),
    chooseCli: vi.fn(async () => {
      if (cliPicks.length === 0) throw new Error('no CLI scripted');
      return cliPicks.shift()!;
    }),
  };
  const opts = {
    tty: true,
    connect,
    picker,
    prompt: {
      write: (value: string) => output.push(value),
      ask: vi.fn(async (question: string, askOptions?: { hidden?: boolean }) => {
        asked.push({ question, hidden: askOptions?.hidden });
        return answers.shift() ?? null;
      }),
    },
    sleep: async () => {},
    renderQr: vi.fn(),
  };
  return { client, connect, output, opts, picker, asked, chosen };
}

const allFlags = ['--name', 'x', '--cli', 'codex', '--working-dir', '/tmp', '--backend', 'pty'];

describe('终端企微扫码向导', () => {
  it('平台确认后创建一次，展示官方QR、完整私聊挑战与真实完成状态', async () => {
    const f = fixture({ answers: ['name', '/tmp'], cli: ['codex'], picks: ['pty', CONTINUE] });
    vi.mocked(f.client.get).mockResolvedValueOnce(job('waiting_for_scan', { qrUrl: 'https://work.weixin.qq.com/ai/qc/test' }))
      .mockResolvedValueOnce(job('needs_pairing', { pairingCode: 'BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF' })).mockResolvedValueOnce(job('completed'));
    expect(await runWecomQrSetup([], f.opts)).toBe(0);
    expect(f.client.start).toHaveBeenCalledExactlyOnceWith({ appName: 'name', cliId: 'codex', workingDir: '/tmp', backend: 'pty' });
    expect(f.opts.renderQr).toHaveBeenCalledWith('https://work.weixin.qq.com/ai/qc/test');
    expect(f.output.join('\n')).toContain('BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF');
  });
  it.each([true, false])('恢复失败任务有凭据=%s，不另创建平台机器人', async retryable => {
    const f = fixture({ answers: ['r'], picks: [id] });
    vi.mocked(f.client.list).mockResolvedValue([job('failed', { retryable })]);
    vi.mocked(f.client.action).mockResolvedValue(job('completed'));
    expect(await runWecomQrSetup([], f.opts)).toBe(0);
    expect(f.client.action).toHaveBeenCalledWith(id, retryable ? 'retry' : 'refresh');
    expect(f.client.start).not.toHaveBeenCalled();
  });
  it('断网丢失创建响应不自动start重试，不声称没有创建', async () => {
    const f = fixture({ picks: [CONTINUE] });
    vi.mocked(f.client.start).mockRejectedValue(new Error('secret-in-error'));
    expect(await runWecomQrSetup(allFlags, f.opts)).toBe(2);
    expect(f.client.start).toHaveBeenCalledTimes(1);
    expect(f.output.join('\n')).toContain(WECOM_START_UNCONFIRMED);
    expect(f.output.join('\n')).not.toContain('secret-in-error');
  });
  it('Ctrl-C与晚到start响应交叠时，用返回的任务ID取消', async () => {
    const f = fixture({ picks: [CONTINUE] }), abort = new AbortController();
    vi.mocked(f.client.start).mockImplementation(async () => { abort.abort(); return job('starting'); });
    expect(await runWecomQrSetup(allFlags, { ...f.opts, signal: abort.signal })).toBe(0);
    expect(f.client.action).toHaveBeenCalledExactlyOnceWith(id, 'cancel');
    expect(f.client.get).not.toHaveBeenCalled();
  });
  it('确认前取消、非TTY、help均不连接Dashboard', async () => {
    const f = fixture();
    expect(await runWecomQrSetup([], { ...f.opts, tty: false })).toBe(2);
    expect(await runWecomQrSetup(['--help'], f.opts)).toBe(0);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('轮询授权失效后退出，不刷新token重新创建', async () => {
    const f = fixture();
    vi.mocked(f.client.get).mockResolvedValueOnce(job('needs_pairing')).mockRejectedValue(new Error('expired'));
    expect(await runWecomQrSetup(['--resume', id], f.opts)).toBe(2);
    expect(f.connect).toHaveBeenCalledTimes(1); expect(f.client.start).not.toHaveBeenCalled();
  });
  it.each([
    ['填了显示名', { appName: '口袋克斯' }],
    ['没填显示名', { appName: '' }],
    ['快照不带显示名', {}],
  ])('完成时说明企业微信里的名称和头像要在企业微信里改（%s）', async (_label, extra: { appName?: string }) => {
    const f = fixture();
    vi.mocked(f.client.get).mockResolvedValue(job('completed', extra));
    expect(await runWecomQrSetup(['--resume', id], f.opts)).toBe(0);
    const name = extra.appName?.trim();
    expect(f.output).toContain(name
      ? t('setup.wecom.completed_name_note', { name })
      : t('setup.wecom.completed_name_note_unnamed'));
  });
  it.each(['failed', 'cancelled'] as const)('流程%s时不说名称', async status => {
    const f = fixture({ answers: ['q'] });
    vi.mocked(f.client.get).mockResolvedValue(job(status, { appName: '口袋克斯' }));
    expect(await runWecomQrSetup(['--resume', id], f.opts)).toBe(0);
    const notes = [t('setup.wecom.completed_name_note', { name: '口袋克斯' }), t('setup.wecom.completed_name_note_unnamed')];
    expect(f.output.filter(line => notes.includes(line))).toEqual([]);
  });
});

describe('企微向导的选择题走与飞书 setup 相同的选择器', () => {
  it('CLI 用飞书同一个级联选择器（同一标题），选中的选择键原样作为 cliId 交给 Dashboard', async () => {
    const f = fixture({ answers: ['', '/srv/repo'], cli: ['aiden-x-claude'], picks: ['tmux', CONTINUE] });

    expect(await runWecomQrSetup([], f.opts)).toBe(0);

    expect(f.picker.chooseCli).toHaveBeenCalledExactlyOnceWith({ title: t('setup.cli.select_title') });
    // Same shape as the browser form: the key goes as `cliId`; the Dashboard resolves the variant.
    expect(f.client.start).toHaveBeenCalledExactlyOnceWith({ appName: '', cliId: 'aiden-x-claude', workingDir: '/srv/repo', backend: 'tmux' });
    // Name and directory stay text questions; CLI and backend are never asked as text.
    expect(f.asked).toHaveLength(2);
  });

  it('后端是 pty / tmux 两项、默认 pty；确认的默认项是「取消」', async () => {
    const f = fixture({ answers: ['', '/tmp'], cli: ['codex'], picks: ['pty', CONTINUE] });

    expect(await runWecomQrSetup([], f.opts)).toBe(0);

    const [backend, confirm] = f.chosen;
    expect(backend.items.map(item => item.label)).toEqual(['pty', 'tmux']);
    expect(backend.items[backend.defaultIndex ?? -1]?.label).toBe('pty');
    expect(confirm.items.map(item => item.label).sort()).toEqual([CANCEL, CONTINUE].sort());
    expect(confirm.items[confirm.defaultIndex ?? -1]?.label).toBe(CANCEL);
    // The terminal selector starts on the first item, so that is the default there too.
    expect(confirm.items[0].label).toBe(CANCEL);
  });

  it('给了 --cli / --backend 等 flag 的问题不再出现，只剩确认', async () => {
    const f = fixture({ picks: [CONTINUE] });

    expect(await runWecomQrSetup(['--name', 'n', '--cli', 'claude-code', '--working-dir', '/w', '--backend', 'tmux', '--model', 'm'], f.opts)).toBe(0);

    expect(f.picker.chooseCli).not.toHaveBeenCalled();
    expect(f.chosen).toHaveLength(1);
    expect(f.asked).toEqual([]);
    expect(f.client.start).toHaveBeenCalledExactlyOnceWith({ appName: 'n', cliId: 'claude-code', workingDir: '/w', backend: 'tmux', model: 'm' });
  });

  it.each([
    { name: 'CLI 选择器 Esc', cli: [null], picks: [] },
    { name: '后端选择器 Esc', cli: ['codex'], picks: [null] },
    { name: '确认选择器 Esc', cli: ['codex'], picks: ['pty', null] },
    { name: '确认选「取消」', cli: ['codex'], picks: ['pty', CANCEL] },
  ])('$name：向导以 0 退出，不调 client.start、不取消任何任务', async ({ cli, picks }) => {
    const f = fixture({ answers: ['', '/tmp'], cli, picks });

    expect(await runWecomQrSetup([], f.opts)).toBe(0);

    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.client.action).not.toHaveBeenCalled();
  });

  it('有未完成任务时列成选择器：每个任务一项（最近的在前、默认），最后一项创建新机器人', async () => {
    const older = { ...job('failed'), id: 'wecom-22222222-2222-4222-8222-222222222222', updatedAt: 1 };
    const newer = { ...job('needs_pairing'), updatedAt: 9 };
    const f = fixture({ answers: ['', '/tmp'], cli: ['codex'], picks: ['创建新机器人', 'pty', CONTINUE] });
    vi.mocked(f.client.list).mockResolvedValue([older, newer, job('completed', { id: 'wecom-33333333-3333-4333-8333-333333333333' })]);

    expect(await runWecomQrSetup([], f.opts)).toBe(0);

    const [tasks] = f.chosen;
    // Unfinished tasks newest first, then the one create-new item; the completed task is not offered.
    expect(tasks.items).toHaveLength(3);
    expect(tasks.items.slice(0, 2).map(item => item.label)).toEqual([newer.id, older.id]);
    expect(tasks.defaultIndex).toBe(0);
    expect(f.client.start).toHaveBeenCalledTimes(1);
  });

  it('未完成任务选择器里选中第二个任务就续办它；Esc 则什么都不做', async () => {
    const other = { ...job('needs_pairing'), id: 'wecom-22222222-2222-4222-8222-222222222222', updatedAt: 1 };
    const f = fixture({ picks: [other.id] });
    vi.mocked(f.client.list).mockResolvedValue([job('needs_pairing'), other]);
    vi.mocked(f.client.get).mockResolvedValue({ ...other, status: 'completed' });

    expect(await runWecomQrSetup([], f.opts)).toBe(0);
    expect(f.client.get).toHaveBeenCalledWith(other.id);
    expect(f.client.start).not.toHaveBeenCalled();

    // Everything a new bot would need is scripted, so only the Esc itself can stop it.
    const esc = fixture({ answers: ['', '/tmp'], cli: ['codex'], picks: [null, 'pty', CONTINUE] });
    vi.mocked(esc.client.list).mockResolvedValue([job('needs_pairing')]);
    expect(await runWecomQrSetup([], esc.opts)).toBe(0);
    expect(esc.client.start).not.toHaveBeenCalled();
    expect(esc.client.get).not.toHaveBeenCalled();
    expect(esc.client.action).not.toHaveBeenCalled();
  });
});

describe('企微向导的「手动凭据」模式', () => {
  const SECRET = 'MANUAL-FIXTURE-SECRET-9f2c';

  it('先问 BotID 与 Secret（Secret 不回显），其余问题同扫码，start 带上 mode/botId/secret；任何输出里都没有 Secret', async () => {
    const f = fixture({ answers: ['bot-manual-1', SECRET, 'name', '/tmp'], cli: ['codex'], picks: ['pty', CONTINUE] });
    vi.mocked(f.client.get).mockResolvedValueOnce(job('needs_pairing', { pairingCode: 'BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF' }))
      .mockResolvedValueOnce(job('completed'));

    expect(await runWecomQrSetup([], { ...f.opts, mode: 'manual' })).toBe(0);

    expect(f.asked.map(entry => entry.hidden === true)).toEqual([false, true, false, false]);
    expect(f.client.start).toHaveBeenCalledExactlyOnceWith({
      appName: 'name', cliId: 'codex', workingDir: '/tmp', backend: 'pty',
      mode: 'manual', botId: 'bot-manual-1', secret: SECRET,
    });
    expect(f.opts.renderQr).not.toHaveBeenCalled();
    const visible = [
      ...f.output,
      ...f.asked.map(entry => entry.question),
      ...f.chosen.flatMap(question => [question.title, question.footer ?? '', ...question.items.flatMap(item => [item.label, item.hint ?? ''])]),
    ].join('\n');
    expect(visible).toContain('BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF');
    expect(visible).not.toContain(SECRET);
  });

  it('BotID / Secret 不合格就重问，不发任何请求；合格后只发一次', async () => {
    const f = fixture({
      answers: ['', 'has space', 'x'.repeat(201), 'bot-ok', '   ', `line${'\n'}break`, SECRET, '', '/tmp'],
      cli: ['codex'],
      picks: ['pty', CONTINUE],
    });

    expect(await runWecomQrSetup([], { ...f.opts, mode: 'manual' })).toBe(0);

    expect(f.asked.slice(0, 7).map(entry => entry.hidden === true)).toEqual([false, false, false, false, true, true, true]);
    expect(f.client.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'manual', botId: 'bot-ok', secret: SECRET }));
    // The rejected Secret is not echoed back in the hint either.
    expect(f.output.join('\n')).not.toContain('break');
    expect(f.output.join('\n')).not.toContain(SECRET);
  });

  it('凭据输入时 Ctrl-C / EOF 取消：不发请求', async () => {
    const f = fixture({ answers: ['bot-ok', null] });

    expect(await runWecomQrSetup([], { ...f.opts, mode: 'manual' })).toBe(0);
    expect(f.client.start).not.toHaveBeenCalled();
  });

  it('start 失败时的错误不带 Secret', async () => {
    const f = fixture({ answers: ['bot-ok', SECRET, '', '/tmp'], cli: ['codex'], picks: ['pty', CONTINUE] });
    vi.mocked(f.client.start).mockRejectedValue(new Error(`boom ${SECRET}`));

    expect(await runWecomQrSetup([], { ...f.opts, mode: 'manual' })).toBe(2);
    expect(f.output.join('\n')).not.toContain(SECRET);
  });

  it('确认前 Esc：不提交凭据', async () => {
    const f = fixture({ answers: ['bot-ok', SECRET, '', '/tmp'], cli: ['codex'], picks: ['pty', null] });

    expect(await runWecomQrSetup([], { ...f.opts, mode: 'manual' })).toBe(0);
    expect(f.client.start).not.toHaveBeenCalled();
  });

  it('有未完成任务时先选续办还是新建；续办不问凭据', async () => {
    const f = fixture({ picks: [id] });
    vi.mocked(f.client.list).mockResolvedValue([job('needs_pairing')]);

    expect(await runWecomQrSetup([], { ...f.opts, mode: 'manual' })).toBe(0);
    expect(f.asked).toEqual([]);
    expect(f.client.start).not.toHaveBeenCalled();
  });
});

describe('Dashboard 在创建前拒绝：说明未创建，只重问被拒的那一题', () => {
  const refuse = (code: string) => new WecomSetupRejectedError(code);
  const startInputs = (f: ReturnType<typeof fixture>) => vi.mocked(f.client.start).mock.calls.map(call => call[0]);
  const confirms = (f: ReturnType<typeof fixture>) => f.chosen.filter(question => question.items.some(item => item.label === CONTINUE));

  it.each([
    {
      code: 'wecom_cli_unavailable',
      answers: ['name', '/srv/a'], cli: ['missing-cli', 'codex'], picks: ['pty', CONTINUE, CONTINUE],
      second: { appName: 'name', cliId: 'codex', workingDir: '/srv/a', backend: 'pty' }, cliAsks: 2, textAsks: ['机器人名称（可留空）', '项目工作目录'],
    },
    {
      code: 'wecom_backend_unavailable',
      answers: ['name', '/srv/a'], cli: ['codex'], picks: ['tmux', CONTINUE, 'pty', CONTINUE],
      second: { appName: 'name', cliId: 'codex', workingDir: '/srv/a', backend: 'pty' }, cliAsks: 1, textAsks: ['机器人名称（可留空）', '项目工作目录'],
    },
    {
      code: 'wecom_working_directory_unavailable',
      answers: ['name', '/nope', '/srv/b'], cli: ['codex'], picks: ['pty', CONTINUE, CONTINUE],
      second: { appName: 'name', cliId: 'codex', workingDir: '/srv/b', backend: 'pty' }, cliAsks: 1, textAsks: ['机器人名称（可留空）', '项目工作目录', '项目工作目录'],
    },
    {
      code: 'wecom_invalid_display_name',
      answers: ['x'.repeat(65), '/srv/a', 'short'], cli: ['codex'], picks: ['pty', CONTINUE, CONTINUE],
      second: { appName: 'short', cliId: 'codex', workingDir: '/srv/a', backend: 'pty' }, cliAsks: 1, textAsks: ['机器人名称（可留空）', '项目工作目录', '机器人名称（可留空）'],
    },
  ])('$code：重问对应那一题、保留其它答案，再确认一次后第二次 start 用新答案', async ({ code, answers, cli, picks, second, cliAsks, textAsks }) => {
    const f = fixture({ answers, cli, picks });
    vi.mocked(f.client.start).mockRejectedValueOnce(refuse(code));

    expect(await runWecomQrSetup([], f.opts)).toBe(0);

    expect(f.client.start).toHaveBeenCalledTimes(2);
    expect(startInputs(f)[1]).toEqual(second);
    expect(f.picker.chooseCli).toHaveBeenCalledTimes(cliAsks);
    expect(f.asked.map(entry => entry.question)).toEqual(textAsks);
    expect(confirms(f)).toHaveLength(2);
    expect(f.output).not.toContain(WECOM_START_UNCONFIRMED);
  });

  it.each([
    { code: 'wecom_cli_unavailable', flag: ['--cli', 'missing-cli'] },
    { code: 'wecom_backend_unavailable', flag: ['--backend', 'tmux'] },
    { code: 'wecom_invalid_backend', flag: ['--backend', 'tmux'] },
    { code: 'wecom_working_directory_unavailable', flag: ['--working-dir', '/nope'] },
    { code: 'wecom_invalid_display_name', flag: ['--name', 'x'.repeat(65)] },
  ])('$code 且答案来自 $flag：不重问，退出码 2，只调一次 start', async ({ code, flag }) => {
    const given = new Map([['--name', 'n'], ['--cli', 'codex'], ['--working-dir', '/w'], ['--backend', 'pty']]);
    given.set(flag[0], flag[1]);
    const f = fixture({ picks: [CONTINUE, CONTINUE] });
    vi.mocked(f.client.start).mockRejectedValueOnce(refuse(code));

    expect(await runWecomQrSetup([...given].flat(), f.opts)).toBe(2);

    expect(f.client.start).toHaveBeenCalledTimes(1);
    expect(f.picker.chooseCli).not.toHaveBeenCalled();
    expect(f.asked).toEqual([]);
    expect(confirms(f)).toHaveLength(1);
    expect(f.output).not.toContain(WECOM_START_UNCONFIRMED);
  });

  it('确认前一定未创建、但没有对应问题的拒绝（如端口分配失败）：说明后退出码 2，不重问', async () => {
    const f = fixture({ answers: ['', '/tmp'], cli: ['codex'], picks: ['pty', CONTINUE, CONTINUE] });
    vi.mocked(f.client.start).mockRejectedValueOnce(refuse('wecom_core_port_unavailable'));

    expect(await runWecomQrSetup([], f.opts)).toBe(2);
    expect(f.client.start).toHaveBeenCalledTimes(1);
    expect(f.output).not.toContain(WECOM_START_UNCONFIRMED);
    expect(f.output).toHaveLength(1);
  });

  it.each(['wecom_onboarding_stale_generation', 'wecom_invalid_onboarding', 'wecom_something_new'])(
    '白名单外的码 %s：仍按「创建请求未确认」处理，退出码 2，不重问',
    async code => {
      const f = fixture({ answers: ['', '/tmp'], cli: ['codex', 'claude-code'], picks: ['pty', CONTINUE, CONTINUE] });
      vi.mocked(f.client.start).mockRejectedValueOnce(refuse(code));

      expect(await runWecomQrSetup([], f.opts)).toBe(2);
      expect(f.client.start).toHaveBeenCalledTimes(1);
      expect(f.picker.chooseCli).toHaveBeenCalledTimes(1);
      expect(f.output).toContain(WECOM_START_UNCONFIRMED);
    },
  );

  it.each([
    { code: 'wecom_cli_unavailable', cli: ['missing-cli', null], picks: ['pty', CONTINUE] },
    { code: 'wecom_backend_unavailable', cli: ['codex'], picks: ['tmux', CONTINUE, null] },
  ])('$code 重问时 Esc：退出码 0，不再 start', async ({ code, cli, picks }) => {
    const f = fixture({ answers: ['', '/tmp'], cli, picks });
    vi.mocked(f.client.start).mockRejectedValueOnce(refuse(code));

    expect(await runWecomQrSetup([], f.opts)).toBe(0);
    expect(f.client.start).toHaveBeenCalledTimes(1);
  });

  it('重问后在确认处取消：退出码 0，不再 start', async () => {
    const f = fixture({ answers: ['', '/tmp'], cli: ['codex'], picks: ['tmux', CONTINUE, 'pty', CANCEL] });
    vi.mocked(f.client.start).mockRejectedValueOnce(refuse('wecom_backend_unavailable'));

    expect(await runWecomQrSetup([], f.opts)).toBe(0);
    expect(f.client.start).toHaveBeenCalledTimes(1);
  });

  it('手动模式：重问后第二次 start 仍带同一份 BotID / Secret，凭据不再问，输出无 Secret', async () => {
    const SECRET = 'MANUAL-RETRY-SECRET-3a9d';
    const f = fixture({ answers: ['bot-retry', SECRET, '', '/nope', '/srv/ok'], cli: ['codex'], picks: ['pty', CONTINUE, CONTINUE] });
    vi.mocked(f.client.start).mockRejectedValueOnce(refuse('wecom_working_directory_unavailable'));

    expect(await runWecomQrSetup([], { ...f.opts, mode: 'manual' })).toBe(0);

    expect(startInputs(f)).toEqual([
      { appName: '', cliId: 'codex', workingDir: '/nope', backend: 'pty', mode: 'manual', botId: 'bot-retry', secret: SECRET },
      { appName: '', cliId: 'codex', workingDir: '/srv/ok', backend: 'pty', mode: 'manual', botId: 'bot-retry', secret: SECRET },
    ]);
    expect(f.asked.filter(entry => entry.hidden)).toHaveLength(1);
    const visible = [
      ...f.output,
      ...f.asked.map(entry => entry.question),
      ...f.chosen.flatMap(question => [question.title, question.footer ?? '', ...question.items.flatMap(item => [item.label, item.hint ?? ''])]),
    ].join('\n');
    expect(visible).not.toContain(SECRET);
  });
});
