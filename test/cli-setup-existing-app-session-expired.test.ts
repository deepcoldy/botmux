/**
 * `botmux setup` →「选择已有应用」撞上飞书 Web 登录态「半失效」时必须能自救。
 *
 * 真实现场（用户终端连贴三遍，一模一样）：
 *   ✔ 飞书应用来源: 选择已有应用
 *   获取飞书 Web 登录态（复用上次登录，过期则需重新扫码）…
 *   ⚠️ 拉取应用列表失败: HTTP 400 /developers/v1/app/list:
 *      {"code":99991641,"msg":"Something went wrong, please log in again.",
 *       "error":{"Code":4101,"LogoutReason":15}}
 *   已返回「飞书应用来源」，可重试或改走其他方式。
 *
 * 成因是两处叠加：① `prepareFeishuWebSession` 的粗检只探 ask.feishu.cn，与
 * console 不同域 ⟹ console 已经拒了的 cookie 照样判「有效」并原样复用；
 * ② 这条分支既不 forceQrLogin 也不识别登出信号，只把 400 原文打出来就回菜单。
 * 于是每次重选都拿同一份坏 cookie 撞同一堵墙 —— 死循环。
 *
 * 这组用例锚定修复后的契约：登出信号（复用 openPlatformWebSessionExpired）→ TTY 下
 * 给一次「重新扫码」→ 第二轮 forceQrLogin 覆盖旧 cookie；非 TTY 绝不弹二维码；
 * 重扫后仍失效不再追问（否则只是换了个死循环）；非登出类错误维持原样。
 *
 * Run: bun run vitest run test/cli-setup-existing-app-session-expired.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inspectCachedFeishuOpenPlatformSession: vi.fn(),
  readStoredCookiesFromSessionFile: vi.fn(),
  prepareFeishuWebSession: vi.fn(),
  createOpenPlatformApiClient: vi.fn(),
  listOpenPlatformApps: vi.fn(),
  fetchOpenPlatformAppSecret: vi.fn(),
  pickChoice: vi.fn(),
}));

// 只替换会真的打网络的那几个出口；openPlatformWebSessionExpired 保持**真实实现**
// —— 这组用例的全部意义就是让真判定器去认真实 payload，本地另写一套判据等于没测。
vi.mock('../src/setup/open-platform-automation.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inspectCachedFeishuOpenPlatformSession: mocks.inspectCachedFeishuOpenPlatformSession,
  readStoredCookiesFromSessionFile: mocks.readStoredCookiesFromSessionFile,
  prepareFeishuWebSession: mocks.prepareFeishuWebSession,
  createOpenPlatformApiClient: mocks.createOpenPlatformApiClient,
  listOpenPlatformApps: mocks.listOpenPlatformApps,
  fetchOpenPlatformAppSecret: mocks.fetchOpenPlatformAppSecret,
}));

// pickChoice 要打桩：TTY 用例得把 isTTY 撑成 true（`interactive` 由它决定），可真
// pickChoice 一看 isTTY=true 就进 raw-mode 全屏选择器，在 vitest 里没法驱动。
vi.mock('../src/setup/interactive-select.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pickChoice: mocks.pickChoice,
}));

import { obtainCredentials } from '../src/cli.js';
import { OpenPlatformApiError } from '../src/setup/open-platform-automation.js';

/** 用户实报的那一份 payload，逐字照抄（LogoutReason 就是 15，不是 40）。 */
function loggedOutError(path = '/developers/v1/app/list'): OpenPlatformApiError {
  return new OpenPlatformApiError(
    `HTTP 400 ${path}: {"code":99991641,"msg":"Something went wrong, please log in again.","error":{"Code":4101,"LogoutReason":15}}`,
    { code: 99991641, msg: 'Something went wrong, please log in again.', error: { Code: 4101, LogoutReason: 15 } },
    400,
  );
}

function fakeRl(answers: string[]) {
  const self: any = {
    question(_q: string, cb: (answer: string) => void) { cb(answers.shift() ?? ''); },
    once() { return self; },
    off() { return self; },
    on() { return self; },
  };
  return self;
}

