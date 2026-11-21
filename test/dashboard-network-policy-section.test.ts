/**
 * Bot 配置页的目标 IP 网络策略区块，以及它在其它区块上留下的报错：
 *  - 未配置时的起始模板带宿主 nameserver（缺 dnsServers 的策略在沙盒里没有 DNS），
 *    会话继承代理变量时带 trusted-egress（否则会话起不来）；
 *  - 「是否支持」按新会话实际的后端判断：没有覆盖时是 daemon 默认后端（tmux）；
 *  - 保存回包里的 warnings 显示出来；清除按钮把文本换回模板；
 *  - 配了策略后切沙盒模式被 bots.json 不变量拒绝时，显示人话而不是错误码。
 */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { NetworkPolicySection, SandboxSection, networkPolicyTemplate, networkPolicyUnsupported } from '../src/dashboard/web/bot-defaults-page.js';
import { configErrorText } from '../src/dashboard/web/bot-defaults-save.js';
import { t } from '../src/dashboard/web/ui.js';

// 切沙盒模式现在先弹确认框（沙盒切换确认）。下面的用例既不渲染确认框也不去点它，
// 而 confirm() 在无人 settle 时返回永不 resolve 的 Promise，会让 selectMode 卡在
// await、PUT 发不出去。测试关心的是「确认之后策略拦截的报错」，故直接确认通过，
// 与 dashboard-sandbox-hints-ui.test.ts 同一写法；产品行为（确认后仍看到拦截提示）不变。
vi.mock('../src/dashboard/web/confirm-modal.js', async () => {
  const actual = await vi.importActual<any>('../src/dashboard/web/confirm-modal.js');
  return { ...actual, confirm: () => Promise.resolve(true) };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SUPPORTED = { cliId: 'claude-code', sandboxNetworkPolicyPlatform: 'linux', backendType: 'pty', sandboxMode: 'oncall' as const, sandbox: true };

function render(component: any, bot: Record<string, unknown>, responses: Array<{ status?: number; body: Record<string, unknown> }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
    const next = responses.shift() ?? { body: { ok: true } };
    const status = next.status ?? 200;
    return { ok: status < 400, status, json: async () => next.body };
  }) as unknown as typeof fetch;
  const patchBot = vi.fn();
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => { renderer = TestRenderer.create(createElement(component, { bot: { larkAppId: 'cli_net', ...bot }, patchBot })); });
  return {
    root: renderer!.root,
    calls,
    patchBot,
    text: () => JSON.stringify(renderer!.toJSON()),
    unmount() { act(() => renderer!.unmount()); globalThis.fetch = previousFetch; },
  };
}

