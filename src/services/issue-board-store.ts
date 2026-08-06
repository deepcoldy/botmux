/**
 * Issue Board 本地状态：binding（issue ↔ 本机会话锚点）与 outbox（状态回写发件箱）。
 *
 * 平台侧契约见 platform 仓 DESIGN-issue-board.md §六/§七。那份设计是按 Desktop 写的，
 * Desktop 有 SQLite、能把「建本地任务」和「写 binding」放进**同一个事务**。botmux 没有
 * SQLite（全仓都是 JSON + 原子写），所以这里换一套等价的崩溃安全约定。
 *
 * ## 时序：binding 只能在拿到 anchor 之后写
 *
 * binding 的主键 `anchorId` 是 `chatId` / `rootMessageId`——**建群/发 seed 之后才存在**，
 * 所以不可能「先写 binding 再建群」。实际顺序是：
 *
 *   1. platform claim            → 拿到 claimId / claimEpoch / stateRev
 *   2. 建群（或发无 @ 的 seed）  → 拿到 anchorId。**held**：不传 kickoffBot/kickoffPrompt
 *   3. createBinding(anchorId…)  → 落盘，durable boundary（放在 createGroupWithBots 的
 *                                  `onChatCreated` 同步钩子里写，函数返回前就已持久化）
 *   4. platform bind(localTaskRef) → bindState 转 'bound'
 *   5. kickoff（@bot）→ activate  → daemon 这时才真正起会话
 *
 * ## 崩溃语义：危险窗口在 2→3，靠「held」兜底
 *
 * 「群已建、binding 未写」= **孤儿群**。它比旧叙事里的「binding 有、群没有」难对账，但
 * 危害被第 2 步的 held 挡住了：没发 kickoff 就没有任何 bot 被 @ 起来，daemon 不会创建
 * 会话，**本机没有 agent 在跑**——与旧叙事想要的安全性质相同，只是换了达成方式。
 *
 * 对账要认出孤儿群，就必须留下 claimId→issue 的痕迹（否则 claimId 只活在内存里，崩了既
 * 找不回 claim、也认不出哪个群是它的）。落点要钉在 **claim 成功之后、建群之前**——危险
 * 窗口从 claim 返回的那一刻就开始了，写「建群前」不够精确：claim 已成功而意图未落盘时崩
 * 溃，同样丢 claimId。held 只保证「没有 agent 在跑」，不保证「能对账续跑」，这两件事别混。
 *
 * ⚠️ 这份「claim 意图」存储**本刀还没有**——本模块只含 binding + outbox。拉群领取那一刀
 * 必须补上（存 claimId / issueId / teamId / claimEpoch / stateRev），并把 claimId 同时写进
 * 群名或 seed 正文，形成「本地意图 + 群侧标记」双通道反查。届时的对账策略：
 *  - 有 claim 意图、无 binding → 按 claimId 反查群：找到就补写 binding 续跑，找不到就
 *    释放 claim（或直接等平台 lease 到期由 sweeper 回收）
 *  - 有 binding 且 `bindState==='pending'` → 重试 bind；被平台拒（issue 被回收/别人领走/
 *    代次过期）则置 void 并解散那个 held 群，此刻同样没有 agent 在跑
 *
 * ## 写者不止一个，所以每次 RMW 都要拿锁
 *
 * 曾经这里写着「单写者假设：claim 流程与 outbox pump 都只跑在 dashboard 进程，故不加锁」。
 * **那句话是错的**：`botmux report` 跑在 **agent 的 CLI 子进程**里（见 cli.ts 的 report
 * issue 分支），它照样 enqueue/claim/settle 这两个文件，而发件箱 pump 跑在 **daemon 进程**。
 *
 * 危害不是"字段短暂回退"这么轻。两个文件都是**整份 map/数组重写**：进程 A 读到快照、进程 B
 * 在这期间新建了一条 binding、A 再把自己的快照写回去 —— **B 那条 binding 直接消失**，那个群
 * 与 issue 的关联凭空丢掉，而且全程无声。概率低（要求毫秒级交错），后果不可恢复。
 *
 * 所以所有 RMW 走 `withIssueLock`（[[utils/file-lock]] 的跨进程 advisory lock，与多 daemon
 * 并发写 `bots.json` 同一套）。只读函数不加锁：原子写保证读者要么看到旧的完整文件、要么看到
 * 新的完整文件，不存在半截状态。
 *
 * ⚠️ 锁**不可重入**：加锁的公开函数之间不能互相调用（`settleOutboxRow` 要改 binding，就用
 * 下面的 `updateBindingUnlocked` 而不是 `updateBinding`）。
 *
 * 存储：`{dataDir}/issue-bindings.json`、`{dataDir}/issue-outbox.json`。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { sessionKey } from '../core/types.js';

/**
 * 串行化对 issue board 本地状态的读-改-写。
 *
 * 一把锁覆盖 bindings / outbox / claim-intents 三个文件而不是各锁各的：`enqueueDesiredStatus`
 * 本来就要跨两个文件写（bump 计数器 + 排行），分开锁等于没锁。
 *
 * 3s 上限：这些临界区都是一次读一次写的毫秒级操作，等到 3 秒基本就是持锁进程死了——
 * file-lock 自己会 stale-break，这里超时抛错让调用方看见，好过无限等。
 */
