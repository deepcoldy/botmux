import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkbenchView } from '../src/dashboard/web/agent-workbench-view.js';
import { AgentWorkbenchDockView } from '../src/dashboard/web/agent-workbench-dock-view.js';
import {
  TerminalPane,
  WebPane,
  type TerminalFrameStatus,
} from '../src/dashboard/web/agent-workbench-panes.js';
import type { WorkbenchApi } from '../src/dashboard/web/agent-workbench-api.js';
import {
  NO_WORKBENCH_CAPABILITIES,
  parseWorkbenchCapabilities,
  type WorkbenchCapabilities,
} from '../src/dashboard/web/agent-workbench-capabilities.js';
// 服务端投影函数：P1-4 六类身份矩阵直接消费它，把组件渲染钉在服务端同一份投影上。
import {
  projectWorkbenchOperationCapabilities,
  type WorkbenchCapabilityActor,
} from '../src/dashboard/auth.js';
import { defaultWorkbenchLayout, type WorkbenchSessionRow } from '../src/dashboard/web/agent-workbench-model.js';
import {
  workbenchLayoutStorageKey,
  type WorkbenchStorage,
} from '../src/dashboard/web/agent-workbench-storage.js';

/** legacy owner 的服务端投影值（P1-4）：三类操作能力齐全。既有用例统一用它——
 *  它们验证的都是「有权身份」形态；按能力隐藏入口的矩阵在文件末尾单独一组。 */
const FULL_CAPABILITIES: WorkbenchCapabilities = { canLocate: true, canControl: true, canInteract: true };

const api: WorkbenchApi = {
  getTerminalControl: async () => ({ mode: 'readonly', owned: false }),
  takeoverTerminal: async () => ({ mode: 'controlled', owned: true, expiresAt: Date.now() + 60_000 }),
  releaseTerminal: async () => ({ mode: 'readonly', owned: false }),
  getPreviewInteraction: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'not a security boundary' }),
  unlockPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a security boundary', idleExpiresAt: Date.now() + 60_000 }),
  touchPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a security boundary', idleExpiresAt: Date.now() + 60_000 }),
  lockPreview: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'not a security boundary' }),
  getH5Context: async () => null,
  getTerminalViewLink: async () => null,
  locateSession: async () => {},
};

function sessions(count = 320): WorkbenchSessionRow[] {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `session-${index}`,
    status: index !== 0 && index % 17 === 0 ? 'closed' : 'working',
    title: `Full title for session ${index} that remains available through title and aria-label`,
    botName: 'Builder',
    cliId: 'codex',
    chatId: `oc_${index}`,
    lastMessageAt: 1_800_000_000_000 + index,
    ...(index === 0 ? { agentAttention: { reason: 'Approve deployment', at: 1_900_000_000_000 } } : {}),
  }));
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
}

/** 单会话夹具：会话类型徽标和定位按钮都只看 chatType/scope，其它字段保持最小。 */
function kindSession(patch: Partial<WorkbenchSessionRow>): WorkbenchSessionRow {
  return {
    sessionId: 'session-0',
    status: 'working',
    title: 'Full title for session 0',
    botName: 'Builder',
    cliId: 'codex',
    chatId: 'oc_0',
    lastMessageAt: 1_800_000_000_000,
    ...patch,
  };
}

function kindViewProps(session: WorkbenchSessionRow, overrides: Partial<{ api: WorkbenchApi }> = {}) {
  return {
    sessions: [session],
    online: true,
    authenticated: true,
    capabilities: FULL_CAPABILITIES,
    initialSessionId: session.sessionId,
    viewportWidth: 1440,
    now: 1_900_000_001_000,
    api,
    storage: null,
    location: null,
    sdk: null,
    h5Context: null,
    onRouteChange: () => {},
    ...overrides,
  };
}

function kindBadges(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(node =>
    node.type === 'span' && String(node.props.className ?? '').includes('wb-session-kind'));
}

function locateButtons(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(node =>
    node.type === 'button' && String(node.props.className ?? '').includes('is-locate'));
}

/** 组头是**按钮**，不是 div —— 折叠靠点它，所以它必须是可聚焦、可回车的原生控件。
 *  断言故意从 node.type 认起：哪天它退回成 div，这里立刻红。 */
function groupHeaders(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(node =>
    node.type === 'button' && String(node.props.className ?? '').startsWith('wb-session-group'));
}

function groupHeaderLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return groupHeaders(renderer).map(node => textOf(node.findByType('strong')));
}

class MemoryStorage implements WorkbenchStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

/** 窗口级栏宽记录的 key，和 agent-workbench-storage 里的常量保持一致。 */
const RAIL_PREFS_KEY = 'botmux.agent-workbench.rail.v1';

/** 侧栏宽度只通过根节点上的这个 CSS 变量下发，所以断言直接读它。 */
function railWidthVar(renderer: TestRenderer.ReactTestRenderer): string {
  const root = renderer.root.findByProps({ className: 'agent-workbench-page' });
  return String((root.props.style as Record<string, string>)['--wb-rail-width']);
}

function railViewProps(storage: WorkbenchStorage) {
  return {
    sessions: sessions(3),
    online: true,
    authenticated: true,
    capabilities: FULL_CAPABILITIES,
    initialSessionId: 'session-0',
    viewportWidth: 1440,
    now: 1_900_000_001_000,
    api,
    storage,
    location: null,
    sdk: null,
    h5Context: null,
    onRouteChange: () => {},
  };
}

