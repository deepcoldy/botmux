/**
 * 终端控制权的**唯一**状态机。
 *
 * 这里住着两半，它们是同一件事的两个视角，所以放在同一个文件里，共用同一套模式
 * 词汇（`TerminalPaneMode`）：
 *
 *   ① 面板侧（{@link terminalControlReducer}）—— 这块终端此刻的租约状态。
 *   ② 外层侧（{@link toggleTerminalIntent} 等）—— 行内「终端」按钮的开关意图：
 *      面板开在哪个会话上。接管不在这一侧，它只由面板标题栏的「接管输入」驱动。
 *
 * 之所以要一个显式状态机，而不是几个 useState 拼起来：控制权同时被四种事件推着走
 * ——首屏 GET、15 秒观察轮询、用户的写操作（takeover/release）、以及面板自己的重挂
 * ——它们会互相抢状态。散着写时踩过的坑逐条列在这里，每一条都对应下面的一段实现：
 *
 *   - **观察与写共用一个 generation**：15 秒轮询一发，正在飞的 takeover 回执就被
 *     判成过期丢掉，界面停在只读，服务端却已经把写租约发出去了。→ 观察 epoch 与
 *     写 epoch 彻底分开：写只被**更新的写**作废，轮询作废不了它；反过来，有在途写
 *     时轮询读数一律丢弃（它描述的是写之前的世界）。
 *   - **只看「有没有在途写」拦不住旧读数**：takeover 发起**之前**就出门的那发轮询，
 *     若在接管回执结算之后才回来，此刻 pending 已经清空，于是这份写之前的读数被当
 *     成权威，界面从 controlled 倒写成 readonly（release 方向对称：把已经还掉的租约
 *     倒写回「可输入」）。→ 读数按**发出时刻**盖写：观察发出时记下当时已结算的写
 *     epoch，回来时早于最新的已结算写 epoch 就丢掉。复核 GET 不受影响——它发出时写
 *     已经不在途，快照与当前相等，照旧能把 unknown 收敛掉。
 *   - **把「还不知道」当成只读**：首屏 GET 没回来时对外说 readonly，用户第二次点
 *     「终端」就被判成「模式没变 → 重挂」而不是关闭。→ `loading` 是一个显式状态，
 *     没有权威读数时同一个按钮再点一次一律按关闭处理。
 *   - **写失败就乐观宣称只读**：release 失败后界面说只读，可写租约其实还在服务端
 *     挂着，用户对着一个「只读」的终端照样能打字。→ 写失败进 `unknown`：保留最后
 *     一次权威读数、立刻发一次 GET 复核，期间由调用方把可写 iframe 遮住。
 *
 * 状态本身是纯函数，不碰 React、不碰网络：所有异步都由调用方发起，回执以带 epoch
 * 的事件喂回来，过期事件在这里被丢掉。
 */
import type { TerminalControlState } from './agent-workbench-api.js';

// ─── 面板侧：租约状态机 ──────────────────────────────────────────────────────

/**
 * 面板此刻的控制权阶段。
 *   loading      首屏 GET 还没回来，什么都不知道（≠ 只读，徽标也不许写「只读」）。
 *   readonly     权威读数：没有可写租约。
 *   controlled   权威读数：这个浏览器握着写租约（平台所有者的恒可写身份也算）。
 *   taking-over  写在途：POST takeover 还没回执。
 *   releasing    写在途：POST release 还没回执。
 *   unknown      权威状态未知（写失败 / 读失败）。**不许**当成只读展示。
 */
export type TerminalControlPhase =
  | 'loading'
  | 'readonly'
  | 'controlled'
  | 'taking-over'
  | 'releasing'
  | 'unknown';

export type TerminalWriteAction = 'takeover' | 'release';