function withIssueLock<T>(dataDir: string, fn: () => T): T {
  return withFileLockSync(join(dataDir, 'issue-board'), fn, { maxWaitMs: 3_000 });
}

/**
 * localTaskRef 的**唯一**构造入口，且 `createBinding` 会自己调它——`CreateBindingInput`
 * 里没有 localTaskRef 字段，调用方**没有**手拼的机会。
 *
 * 之所以做成内生而不是「约定调用方用这个函数」：拼反了顺序不会当场报错，要等平台 bind
 * 记下的 localTaskRef 与崩溃恢复时的重确认对不上，那条 held 会话被判 claim_mismatch 作废
 * 才暴露——离出错点太远。直接复用 botmux 自己的 `sessionKey`，与 activeSessions 键同源。
 */
export function buildLocalTaskRef(anchorId: string, larkAppId: string): string {
  return sessionKey(anchorId, larkAppId);
}

/** 平台 IssueStatus 的线上取值（回写目标只用得到其中一部分，但解析要认全）。 */
export type IssueStatus =
  | 'open'
  | 'claimed'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelling'
  | 'needs_attention'
  | 'reopened';

export type AttentionReason =
  | 'cancel_delivery_timeout'
  | 'claim_activate_timeout'
  | 'task_blocked'
  | 'run_timeout';

/**
 * 一条 issue ↔ 本机会话的绑定。
 *
 * `bindState` 对应 §六 的崩溃恢复分支，外加一个人为终态：
 *  - `pending` ：claim 成功、binding 已落盘，但还没向平台 bind（群可能还没建出来）
 *  - `bound`   ：平台已接受 bind，本地会话可以 activate（发 kickoff @ bot）
 *  - `void`    ：补 bind 被平台拒（issue 被回收 / 别人领走 / 代次过期），这条作废
 *  - `released`：人主动释放（[[issue-release]]），issue 已退回平台待领取池
 *  - `done`    ：人验收通过（`/issue done`），平台已终结这条 issue
 *
 * 三个终态都不再回写，但**不能合并**：`void` 是"平台不认这次领取"，对账见到它要考虑群是不是
 * 白建了；`released` 是"领取本来是好的，人不做了"，群里有正经的工作记录，对账不该去动它；
 * `done` 是"活干完并且验收了"。区分开也让日志能说清一个群到底是怎么结束的。
 *
 * 加终态时只改 `isActiveBindState` 一处——散落的 `!== 'void'` 式判断漏改一处，就会出现
 * 「已结束的 issue 仍被当成本机持有」，而且全程不报错。
 */
