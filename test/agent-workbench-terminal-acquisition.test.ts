import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from '../src/dashboard/web/agent-workbench-panes.js';
import {
  WorkbenchApiError,
  type TerminalControlState,
  type WorkbenchApi,
} from '../src/dashboard/web/agent-workbench-api.js';
import {
  initialTerminalControlModel,
  terminalControlMode,
  terminalControlNeedsMask,
  terminalControlReducer,
} from '../src/dashboard/web/agent-workbench-terminal-control.js';
import { TerminalControlManager } from '../src/dashboard/terminal-control.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';
import type { WorkbenchCapabilities } from '../src/dashboard/web/agent-workbench-capabilities.js';
import type { WorkbenchSessionRow } from '../src/dashboard/web/agent-workbench-model.js';

/**
 * 收口轮的四条组合门禁。
 *
 * 与 `agent-workbench-terminal-control.test.ts` 的分工：那一份用手写的租约替身钉
 * 状态机的时序；这一份把**真的 `TerminalControlManager`** 接在面板背后，验的是
 * 「浏览器这一侧发出的补偿，落到服务端租约上到底是什么结果」。租约挂在
 * （会话 × 登录）上，同一个登录的第二块面板拿到的是同一把——只有客户端在 POST
 * **之前**自己生成的 acquisition id 分得清「我那一次」和「别人后来那一次」。
 *
 *   门禁① 回执丢了 + 跨标签页抢先接管 + 旧面板补偿 → 新租约必须原封不动
 *   门禁② 旧 poll 发出 → 接管回执丢 → unknown → 旧 poll 回来仍是 unknown/遮罩
 *   门禁③ 接管已结算但 WS 还没注册就关面板 → 租约必须被收掉，且不伤随后的新接管
 *   门禁④ viewToken 换链 → 立刻 unknown，新 WS 报只读之后才是只读
 */

const NOW = 1_900_000_001_000;
const LOCATION = { protocol: 'http:', origin: 'http://dashboard.test', hostname: 'dashboard.test' };
const FULL_CAPABILITIES: WorkbenchCapabilities = { canLocate: true, canControl: true, canInteract: true };
const READONLY: TerminalControlState = { mode: 'readonly', owned: false };
const SESSION = 'session-a';

function row(sessionId: string): WorkbenchSessionRow {
  return {
    sessionId,
    title: 'Session A',
    status: 'working',
    botName: 'Builder',
    cliId: 'codex',
    chatId: `oc_${sessionId}`,
    webPort: 7681,
    proxyPort: 7682,
    lastMessageAt: 1_800_000_002_000,
  };
}

const baseApi: WorkbenchApi = {
  getTerminalControl: async () => READONLY,
  takeoverTerminal: async () => ({ mode: 'controlled', owned: true, expiresAt: NOW + 60_000 }),
  releaseTerminal: async () => READONLY,
  getPreviewInteraction: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'x' }),
  unlockPreview: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'x' }),
  touchPreview: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'x' }),
  lockPreview: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'x' }),
  getH5Context: async () => null,
  getTerminalViewLink: async () => null,
  locateSession: async () => {},
  getStandingLink: async () => null,
};

class MemoryAudit implements ControlAuditSink {
  readonly records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
}

async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await act(async () => {});
}

function paneControl(
  renderer: TestRenderer.ReactTestRenderer,
  label: '接管输入' | '释放输入',
): ReactTestInstance | null {
  return renderer.root.findAll(node => node.type === 'button' && textOf(node) === label)[0] ?? null;
}

function paneMode(
  renderer: TestRenderer.ReactTestRenderer,
): 'controlled' | 'readonly' | 'unknown' | 'checking' | 'closed' {
  const chips = renderer.root.findAll(node =>
    typeof node.props.className === 'string' && node.props.className.startsWith('wb-mode-chip'));
  if (chips.length === 0) return 'closed';
  const className = String(chips[0].props.className);
  if (className.includes('is-controlled')) return 'controlled';
  if (className.includes('is-unknown')) return 'unknown';
  if (className.includes('is-checking')) return 'checking';
  return 'readonly';
}