export interface TerminalControlModel {
  phase: TerminalControlPhase;
  /** 最后一次**权威**读数（GET 或写回执）。unknown 阶段照旧保留它——「不知道现在
   *  怎么样」不等于「回到出厂只读」，复核 GET 回来之前它是唯一有依据的东西。 */
  authoritative: TerminalControlState | null;
  /** 观察 epoch（首屏 / 轮询 / 复核）。只作废观察，作废不了写。 */
  observeEpoch: number;
  /** 当前这发观察**发出时**，已经结算过的最新那次写的 epoch。读数描述的是「发出那
   *  一刻的世界」，所以它是否过期只能拿发出时刻去比，不能拿回来时的 pending 去比。 */
  observeIssueEpoch: number;
  /** 写 epoch（takeover / release）。只被更新的写作废，轮询碰不到它。 */
  writeEpoch: number;
  /** 最近一次**结算成功**（拿到权威回执）的写 epoch。发出时刻早于它的读数一律作废。
   *  写**失败**不算：失败没有产生任何权威读数，随后的复核 GET 正是要靠它收敛
   *  unknown，把失败也计进来就等于把复核自己挡在门外。 */
  settledWriteEpoch: number;
  /** 在途写。非空期间轮询读数一律丢弃。 */
  pending: { action: TerminalWriteAction; epoch: number } | null;
  /** 这块 iframe **可能**仍然可写（拿过租约，或有过一次可能已经生效的接管）。
   *  unknown 阶段靠它决定要不要遮住 iframe：从来没碰过写的面板不需要遮，
   *  一次读失败不该把只读终端也糊上一层。 */
  mayWrite: boolean;
  /** 最近一次失败。`from: 'write'` 的错误要挺过随后的复核 GET——control_busy 正是
   *  这样一条「读数没问题、但你的动作没成」的消息，被复核清掉就等于静默吞掉。 */
  error: { text: string; from: 'observe' | 'write' } | null;
  /** iframe 重挂计数：租约变化必须换一块 iframe，否则页面还挂着旧 grant。 */
  frameGeneration: number;
  /** 每需要立刻发一次复核 GET 就 +1（写失败后）。 */
  reconcileNonce: number;
}

export type TerminalControlEvent =
  | { type: 'observe-start'; epoch: number; source: 'load' | 'poll' | 'reconcile' }
  | { type: 'observe-settled'; epoch: number; control: TerminalControlState }
  | { type: 'observe-failed'; epoch: number; error: string }
  /** 没有凭证 / 没有终端可框：控制权接口只会 401，直接落到只读，不发请求。 */
  | { type: 'settle-readonly' }
  | { type: 'write-start'; epoch: number; action: TerminalWriteAction }
  | { type: 'write-settled'; epoch: number; control: TerminalControlState }
  | { type: 'write-failed'; epoch: number; error: string };

export function initialTerminalControlModel(): TerminalControlModel {
  return {
    phase: 'loading',
    authoritative: null,
    observeEpoch: 0,
    observeIssueEpoch: 0,
    writeEpoch: 0,
    settledWriteEpoch: 0,
    pending: null,
    mayWrite: false,
    error: null,
    frameGeneration: 0,
    reconcileNonce: 0,
  };
}

/** 一次权威读数落成哪个阶段。`fixed`（平台所有者恒可写）在服务端就是 controlled。 */
function settledPhase(control: TerminalControlState): 'controlled' | 'readonly' {
  return control.mode === 'controlled' && control.owned ? 'controlled' : 'readonly';
}

function ownsWrite(control: TerminalControlState | null): boolean {
  return control?.mode === 'controlled' && control.owned;
}

/** 有在途写。行内 / 标题栏的写按钮此刻必须禁用或串行——不然快速双击会发出两次
 *  takeover，第一次的租约没有任何界面在管。 */
export function terminalControlBusy(model: TerminalControlModel): boolean {
  return model.phase === 'taking-over' || model.phase === 'releasing';
}

/** 已经有过权威读数（开场意图只在这之后兑现一次）。 */
export function terminalControlSettled(model: TerminalControlModel): boolean {
  return model.phase === 'readonly' || model.phase === 'controlled';
}

