/**
 * 交互式 `botmux setup` 在「飞书应用来源」的企业微信分区选了一种接入方式之后的交接边界。
 *
 * 各入口（首次配置 / 多机器人「添加机器人」/ .env「添加机器人」）的来源菜单是四项来源（飞书三项 +
 * 「仅本地机器人」）+ 一行「企业微信」分隔 + 「扫码创建新机器人」「手动输入 BotID/Secret」。拿到交接结果后：先
 * 关掉飞书向导的 readline，再以所选方式（qr / manual）调一次企微向导（可注入，这里永远是假
 * 的），退出码取它的返回值；不写 bots.json / .env、不迁移不备份、不打印飞书侧的收尾文案。
 * 替换飞书配置的入口（重新配置 / 覆盖 .env / .env 缺凭据兜底）、非交互终端、显式
 * --platform feishu 时来源菜单仍只有四项、没有分隔行。
 *
 * pickChoice 打桩：要把 isTTY 撑成 true（显示与否由它决定），真 pickChoice 一看 TTY 就进
 * raw-mode 全屏选择器，vitest 里没法驱动。readline 也换成假的，免得在测试进程的 stdin 上
 * 开真终端会话。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

const mocks = vi.hoisted(() => ({
  pickChoice: vi.fn(),
  createInterface: vi.fn(),
  tryRegisterApp: vi.fn(),
  createFeishuOpenPlatformApp: vi.fn(),
  inspectCachedFeishuOpenPlatformSession: vi.fn(),
  readStoredCookiesFromSessionFile: vi.fn(),
  prepareFeishuWebSession: vi.fn(),
  automateOpenPlatformSetup: vi.fn(),
  validateCredentials: vi.fn(),
}));

vi.mock('node:readline', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createInterface: mocks.createInterface,
}));

vi.mock('../src/setup/interactive-select.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pickChoice: mocks.pickChoice,
}));

// 飞书来源、凭证校验、写盘后的开放平台自动配置都会打网络；交接路径上一个都不该被碰到
// （一旦漏判写了盘，自动配置这一步立刻报错，而不是真去连飞书）。
vi.mock('../src/setup/register-app.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tryRegisterApp: mocks.tryRegisterApp,
}));

vi.mock('../src/setup/open-platform-automation.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFeishuOpenPlatformApp: mocks.createFeishuOpenPlatformApp,
  inspectCachedFeishuOpenPlatformSession: mocks.inspectCachedFeishuOpenPlatformSession,
  readStoredCookiesFromSessionFile: mocks.readStoredCookiesFromSessionFile,
  prepareFeishuWebSession: mocks.prepareFeishuWebSession,
  automateOpenPlatformSetup: mocks.automateOpenPlatformSetup,
}));

vi.mock('../src/setup/verify-permissions.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateCredentials: mocks.validateCredentials,
}));

import { cmdSetup } from '../src/cli.js';
import { getDefaultLocale, setDefaultLocale, shippedText, type Locale } from '../src/i18n/index.js';

const CONFIG_DIR = join(homedir(), '.botmux');
const BOTS_JSON = join(CONFIG_DIR, 'bots.json');
const ENV = join(CONFIG_DIR, '.env');
const BOT_FIXTURE = JSON.stringify([{
  larkAppId: 'cli_handoff_fixture',
  larkAppSecret: 'handoff-fixture-secret',
  cliId: 'claude-code',
  allowedUsers: ['owner@example.com'],
}], null, 2);
const ENV_FIXTURE = 'LARK_APP_ID=cli_handoff_fixture\nLARK_APP_SECRET=handoff-fixture-secret\n';

const initialLocale = getDefaultLocale();
const initialExitCode = process.exitCode;
const TTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
function setTty(on: boolean): void {
  (process.stdin as any).isTTY = on;
  (process.stdout as any).isTTY = on;
}

const sourceTitle = (locale: Locale = 'zh') => shippedText('setup.credentials.source_title', locale);
const actionTitle = (locale: Locale = 'zh') => shippedText('setup.menu.action_title', locale);

type FakeRl = { close: ReturnType<typeof vi.fn> };
let rls: FakeRl[] = [];
/** 每个菜单的标题与各项（分隔行标成 `separator`）。 */
let menus: Array<{ title: string; labels: string[]; separators: number[] }> = [];
let logged = '';

/** 菜单标题 → 依次返回的下标；`before` 在返回前执行（模拟用户在这个菜单里按 L 切语言）。 */
function scriptChoices(script: Record<string, Array<number | null>>, before?: (title: string) => void): void {
  mocks.pickChoice.mockImplementation(async (_rl: unknown, optsOrFactory: any) => {
    const opts = typeof optsOrFactory === 'function' ? optsOrFactory() : optsOrFactory;
    menus.push({
      title: opts.title,
      labels: opts.items.map((item: { label: string }) => item.label),
      separators: opts.items.flatMap((item: { separator?: boolean }, index: number) => (item.separator ? [index] : [])),
    });
    before?.(opts.title);
    const queue = script[opts.title];
    if (!queue || queue.length === 0) throw new Error(`没有为菜单「${opts.title}」准备答案`);
    return queue.shift()!;
  });
}

