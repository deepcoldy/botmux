import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkbenchView } from '../src/dashboard/web/agent-workbench-view.js';
import {
  TERMINAL_WRITE_TIMEOUT_MS,
  TerminalPane,
  type TerminalFrameWrite,
} from '../src/dashboard/web/agent-workbench-panes.js';
import {
  WorkbenchApiError,
  type TerminalControlState,
  type WorkbenchApi,
} from '../src/dashboard/web/agent-workbench-api.js';
import type { WorkbenchCapabilities } from '../src/dashboard/web/agent-workbench-capabilities.js';
import type { WorkbenchSessionRow } from '../src/dashboard/web/agent-workbench-model.js';

/**
 * 终端控制权状态机的真实组件用例。
 *
 * 这一组盯的都是**多个事件互相抢状态**的路径——它们在「一个请求一个请求地跑完」
 * 的理想序列下全都是绿的，正因为如此才需要专门的用例把时序钉住：
 *
 *   1. 跨会话点「终端」：A 的终端开着，点 B 行的「终端」必须打开 B 的只读终端，
 *      不能因为「先选中把面板迁过去」而被判成同按钮二次点击、把面板关掉。
 *   2. 在途写与关闭/双击：POST 还没回来时关掉面板 → 服务端随后发出的写租约必须被
 *      精确补偿掉；接管在途时连点只许发一次；15 秒观察轮询不许丢掉在途写的回执。
 *   3. release 失败：不许乐观宣称只读——保留最后一次权威读数、盖住可写 iframe、
 *      立刻 GET 复核。
 *   4. fixed / touch 的只读语义：恒可写身份行内文案如实（不写「只读」）；触屏文案
 *      跟着这块 iframe 真实的写权限走。
 *
 * 接管的唯一入口是终端面板标题栏的「接管输入」——会话行内的「接管」捷径已按产品
 * 决策移除，所以这一组里凡是需要写权限的步骤都走 {@link openAndTakeOver}。
 */

const FULL_CAPABILITIES: WorkbenchCapabilities = { canLocate: true, canControl: true, canInteract: true };
const NOW = 1_900_000_001_000;
const LOCATION = { protocol: 'http:', origin: 'http://dashboard.test', hostname: 'dashboard.test' };

const READONLY: TerminalControlState = { mode: 'readonly', owned: false };
const baseApi: WorkbenchApi = {
  getTerminalControl: async () => READONLY,
  takeoverTerminal: async () => ({ mode: 'controlled', owned: true, expiresAt: NOW + 60_000 }),
  releaseTerminal: async () => READONLY,
  getPreviewInteraction: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'not a boundary' }),
  unlockPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a boundary', idleExpiresAt: NOW + 60_000 }),
  touchPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a boundary', idleExpiresAt: NOW + 60_000 }),
  lockPreview: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'not a boundary' }),
  getH5Context: async () => null,
  getTerminalViewLink: async () => null,
  locateSession: async () => {},
  getStandingLink: async () => null,
};

/** 终端地址要 webPort + proxyPort + location 三者齐了才成立；缺一个面板只剩空态，
 *  控制权接口压根不会被调用，这一整组用例也就证明不了任何事。 */
function row(sessionId: string, title: string, lastMessageAt: number): WorkbenchSessionRow {
  return {
    sessionId,
    title,
    status: 'working',
    botName: 'Builder',
    cliId: 'codex',
    chatId: `oc_${sessionId}`,
    webPort: 7681,
    proxyPort: 7682,
    lastMessageAt,
  };
}

/** A 的活跃时间更新，稳定排在 B 前面（组内按活跃降序）。 */
const PAIR = (): WorkbenchSessionRow[] => [
  row('session-a', 'Session A', 1_800_000_002_000),
  row('session-b', 'Session B', 1_800_000_001_000),
];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  // 未被消费的 rejection 会在 vitest 里冒成 unhandled；这里挂一个空的兜底，
  // 真正的断言走组件那条链路。
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
}

async function renderView(
  api: WorkbenchApi,
  sessions: WorkbenchSessionRow[] = PAIR(),
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
      sessions,
      online: true,
      authenticated: true,
      capabilities: FULL_CAPABILITIES,
      initialSessionId: sessions[0].sessionId,
      viewportWidth: 1440,
      now: NOW,
      api,
      storage: null,
      location: LOCATION,
      sdk: null,
      h5Context: null,
      onRouteChange: () => {},
    }));
  });
  return renderer;
}

/** 一次点击要走完「重挂面板 → 拉控制权 → 决定要不要写」好几个 await，多空跑几轮
 *  act 让这条链彻底落定，断言才不是在半路上取样。 */
async function settle(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) await act(async () => {});
}

