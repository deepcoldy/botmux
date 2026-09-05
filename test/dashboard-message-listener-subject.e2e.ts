import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Json = Record<string, any>;

function jsonResponse(body: Json, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  const visit = (child: unknown): void => {
    if (typeof child === 'string') parts.push(child);
    else if (child && typeof child === 'object' && 'children' in child) {
      for (const nested of (child as TestRenderer.ReactTestInstance).children) visit(nested);
    }
  };
  for (const child of node.children) visit(child);
  return parts.join('');
}

/**
 * The production page intentionally exports only its DOM mount function. For
 * this Node e2e we expose the real, otherwise-private RolesPage at bundle time;
 * its source and all handlers remain unchanged, so the test drives the exact
 * production select/input/save/reload path without adding a test seam to src.
 */
async function loadRolesPage(): Promise<React.ComponentType<{ tab: 'groups' | 'profiles' }>> {
  const sourcePath = fileURLToPath(new URL('../src/dashboard/web/roles-page.tsx', import.meta.url));
  const source = readFileSync(sourcePath, 'utf8');
  const exposed = source.replace('function RolesPage(props:', 'export function RolesPage(props:');
  expect(exposed).not.toBe(source);

  const tempDir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.subject-ui-e2e-'));
  const outputPath = join(tempDir, 'roles-page.mjs');
  await build({
    stdin: {
      contents: exposed,
      sourcefile: sourcePath,
      resolveDir: dirname(sourcePath),
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    jsx: 'automatic',
    target: 'node22',
    logLevel: 'silent',
  });
  try {
    const loaded = await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`) as {
      RolesPage: React.ComponentType<{ tab: 'groups' | 'profiles' }>;
    };
    return loaded.RolesPage;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dashboard Subject listener main path', () => {
  it('lets an administrator select Subject, set N, save empty focus, and see the same values after reload', async () => {
    const saved: { listener: Json | null } = { listener: null };
    const puts: Json[] = [];
    const groupBody = {
      bots: [{ larkAppId: 'cli_subject_ui', botName: 'Subject Bot' }],
      chats: [{
        chatId: 'oc_subject_ui',
        name: '交付协作群',
        memberBots: [{
          larkAppId: 'cli_subject_ui',
          botName: 'Subject Bot',
          inChat: true,
          hasRole: false,
          hasMessageListener: false,
          oncallChat: null,
        }],
      }],
    };
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? 'GET';
      if (url === '/api/groups' || url === '/api/groups?view=names') return jsonResponse(groupBody);
      if (url === '/api/role-profiles') return jsonResponse({ profiles: [] });
      if (url === '/api/roles/cli_subject_ui/oc_subject_ui') {
        return jsonResponse({
          chatId: 'oc_subject_ui',
          content: null,
          byteLength: 0,
          hasRole: false,
          injectMode: 'every',
        });
      }
      if (url === '/api/groups/cli_subject_ui/oc_subject_ui/members-display') {
        return jsonResponse({ members: [] });
      }
      if (url === '/api/message-listeners/cli_subject_ui/oc_subject_ui' && method === 'PUT') {
        saved.listener = JSON.parse(String(init?.body ?? '{}'));
        puts.push(saved.listener!);
        return jsonResponse({ ok: true, listener: saved.listener });
      }
      if (url === '/api/message-listeners/cli_subject_ui/oc_subject_ui') {
        return jsonResponse({ listener: saved.listener });
      }
      throw new Error(`Unexpected dashboard request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { hash: '#/roles' });
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => undefined },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });

    const RolesPage = await loadRolesPage();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(RolesPage, { tab: 'groups' }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.root.findByProps({ 'data-group-id': 'oc_subject_ui' }).props.onClick();
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-bot-id': 'cli_subject_ui' }).props.onClick({ stopPropagation: () => undefined });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const listenerTab = renderer.root.findAllByType('button')
      .find(button => textOf(button) === '消息监听');
    expect(listenerTab).toBeDefined();
    await act(async () => { listenerTab!.props.onClick(); });

    const behavior = renderer.root.findByProps({ id: 'roles-listener-behavior' });
    expect(behavior.props.value).toBe('prompt');
    await act(async () => {
      behavior.props.onChange({ currentTarget: { value: 'subject' } });
    });
    const fallback = renderer.root.findByProps({ id: 'roles-listener-subject-fallback' });
    expect(fallback.props.value).toBe(20);
    await act(async () => {
      fallback.props.onChange({ currentTarget: { valueAsNumber: 30 } });
    });

    await act(async () => {
      renderer.root.findByProps({ id: 'roles-listener-subject-fallback' }).props.onChange({
        currentTarget: { valueAsNumber: 0 },
      });
    });
    expect(renderer.root.findByProps({ id: 'roles-listener-save' }).props.disabled).toBe(true);
    await act(async () => {
      renderer.root.findByProps({ id: 'roles-listener-subject-fallback' }).props.onChange({
        currentTarget: { valueAsNumber: 30 },
      });
    });
    expect(renderer.root.findByProps({ id: 'roles-listener-save' }).props.disabled).toBe(false);

    await act(async () => {
      renderer.root.findByProps({ id: 'roles-listener-behavior' }).props.onChange({
        currentTarget: { value: 'prompt' },
      });
    });
    expect(renderer.root.findAllByProps({ id: 'roles-listener-subject-fallback' })).toHaveLength(0);
    expect(renderer.root.findByProps({ id: 'roles-listener-prompt' }).props.placeholder).not.toContain('Subject');
    await act(async () => {
      renderer.root.findByProps({ id: 'roles-listener-behavior' }).props.onChange({
        currentTarget: { value: 'subject' },
      });
    });
    expect(renderer.root.findByProps({ id: 'roles-listener-subject-fallback' }).props.value).toBe(30);

    const focus = renderer.root.findByProps({ id: 'roles-listener-prompt' });
    expect(focus.props.value).toBe('');
    expect(focus.props.placeholder).toContain('留空则由 Subject');
    expect(renderer.root.findAll(node => typeof node.children[0] === 'string'
      && String(node.children[0]).includes('显式 @ 当前 Bot 始终走普通 @ 路由'))).not.toHaveLength(0);

    const save = renderer.root.findByProps({ id: 'roles-listener-save' });
    expect(save.props.disabled).toBe(false);
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(puts).toEqual([expect.objectContaining({
      enabled: false,
      behavior: 'subject',
      prompt: '',
      subjectPolicy: {
        context: { source: 'lark', fallbackMessages: 30 },
      },
    })]);
    expect(renderer.root.findByProps({ id: 'roles-listener-behavior' }).props.value).toBe('subject');
    expect(renderer.root.findByProps({ id: 'roles-listener-subject-fallback' }).props.value).toBe(30);
    expect(renderer.root.findByProps({ id: 'roles-listener-prompt' }).props.value).toBe('');

    await act(async () => { renderer.unmount(); });
  });
});
