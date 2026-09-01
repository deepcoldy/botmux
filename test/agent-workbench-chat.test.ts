import { describe, expect, it, vi } from 'bun:test';
import {
  buildChatAppLink,
  buildWorkbenchLoginUrl,
  buildWorkbenchWebAppLink,
  openWorkbenchChat,
  type FeishuJsApi,
} from '../src/dashboard/web/agent-workbench-chat.js';

describe('Agent Workbench Feishu chat bridge', () => {
  it('uses PC toggleChat first when capability exists', async () => {
    const enterChat = vi.fn();
    const sdk: FeishuJsApi = {
      toggleChat(options) { options.success?.(); },
      enterChat,
    };
    await expect(openWorkbenchChat({ chatId: 'oc_1', preferSplit: true, sdk })).resolves.toEqual({ kind: 'native-split', method: 'toggleChat' });
    expect(enterChat).not.toHaveBeenCalled();
  });

  it('goes straight from a rejected toggleChat to AppLink on desktop', async () => {
    // enterChat navigates the entire page. When toggleChat is rejected the JSAPI
    // is unauthorised, so enterChat would fail the same way while additionally
    // displacing the Workbench — the double navigation users reported.
    const order: string[] = [];
    const sdk: FeishuJsApi = {
      toggleChat(options) { order.push('toggleChat'); options.fail?.({ errno: 1 }); },
      enterChat(options) { order.push('enterChat'); options.fail?.({ errno: 2 }); },
    };
    const opened: string[] = [];
    const result = await openWorkbenchChat({ chatId: 'oc_2', preferSplit: true, sdk, openExternal: url => opened.push(url) });
    expect(order).toEqual(['toggleChat']);
    expect(result.kind).toBe('applink');
    expect(opened[0]).toContain('openChatId=oc_2');
  });

  it('reports the client rejection reason instead of inferring one', async () => {
    // The fallback is only diagnosable if the client's own errno survives; a
    // bare "failed" leaves us guessing why the page navigated away.
    const sdk: FeishuJsApi = {
      toggleChat(options) { options.fail?.({ errno: 10003, errString: 'jsapi not authorized' }); },
    };
    const result = await openWorkbenchChat({ chatId: 'oc_9', preferSplit: true, sdk, openExternal: () => {} });
    expect(result.kind).toBe('applink');
    if (result.kind !== 'applink') throw new Error('expected applink');
    expect(result.rejectedBecause).toContain('errno=10003');
    expect(result.rejectedBecause).toContain('jsapi not authorized');
  });

  it('still uses enterChat where split chat is not the contract (mobile)', async () => {
    const order: string[] = [];
    const sdk: FeishuJsApi = {
      toggleChat(options) { order.push('toggleChat'); options.fail?.({ errno: 1 }); },
      enterChat(options) { order.push('enterChat'); options.success?.(); },
    };
    const result = await openWorkbenchChat({ chatId: 'oc_3', preferSplit: false, sdk });
    expect(order).toEqual(['enterChat']);
    expect(result).toEqual({ kind: 'native-jump', method: 'enterChat' });
  });

  it('is safe without a Feishu SDK and builds explicit appCenter/sidebar contracts', async () => {
    const opened: string[] = [];
    await expect(openWorkbenchChat({ chatId: 'oc_browser', preferSplit: true, sdk: null, openExternal: url => opened.push(url) }))
      .resolves.toMatchObject({ kind: 'applink', method: 'AppLink' });
    expect(buildChatAppLink('oc_browser')).toContain('/client/chat/open');
    const main = buildWorkbenchWebAppLink({ appId: 'cli_x', surface: 'main', targetOrigin: 'https://dash.example', sessionId: 's/1' });
    const dock = buildWorkbenchWebAppLink({ appId: 'cli_x', surface: 'dock', targetOrigin: 'https://dash.example', sessionId: 's/1' });
    expect(main).toContain('mode=appCenter');
    expect(main).toContain('lk_target_url=');
    expect(dock).toContain('mode=sidebar');
    expect(dock).toContain('min_width=350');
    expect(dock).toContain('max_width=520');
    expect(buildWorkbenchLoginUrl('/auth/feishu', 'dock', 's/1')).toContain('returnTo=');
    expect(buildWorkbenchWebAppLink({ appId: 'cli_x', surface: 'main', targetOrigin: 'https://[' })).toBeNull();
  });

  it('skips JSAPI entirely on unsigned pages and dispatches inside the click task', () => {
    const opened: string[] = [];
    const enterChat = vi.fn();
    const toggleChat = vi.fn();
    // Not awaited on purpose: with JSAPI gated off there is no await ahead of
    // the fallback, so the anchor fires while the user activation is still
    // live. An enterChat detour here is what demoted the open to a narrow
    // page-initiated container (observed live as errno=105 then a late click).
    const pending = openWorkbenchChat({
      chatId: 'oc_unsigned',
      preferSplit: false,
      nativeEnabled: false,
      sdk: { enterChat, toggleChat } as unknown as FeishuJsApi,
      openExternal: url => opened.push(url),
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('openChatId=oc_unsigned');
    expect(enterChat).not.toHaveBeenCalled();
    expect(toggleChat).not.toHaveBeenCalled();
    return expect(pending).resolves.toMatchObject({ kind: 'applink', method: 'AppLink' });
  });

  it('keeps chat/open bare — container params on it make the client navigate', () => {
    // Regression lock: adding sidebar-semi/width params to chat/open made the
    // Feishu client stop placing the chat in its side slot and jump instead
    // (observed live). Width is a web_url container contract only.
    const built = new URL(buildChatAppLink('oc_bare'));
    expect(built.searchParams.get('openChatId')).toBe('oc_bare');
    expect([...built.searchParams.keys()]).toEqual(['openChatId']);
  });

  it('never follows a session-provided non-Feishu AppLink', async () => {
    const opened: string[] = [];
    const result = await openWorkbenchChat({
      chatId: 'oc_safe',
      appLink: 'javascript:alert(1)',
      preferSplit: false,
      sdk: null,
      openExternal: url => opened.push(url),
    });
    expect(result).toMatchObject({ kind: 'applink', method: 'AppLink' });
    expect(opened[0]).toMatch(/^https:\/\/applink\.feishu\.cn\/client\/chat\/open\?/);
    expect(opened[0]).toContain('openChatId=oc_safe');

    opened.length = 0;
    await openWorkbenchChat({
      chatId: 'oc_safe',
      appLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_other',
      preferSplit: false,
      sdk: null,
      openExternal: url => opened.push(url),
    });
    expect(opened[0]).toContain('openChatId=oc_safe');
    expect(opened[0]).not.toContain('oc_other');
  });
});