/** 行内终端入口。产品决策：会话行只留「聊天 / 终端」，接管一律走终端面板标题栏的
 *  「接管输入」，所以这里不再有 `terminal-control` 这个 surface。 */
function rowAction(
  renderer: TestRenderer.ReactTestRenderer,
  title: string,
): ReactTestInstance | null {
  return renderer.root.findAll(node => node.type === 'button'
    && node.props.className === 'wb-session-row-action is-terminal'
    && String(node.props['aria-label'] ?? '').endsWith(`— ${title}`))[0] ?? null;
}

async function clickRowAction(
  renderer: TestRenderer.ReactTestRenderer,
  title: string,
): Promise<void> {
  const button = rowAction(renderer, title);
  if (!button) throw new Error(`row action terminal for ${title} not rendered`);
  await act(async () => { button.props.onClick({ stopPropagation() {} }); });
  await settle();
}

/** 这一行此刻渲染出来的操作按钮文案（含「聊天」这个锚点）。 */
function rowActionLabels(renderer: TestRenderer.ReactTestRenderer, title: string): string[] {
  const actions = renderer.root.findAll(node => node.props.className === 'wb-session-row-actions'
    && node.parent?.props['aria-label']?.startsWith?.(`${title}.`));
  if (actions.length === 0) return [];
  return actions[0].children
    .filter((child): child is ReactTestInstance => typeof child !== 'string')
    .map(child => textOf(child));
}

/** 终端面板标题栏的「接管输入 / 释放输入」——接管的**唯一**入口。 */
function paneControl(
  renderer: TestRenderer.ReactTestRenderer,
  label: '接管输入' | '释放输入',
): ReactTestInstance | null {
  return renderer.root.findAll(node => node.type === 'button' && textOf(node) === label)[0] ?? null;
}

async function clickPaneControl(
  renderer: TestRenderer.ReactTestRenderer,
  label: '接管输入' | '释放输入',
): Promise<void> {
  const button = paneControl(renderer, label);
  if (!button) throw new Error(`pane control ${label} not rendered`);
  await act(async () => { button.props.onClick(); });
  await settle();
}

/** 「打开终端并接管」现在是两步：行内「终端」只读打开，再在面板标题栏点接管。
 *  （以前行内「接管」一键做完这两步，那个捷径已按产品决策移除。） */
async function openAndTakeOver(
  renderer: TestRenderer.ReactTestRenderer,
  title: string,
): Promise<void> {
  await clickRowAction(renderer, title);
  await clickPaneControl(renderer, '接管输入');
}

/** 直接挂一块终端面板（不经过工作台外壳）：要拨 15 秒轮询的表时，外壳里的其它
 *  定时器只会添乱。挂完先把首屏 GET 走完，返回时面板已经有权威读数。 */
async function renderPane(api: WorkbenchApi): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(TerminalPane, {
      session: PAIR()[0],
      api,
      authenticated: true,
      capabilities: FULL_CAPABILITIES,
      now: NOW,
      location: LOCATION,
    }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return renderer;
}

async function clickRow(renderer: TestRenderer.ReactTestRenderer, title: string): Promise<void> {
  const node = renderer.root.find(node => node.props.role === 'option'
    && String(node.props['aria-label'] ?? '').startsWith(`${title}.`));
  await act(async () => { node.props.onClick(); });
  await settle();
}

/** 面板在不在、挂在哪个会话上，以及它是带着什么开场意图挂上来的。
 *  行内接管移除之后 `autoTakeControl` 恒为 false（只读打开）——留着这个字段正是
 *  为了钉住这条不变量：外层永远不会替用户发起接管。 */
function pane(renderer: TestRenderer.ReactTestRenderer): { sessionId: string; autoTakeControl: unknown } | null {
  const panes = renderer.root.findAllByType(TerminalPane);
  if (panes.length === 0) return null;
  return {
    sessionId: String(panes[0].props.session.sessionId),
    autoTakeControl: panes[0].props.autoTakeControl,
  };
}

/** 徽标读的就是面板自己算出来的模式，比 prop 更贴近用户看到的东西。 */
function paneMode(
  renderer: TestRenderer.ReactTestRenderer,
): 'controlled' | 'readonly' | 'unknown' | 'closed' {
  const chips = renderer.root.findAll(node =>
    typeof node.props.className === 'string' && node.props.className.startsWith('wb-mode-chip'));
  if (chips.length === 0) return 'closed';
  const className = String(chips[0].props.className);
  if (className.includes('is-controlled')) return 'controlled';
  if (className.includes('is-unknown')) return 'unknown';
  return 'readonly';
}

function feedback(renderer: TestRenderer.ReactTestRenderer): string {
  const nodes = renderer.root.findAll(node => node.props.className === 'wb-pane-feedback');
  return nodes.length === 0 ? '' : textOf(nodes[0]);
}

