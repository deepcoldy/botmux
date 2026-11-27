/**
 * 交互式 `botmux setup` 的「飞书应用来源」末尾的企业微信分区。
 *
 * - 判定（入口语义 × 是否交互终端）是纯函数 `offersWecomSetupSource`；只有「再加一个
 *   机器人」的入口、且 stdin 与 stdout 都是 TTY 时才出现。
 * - `obtainCredentials` 只在调用方显式打开 `offerWecom` 时才多出这个分区：一行不可选的
 *   「企业微信」分隔，再是「扫码创建新机器人」「手动输入 BotID/Secret」。选中其一只是把
 *   「交给企微」连同接入方式交还调用方，不走任何飞书来源、不写盘。不打开时菜单仍是四项。
 *
 * vitest 的 stdin/stdout 不是 TTY，pickChoice 走「序号文本输入」回退分支（分隔行不编号，
 * 企微两项接着四项来源（飞书三项 +「仅本地机器人」）编为 5、6），菜单选择从假 readline 的答案队列里取，菜单本身打在
 * process.stdout 上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  tryRegisterApp: vi.fn(),
  createFeishuOpenPlatformApp: vi.fn(),
  inspectCachedFeishuOpenPlatformSession: vi.fn(),
  readStoredCookiesFromSessionFile: vi.fn(),
  prepareFeishuWebSession: vi.fn(),
}));

// 只替换会打网络的飞书来源出口：选「企业微信机器人」时一个都不该被碰到。
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
}));

import { obtainCredentials } from '../src/cli.js';
import { offersWecomSetupSource, type SetupSourceEntry } from '../src/setup/platform-entry.js';
import { getDefaultLocale, setDefaultLocale, shippedText, type Locale } from '../src/i18n/index.js';

const CONFIG_DIR = join(homedir(), '.botmux');
const initialLocale = getDefaultLocale();

/** 假 readline：按队列吐答案，并记下每次提问（非 TTY 菜单的「选择 (1-N)」提示就在这里）。 */
function fakeRl(answers: string[]) {
  const questions: string[] = [];
  const self: any = {
    questions,
    question(q: string, cb: (answer: string) => void) { questions.push(q); cb(answers.shift() ?? ''); },
    once() { return self; },
    off() { return self; },
    on() { return self; },
  };
  return self;
}

let stdout = '';
beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.inspectCachedFeishuOpenPlatformSession.mockResolvedValue({ ok: false, reason: 'missing_session', message: 'none' });
  mocks.readStoredCookiesFromSessionFile.mockReturnValue([]);
  mocks.createFeishuOpenPlatformApp.mockRejectedValue(new Error('飞书来源不应被调用'));
  mocks.tryRegisterApp.mockRejectedValue(new Error('飞书来源不应被调用'));
  mocks.prepareFeishuWebSession.mockRejectedValue(new Error('飞书来源不应被调用'));
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
});

afterEach(() => {
  vi.restoreAllMocks();
  setDefaultLocale(initialLocale);
});

/** 非 TTY 菜单里第 n 项（1 起）的那一行。 */
function menuLine(n: number, labelKey: string, locale: Locale): string {
  return `  ${n}) ${shippedText(labelKey, locale)}`;
}

describe('offersWecomSetupSource：哪些入口在来源菜单里给出企业微信', () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };

  it.each<SetupSourceEntry>(['first-run', 'add-bot', 'env-add-bot'])('新增机器人的入口 + 交互终端 → 显示：%s', entry => {
    expect(offersWecomSetupSource(entry, tty)).toBe(true);
  });

  it.each<SetupSourceEntry>(['reconfigure', 'env-overwrite', 'env-missing-credentials'])(
    '替换飞书配置 / 补齐 .env 的入口即使在交互终端也不显示：%s',
    entry => {
      expect(offersWecomSetupSource(entry, tty)).toBe(false);
    },
  );

  it.each([
    { stdinIsTTY: false, stdoutIsTTY: true },
    { stdinIsTTY: true, stdoutIsTTY: false },
    { stdinIsTTY: undefined, stdoutIsTTY: undefined },
  ])('stdin 或 stdout 不是 TTY（管道输入）时任何入口都不显示：%o', terminal => {
    for (const entry of ['first-run', 'add-bot', 'env-add-bot', 'reconfigure', 'env-overwrite', 'env-missing-credentials'] as const) {
      expect(offersWecomSetupSource(entry, terminal)).toBe(false);
    }
  });
});