describe('Agent Workbench components', () => {
  it('chat-follow rows are real chat anchors, never scripted opens', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    const picked: string[] = [];
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        sessions: sessions(6),
        online: true,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        initialSessionId: 'session-0',
        viewportWidth: 1440,
        now: 1_900_000_001_000,
        api,
        storage: null,
        location: null,
        sdk: null,
        h5Context: null,
        onRouteChange: () => {},
      }));
    });
    // Desktop + follow-on (the default): the row body itself is the link, so
    // the open rides the user's trusted click — the only unsigned dispatch the
    // Feishu client does not demote to the narrow attached panel.
    const rowLinks = renderer.root.findAll(node =>
      node.type === 'a' && String(node.props.className ?? '').includes('wb-session-copy-link'));
    expect(rowLinks.length).toBeGreaterThan(0);
    expect(rowLinks[0].props.href).toContain('/client/chat/open?openChatId=');
    expect(rowLinks[0].props.target).toBe('_blank');
    expect(rowLinks[0].props.rel).toBe('noopener');
    // Same session, two entry points, one implementation: the row body and the
    // row-end chat icon must carry the identical href — the Dashboard-proven
    // shape, not a parallel reinvention.
    const iconLinks = renderer.root.findAll(node =>
      node.type === 'a' && String(node.props.className ?? '').includes('is-chat'));
    expect(iconLinks.length).toBeGreaterThan(0);
    expect(iconLinks[0].props.href).toBe(rowLinks[0].props.href);
    expect(iconLinks[0].props.rel).toBe('noopener');
    await act(async () => {
      rowLinks[0].props.onClick({ stopPropagation: () => picked.push('stopped') });
    });
    expect(picked).toContain('stopped');
    // The scripted fallback is gone for good: nothing in the view synthesises
    // anchor clicks any more (that path opened chats in the demoted container).
    // The FOLLOW switch that used to turn the anchor shape off is gone too —
    // chatFollowNavigates is now permanently on for every non-mobile layout, so
    // the row body stays a real link and there is no way back to the old path.
    expect(renderer.root.findAll(node =>
      node.type === 'button' && textOf(node).includes('FOLLOW'))).toHaveLength(0);
    expect(renderer.root.findAll(node =>
      node.type === 'a' && String(node.props.className ?? '').includes('wb-session-copy-link')).length).toBeGreaterThan(0);
  });

  it('renders a windowed accessible session list and keeps Info outside panes', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        sessions: sessions(),
        online: true,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        initialSessionId: 'session-0',
        viewportWidth: 1440,
        now: 1_900_000_001_000,
        api,
        storage: null,
        location: null,
        sdk: null,
        h5Context: null,
        onRouteChange: () => {},
      }));
    });
    const options = renderer.root.findAll(node => node.props.role === 'option');
    expect(options.length).toBeGreaterThan(1);
    expect(options.length).toBeLessThan(30);
    expect(options[0].props['aria-label']).toContain('Approve deployment');
    expect(options[0].findByProps({ className: 'wb-session-title' }).props.title).toContain('Full title');
    // The workspace starts empty: session management is the home surface and a
    // terminal only appears once a row button asks for one.
    expect(renderer.root.findAllByProps({ 'aria-label': '终端面板' })).toHaveLength(0);
    const openTerminal = renderer.root.findAll(node => node.props.className === 'wb-session-row-action is-terminal')[0];
    await act(async () => { openTerminal.props.onClick({ stopPropagation() {} }); });
    expect(renderer.root.findByProps({ 'aria-label': '终端面板' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('renders a standalone >=350px Dock with appCenter action and no pane tree', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchDockView, {
        sessions: sessions(3),
        online: true,
        authenticated: true,
        initialSessionId: 'session-0',
        api,
        sdk: null,
        h5Context: { enabled: true, appId: 'cli_x', brand: 'feishu', entryPath: '/auth/feishu' },
        targetOrigin: 'https://dash.example',
        location: null,
        onRouteChange: () => {},
      }));
    });
    const root = renderer.root.findByProps({ className: 'agent-workbench-dock' });
    expect(root.props.style.minWidth).toBe(350);
    expect(renderer.root.findByProps({ className: 'wb-primary-action' }).props.href).toContain('mode=appCenter');
    expect(renderer.root.findAll(node => node.props.className === 'wb-pane')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('renders the full Sessions list in the fixed mobile page stack', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        sessions: sessions(12),
        online: true,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        initialSessionId: 'session-0',
        viewportWidth: 390,
        api,
        storage: null,
        location: null,
        sdk: null,
        h5Context: null,
        onRouteChange: () => {},
      }));
    });
    expect(renderer.root.findByProps({ 'data-responsive-step': 'mobile-stack' })).toBeTruthy();
    // The chat-contract banner was removed with the pane toolbar: chat is a link
    // on each row now, and narrow layouts open on the session list itself.
    // Mobile is a drill-down now, not an in-page tab bar: the list is the home
    // level, so a second navigation does not compete with Feishu's own tab bar.
    expect(renderer.root.findAllByProps({ className: 'wb-mobile-nav' })).toHaveLength(0);
    expect(renderer.root.findByProps({ className: 'wb-session-list' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ className: 'wb-rail-expand' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('keeps an explicit session selection when the initial route prop is unchanged', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        sessions: sessions(3),
        online: true,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        initialSessionId: 'session-0',
        viewportWidth: 1440,
        api,
        storage: null,
        location: null,
        sdk: null,
        h5Context: null,
        onRouteChange: () => {},
      }));
    });
    const second = renderer.root.findAll(node => node.props.role === 'option')
      .find(option => String(option.props['aria-label']).includes('session 1'))!;
    await act(async () => { second.props.onClick(); });
    expect(renderer.root.findAll(node => String(node.props['aria-label']).includes('工作台 — Full title for session 1'))).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('keeps the rail width when the selected session changes', async () => {
    const storage = new MemoryStorage();
    // 两个会话各自存着不同的旧栏宽：以前切换会话会把这份 per-session 值读回来，宽度就跳了。
    storage.setItem(workbenchLayoutStorageKey('session-0'), JSON.stringify({ ...defaultWorkbenchLayout(), railWidth: 200 }));
    storage.setItem(workbenchLayoutStorageKey('session-1'), JSON.stringify({ ...defaultWorkbenchLayout(), railWidth: 440 }));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, railViewProps(storage)));
    });
    // 还没有全局记录时，退回当前会话那份值当迁移兜底。
    expect(railWidthVar(renderer)).toBe('200px');

    const second = renderer.root.findAll(node => node.props.role === 'option')
      .find(option => String(option.props['aria-label']).includes('session 1'))!;
    await act(async () => { second.props.onClick(); });

    // 先确认切换真的发生了，否则下面那条断言会因为压根没切而假绿。
    expect(renderer.root.findAll(node => String(node.props['aria-label']).includes('工作台 — Full title for session 1'))).toHaveLength(1);
    // session-1 自己那份记录写的是 440px，但栏宽属于窗口，不许跟着会话走。
    expect(railWidthVar(renderer)).toBe('200px');
    act(() => renderer.unmount());
  });

  it('prefers the window-global rail record over the per-session copy', async () => {
    const storage = new MemoryStorage();
    storage.setItem(workbenchLayoutStorageKey('session-0'), JSON.stringify({ ...defaultWorkbenchLayout(), railWidth: 200 }));
    storage.setItem(RAIL_PREFS_KEY, JSON.stringify({ railWidth: 380, railCollapsed: false }));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, railViewProps(storage)));
    });
    expect(railWidthVar(renderer)).toBe('380px');
    act(() => renderer.unmount());
  });

  it('marks a thread row with the 话题 badge and gives it the locate action', async () => {
    const located: string[] = [];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, kindViewProps(
        kindSession({ chatType: 'group', scope: 'thread' }),
        { api: { ...api, locateSession: async sessionId => { located.push(sessionId); } } },
      )));
    });
    const badges = kindBadges(renderer);
    expect(badges).toHaveLength(1);
    expect(textOf(badges[0])).toBe('话题');
    expect(badges[0].props.className).toContain('is-thread');
    expect(badges[0].props.title).toBe('话题会话');

    // 定位是话题会话独有的第二条回跳路径，和聊天入口并存而不是替代它。
    const locate = locateButtons(renderer);
    expect(locate).toHaveLength(1);
    expect(locate[0].props.disabled).toBe(false);
    expect(locate[0].props['aria-label']).toContain('在话题里 @ 我定位');
    // 按钮是文字而不是图标：文案本身就是可读标签，别再退回纯 icon。
    expect(textOf(locate[0])).toBe('定位');
    await act(async () => { locate[0].props.onClick({ stopPropagation() {} }); });
    expect(located).toEqual(['session-0']);

    // 冷却状态挂在列表上而不是按钮上：点过之后按钮立刻禁用，连点绕不过服务端 30s 限流。
    const cooling = locateButtons(renderer)[0];
    expect(cooling.props.disabled).toBe(true);
    expect(cooling.props.title).toContain('30 秒后可再次使用');
    // 成功态换文案（而不是只换颜色），2 秒后自己退回「定位」。
    expect(textOf(cooling)).toBe('已发送');
    act(() => renderer.unmount());
  });

  it('leaves a group-chat row without a locate action', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        kindViewProps(kindSession({ chatType: 'group', scope: 'chat' })),
      ));
    });
    const badges = kindBadges(renderer);
    expect(badges).toHaveLength(1);
    expect(textOf(badges[0])).toBe('群');
    expect(badges[0].props.className).toContain('is-group');
    // 群会话没有可回跳的话题锚点，所以定位按钮整体不渲染（而不是渲染成禁用态）。
    expect(locateButtons(renderer)).toHaveLength(0);
    // 但聊天入口照旧在，否则这条断言会把「按钮全没了」也当成通过。
    expect(renderer.root.findAll(node =>
      node.type === 'a' && String(node.props.className ?? '').includes('is-chat')).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('binds a preview descriptor to the selected session and shows the weak-overlay boundary', async () => {
    const selected = sessions(1)[0];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WebPane, {
        session: { ...selected, preview: { path: '/preview/another-session/', registeredAt: new Date().toISOString() } },
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        api,
        now: Date.now(),
      }));
    });
    expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
    expect(textOf(renderer.root)).toContain('未注册网页预览');
    act(() => renderer.unmount());

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WebPane, {
        session: { ...selected, preview: { path: '/preview/session-0/', registeredAt: new Date().toISOString() } },
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        api,
        now: Date.now(),
      }));
    });
    expect(renderer.root.findByType('iframe').props.src).toBe('/preview/session-0/');
    expect(textOf(renderer.root)).toContain('not a security boundary');
    act(() => renderer.unmount());
  });
});

