import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectWecomSetupDashboard,
  runWecomQrSetup,
  WecomSetupDashboardNotRunningError,
} from '../src/cli/wecom/setup-wizard.js';
import type { DashboardEndpoint, DashboardResult } from '../src/cli/dashboard-endpoint.js';
import type { WecomSetupClient } from '../src/cli/wecom/onboarding-client.js';
import type { WecomOnboardingSnapshot } from '../src/im/wecom/contract/dashboard-dto.js';
import { getDefaultLocale, setDefaultLocale, shippedText, type Locale } from '../src/i18n/index.js';

const NOT_RUNNING_KEY = 'setup.wecom.dashboard_not_running';
/** Inside a sandbox `botmux start` is refused, so the hint points at the host. */
const SANDBOX_KEY = 'setup.wecom.dashboard_not_running_sandbox';
const jobId = 'wecom-11111111-1111-4111-8111-111111111111';
const initialLocale = getDefaultLocale();

afterEach(() => setDefaultLocale(initialLocale));

function cancelledJob(): WecomOnboardingSnapshot {
  return {
    id: jobId, platform: 'wecom', status: 'cancelled', createdAt: 1, updatedAt: 2, resumeUntil: 3,
    cliId: 'codex', workingDir: '/tmp', externalBotCreated: false, saved: false, retryable: false,
  };
}

/** A host whose Dashboard answers `/__cli/*` with the given sequence (the last
 * entry repeats), plus spies on everything setup could launch or open. */
function hostFixture(options: { hasConfig: boolean; hostProcessesHidden?: boolean; responses: DashboardResult[] }) {
  const responses = [...options.responses];
  const callEndpoint = vi.fn(async (_path: DashboardEndpoint): Promise<DashboardResult> => (
    responses.length > 1 ? responses.shift()! : responses[0]
  ));
  const start = vi.fn(async () => {});
  const client: WecomSetupClient = {
    list: vi.fn(async () => []),
    start: vi.fn(async () => cancelledJob()),
    get: vi.fn(async () => cancelledJob()),
    action: vi.fn(async () => cancelledJob()),
  };
  // Like createWecomSetupClient: only a successful credential result yields a client.
  const createClient = vi.fn(async (result: DashboardResult) => {
    if (!result.ok) throw new Error('fixture: no usable Dashboard credential');
    return client;
  });
  let clock = 0;
  const connect = () => connectWecomSetupDashboard({
    callEndpoint,
    hasConfig: () => options.hasConfig,
    hostProcessesHidden: () => options.hostProcessesHidden ?? false,
    start,
    createClient,
    now: () => clock,
    sleep: async ms => { clock += ms; },
  });
  const output: string[] = [];
  const ask = vi.fn(async () => null);
  const run = (args: string[] = []) => runWecomQrSetup(args, {
    connect,
    tty: true,
    signal: new AbortController().signal,
    prompt: { write: (value: string) => output.push(value), ask },
    sleep: async () => {},
    renderQr: () => {},
  });
  return { callEndpoint, start, client, createClient, connect, output, ask, run };
}

describe('企微扫码 setup 在 Dashboard 没有运行时不代起任何服务', () => {
  it.each([
    { hasConfig: true, hostProcessesHidden: false, reason: 'unreachable', hint: NOT_RUNNING_KEY },
    { hasConfig: true, hostProcessesHidden: false, reason: 'no-secret', hint: NOT_RUNNING_KEY },
    { hasConfig: false, hostProcessesHidden: true, reason: 'unreachable', hint: SANDBOX_KEY },
    { hasConfig: true, hostProcessesHidden: true, reason: 'unreachable', hint: SANDBOX_KEY },
  ] as const)('已有配置=$hasConfig、沙箱=$hostProcessesHidden、$reason：不启动 supervisor，以「Dashboard 未运行」失败并提示 $hint', async ({ hasConfig, hostProcessesHidden, reason, hint }) => {
    const host = hostFixture({ hasConfig, hostProcessesHidden, responses: [{ ok: false, reason }] });

    await expect(host.connect()).rejects.toBeInstanceOf(WecomSetupDashboardNotRunningError);
    const exitCode = await host.run();

    expect(host.start).not.toHaveBeenCalled();
    expect(host.createClient).not.toHaveBeenCalled();
    expect(host.ask).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(host.output).toEqual([shippedText(hint)]);
  });

  it.each([
    { locale: 'zh', hostProcessesHidden: false, hint: NOT_RUNNING_KEY },
    { locale: 'en', hostProcessesHidden: false, hint: NOT_RUNNING_KEY },
    { locale: 'zh', hostProcessesHidden: true, hint: SANDBOX_KEY },
    { locale: 'en', hostProcessesHidden: true, hint: SANDBOX_KEY },
  ] as const)('提示走 i18n 字典（$locale，沙箱=$hostProcessesHidden）', async ({ locale, hostProcessesHidden, hint }) => {
    setDefaultLocale(locale as Locale);
    const host = hostFixture({ hasConfig: true, hostProcessesHidden, responses: [{ ok: false, reason: 'unreachable' }] });

    expect(await host.run()).toBe(1);
    expect(host.output).toEqual([shippedText(hint, locale)]);
    expect(shippedText(hint, 'en')).not.toBe(shippedText(hint, 'zh'));
    // The two hints must stay distinct, or the sandbox branch would be decorative.
    expect(shippedText(SANDBOX_KEY, locale)).not.toBe(shippedText(NOT_RUNNING_KEY, locale));
  });

  it('Dashboard 应答但拒绝鉴权：不启动、不报「未运行」，按向导通用失败退出', async () => {
    const host = hostFixture({ hasConfig: true, responses: [{ ok: false, reason: 'auth-failed' }] });

    const exitCode = await host.run();

    expect(host.start).not.toHaveBeenCalled();
    expect(exitCode).toBe(2);
    expect(host.output).not.toContain(shippedText(NOT_RUNNING_KEY));
  });

  it('未配置主机仍走首次使用自启：只启动一次，就绪后照常进入向导', async () => {
    const ready: DashboardResult = { ok: true, url: 'http://127.0.0.1:7891/?t=fixture_token_0123456789' };
    const host = hostFixture({ hasConfig: false, responses: [{ ok: false, reason: 'unreachable' }, ready] });

    const exitCode = await host.run(['--cancel', jobId]);

    expect(host.start).toHaveBeenCalledTimes(1);
    expect(host.createClient).toHaveBeenCalledExactlyOnceWith(ready);
    expect(host.client.action).toHaveBeenCalledExactlyOnceWith(jobId, 'cancel');
    expect(exitCode).toBe(0);
  });

  it('首次使用已启动但始终未就绪：不误报「setup 不会代为启动」', async () => {
    const host = hostFixture({ hasConfig: false, responses: [{ ok: false, reason: 'unreachable' }] });

    const exitCode = await host.run();

    expect(host.start).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(2);
    expect(host.output).not.toContain(shippedText(NOT_RUNNING_KEY));
  });
});