describe('networkPolicyTemplate / networkPolicyUnsupported', () => {
  it('starts from the host nameservers, and trusted-egress only when sessions inherit a proxy', () => {
    expect(networkPolicyTemplate({ sandboxNetworkHostDns: ['10.0.0.53'], sandboxNetworkProxyEnv: [] }))
      .toEqual({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' }, dnsServers: ['10.0.0.53'] });
    expect(networkPolicyTemplate({ sandboxNetworkHostDns: [], sandboxNetworkProxyEnv: ['HTTPS_PROXY'] }))
      .toEqual({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' }, proxyMode: 'trusted-egress' });
    // An older daemon without these fields: the previous template.
    expect(networkPolicyTemplate({})).toEqual({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' } });
  });

  it('judges support on the backend new sessions launch on', () => {
    expect(networkPolicyUnsupported(SUPPORTED)).toBeUndefined();
    expect(networkPolicyUnsupported({ ...SUPPORTED, backendType: null, defaultBackendType: 'tmux' }))
      .toEqual({ key: 'botDefaults.networkUnsupportedBackend', params: { backend: 'tmux' } });
    expect(networkPolicyUnsupported({ ...SUPPORTED, backendType: null, defaultBackendType: 'pty' })).toBeUndefined();
    // A remote CLI dictates its own backend even when the daemon default is pty.
    expect(networkPolicyUnsupported({ ...SUPPORTED, cliId: 'riff', backendType: null, defaultBackendType: 'pty' }))
      .toEqual({ key: 'botDefaults.networkUnsupportedBackend', params: { backend: 'riff' } });
    // A local CLI whose daemon default is remote is paired back onto pty.
    expect(networkPolicyUnsupported({ ...SUPPORTED, cliId: 'claude-code', backendType: null, defaultBackendType: 'riff' })).toBeUndefined();
    expect(networkPolicyUnsupported({ ...SUPPORTED, sandboxMode: 'scratch' })?.params).toEqual({ mode: 'scratch' });
    expect(networkPolicyUnsupported({ ...SUPPORTED, sandboxMode: null, sandbox: true })).toBeUndefined();
    expect(networkPolicyUnsupported({ ...SUPPORTED, sandboxNetworkPolicyPlatform: 'darwin' })?.key).toBe('botDefaults.networkUnsupportedPlatform');
  });
});

describe('NetworkPolicySection', () => {
  it('fills the editor with the template and disables it where new sessions cannot enforce a policy', () => {
    const h = render(NetworkPolicySection, { ...SUPPORTED, backendType: null, defaultBackendType: 'tmux', sandboxNetworkHostDns: ['10.0.0.53'] }, []);
    try {
      const textarea = h.root.findByType('textarea');
      expect(JSON.parse(textarea.props.value).dnsServers).toEqual(['10.0.0.53']);
      expect(textarea.props.disabled).toBe(true);
      expect(h.root.findByProps({ 'data-action': 'save-network-policy' }).props.disabled).toBe(true);
      expect(h.root.findByProps({ 'data-network-support': 'no' }).children.join('')).toContain('tmux');
    } finally { h.unmount(); }
  });

  it('shows the warnings the daemon returns with a successful save', async () => {
    const saved = { version: 1, public: { mode: 'allow' }, private: { mode: 'block' } };
    const h = render(NetworkPolicySection, { ...SUPPORTED, sandboxNetworkProxyEnv: ['HTTPS_PROXY'] }, [
      { body: { ok: true, sandboxNetworkPolicy: saved, warnings: ['dns_servers_missing', 'proxy_requires_trusted_egress'] } },
    ]);
    try {
      expect(h.root.findAllByProps({ 'data-network-proxy-env': '' })).toHaveLength(1);
      await act(async () => { await h.root.findByProps({ 'data-action': 'save-network-policy' }).props.onClick(); });
      expect(h.calls[0]!.url).toBe('/api/bots/cli_net/sandbox-network-policy');
      expect(h.patchBot).toHaveBeenCalledWith('cli_net', { sandboxNetworkPolicy: saved });
      const shown = h.root.findAll(node => typeof node.props['data-network-warning'] === 'string').map(node => node.props['data-network-warning']);
      expect(shown).toEqual(['dns_servers_missing', 'proxy_requires_trusted_egress']);
      expect(h.text()).toContain(t('botDefaults.networkWarnNoDns'));
    } finally { h.unmount(); }
  });

  it('clearing resets the editor to the template', async () => {
    const stored = { version: 1, public: { mode: 'block' }, private: { mode: 'block' }, dnsServers: ['10.9.9.9'] };
    const h = render(NetworkPolicySection, { ...SUPPORTED, sandboxNetworkPolicy: stored, sandboxNetworkHostDns: ['10.0.0.53'] }, [
      { body: { ok: true, sandboxNetworkPolicy: null, warnings: [] } },
    ]);
    try {
      expect(JSON.parse(h.root.findByType('textarea').props.value)).toEqual(stored);
      await act(async () => { await h.root.findByProps({ 'data-action': 'clear-network-policy' }).props.onClick(); });
      expect(h.calls[0]!.body).toEqual({ policy: null });
      expect(JSON.parse(h.root.findByType('textarea').props.value).dnsServers).toEqual(['10.0.0.53']);
    } finally { h.unmount(); }
  });
});

describe('network policy invariant on other sections', () => {
  it('translates the invariant codes and leaves other errors untouched', () => {
    for (const code of ['sandbox_network_policy_requires_local_pty_oncall', 'invalid_sandbox_network_policy']) {
      const text = configErrorText({ ok: false, status: 400, body: { ok: false, error: code } }, t);
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/^botDefaults\./);
    }
    expect(configErrorText({ ok: false, status: 409, body: { ok: false, error: 'codex_browser_config_conflict' } }, t)).toBe('codex_browser_config_conflict');
  });

  it('switching the sandbox mode with a policy configured explains how to proceed', async () => {
    const h = render(SandboxSection, { ...SUPPORTED, sandboxNetworkPolicy: { version: 1, public: { mode: 'allow' }, private: { mode: 'block' } } }, [
      { status: 400, body: { ok: false, error: 'sandbox_network_policy_requires_local_pty_oncall' } },
    ]);
    try {
      await act(async () => { await h.root.findByProps({ 'data-action': 'sandbox-mode-scratch' }).props.onClick(); });
      const status = h.root.findByProps({ 'data-sandbox-status': '' });
      expect(status.children.join('')).toBe(`✗ ${t('botDefaults.networkPolicyBlocksChange')}`);
    } finally { h.unmount(); }
  });
});