describe('mobile session surfaces', () => {
  const mobileProps = {
    online: true,
    authenticated: true,
    capabilities: FULL_CAPABILITIES,
    initialSessionId: 'session-0',
    viewportWidth: 390,
    api,
    storage: null,
    location: null,
    sdk: null,
    h5Context: null,
    onRouteChange: () => {},
  };

  function segmentLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root
      .findAll(node => node.props.className === 'wb-mobile-detail-seg')
      .flatMap(seg => seg.findAllByType('button').map(textOf));
  }

  it('offers Web only for a session that registered a preview', async () => {
    const withPreview = sessions(2);
    withPreview[0] = {
      ...withPreview[0],
      preview: { path: '/preview/session-0/', registeredAt: new Date().toISOString() },
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, { ...mobileProps, sessions: withPreview }));
    });
    const row = renderer.root.findAll(node => node.props.role === 'option')[0];
    await act(async () => { row.props.onClick(); });
    expect(segmentLabels(renderer)).toEqual(['终端', '网页', '信息']);
    act(() => renderer.unmount());
  });

  it('hides Web when no preview is registered, so the tab never opens empty', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, { ...mobileProps, sessions: sessions(2) }));
    });
    const row = renderer.root.findAll(node => node.props.role === 'option')[0];
    await act(async () => { row.props.onClick(); });
    expect(segmentLabels(renderer)).toEqual(['终端', '信息']);
    act(() => renderer.unmount());
  });

  /** 终端可框起来的最小会话：webPort + proxyPort + location 三者齐了
   *  workbenchTerminalHref 才给出 /s/<id> 地址，否则面板只渲染空态。 */
  function framedSessions(): WorkbenchSessionRow[] {
    return sessions(2).map(row => ({ ...row, webPort: 7681, proxyPort: 7682 }));
  }
  const terminalLocation = { protocol: 'http:', origin: 'http://dashboard.test', hostname: 'dashboard.test' };

  function terminalFrame(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance | null {
    return renderer.root.findAll(node =>
      node.type === 'iframe' && String(node.props.className ?? '').includes('wb-pane-frame'))[0] ?? null;
  }

  /** 直嵌契约：iframe 就挂在面板容器下，中间没有任何做缩放的包一层。 */
  function expectPlainEmbed(frame: ReactTestInstance): void {
    expect(frame.props.className).toBe('wb-pane-frame');
    expect(frame.props.style).toBeUndefined();
    expect(frame.parent?.props.className).toBe('wb-pane-frame-shell');
  }

  it('embeds the phone terminal directly, with no scaling wrapper around the frame', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        ...mobileProps,
        sessions: framedSessions(),
        location: terminalLocation,
      }));
    });
    const row = renderer.root.findAll(node => node.props.role === 'option')[0];
    await act(async () => { row.props.onClick(); });
    // Phones take the same plain-iframe path as pointer layouts. A transform
    // scale here is what blanked the terminal on iOS: WKWebView does not
    // composite canvas/WebGL inside a scaled iframe. The terminal page fits
    // itself to whatever width the iframe actually has, so none is needed.
    const frame = terminalFrame(renderer)!;
    expect(frame).toBeTruthy();
    expect(String(frame.props.src)).toContain('/s/session-0');
    expectPlainEmbed(frame);
    act(() => renderer.unmount());
  });

  it('leaves the pointer-layout terminal unscaled too, matching the phone contract', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        ...mobileProps,
        viewportWidth: 1440,
        sessions: framedSessions(),
        location: terminalLocation,
      }));
    });
    const openTerminal = renderer.root.findAll(node => node.props.className === 'wb-session-row-action is-terminal')[0];
    await act(async () => { openTerminal.props.onClick({ stopPropagation() {} }); });
    const frame = terminalFrame(renderer)!;
    expect(frame).toBeTruthy();
    expectPlainEmbed(frame);
    act(() => renderer.unmount());
  });
});