function maskShown(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findAll(node =>
    String(node.props.className ?? '').includes('wb-control-unknown')).length > 0;
}

function terminalFrames(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAll(node => node.type === 'iframe'
    && String(node.props.className ?? '').includes('wb-pane-frame')).length;
}

function frameKeys(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAll(node => node.type === 'iframe'
    && String(node.props.className ?? '').includes('wb-pane-frame'))
    .map(node => String(node.props.title ?? '') + '|' + String(node.props.src ?? ''));
}

/**
 * 真服务端租约 + 一条把它接到面板上的 WorkbenchApi。
 *
 * 这里没有任何「行为替身」：takeover / release / state 全部落到生产的
 * `TerminalControlManager`，CAS 也是它自己那条。测试能直接问服务端「这一刻租约在
 * 不在、在哪一次 acquisition 上」——这正是补偿类回归唯一算数的判据。
 */
function liveLease(): {
  api: WorkbenchApi;
  control: TerminalControlManager;
  calls: string[];
  /** 服务端此刻的租约状态（用另一个只读视角问，不惊动 CAS）。 */
  leaseAcquisition(): string | undefined;
  leaseHeld(): boolean;
  /** 模拟「另一个标签页在同一个登录下又接管了一次」。 */
  supersede(acquisitionId: string): void;
  holdNextTakeover(): { resolve(): void; reject(error: unknown): void };
  holdGets(on: boolean): void;
  /** 放行第 n 个被按住的 GET（0 起）。 */
  flushGet(index: number): void;
  pendingGets(): number;
} {
  const audit = new MemoryAudit();
  const control = new TerminalControlManager({ secret: 'closure-secret', audit, now: () => NOW });
  const actor = {
    userId: 'user-1',
    authSessionId: 'auth-1',
    expiresAt: NOW + 10 * 60_000,
    terminalCapability: 'controlled' as const,
  };
  const calls: string[] = [];
  let held: { promise: Promise<void>; resolve(value: void): void; reject(error: unknown): void } | null = null;
  let gating = false;
  const gates: Array<{ promise: Promise<void>; resolve(value: void): void }> = [];

  const toState = (raw: ReturnType<TerminalControlManager['state']>): TerminalControlState => ({
    mode: raw.mode,
    owned: raw.owned,
    ...(raw.expiresAt === undefined ? {} : { expiresAt: raw.expiresAt }),
    ...(raw.fixed === undefined ? {} : { fixed: raw.fixed }),
    ...((raw as { acquisition?: string }).acquisition === undefined
      ? {}
      : { acquisition: (raw as { acquisition?: string }).acquisition }),
  });

  return {
    control,
    calls,
    // 旧实现叫 marker（服务端生成），新实现叫 acquisition（客户端生成）。这里两边都
    // 读得到，用例才能在**行为**上分红绿，而不是卡在字段改名上。
    leaseAcquisition: () => {
      const raw = control.state(actor, SESSION) as { acquisition?: string; marker?: string };
      return raw.acquisition ?? raw.marker;
    },
    leaseHeld: () => control.state(actor, SESSION).mode === 'controlled',
    supersede(acquisitionId: string) {
      const result = control.takeover(actor, SESSION, acquisitionId);
      if (!result.ok) throw new Error(`supersede failed: ${result.error}`);
    },
    holdNextTakeover() {
      const gate = deferred<void>();
      held = gate;
      return { resolve: () => gate.resolve(undefined), reject: error => gate.reject(error) };
    },
    holdGets(on: boolean) { gating = on; },
    flushGet(index: number) { gates[index]?.resolve(undefined); },
    pendingGets: () => gates.length,
    api: {
      ...baseApi,
      getTerminalControl: async () => {
        calls.push('get');
        // 读数在服务端受理这一刻就定形，闸门只按住回执 —— 「写之前受理、写结算之后
        // 才回来」的旧 poll 只能这样造出来。
        const answer = toState(control.state(actor, SESSION));
        if (gating) {
          const gate = deferred<void>();
          gates.push(gate);
          await gate.promise;
        }
        return answer;
      },
      takeoverTerminal: async (sessionId: string, _signal?: AbortSignal, acquisitionId?: string) => {
        calls.push(`takeover:${acquisitionId ?? '*'}`);
        const result = control.takeover(actor, sessionId, acquisitionId);
        const gate = held;
        held = null;
        if (gate) await gate.promise;
        if (!result.ok) throw new WorkbenchApiError(409, result.error);
        return {
          mode: 'controlled' as const,
          owned: true,
          ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
          ...(result.acquisition === undefined ? {} : { acquisition: result.acquisition }),
        };
      },
      releaseTerminal: async (sessionId: string, _signal?: AbortSignal, expected?: string) => {
        calls.push(`release:${expected ?? '*'}`);
        const result = control.release(actor, sessionId, expected);
        if (!result.ok) throw new WorkbenchApiError(403, result.error);
        return READONLY;
      },
    },
  };
}