export interface IssueBinding {
  /**
   * **路由锚点**——主键，也是平台契约里的「本地任务」标识。
   *
   * 这里必须是 anchor 而**不是** botmux 的 session id：协议要求 bind（带 localTaskRef）
   * 发生在 activate 之前，而 botmux 的会话是 kickoff 消息把 bot @ 起来之后才由 daemon
   * 创建的——bind 那一刻根本还没有 session id。anchor 则在 kickoff 之前就存在：
   *  - 拉群模式 → `chatId`（chat-scope 会话的路由键，建群即得）
   *  - 话题模式 → `rootMessageId`（先发无 @ 的 seed 拿到，再发 threaded kickoff）
   * 见 core/types.ts 的 `sessionAnchorId` / `sessionKey`。
   */
  anchorId: string;
  /** 平台契约的 localTaskRef，取值就是 botmux 自己的 `sessionKey(anchorId, larkAppId)`
   *  = `<anchorId>::<larkAppId>`。复用它而不是另造一套：它本来就是本仓跨 bot 的规范会话
   *  身份，且 `om_`（消息）与 `oc_`（群）两个地址空间不会碰撞。 */
  localTaskRef: string;
  larkAppId: string;
  issueId: string;
  teamId: string;
  /** 绑到哪个平台（换绑/多平台时区分该往哪回写）。 */
  platformBaseUrl: string;
  /** 领取幂等键，必须是高熵随机（禁止由 issueId 派生）。全表唯一。 */
  claimId: string;
  /** 领取代次快照——回写栅栏，旧代次的迟到回写会被平台按 stale_epoch 丢弃。 */
  claimEpoch: number;
  bindState: 'pending' | 'bound' | 'void' | 'released' | 'done';
  /** 会话所在的群。拉群模式下 === anchorId；话题模式下是承载话题的那个群。
   *  崩溃恢复据此复用已建的群而不是再建一个。 */
  chatId?: string;
  /** 会话作用域：拉群 → 'chat'（一群一 issue 一会话）；话题 → 'thread'。 */
  scope: 'chat' | 'thread';
  /** 本 binding 的 sourceSeq 分配计数器：单调、每 binding 唯一，平台的线上幂等只认它。 */
  nextSourceSeq: number;
  /** 已成功回写的状态（离线期间不动——去重合并要拿它和「最新未完成目标」一起比）。 */
  lastSyncedStatus?: IssueStatus;
  /** 上次回写后平台返回的 issue.stateRev，下次状态 CAS 用。 */
  platformStateRev?: number;
  createdAt: number;
  updatedAt: number;
}

export interface IssueOutboxRow {
  /** 仅本地行主键（去重发送用），不上送平台——平台幂等只认 sourceSeq。 */
  writeId: string;
  anchorId: string;
  sourceSeq: number;
  targetStatus: IssueStatus;
  attentionReason?: AttentionReason;
  claimId: string;
  claimEpoch: number;
  expectedStateRev?: number;
  state: 'pending' | 'inflight' | 'done' | 'failed';
  attempts: number;
  nextRetryAt?: number;
  lastError?: string;
  createdAt: number;
}

function bindingsPath(dataDir: string): string {
  return join(dataDir, 'issue-bindings.json');
}
function outboxPath(dataDir: string): string {
  return join(dataDir, 'issue-outbox.json');
}

function readJson<T>(fp: string, fallback: T): T {
  if (!existsSync(fp)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed as T;
  } catch {
    // 文件损坏 → fallback。binding 丢了会让在跑的会话失去 issue 关联（人工 force-detach
    // 兜底），但绝不能因为一个坏文件让整个 daemon 起不来。
  }
  return fallback;
}

// ── bindings ────────────────────────────────────────────────────────────────

export function listBindings(dataDir: string): IssueBinding[] {
  return Object.values(readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {}));
}

export function getBinding(dataDir: string, anchorId: string): IssueBinding | null {
  return readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {})[anchorId] ?? null;
}

/**
 * 这条 binding 是否还代表「本机正持有这个 issue」。
 *
 * 抽成一个谓词而不是到处写 `!== 'void'`：终态从一个变成两个（`void` / `released`）时，
 * 散落各处的判断只要漏改一处，就会出现「已释放的 issue 仍被当成已领取」——重领被拦、
 * 回写继续发，而且全程不报错。加状态就改这一个地方。
 */
export function isActiveBindState(state: IssueBinding['bindState']): boolean {
  return state === 'pending' || state === 'bound';
}

/** 按 claimId 反查——崩溃恢复的入口（§六：不依赖平台「按 claimId 查 issue」的接口，那个接口不存在）。 */
export function findBindingByClaimId(dataDir: string, claimId: string): IssueBinding | null {
  return listBindings(dataDir).find((b) => b.claimId === claimId) ?? null;
}

/** 某 issue 当前在本机的活跃 binding（作废/已释放的不算）。用于「这个 issue 是不是我已经领了」。 */
export function findActiveBindingByIssue(dataDir: string, issueId: string): IssueBinding | null {
  return listBindings(dataDir).find((b) => b.issueId === issueId && isActiveBindState(b.bindState)) ?? null;
}

