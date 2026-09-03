import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { AgentWorkbenchView } from '../src/dashboard/web/agent-workbench-view.js';
import { AgentWorkbenchDockView } from '../src/dashboard/web/agent-workbench-dock-view.js';
import type { WorkbenchApi } from '../src/dashboard/web/agent-workbench-api.js';
import type { WorkbenchSessionRow, WorkbenchTerminalLocation } from '../src/dashboard/web/agent-workbench-model.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TERMINAL_ORIGIN = 'https://dash.example';
/** 注入的 location 必须是完整的 `WorkbenchTerminalLocation`（protocol / origin /
 *  hostname 三件套），不能只给 origin：真实 `window.Location` 就是这个形状，缺字段的
 *  夹具会让「HTTPS 集中域一律走同源 /s/ 反代」这类分支在脚本里根本走不到。字段从
 *  origin 解出来，改一处即可。 */
const TERMINAL_LOCATION: WorkbenchTerminalLocation = (() => {
  const url = new URL(TERMINAL_ORIGIN);
  return { protocol: url.protocol, origin: url.origin, hostname: url.hostname };
})();
let takeovers = 0;
const api: WorkbenchApi = {
  getTerminalControl: async () => ({ mode: 'readonly', owned: false }),
  takeoverTerminal: async () => {
    takeovers += 1;
    return { mode: 'controlled', owned: true, expiresAt: Date.now() + 60_000 };
  },
  releaseTerminal: async () => ({ mode: 'readonly', owned: false }),
  getPreviewInteraction: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'not a security boundary' }),
  unlockPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a security boundary', idleExpiresAt: Date.now() + 60_000 }),
  touchPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a security boundary', idleExpiresAt: Date.now() + 60_000 }),
  lockPreview: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'not a security boundary' }),
  getH5Context: async () => null,
  getTerminalViewLink: async () => null,
  locateSession: async () => {},
  getStandingLink: async () => null,
};
const sessions: WorkbenchSessionRow[] = Array.from({ length: 320 }, (_, index) => ({
  sessionId: `session-${index}`,
  status: index !== 0 && index % 17 === 0 ? 'closed' : 'working',
  title: `Full title for session ${index}`,
  botName: 'Builder',
  cliId: 'codex',
  chatId: `oc_${index}`,
  scope: 'thread',
  // 终端面板要的是「同源前置代理可达」：webPort + proxyPort + location 三者齐了
  // 才会渲染出真 iframe 与接管按钮（见 workbenchTerminalHref）。
  webPort: 4000 + index,
  proxyPort: 5000 + index,
  lastMessageAt: 1_800_000_000_000 + index,
  ...(index === 0 ? { agentAttention: { reason: 'Approve deployment', at: 1_900_000_000_000 } } : {}),
}));

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
}

function buttonWithText(root: ReactTestInstance, text: string): ReactTestInstance | undefined {
  return root.findAllByType('button').find(button => textOf(button) === text);
}

/**
 * 挂载一个组件。
 *
 * props 与组件契约就在 `React.createElement` 这一行被真正检查——工作台组件改了必填
 * 属性，这个脚本立刻编译不过，这正是把 scripts/ 纳入 tsc 要拦的那类夹具腐烂。
 *
 * 交给渲染器时的那次转换只为绕开一处依赖版本错配：`@types/react-test-renderer@19.1`
 * 自己钉的是 `@types/react@18`，它眼里的 `ReactElement` 和仓库在用的 React 19 不是
 * 同一个类型。转换只发生在「元素 → 渲染器入参」这一步，不放过任何 props 检查。
 */
function render<P extends object>(component: React.FunctionComponent<P>, props: P): TestRenderer.ReactTestRenderer {
  const element = React.createElement(component, props);
  return TestRenderer.create(element as unknown as Parameters<typeof TestRenderer.create>[0]);
}

let main!: TestRenderer.ReactTestRenderer;
await act(async () => {
  main = render(AgentWorkbenchView, {
    sessions,
    online: true,
    authenticated: true,
    // 本脚本验证的是 legacy owner 形态：三类操作能力齐全（P1-4 服务端投影值）。
    capabilities: { canLocate: true, canControl: true, canInteract: true },
    initialSessionId: 'session-0',
    viewportWidth: 1440,
    now: 1_900_000_001_000,
    api,
    storage: null,
    location: TERMINAL_LOCATION,
    sdk: null,
    h5Context: null,
    onRouteChange: () => {},
  });
});

// 虚拟滚动：320 个会话只渲染一屏多一点，绝不是全量铺开。
const options = main.root.findAll(node => node.props.role === 'option');
assert.ok(options.length > 1 && options.length < 30);
// 未读/attention 会话进「待你处理」并置顶，行的无障碍名里带上分组状态和理由。
assert.match(options[0].props['aria-label'], /Approve deployment/);
assert.match(options[0].props['aria-label'], /待你处理/);
// 行高 54 与 style.css 的 `.wb-session-row { height: 54px }` 必须一致，
// 不然虚拟滚动算出来的位置会和实际渲染错开。
assert.equal(options[0].props.style.height, 54);

// 组头是可折叠按钮：展开时 ▾，折叠后 ▸，且 aria-expanded 跟着翻。
const groupHeaders = main.root.findAll(node => node.props['aria-expanded'] !== undefined
  && String(node.props.className ?? '').includes('wb-session-group-toggle'));