/** 未知且这块 iframe 可能是可写的 → 调用方必须遮住它。 */
export function terminalControlNeedsMask(model: TerminalControlModel): boolean {
  return model.phase === 'unknown' && model.mayWrite;
}

/** 用户眼里的四种模式。写在途时沿用最后一次权威读数：接管过程中说「只读」，
 *  与紧接着的回执自相矛盾。 */
export type TerminalPaneMode = 'loading' | 'readonly' | 'controlled' | 'unknown';

export function terminalControlMode(model: TerminalControlModel): TerminalPaneMode {
  switch (model.phase) {
    case 'loading': return 'loading';
    case 'unknown': return 'unknown';
    case 'controlled': return 'controlled';
    case 'readonly': return 'readonly';
    default: return ownsWrite(model.authoritative) ? 'controlled' : 'readonly';
  }
}

export function terminalControlReducer(
  state: TerminalControlModel,
  event: TerminalControlEvent,
): TerminalControlModel {
  switch (event.type) {
    case 'observe-start':
      return {
        ...state,
        observeEpoch: event.epoch,
        // 盖写判据的快照：这一刻的世界已经含进了哪些写。回来时拿它跟最新的
        // settledWriteEpoch 比，才拦得住「写发起之前发出、写结算之后才回来」的旧
        // poll——那种读数回来时 pending 已经清空，光看 pending 是拦不住的。
        observeIssueEpoch: state.settledWriteEpoch,
        // 首屏才把画面压回 loading；轮询和复核是背景动作，不该让已经settle 的
        // 徽标闪一下，复核更要把 unknown 保持到 GET 真的回来为止。
        phase: event.source === 'load' && !state.pending ? 'loading' : state.phase,
      };

    case 'observe-settled': {
      // 过期观察；或有在途写——它描述的是写之前的世界，写的回执才是新的权威。
      if (event.epoch !== state.observeEpoch || state.pending) return state;
      // 发出之后又有写结算过：这份读数描述的是那次写**之前**的世界，接受它就是把
      // takeover 刚拿到的 controlled 倒写成 readonly（release 方向则是反过来，把已经
      // 还掉的租约倒写成「可输入」）。复核 GET 不在此列——它发出时写已经不在途了，
      // 快照与当前 settledWriteEpoch 相等，照旧放行去收敛 unknown。
      if (state.observeIssueEpoch < state.settledWriteEpoch) return state;
      const downgraded = ownsWrite(state.authoritative) && !ownsWrite(event.control);
      return {
        ...state,
        phase: settledPhase(event.control),
        authoritative: event.control,
        mayWrite: ownsWrite(event.control),
        // 写失败的消息要挺过这次复核：它说的是「你的动作没成」，读数正常并不能
        // 把它反驳掉。观察自己的错误则由这次成功读数清掉。
        error: state.error?.from === 'write' ? state.error : null,
        frameGeneration: state.frameGeneration + (downgraded ? 1 : 0),
      };
    }

    case 'observe-failed': {
      if (event.epoch !== state.observeEpoch || state.pending) return state;
      // 同一条判据：写结算之后才失败回来的旧观察说的是上一个世界，连它的错误文案都
      // 不该盖掉刚落地的写回执（首屏失败时两边都是 0，照旧放行）。
      if (state.observeIssueEpoch < state.settledWriteEpoch) return state;
      const error = { text: event.error, from: 'observe' as const };
      // 从来没读到过权威状态（首屏就失败，daemon 抖一下是典型）。这里**不能**落只读：
      // 租约挂在（会话 × 登录）上，不挂在这块面板上——同一个登录里上一块面板接管过、
      // 这块面板刚挂上来时，服务端那把写租约仍在，前置代理照旧会给这个 iframe 补
      // WRITE grant，也就是说它**真的能打字**。此时说一句「只读」既是没有依据的结论，
      // 又顺手把遮罩取消了（mayWrite=false），等于给可写终端盖了个只读的章。
      // 照实说未知：mayWrite 保持为真，遮罩挡住盲输入，等下一拍轮询或用户手动重试
      // 把它收敛掉。
      if (!state.authoritative) {
        return { ...state, phase: 'unknown', mayWrite: true, error };
      }
      // 已经有过权威读数：一次读失败推翻不了它——尤其不该把「我正握着写租约」改口
      // 成只读。保留原判，把错误说出来，等下一拍轮询自己收敛。
      return { ...state, error };
    }

    case 'settle-readonly':
      // 轮询每 15 秒会重发一次这条（没有凭证的面板压根不发请求），已经落座就别再
      // 造一个新对象出来，白白惊动整棵子树。
      if (state.phase === 'readonly' && state.authoritative?.mode === 'readonly'
        && !state.pending && !state.mayWrite && !state.error) return state;
      return {
        ...state,
        phase: 'readonly',
        authoritative: { mode: 'readonly', owned: false },
        pending: null,
        mayWrite: false,
        error: null,
      };

    case 'write-start':
      return {
        ...state,
        writeEpoch: event.epoch,
        pending: { action: event.action, epoch: event.epoch },
        phase: event.action === 'takeover' ? 'taking-over' : 'releasing',
        // 只要有写在途，这块 iframe 就可能是可写的：takeover 可能已经在服务端生效，
        // release 在回执之前租约还在手上。
        mayWrite: true,
        error: null,
      };

    case 'write-settled': {
      // 只有**更新的写**能作废它——15 秒轮询作废不了（这正是丢结果那条 bug）。
      if (event.epoch !== state.writeEpoch) return state;
      return {
        ...state,
        phase: settledPhase(event.control),
        authoritative: event.control,
        pending: null,
        // 这一刻之前发出的观察全部作废：它们描述的是这次写之前的世界。
        settledWriteEpoch: event.epoch,
        mayWrite: ownsWrite(event.control),
        error: null,
        // 写成功一律换 iframe：新的 grant 只在新的一次加载里生效。
        frameGeneration: state.frameGeneration + 1,
      };
    }

    case 'write-failed': {
      if (event.epoch !== state.writeEpoch) return state;
      return {
        ...state,
        phase: 'unknown',
        pending: null,
        // 失败不代表服务端没生效（超时、断连都可能只丢了回执），所以 mayWrite 保持
        // 为真，遮罩挡住盲输入，等复核 GET 说话。
        mayWrite: true,
        error: { text: event.error, from: 'write' },
        reconcileNonce: state.reconcileNonce + 1,
      };
    }

    default:
      return state;
  }
}