function writeBindings(dataDir: string, all: Record<string, IssueBinding>): void {
  atomicWriteFileSync(bindingsPath(dataDir), JSON.stringify(all, null, 2) + '\n');
}

// ── claim 意图 ──────────────────────────────────────────────────────────────
//
// 补上文件头点名的那个窗口：**claim 成功之后、建群之前**。
//
// binding 的主键是 anchorId，而 anchor 要建完群才有；在那之前 claimId 只活在内存里。
// 这段时间崩溃 = 平台上有一个已 claim 的 issue，本机却既不知道 claimId、也认不出刚建出来
// 的群属于谁。所以 claim 一返回就先把意图落盘，它是「本机领了这个 issue」的**唯一**持久
// 证据，直到 binding 建立为止。
//
// 双通道反查：本地这份意图 + 群名/seed 正文里带的 claimId。少哪一边都会留下认不出的孤儿。

export interface IssueClaimIntent {
  /** 主键。高熵随机，与平台 claim 用的是同一个值。 */
  claimId: string;
  issueId: string;
  teamId: string;
  claimEpoch: number;
  platformBaseUrl: string;
  /** 平台 claim 返回的 stateRev，后续 bind 的 CAS 基线。 */
  platformStateRev: number;
  /** 这个 issue 交给哪个 bot 跑（决定 localTaskRef 的 appId 段）。 */
  larkAppId: string;
  scope: 'chat' | 'thread';
  /**
   * 建群/发 seed 拿到 anchor 后回填。它出现 = 群已存在，对账时**不要再建一个**。
   * 注意这份回填本身也可能崩在中间，所以对账不能只信它，还要按 claimId 去群里反查。
   */
  anchorId?: string;
  chatId?: string;
  createdAt: number;
  updatedAt: number;
}

function claimIntentsPath(dataDir: string): string {
  return join(dataDir, 'issue-claims.json');
}

function writeClaimIntents(dataDir: string, all: Record<string, IssueClaimIntent>): void {
  atomicWriteFileSync(claimIntentsPath(dataDir), JSON.stringify(all, null, 2) + '\n');
}

export function listClaimIntents(dataDir: string): IssueClaimIntent[] {
  return Object.values(readJson<Record<string, IssueClaimIntent>>(claimIntentsPath(dataDir), {}));
}

export function getClaimIntent(dataDir: string, claimId: string): IssueClaimIntent | null {
  return readJson<Record<string, IssueClaimIntent>>(claimIntentsPath(dataDir), {})[claimId] ?? null;
}

/**
 * 记下一次领取意图。**必须在 platform claim 返回成功后立刻调用，早于任何建群动作**。
 *
 * 同 claimId 重入返回既有记录（claim 本身幂等，重试不该产生第二条意图）。
 */
export function recordClaimIntent(
  dataDir: string,
  input: Omit<IssueClaimIntent, 'createdAt' | 'updatedAt'>,
  now: number = Date.now(),
): IssueClaimIntent {
  return withIssueLock(dataDir, () => {
    const all = readJson<Record<string, IssueClaimIntent>>(claimIntentsPath(dataDir), {});
    const existing = all[input.claimId];
    if (existing) return existing;
    const intent: IssueClaimIntent = { ...input, createdAt: now, updatedAt: now };
    all[intent.claimId] = intent;
    writeClaimIntents(dataDir, all);
    return intent;
  });
}

/** 回填 anchorId / chatId（建群成功后）。 */
export function updateClaimIntent(
  dataDir: string,
  claimId: string,
  patch: Partial<Omit<IssueClaimIntent, 'claimId' | 'createdAt'>>,
  now: number = Date.now(),
): IssueClaimIntent | null {
  return withIssueLock(dataDir, () => {
    const all = readJson<Record<string, IssueClaimIntent>>(claimIntentsPath(dataDir), {});
    const cur = all[claimId];
    if (!cur) return null;
    const next = { ...cur, ...patch, claimId: cur.claimId, createdAt: cur.createdAt, updatedAt: now };
    all[claimId] = next;
    writeClaimIntents(dataDir, all);
    return next;
  });
}

