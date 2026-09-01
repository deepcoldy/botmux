/**
 * 工作台内「常驻链接」入口的前端契约。
 *
 * 服务端那条 `GET /api/workbench/standing-link` 只对本机完整管理身份开放（见
 * test/workbench-standing-link.test.ts）。前端这一侧钉住三件事：
 *  1. 入口**只对 owner 渲染**：`manageAuthed`（= `/api/settings` 的 `authed`，
 *     Dashboard 既有的「本机完整管理身份」判据）为假时，⋯ 菜单和移动 sheet 里
 *     都没有这一项——不给无权身份画一个点了必然 401 的按钮；
 *  2. 弹层拿到链接后可全选、可一键复制（navigator.clipboard 不可用时降级到
 *     document.execCommand，两条路都在 web/clipboard.ts 里，这里注入替身验证
 *     调用参数与三种反馈态）；
 *  3. 文案走 i18n 字典，zh / en 都有。
 *
 * Run: pnpm vitest run test/agent-workbench-standing-link.test.ts
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'bun:test';

import {
  WorkbenchAppearanceMenu,
  WorkbenchAppearanceSheet,
  WorkbenchStandingLinkPanel,
} from '../src/dashboard/web/agent-workbench-appearance-menu.js';
import { AgentWorkbenchView } from '../src/dashboard/web/agent-workbench-view.js';
import { AgentWorkbenchDockView } from '../src/dashboard/web/agent-workbench-dock-view.js';
import type { WorkbenchApi } from '../src/dashboard/web/agent-workbench-api.js';
import { createWorkbenchApi } from '../src/dashboard/web/agent-workbench-api.js';
import type { WorkbenchSessionRow } from '../src/dashboard/web/agent-workbench-model.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

const STANDING_URL = 'http://127.0.0.1:7891/workbench?t=standing-token-fixture';

const api: WorkbenchApi = {
  getTerminalControl: async () => ({ mode: 'readonly', owned: false }),
  takeoverTerminal: async () => ({ mode: 'controlled', owned: true, expiresAt: Date.now() + 60_000 }),
  releaseTerminal: async () => ({ mode: 'readonly', owned: false }),
  getPreviewInteraction: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'n/a' }),
  unlockPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'n/a', idleExpiresAt: Date.now() + 60_000 }),
  touchPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'n/a', idleExpiresAt: Date.now() + 60_000 }),
  lockPreview: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'n/a' }),
  getH5Context: async () => null,
  getTerminalViewLink: async () => null,
  locateSession: async () => {},
  getStandingLink: async () => ({ url: STANDING_URL }),
};

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
}

function byClass(renderer: TestRenderer.ReactTestRenderer, className: string): ReactTestInstance[] {
  return renderer.root.findAll(node =>
    typeof node.type === 'string'
    && String((node.props as { className?: unknown }).className ?? '').split(/\s+/).includes(className));
}

function sessionRow(): WorkbenchSessionRow {
  return {
    sessionId: 'session-0',
    status: 'working',
    title: '会话零',
    botName: 'Builder',
    cliId: 'codex',
    chatId: 'oc_0',
    lastMessageAt: 1_800_000_000_000,
  };
}

async function renderMenu(props: { standingLink?: boolean; api?: WorkbenchApi } = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(WorkbenchAppearanceMenu, {
      standingLink: props.standingLink,
      api: props.api ?? api,
    }));
  });
  return renderer;
}

async function openMenu(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  const button = byClass(renderer, 'wb-more-btn')[0];
  await act(async () => { button.props.onClick(); });
}

// ─── owner 才渲染入口 ───────────────────────────────────────────────────────

describe('⋯ 菜单里的「常驻链接」入口', () => {
  it('owner（standingLink=true）：菜单里同时有「外观」和「常驻链接」', async () => {
    const renderer = await renderMenu({ standingLink: true });
    await openMenu(renderer);
    const items = byClass(renderer, 'wb-more-item').map(textOf);
    expect(items).toEqual(['外观', '常驻链接']);
    act(() => renderer.unmount());
  });

  it('非 owner：菜单里只有「外观」，常驻链接整项不渲染', async () => {
    for (const standingLink of [false, undefined]) {
      const renderer = await renderMenu({ standingLink });
      await openMenu(renderer);
      expect(byClass(renderer, 'wb-more-item').map(textOf)).toEqual(['外观']);
      act(() => renderer.unmount());
    }
  });

  it('点开「常驻链接」渲染弹层（复用外观浮层样式族），并从服务端取链接', async () => {
    const getStandingLink = vi.fn(async () => ({ url: STANDING_URL }));
    const renderer = await renderMenu({ standingLink: true, api: { ...api, getStandingLink } });
    await openMenu(renderer);
    const entry = byClass(renderer, 'wb-more-item')[1];
    await act(async () => { entry.props.onClick(); });
    await act(async () => {});

    expect(getStandingLink).toHaveBeenCalledTimes(1);
    const pop = byClass(renderer, 'wb-standing-link-pop');
    expect(pop).toHaveLength(1);
    // 与外观浮层同一样式族：同一个类名前缀负责定位/描边/投影。
    expect(String(pop[0].props.className)).toContain('wb-appearance-pop');
    const field = byClass(renderer, 'wb-standing-link-url')[0];
    expect(field.props.value).toBe(STANDING_URL);
    expect(field.props.readOnly).toBe(true);
    act(() => renderer.unmount());
  });
});

// ─── 弹层本体 ───────────────────────────────────────────────────────────────

describe('常驻链接弹层', () => {
  async function renderPanel(overrides: {
    getStandingLink?: WorkbenchApi['getStandingLink'];
    copy?: (text: string) => Promise<boolean>;
  } = {}) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WorkbenchStandingLinkPanel, {
        api: { ...api, ...(overrides.getStandingLink ? { getStandingLink: overrides.getStandingLink } : {}) },
        onClose: () => {},
        ...(overrides.copy ? { copy: overrides.copy } : {}),
      }));
    });
    await act(async () => {});
    return renderer;
  }

  it('显示完整链接（只读且默认全选）+ 复制按钮 + 泄漏提示文案', async () => {
    const renderer = await renderPanel();
    const field = byClass(renderer, 'wb-standing-link-url')[0];
    expect(field.props.value).toBe(STANDING_URL);
    // 点一下就全选，方便手动复制（自动复制被浏览器拦掉时的退路）。
    expect(typeof field.props.onFocus).toBe('function');
    expect(byClass(renderer, 'wb-standing-link-copy')).toHaveLength(1);
    const note = byClass(renderer, 'wb-standing-link-note').map(textOf).join('');
    expect(note).toContain('书签');
    expect(note).toContain('rotate');
    act(() => renderer.unmount());
  });

  it('复制按钮把完整链接交给注入的复制实现，并给出「已复制」反馈', async () => {
    const copy = vi.fn(async () => true);
    const renderer = await renderPanel({ copy });
    const button = byClass(renderer, 'wb-standing-link-copy')[0];
    expect(textOf(button)).toBe('复制');
    await act(async () => { await button.props.onClick(); });
    expect(copy).toHaveBeenCalledWith(STANDING_URL);
    expect(textOf(byClass(renderer, 'wb-standing-link-copy')[0])).toBe('已复制');
    act(() => renderer.unmount());
  });

  it('复制失败（剪贴板被拒 + execCommand 也失败）时提示手动复制，链接仍在', async () => {
    const renderer = await renderPanel({ copy: async () => false });
    const button = byClass(renderer, 'wb-standing-link-copy')[0];
    await act(async () => { await button.props.onClick(); });
    expect(textOf(byClass(renderer, 'wb-standing-link-copy')[0])).toBe('复制失败，请手动选中');
    expect(byClass(renderer, 'wb-standing-link-url')[0].props.value).toBe(STANDING_URL);
    act(() => renderer.unmount());
  });

  it('服务端拒绝（401/403/404 → null）时只提示不可用，绝不显示半截链接', async () => {
    const renderer = await renderPanel({ getStandingLink: async () => null });
    expect(byClass(renderer, 'wb-standing-link-url')).toHaveLength(0);
    expect(byClass(renderer, 'wb-standing-link-copy')).toHaveLength(0);
    expect(byClass(renderer, 'wb-standing-link-status').map(textOf).join('')).toBe('暂时取不到常驻链接');
    act(() => renderer.unmount());
  });
});

// ─── 默认复制实现（navigator.clipboard → execCommand 降级） ────────────────

describe('默认复制实现', () => {
  it('弹层默认用 web/clipboard.ts 的 copyText：先 navigator.clipboard，失败降级 execCommand', async () => {
    const source = await import('node:fs').then(fs =>
      fs.readFileSync('src/dashboard/web/agent-workbench-appearance-menu.tsx', 'utf8'));
    expect(source).toContain("from './clipboard.js'");
    const clipboard = await import('node:fs').then(fs =>
      fs.readFileSync('src/dashboard/web/clipboard.ts', 'utf8'));
    expect(clipboard).toContain('navigator.clipboard');
    expect(clipboard).toContain("document.execCommand('copy')");
  });
});

// ─── 挂载点：桌面 ⋯ / 移动 sheet / 会话坞 ──────────────────────────────────

describe('入口挂载点', () => {
  const viewProps = (manageAuthed: boolean, viewportWidth: number) => ({
    sessions: [sessionRow()],
    online: true,
    authenticated: true,
    capabilities: { canLocate: true, canControl: true, canInteract: true },
    initialSessionId: 'session-0',
    viewportWidth,
    now: 1_800_000_100_000,
    api,
    storage: null,
    location: null,
    sdk: null,
    h5Context: null,
    manageAuthed,
    onRouteChange: () => {},
  });

  it('桌面工作区头部的 ⋯：owner 有「常驻链接」，非 owner 没有', async () => {
    for (const manageAuthed of [true, false]) {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, viewProps(manageAuthed, 1440)));
      });
      await openMenu(renderer);
      const items = byClass(renderer, 'wb-more-item').map(textOf);
      expect(items.includes('常驻链接'), `manageAuthed=${manageAuthed}`).toBe(manageAuthed);
      act(() => renderer.unmount());
    }
  });

  it('移动端外观 sheet 里同样能自取（owner 在手机浏览器也能收藏）', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, viewProps(true, 390)));
    });
    const appearanceBtn = byClass(renderer, 'wb-appearance-btn')[0];
    await act(async () => { appearanceBtn.props.onClick(); });
    expect(byClass(renderer, 'wb-appearance-sheet')).toHaveLength(1);
    const open = byClass(renderer, 'wb-standing-link-open')[0];
    expect(textOf(open)).toBe('常驻链接');
    await act(async () => { open.props.onClick(); });
    await act(async () => {});
    expect(byClass(renderer, 'wb-standing-link-url')[0].props.value).toBe(STANDING_URL);
    act(() => renderer.unmount());
  });

  it('移动端 sheet：非 owner 连入口按钮都没有', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, viewProps(false, 390)));
    });
    const appearanceBtn = byClass(renderer, 'wb-appearance-btn')[0];
    await act(async () => { appearanceBtn.props.onClick(); });
    expect(byClass(renderer, 'wb-appearance-sheet')).toHaveLength(1);
    expect(byClass(renderer, 'wb-standing-link-open')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('WorkbenchAppearanceSheet 独立渲染时也遵守 owner 门禁', async () => {
    for (const standingLink of [true, false]) {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(WorkbenchAppearanceSheet, {
          open: true,
          onClose: () => {},
          standingLink,
          api,
        }));
      });
      expect(byClass(renderer, 'wb-standing-link-open').length, `standingLink=${standingLink}`)
        .toBe(standingLink ? 1 : 0);
      act(() => renderer.unmount());
    }
  });

  it('会话坞头部的 ⋯ 同样按 manageAuthed 决定这一项', async () => {
    for (const manageAuthed of [true, false]) {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(AgentWorkbenchDockView, {
          sessions: [sessionRow()],
          online: true,
          authenticated: true,
          initialSessionId: 'session-0',
          now: 1_800_000_100_000,
          api,
          h5Context: null,
          sdk: null,
          location: null,
          manageAuthed,
          onRouteChange: () => {},
        }));
      });
      await openMenu(renderer);
      expect(byClass(renderer, 'wb-more-item').map(textOf).includes('常驻链接'), `manageAuthed=${manageAuthed}`)
        .toBe(manageAuthed);
      act(() => renderer.unmount());
    }
  });
});

// ─── 客户端严格解析 ────────────────────────────────────────────────────────

describe('createWorkbenchApi().getStandingLink', () => {
  function fetchStub(status: number, body: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  }

  it('200 + 合法绝对 http(s) 链接才返回', async () => {
    const client = createWorkbenchApi(fetchStub(200, { ok: true, url: STANDING_URL }));
    expect(await client.getStandingLink()).toEqual({ url: STANDING_URL });
  });

  it('401 / 403 / 404 / 503 一律 null（无权身份就是没有这个入口）', async () => {
    for (const status of [401, 403, 404, 503]) {
      const client = createWorkbenchApi(fetchStub(status, { ok: false, error: 'not_found' }));
      expect(await client.getStandingLink(), String(status)).toBeNull();
    }
  });

  it('形状不合法（缺字段 / 非 http scheme / 超长）一律 null，绝不把它塞进输入框', async () => {
    const bad: unknown[] = [
      { ok: true },
      { ok: true, url: 42 },
      { ok: true, url: 'javascript:alert(1)' },
      { ok: true, url: `http://127.0.0.1/${'a'.repeat(3000)}` },
      { ok: false, url: STANDING_URL },
    ];
    for (const body of bad) {
      const client = createWorkbenchApi(fetchStub(200, body));
      expect(await client.getStandingLink(), JSON.stringify(body).slice(0, 40)).toBeNull();
    }
  });
});

// ─── i18n ───────────────────────────────────────────────────────────────────

describe('i18n', () => {
  const KEYS = [
    'workbench.standingLink.title',
    'workbench.standingLink.loading',
    'workbench.standingLink.error',
    'workbench.standingLink.copy',
    'workbench.standingLink.copied',
    'workbench.standingLink.copyFailed',
    'workbench.standingLink.note',
    'workbench.standingLink.fieldLabel',
  ];

  it('zh / en 两本字典都定义了全部键', () => {
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');
    for (const key of KEYS) {
      expect(zh(key), `zh ${key}`).not.toBe(key);
      expect(en(key), `en ${key}`).not.toBe(key);
    }
  });

  it('提示文案两边都说清「收藏书签」和「rotate 立即作废」', () => {
    expect(createDashboardTranslator('zh')('workbench.standingLink.note')).toMatch(/书签.*rotate/s);
    expect(createDashboardTranslator('en')('workbench.standingLink.note')).toMatch(/bookmark.*rotate/is);
  });
});