function maskShown(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findAll(node =>
    String(node.props.className ?? '').includes('wb-control-unknown')).length > 0;
}

/** 有状态的租约替身：接管/释放真的改变后续 getTerminalControl 的读数，并把服务端
 *  此刻到底有没有把写租约发出去暴露给断言（`serverControlled`）。 */
function leaseApi(options: {
  fixed?: boolean;
  /** 拦截一次写：拿到 deferred 后由用例决定什么时候 resolve/reject。 */
  hold?: 'takeover' | 'release';
  /** 别的浏览器正握着租约：GET 报 controlled 但不是 owned，takeover 必 409。 */
  busyElsewhere?: boolean;
} = {}): {
  api: WorkbenchApi;
  calls: string[];
  held: { promise: Promise<TerminalControlState>; resolve(v: TerminalControlState): void; reject(e: unknown): void };
  /** 读控制权时先等这道闸（默认放行）——用来把「复核 GET」按住，好断言 unknown 中间态。 */
  gate: { open(): void; hold(): void };
  serverControlled(): boolean;
} {
  const calls: string[] = [];
  let controlled = options.fixed === true;
  const held = deferred<TerminalControlState>();
  let gatePromise: { promise: Promise<void>; resolve(value: void): void } | null = null;
  const snapshot = (): TerminalControlState => (options.fixed
    ? { mode: 'controlled', owned: true, fixed: true }
    : options.busyElsewhere && !controlled
      ? { mode: 'controlled', owned: false, expiresAt: NOW + 60_000 }
      : controlled
        ? { mode: 'controlled', owned: true, expiresAt: NOW + 60_000 }
        : READONLY);
  return {
    calls,
    held,
    gate: {
      hold() { gatePromise = deferred<void>(); },
      open() { gatePromise?.resolve(); gatePromise = null; },
    },
    serverControlled: () => controlled,
    api: {
      ...baseApi,
      getTerminalControl: async () => {
        calls.push('get');
        // 读数在**服务端受理这一刻**就定形了，下面那道闸只是把回执按住不发。
        // 这样才造得出「写之前受理、写结算之后才回来」的旧 poll——把 snapshot() 挪到
        // 闸后面，旧 poll 会凭空读到写之后的世界，那条竞态就永远复现不了。
        const answer = snapshot();
        if (gatePromise) await gatePromise.promise;
        return answer;
      },
      takeoverTerminal: async (sessionId: string) => {
        calls.push(`takeover:${sessionId}`);
        if (options.busyElsewhere && !controlled) throw new WorkbenchApiError(409, 'control_busy');
        if (options.hold === 'takeover') {
          const next = await held.promise;
          if (!options.fixed) controlled = true;
          return next;
        }
        if (!options.fixed) controlled = true;
        return snapshot();
      },
      releaseTerminal: async (sessionId: string) => {
        calls.push(`release:${sessionId}`);
        if (options.hold === 'release') {
          // 失败也要如实反映服务端：租约没被还回去，`serverControlled()` 仍是 true。
          const next = await held.promise;
          if (!options.fixed) controlled = false;
          return next;
        }
        if (!options.fixed) controlled = false;
        return snapshot();
      },
    },
  };
}

afterEach(() => { vi.useRealTimers(); });

// ─── ⓪ 行内操作集：只剩 聊天 / 终端 ─────────────────────────────────────────
describe('会话行只保留「聊天 / 终端」两个操作', () => {
  it('行内不再渲染「接管」按钮——接管统一走终端面板标题栏的「接管输入」', async () => {
    // 产品决策（2026-08）：行内接管与标题栏接管做的是同一件事，却多一条状态更难
    // 对齐的链路，因此收敛到面板标题栏这一个入口。这条用例就是那个决策的门禁。
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    expect(rowActionLabels(renderer, 'Session A')).toEqual(['聊天', '终端']);
    expect(rowActionLabels(renderer, 'Session B')).toEqual(['聊天', '终端']);
    expect(renderer.root.findAll(node => typeof node.props.className === 'string'
      && node.props.className.includes('is-terminal-control'))).toEqual([]);

    // 行内唯一的终端入口就是只读打开；接管按钮在面板标题栏里等着。
    await clickRowAction(renderer, 'Session A');
    expect(paneMode(renderer)).toBe('readonly');
    expect(paneControl(renderer, '接管输入')).not.toBeNull();
    expect(lease.calls.filter(call => call !== 'get')).toEqual([]);
    act(() => renderer.unmount());
  });
});