/**
 * 领取流程走完（binding 已 bound）后清掉意图——此后 binding 自己就是完整证据。
 *
 * ⚠️ 清除必须**晚于** binding 落盘。反过来先清意图再写 binding，中间崩溃就同时丢掉了两份
 * 证据，那个群彻底认不回来——这正是意图存在的意义。
 */
export function clearClaimIntent(dataDir: string, claimId: string): boolean {
  return withIssueLock(dataDir, () => {
    const all = readJson<Record<string, IssueClaimIntent>>(claimIntentsPath(dataDir), {});
    if (!all[claimId]) return false;
    delete all[claimId];
    writeClaimIntents(dataDir, all);
    return true;
  });
}

/** 对账分类：意图还在、但没有对应 binding 的，就是需要人/流程接手的悬空领取。 */
export function listDanglingClaimIntents(dataDir: string): IssueClaimIntent[] {
  const bound = new Set(listBindings(dataDir).map((b) => b.claimId));
  return listClaimIntents(dataDir).filter((i) => !bound.has(i.claimId));
}

/** 注意没有 `localTaskRef`：它由 `buildLocalTaskRef(anchorId, larkAppId)` 内生，见上。 */
export type CreateBindingInput = Omit<
  IssueBinding,
  'nextSourceSeq' | 'createdAt' | 'updatedAt' | 'bindState' | 'localTaskRef'
> & { bindState?: IssueBinding['bindState'] };

/**
 * 写入一条 pending binding。**在建群/发 seed 拿到 anchorId 之后调用**——主键就是那个
 * anchor，之前不可能有。放在 `createGroupWithBots` 的 `onChatCreated` 同步钩子里写，
 * 让它成为「群已存在」到「群已归属某个 issue」之间的 durable boundary（见文件头时序）。
 *
 * 两条不变式都在这层强制，不指望调用方自觉：
 *  - **claimId 唯一**：同 claimId 重入直接返回既有行（本地幂等，对应 Desktop 侧的
 *    `UNIQUE(claim_id)`）——领取重试不会产生第二条 binding、也不会重复建群。
 *  - **一 issue 一活跃 binding**：同 issue 已有非 void 的 binding 却拿着不同 claimId 进来，
 *    是调用方漏查（比如没先 `findActiveBindingByIssue`）。此时**抛错**而不是照写——写下去
 *    就是同一个 issue 两个群、两个 agent 同时开工，而平台侧只认最后一次 claim，另一个群
 *    会变成谁也不管的孤儿。抛在这里离原因最近；释放后重领是安全的（旧 binding 已置 void）。
 */
export function createBinding(
  dataDir: string,
  input: CreateBindingInput,
  now: number = Date.now(),
): IssueBinding {
  return withIssueLock(dataDir, () => {
    const all = readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {});
    const existing = Object.values(all).find((b) => b.claimId === input.claimId);
    if (existing) return existing;
    const activeSameIssue = Object.values(all).find(
      (b) => b.issueId === input.issueId && isActiveBindState(b.bindState),
    );
    if (activeSameIssue) {
      throw new Error(
        `issue ${input.issueId} 已有活跃 binding（anchor=${activeSameIssue.anchorId}, claimId=${activeSameIssue.claimId}）；`
        + '重复领取前应先 findActiveBindingByIssue 复用，或释放后再领',
      );
    }
    const binding: IssueBinding = {
      ...input,
      localTaskRef: buildLocalTaskRef(input.anchorId, input.larkAppId),
      bindState: input.bindState ?? 'pending',
      nextSourceSeq: 1,
      createdAt: now,
      updatedAt: now,
    };
    all[binding.anchorId] = binding;
    writeBindings(dataDir, all);
    return binding;
  });
}

/** 局部更新一条 binding（read-modify-write，保住并发写入的其它字段）。 */
export function updateBinding(
  dataDir: string,
  anchorId: string,
  patch: Partial<Omit<IssueBinding, 'anchorId' | 'createdAt'>>,
  now: number = Date.now(),
): IssueBinding | null {
  return withIssueLock(dataDir, () => updateBindingUnlocked(dataDir, anchorId, patch, now));
}