/** 配置目录下所有文件 → 内容（目录本身由 ensureConfigDir 建，不算写盘）。 */
function configFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(CONFIG_DIR, path)] = readFileSync(path, 'utf8');
    }
  };
  if (existsSync(CONFIG_DIR)) walk(CONFIG_DIR);
  return files;
}

/** 飞书向导各种「已取消 / 未改动 / 已中止 / 已写入」的收尾句：交接时一条都不该出现。 */
const FEISHU_WRAP_UP_KEYS = [
  'setup.common.cancelled',
  'setup.common.cancelled_abort',
  'setup.common.aborted_keep_config',
  'setup.common.aborted_bots_json_untouched',
  'setup.common.aborted_env_untouched',
  'setup.credentials.empty_abort',
];

function fakeWecomWizard(exitCode: number) {
  const seen: { feishuRlClosed?: boolean; locale?: Locale } = {};
  const handOffToWecom = vi.fn(async (_mode: 'qr' | 'manual') => {
    seen.feishuRlClosed = rls.length > 0 && rls.every(rl => rl.close.mock.calls.length > 0);
    seen.locale = getDefaultLocale();
    return exitCode;
  });
  return { handOffToWecom, seen };
}

/** 企微分区在来源菜单里的位置：四项来源之后的分隔行，以及它下面的两种接入方式。 */
const WECOM_SECTION_INDEX = 4;
const WECOM_PICK = { qr: 5, manual: 6 } as const;
/** 上游的第四项来源，没有 i18n 键，中英文界面都是这一句。 */
const LOCAL_BOT_SOURCE_LABEL = '仅本地机器人';
const SOURCE_COUNT = 4;
const WECOM_KEYS = ['setup.platform.source_wecom_section', 'setup.platform.source_wecom_qr', 'setup.platform.source_wecom_manual'];

function sourceLabels(locale: Locale = 'zh'): string[] {
  return [
    shippedText('setup.credentials.one_scan', locale),
    shippedText('setup.credentials.pick_existing', locale),
    shippedText('setup.credentials.manual', locale),
    LOCAL_BOT_SOURCE_LABEL,
    ...WECOM_KEYS.map(key => shippedText(key, locale)),
  ];
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  rls = [];
  menus = [];
  logged = '';
  mocks.createInterface.mockImplementation(() => {
    const rl: any = {
      question(_q: string, cb: (answer: string) => void) { cb(''); },
      once() { return rl; },
      off() { return rl; },
      on() { return rl; },
      close: vi.fn(),
    };
    rls.push(rl);
    return rl;
  });
  const unreachable = new Error('交接路径不应走到飞书来源或凭证校验');
  mocks.createFeishuOpenPlatformApp.mockRejectedValue(unreachable);
  mocks.inspectCachedFeishuOpenPlatformSession.mockRejectedValue(unreachable);
  mocks.prepareFeishuWebSession.mockRejectedValue(unreachable);
  mocks.tryRegisterApp.mockRejectedValue(unreachable);
  mocks.automateOpenPlatformSetup.mockRejectedValue(unreachable);
  mocks.validateCredentials.mockRejectedValue(unreachable);
  mocks.readStoredCookiesFromSessionFile.mockReturnValue([]);
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged += `${args.join(' ')}\n`; });
  setTty(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  (process.stdin as any).isTTY = TTY.stdin;
  (process.stdout as any).isTTY = TTY.stdout;
  setDefaultLocale(initialLocale);
  process.exitCode = initialExitCode;
});