describe('Agent Workbench 未读与分组维度', () => {
  /** 分组维度的持久化 key，和 agent-workbench-storage 里的常量保持一致。 */
  const GROUP_DIMENSION_KEY = 'botmux.agent-workbench.group-dim.v1';
  /** 会话活动时间刻意远早于 now：账本首次基线把它们全记成已读，
   *  这样任何未读都只可能来自状态跃迁，而不是活动时间兜底。 */
  const NOW = 1_900_000_001_000;

  /** 两个会话分属不同机器人/CLI，切维度后组头才看得出变化。 */
  function unreadRow(index: number, patch: Partial<WorkbenchSessionRow> = {}): WorkbenchSessionRow {
    return {
      sessionId: `session-${index}`,
      status: 'working',
      title: `Full title for session ${index}`,
      botName: index === 0 ? 'Builder' : 'Reviewer',
      cliId: index === 0 ? 'codex' : 'claude',
      chatId: `oc_${index}`,
      lastMessageAt: 1_800_000_000_000 + index,
      ...patch,
    };
  }

  function viewProps(rows: WorkbenchSessionRow[], storage: WorkbenchStorage) {
    return {
      sessions: rows,
      online: true,
      authenticated: true,
      capabilities: FULL_CAPABILITIES,
      initialSessionId: 'session-0',
      viewportWidth: 1440,
      now: NOW,
      api,
      storage,
      location: null,
      sdk: null,
      h5Context: null,
      onRouteChange: () => {},
    };
  }

  /** 未读行：className 上带 is-unread 的会话行。 */
  function unreadRowLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root
      .findAll(node => node.type === 'div' && String(node.props.className ?? '').includes('is-unread'))
      .map(node => String(node.props['aria-label']));
  }

  function rowByTitle(renderer: TestRenderer.ReactTestRenderer, title: string): ReactTestInstance {
    return renderer.root
      .findAll(node => node.props.role === 'option')
      .find(node => String(node.props['aria-label']).startsWith(title))!;
  }

  it('把 working→idle 的跃迁标成未读、并进「待你处理」，点开即清', async () => {
    const storage = new MemoryStorage();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        viewProps([unreadRow(0), unreadRow(1)], storage),
      ));
    });
    // 首屏：账本把当前快照全记成已读，一条未读都不该有。
    expect(groupHeaderLabels(renderer)).toEqual(['进行中']);
    expect(unreadRowLabels(renderer)).toEqual([]);
    expect(renderer.root.findAllByProps({ className: 'wb-unread-dot' })).toHaveLength(0);

    // session-1 干完这一轮：working → idle，这就是未读的主信号。
    await act(async () => {
      renderer.update(React.createElement(
        AgentWorkbenchView,
        viewProps([unreadRow(0), unreadRow(1, { status: 'idle' })], storage),
      ));
    });
    // 未读把它抽进置顶的「待你处理」，理由那格写「有新回复」。
    expect(groupHeaderLabels(renderer)).toEqual(['待你处理', '进行中']);
    expect(unreadRowLabels(renderer)).toEqual(['Full title for session 1. 待你处理. 有新回复']);
    expect(renderer.root.findAllByProps({ className: 'wb-unread-dot' })).toHaveLength(1);

    // 点开即清。
    await act(async () => { rowByTitle(renderer, 'Full title for session 1').props.onClick(); });
    expect(unreadRowLabels(renderer)).toEqual([]);

    // 选中的会话本来就不标未读，所以再切回 session-0，确认账本真的清了、
    // 而不是被「当前选中」这条规则临时盖住。
    await act(async () => { rowByTitle(renderer, 'Full title for session 0').props.onClick(); });
    expect(unreadRowLabels(renderer)).toEqual([]);
    expect(groupHeaderLabels(renderer)).toEqual(['进行中']);
    act(() => renderer.unmount());
  });

  it('正在看的那个会话干完活不算未读', async () => {
    const storage = new MemoryStorage();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        viewProps([unreadRow(0), unreadRow(1)], storage),
      ));
    });
    // 跃迁发生在当前选中的 session-0 上：你正看着它，没有「你还没看」这回事。
    await act(async () => {
      renderer.update(React.createElement(
        AgentWorkbenchView,
        viewProps([unreadRow(0, { status: 'idle' }), unreadRow(1)], storage),
      ));
    });
    expect(unreadRowLabels(renderer)).toEqual([]);
    expect(groupHeaderLabels(renderer)).toEqual(['进行中']);
    act(() => renderer.unmount());
  });

  it('维度下拉切换分组，选择立刻落盘并在下次挂载时生效', async () => {
    const storage = new MemoryStorage();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        viewProps([unreadRow(0), unreadRow(1)], storage),
      ));
    });
    const select = renderer.root.findByProps({ className: 'wb-group-dim' });
    expect(select.props['aria-label']).toBe('分组维度');
    // 默认维度是「状态」，也就是改版前那套分组。
    expect(select.props.value).toBe('status');
    expect(select.findAllByType('option').map(textOf))
      .toEqual(['状态', '机器人', '会话位置', '类型', 'CLI', '活跃时间']);
    expect(groupHeaderLabels(renderer)).toEqual(['进行中']);

    // 切到「机器人」：组头换成机器人名，按最新活跃排序（session-1 更新）。
    await act(async () => { select.props.onChange({ currentTarget: { value: 'bot' } }); });
    expect(groupHeaderLabels(renderer)).toEqual(['Reviewer', 'Builder']);
    expect(storage.values.get(GROUP_DIMENSION_KEY)).toBe('bot');

    // 切到「CLI」：同一批会话按 cliId 重新分组。
    await act(async () => { select.props.onChange({ currentTarget: { value: 'cli' } }); });
    expect(groupHeaderLabels(renderer)).toEqual(['claude', 'codex']);
    expect(storage.values.get(GROUP_DIMENSION_KEY)).toBe('cli');

    // 白名单外的值被下拉自己挡掉：既不换组，也不写盘。
    await act(async () => { select.props.onChange({ currentTarget: { value: 'repo' } }); });
    expect(groupHeaderLabels(renderer)).toEqual(['claude', 'codex']);
    expect(storage.values.get(GROUP_DIMENSION_KEY)).toBe('cli');
    act(() => renderer.unmount());

    // 重新挂载读回持久化的维度，而不是弹回默认的「状态」。
    let reopened!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      reopened = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        viewProps([unreadRow(0), unreadRow(1)], storage),
      ));
    });
    expect(reopened.root.findByProps({ className: 'wb-group-dim' }).props.value).toBe('cli');
    expect(groupHeaderLabels(reopened)).toEqual(['claude', 'codex']);
    act(() => reopened.unmount());
  });

  it('切换维度不影响未读：「待你处理」在任何维度下都置顶', async () => {
    const storage = new MemoryStorage();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        viewProps([unreadRow(0), unreadRow(1)], storage),
      ));
    });
    await act(async () => {
      renderer.update(React.createElement(
        AgentWorkbenchView,
        viewProps([unreadRow(0), unreadRow(1, { status: 'idle' })], storage),
      ));
    });
    expect(groupHeaderLabels(renderer)).toEqual(['待你处理', '进行中']);

    const select = renderer.root.findByProps({ className: 'wb-group-dim' });
    await act(async () => { select.props.onChange({ currentTarget: { value: 'bot' } }); });
    // 未读的 session-1 被抽走后，剩下的只有 Builder 那一组——空桶不产出组头。
    expect(groupHeaderLabels(renderer)).toEqual(['待你处理', 'Builder']);
    expect(unreadRowLabels(renderer)).toEqual(['Full title for session 1. 待你处理. 有新回复']);
    act(() => renderer.unmount());
  });
});