/** 已经持有 issue 锁时用这个——锁不可重入，嵌套调 `updateBinding` 会自己等死自己。 */
function updateBindingUnlocked(
  dataDir: string,
  anchorId: string,
  patch: Partial<Omit<IssueBinding, 'anchorId' | 'createdAt'>>,
  now: number,
): IssueBinding | null {
  const all = readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {});
  const cur = all[anchorId];
  if (!cur) return null;
  const next: IssueBinding = { ...cur, ...patch, anchorId: cur.anchorId, createdAt: cur.createdAt, updatedAt: now };
  all[anchorId] = next;
  writeBindings(dataDir, all);
  return next;
}

/** 删除一条 binding（会话彻底结束且 issue 已终态后清理）。返回是否删掉。 */
export function removeBinding(dataDir: string, anchorId: string): boolean {
  return withIssueLock(dataDir, () => {
    const all = readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {});
    if (!(anchorId in all)) return false;
    delete all[anchorId];
    writeBindings(dataDir, all);
    return true;
  });
}

// ── outbox ──────────────────────────────────────────────────────────────────

function readOutbox(dataDir: string): IssueOutboxRow[] {
  const raw = readJson<IssueOutboxRow[] | Record<string, never>>(outboxPath(dataDir), []);
  return Array.isArray(raw) ? raw : [];
}

function writeOutbox(dataDir: string, rows: IssueOutboxRow[]): void {
  atomicWriteFileSync(outboxPath(dataDir), JSON.stringify(rows, null, 2) + '\n');
}

export function listOutbox(dataDir: string, anchorId?: string): IssueOutboxRow[] {
  const rows = readOutbox(dataDir);
  return anchorId === undefined ? rows : rows.filter((r) => r.anchorId === anchorId);
}

/**
 * 投影一次「本会话应达的 issue 状态」到发件箱（§七 去重合并）。
 *
 * 合并规则（**与最新未完成目标比，不是与 lastSyncedStatus 比**）：
 *  - 该 binding 已有 `pending` 行 → **就地覆盖**它的 targetStatus 并重分配 sourceSeq，不新增行；
 *  - 否则仅当 desired 与「最新目标 ∪ lastSyncedStatus」都不同才排一条新行。
 *
 * 为什么必须这样：离线期间 30s 一次的 tick 会反复投影，若每次都追加，恢复后会把一长串
 * 早已过时的中间态依次发给平台——既刷无效自迁移，又让**最新**状态排在队尾迟迟到不了。
 *
 * 返回排出的行；无需回写时返回 null。
 */