// ─── ① 跨会话点「终端」（P1-1）───────────────────────────────────────────────
describe('跨会话点行内「终端」打开的是那一行的只读终端，不是把面板关掉', () => {
  it('A 的终端接管着，点 B 行「终端」→ B 的只读终端打开（回归时这里是 closed）', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    // 外层递进去的永远是只读意图（行内接管已移除）；可写是标题栏那一下的结果。
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });
    expect(paneMode(renderer)).toBe('controlled');

    await clickRowAction(renderer, 'Session B');
    // 回归的形状：先 selectSession 把面板迁到 B 并压成只读，紧接着的开关判断看到
    // 「B 且只读」= 这次点击的意图，于是被当成同按钮二次点击 → 面板被关掉。
    expect(pane(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: false });
    expect(paneMode(renderer)).toBe('readonly');
    // 写权限没有跟着漂过去：B 从头到尾没有被接管。
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual(['takeover:session-a']);
    act(() => renderer.unmount());
  });

  it('A 只读开着，点 B 行「终端」同样是打开 B，不是关面板', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });

    await clickRowAction(renderer, 'Session B');
    expect(pane(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: false });
    act(() => renderer.unmount());
  });

  it('同一行的「终端」照旧是开关：第二次点击才关闭', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).not.toBeNull();
    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).toBeNull();
    act(() => renderer.unmount());
  });

  it('普通选中仍然只跟随、不接管（跨会话原子化没有把跟随一起改掉）', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    await clickRow(renderer, 'Session B');
    expect(pane(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: false });
    expect(paneMode(renderer)).toBe('readonly');
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual(['takeover:session-a']);
    act(() => renderer.unmount());
  });
});

// ─── ①' 只读面板已经挂着 → 标题栏点「接管输入」（用户实测报的那条）───────────────
describe('先开只读终端、再点标题栏「接管输入」，写权限必须真的到手', () => {
  /**
   * 用户实测报的形状：「先点『终端』开只读，再接管就打不了字」。这一路要走完
   * readonly → taking-over → controlled 的显式转换，只读那一拍留下的一次性
   * 「还回租约」意图也必须已经兑现完、不能反手把用户刚按下的接管撤销掉。上面那组
   * 用例全是「面板还没挂 / 换会话 / 反方向降级」，没有一条压住这条正向转换，所以
   * 单独钉在这里。
   *
   * 产品决策后接管只剩标题栏这一个入口（会话行内的「接管」按钮已移除），所以这一组
   * 的第二步统一改成点面板标题栏的「接管输入」——覆盖的转换和以前完全一样。
   */
  it('只读面板挂着 → 标题栏「接管输入」→ takeover 真的发出去且租约到手', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    // ① 只读打开：面板挂上，服务端此刻没有发出任何写租约。
    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });
    expect(paneMode(renderer)).toBe('readonly');
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual([]);
    expect(lease.serverControlled()).toBe(false);

    // ② 在这块已经挂着的只读面板上点标题栏「接管输入」。回归的形状是只读那一拍的
    //    一次性「还回租约」意图反手把它撤销掉 → 用户看着一个「已接管」的终端却打
    //    不进字。
    await clickPaneControl(renderer, '接管输入');
    // 面板还是同一块（不重挂），开场意图照旧是只读——可写是标题栏那一下的结果。
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });
    expect(paneMode(renderer)).toBe('controlled');
    expect(feedback(renderer)).toContain('已接管');
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual(['takeover:session-a']);
    // 服务端侧的判据：租约真的发出来了，不只是徽标好看。
    expect(lease.serverControlled()).toBe(true);
    // 刚拿到的租约不许被只读那一拍的残留意图反手还回去。
    expect(lease.calls.filter(call => call.startsWith('release'))).toEqual([]);
    act(() => renderer.unmount());
  });

  it('标题栏接管之后再点行内「终端」→ 降回只读并真的把租约还回去（来回都完整）', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    expect(lease.serverControlled()).toBe(true);

    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });
    expect(paneMode(renderer)).toBe('readonly');
    // 「打开只读终端」名副其实：不真的 release，只读就只是外层记了一笔，面板照样可写。
    expect(lease.calls).toContain('release:session-a');
    expect(lease.serverControlled()).toBe(false);
    act(() => renderer.unmount());
  });

  it('只读 → 接管的在途那一拍说「正在接管」，不冒充只读也不冒充可输入', async () => {
    const lease = leaseApi({ hold: 'takeover' });
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A');
    expect(paneMode(renderer)).toBe('readonly');

    await clickPaneControl(renderer, '接管输入');
    expect(lease.calls).toContain('takeover:session-a');
    expect(feedback(renderer)).toContain('正在接管输入');

    await act(async () => {
      lease.held.resolve({ mode: 'controlled', owned: true, expiresAt: NOW + 60_000 });
    });
    await settle();
    expect(paneMode(renderer)).toBe('controlled');
    act(() => renderer.unmount());
  });
});

