import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBrowserBroker } from '../src/services/codex-browser-broker.js';

let broker: CodexBrowserBroker | undefined;
afterEach(async () => { await broker?.close(); broker = undefined; });

const origin = {
  codex_approval_kind: 'mcp_tool_call', connector_id: 'browser-use',
  tool_name: 'access_browser_origin', origin: 'https://example.test',
  tool_params: { origin: 'https://example.test' }, persist: 'always',
};
async function setup(autoApproveOrigins?: boolean) {
  const requestApproval = vi.fn(async () => ({ action: 'decline' as const }));
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
    { tool_name: 'upload_browser_files', file_transfer: 'upload' },
    { tool_name: 'download_browser_files', file_transfer: 'download' },
    { tool_name: 'access_browser_origin_with_raw_cdp', full_cdp_access: true },
    { codex_approval_kind: 'browser_auth' },
    { sensitive_data: 'browsing_history' }, { connector_id: 'another-connector' },
    { tool_name: 'another-tool' },
    { riskLevel: 'high' }, { risk_level: 'high' },
    { file_transfer: 'upload' }, { full_cdp_access: true },
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
});