export function enqueueDesiredStatus(
  dataDir: string,
  anchorId: string,
  desired: IssueStatus,
  opts: { attentionReason?: AttentionReason; expectedStateRev?: number } = {},
  now: number = Date.now(),
): IssueOutboxRow | null {
  return withIssueLock(dataDir, () => {
    const bindings = readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {});
    const binding = bindings[anchorId];
    // 终态（void/released）之后不再回写：那个 issue 已经不归本机管了，继续发只会被平台拒。
    // 释放本身也走这里，但它是在 binding 还是 bound 的时候排的行——先排队再改状态，见
    // [[issue-release]] 的「平台先行、本地后写」。
    if (!binding || !isActiveBindState(binding.bindState)) return null;

    const rows = readOutbox(dataDir);
    const mine = rows.filter((r) => r.anchorId === anchorId);
    const pendingIdx = rows.findIndex((r) => r.anchorId === anchorId && r.state === 'pending');
    const latestUnsettled = mine
      .filter((r) => r.state === 'pending' || r.state === 'inflight')
      .sort((a, b) => b.sourceSeq - a.sourceSeq)[0];

    // 已经在追同一个目标（或已经同步到位）→ 无事可做。
    if (pendingIdx < 0) {
      const latestTarget = latestUnsettled?.targetStatus;
      if (desired === latestTarget || (latestTarget === undefined && desired === binding.lastSyncedStatus)) {
        return null;
      }
    } else if (rows[pendingIdx].targetStatus === desired && rows[pendingIdx].attentionReason === opts.attentionReason) {
      return null;
    }

    // 分配序号时取「计数器」与「本 binding 在 outbox 里出现过的最大序号 + 1」的较大者。
    //
    // 写序（见下）已经保证正常路径不会复用序号；这一层是**自愈**：万一计数器因为任何原因
    // 落后于已排出的行（历史遗留数据、外部改文件、未来重构把写序改回去），复用序号的后果是
    // 平台按 `sourceSeq <= lastSourceSeq` 静默 no-op ——**新状态永远上不去且毫无报错**。
    // 这种失败太安静，值得用两行把它变成不可能，而不是只靠写序的正确性来担保。
    // prune 删掉旧的 done 行会让 max 变小，但计数器只增不减，取较大者天然安全。
    const maxSeen = mine.reduce((m, r) => Math.max(m, r.sourceSeq), 0);
    const sourceSeq = Math.max(binding.nextSourceSeq, maxSeen + 1);
    const row: IssueOutboxRow = {
      writeId: randomUUID(),
      anchorId,
      sourceSeq,
      targetStatus: desired,
      ...(opts.attentionReason ? { attentionReason: opts.attentionReason } : {}),
      claimId: binding.claimId,
      claimEpoch: binding.claimEpoch,
      ...(opts.expectedStateRev !== undefined
        ? { expectedStateRev: opts.expectedStateRev }
        : binding.platformStateRev !== undefined
          ? { expectedStateRev: binding.platformStateRev }
          : {}),
      state: 'pending',
      attempts: 0,
      createdAt: now,
    };
    // ⚠️ 写序不能反：**先 bump 计数器落盘，再写 outbox**。
    //
    // 这是两个文件的 RMW，单文件 atomicWrite 保不了跨文件原子性，中间必然存在崩溃窗口。
    // 两种写序的崩溃后果完全不同：
    //  - 先 outbox 后 binding（错）：outbox 已有 seq=N、计数器还停在 N。该行 settle 后
    //    下一次投影会**复用 N**，平台见 `sourceSeq <= lastSourceSeq` 直接 no-op —— 新状态
    //    **永远上不去**，而且一路静默，真机上极难查。
    //  - 先 binding 后 outbox（对）：最坏是 outbox 那条没写成、序号 N 被跳过。平台只要求
    //    单调、不要求连续，跳号无害；丢掉的投影下一拍 tick 会用更大的 seq 重新排出来。
    bindings[anchorId] = { ...binding, nextSourceSeq: sourceSeq + 1, updatedAt: now };
    writeBindings(dataDir, bindings);

    if (pendingIdx >= 0) rows[pendingIdx] = row; // 就地覆盖未发送行
    else rows.push(row);
    writeOutbox(dataDir, rows);
    return row;
  });
}

/**
 * 领取该 binding 的下一条待发行（`pending → inflight` 的 CAS）。
 *
 * **串行**：同一 binding 已有 inflight 行时返回 null——平台侧要求同一 issue 的 sourceSeq
 * 单调到达，并发发送会让顺序乱掉。`nextRetryAt` 未到的行也不返回（退避）。
 */
export function claimNextOutboxRow(
  dataDir: string,
  anchorId: string,
  now: number = Date.now(),
): IssueOutboxRow | null {
  return withIssueLock(dataDir, () => {
    const rows = readOutbox(dataDir);
    const mine = rows.filter((r) => r.anchorId === anchorId);
    if (mine.some((r) => r.state === 'inflight')) return null;
    // 按 sourceSeq 最小的先发，不依赖数组顺序。今天「追加保序 + 就地覆盖」恰好也对，但
    // 一旦以后 prune/compaction 重排数组，按下标取就可能先发高序号再发低序号——平台按
    // 单调判重，低序号那条会被静默丢弃。显式排序把这条契约钉在代码里而不是数组布局上。
    const nextRow = mine
      .filter((r) => r.state === 'pending' && (r.nextRetryAt ?? 0) <= now)
      .sort((a, b) => a.sourceSeq - b.sourceSeq)[0];
    if (!nextRow) return null;
    const idx = rows.findIndex((r) => r.writeId === nextRow.writeId);
    if (idx < 0) return null;
    rows[idx] = { ...rows[idx], state: 'inflight', attempts: rows[idx].attempts + 1 };
    writeOutbox(dataDir, rows);
    return rows[idx];
  });
}

/**
 * 发送成功：标 done，并把平台返回的 stateRev / 已同步状态写回 binding。
 *
 * `applied: false` 用于「这条行不必再发了，但平台**没有**采纳它」——目前只有一种情况：
 * 409 对账发现 claim 已易主。此时**绝不能**写 `lastSyncedStatus`：写了本地就以为
 * "已经是 in_review 了"，下一次交付会走幂等分支直接回成功，而平台上那条压根没变。
 */