// ─── ② 在途写：双击、关闭补偿、轮询不许丢结果（P1-2）─────────────────────────
describe('在途 takeover 与关闭 / 双击 / 轮询互不抢状态', () => {
  it('接管在途时快速双击只发一次 takeover，行内「终端」也不会在 POST 回来前把面板关掉', async () => {
    const lease = leaseApi({ hold: 'takeover' });
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    // POST 还在飞：标题栏的接管按钮禁用（浏览器据此吞掉连点），行内「终端」也跟着
    // 禁用（回执把 busy 传回外层），而且**行为上**也必须吞掉这一下——不然面板被关
    // 掉，第一条租约没人管。
    expect(paneControl(renderer, '接管输入')?.props.disabled).toBe(true);
    expect(rowAction(renderer, 'Session A')?.props.disabled).toBe(true);
    await clickRowAction(renderer, 'Session A');
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual(['takeover:session-a']);
    expect(pane(renderer)).not.toBeNull();

    await act(async () => {
      lease.held.resolve({ mode: 'controlled', owned: true, expiresAt: NOW + 60_000 });
    });
    await settle();
    expect(paneMode(renderer)).toBe('controlled');
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual(['takeover:session-a']);
    act(() => renderer.unmount());
  });

  it('takeover 未回执就关掉面板：随后成功的租约被精确补偿释放，不留无面板的写租约', async () => {
    const lease = leaseApi({ hold: 'takeover' });
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    expect(lease.calls).toContain('takeover:session-a');

    // 工作区头部的「关闭终端」：这一步在 POST 回执之前发生。
    const close = renderer.root.find(node => node.type === 'button'
      && String(node.props.className ?? '').includes('wb-terminal-toggle'));
    await act(async () => { close.props.onClick(); });
    await settle();
    expect(pane(renderer)).toBeNull();

    // 服务端这时才把写租约发出来——没有任何面板在管它了。
    await act(async () => {
      lease.held.resolve({ mode: 'controlled', owned: true, expiresAt: NOW + 60_000 });
    });
    await settle();
    expect(lease.calls).toContain('release:session-a');
    expect(lease.serverControlled()).toBe(false);
    act(() => renderer.unmount());
  });

  it('切到别的会话同样补偿：A 的在途接管成功后立刻还回去', async () => {
    const lease = leaseApi({ hold: 'takeover' });
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    await clickRow(renderer, 'Session B');
    expect(pane(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: false });

    await act(async () => {
      lease.held.resolve({ mode: 'controlled', owned: true, expiresAt: NOW + 60_000 });
    });
    await settle();
    expect(lease.calls).toContain('release:session-a');
    expect(lease.serverControlled()).toBe(false);
    act(() => renderer.unmount());
  });

  it('15 秒观察轮询不许丢掉在途写的回执（写 epoch 与观察 epoch 分开）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = leaseApi({ hold: 'takeover' });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: PAIR()[0],
        api: lease.api,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        now: NOW,
        location: LOCATION,
      }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // 先走到离下一发轮询只差 200ms 的位置，再发起接管：这样轮询落在写的**在途窗口
    // 内**，而写本身远没到硬超时（TERMINAL_WRITE_TIMEOUT_MS）。这条用例考的是
    // 「观察 epoch 作废不了写 epoch」，不是「写可以永远挂着」——后者由超时那组用例
    // 单独钉住。
    await act(async () => { await vi.advanceTimersByTimeAsync(14_900); });
    // 接管只由标题栏发起（行内接管捷径已按产品决策移除）。POST 被 hold 住，
    // 面板停在「正在接管」，正好用来观察轮询会不会把它挤掉。
    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lease.calls).toContain('takeover:session-a');

    // 轮询在写还没回执时发了一发，读到的当然还是「写之前的世界」；面板照旧显示
    // 「正在接管」，没有被这一发轮询挤掉。
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(lease.calls.filter(call => call === 'get').length).toBeGreaterThan(1);
    expect(feedback(renderer)).toContain('正在接管输入');

    // 写的回执现在才到：它才是权威，绝不能因为「轮询更晚发起」而被丢掉。
    await act(async () => {
      lease.held.resolve({ mode: 'controlled', owned: true, expiresAt: NOW + 600_000 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('controlled');
    act(() => renderer.unmount());
  });

  it('首屏 GET 还没回来时，第二次点「终端」是关闭而不是重挂', async () => {
    const lease = leaseApi();
    lease.gate.hold();
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).not.toBeNull();
    // 还没有任何权威读数：此时的模式是 loading，不是「只读」。
    expect(feedback(renderer)).toContain('正在检查终端权限');

    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).toBeNull();
    lease.gate.open();
    await settle();
    act(() => renderer.unmount());
  });
});