/** 菜单标题 → 本次返回的下标；同一标题按出现顺序依次消费队列。 */
function scriptChoices(script: Record<string, Array<number | null>>): string[] {
  const seen: string[] = [];
  mocks.pickChoice.mockImplementation(async (_rl: unknown, opts: { title: string }) => {
    seen.push(opts.title);
    const queue = script[opts.title];
    if (!queue || queue.length === 0) throw new Error(`没有为菜单「${opts.title}」准备答案`);
    return queue.shift()!;
  });
  return seen;
}

const TTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
function setTty(on: boolean): void {
  (process.stdin as any).isTTY = on;
  (process.stdout as any).isTTY = on;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.inspectCachedFeishuOpenPlatformSession.mockResolvedValue({ ok: false, reason: 'missing_session', message: 'none' });
  mocks.readStoredCookiesFromSessionFile.mockReturnValue([]);
  mocks.prepareFeishuWebSession.mockResolvedValue({ ok: true, cookies: [] });
  mocks.createOpenPlatformApiClient.mockResolvedValue({ ok: true, client: {} });
  setTty(true);
});

afterEach(() => {
  (process.stdin as any).isTTY = TTY.stdin;
  (process.stdout as any).isTTY = TTY.stdout;
});

describe('「选择已有应用」遇到飞书 Web 登录态失效', () => {
  it('TTY：列表报登出信号 → 提示重新扫码 → 第二轮 forceQrLogin 拿到应用', async () => {
    mocks.listOpenPlatformApps
      .mockRejectedValueOnce(loggedOutError())
      .mockResolvedValueOnce([{ clientId: 'cli_existing', name: '存量应用' }]);
    mocks.fetchOpenPlatformAppSecret.mockResolvedValue('existing-secret');
    const titles = scriptChoices({
      '飞书应用来源': [1],
      '飞书登录态已失效': [0], // 重新扫码
      '选择已有应用': [0],
    });

    const creds = await obtainCredentials(fakeRl([]));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_existing', appSecret: 'existing-secret', brand: 'feishu' });
    expect(titles).toEqual(['飞书应用来源', '飞书登录态已失效', '选择已有应用']);
    // 关键：第一轮复用缓存，第二轮必须 forceQrLogin —— 否则还是同一份坏 cookie。
    expect(mocks.prepareFeishuWebSession).toHaveBeenCalledTimes(2);
    expect(mocks.prepareFeishuWebSession.mock.calls[0][0]).toMatchObject({ forceQrLogin: false });
    expect(mocks.prepareFeishuWebSession.mock.calls[1][0]).toMatchObject({ forceQrLogin: true });
  });

  it('TTY：选「返回应用来源」不重扫，回到来源菜单继续走别的路', async () => {
    mocks.listOpenPlatformApps.mockRejectedValue(loggedOutError());
    const titles = scriptChoices({
      '飞书应用来源': [1, 2],   // 先「选择已有应用」，失败后改「手动输入」
      '飞书登录态已失效': [1],  // 返回应用来源
      '租户类型': [0],
    });

    const creds = await obtainCredentials(fakeRl(['cli_manual', 'manual-secret']));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_manual' });
    expect(titles).toEqual(['飞书应用来源', '飞书登录态已失效', '飞书应用来源', '租户类型']);
    expect(mocks.prepareFeishuWebSession).toHaveBeenCalledTimes(1);
  });

  it('TTY：重新扫完还是失效 → 不再追问，直接回来源菜单（不换个死循环）', async () => {
    mocks.listOpenPlatformApps.mockRejectedValue(loggedOutError());
    const titles = scriptChoices({
      '飞书应用来源': [1, 2],
      '飞书登录态已失效': [0],  // 只会被问这一次
      '租户类型': [0],
    });

    const creds = await obtainCredentials(fakeRl(['cli_manual', 'manual-secret']));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_manual' });
    expect(titles.filter(t => t === '飞书登录态已失效')).toHaveLength(1);
    expect(mocks.prepareFeishuWebSession).toHaveBeenCalledTimes(2);
  });

  it('TTY：读 AppSecret 报登出但用户选「返回」→ 不再追问手动粘 secret（菜单写什么就做什么）', async () => {
    mocks.listOpenPlatformApps.mockResolvedValue([{ clientId: 'cli_existing', name: '存量应用' }]);
    mocks.fetchOpenPlatformAppSecret.mockRejectedValue(loggedOutError('/developers/v1/secret/cli_existing'));
    const titles = scriptChoices({
      '飞书应用来源': [1, 2],
      '选择已有应用': [0],
      '飞书登录态已失效': [1], // 返回应用来源
      '租户类型': [0],
    });
    const asked: string[] = [];
    const rl = fakeRl(['cli_manual', 'manual-secret']);
    const realQuestion = rl.question.bind(rl);
    rl.question = (q: string, cb: (a: string) => void) => { asked.push(q); realQuestion(q, cb); };

    const creds = await obtainCredentials(rl);

    expect(creds).toMatchObject({ ok: true, appId: 'cli_manual' });
    // 登出态下「手动粘贴 AppSecret」是个死路（secret 本来就要登录态才读得到），
    // 选了返回就不该再被问一遍。
    expect(asked.some(q => q.includes('请手动粘贴'))).toBe(false);
    expect(titles).toEqual(['飞书应用来源', '选择已有应用', '飞书登录态已失效', '飞书应用来源', '租户类型']);
  });

  it('非 TTY：读 AppSecret 报登出 → 问不成扫码，保留手动粘贴兜底（管道下唯一能走通的路）', async () => {
    setTty(false);
    mocks.listOpenPlatformApps.mockResolvedValue([{ clientId: 'cli_existing', name: '存量应用' }]);
    mocks.fetchOpenPlatformAppSecret.mockRejectedValue(loggedOutError('/developers/v1/secret/cli_existing'));
    scriptChoices({ '飞书应用来源': [1], '选择已有应用': [0] });

    const creds = await obtainCredentials(fakeRl(['pasted-secret']));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_existing', appSecret: 'pasted-secret' });
  });

  it('TTY：选完应用读 AppSecret 才报登出 → 重扫后整条重来（列表会随账号变，不能只补这一笔）', async () => {
    mocks.listOpenPlatformApps.mockResolvedValue([{ clientId: 'cli_existing', name: '存量应用' }]);
    mocks.fetchOpenPlatformAppSecret
      .mockRejectedValueOnce(loggedOutError('/developers/v1/secret/cli_existing'))
      .mockResolvedValueOnce('existing-secret');
    const titles = scriptChoices({
      '飞书应用来源': [1],
      '选择已有应用': [0, 0],
      '飞书登录态已失效': [0],
    });

    const creds = await obtainCredentials(fakeRl([]));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_existing', appSecret: 'existing-secret' });
    expect(titles).toEqual(['飞书应用来源', '选择已有应用', '飞书登录态已失效', '选择已有应用']);
    expect(mocks.listOpenPlatformApps).toHaveBeenCalledTimes(2);
    expect(mocks.prepareFeishuWebSession.mock.calls[1][0]).toMatchObject({ forceQrLogin: true });
  });

  it('导航语义：主动「返回」静默回菜单，问不成扫码才算技术失败（多打一句导航提示）', async () => {
    // obtainCredentials 的契约：back = 用户主动退出（静默），failed = 技术性失败
    // （补一句「已返回…可重试或改走其他方式」）。两条都回同一个菜单，差别只在这句话，
    // 所以只能从输出上锚定——否则这个分支等于没测。
    const navLine = '已返回「飞书应用来源」';
    const capture = (): string[] => {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
      return lines;
    };

    // ① 用户自己选「返回应用来源」→ 静默。
    mocks.listOpenPlatformApps.mockRejectedValue(loggedOutError());
    scriptChoices({ '飞书应用来源': [1, 2], '飞书登录态已失效': [1], '租户类型': [0] });
    let lines = capture();
    await obtainCredentials(fakeRl(['cli_manual', 'manual-secret']));
    vi.restoreAllMocks();
    expect(lines.some(l => l.includes(navLine))).toBe(false);

    // ② 重扫过还失效 → 已经问不成第二次，算技术失败，补导航提示。
    // 同样在 TTY 下做，才与 ① 只差「谁决定的」这一个变量。
    mocks.prepareFeishuWebSession.mockResolvedValue({ ok: true, cookies: [] });
    mocks.createOpenPlatformApiClient.mockResolvedValue({ ok: true, client: {} });
    mocks.listOpenPlatformApps.mockRejectedValue(loggedOutError());
    scriptChoices({ '飞书应用来源': [1, 2], '飞书登录态已失效': [0], '租户类型': [0] });
    lines = capture();
    await obtainCredentials(fakeRl(['cli_manual', 'manual-secret']));
    vi.restoreAllMocks();
    expect(lines.some(l => l.includes(navLine))).toBe(true);
  });

  it('TTY：普通 console 故障（顶层 99991641 但无登出信号）不当登录失效，维持旧路径', async () => {
    // 反例锚点，与 open-platform-redirect-repair.test.ts 同源：顶层 99991641 是通用
    // 错误码，单独出现不能弹扫码，否则一般故障也会把人赶去扫二维码。
    mocks.listOpenPlatformApps.mockRejectedValue(new OpenPlatformApiError(
      'HTTP 400 /developers/v1/app/list: code=99991641',
      { code: 99991641, msg: '系统繁忙' },
      400,
    ));
    const titles = scriptChoices({ '飞书应用来源': [1, 2], '租户类型': [0] });

    const creds = await obtainCredentials(fakeRl(['cli_manual', 'manual-secret']));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_manual' });
    expect(titles).not.toContain('飞书登录态已失效');
    expect(mocks.prepareFeishuWebSession).toHaveBeenCalledTimes(1);
  });

  it('非 TTY：不弹二维码也不重扫，按旧契约直落手动输入', async () => {
    setTty(false);
    mocks.listOpenPlatformApps.mockRejectedValue(loggedOutError());
    const titles = scriptChoices({ '飞书应用来源': [1], '租户类型': [0] });

    const creds = await obtainCredentials(fakeRl(['cli_manual', 'manual-secret']));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_manual' });
    expect(titles).not.toContain('飞书登录态已失效');
    expect(mocks.prepareFeishuWebSession).toHaveBeenCalledTimes(1);
    expect(mocks.prepareFeishuWebSession.mock.calls[0][0]).toMatchObject({ forceQrLogin: false });
  });

  it('createOpenPlatformApiClient 取不到 csrfToken（同源症状）也给重扫机会', async () => {
    mocks.createOpenPlatformApiClient
      .mockResolvedValueOnce({ ok: false, reason: 'missing_csrf', message: '开放平台页面没有返回 window.csrfToken' })
      .mockResolvedValueOnce({ ok: true, client: {} });
    mocks.listOpenPlatformApps.mockResolvedValue([{ clientId: 'cli_existing', name: '存量应用' }]);
    mocks.fetchOpenPlatformAppSecret.mockResolvedValue('existing-secret');
    scriptChoices({ '飞书应用来源': [1], '飞书登录态已失效': [0], '选择已有应用': [0] });

    const creds = await obtainCredentials(fakeRl([]));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_existing' });
    expect(mocks.prepareFeishuWebSession.mock.calls[1][0]).toMatchObject({ forceQrLogin: true });
  });

  it('network 类失败不弹扫码（重扫治不了连不上）', async () => {
    mocks.createOpenPlatformApiClient.mockResolvedValue({ ok: false, reason: 'network', message: '读取开放平台页面失败' });
    const titles = scriptChoices({ '飞书应用来源': [1, 2], '租户类型': [0] });

    const creds = await obtainCredentials(fakeRl(['cli_manual', 'manual-secret']));

    expect(creds).toMatchObject({ ok: true, appId: 'cli_manual' });
    expect(titles).not.toContain('飞书登录态已失效');
    expect(mocks.prepareFeishuWebSession).toHaveBeenCalledTimes(1);
  });
});