describe('obtainCredentials 的企业微信分区', () => {
  it.each([
    { locale: 'zh' as Locale, answer: '5', mode: 'qr' },
    { locale: 'en' as Locale, answer: '5', mode: 'qr' },
    { locale: 'zh' as Locale, answer: '6', mode: 'manual' },
    { locale: 'en' as Locale, answer: '6', mode: 'manual' },
  ])('打开 offerWecom：四项来源 + 分隔行 + 企微两项，选 $answer 即以 $mode 交给企微、不碰飞书来源、不写盘（$locale）', async ({ locale, answer, mode }) => {
    setDefaultLocale(locale);
    const rl = fakeRl([answer]);

    const creds = await obtainCredentials(rl, { offerWecom: true });

    expect(creds).toEqual({ ok: false, reason: 'wecom', mode });
    // 菜单结构：飞书三项（1-3）+「仅本地机器人」（4）→ 一行不带序号的「企业微信」分隔 → 企微两项（5、6）。
    const menu = stdout.slice(stdout.indexOf(shippedText('setup.credentials.source_title', locale))).split('\n');
    const at = (text: string) => menu.findIndex(line => line.startsWith(text));
    const feishuManual = at(menuLine(3, 'setup.credentials.manual', locale));
    const section = menu.findIndex(line => line.includes(shippedText('setup.platform.source_wecom_section', locale)));
    const qr = at(menuLine(5, 'setup.platform.source_wecom_qr', locale));
    const manual = at(menuLine(6, 'setup.platform.source_wecom_manual', locale));
    expect(feishuManual).toBeGreaterThan(-1);
    expect(menu[feishuManual + 1]).toMatch(/^ {2}4\) /);
    expect([section, qr, manual]).toEqual([feishuManual + 2, feishuManual + 3, feishuManual + 4]);
    expect(menu[section]).not.toMatch(/\d+\)/);
    // 只问了这一个问题，可选序号上限是 6（分隔行不算）。
    expect(rl.questions).toEqual([
      shippedText('setup.select.choose_prompt', locale).replace('{max}', '6').replace('{default}', ' [1]'),
    ]);
    for (const fn of Object.values(mocks)) expect(fn).not.toHaveBeenCalled();
    expect(existsSync(CONFIG_DIR) ? readdirSync(CONFIG_DIR) : []).toEqual([]);
  });

  it('打开 offerWecom 时默认项仍是第 1 项（回车不会进企微）', async () => {
    mocks.createFeishuOpenPlatformApp.mockResolvedValue({ ok: true, appId: 'cli_default', appSecret: 'default-secret' });

    const creds = await obtainCredentials(fakeRl(['', '']), { offerWecom: true });

    expect(creds.ok && creds.appId).toBe('cli_default');
  });

  it('不打开 offerWecom：菜单只有四项、没有分隔行，输入 5 照旧判为无效并重问，随后的飞书流程不受影响', async () => {
    const rl = fakeRl(['5', '3', '', 'cli_manual', 'manual-secret']);

    const creds = await obtainCredentials(rl);

    expect(creds).toEqual({ ok: true, appId: 'cli_manual', appSecret: 'manual-secret', brand: 'feishu' });
    expect(stdout).toContain(menuLine(3, 'setup.credentials.manual', 'zh'));
    for (const key of ['setup.platform.source_wecom_section', 'setup.platform.source_wecom_qr', 'setup.platform.source_wecom_manual']) {
      expect(stdout).not.toContain(shippedText(key, 'zh'));
    }
    expect(stdout).toContain(shippedText('setup.select.invalid_choice', 'zh').replace('{choice}', '5'));
    // 头两次都是来源菜单的提问（第二次是重问），上限都是 4。
    const sourcePrompt = shippedText('setup.select.choose_prompt', 'zh').replace('{max}', '4').replace('{default}', ' [1]');
    expect(rl.questions.slice(0, 2)).toEqual([sourcePrompt, sourcePrompt]);
  });
});
