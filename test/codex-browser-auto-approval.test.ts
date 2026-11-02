import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBrowserBroker } from '../src/services/codex-browser-broker.js';

let broker: CodexBrowserBroker | undefined;
afterEach(async () => { await broker?.close(); broker = undefined; });

const origin = {
  codex_approval_kind: 'mcp_tool_call', connector_id: 'browser-use',
  tool_name: 'access_browser_origin', origin: 'https://example.test',
  tool_params: { origin: 'https://example.test' }, persist: 'always',
};
async function setup(autoApproveOrigins?: boolean, decision: 'accept' | 'decline' = 'decline') {
  const requestApproval = vi.fn(async () => ({ action: decision }));
  broker = new CodexBrowserBroker({ sessionId: 's-auto-origin', family: 'chrome', autoApproveOrigins,
    requestApproval, modules: {
      async setupBrowserRuntime() { return { browsers: { async get() { return {
        browserId: 'fake', async nameSession() {},
        tabs: { async get() { throw new Error('unused'); }, async list() { return []; },
          async new() { throw new Error('unused'); }, async selected() { return undefined; } },
        user: { async openTabs() { return []; }, async claimTab() { throw new Error('unused'); } },
      }; } } }; }, async handleRpc() { return {}; },
    } });
  await broker.handleToolCall({ tool: 'botmux_browser', arguments: { operation: 'list_tabs' },
    callId: 'c-origin', threadId: 't-origin', turnId: 'turn-origin' });
  return { requestApproval, ask: (meta: Record<string, unknown>) =>
    (globalThis as any).nodeRepl.createElicitation({ message: 'Browser access', meta }) };
}

describe('bot-config browser origin delegation', () => {
  it.each([undefined, false])('asks by default (%s)', async setting => {
    const h = await setup(setting);
    expect(await h.ask(origin)).toEqual({ action: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledOnce();
  });
  it.each(['https://example.test', 'http://localhost:8080'])('accepts only a session grant for %s', async site => {
    const h = await setup(true);
    const response = await h.ask({ ...origin, origin: site, tool_params: { origin: site } });
    expect(response).toEqual({ action: 'accept', meta: {
      approval_channel: 'bot-config', approval_scope: 'browser-origin', persist: 'session',
    } });
    expect(h.requestApproval).not.toHaveBeenCalled();
  });
  it.each([
    { risk_level: 'low' }, { risk_level: 'medium' },
    { riskLevel: 'low' }, { riskLevel: 'medium' },
    { risk_level: 'low', riskLevel: 'medium' },
  ])('accepts explicit ordinary risk labels: %j', async risk => {
    const h = await setup(true);
    expect((await h.ask({ ...origin, ...risk })).action).toBe('accept');
    expect(h.requestApproval).not.toHaveBeenCalled();
  });
  it.each(['risk_level', 'riskLevel'])('rejects nonordinary values in %s', async key => {
    for (const value of ['high', 'critical', 'CRITICAL', 'LOW', 'very_high', '', 0, 1, null, false, [], {}]) {
      const h = await setup(true);
      expect((await h.ask({ ...origin, [key]: value })).action).toBe('decline');
      expect(h.requestApproval).toHaveBeenCalledOnce();
      await broker!.close(); broker = undefined;
    }
  });
  it.each([
    { tool_name: 'upload_browser_files', file_transfer: 'upload' },
    { tool_name: 'download_browser_files', file_transfer: 'download' },
    { tool_name: 'access_browser_origin_with_raw_cdp', full_cdp_access: true },
    { codex_approval_kind: 'browser_auth' },
    { sensitive_data: 'browsing_history' }, { connector_id: 'another-connector' },
    { tool_name: 'another-tool' },
    { riskLevel: 'high' }, { risk_level: 'high' },
    { risk_level: 'low', riskLevel: 'critical' },
    { risk_level: 'critical', riskLevel: 'low' },
    { file_transfer: 'upload' }, { full_cdp_access: true },
    { fileTransfer: 'upload' }, { fullCdpAccess: true }, { sensitiveData: 'browsing_history' },
    { file_transfer: false }, { fileTransfer: false },
    { full_cdp_access: false }, { fullCdpAccess: false },
    { sensitive_data: false }, { sensitiveData: false },
    ...['file_transfer', 'fileTransfer', 'full_cdp_access', 'fullCdpAccess',
      'sensitive_data', 'sensitiveData'].map(key => ({ [key]: null })),
    { origin: 'file:///etc', tool_params: undefined },
    { origin: 'ftp://example.test', tool_params: { origin: 'ftp://example.test' } },
    { origin: 'https://user:secret@example.test', tool_params: undefined },
    { origin: 'https://example.test/path', tool_params: undefined }, { origin: 'not-a-url' },
    { origin: undefined }, { tool_params: { origin: 'https://other.test' } },
  ])('keeps other prompts on the approval path: %j', async override => {
    const h = await setup(true);
    expect(await h.ask({ ...origin, ...override })).toEqual({ action: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledOnce();
  });
  it('does not carry delegation into another bot broker', async () => {
    const allowed = await setup(true); expect((await allowed.ask(origin)).action).toBe('accept');
    await broker!.close();
    const other = await setup(false); expect((await other.ask(origin)).action).toBe('decline');
    expect(other.requestApproval).toHaveBeenCalledOnce();
  });
  it('audits delegation on stderr with only the session and canonical origin', async () => {
    const h = await setup(true);
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect((await h.ask({ ...origin, tool_params: { ...origin.tool_params, token: 'private-test-value' } })).action).toBe('accept');
      expect(write).toHaveBeenCalledOnce();
      const line = String(write.mock.calls[0][0]);
      expect(JSON.parse(line.slice(line.indexOf('{')))).toEqual({ event: 'origin_auto_approved',
        sessionId: 's-auto-origin', origin: 'https://example.test', persist: 'session' });
      expect(line).not.toContain('private-test-value');
    } finally { write.mockRestore(); }
  });
  it.each([false, true])('does not cache ambiguous or sensitive origin decisions (automatic=%s)', async automatic => {
    const h = await setup(automatic, 'accept');
    for (const fields of [{ risk_level: 'low', riskLevel: 'high' }, { riskLevel: 1 },
      { risk_level: 'critical' }, { sensitiveData: 'browsing_history' }]) {
      const before = h.requestApproval.mock.calls.length;
      await h.ask({ ...origin, ...fields });
      await h.ask({ ...origin, ...fields });
      expect(h.requestApproval).toHaveBeenCalledTimes(before + 2);
    }
  });
  it('does not merge an escalating origin request with a pending human decision', async () => {
    const h = await setup(true, 'accept');
    let resolveFirst!: (value: { action: 'accept' }) => void;
    h.requestApproval.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    const first = h.ask({ ...origin, risk_level: 'low', riskLevel: 'high' });
    const second = h.ask({ ...origin, risk_level: 'low', riskLevel: 'critical' });
    const decisions = h.requestApproval.mock.calls.length;
    resolveFirst({ action: 'accept' });
    await Promise.all([first, second]);
    expect(decisions).toBe(2);
  });
  it('keeps ordinary human session grants cached when automatic approval is off', async () => {
    const h = await setup(false, 'accept');
    await h.ask(origin); await h.ask(origin);
    expect(h.requestApproval).toHaveBeenCalledOnce();
    await h.ask({ ...origin, riskLevel: 1 });
    expect(h.requestApproval).toHaveBeenCalledTimes(2);
  });
});