describe('Agent Workbench 分组折叠', () => {
  /** 折叠状态的持久化 key，和 agent-workbench-storage 里的常量保持一致。 */
  const COLLAPSED_GROUPS_KEY = 'botmux.agent-workbench.collapsed.v1';
  const NOW = 1_900_000_001_000;

  /** 列表的折叠状态直接读写 window.localStorage（工作台和会话坞共用同一份），
   *  单测跑在 node 上压根没有 window，所以临时挂一个最小实现，测完还原。 */
  let browser: MemoryStorage;
  let previousWindow: unknown;
  beforeEach(() => {
    browser = new MemoryStorage();
    previousWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = { localStorage: browser };
  });
  afterEach(() => {
    if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = previousWindow;
  });

  /** 默认的「状态」维度下分成两组：session-0 有 attention 进「待你处理」，
   *  另外两条留在「进行中」，折叠一组就能看出另一组不受影响。 */
  function collapseRows(): WorkbenchSessionRow[] {
    return [
      { ...kindSession({ agentAttention: { reason: 'Approve deployment', at: 1_900_000_000_000 } }) },
      { ...kindSession({}), sessionId: 'session-1', title: 'Full title for session 1', lastMessageAt: 1_800_000_000_001 },
      { ...kindSession({}), sessionId: 'session-2', title: 'Full title for session 2', lastMessageAt: 1_800_000_000_002 },
    ];
  }

  function collapseViewProps(rows: WorkbenchSessionRow[], storage: WorkbenchStorage) {
    return {
      sessions: rows,
      online: true,
      authenticated: true,
      capabilities: FULL_CAPABILITIES,
      initialSessionId: 'session-0',
      viewportWidth: 1440,
      now: NOW,
      api,
      storage,
      location: null,
      sdk: null,
      h5Context: null,
      onRouteChange: () => {},
    };
  }

  function headerFor(renderer: TestRenderer.ReactTestRenderer, label: string): ReactTestInstance {
    return groupHeaders(renderer).find(node => textOf(node.findByType('strong')) === label)!;
  }

  /** 组头最右边那格就是条数；它是折叠前的真实条数，收起来也不该变。 */
  function headerCount(header: ReactTestInstance): string {
    return textOf(header.findAllByType('span').at(-1)!);
  }

  function rowTitles(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root
      .findAll(node => node.props.role === 'option')
      .map(node => String(node.props['aria-label']).split('.')[0]);
  }

  function expandedFlags(renderer: TestRenderer.ReactTestRenderer): unknown[] {
    return groupHeaders(renderer).map(node => node.props['aria-expanded']);
  }

  it('点组头折叠该组的会话行，aria-expanded 翻成 false，再点恢复', async () => {
    const storage = new MemoryStorage();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        collapseViewProps(collapseRows(), storage),
      ));
    });
    // 组头必须是原生 button：可聚焦、可回车，读屏器也才会把它读成可展开的控件。
    expect(groupHeaders(renderer)).toHaveLength(2);
    expect(groupHeaderLabels(renderer)).toEqual(['待你处理', '进行中']);
    expect(groupHeaders(renderer).every(node => node.props.type === 'button')).toBe(true);
    // 默认全展开：三条会话行都在，组内按最新活跃降序。
    expect(expandedFlags(renderer)).toEqual([true, true]);
    expect(rowTitles(renderer)).toEqual([
      'Full title for session 0', 'Full title for session 2', 'Full title for session 1',
    ]);

    const active = headerFor(renderer, '进行中');
    expect(active.props.title).toBe('折叠「进行中」');
    await act(async () => { active.props.onClick(); });

    // 这一组的会话行整体消失，另一组一条不少——折叠是按组的，不是全局开关。
    expect(rowTitles(renderer)).toEqual(['Full title for session 0']);
    expect(expandedFlags(renderer)).toEqual([true, false]);
    // 组头自己还在，否则用户没有地方点回来。
    expect(groupHeaderLabels(renderer)).toEqual(['待你处理', '进行中']);
    const collapsedHeader = headerFor(renderer, '进行中');
    expect(collapsedHeader.props.title).toBe('展开「进行中」');
    // 收起来时更要说清里面压着几条，所以 count 仍是折叠前的真实条数。
    expect(headerCount(collapsedHeader)).toBe('2');
    expect(headerCount(headerFor(renderer, '待你处理'))).toBe('1');

    // 再点一次原样恢复，顺序也不变。
    await act(async () => { headerFor(renderer, '进行中').props.onClick(); });
    expect(expandedFlags(renderer)).toEqual([true, true]);
    expect(rowTitles(renderer)).toEqual([
      'Full title for session 0', 'Full title for session 2', 'Full title for session 1',
    ]);
    act(() => renderer.unmount());
  });

  it('折叠状态立刻落盘，重新挂载时读回来', async () => {
    const storage = new MemoryStorage();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        collapseViewProps(collapseRows(), storage),
      ));
    });
    // 没折叠过就不写盘，别给每个打开过工作台的浏览器凭空塞一条记录。
    expect(browser.values.has(COLLAPSED_GROUPS_KEY)).toBe(false);

    await act(async () => { headerFor(renderer, '进行中').props.onClick(); });
    // 按一下就该记住，不攒批：存的是组的稳定 key（状态维度沿用 active 这个保留 key）。
    expect(JSON.parse(browser.values.get(COLLAPSED_GROUPS_KEY)!)).toEqual(['active']);
    act(() => renderer.unmount());

    // 重新挂载：折叠状态从 localStorage 读回来，而不是弹回全展开。
    let reopened!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      reopened = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        collapseViewProps(collapseRows(), storage),
      ));
    });
    expect(groupHeaderLabels(reopened)).toEqual(['待你处理', '进行中']);
    expect(expandedFlags(reopened)).toEqual([true, false]);
    expect(rowTitles(reopened)).toEqual(['Full title for session 0']);

    // 在新的这次挂载里展开，同样立刻落盘 —— 记忆是双向的。
    await act(async () => { headerFor(reopened, '进行中').props.onClick(); });
    expect(JSON.parse(browser.values.get(COLLAPSED_GROUPS_KEY)!)).toEqual([]);
    expect(rowTitles(reopened)).toHaveLength(3);
    act(() => reopened.unmount());
  });

  it('把所有组折起来也不等于「没有会话」，空态提示不出现', async () => {
    const storage = new MemoryStorage();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        AgentWorkbenchView,
        collapseViewProps(collapseRows(), storage),
      ));
    });
    await act(async () => { headerFor(renderer, '进行中').props.onClick(); });
    await act(async () => { headerFor(renderer, '待你处理').props.onClick(); });

    expect(rowTitles(renderer)).toEqual([]);
    expect(expandedFlags(renderer)).toEqual([false, false]);
    // 全折起来只是把行藏了，不代表搜不到东西：空态文案一出现就是在骗人。
    expect(renderer.root.findAll(node =>
      String(node.props.className ?? '') === 'wb-session-empty')).toHaveLength(0);
    expect(JSON.parse(browser.values.get(COLLAPSED_GROUPS_KEY)!)).toEqual(['active', 'needs-you']);
    act(() => renderer.unmount());
  });
});

describe('终端面板：实时通道被拦时的降级提示', () => {
  const NOW = 1_900_000_001_000;
  let previousWindow: unknown;

  beforeEach(() => {
    vi.useFakeTimers();
    previousWindow = (globalThis as Record<string, unknown>).window;
    // 整套探测只在触屏环境启用，所以先把 window 伪装成手机（无 hover）。
    (globalThis as Record<string, unknown>).window = {
      matchMedia: (query: string) => ({
        matches: query === '(hover: none)',
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = previousWindow;
  });

  const BLOCKED_HEADLINE = '终端实时连接未建立';
  /** 触屏下 iframe 挂的是带 viewToken 的只读链接（iOS WebView 的 WS 不带 Cookie，同源
   *  地址握不上手），所以这里的 api 必须给得出这条链接，否则面板停在空态、连 iframe 都
   *  没有，覆盖层也就无从谈起。 */
  const VIEW_LINK = 'https://board.example/s/session-0?viewToken=view-cap-abc';
  const touchApi: WorkbenchApi = {
    ...api,
    getTerminalViewLink: async () => ({ url: VIEW_LINK, expiresAt: null }),
  };

  /** 组件测试拿不到真 iframe 的 internals，所以把「读状态」当 prop 注进去。
   *  生产默认实现读的是同源 iframe 里的 #status 节点。 */
  async function renderTerminal(read: () => TerminalFrameStatus): Promise<TestRenderer.ReactTestRenderer> {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: { ...kindSession({}), webPort: 7681, proxyPort: 7682 },
        api: touchApi,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        now: NOW,
        location: { protocol: 'https:', origin: 'https://board.example', hostname: 'board.example' },
        readFrameStatus: () => read(),
      }));
    });
    // 轮询从 iframe 的 onLoad 起步：页面还没加载完就开始读，读到的只会是 unknown。
    await act(async () => { renderer.root.findByType('iframe').props.onLoad(); });
    return renderer;
  }

  it('持续读不到连接才盖提示，并给出用浏览器打开的出路', async () => {
    let status: TerminalFrameStatus = 'disconnected';
    const renderer = await renderTerminal(() => status);

    // 7 秒还没到阈值：终端页自己每 2 秒重连一次，一断就吓唬人只会误报。
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
    expect(textOf(renderer.root)).not.toContain(BLOCKED_HEADLINE);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(textOf(renderer.root)).toContain(BLOCKED_HEADLINE);
    const links = renderer.root.findAll(node => node.type === 'a' && textOf(node) === '在浏览器中打开');
    expect(links).toHaveLength(1);
    // 出路给的是 iframe 正在用的那条 viewToken 链接：换成裸同源地址，在系统浏览器里
    // 一样连不上（无 Cookie 的 WS 会被 403）。
    expect(links[0].props.href).toBe(VIEW_LINK);
    expect(links[0].props.target).toBe('_blank');
    // iframe 不卸载：底下的页面一直在重连，卸了就永远连不上了。
    expect(renderer.root.findAllByType('iframe')).toHaveLength(1);

    // 读不到状态（跨域/时序）不算证据，但也不该把已经显示的提示撤掉。
    status = 'unknown';
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(textOf(renderer.root)).toContain(BLOCKED_HEADLINE);

    // 页面自己重连上了 → 提示自动消失，不需要用户做任何事。
    status = 'connected';
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(textOf(renderer.root)).not.toContain(BLOCKED_HEADLINE);
    act(() => renderer.unmount());
  });

  it('连上过一次之后再断开也不再打扰', async () => {
    let status: TerminalFrameStatus = 'connected';
    const renderer = await renderTerminal(() => status);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(textOf(renderer.root)).not.toContain(BLOCKED_HEADLINE);

    // 连过就说明这个浏览器环境没拦 ws://，后续闪断交给终端页自身的重连。
    status = 'disconnected';
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(textOf(renderer.root)).not.toContain(BLOCKED_HEADLINE);
    act(() => renderer.unmount());
  });
});

