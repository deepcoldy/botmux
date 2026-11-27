import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: confirmMock }));

import { BotOnboardingDialog, openBotOnboarding } from '../src/dashboard/web/bot-onboarding.js';
import { t } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { status?: number; body?: unknown } | Error;
type Route = (url: string, init?: RequestInit) => Reply | undefined;

let renderer: TestRenderer.ReactTestRenderer | undefined;
let calls: Array<{ url: string; body?: any }> = [];

function cliOptions(canCreateWecomBot?: boolean): Record<string, unknown> {
  return {
    options: [{ id: 'codex', label: 'Codex', modelChoices: [] }],
    ttadkModelSuggestions: [],
    webSession: { status: 'scan_required' },
    ...(canCreateWecomBot === undefined ? {} : { canCreateWecomBot }),
  };
}

/** 按 URL 路由的 fetch 替身；没路由到的 CLI 探测给一个中性答复。 */
function stubFetch(route: Route): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const reply = route(url, init)
      ?? (url.startsWith('/api/cli-options/') ? { body: { status: 'available', models: [] } } : undefined);
    if (!reply) throw new Error(`unexpected request: ${url}`);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }));
}

function stubWindow(): void {
  // 轮询走 window.setTimeout（企业微信）/ window.setInterval（飞书）；委托给（可能被 fake timers 接管的）全局计时器。
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    dispatchEvent: vi.fn(),
    location: { hash: '' },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function openDialog(): Promise<TestRenderer.ReactTestRenderer> {
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(BotOnboardingDialog, { open: true, onClose: () => undefined }));
  });
  await flush();
  return renderer!;
}

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(child => textOf(child as ReactTestInstance | string)).join('');
}

function buttonsWithText(text: string): ReactTestInstance[] {
  return renderer!.root.findAll(node => node.type === 'button' && textOf(node).trim() === text);
}

/** 企业微信表单独有的「接入方式」单选组：用它判断当前是否在企业微信流程里。 */
function wecomModeRadios(): ReactTestInstance[] {
  return renderer!.root.findAll(node => node.type === 'input' && node.props.name === 'wecom-mode');
}

function feishuForms(): ReactTestInstance[] {
  return renderer!.root.findAll(node => node.type === 'form' && node.props.id === 'onboarding-form');
}

function platformSwitches(): ReactTestInstance[] {
  return renderer!.root.findAll(node => node.type === 'button' && node.props['data-onboarding-platform-switch'] !== undefined);
}

function pollCalls(id: string): number {
  return calls.filter(call => call.url === `/api/bot-onboarding/${id}`).length;
}

function startBodies(): any[] {
  return calls.filter(call => call.url === '/api/bot-onboarding/start').map(call => call.body);
}

async function submitForm(): Promise<void> {
  await act(async () => {
    renderer!.root.findByProps({ id: 'onboarding-form' }).props.onSubmit({ preventDefault() {} });
  });
  await flush();
}

beforeEach(() => {
  calls = [];
  confirmMock.mockClear();
  stubWindow();
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bot creation wizard opens on the Feishu flow', () => {
  it('lands on the Feishu form with no platform chooser and the form first in focus order', async () => {
    stubFetch(url => (url === '/api/cli-options' ? { body: cliOptions(true) } : undefined));
    const dialog = await openDialog();

    expect(feishuForms()).toHaveLength(1);
    expect(wecomModeRadios()).toHaveLength(0);
    expect(dialog.root.findAll(node => node.props['aria-pressed'] !== undefined)).toHaveLength(0);
    expect(textOf(dialog.root.findByType('h3'))).toBe(t('botOnboarding.title'));
    // showModal() 把焦点交给第一个可聚焦元素：它必须是飞书表单本身，旁路入口不能抢在前面。
    const [firstInteractive] = dialog.root.findAll(node => ['input', 'button', 'select', 'textarea'].includes(String(node.type)));
    let ancestor: ReactTestInstance | null = firstInteractive ?? null;
    while (ancestor && !(ancestor.type === 'form' && ancestor.props.id === 'onboarding-form')) ancestor = ancestor.parent;
    expect(ancestor).not.toBeNull();
    expect(firstInteractive?.props['data-onboarding-platform-switch']).toBeUndefined();
  });

  it.each([
    ['declared false', false],
    ['not declared', undefined],
  ])('offers no WeCom entry when canCreateWecomBot is %s', async (_label, canCreate) => {
    stubFetch(url => (url === '/api/cli-options' ? { body: cliOptions(canCreate) } : undefined));
    await openDialog();

    expect(feishuForms()).toHaveLength(1);
    expect(platformSwitches()).toHaveLength(0);
  });

  it('offers no WeCom entry while cloning a Feishu bot', async () => {
    stubFetch(url => (url === '/api/cli-options' ? { body: cliOptions(true) } : undefined));
    await openBotOnboarding('cli_source', { cliId: 'codex' });
    try {
      await openDialog();
      expect(platformSwitches()).toHaveLength(0);
    } finally {
      await openBotOnboarding();
    }
  });

  it('enters the WeCom flow from the side entry and can switch back to Feishu', async () => {
    stubFetch(url => {
      if (url === '/api/cli-options') return { body: cliOptions(true) };
      if (url === '/api/bot-onboarding/wecom-jobs') return { body: { jobs: [] } };
      return undefined;
    });
    await openDialog();
    const [entry] = platformSwitches();
    expect(textOf(entry!)).toBe(t('botOnboarding.switchToWecom'));

    await act(async () => entry!.props.onClick());
    await flush();

    expect(wecomModeRadios()).toHaveLength(2);
    expect(buttonsWithText(t('botOnboarding.wecom.submitQr'))).toHaveLength(1);
    expect(calls.some(call => call.url === '/api/bot-onboarding/wecom-jobs')).toBe(true);

    const [back] = platformSwitches();
    expect(textOf(back!)).toBe(t('botOnboarding.switchToLark'));
    await act(async () => back!.props.onClick());
    await flush();
    expect(wecomModeRadios()).toHaveLength(0);
    expect(feishuForms()).toHaveLength(1);
  });
});