export function settleOutboxRow(
  dataDir: string,
  writeId: string,
  result: { platformStateRev?: number; platformLastSourceSeq?: number; applied?: boolean },
  now: number = Date.now(),
): void {
  withIssueLock(dataDir, () => {
    const rows = readOutbox(dataDir);
    const idx = rows.findIndex((r) => r.writeId === writeId);
    if (idx < 0) return;
    const row = rows[idx];
    rows[idx] = { ...row, state: 'done' };
    writeOutbox(dataDir, rows);
    const binding = getBinding(dataDir, row.anchorId);
    // 用平台回传的 `claim.lastSourceSeq` 校准本地计数器。
    //
    // 平台才是「已应用到哪一号」的权威：它按 `sourceSeq <= lastSourceSeq` 判重，本地计数器
    // 一旦落后（dataDir 从旧快照恢复、文件被外部改、其它路径抢跑过序号），之后每一条回写都
    // 会被静默丢弃——平台回 200、本地记成功、状态却永远上不去。真机 e2e 里就撞到过这一幕。
    //
    // 单写者假设下计数器本该恒领先，所以这只是兜底；但代价是一次 max()，而漏掉的代价是
    // 无声的状态停更，值得。
    const syncedSeq =
      result.platformLastSourceSeq !== undefined && binding
        ? Math.max(binding.nextSourceSeq, result.platformLastSourceSeq + 1)
        : undefined;
    updateBindingUnlocked(
      dataDir,
      row.anchorId,
      {
        ...(result.applied === false ? {} : { lastSyncedStatus: row.targetStatus }),
        ...(result.platformStateRev !== undefined ? { platformStateRev: result.platformStateRev } : {}),
        ...(syncedSeq !== undefined && syncedSeq !== binding?.nextSourceSeq ? { nextSourceSeq: syncedSeq } : {}),
      },
      now,
    );
  });
}

/** 发送失败：退回 pending + 指数退避（上限 5min）。`fatal` 用于平台明确拒绝、重试无意义的情况。 */
export function failOutboxRow(
  dataDir: string,
  writeId: string,
  error: string,
  opts: { fatal?: boolean } = {},
  now: number = Date.now(),
): void {
  withIssueLock(dataDir, () => {
    const rows = readOutbox(dataDir);
    const idx = rows.findIndex((r) => r.writeId === writeId);
    if (idx < 0) return;
    const row = rows[idx];
    const backoff = Math.min(1_000 * 2 ** Math.max(0, row.attempts - 1), 5 * 60_000);
    rows[idx] = {
      ...row,
      state: opts.fatal ? 'failed' : 'pending',
      lastError: error.slice(0, 500),
      ...(opts.fatal ? {} : { nextRetryAt: now + backoff }),
    };
    writeOutbox(dataDir, rows);
  });
}

/**
 * 启动对账：把本机所有 `inflight` 退回 `pending`。
 *
 * 进程在「标 inflight 后、记录响应前」崩溃时，那一行会永远停在 inflight 并**堵死该
 * binding 的串行 pump**（claimNextOutboxRow 见到 inflight 就返回 null）。平台侧的
 * sourceSeq 单调 + 终态幂等保证重复投递是安全的，所以无脑退回即可，不需要发送租约。
 *
 * 返回被退回的行数。
 */
export function resetInflightToPending(dataDir: string): number {
  return withIssueLock(dataDir, () => {
    const rows = readOutbox(dataDir);
    let n = 0;
    const next = rows.map((r) => {
      if (r.state !== 'inflight') return r;
      n += 1;
      return { ...r, state: 'pending' as const };
  });
  if (n > 0) writeOutbox(dataDir, next);
  return n;
  });
}

/** 清理已完成的发件箱行（保留最近 `keep` 条便于排查）。返回清掉的行数。 */
export function pruneOutbox(dataDir: string, keep = 50): number {
  return withIssueLock(dataDir, () => {
    const rows = readOutbox(dataDir);
    const settled = rows.filter((r) => r.state === 'done');
    if (settled.length <= keep) return 0;
    const drop = new Set(
      settled.sort((a, b) => a.createdAt - b.createdAt).slice(0, settled.length - keep).map((r) => r.writeId),
    );
    writeOutbox(dataDir, rows.filter((r) => !drop.has(r.writeId)));
    return drop.size;
  });
}