describe('终端面板：触屏改走 viewToken 链路', () => {
  const NOW = 1_900_000_001_000;
  /** 两条链接都是同源的——api 层已把 view-link 改写到工作台 origin（反代自身端口未必对
   *  客户端网段放行）。区别只在鉴权方式：带 viewToken 的走能力凭证，裸路径靠 Cookie。 */
  const VIEW_LINK = 'https://board.example/s/session-0?viewToken=view-cap-abc';
  const COOKIE_TERMINAL_URL = 'https://board.example/s/session-0';
  const TOUCH_FEEDBACK = '只读查看中。手机端为只读视图，需要输入请在电脑上操作。';
  let previousWindow: unknown;

  /** 触屏与否只由 useTouchEnvironment 的 matchMedia('(hover: none)') 读数决定。 */
  function setTouchEnvironment(touch: boolean): void {
    (globalThis as Record<string, unknown>).window = {
      matchMedia: (query: string) => ({
        matches: touch && query === '(hover: none)',
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    };
  }

  beforeEach(() => { previousWindow = (globalThis as Record<string, unknown>).window; });
  afterEach(() => {
    if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = previousWindow;
  });

  /** 一律用登录态渲染：本组要证明的正是「登录与否不决定走哪条链路，触屏与否才决定」。 */
  async function renderTerminal(overrides: Partial<WorkbenchApi> = {}): Promise<{
    renderer: TestRenderer.ReactTestRenderer;
    viewLinkCalls: string[];
  }> {
    const viewLinkCalls: string[] = [];
    const paneApi: WorkbenchApi = {
      ...api,
      getTerminalViewLink: async (sessionId: string) => {
        viewLinkCalls.push(sessionId);
        return { url: VIEW_LINK, expiresAt: null };
      },
      ...overrides,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: { ...kindSession({}), webPort: 7681, proxyPort: 7682 },
        api: paneApi,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        now: NOW,
        location: { protocol: 'https:', origin: 'https://board.example', hostname: 'board.example' },
      }));
    });
    return { renderer, viewLinkCalls };
  }

  function buttonLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root.findAllByType('button').map(node => textOf(node));
  }

  it('触屏即使已登录也挂 viewToken 链接，并且不给接管按钮', async () => {
    setTouchEnvironment(true);
    const { renderer, viewLinkCalls } = await renderTerminal();

    // iOS WebView 的 WebSocket 升级不带 Cookie，同源 /s/<id> 必然 403 到黑屏；
    // 凭证必须在查询参数里。
    expect(viewLinkCalls).toEqual(['session-0']);
    const src = String(renderer.root.findByType('iframe').props.src);
    expect(src).toBe(VIEW_LINK);
    expect(src).toContain('viewToken=');
    expect(src).not.toBe(COOKIE_TERMINAL_URL);
    // viewToken 通道只读，接管按钮点了也送不进输入，摆出来只会误导。
    expect(buttonLabels(renderer)).not.toContain('接管输入');
    expect(buttonLabels(renderer)).not.toContain('释放输入');
    expect(textOf(renderer.root)).toContain(TOUCH_FEEDBACK);
    act(() => renderer.unmount());
  });

  it('桌面登录态照旧走同源地址，接管按钮还在', async () => {
    setTouchEnvironment(false);
    const { renderer, viewLinkCalls } = await renderTerminal();

    // 桌面浏览器的 WS 正常带 Cookie，同源那条还捎带接管授权，没有理由绕道。
    expect(viewLinkCalls).toEqual([]);
    expect(renderer.root.findByType('iframe').props.src).toBe(COOKIE_TERMINAL_URL);
    expect(buttonLabels(renderer)).toContain('接管输入');
    expect(textOf(renderer.root)).toContain('只读查看中，点「接管输入」可操作。');
    expect(textOf(renderer.root)).not.toContain(TOUCH_FEEDBACK);
    act(() => renderer.unmount());
  });

  it('触屏拿不到 viewToken 链接时停在空态，绝不回退到同源地址', async () => {
    setTouchEnvironment(true);
    const { renderer } = await renderTerminal({ getTerminalViewLink: async () => null });

    // 裸同源地址在触屏上只会是黑屏，宁可空着也不能挂上去。
    expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
    expect(textOf(renderer.root)).toContain('只读链接获取失败');
    expect(renderer.root.findAll(node => node.type === 'a').map(node => node.props.href))
      .not.toContain(COOKIE_TERMINAL_URL);
    act(() => renderer.unmount());
  });

  it('短时 viewToken 到期前主动换链：旧 iframe 顶到新链接就位再换 src', async () => {
    // P1-5 后 view-link 是短时能力（服务端会在 expiresAt 关掉 WS 并拒绝重连）。
    // 面板必须赶在到期前重取一条新链接，否则触屏终端会在 TTL 后死在黑屏重连循环里。
    vi.useFakeTimers();
    try {
      setTouchEnvironment(true);
      const mints: string[] = [];
      const { renderer } = await renderTerminal({
        getTerminalViewLink: async (sessionId: string) => {
          mints.push(sessionId);
          return { url: `${VIEW_LINK}-${mints.length}`, expiresAt: Date.now() + 120_000 };
        },
      });
      expect(mints).toEqual(['session-0']);
      expect(String(renderer.root.findByType('iframe').props.src)).toBe(`${VIEW_LINK}-1`);

      // 到期前 30 秒（120s - 30s = 90s）自动重取；旧链接在新链接就位前不撤，
      // iframe 始终在。
      await act(async () => { await vi.advanceTimersByTimeAsync(90_500); });
      expect(mints).toEqual(['session-0', 'session-0']);
      expect(String(renderer.root.findByType('iframe').props.src)).toBe(`${VIEW_LINK}-2`);
      act(() => renderer.unmount());
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 接管是「针对某一行的一次显式动作」，不是工作台的全局模式。
 * 这组用例把两件事拆开钉死：面板可以跟着选中走，**写权限不许跟着走**。
 * 回归的形状是——在 A 行点过「接管」之后，普通选中 B 会把接管意图带过去，
 * 于是用户只是想点开看看的 B 被自动接管了输入。
 */
describe('Agent Workbench 接管意图只属于按下「接管」的那一行', () => {
  const NOW = 1_900_000_001_000;
  /** 终端地址要 webPort + proxyPort + location 三者齐了才成立；缺一个面板只剩空态，
   *  控制权接口压根不会被调用，这组用例也就证明不了任何事。 */
  const terminalLocation = { protocol: 'http:', origin: 'http://dashboard.test', hostname: 'dashboard.test' };
  const READONLY_FEEDBACK = '只读查看中，点「接管输入」可操作。';

  /** A 的活跃时间**更新**，让它稳定排在 B 前面：组内按活跃降序排，j/k 的移动方向
   *  必须可预期，否则键盘那条用例断的是运气。 */
  function pair(): WorkbenchSessionRow[] {
    const base = { status: 'working', botName: 'Builder', cliId: 'codex', webPort: 7681, proxyPort: 7682 };
    return [
      { ...base, sessionId: 'session-a', title: 'Session A', chatId: 'oc_a', lastMessageAt: 1_800_000_002_000 },
      { ...base, sessionId: 'session-b', title: 'Session B', chatId: 'oc_b', lastMessageAt: 1_800_000_001_000 },
    ];
  }

  async function renderPair(): Promise<{
    renderer: TestRenderer.ReactTestRenderer;
    takeovers: string[];
  }> {
    const takeovers: string[] = [];
    const paneApi: WorkbenchApi = {
      ...api,
      takeoverTerminal: async (sessionId: string) => {
        takeovers.push(sessionId);
        return { mode: 'controlled', owned: true, expiresAt: Date.now() + 60_000 };
      },
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        sessions: pair(),
        online: true,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        initialSessionId: 'session-a',
        viewportWidth: 1440,
        now: NOW,
        api: paneApi,
        storage: null,
        location: terminalLocation,
        sdk: null,
        h5Context: null,
        onRouteChange: () => {},
      }));
    });
    return { renderer, takeovers };
  }

  /** 一次点击要走完「重挂面板 → 拉控制权 → 决定要不要接管」好几个 await，
   *  多空跑一轮 act 让这条链彻底落定，断言才不是在半路上取样。 */
  async function settle(): Promise<void> { await act(async () => {}); }

  function rowAction(
    renderer: TestRenderer.ReactTestRenderer,
    title: string,
    surface: 'terminal' | 'terminal-control',
  ): ReactTestInstance {
    return renderer.root.find(node => node.type === 'button'
      && node.props.className === `wb-session-row-action is-${surface}`
      && String(node.props['aria-label'] ?? '').endsWith(`— ${title}`));
  }

  /** 普通选中：点行本身，不碰行内的任何按钮。 */
  async function clickRow(renderer: TestRenderer.ReactTestRenderer, title: string): Promise<void> {
    const row = renderer.root.find(node => node.props.role === 'option'
      && String(node.props['aria-label'] ?? '').startsWith(`${title}.`));
    await act(async () => { row.props.onClick(); });
    await settle();
  }

  async function clickRowAction(
    renderer: TestRenderer.ReactTestRenderer,
    title: string,
    surface: 'terminal' | 'terminal-control',
  ): Promise<void> {
    await act(async () => { rowAction(renderer, title, surface).props.onClick({ stopPropagation() {} }); });
    await settle();
  }

  /** 面板当前挂在哪个会话上、这次打开带不带接管意图。 */
  function paneIntent(
    renderer: TestRenderer.ReactTestRenderer,
  ): { sessionId: string; autoTakeControl: boolean } | null {
    const panes = renderer.root.findAllByType(TerminalPane);
    if (panes.length === 0) return null;
    return {
      sessionId: String(panes[0].props.session.sessionId),
      autoTakeControl: panes[0].props.autoTakeControl === true,
    };
  }

  /** 徽标读的就是面板自己算出来的控制权，比 prop 更贴近用户看到的东西。 */
  function paneMode(renderer: TestRenderer.ReactTestRenderer): 'controlled' | 'readonly' | 'closed' {
    const chips = renderer.root.findAll(node =>
      typeof node.props.className === 'string' && node.props.className.startsWith('wb-mode-chip'));
    if (chips.length === 0) return 'closed';
    return String(chips[0].props.className).includes('is-controlled') ? 'controlled' : 'readonly';
  }

  it('A 行点过接管后普通选中 B：面板跟过去，但只读，且不对 B 发起接管', async () => {
    const { renderer, takeovers } = await renderPair();
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(paneIntent(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: true });
    expect(takeovers).toEqual(['session-a']);
    expect(paneMode(renderer)).toBe('controlled');

    await clickRow(renderer, 'Session B');
    // 跟随是对的（面板不该还钉在 A 上），跟过去的写权限不是。
    expect(paneIntent(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: false });
    expect(takeovers).toEqual(['session-a']);
    expect(paneMode(renderer)).toBe('readonly');
    expect(textOf(renderer.root.findByProps({ 'aria-label': '终端面板' }))).toContain(READONLY_FEEDBACK);
    act(() => renderer.unmount());
  });

  it('键盘 j 选到下一行同样只跟随、不接管', async () => {
    const { renderer, takeovers } = await renderPair();
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(takeovers).toEqual(['session-a']);

    // j/k 走的是同一个 onSelect，和行点击必须给出同一个结论。
    const listbox = renderer.root.find(node => node.props.role === 'listbox');
    await act(async () => {
      listbox.props.onKeyDown({ key: 'j', altKey: false, ctrlKey: false, metaKey: false, target: null, preventDefault() {} });
    });
    await settle();
    expect(paneIntent(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: false });
    expect(takeovers).toEqual(['session-a']);
    expect(paneMode(renderer)).toBe('readonly');
    act(() => renderer.unmount());
  });

  it('B 行显式点接管才对 B 发起接管，面板也不会被误判成二次点击而关掉', async () => {
    const { renderer, takeovers } = await renderPair();
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(takeovers).toEqual(['session-a']);

    await clickRowAction(renderer, 'Session B', 'terminal-control');
    expect(paneIntent(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: true });
    expect(takeovers).toEqual(['session-a', 'session-b']);
    expect(paneMode(renderer)).toBe('controlled');
    act(() => renderer.unmount());
  });

  it('绕回 A 之后再点接管仍然生效：一次性接管 ref 随面板重挂被重置', async () => {
    const { renderer, takeovers } = await renderPair();
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    await clickRow(renderer, 'Session B');
    // 选回 A：普通选中，所以依旧只读——不能因为「A 之前接管过」就自动恢复写权限。
    await clickRow(renderer, 'Session A');
    expect(paneIntent(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });
    expect(takeovers).toEqual(['session-a']);
    expect(paneMode(renderer)).toBe('readonly');

    // 显式再点一次 A 行的「接管」：请求必须真的发出去，不能被上一轮的一次性 ref 吞掉。
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(paneIntent(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: true });
    expect(takeovers).toEqual(['session-a', 'session-a']);
    expect(paneMode(renderer)).toBe('controlled');
    act(() => renderer.unmount());
  });

  it('同一行重复点接管照旧关闭面板，只读「终端」按钮把它降回只读', async () => {
    const { renderer, takeovers } = await renderPair();
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(paneMode(renderer)).toBe('controlled');

    // 同按钮二次点击 = 关闭，这是原有的开关语义，改「意图」不该动它。
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(paneIntent(renderer)).toBeNull();

    // 只读入口从来不该带写权限：重开为只读，接管次数停在原地。
    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(paneIntent(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });
    expect(takeovers).toEqual(['session-a']);
    expect(paneMode(renderer)).toBe('readonly');
    act(() => renderer.unmount());
  });
});

