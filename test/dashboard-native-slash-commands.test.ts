import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeSlashCommandRegistration } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const command = {
  command: 'help',
  description: { default_value: '显示 botmux 命令帮助' },
  source: 'botmux',
  status: 'missing',
};

const remoteExtra = {
  command: 'external',
  description: { default_value: '飞书后台已有命令' },
  source: 'remote',
  status: 'remote-extra',
  commandId: 'id-external',
};

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dashboard native Lark slash commands', () => {
  it('loads the app catalog, renders status, and invokes the per-bot sync route', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return response({
          ok: true,
          commands: [{ ...command, status: 'synced' }],
          summary: { total: 1, synced: 1, missing: 0, outdated: 0, remoteExtra: 1 },
          report: { created: 1, updated: 0, failed: 0 },
        });
      }
      return response({
        ok: true,
        commands: [command],
        summary: { total: 1, synced: 0, missing: 1, outdated: 0, remoteExtra: 1 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const root = renderer.root;
    expect(fetchMock).toHaveBeenCalledWith('/api/bots/cli_test/slash-commands', expect.objectContaining({ method: 'GET' }));
    expect(root.findByProps({ 'data-native-slash-commands': '' })).toBeTruthy();
    expect(root.findByProps({ 'data-slash-status': 'missing' })).toBeTruthy();
    expect(root.findByType('code').children.join('')).toBe('/help');
    expect(JSON.stringify(renderer.toJSON())).toContain('待新增 1');

    await act(async () => {
      root.findByProps({ 'data-action': 'sync-native-slash-commands' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/bots/cli_test/slash-commands/sync', expect.objectContaining({ method: 'POST' }));
    expect(root.findByProps({ 'data-slash-status': 'synced' })).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain('同步完成：新增 1，更新 0');
  });

  it('lets the user sync one candidate and delete remote commands independently', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/sync-one')) {
        expect(JSON.parse(String(init?.body))).toEqual({ command: 'help' });
        return response({
          ok: true,
          commands: [{ ...command, status: 'synced', commandId: 'id-help' }, remoteExtra],
          summary: { total: 1, synced: 1, missing: 0, outdated: 0, remoteExtra: 1 },
          report: { created: 1, updated: 0, deleted: 0, failed: 0 },
        });
      }
      if (url.endsWith('/delete')) {
        expect(JSON.parse(String(init?.body))).toEqual({ command: 'external' });
        return response({
          ok: true,
          commands: [{ ...command, status: 'synced', commandId: 'id-help' }],
          summary: { total: 1, synced: 1, missing: 0, outdated: 0, remoteExtra: 0 },
          report: { created: 0, updated: 0, deleted: 1, failed: 0 },
        });
      }
      return response({
        ok: true,
        commands: [command, remoteExtra],
        summary: { total: 1, synced: 0, missing: 1, outdated: 0, remoteExtra: 1 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const root = renderer.root;
    expect(root.findByProps({ 'data-slash-status': 'remote-extra' })).toBeTruthy();

    await act(async () => {
      root.findByProps({ 'data-action': 'sync-native-slash-command', 'data-command': 'help' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/bots/cli_test/slash-commands/sync-one', expect.objectContaining({ method: 'POST' }));

    await act(async () => {
      root.findByProps({ 'data-action': 'delete-native-slash-command', 'data-command': 'external' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/bots/cli_test/slash-commands/delete', expect.objectContaining({ method: 'POST' }));
    expect(root.findAllByProps({ 'data-slash-status': 'remote-extra' })).toHaveLength(0);
  });

  it('keeps the catalog visible and shows scope deep links when inspection is denied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: false,
      error: 'Access denied',
      commands: [{ ...command, status: 'unknown' }],
      summary: { total: 1, synced: 0, missing: 0, outdated: 0, remoteExtra: 0 },
      permissionUrls: { read: 'https://open.feishu.cn/read', write: 'https://open.feishu.cn/write' },
    }, false, 502)));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const root = renderer.root;
    expect(root.findByProps({ 'data-slash-status': 'unknown' })).toBeTruthy();
    expect(root.findAllByType('a').map(link => link.props.href)).toEqual([
      'https://open.feishu.cn/read',
      'https://open.feishu.cn/write',
    ]);
    expect(JSON.stringify(renderer.toJSON())).toContain('Access denied');
  });

  it('degrades to an informational "unavailable" state when the optional scope is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: true,
      available: false,
      reason: 'missing_scope',
      missingScopes: ['application:app_slash_command:read'],
      commands: [{ ...command, status: 'unknown' }],
      summary: { total: 1, synced: 0, missing: 0, outdated: 0, remoteExtra: 0 },
      permissionUrls: { read: 'https://open.feishu.cn/read', write: 'https://open.feishu.cn/write' },
    })));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const root = renderer.root;
    const json = JSON.stringify(renderer.toJSON());
    expect(root.findByProps({ 'data-native-slash-unavailable': 'missing_scope' })).toBeTruthy();
    expect(json).toContain('application:app_slash_command:read');
    expect(json).toContain('Bot 的其它功能不受影响');
    expect(json).not.toContain('✗');
    // Candidates stay visible read-only; every write affordance is off.
    expect(root.findByProps({ 'data-slash-status': 'unknown' })).toBeTruthy();
    expect(root.findByProps({ 'data-action': 'sync-native-slash-commands' }).props.disabled).toBe(true);
    expect(root.findAllByProps({ 'data-action': 'sync-native-slash-command' })).toHaveLength(0);
    expect(root.findAllByType('a').map(link => link.props.href)).toEqual([
      'https://open.feishu.cn/read',
      'https://open.feishu.cn/write',
    ]);
  });

  it('explains a tenant that is not gated in without offering scope links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: true,
      available: false,
      reason: 'not_enabled',
      missingScopes: [],
      commands: [{ ...command, status: 'unknown' }],
      summary: { total: 1, synced: 0, missing: 0, outdated: 0, remoteExtra: 0 },
      permissionUrls: { read: 'https://open.feishu.cn/read', write: 'https://open.feishu.cn/write' },
    })));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const root = renderer.root;
    expect(root.findByProps({ 'data-native-slash-unavailable': 'not_enabled' })).toBeTruthy();
    expect(root.findAllByType('a')).toHaveLength(0);
    expect(root.findByProps({ 'data-action': 'sync-native-slash-commands' }).props.disabled).toBe(true);
  });

  it('turns a write-scope denial into a readable hint instead of a raw Lark error', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return response({
          ok: false,
          available: true,
          error: 'missing_scope',
          reason: 'missing_scope',
          missingScopes: ['application:app_slash_command:write'],
          commands: [command],
          summary: { total: 1, synced: 0, missing: 1, outdated: 0, remoteExtra: 0 },
          report: { created: 0, updated: 0, deleted: 0, failed: 1 },
        });
      }
      return response({
        ok: true,
        available: true,
        commands: [command],
        summary: { total: 1, synced: 0, missing: 1, outdated: 0, remoteExtra: 0 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'sync-native-slash-command', 'data-command': 'help' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('application:app_slash_command:write');
  });

  async function clickSyncOneWith(postBody: unknown, ok: boolean): Promise<string> {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response(postBody, ok);
      return response({
        ok: true,
        available: true,
        commands: [command],
        summary: { total: 1, synced: 0, missing: 1, outdated: 0, remoteExtra: 0 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'sync-native-slash-command', 'data-command': 'help' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    return JSON.stringify(renderer.toJSON());
  }

  it('reports a confirmed write as success and the failed list refresh as a separate note', async () => {
    const html = await clickSyncOneWith({
      ok: true,
      available: true,
      commands: [{ ...command, status: 'unknown' }],
      summary: { total: 1, synced: 0, missing: 0, outdated: 0, remoteExtra: 0 },
      report: { created: 1, updated: 0, deleted: 0, failed: 0, outcomes: [{ action: 'create', command: 'help', ok: true }] },
      refreshError: 'refresh ETIMEDOUT',
    }, true);
    expect(html).toContain('✓ /help 已同步');
    expect(html).toContain('刷新清单失败（refresh ETIMEDOUT）');
    expect(html).not.toContain('✗');
  });

  it('names the command whose write threw and marks its outcome unconfirmed', async () => {
    const html = await clickSyncOneWith({
      ok: false,
      available: true,
      error: 'slash_command_sync_failed',
      commands: [command],
      summary: { total: 1, synced: 0, missing: 1, outdated: 0, remoteExtra: 0 },
      report: {
        created: 0, updated: 0, deleted: 0, failed: 1,
        outcomes: [{ action: 'create', command: 'help', ok: false, uncertain: true, message: 'socket hang up' }],
      },
    }, true);
    expect(html).toContain('/help: 请求异常，结果未确认（socket hang up）');
  });

  it('explains a core-only bot without offering scope links or write actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: true,
      available: false,
      reason: 'core_only',
      missingScopes: [],
      commands: [{ ...command, status: 'unknown' }],
      summary: { total: 1, synced: 0, missing: 0, outdated: 0, remoteExtra: 0 },
    })));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const html = JSON.stringify(renderer.toJSON());
    expect(renderer.root.findByProps({ 'data-native-slash-unavailable': 'core_only' })).toBeTruthy();
    expect(html).toContain('core-only');
    expect(html).not.toContain('read ↗');
    expect(renderer.root.findByProps({ 'data-action': 'sync-native-slash-commands' }).props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-action': 'sync-native-slash-command' })).toHaveLength(0);
  });

  it('sends the control CSRF ticket on every write (sync / sync-one / delete) but not on the read', async () => {
    vi.stubGlobal('document', {
      querySelector: (selector: string) => selector === 'meta[name="botmux-csrf"]'
        ? { getAttribute: () => 'ticket-123' }
        : null,
    });
    vi.stubGlobal('confirm', () => true);
    const fetchMock = vi.fn(async () => response({
      ok: true,
      available: true,
      commands: [command, remoteExtra],
      summary: { total: 1, synced: 0, missing: 1, outdated: 0, remoteExtra: 1 },
      report: { created: 0, updated: 0, deleted: 0, failed: 0, outcomes: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    for (const props of [
      { 'data-action': 'sync-native-slash-commands' },
      { 'data-action': 'sync-native-slash-command', 'data-command': 'help' },
      { 'data-action': 'delete-native-slash-command', 'data-command': 'external' },
    ]) {
      await act(async () => {
        renderer.root.findByProps(props).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const writes = calls.filter(([, init]) => init.method === 'POST');
    expect(writes.map(([url]) => url)).toEqual([
      '/api/bots/cli_test/slash-commands/sync',
      '/api/bots/cli_test/slash-commands/sync-one',
      '/api/bots/cli_test/slash-commands/delete',
    ]);
    for (const [, init] of writes) expect((init.headers as Record<string, string>)['x-botmux-csrf']).toBe('ticket-123');
    const read = calls.find(([, init]) => init.method === 'GET')!;
    expect((read[1].headers as Record<string, string>)['x-botmux-csrf']).toBeUndefined();
  });

  it.each([
    ['sync', { 'data-action': 'sync-native-slash-commands' }],
    ['sync-one', { 'data-action': 'sync-native-slash-command', 'data-command': 'help' }],
    ['delete', { 'data-action': 'delete-native-slash-command', 'data-command': 'external' }],
  ] as const)('drops a stale %s response that lands after the bot CLI changed', async (_name, props) => {
    vi.stubGlobal('confirm', () => true);
    const effort = { command: 'effort', description: { default_value: '调整推理强度' }, source: 'botmux', status: 'missing' };
    const claudeOnly = { command: 'claudeonly', description: { default_value: '新 CLI 的命令' }, source: 'botmux', status: 'missing' };
    let releasePost!: (value: Response) => void;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>(resolve => { releasePost = resolve; });
      const cliCommands = fetchMock.mock.calls.filter(([, i]) => i?.method === 'GET').length === 1
        ? [command, effort, remoteExtra]
        : [claudeOnly];
      return Promise.resolve(response({
        ok: true,
        available: true,
        commands: cliCommands,
        summary: { total: cliCommands.length, synced: 0, missing: cliCommands.length, outdated: 0, remoteExtra: 0 },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex-app' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('"effort"');

    await act(async () => {
      renderer.root.findByProps(props).props.onClick();
      await Promise.resolve();
    });
    // User switches this bot to another CLI while the write is still in flight.
    await act(async () => {
      renderer.update(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'claude' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('"claudeonly"');

    // The old write now returns the codex-app catalog — it must not overwrite.
    await act(async () => {
      releasePost(response({
        ok: true,
        available: true,
        commands: [{ ...command, status: 'synced' }, { ...effort, status: 'synced' }],
        summary: { total: 2, synced: 2, missing: 0, outdated: 0, remoteExtra: 0 },
        report: { created: 1, updated: 0, deleted: 1, failed: 0, outcomes: [] },
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain('"claudeonly"');
    expect(html).not.toContain('"effort"');
    expect(html).not.toContain('✓');
    expect(renderer.root.findByProps({ 'data-action': 'sync-native-slash-commands' }).props.disabled).toBe(false);
  });

  it('clears the previous CLI catalog on switch and keeps it empty if the new query fails', async () => {
    let gets = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      gets += 1;
      if (gets === 1) {
        return response({
          ok: true,
          available: true,
          commands: [command],
          summary: { total: 1, synced: 0, missing: 1, outdated: 0, remoteExtra: 0 },
        });
      }
      return response({ ok: false, error: 'daemon_offline' }, false, 503);
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'codex-app' },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ 'data-action': 'sync-native-slash-command' })).toHaveLength(1);

    await act(async () => {
      renderer.update(React.createElement(NativeSlashCommandRegistration, {
        bot: { larkAppId: 'cli_test', cliId: 'claude' },
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const html = JSON.stringify(renderer.toJSON());
    expect(renderer.root.findAllByProps({ 'data-action': 'sync-native-slash-command' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-slash-status': 'missing' })).toHaveLength(0);
    expect(html).toContain('daemon_offline');
    expect(renderer.root.findByProps({ 'data-action': 'sync-native-slash-commands' }).props.disabled).toBe(true);
  });
});