// ─── 外层侧：行内「终端」的打开意图 ─────────────────────────────────────────

/** 面板给外层的回执。外层的行内按钮只认它，不认自己当初递进去的意图——标题栏的
 *  「接管输入 / 释放输入」不经过外层，恒可写身份更是从头到尾没发过任何请求。 */
export interface TerminalPaneControlMode {
  sessionId: string;
  /** 用户眼里的模式（含触屏那层「这条通道到底能不能写」的覆盖）。 */
  mode: TerminalPaneMode;
  /** 恒可写身份（平台所有者）：没有租约可接管 / 可释放，也就没有只读模式可切。 */
  fixed: boolean;
  /** 这块面板切不出第二种模式（触屏只读通道、无 canControl 能力、fixed 身份）。
   *  此时行内按钮只能是开 / 关，拿模式去比会永远不相等、面板再也关不掉。 */
  toggleOnly: boolean;
  /** 有在途写：这一刻行内按钮必须禁用或串行。 */
  busy: boolean;
}

/**
 * 终端面板的完整意图：开在**哪个会话**上，以及面板回执回来的真实模式。两者必须
 * 原子地一起变——拆开写时踩过的坑：先 `selectSession` 把面板迁到 B（压成只读）、
 * 再判断「B 行的终端按钮」→ 迁移后的状态刚好等于只读，于是被判成同按钮二次点击，
 * 面板被关掉。
 *
 * 行内**没有**接管入口（产品决策：接管只走终端面板标题栏的「接管输入」），所以
 * 这里也不再记「这次开带不带接管」——行内点开的终端一律是只读打开。
 */