// ─── P1-4：操作入口按服务端最小能力集渲染（六类身份矩阵）─────────────────────
//
// workbenchAuthed 只决定观察级形态；三类操作入口各看服务端投影的对应布尔。
// 矩阵里的 capabilities **不手写**：直接调服务端投影函数
// projectWorkbenchOperationCapabilities，把前端渲染钉在服务端同一份投影上——
// 服务端投影一变，这里的按钮存在性断言立刻跟着红。
describe('P1-4 操作入口按最小能力集渲染', () => {
  const NOW = 1_900_000_001_000;
  const terminalLocation = { protocol: 'http:', origin: 'http://dashboard.test', hostname: 'dashboard.test' };

  /** 话题会话 + 终端可框 + 注册了预览：三类操作入口都具备渲染前提，缺席只可能
   *  是能力位关掉的结果。 */
  function fullSurfaceSession(): WorkbenchSessionRow {
    return {
      ...kindSession({ chatType: 'group', scope: 'thread' }),
      webPort: 7681,
      proxyPort: 7682,
      preview: { path: '/preview/session-0/', registeredAt: new Date(NOW).toISOString() },
    };
  }

  const MATRIX: ReadonlyArray<{
    name: string;
    actor: WorkbenchCapabilityActor | null;
    /** app.tsx：legacy/H5/platform → workbenchAuthed=true；匿名 → false。 */
    authenticated: boolean;
  }> = [
    { name: 'legacy owner', authenticated: true, actor: { kind: 'legacy-dashboard', terminalCapability: 'controlled', previewCapability: 'operate' } },
    { name: 'feishu H5', authenticated: true, actor: { kind: 'feishu-h5', terminalCapability: 'controlled', previewCapability: 'operate' } },
    { name: 'platform owner', authenticated: true, actor: { kind: 'platform-dashboard', terminalCapability: 'owner', previewCapability: 'operate' } },
    { name: 'platform teammate', authenticated: true, actor: { kind: 'platform-dashboard', terminalCapability: 'readonly', previewCapability: 'readonly' } },
    { name: 'platform guest', authenticated: true, actor: { kind: 'platform-dashboard', terminalCapability: 'readonly', previewCapability: 'readonly' } },
    { name: 'anonymous', authenticated: false, actor: null },
  ];

  function buttonTexts(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root.findAllByType('button').map(node => textOf(node));
  }

  it('六类身份矩阵：定位/接管入口的存在性 = 服务端投影值', async () => {
    for (const { name, actor, authenticated } of MATRIX) {
      const capabilities = projectWorkbenchOperationCapabilities(actor);
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
          sessions: [fullSurfaceSession()],
          online: true,
          authenticated,
          capabilities,
          initialSessionId: 'session-0',
          viewportWidth: 1440,
          now: NOW,
          api,
          storage: null,
          location: terminalLocation,
          sdk: null,
          h5Context: null,
          onRouteChange: () => {},
        }));
      });
      // 定位按钮：只随 canLocate 出现（H5/platform 的 capability 表没有 /locate）。
      expect(locateButtons(renderer).length, `${name} locate`).toBe(capabilities.canLocate ? 1 : 0);
      // 行内「接管」捷径：只随 canControl 出现；只读「终端」入口对所有身份保留。
      const rowActions = renderer.root.findAll(node =>
        node.type === 'button' && String(node.props.className ?? '').includes('wb-session-row-action is-terminal'));
      expect(
        rowActions.some(node => node.props.className === 'wb-session-row-action is-terminal-control'),
        `${name} row takeover shortcut`,
      ).toBe(capabilities.canControl);
      expect(
        rowActions.some(node => node.props.className === 'wb-session-row-action is-terminal'),
        `${name} readonly terminal entry`,
      ).toBe(true);

      // 打开终端面板：面板级「接管输入」按钮同样只随 canControl 出现。
      const openTerminal = rowActions.find(node => node.props.className === 'wb-session-row-action is-terminal')!;
      await act(async () => { openTerminal.props.onClick({ stopPropagation() {} }); });
      await act(async () => {});
      const labels = buttonTexts(renderer);
      expect(labels.includes('接管输入') || labels.includes('释放输入'), `${name} pane takeover`)
        .toBe(capabilities.canControl && authenticated);
      act(() => renderer.unmount());
    }
  });

  it('六类身份矩阵：Preview「开启交互」只随 canInteract 出现', async () => {
    for (const { name, actor, authenticated } of MATRIX) {
      const capabilities = projectWorkbenchOperationCapabilities(actor);
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(WebPane, {
          session: fullSurfaceSession(),
          api,
          authenticated,
          capabilities,
          now: NOW,
        }));
      });
      const labels = buttonTexts(renderer);
      expect(labels.includes('开启交互') || labels.includes('立即锁定'), `${name} preview unlock`)
        .toBe(capabilities.canInteract && authenticated);
      // 预览 iframe 本体对可进工作台的身份照常渲染——隐藏的只是写入口。
      expect(renderer.root.findAllByType('iframe').length, `${name} preview frame`).toBe(1);
      act(() => renderer.unmount());
    }
  });

  it('canControl=false 时行内「接管」意图被压回只读：不发出注定 403 的 takeover', async () => {
    // teammate/guest 形态。行内捷径已隐藏，这里直接对 TerminalPane 传
    // autoTakeControl（等价于任何遗留入口递进来的接管意图），断言 POST 不发出。
    const takeovers: string[] = [];
    const paneApi: WorkbenchApi = {
      ...api,
      takeoverTerminal: async (sessionId: string) => {
        takeovers.push(sessionId);
        return { mode: 'controlled', owned: true, expiresAt: Date.now() + 60_000 };
      },
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: { ...kindSession({}), webPort: 7681, proxyPort: 7682 },
        api: paneApi,
        authenticated: true,
        capabilities: { canLocate: false, canControl: false, canInteract: false },
        autoTakeControl: true,
        now: NOW,
        location: terminalLocation,
      }));
    });
    await act(async () => {});
    expect(takeovers).toEqual([]);
    expect(buttonTexts(renderer)).not.toContain('接管输入');
    // 反馈语也不再劝人点一个不存在的按钮。
    expect(textOf(renderer.root)).toContain('当前身份不可接管输入');
    expect(textOf(renderer.root)).not.toContain('点「接管输入」可操作');
    act(() => renderer.unmount());
  });

  it('canInteract=false 时 Preview 面板没有解锁入口，锁定态照常展示', async () => {
    const unlocks: string[] = [];
    const paneApi: WorkbenchApi = {
      ...api,
      unlockPreview: async (sessionId: string) => {
        unlocks.push(sessionId);
        return { mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a security boundary', idleExpiresAt: Date.now() + 60_000 };
      },
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WebPane, {
        session: fullSurfaceSession(),
        api: paneApi,
        authenticated: true,
        capabilities: { canLocate: false, canControl: true, canInteract: false },
        now: NOW,
      }));
    });
    expect(buttonTexts(renderer)).not.toContain('开启交互');
    expect(unlocks).toEqual([]);
    expect(textOf(renderer.root)).toContain('预览模式已锁定');
    act(() => renderer.unmount());
  });
});

