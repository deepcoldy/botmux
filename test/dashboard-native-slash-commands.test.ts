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
        bot: { larkAppId: 'cli_test', cliId: 'codex', customPassthroughCommands: '/export' },
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
});
