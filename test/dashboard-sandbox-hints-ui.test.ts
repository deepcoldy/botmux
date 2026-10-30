/**
 * Dashboard 文件沙盒相关的提示与确认：
 *   - Bot 配置页切到白名单隔离 / scratch 先弹确认，取消不保存；切回关闭不弹
 *   - 零注入不支持时按具体原因给出说明
 *   - 开了沙盒的 bot 在「动态单卡」旁提示不生效
 *   - 独立 CODEX_HOME 的 config.toml：亮出路径，「从宿主重新同步」先确认再 POST
 *   - 会话行：冻结沙盒与当前配置不一致时出徽标
 *   - Skill 更新成功后提示运行中的会话需 /restart
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmMock = vi.fn<(options: { title: string; message: string }) => Promise<boolean>>();
vi.mock('../src/dashboard/web/confirm-modal.js', async () => {
  const actual = await vi.importActual<typeof import('../src/dashboard/web/confirm-modal.js')>('../src/dashboard/web/confirm-modal.js');
  return { ...actual, confirm: (options: any) => confirmMock(options) };
});

import {
  CardBehaviorSection,
  CodexIsolatedConfigInfo,
  PromptInjectionSection,
  SandboxSection,
} from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';
import { SandboxDriftChip } from '../src/dashboard/web/session-sandbox-drift-chip.js';
import { runSkillUpdate } from '../src/dashboard/web/skills-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type FetchCall = { url: string; method: string; body?: string };
let calls: FetchCall[];
let responder: (call: FetchCall) => { status?: number; body: unknown };

beforeEach(() => {
  calls = [];
  responder = () => ({ body: { ok: true } });
  confirmMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  act(() => { for (const view of mounted.splice(0)) view.unmount(); });
});
function mount(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let view!: TestRenderer.ReactTestRenderer;
  act(() => { view = TestRenderer.create(element); });
  mounted.push(view);
  return view;
}
const bot = (over: Partial<BotDefaultsRow>): BotDefaultsRow => ({ larkAppId: 'app_a', ...over } as BotDefaultsRow);
const sandboxPuts = () => calls.filter(c => c.method === 'PUT' && c.url === '/api/bots/app_a/sandbox');

describe('SandboxSection — confirm before switching the sandbox on', () => {
  async function click(view: TestRenderer.ReactTestRenderer, action: string): Promise<void> {
    await act(async () => { await view.root.findByProps({ 'data-action': action }).props.onClick(); });
  }

  it.each(['oncall', 'scratch'] as const)('cancelling the %s confirm saves nothing and keeps the old mode', async (mode) => {
    confirmMock.mockResolvedValue(false);
    const patchBot = vi.fn();
    const view = mount(React.createElement(SandboxSection, { bot: bot({ sandboxMode: 'off', scratchSupported: true }), patchBot }));
    await click(view, `sandbox-mode-${mode}`);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(sandboxPuts()).toEqual([]);
    expect(patchBot).not.toHaveBeenCalled();
    expect(view.root.findByProps({ 'data-action': 'sandbox-mode-off' }).props['aria-pressed']).toBe(true);
  });

  it.each(['oncall', 'scratch'] as const)('confirming %s saves exactly that mode', async (mode) => {
    confirmMock.mockResolvedValue(true);
    responder = () => ({ body: { ok: true, sandbox: true, mode } });
    const patchBot = vi.fn();
    const view = mount(React.createElement(SandboxSection, { bot: bot({ sandboxMode: 'off', scratchSupported: true }), patchBot }));
    await click(view, `sandbox-mode-${mode}`);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(sandboxPuts()).toHaveLength(1);
    expect(JSON.parse(sandboxPuts()[0]!.body!)).toMatchObject({ mode });
    expect(patchBot).toHaveBeenCalledWith('app_a', expect.objectContaining({ sandboxMode: mode }));
  });

  it('the oncall and scratch dialogs explain different things', async () => {
    confirmMock.mockResolvedValue(false);
    const view = mount(React.createElement(SandboxSection, { bot: bot({ sandboxMode: 'off', scratchSupported: true }), patchBot: vi.fn() }));
    await click(view, 'sandbox-mode-oncall');
    await click(view, 'sandbox-mode-scratch');
    const [oncall, scratch] = confirmMock.mock.calls.map(([options]) => options);
    expect(oncall!.message).not.toBe(scratch!.message);
    expect(oncall!.title).not.toBe(scratch!.title);
  });

  it('switching off saves immediately without a dialog', async () => {
    const view = mount(React.createElement(SandboxSection, { bot: bot({ sandboxMode: 'oncall' }), patchBot: vi.fn() }));
    await click(view, 'sandbox-mode-off');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(JSON.parse(sandboxPuts()[0]!.body!)).toEqual({ mode: 'off' });
  });

  it('re-picking the current mode or changing scratch storage does not ask again', async () => {
    const view = mount(React.createElement(SandboxSection, { bot: bot({ sandboxMode: 'scratch', scratchSupported: true }), patchBot: vi.fn() }));
    await click(view, 'sandbox-mode-scratch');
    await click(view, 'scratch-storage-disk');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(sandboxPuts()).toHaveLength(2);
  });
});

describe('PromptInjectionSection — reason-specific unsupported note', () => {
  it.each([
    [{ cliId: 'gemini' }, 'cli_unsupported'],
    [{ cliId: 'cursor', sandboxMode: 'scratch' as const }, 'scratch_unsupported_for_cli'],
    [{ cliId: 'antigravity', backendType: 'zmx' }, 'zmx_unsupported_for_antigravity'],
  ])('%j → %s', (over, reason) => {
    const view = mount(React.createElement(PromptInjectionSection, { bot: bot({ promptInjection: 'default', ...over }), patchBot: vi.fn() }));
    const note = view.root.findByProps({ 'data-zero-prompt-unsupported': reason });
    expect(note).toBeTruthy();
  });

  it('each reason renders its own sentence, and a supported CLI renders none of them', () => {
    const texts = (['gemini', 'cursor', 'antigravity'] as const).map((cliId, i) => {
      const over = [{}, { sandboxMode: 'scratch' as const }, { backendType: 'zmx' }][i];
      const view = mount(React.createElement(PromptInjectionSection, { bot: bot({ cliId, promptInjection: 'default', ...over }), patchBot: vi.fn() }));
      return JSON.stringify(view.root.findByProps({ className: 'bd-section-note' }).props.children);
    });
    expect(new Set(texts).size).toBe(3);
    const ok = mount(React.createElement(PromptInjectionSection, { bot: bot({ cliId: 'claude-code', promptInjection: 'default' }), patchBot: vi.fn() }));
    expect(ok.root.findAll(node => node.props['data-zero-prompt-unsupported'] !== undefined && typeof node.type === 'string')).toEqual([]);
  });
});

describe('CardBehaviorSection — dynamic single card under a sandbox', () => {
  const render = (over: Partial<BotDefaultsRow>) => mount(React.createElement(CardBehaviorSection, {
    bot: bot(over),
    putCardPref: vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } })),
  }));
  const blocked = (view: TestRenderer.ReactTestRenderer) =>
    view.root.findAll(node => typeof node.type === 'string' && node.props['data-reply-card-sandbox-blocked'] !== undefined);

  it.each([
    [{ sandboxMode: 'oncall' as const }],
    [{ sandboxMode: 'scratch' as const }],
    [{ sandbox: true }],
    [{ sandboxMode: 'off' as const, readIsolation: true }],
  ])('%j shows the not-effective note', (over) => {
    expect(blocked(render(over))).toHaveLength(1);
  });

  it.each([
    [{ sandboxMode: 'off' as const }],
    [{}],
  ])('%j shows nothing extra', (over) => {
    expect(blocked(render(over))).toHaveLength(0);
  });
});

describe('CodexIsolatedConfigInfo — isolated config.toml path + re-sync', () => {
  const INFO = {
    ok: true, isolated: true, path: '/srv/bots/app_a/codex/config.toml', exists: true,
    hostPath: '/home/u/.codex/config.toml', hostExists: true,
  };
  async function mountInfo(info: Record<string, unknown>): Promise<TestRenderer.ReactTestRenderer> {
    responder = call => call.method === 'GET' ? { body: info } : { body: { ok: true, backupPath: '/srv/bots/app_a/codex/config.toml.bak-x' } };
    const view = mount(React.createElement(CodexIsolatedConfigInfo, { bot: bot({ cliId: 'codex', sandboxMode: 'oncall' }) }));
    await act(async () => { await Promise.resolve(); });
    return view;
  }
  const posts = () => calls.filter(c => c.method === 'POST');
  const resyncButton = (view: TestRenderer.ReactTestRenderer) => view.root.findByProps({ 'data-action': 'codex-config-resync' });

  it('shows the per-bot path for an isolated Codex home', async () => {
    const view = await mountInfo(INFO);
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/bots/app_a/codex-config' });
    expect(view.root.findByProps({ 'data-codex-config-path': '' }).props.children).toBe(INFO.path);
  });

  it('renders nothing when new sessions use the shared ~/.codex', async () => {
    const view = await mountInfo({ ...INFO, isolated: false });
    expect(view.toJSON()).toBeNull();
  });

  it('cancelling the confirm sends no request', async () => {
    confirmMock.mockResolvedValue(false);
    const view = await mountInfo(INFO);
    await act(async () => { await resyncButton(view).props.onClick(); });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });

  it('confirming POSTs the resync and reports the backup', async () => {
    confirmMock.mockResolvedValue(true);
    const view = await mountInfo(INFO);
    await act(async () => { await resyncButton(view).props.onClick(); });
    expect(posts()).toEqual([expect.objectContaining({ url: '/api/bots/app_a/codex-config/resync' })]);
    const status = view.root.findByProps({ 'data-codex-config-status': '' });
    expect(JSON.stringify(status.props)).toContain('/srv/bots/app_a/codex/config.toml.bak-x');
  });

  it('surfaces a daemon error (host config missing) as a failed status', async () => {
    confirmMock.mockResolvedValue(true);
    const view = await mountInfo(INFO);
    responder = call => call.method === 'GET' ? { body: INFO } : { status: 404, body: { ok: false, error: 'host_config_missing' } };
    await act(async () => { await resyncButton(view).props.onClick(); });
    expect(JSON.stringify(view.root.findByProps({ 'data-codex-config-status': '' }).props)).toContain(INFO.hostPath);
  });
});

describe('SandboxDriftChip', () => {
  it('renders only for rows that carry sandboxDrift, naming both modes in its tooltip', () => {
    expect(mount(React.createElement(SandboxDriftChip, { row: {} })).toJSON()).toBeNull();
    const view = mount(React.createElement(SandboxDriftChip, { row: { sandboxDrift: { session: 'scratch', current: 'off' } } }));
    const chip = view.root.findByProps({ 'data-sandbox-drift': '' });
    const swapped = mount(React.createElement(SandboxDriftChip, { row: { sandboxDrift: { session: 'off', current: 'scratch' } } }));
    expect(chip.props.title).not.toBe(swapped.root.findByProps({ 'data-sandbox-drift': '' }).props.title);
  });
});

describe('runSkillUpdate', () => {
  const tr = (key: string) => `<${key}>`;
  const deps = (over: Partial<Parameters<typeof runSkillUpdate>[1]> = {}) => ({
    request: vi.fn(async () => ({ job: { id: 'j1', status: 'running' } })),
    waitForJob: vi.fn(async (job: any) => ({ ...job, status: 'succeeded' })),
    isMounted: () => true,
    setStatus: vi.fn(),
    tr,
    ...over,
  });

  it('after a successful update tells the user running sessions need /restart', async () => {
    const d = deps();
    await runSkillUpdate('deploy', d);
    expect(d.request).toHaveBeenCalledWith('/api/skills/deploy/update', { method: 'POST', body: '{}' });
    expect(d.setStatus).toHaveBeenLastCalledWith({ text: '<skills.saved> <skills.updateRestartHint>', ok: true });
  });

  it('says nothing more when the page unmounted while waiting', async () => {
    const d = deps({ waitForJob: vi.fn(async () => null) });
    await runSkillUpdate('deploy', d);
    expect(d.setStatus).not.toHaveBeenCalled();
  });

  it('lets a failed job reach the caller (toast) instead of claiming success', async () => {
    const d = deps({ waitForJob: vi.fn(async () => { throw new Error('job_failed'); }) });
    await expect(runSkillUpdate('deploy', d)).rejects.toThrow('job_failed');
    expect(d.setStatus).not.toHaveBeenCalled();
  });
});