describe('Feishu creation failures stay visible and recoverable', () => {
  it('stops polling on a failed job read and shows retry and compatibility mode', async () => {
    vi.useFakeTimers();
    stubFetch(url => {
      if (url === '/api/cli-options') return { body: cliOptions(false) };
      if (url === '/api/bot-onboarding/start') return { body: { job: { id: 'job-1', status: 'waiting_for_scan' } } };
      if (url === '/api/bot-onboarding/job-1') return { status: 404, body: { error: 'job_not_found' } };
      return undefined;
    });
    const dialog = await openDialog();
    await submitForm();
    expect(dialog.root.findAll(node => node.props.className === 'onboarding-status status-waiting_for_scan')).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    await flush();

    expect(pollCalls('job-1')).toBe(1);
    expect(dialog.root.findAll(node => node.props.className === 'onboarding-status status-failed')).toHaveLength(1);
    expect(buttonsWithText(t('botOnboarding.compatibilityMode'))).toHaveLength(1);
    expect(buttonsWithText(t('botOnboarding.retry'))).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(pollCalls('job-1')).toBe(1);
  });

  it('keeps retry and compatibility mode after a server error, including when the compatibility retry fails too', async () => {
    stubFetch(url => {
      if (url === '/api/cli-options') return { body: cliOptions(false) };
      if (url === '/api/bot-onboarding/start') return { status: 503, body: { error: 'daemon_unavailable' } };
      return undefined;
    });
    const dialog = await openDialog();
    await submitForm();

    expect(dialog.root.findAll(node => node.props.className === 'onboarding-status status-failed')).toHaveLength(1);
    const compat = buttonsWithText(t('botOnboarding.compatibilityMode'));
    expect(compat).toHaveLength(1);

    await act(async () => compat[0]!.props.onClick());
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(startBodies().map(body => body.registrationMode)).toEqual(['web', 'compat']);
    expect(dialog.root.findAll(node => node.props.className === 'onboarding-status status-failed')).toHaveLength(1);
    expect(buttonsWithText(t('botOnboarding.compatibilityMode'))).toHaveLength(1);
  });

  it('shows the failed view with recovery actions when the start request cannot be sent', async () => {
    stubFetch(url => {
      if (url === '/api/cli-options') return { body: cliOptions(false) };
      if (url === '/api/bot-onboarding/start') return new Error('network down');
      return undefined;
    });
    const dialog = await openDialog();
    await submitForm();

    expect(dialog.root.findAll(node => node.props.className === 'onboarding-status status-failed')).toHaveLength(1);
    expect(buttonsWithText(t('botOnboarding.compatibilityMode'))).toHaveLength(1);
  });

  it('returns to the form only for invalid input', async () => {
    stubFetch(url => {
      if (url === '/api/cli-options') return { body: cliOptions(false) };
      if (url === '/api/bot-onboarding/start') return { status: 400, body: { error: 'invalid_input', message: 'workingDir missing' } };
      return undefined;
    });
    const dialog = await openDialog();
    await submitForm();

    expect(feishuForms()).toHaveLength(1);
    expect(textOf(dialog.root.findByProps({ className: 'form-error' }))).toBe('workingDir missing');
  });
});

