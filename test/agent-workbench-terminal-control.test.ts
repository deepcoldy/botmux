import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkbenchView } from '../src/dashboard/web/agent-workbench-view.js';
import { TerminalPane, type TerminalFrameWrite } from '../src/dashboard/web/agent-workbench-panes.js';
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
 *      精确补偿掉；快速双击「接管」只许发一次；15 秒观察轮询不许丢掉在途写的回执。
 *   3. release 失败：不许乐观宣称只读——保留最后一次权威读数、盖住可写 iframe、
 *      立刻 GET 复核。
 *   4. fixed / touch 的只读语义：恒可写身份行内收敛成一个开关且文案如实；触屏文案
 *      跟着这块 iframe 真实的写权限走。
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

function rowAction(
  renderer: TestRenderer.ReactTestRenderer,
  title: string,
  surface: 'terminal' | 'terminal-control',
): ReactTestInstance | null {
  return renderer.root.findAll(node => node.type === 'button'
    && node.props.className === `wb-session-row-action is-${surface}`
    && String(node.props['aria-label'] ?? '').endsWith(`— ${title}`))[0] ?? null;
}

async function clickRowAction(
  renderer: TestRenderer.ReactTestRenderer,
  title: string,
  surface: 'terminal' | 'terminal-control',
): Promise<void> {
  const button = rowAction(renderer, title, surface);
  if (!button) throw new Error(`row action ${surface} for ${title} not rendered`);
  await act(async () => { button.props.onClick({ stopPropagation() {} }); });
  await settle();
}

async function clickRow(renderer: TestRenderer.ReactTestRenderer, title: string): Promise<void> {
  const node = renderer.root.find(node => node.props.role === 'option'
    && String(node.props['aria-label'] ?? '').startsWith(`${title}.`));
  await act(async () => { node.props.onClick(); });
  await settle();
}

/** 面板在不在、挂在哪个会话上。 */
function pane(renderer: TestRenderer.ReactTestRenderer): { sessionId: string; autoTakeControl: boolean } | null {
  const panes = renderer.root.findAllByType(TerminalPane);
  if (panes.length === 0) return null;
  return {
    sessionId: String(panes[0].props.session.sessionId),
    autoTakeControl: panes[0].props.autoTakeControl === true,
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
        if (gatePromise) await gatePromise.promise;
        return snapshot();
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

// ─── ① 跨会话点「终端」（P1-1）───────────────────────────────────────────────
describe('跨会话点行内「终端」打开的是那一行的只读终端，不是把面板关掉', () => {
  it('A 的终端接管着，点 B 行「终端」→ B 的只读终端打开（回归时这里是 closed）', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: true });
    expect(paneMode(renderer)).toBe('controlled');

    await clickRowAction(renderer, 'Session B', 'terminal');
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

    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });

    await clickRowAction(renderer, 'Session B', 'terminal');
    expect(pane(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: false });
    act(() => renderer.unmount());
  });

  it('同一行的「终端」照旧是开关：第二次点击才关闭', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(pane(renderer)).not.toBeNull();
    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(pane(renderer)).toBeNull();
    act(() => renderer.unmount());
  });

  it('普通选中仍然只跟随、不接管（跨会话原子化没有把跟随一起改掉）', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A', 'terminal-control');
    await clickRow(renderer, 'Session B');
    expect(pane(renderer)).toEqual({ sessionId: 'session-b', autoTakeControl: false });
    expect(paneMode(renderer)).toBe('readonly');
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual(['takeover:session-a']);
    act(() => renderer.unmount());
  });
});