// ─── ②' 写结算之后才回来的旧 poll：读数按**发出时刻**的写世代裁决 ─────────────
describe('写结算之后才回来的旧 poll 不许倒写控制权', () => {
  it('takeover 发起**之前**发出的 poll 在接管结算之后才回来 → 仍是「可输入」，不倒写只读', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = leaseApi();
    const renderer = await renderPane(lease.api);
    expect(paneMode(renderer)).toBe('readonly');

    // 旧 poll：服务端在**接管之前**就受理了它，读数是「写之前的世界」= 只读。
    // 回执被闸门按住，等接管结算之后再放回来。
    lease.gate.hold();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });

    // 接管在这发 poll 之后发起，并且先结算：租约确实到手了。
    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('controlled');
    expect(lease.serverControlled()).toBe(true);

    // 旧 poll 现在才回来。回归的形状：此刻已经没有在途写了，reducer 光看「有没有
    // pending」就把这份陈年读数当成权威，界面倒写成只读——服务端的写租约还在手上，
    // 用户对着一个写着「只读」的终端照样能打字。
    await act(async () => {
      lease.gate.open();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('controlled');
    expect(lease.serverControlled()).toBe(true);
    act(() => renderer.unmount());
  });

  it('release 结算之后才回来的旧 poll 不许把只读倒写回「可输入」（对称方向）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = leaseApi();
    const renderer = await renderPane(lease.api);

    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('controlled');

    // 旧 poll 在释放之前被受理，读到的是「还握着租约」。
    lease.gate.hold();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });

    await act(async () => {
      paneControl(renderer, '释放输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('readonly');
    expect(lease.serverControlled()).toBe(false);

    // 倒写回「可输入」= 给一块租约已经还掉的终端亮起输入口，比倒写成只读更糟。
    await act(async () => {
      lease.gate.open();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('readonly');
    expect(lease.serverControlled()).toBe(false);
    act(() => renderer.unmount());
  });

  it('写失败后的复核 GET 不被这条判据误伤：unknown 照旧收敛回权威读数', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = leaseApi({ hold: 'release' });
    const renderer = await renderPane(lease.api);

    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('controlled');

    // 一发旧 poll 先按住，随后释放失败 → unknown + 立刻复核，复核 GET 被同一道闸按住。
    lease.gate.hold();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
    await act(async () => {
      paneControl(renderer, '释放输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      lease.held.reject(new WorkbenchApiError(500, 'terminal_unavailable'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('unknown');
    expect(maskShown(renderer)).toBe(true);

    // 一起放行。复核读**不是**旧 poll：它发出时写世代已经推进过了，判据必须放它过去，
    // 否则 unknown 再也收敛不了、遮罩永远挂着。释放确实没成，所以收敛回「可输入」。
    await act(async () => {
      lease.gate.open();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('controlled');
    expect(maskShown(renderer)).toBe(false);
    expect(lease.serverControlled()).toBe(true);
    act(() => renderer.unmount());
  });
});

// ─── ③ release 失败：保留权威状态 + 遮罩 + 立刻复核（P1-3）───────────────────
describe('release 失败不许乐观宣称只读', () => {
  it('释放失败 → 徽标进「未知」并盖住可写 iframe，复核后回到真实的「可输入」', async () => {
    const lease = leaseApi({ hold: 'release' });
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    expect(paneMode(renderer)).toBe('controlled');
    expect(lease.serverControlled()).toBe(true);

    // 行内「终端」= 把已接管的面板降回只读，面板会真的发一次 release；这一次让它失败。
    await clickRowAction(renderer, 'Session A');
    expect(lease.calls).toContain('release:session-a');
    // 把随后的复核 GET 按住，好观察 unknown 这个中间态。
    lease.gate.hold();

    await act(async () => { lease.held.reject(new WorkbenchApiError(500, 'terminal_unavailable')); });
    await settle();
    // 回归的形状：这里曾经是 readonly —— 界面说只读，服务端的写租约还在。
    expect(paneMode(renderer)).toBe('unknown');
    expect(maskShown(renderer)).toBe(true);
    expect(feedback(renderer)).toContain('控制权状态未知');
    expect(lease.serverControlled()).toBe(true);

    // 复核 GET 放行：权威读数回来，状态收敛（依旧握着租约，因为释放确实没成）。
    lease.gate.open();
    await settle(4);
    expect(paneMode(renderer)).toBe('controlled');
    expect(maskShown(renderer)).toBe(false);
    // 失败原因不被复核冲掉：用户要知道刚才那次释放没成。
    expect(feedback(renderer)).toContain('终端不可用');
    act(() => renderer.unmount());
  });

  it('接管失败同样进未知并复核，不会留下一个「只读」的假结论', async () => {
    const lease = leaseApi({ hold: 'takeover' });
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    expect(lease.calls).toContain('takeover:session-a');
    lease.gate.hold();
    await act(async () => { lease.held.reject(new WorkbenchApiError(500, 'terminal_unavailable')); });
    await settle();
    expect(paneMode(renderer)).toBe('unknown');
    expect(maskShown(renderer)).toBe(true);

    lease.gate.open();
    await settle(4);
    // 复核说没有租约 → 这时才可以说只读，而且是有依据的。
    expect(paneMode(renderer)).toBe('readonly');
    expect(maskShown(renderer)).toBe(false);
    act(() => renderer.unmount());
  });
});

// ─── ④ fixed / touch 的只读语义（P1-4）──────────────────────────────────────
describe('恒可写身份与触屏的只读语义与实际能力一致', () => {
  it('平台 owner：行内只有一个「终端」开关，文案不再写「只读」，也不发任何控制 POST', async () => {
    const lease = leaseApi({ fixed: true });
    const renderer = await renderView(lease.api);

    // 行内本来就只剩「终端」一个终端入口（产品决策：接管统一走面板标题栏），这条
    // 用例原来还在断言「恒可写身份下那个多余的行内接管按钮要收敛掉」——按钮已经
    // 整体移除，这一半自然消失，剩下的文案与「不发控制 POST」照旧钉住。
    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).not.toBeNull();
    expect(paneMode(renderer)).toBe('controlled');

    // 恒可写身份连标题栏的接管/释放都不渲染：它没有租约可接管，也没有可释放的。
    expect(paneControl(renderer, '接管输入')).toBeNull();
    expect(paneControl(renderer, '释放输入')).toBeNull();

    const toggle = rowAction(renderer, 'Session A')!;
    expect(toggle.props.title).toBe('打开终端（当前身份可直接输入）');
    expect(toggle.props.title).not.toContain('只读');

    // 一个按钮 = 一个开关：点一次关、再点一次开。
    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).toBeNull();
    await clickRowAction(renderer, 'Session A');
    expect(pane(renderer)).not.toBeNull();
    expect(paneMode(renderer)).toBe('controlled');

    // 恒可写身份没有租约，别对它发注定 403 的 takeover/release。
    expect(lease.calls.filter(call => call !== 'get')).toEqual([]);
    act(() => renderer.unmount());
  });

  async function renderTouchPane(options: {
    fixed?: boolean;
    write: TerminalFrameWrite;
  }): Promise<TestRenderer.ReactTestRenderer> {
    const previousWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      matchMedia: (query: string) => ({
        matches: query === '(hover: none)',
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    };
    const lease = leaseApi({ fixed: options.fixed });
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(TerminalPane, {
          session: PAIR()[0],
          api: {
            ...lease.api,
            getTerminalViewLink: async () => ({ url: '/s/session-a?viewToken=cap', expiresAt: null }),
          },
          authenticated: true,
          capabilities: FULL_CAPABILITIES,
          now: NOW,
          location: LOCATION,
          readFrameWrite: () => options.write,
        }));
      });
      await settle();
    } finally {
      if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = previousWindow;
    }
    return renderer;
  }

  it('触屏 + 恒可写身份 + 这块 iframe 自报可写 → 说「可输入」，不再写死「手机端只读」', async () => {
    const renderer = await renderTouchPane({ fixed: true, write: 'writable' });
    expect(paneMode(renderer)).toBe('controlled');
    expect(feedback(renderer)).toContain('手机端也可直接输入');
    expect(feedback(renderer)).not.toContain('手机端为只读视图');
    act(() => renderer.unmount());
  });

  it('触屏 + 普通身份 → 照旧只读（那条 viewToken 通道确实只读）', async () => {
    const renderer = await renderTouchPane({ write: 'readonly' });
    expect(paneMode(renderer)).toBe('readonly');
    expect(feedback(renderer)).toContain('手机端为只读视图');
    act(() => renderer.unmount());
  });

  it('触屏 + 恒可写身份 + 读不出这块 iframe 的写权限 → 说未知，不冒充只读', async () => {
    const renderer = await renderTouchPane({ fixed: true, write: 'unknown' });
    expect(paneMode(renderer)).toBe('unknown');
    expect(feedback(renderer)).toContain('以终端页内的提示为准');
    act(() => renderer.unmount());
  });

  it('触屏 + 普通身份 + 读不出写权限 → 仍说只读：那条通道对非 owner 必定只读', async () => {
    const renderer = await renderTouchPane({ write: 'unknown' });
    expect(paneMode(renderer)).toBe('readonly');
    expect(feedback(renderer)).toContain('手机端为只读视图');
    act(() => renderer.unmount());
  });

  it('触屏读的那把钥匙是跨文件契约：终端页仍然导出同名的 hasToken 全局', () => {
    // 面板靠同源 iframe 里的 `window.hasToken` 判断这块终端到底能不能写
    // （readTerminalFrameWrite）。这个名字由 worker 渲染终端页时写下，两处必须
    // 对得上：worker 改名而这里不改，面板会静默退回「读不出来」，触屏文案又会
    // 悄悄回到写死的「手机端只读」——正是本次要修掉的那句反话。
    const worker = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    expect(worker).toContain('var hasToken=${hasWrite}');
    const panes = readFileSync(join(process.cwd(), 'src/dashboard/web/agent-workbench-panes.tsx'), 'utf8');
    expect(panes).toContain('{ hasToken?: unknown }');
  });
});