function expectCleanHandoff(wizard: ReturnType<typeof fakeWecomWizard>, before: Record<string, string>): void {
  expect(wizard.handOffToWecom).toHaveBeenCalledTimes(1);
  expect(wizard.seen.feishuRlClosed).toBe(true);
  expect(configFiles()).toEqual(before);
  for (const key of FEISHU_WRAP_UP_KEYS) expect(logged).not.toContain(shippedText(key, 'zh'));
  for (const fn of [mocks.createFeishuOpenPlatformApp, mocks.prepareFeishuWebSession, mocks.tryRegisterApp, mocks.automateOpenPlatformSetup, mocks.validateCredentials]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

describe('新增机器人的入口：企业微信分区的两种方式各自交给企微向导', () => {
  it.each(['qr', 'manual'] as const)('首次配置：来源菜单是四项来源 + 分隔行 + 企微两项，选 %s 后不写任何配置，退出码取企微向导的返回值', async mode => {
    scriptChoices({ [sourceTitle()]: [WECOM_PICK[mode]] });
    const wizard = fakeWecomWizard(7);

    await cmdSetup({ handOffToWecom: wizard.handOffToWecom });

    expect(menus).toEqual([{ title: sourceTitle(), labels: sourceLabels(), separators: [WECOM_SECTION_INDEX] }]);
    expectCleanHandoff(wizard, {});
    expect(wizard.handOffToWecom).toHaveBeenCalledWith(mode);
    expect(process.exitCode).toBe(7);
  });

  it.each(['qr', 'manual'] as const)('多机器人「添加机器人」（%s）：bots.json 原样不动、不留 .bak', async mode => {
    writeFileSync(BOTS_JSON, BOT_FIXTURE);
    const before = configFiles();
    scriptChoices({ [actionTitle()]: [0], [sourceTitle()]: [WECOM_PICK[mode]] });
    const wizard = fakeWecomWizard(0);

    await cmdSetup({ handOffToWecom: wizard.handOffToWecom });

    expect(menus.map(menu => menu.title)).toEqual([actionTitle(), sourceTitle()]);
    expect(menus[1]).toMatchObject({ labels: sourceLabels(), separators: [WECOM_SECTION_INDEX] });
    expectCleanHandoff(wizard, before);
    expect(wizard.handOffToWecom).toHaveBeenCalledWith(mode);
    expect(process.exitCode).toBe(0);
  });

  it.each(['qr', 'manual'] as const)('.env「添加机器人」（%s）：不迁移 .env、不建 bots.json、不留 .env.bak', async mode => {
    writeFileSync(ENV, ENV_FIXTURE);
    const before = configFiles();
    scriptChoices({ [actionTitle()]: [0], [sourceTitle()]: [WECOM_PICK[mode]] });
    const wizard = fakeWecomWizard(2);

    await cmdSetup({ handOffToWecom: wizard.handOffToWecom });

    expect(menus[1]).toMatchObject({ labels: sourceLabels(), separators: [WECOM_SECTION_INDEX] });
    expectCleanHandoff(wizard, before);
    expect(wizard.handOffToWecom).toHaveBeenCalledWith(mode);
    expect(process.exitCode).toBe(2);
  });

  it('向导里切换过的界面语言原样带进企微向导', async () => {
    writeFileSync(BOTS_JSON, BOT_FIXTURE);
    // 在操作菜单里按 L：真选择器做的就是 setDefaultLocale（另有持久化，这里不需要）。
    scriptChoices({ [actionTitle('zh')]: [0], [sourceTitle('en')]: [WECOM_PICK.manual] }, title => {
      if (title === actionTitle('zh')) setDefaultLocale('en');
    });
    const wizard = fakeWecomWizard(0);

    await cmdSetup({ handOffToWecom: wizard.handOffToWecom });

    expect(menus[1]).toMatchObject({ title: sourceTitle('en'), labels: sourceLabels('en') });
    expect(wizard.handOffToWecom).toHaveBeenCalledWith('manual');
    expect(wizard.seen.locale).toBe('en');
  });
});

describe('其余场合来源菜单仍只有四项', () => {
  it.each([
    { name: '多机器人「重新配置」', seed: () => writeFileSync(BOTS_JSON, BOT_FIXTURE), action: 3 },
    { name: '.env「覆盖当前配置」', seed: () => writeFileSync(ENV, ENV_FIXTURE), action: 1 },
    { name: '.env 缺凭据的「添加机器人」兜底', seed: () => writeFileSync(ENV, 'CLI_ID=claude-code\n'), action: 0 },
  ])('$name（交互终端）', async ({ seed, action }) => {
    seed();
    const before = configFiles();
    scriptChoices({ [actionTitle()]: [action], [sourceTitle()]: [null] });
    const wizard = fakeWecomWizard(0);

    await cmdSetup({ handOffToWecom: wizard.handOffToWecom });

    expect(menus.map(menu => menu.title)).toEqual([actionTitle(), sourceTitle()]);
    expect(menus[1]).toMatchObject({ labels: sourceLabels().slice(0, SOURCE_COUNT), separators: [] });
    expect(wizard.handOffToWecom).not.toHaveBeenCalled();
    expect(configFiles()).toEqual(before);
  });

  it('首次配置但不是交互终端（管道输入）', async () => {
    setTty(false);
    scriptChoices({ [sourceTitle()]: [null] });
    const wizard = fakeWecomWizard(0);

    await cmdSetup({ handOffToWecom: wizard.handOffToWecom });

    expect(menus).toEqual([{ title: sourceTitle(), labels: sourceLabels().slice(0, SOURCE_COUNT), separators: [] }]);
    expect(wizard.handOffToWecom).not.toHaveBeenCalled();
  });

  it('首次配置但显式 --platform feishu|lark', async () => {
    scriptChoices({ [sourceTitle()]: [null] });
    const wizard = fakeWecomWizard(0);

    await cmdSetup({ platform: 'lark', handOffToWecom: wizard.handOffToWecom });

    expect(menus).toEqual([{ title: sourceTitle(), labels: sourceLabels().slice(0, SOURCE_COUNT), separators: [] }]);
    expect(wizard.handOffToWecom).not.toHaveBeenCalled();
  });
});