assert.ok(groupHeaders.length >= 2);
assert.equal(groupHeaders[0].props['aria-expanded'], true);
assert.ok(textOf(groupHeaders[0]).startsWith('▾'));
await act(async () => { groupHeaders[0].props.onClick(); });
const collapsedHeader = main.root.findAll(node => node.props['aria-expanded'] !== undefined
  && String(node.props.className ?? '').includes('wb-session-group-toggle'))[0];
assert.equal(collapsedHeader.props['aria-expanded'], false);
assert.ok(textOf(collapsedHeader).startsWith('▸'));
await act(async () => { collapsedHeader.props.onClick(); });

// 分组维度下拉（状态/机器人/会话/类型/CLI/时间）。
assert.ok(main.root.findByProps({ className: 'wb-group-dim' }).props.children.length >= 2);

// 行操作是文字按钮：聊天（真锚点）/ 定位 / 终端。
// 「接管」已按产品决策从行内移除，统一走终端面板标题栏的「接管输入」——所以这里既要
// 查到剩下的三个，也要反向守住「行内不许再长出接管入口」。
const rowActions = main.root.findAll(node => typeof node.type === 'string'
  && String(node.props.className ?? '').includes('wb-session-row-action'));
const rowActionText = new Set(rowActions.map(node => textOf(node)));
for (const label of ['聊天', '定位', '终端']) assert.ok(rowActionText.has(label), `缺少行操作「${label}」`);
assert.equal(rowActionText.has('接管'), false, '行内不应再有「接管」');
// 聊天必须是真锚点：脚本化打开会被飞书客户端降级成窄容器，这条契约不能退化成 button。
assert.equal(rowActions.find(node => textOf(node) === '聊天')!.type, 'a');

// 终端面板默认不开：会话列表才是主界面，工作区先给占位提示。
assert.equal(main.root.findAll(node => node.props['aria-label'] === '终端面板').length, 0);
assert.ok(main.root.findByProps({ className: 'wb-pane-placeholder' }));

// 行内「终端」= 只读打开终端面板，一个写请求都不发。
const openTerminal = rowActions.find(node => textOf(node) === '终端')!;
await act(async () => { openTerminal.props.onClick({ stopPropagation() {} }); });
await act(async () => {});
assert.ok(main.root.findByProps({ 'aria-label': '终端面板' }));
assert.equal(takeovers, 0, '行内「终端」不该替用户发起接管');
// 接管的唯一入口：面板标题栏的「接管输入」。
await act(async () => { buttonWithText(main.root, '接管输入')!.props.onClick(); });
await act(async () => {});
assert.equal(takeovers, 1);
assert.ok(main.root.findAll(node => String(node.props.className ?? '').includes('wb-mode-chip is-controlled')).length === 1);
assert.ok(buttonWithText(main.root, '释放输入'));
// 面板打开后工作区标题才出现（无终端时 .wb-desktop-layout.is-terminal-closed 把它整块隐藏）。
assert.ok(main.root.findByProps({ className: 'wb-workspace-title' }));

// 「关闭终端 ✕」把工作区收回占位态。
await act(async () => { buttonWithText(main.root, '关闭终端 ✕')!.props.onClick(); });
assert.equal(main.root.findAll(node => node.props['aria-label'] === '终端面板').length, 0);

// 已被有意移除的形态：分屏、信息抽屉、页内聊天挂件、FOLLOW/L1 层级控件。
// 这些断言原本存在，功能删除后一并改为「必须不存在」的反向守卫。
for (const gone of ['wb-pane-split', 'wb-info-drawer', 'wb-pane-region', 'wb-chat-pane']) {
  assert.equal(main.root.findAll(node => node.props.className === gone).length, 0, `${gone} 应已移除`);
}
const allText = textOf(main.root);
for (const gone of ['FOLLOW', 'SESSION INFO', 'Info drawer']) {
  assert.equal(allText.includes(gone), false, `${gone} 应已移除`);
}
// 完整工作台挂在应用中心形态上（会话坞是另一套 data-surface="sidebar"）。
assert.equal(main.root.findByProps({ className: 'agent-workbench-page' }).props['data-surface'], 'appCenter');
act(() => main.unmount());

let dock!: TestRenderer.ReactTestRenderer;
await act(async () => {
  dock = render(AgentWorkbenchDockView, {
    sessions: sessions.slice(0, 3),
    online: true,
    authenticated: true,
    initialSessionId: 'session-0',
    api,
    sdk: null,
    h5Context: { enabled: true, appId: 'cli_x', brand: 'feishu', entryPath: '/auth/feishu' },
    targetOrigin: TERMINAL_ORIGIN,
    location: TERMINAL_LOCATION,
    onRouteChange: () => {},
  });
});
assert.equal(dock.root.findByProps({ className: 'agent-workbench-dock' }).props.style.minWidth, 350);
assert.match(dock.root.findByProps({ className: 'wb-primary-action' }).props.href, /mode=appCenter/);
assert.equal(dock.root.findAll(node => node.props.className === 'wb-pane').length, 0);
act(() => dock.unmount());

process.stdout.write(JSON.stringify({
  ok: true,
  componentChecks: 23,
  renderedSessionOptions: options.length,
  rowHeight: 54,
}) + '\n');