// ─── ⑥ 写 POST 的硬超时：永久 pending 不许锁死面板 ───────────────────────────
describe('写请求永久 pending 时不许把按钮和 busy 永久锁死', () => {
  it('takeover 迟迟不回执 → 到点判超时：进未知 + 遮罩 + 复核，按钮重新可点', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // hold 住的那个 promise 这条用例里**永远不 resolve**，正是线上会遇到的形状：
    // 连接半开、代理吞掉回执，fetch 就那么挂着。
    const lease = leaseApi({ hold: 'takeover' });
    const renderer = await renderPane(lease.api);
    expect(paneMode(renderer)).toBe('readonly');

    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lease.calls).toContain('takeover:session-a');
    expect(feedback(renderer)).toContain('正在接管输入');
    expect(paneControl(renderer, '接管输入')?.props.disabled).toBe(true);

    // 复核 GET 先按住，好观察 unknown 这个中间态。
    lease.gate.hold();
    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS + 100); });
    // 回归的形状：这里会一直停在「正在接管输入…」，busy 恒为真、按钮恒禁用，
    // 卸载补偿也永远等不到那个 promise。
    expect(paneMode(renderer)).toBe('unknown');
    expect(maskShown(renderer)).toBe(true);
    expect(feedback(renderer)).toContain('超时');
    expect(feedback(renderer)).toContain('控制权状态未知');
    // busy 解锁：用户还能再试一次，不是对着一个死掉的按钮干瞪眼。
    expect(paneControl(renderer, '接管输入')?.props.disabled).toBe(false);

    // 权威复核放行：服务端确实没有发出租约，这时才可以说只读，而且是有依据的。
    await act(async () => {
      lease.gate.open();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('readonly');
    expect(maskShown(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('release 同样有超时兜底：不会因为回执丢了就把「释放输入」永久禁用', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = leaseApi();
    const renderer = await renderPane(lease.api);
    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('controlled');

    // 第二次写（release）挂死：把替身换成一个永不回执的实现。
    const stuck = deferred<TerminalControlState>();
    const stuckApi: WorkbenchApi = {
      ...lease.api,
      releaseTerminal: async () => stuck.promise,
    };
    await act(async () => {
      renderer.update(React.createElement(TerminalPane, {
        session: PAIR()[0],
        api: stuckApi,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        now: NOW,
        location: LOCATION,
      }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      paneControl(renderer, '释放输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(feedback(renderer)).toContain('正在释放输入');

    // 复核 GET 按住，好观察 unknown 这个中间态。
    lease.gate.hold();
    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS + 100); });
    // 释放没拿到确认 → 绝不许乐观宣称只读：进未知、盖住可写 iframe、复核。
    expect(paneMode(renderer)).toBe('unknown');
    expect(maskShown(renderer)).toBe(true);
    // busy 解锁：未知态下标题栏给的是「接管输入」（我们并不知道租约还在不在），
    // 但它必须是可点的——不能因为回执丢了就把这块面板焊死。
    expect(paneControl(renderer, '接管输入')?.props.disabled).toBe(false);
    expect(lease.serverControlled()).toBe(true);

    // 复核放行：释放确实没成，租约还在手上，收敛回「可输入」而不是假的只读。
    await act(async () => {
      lease.gate.open();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(paneMode(renderer)).toBe('controlled');
    expect(maskShown(renderer)).toBe(false);
    act(() => renderer.unmount());
  });
});

// ─── P2：别的会话正控制着终端时，「接管」要说话 ─────────────────────────────
describe('另一个浏览器正握着租约时点「接管输入」不许静默吞掉', () => {
  it('标题栏「接管输入」照发 POST，服务端 control_busy 原样显示给用户', async () => {
    const lease = leaseApi({ busyElsewhere: true });
    const renderer = await renderView(lease.api);

    await openAndTakeOver(renderer, 'Session A');
    // 回归的形状：只在 mode === 'readonly' 时才发 POST，于是这个动作没有任何反馈。
    expect(lease.calls).toContain('takeover:session-a');
    await settle(4);
    expect(feedback(renderer)).toContain('另一个浏览器正在控制该终端');
    expect(paneMode(renderer)).not.toBe('controlled');
    act(() => renderer.unmount());
  });
});