// ─── P1-4：能力 DTO 严格解析（缺字段回落全 false，绝不回落 true）──────────────
describe('parseWorkbenchCapabilities 严格校验', () => {
  it('合法响应逐字段透传', () => {
    expect(parseWorkbenchCapabilities({
      ok: true,
      capabilities: { canLocate: true, canControl: true, canInteract: true },
    })).toEqual({ canLocate: true, canControl: true, canInteract: true });
    expect(parseWorkbenchCapabilities({
      ok: true,
      capabilities: { canLocate: false, canControl: true, canInteract: false },
    })).toEqual({ canLocate: false, canControl: true, canInteract: false });
  });

  it('缺字段回落 false，不回落 true', () => {
    expect(parseWorkbenchCapabilities({ ok: true, capabilities: { canControl: true } }))
      .toEqual({ canLocate: false, canControl: true, canInteract: false });
    expect(parseWorkbenchCapabilities({ ok: true, capabilities: {} }))
      .toEqual({ canLocate: false, canControl: false, canInteract: false });
  });

  it('只认字面量 true：1 / "true" / null 一律 false', () => {
    expect(parseWorkbenchCapabilities({
      ok: true,
      capabilities: { canLocate: 1, canControl: 'true', canInteract: null },
    })).toEqual({ canLocate: false, canControl: false, canInteract: false });
  });

  it('外层不合形（ok!=true、非对象、数组、null）整体回落全 false', () => {
    for (const value of [
      { ok: false, capabilities: { canLocate: true, canControl: true, canInteract: true } },
      { capabilities: { canLocate: true, canControl: true, canInteract: true } },
      { ok: true, capabilities: [true, true, true] },
      { ok: true },
      [], null, undefined, 'x', 42,
    ]) {
      expect(parseWorkbenchCapabilities(value), JSON.stringify(value) ?? 'undefined')
        .toEqual({ canLocate: false, canControl: false, canInteract: false });
    }
  });

  it('fail-closed 默认值三项全 false 且被冻结', () => {
    expect(NO_WORKBENCH_CAPABILITIES).toEqual({ canLocate: false, canControl: false, canInteract: false });
    expect(Object.isFrozen(NO_WORKBENCH_CAPABILITIES)).toBe(true);
  });
});