export interface WorkbenchTerminalIntent {
  sessionId: string;
  mode: TerminalPaneMode;
  fixed: boolean;
  toggleOnly: boolean;
  busy: boolean;
  /** 每换一次模式 +1。面板 key 带上它，切模式才会真的重挂，面板里那个一次性的
   *  开场意图也才有机会重新兑现（只读意图靠它把还攥着的租约真的还回去）。 */
  generation: number;
}

/** 一次新的打开 / 重挂。`mode` 先记成 loading：面板还没说话之前我们**不知道**
 *  它是什么模式，把意图当成模式正是「第二次点击重挂而不是关闭」的来源。 */
export function openTerminalIntent(
  sessionId: string,
  generation = 0,
): WorkbenchTerminalIntent {
  return {
    sessionId,
    mode: 'loading',
    fixed: false,
    toggleOnly: false,
    busy: false,
    generation,
  };
}

/**
 * 普通选中（行点击 / j-k / 路由）：已经开着的面板跟到新会话，但**只跟到只读**。
 * 接管属于「你在那块面板标题栏按下接管」的那个会话，普通选中不是要写权限的表示。
 */
export function followTerminalIntent(
  current: WorkbenchTerminalIntent | null,
  sessionId: string,
): WorkbenchTerminalIntent | null {
  if (!current) return null;
  // 同一个会话内重复选中不动意图：正在接管 A 时点 A 的行，不该把自己的写权限收掉。
  if (current.sessionId === sessionId) return current;
  return openTerminalIntent(sessionId);
}

/**
 * 行内「终端」按钮：选中会话 + 只读打开终端面板的那一次原子更新。
 * 返回 `null` = 关掉面板。
 */
export function toggleTerminalIntent(
  current: WorkbenchTerminalIntent | null,
  sessionId: string,
): WorkbenchTerminalIntent | null {
  // 在途写期间对同一个会话的重复点击一律吞掉（串行）：标题栏刚发出的 takeover /
  // release 还没回执时再点一次，不会在 POST 回来前把面板关掉、留下没人管的写租约。
  if (current && current.busy && current.sessionId === sessionId) return current;
  // 换会话 = 一次全新的打开。这里绝不能先经过「跟随选中」把面板迁过来，迁移后的
  // 状态会让紧接着的判断误以为是同按钮二次点击。
  if (!current || current.sessionId !== sessionId) return openTerminalIntent(sessionId);
  // 切不出第二种模式的面板（恒可写身份 / 触屏只读通道）只有开和关两种结果。
  if (current.toggleOnly) return null;
  // 面板此刻真的可写（标题栏接管过）→ 这一次点「终端」是「降回只读」：重挂一块带
  // 只读意图的面板，把租约真的还回去。已经是只读、或还没有权威读数（loading /
  // unknown）→ 同一个按钮再点一次就是关掉。
  if (current.mode !== 'controlled') return null;
  return openTerminalIntent(sessionId, current.generation + 1);
}

/** 面板回执：把真实模式记回意图。只改回执那几个字段，不动 sessionId /
 *  generation —— 那两个决定面板的 key，被回执带着走就会无谓重挂、终端连接跟着断。 */
export function receiveTerminalIntentMode(
  current: WorkbenchTerminalIntent | null,
  receipt: TerminalPaneControlMode,
): WorkbenchTerminalIntent | null {
  if (!current || current.sessionId !== receipt.sessionId) return current;
  if (current.mode === receipt.mode
    && current.fixed === receipt.fixed
    && current.toggleOnly === receipt.toggleOnly
    && current.busy === receipt.busy) return current;
  return {
    ...current,
    mode: receipt.mode,
    fixed: receipt.fixed,
    toggleOnly: receipt.toggleOnly,
    busy: receipt.busy,
  };
}