// ─── ①' 只读面板已经挂着 → 同一行点「接管」（用户实测报的那条）─────────────────
describe('先开只读终端、再点同一行的「接管」，写权限必须真的到手', () => {
  /**
   * 用户实测报的形状：「直接点接管能输入；先点『终端』开只读，再点『接管』就打不了字」。
   * 差别只在**面板已经挂着**：这一路要走完 readonly → taking-over → controlled 的
   * 显式转换，只读那一拍留下的一次性「还回租约」意图也必须已经兑现完、不能反手把
   * 用户刚按下的接管撤销掉。上面那组用例全是「面板还没挂 / 换会话 / 反方向降级」，
   * 没有一条压住这条正向转换，所以单独钉在这里。
   */
  it('只读面板挂着 → 点「接管」→ 换成带接管意图的面板，takeover 真的发出去且租约到手', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    // ① 只读打开：面板挂上，服务端此刻没有发出任何写租约。
    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: false });
    expect(paneMode(renderer)).toBe('readonly');
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual([]);
    expect(lease.serverControlled()).toBe(false);

    // ② 同一行再点「接管」。回归的形状是这里被判成「模式没变 → 什么都不做」或者
    //    面板不重挂 → 一次性的开场接管意图早已消费掉 → 永远没有 takeover 发出去，
    //    用户看着一个「只读」终端打不进字。
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(pane(renderer)).toEqual({ sessionId: 'session-a', autoTakeControl: true });
    expect(paneMode(renderer)).toBe('controlled');
    expect(feedback(renderer)).toContain('已接管');
    expect(lease.calls.filter(call => call.startsWith('takeover'))).toEqual(['takeover:session-a']);
    // 服务端侧的判据：租约真的发出来了，不只是徽标好看。
    expect(lease.serverControlled()).toBe(true);
    // 刚拿到的租约不许被只读那一拍的残留意图反手还回去。
    expect(lease.calls.filter(call => call.startsWith('release'))).toEqual([]);
    act(() => renderer.unmount());
  });

  it('接管之后再点「终端」→ 降回只读并真的把租约还回去（来回都完整）', async () => {
    const lease = leaseApi();
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A', 'terminal');
    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(lease.serverControlled()).toBe(true);

    await clickRowAction(renderer, 'Session A', 'terminal');
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

    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(paneMode(renderer)).toBe('readonly');

    await clickRowAction(renderer, 'Session A', 'terminal-control');
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
  it('快速双击「接管」只发一次 takeover，面板也不会在 POST 回来前被关掉', async () => {
    const lease = leaseApi({ hold: 'takeover' });
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A', 'terminal-control');
    // POST 还在飞：按钮此刻必须是禁用态，行为上也必须吞掉第二次点击。
    expect(rowAction(renderer, 'Session A', 'terminal-control')?.props.disabled).toBe(true);
    await clickRowAction(renderer, 'Session A', 'terminal-control');
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

    await clickRowAction(renderer, 'Session A', 'terminal-control');
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

    await clickRowAction(renderer, 'Session A', 'terminal-control');
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
        autoTakeControl: true,
        now: NOW,
        location: LOCATION,
      }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(lease.calls).toContain('takeover:session-a');

    // 轮询在写还没回执时发了一发，读到的当然还是「写之前的世界」；面板照旧显示
    // 「正在接管」，没有被这一发轮询挤掉。
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
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

    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(pane(renderer)).not.toBeNull();
    // 还没有任何权威读数：此时的模式是 loading，不是「只读」。
    expect(feedback(renderer)).toContain('正在检查终端权限');

    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(pane(renderer)).toBeNull();
    lease.gate.open();
    await settle();
    act(() => renderer.unmount());
  });
});

// ─── ③ release 失败：保留权威状态 + 遮罩 + 立刻复核（P1-3）───────────────────
describe('release 失败不许乐观宣称只读', () => {
  it('释放失败 → 徽标进「未知」并盖住可写 iframe，复核后回到真实的「可输入」', async () => {
    const lease = leaseApi({ hold: 'release' });
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(paneMode(renderer)).toBe('controlled');
    expect(lease.serverControlled()).toBe(true);

    // 行内「终端」= 降为只读，面板会真的发一次 release；这一次让它失败。
    await clickRowAction(renderer, 'Session A', 'terminal');
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

    await clickRowAction(renderer, 'Session A', 'terminal-control');
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
  it('平台 owner：行内收敛成一个「终端」开关，文案不再写「只读」，也不发任何控制 POST', async () => {
    const lease = leaseApi({ fixed: true });
    const renderer = await renderView(lease.api);

    // 还不知道身份时两个入口都在（第一次点开之前没有任何依据）。
    expect(rowAction(renderer, 'Session A', 'terminal-control')).not.toBeNull();

    await clickRowAction(renderer, 'Session A', 'terminal-control');
    expect(pane(renderer)).not.toBeNull();
    expect(paneMode(renderer)).toBe('controlled');

    // 面板回执带回 fixed：这是身份级事实，整张列表都收敛成一个开关。
    expect(rowAction(renderer, 'Session A', 'terminal-control')).toBeNull();
    expect(rowAction(renderer, 'Session B', 'terminal-control')).toBeNull();
    const toggle = rowAction(renderer, 'Session A', 'terminal')!;
    expect(toggle.props.title).toBe('打开终端（当前身份可直接输入）');
    expect(toggle.props.title).not.toContain('只读');

    // 一个按钮 = 一个开关：点一次关、再点一次开。
    await clickRowAction(renderer, 'Session A', 'terminal');
    expect(pane(renderer)).toBeNull();
    await clickRowAction(renderer, 'Session A', 'terminal');
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

// ─── P2：别的会话正控制着终端时，「接管」要说话 ─────────────────────────────
describe('另一个浏览器正握着租约时点「接管」不许静默吞掉', () => {
  it('行内「接管」照发 POST，服务端 control_busy 原样显示给用户', async () => {
    const lease = leaseApi({ busyElsewhere: true });
    const renderer = await renderView(lease.api);

    await clickRowAction(renderer, 'Session A', 'terminal-control');
    // 回归的形状：只在 mode === 'readonly' 时才发 POST，于是这个动作没有任何反馈。
    expect(lease.calls).toContain('takeover:session-a');
    await settle(4);
    expect(feedback(renderer)).toContain('另一个浏览器正在控制该终端');
    expect(paneMode(renderer)).not.toBe('controlled');
    act(() => renderer.unmount());
  });
});