describe('WeCom creation polling', () => {
  it('shows a failed job read and retries with a growing, bounded back-off', async () => {
    vi.useFakeTimers();
    const pollTimes: number[] = [];
    stubFetch(url => {
      if (url === '/api/cli-options') return { body: cliOptions(true) };
      if (url === '/api/bot-onboarding/wecom-jobs') return { body: { jobs: [] } };
      if (url === '/api/bot-onboarding/start') {
        return { body: { job: { id: 'wecom-1', platform: 'wecom', status: 'waiting_for_scan', createdAt: 1, updatedAt: 1 } } };
      }
      if (url === '/api/bot-onboarding/wecom-1') {
        pollTimes.push(Date.now());
        return { status: 503, body: { error: 'dashboard_restarting' } };
      }
      return undefined;
    });
    const dialog = await openDialog();
    await act(async () => platformSwitches()[0]!.props.onClick());
    await flush();
    await submitForm();
    const submittedAt = Date.now();

    await act(async () => { await vi.advanceTimersByTimeAsync(200_000); });
    await flush();

    // 轮询失败不冒充平台创建失败：任务视图还在，错误显示出来。
    expect(dialog.root.findAll(node => node.props['data-wecom-onboarding-status'] === 'waiting_for_scan')).toHaveLength(1);
    expect(dialog.root.findAll(node => node.props.role === 'alert' && textOf(node) === 'dashboard_restarting')).toHaveLength(1);

    const gaps = pollTimes.slice(1).map((at, index) => at - pollTimes[index]!);
    const normalInterval = pollTimes[0]! - submittedAt;
    expect(gaps.length).toBeGreaterThanOrEqual(4);
    expect(gaps[0]).toBeGreaterThan(normalInterval);
    expect(gaps[1]).toBeGreaterThan(gaps[0]!);
    for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]!);
    // 有上限：退避到顶后间隔不再增长。
    expect(gaps.at(-1)).toBe(gaps.at(-2));
  });
});

describe('creation completion explains where the bot name lives', () => {
  const wecomCompleted = (appName?: string) => ({
    id: 'wecom-done', platform: 'wecom', status: 'completed', createdAt: 1, updatedAt: 2, resumeUntil: 3,
    cliId: 'codex', workingDir: '/tmp', externalBotCreated: true, saved: true, retryable: false, liveStarted: true,
    connectionId: 'fixture-connection', ...(appName === undefined ? {} : { appName }),
  });
  const nameNotes = () => renderer!.root.findAll(node => node.props['data-wecom-name-note'] !== undefined);

  it.each([
    ['a typed display name', 'Fixture Bot'],
    ['no display name', ''],
    ['a whitespace-only display name', '   '],
  ])('WeCom completion with %s says the WeCom-side name and avatar are changed in WeCom', async (_label, appName) => {
    stubFetch(url => {
      if (url === '/api/cli-options') return { body: cliOptions(true) };
      if (url === '/api/bot-onboarding/wecom-jobs') return { body: { jobs: [] } };
      if (url === '/api/bot-onboarding/start') return { body: { job: wecomCompleted(appName) } };
      return undefined;
    });
    await openDialog();
    await act(async () => platformSwitches()[0]!.props.onClick());
    await flush();
    await submitForm();

    expect(renderer!.root.findAll(node => node.props['data-wecom-onboarding-status'] === 'completed')).toHaveLength(1);
    const notes = nameNotes();
    expect(notes).toHaveLength(1);
    const name = appName.trim();
    expect(textOf(notes[0]!)).toBe(name
      ? t('botOnboarding.wecom.completedNameNote', { name })
      : t('botOnboarding.wecom.completedNameNoteUnnamed'));
    if (name) expect(textOf(notes[0]!)).toContain(name);
  });

  it('does not add the note to the Feishu completion view', async () => {
    stubFetch(url => {
      if (url === '/api/cli-options') return { body: cliOptions(true) };
      if (url === '/api/bot-onboarding/start') return { body: { job: { id: 'job-1', status: 'completed', appName: 'Fixture Bot' } } };
      return undefined;
    });
    await openDialog();
    await submitForm();

    expect(renderer!.root.findAll(node => node.props.className === 'onboarding-status status-completed')).toHaveLength(1);
    expect(nameNotes()).toHaveLength(0);
  });
});