async function renderPane(
  api: WorkbenchApi,
  options?: TestRenderer.TestRendererOptions,
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(TerminalPane, {
      session: row(SESSION),
      api,
      authenticated: true,
      capabilities: FULL_CAPABILITIES,
      now: NOW,
      location: LOCATION,
    }), options);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return renderer;
}

afterEach(() => { vi.useRealTimers(); });

// ─── 门禁①：回执丢了 + 跨标签页抢先接管 + 旧面板补偿 ────────────────────────
describe('门禁①：旧面板的迟到补偿不许踩掉跨标签页刚拿到的新租约', () => {
  it('回执丢失 → 别处接管 → 旧面板补偿：新租约必须原封不动地留着', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = liveLease();

    // ① 第一块面板接管。服务端**已经受理**（真 manager 里租约已发出），只是回执被按住。
    const gate = lease.holdNextTakeover();
    const first = await renderPane(lease.api);
    await act(async () => {
      paneControl(first, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lease.leaseHeld()).toBe(true);
    const mine = lease.leaseAcquisition();

    // ② 面板没了（关标签页 / 切会话）。
    act(() => first.unmount());

    // ③ 另一个标签页（同一个登录）接管：同一把租约，acquisition 往前滚。
    lease.supersede('acq-other-tab');
    const otherTab = lease.leaseAcquisition();
    expect(otherTab).not.toBe(mine);

    // ④ 第一块面板的回执现在才**失败**回来（响应丢了，服务端其实早就受理了）。
    //    旧实现在这里去 GET 一次「当前 marker」再 release —— 拿到的正是新标签页那
    //    一把，于是精准误删。新实现按自己 POST 前生成的 acquisition 做 CAS。
    await act(async () => {
      gate.reject(new WorkbenchApiError(504, 'control_request_timeout'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();

    expect(lease.leaseHeld()).toBe(true);
    expect(lease.leaseAcquisition()).toBe(otherTab);
    // 补偿确实发出去了（不是「什么都没做」蒙混过关），只是被 CAS 拒了；而且带的是
    // **自己那一次**的 id，不是事后 GET 回来的当前 id。
    const releases = lease.calls.filter(call => call.startsWith('release:'));
    expect(releases.length).toBeGreaterThan(0);
    expect(releases.every(call => call !== 'release:*')).toBe(true);
    expect(releases.every(call => call !== `release:${otherTab}`)).toBe(true);
    expect(releases.some(call => call === `release:${mine}`)).toBe(true);
  });

  it('没人抢：回执丢失后旧面板的补偿按自己的 acquisition 真的把租约收掉', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = liveLease();
    const gate = lease.holdNextTakeover();
    const first = await renderPane(lease.api);
    await act(async () => {
      paneControl(first, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lease.leaseHeld()).toBe(true);
    act(() => first.unmount());
    await act(async () => {
      gate.reject(new WorkbenchApiError(504, 'control_request_timeout'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(lease.leaseHeld()).toBe(false);
  });
});

// ─── 门禁②：旧 poll 不许把写失败后的 unknown 倒写回只读 ─────────────────────
describe('门禁②：接管之前发出的旧 poll 不许推翻写失败留下的 unknown', () => {
  /**
   * 门禁序列（复审给的那条）：old poll issued → takeover response lost → unknown →
   * old poll returns 仍保持 unknown/mask，只有写之后新发的 reconcile 收敛得了。
   *
   * 这条要在**状态机本身**上钉住：面板那一层的观察计数器碰巧还能兜住一部分时序
   * （复核 GET 一发出就把旧 poll 的 epoch 作废了），但 reducer 是独立的公共契约，
   * 「写失败不推进盖写基准」这个漏洞就住在里面 —— 写失败恰恰是最需要 unknown 这道
   * 防线的场景（回执丢了、服务端很可能已经受理）。
   */
  it('状态机：旧 poll 的盖写基准是「已发起的写 epoch」，写失败也算', () => {
    let model = initialTerminalControlModel();
    model = terminalControlReducer(model, { type: 'observe-start', epoch: 1, source: 'load' });
    model = terminalControlReducer(model, { type: 'observe-settled', epoch: 1, control: READONLY });
    expect(model.phase).toBe('readonly');

    // ① 15 秒轮询发出（此刻服务端还没有租约）。
    model = terminalControlReducer(model, { type: 'observe-start', epoch: 2, source: 'poll' });

    // ② 用户接管，回执丢了 → unknown + 遮罩（服务端很可能已经受理）。
    model = terminalControlReducer(model, { type: 'write-start', epoch: 1, action: 'takeover' });
    model = terminalControlReducer(model, { type: 'write-failed', epoch: 1, error: 'control_request_timeout' });
    expect(terminalControlMode(model)).toBe('unknown');
    expect(terminalControlNeedsMask(model)).toBe(true);

    // ③ 旧 poll 现在才回来，说的是接管**之前**的世界。
    model = terminalControlReducer(model, { type: 'observe-settled', epoch: 2, control: READONLY });
    expect(terminalControlMode(model)).toBe('unknown');
    expect(terminalControlNeedsMask(model)).toBe(true);

    // ④ 写之后新发的复核才作数。
    model = terminalControlReducer(model, { type: 'observe-start', epoch: 3, source: 'reconcile' });
    model = terminalControlReducer(model, {
      type: 'observe-settled',
      epoch: 3,
      control: { mode: 'controlled', owned: true, expiresAt: NOW + 60_000 },
    });
    expect(terminalControlMode(model)).toBe('controlled');
    expect(terminalControlNeedsMask(model)).toBe(false);
  });

  it('状态机：写在途期间发出的观察同样作废（它描述的是一个未定的世界）', () => {
    let model = initialTerminalControlModel();
    model = terminalControlReducer(model, { type: 'observe-start', epoch: 1, source: 'load' });
    model = terminalControlReducer(model, { type: 'observe-settled', epoch: 1, control: READONLY });
    model = terminalControlReducer(model, { type: 'write-start', epoch: 1, action: 'takeover' });
    // POST 已经出门、回执还没到时发出的轮询。
    model = terminalControlReducer(model, { type: 'observe-start', epoch: 2, source: 'poll' });
    model = terminalControlReducer(model, {
      type: 'write-settled',
      epoch: 1,
      control: { mode: 'controlled', owned: true, expiresAt: NOW + 60_000 },
    });
    model = terminalControlReducer(model, { type: 'observe-settled', epoch: 2, control: READONLY });
    expect(terminalControlMode(model)).toBe('controlled');
  });

  it('状态机：写失败的错误文案不被更早发出的观察失败盖掉', () => {
    let model = initialTerminalControlModel();
    model = terminalControlReducer(model, { type: 'observe-start', epoch: 1, source: 'load' });
    model = terminalControlReducer(model, { type: 'observe-settled', epoch: 1, control: READONLY });
    model = terminalControlReducer(model, { type: 'observe-start', epoch: 2, source: 'poll' });
    model = terminalControlReducer(model, { type: 'write-start', epoch: 1, action: 'release' });
    model = terminalControlReducer(model, { type: 'write-failed', epoch: 1, error: 'control_request_timeout' });
    model = terminalControlReducer(model, {
      type: 'observe-failed', epoch: 2, error: 'daemon_offline', canHoldLease: true,
    });
    expect(model.error).toEqual({ text: 'control_request_timeout', from: 'write' });
    expect(terminalControlMode(model)).toBe('unknown');
  });

  it('面板：旧 poll 发出 → 接管回执丢 → unknown → 旧 poll 回来仍是 unknown + 遮罩', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = liveLease();
    const renderer = await renderPane(lease.api);
    expect(paneMode(renderer)).toBe('readonly');

    // ① 15 秒轮询发出一发观察，回执按住（此刻服务端还没有租约 → 读数是 readonly）。
    lease.holdGets(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(lease.pendingGets()).toBe(1);

    // ② 用户点接管：服务端受理，回执丢了 → 写失败 → unknown。
    const gate = lease.holdNextTakeover();
    await act(async () => { paneControl(renderer, '接管输入')?.props.onClick(); });
    await act(async () => {
      gate.reject(new WorkbenchApiError(504, 'control_request_timeout'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(paneMode(renderer)).toBe('unknown');
    expect(maskShown(renderer)).toBe(true);
    expect(lease.leaseHeld()).toBe(true);

    // ③ 写失败后的复核 GET 也发出来了（按住不放，好把旧 poll 单独拎出来看）。
    expect(lease.pendingGets()).toBe(2);

    // ④ 旧 poll 现在才回来。它描述的是接管**之前**的世界（readonly）。
    //    回归的形状：unknown 被倒写成 readonly、遮罩撤掉，而服务端租约还挂着 —— 用户
    //    对着一个写着「只读」的终端照样能打字。
    await act(async () => {
      lease.flushGet(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(paneMode(renderer)).toBe('unknown');
    expect(maskShown(renderer)).toBe(true);

    // ⑤ 只有写之后发出的那一发复核才收敛得了：它读到的是真租约。
    await act(async () => {
      lease.flushGet(1);
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(paneMode(renderer)).toBe('controlled');
    expect(maskShown(renderer)).toBe(false);
    act(() => renderer.unmount());
  });
});

// ─── 门禁③：接管已结算、WS 还没注册就关面板 ─────────────────────────────────
describe('门禁③：接管已回执但 WS 未注册就关面板，租约必须被收掉', () => {
  it('takeover settled → 关面板 → 服务端租约清掉', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = liveLease();
    const renderer = await renderPane(lease.api);
    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(paneMode(renderer)).toBe('controlled');
    expect(lease.leaseHeld()).toBe(true);

    // 这块面板从来没有连上 WS（组件测试里根本没有 socket），所以既没有在途 promise
    // 可补偿，也没有已注册的 socket 会在断开时触发 disconnect。旧实现只撤掉本地
    // 认领，租约一路挂到 TTL。
    act(() => renderer.unmount());
    await settle();
    expect(lease.leaseHeld()).toBe(false);
  });

  it('settled → 别处接管 → 再关旧面板：新 acquisition 不受伤', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = liveLease();
    const renderer = await renderPane(lease.api);
    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(lease.leaseHeld()).toBe(true);

    lease.supersede('acq-newer-pane');
    const newer = lease.leaseAcquisition();
    act(() => renderer.unmount());
    await settle();
    expect(lease.leaseHeld()).toBe(true);
    expect(lease.leaseAcquisition()).toBe(newer);
  });

  it('释放失败且面板已卸载：按此前接管的那一次 acquisition 再条件释放一遍', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lease = liveLease();
    const gate = deferred<never>();
    const failing: WorkbenchApi = {
      ...lease.api,
      releaseTerminal: async (sessionId, signal, expected) => {
        if (expected === undefined) {
          // 用户手点「释放输入」那一次：回执在路上丢了（服务端受没受理都不知道）。
          lease.calls.push('release:manual-lost');
          await gate.promise;
          throw new WorkbenchApiError(504, 'control_request_timeout');
        }
        return lease.api.releaseTerminal(sessionId, signal, expected);
      },
    };
    const renderer = await renderPane(failing);
    await act(async () => {
      paneControl(renderer, '接管输入')?.props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(lease.leaseHeld()).toBe(true);

    await act(async () => { paneControl(renderer, '释放输入')?.props.onClick(); });
    act(() => renderer.unmount());
    await act(async () => {
      gate.reject(new WorkbenchApiError(504, 'control_request_timeout'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    // 回归的形状：释放失败 + 面板已卸载 → 什么都不做，租约一路挂到 TTL。
    expect(lease.leaseHeld()).toBe(false);
    expect(lease.calls.filter(call => call.startsWith('release:') && call !== 'release:manual-lost'))
      .not.toEqual([]);
  });

  it('恒可写身份（fixed）关面板不发任何 release', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const calls: string[] = [];
    const fixedApi: WorkbenchApi = {
      ...baseApi,
      getTerminalControl: async () => {
        calls.push('get');
        return { mode: 'controlled', owned: true, fixed: true };
      },
      releaseTerminal: async () => { calls.push('release'); return READONLY; },
    };
    const renderer = await renderPane(fixedApi);
    await settle();
    expect(paneMode(renderer)).toBe('controlled');
    act(() => renderer.unmount());
    await settle();
    expect(calls.filter(call => call === 'release')).toEqual([]);
  });
});

// ─── 门禁④：viewToken 换链立刻回到未知 ──────────────────────────────────────
describe('门禁④：短时 viewToken 换链后，旧连接的写权限结论必须作废', () => {
  async function renderTouchFixedPane(links: string[]): Promise<{
    renderer: TestRenderer.ReactTestRenderer;
    frameWindow: object;
    post(data: unknown, source: unknown): void;
    restore(): void;
  }> {
    const listeners: Array<(event: unknown) => void> = [];
    const previousWindow = (globalThis as Record<string, unknown>).window;
    const frameWindow = {};
    (globalThis as Record<string, unknown>).window = {
      matchMedia: (query: string) => ({
        matches: query === '(hover: none)',
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        if (type === 'message') listeners.push(handler);
      },
      removeEventListener: (type: string, handler: (event: unknown) => void) => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
    let issued = 0;
    const api: WorkbenchApi = {
      ...baseApi,
      // 恒可写身份：控制权接口说 fixed，触屏这条通道能不能写只由终端页自己回报。
      getTerminalControl: async () => ({ mode: 'controlled', owned: true, fixed: true }),
      getTerminalViewLink: async () => {
        const url = links[Math.min(issued, links.length - 1)];
        issued += 1;
        // 短时能力：35 秒后到期 → hook 在提前 30 秒的档口重取，正好造出换链。
        return { url, expiresAt: NOW + 35_000 };
      },
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: row(SESSION),
        api,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        now: NOW,
        location: LOCATION,
      }), {
        createNodeMock: (element: { props: Record<string, unknown> }) => (
          String((element.props as { className?: string }).className ?? '').includes('wb-pane-frame')
            ? { contentWindow: frameWindow }
            : null
        ),
      });
    });
    await settle();
    return {
      renderer,
      frameWindow,
      post(data, source) { for (const handler of [...listeners]) handler({ data, source }); },
      restore() {
        if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window;
        else (globalThis as Record<string, unknown>).window = previousWindow;
      },
    };
  }

  it('旧链报可写 → 换链 → 未知；新 WS 报只读之后才是只读', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const touch = await renderTouchFixedPane([
      '/s/session-a?viewToken=cap-1',
      '/s/session-a?viewToken=cap-2',
    ]);
    try {
      // ① 旧链上的终端页回报：这条 WS 拿到写权限。
      await act(async () => {
        touch.post({ type: 'botmux:wb-terminal-write', write: true }, touch.frameWindow);
      });
      expect(paneMode(touch.renderer)).toBe('controlled');
      const before = frameKeys(touch.renderer);
      expect(before.length).toBe(1);

      // ② viewToken 到期前换链：新的 URL、新的连接，旧连接的结论一律作废。
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      await settle();
      const after = frameKeys(touch.renderer);
      expect(after.length).toBe(1);
      expect(after[0]).not.toBe(before[0]);
      // 回归的形状：React 复用同一块 iframe / WindowProxy，旧连接报的 writable 没被
      // 清掉，UI 继续说「可输入」。
      expect(paneMode(touch.renderer)).toBe('unknown');

      // ③ 新连接自己说话之后才落座。
      await act(async () => {
        touch.post({ type: 'botmux:wb-terminal-write', write: false }, touch.frameWindow);
      });
      expect(paneMode(touch.renderer)).toBe('readonly');
    } finally {
      act(() => touch.renderer.unmount());
      touch.restore();
    }
  });
});

// ─── 首屏未知期间不许挂可写 iframe（第 9 / 9b 点）────────────────────────────
describe('首个控制权 GET 没回来之前，能握租约的通道不挂 iframe', () => {
  it('loading 阶段 terminalFrames === 0（同一个登录留下的旧租约会让它真的可写）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const gate = deferred<TerminalControlState>();
    const api: WorkbenchApi = {
      ...baseApi,
      getTerminalControl: async () => gate.promise,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: row(SESSION),
        api,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        now: NOW,
        location: LOCATION,
      }));
    });
    expect(paneMode(renderer)).toBe('checking');
    expect(terminalFrames(renderer)).toBe(0);

    await act(async () => {
      gate.resolve(READONLY);
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(paneMode(renderer)).toBe('readonly');
    expect(terminalFrames(renderer)).toBe(1);
    act(() => renderer.unmount());
  });

  it('随后才被识别为 fixed 的平台 owner，loading 期间同样不挂', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const gate = deferred<TerminalControlState>();
    const api: WorkbenchApi = { ...baseApi, getTerminalControl: async () => gate.promise };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: row(SESSION),
        api,
        authenticated: true,
        capabilities: FULL_CAPABILITIES,
        now: NOW,
        location: LOCATION,
      }));
    });
    expect(terminalFrames(renderer)).toBe(0);
    await act(async () => {
      gate.resolve({ mode: 'controlled', owned: true, fixed: true });
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(paneMode(renderer)).toBe('controlled');
    expect(terminalFrames(renderer)).toBe(1);
    act(() => renderer.unmount());
  });

  it('无 canControl 能力的只读通道 loading 期间照旧直挂', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const gate = deferred<TerminalControlState>();
    const api: WorkbenchApi = { ...baseApi, getTerminalControl: async () => gate.promise };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: row(SESSION),
        api,
        authenticated: true,
        capabilities: { canLocate: true, canControl: false, canInteract: false },
        now: NOW,
        location: LOCATION,
      }));
    });
    expect(terminalFrames(renderer)).toBe(1);
    await act(async () => {
      gate.resolve(READONLY);
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(terminalFrames(renderer)).toBe(1);
    act(() => renderer.unmount());
  });
});
