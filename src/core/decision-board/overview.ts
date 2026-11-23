/**
 * 决策看板的「总览」和父子任务（树形关联）：纯函数，不碰磁盘、网络和 DOM。daemon（CLI 输出、写入时的校验）
 * 和 Dashboard 页面共用，所以这里只 type-import，不引任何会拉进服务端代码的模块。
 *
 * 父子和依赖是两回事：
 *   - 父子（`--parent`）：「它是我的一部分」——大任务拆成几步，每步挂在大任务下面；子任务都结束了，大任务可以收尾。
 *   - 依赖（`--depends-on`）：「等它先做完」——别的事项结束之后这一项才能往下走。
 * 所以一项不能依赖自己的上级（上级要等它结束才收尾，互相等）。
 *
 * 总览只看没结束的事项，按「最该看的在最上面」分组（见 {@link OVERVIEW_GROUPS}）；一棵树整体放在它里面
 * 最该看的那一项所在的组，树内按同样的规则排。
 */
import type { BoardState } from './model.js';

/** 一棵树最多几层（顶层算第 1 层）。再深在手机侧栏里缩进放不下，也说明该拆成几棵树。 */
export const BOARD_TREE_MAX_DEPTH = 6;

/** 多久没有任何更新算「很久没动」。 */
export const BOARD_STALE_MS = 3 * 86_400_000;

const ENDED: ReadonlySet<BoardState> = new Set(['done', 'closed']);
const isEnded = (state: BoardState): boolean => ENDED.has(state);
const isAsking = (state: BoardState): boolean => state === 'decide' || state === 'accept';

/** `--parent 12` / `#12` 挂到 #12 下面；`none` 取消。 */
export function parseParentSpec(raw: string): number | null | { error: string } {
  const value = raw.trim();
  if (value.toLowerCase() === 'none') return null;
  const m = /^#?(\d{1,9})$/.exec(value);
  if (!m || Number(m[1]) <= 0) return { error: `--parent 要写上级事项的编号（如 12），取消写 none：${raw}` };
  return Number(m[1]);
}

// ─── 树 ─────────────────────────────────────────────────────────────────────

export interface TreeNodeInput {
  seq: number;
  parentSeq?: number;
}

/**
 * 每一项实际的上级：上级要在这批事项里、不是自己；万一数据里有环（旧构建、手工改库），从编号小的开始沿上级
 * 往上走，走回走过的项就把那一项的上级断开，让它当顶层——展示时不会死循环，也不丢项。
 */
export function effectiveParents(items: readonly TreeNodeInput[]): Map<number, number> {
  const seqs = new Set(items.map(i => i.seq));
  const parentOf = new Map<number, number>();
  for (const i of items) {
    if (i.parentSeq !== undefined && i.parentSeq !== i.seq && seqs.has(i.parentSeq)) parentOf.set(i.seq, i.parentSeq);
  }
  for (const start of [...parentOf.keys()].sort((a, b) => a - b)) {
    const seen = new Set<number>();
    let cur: number | undefined = start;
    while (cur !== undefined && parentOf.has(cur)) {
      if (seen.has(cur)) { parentOf.delete(cur); break; }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return parentOf;
}

function childrenIndex(parentOf: ReadonlyMap<number, number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [child, parent] of parentOf) out.set(parent, [...(out.get(parent) ?? []), child]);
  return out;
}

/**
 * 每一项连同它所有子孙里最晚的一次进展（own：每项自己的最近进展）。大任务拆成子任务以后，推进都发生在子任务上，
 * 大任务这一项自己很少被改——按它自己的时间算，每个在推进的大任务三天后都会被标成「很久没动」。
 */
export function subtreeLatest(items: readonly TreeNodeInput[], own: ReadonlyMap<number, number>): Map<number, number> {
  const parentOf = effectiveParents(items);
  const out = new Map<number, number>(items.map(i => [i.seq, own.get(i.seq) ?? 0]));
  // 每一项把自己的时间往上传给所有祖先（effectiveParents 已经断了环，往上走一定到头）。
  for (const i of items) {
    const t = own.get(i.seq) ?? 0;
    for (let p = parentOf.get(i.seq); p !== undefined; p = parentOf.get(p)) {
      if ((out.get(p) ?? 0) < t) out.set(p, t);
    }
  }
  return out;
}

/** 直接子任务的完成情况：完成（done）、关闭（closed，不做了）都算结束。 */
export interface ChildStats {
  total: number;
  done: number;
  closed: number;
}

/** 每一项直接子任务的完成情况（只数直接子任务；多层时每层各数各的）。没有子任务的项不在结果里。 */
export function boardChildStats(items: ReadonlyArray<TreeNodeInput & { state: BoardState }>): Map<number, ChildStats> {
  const bySeq = new Map(items.map(i => [i.seq, i]));
  const out = new Map<number, ChildStats>();
  for (const [child, parent] of effectiveParents(items)) {
    const stats = out.get(parent) ?? { total: 0, done: 0, closed: 0 };
    stats.total += 1;
    const state = bySeq.get(child)!.state;
    if (state === 'done') stats.done += 1;
    if (state === 'closed') stats.closed += 1;
    out.set(parent, stats);
  }
  return out;
}

/** 子任务都结束了（至少有一个子任务），而这一项自己还没结束：可以收尾了。 */
export function readyToWrapUp(item: { state: BoardState; childStats?: ChildStats }): boolean {
  const s = item.childStats;
  return !!s && s.total > 0 && s.done + s.closed === s.total && !isEnded(item.state);
}

/**
 * 列表视图（待你拍板 / 进行中 / 全部）按树显示：顶层按服务端给的顺序；上级也在这份列表里的，排在上级后面、
 * 缩进一级（同一个上级下按服务端顺序）。上级不在列表里的（被筛掉、或在别的视图）照常放顶层，由调用方标出属于谁。
 */
export function nestBoardList<T extends TreeNodeInput>(items: readonly T[]): Array<{ item: T; depth: number }> {
  const parentOf = effectiveParents(items);
  const kids = childrenIndex(parentOf);
  const order = new Map(items.map((i, n) => [i.seq, n]));
  const bySeq = new Map(items.map(i => [i.seq, i]));
  const out: Array<{ item: T; depth: number }> = [];
  const visit = (seq: number, depth: number) => {
    out.push({ item: bySeq.get(seq)!, depth });
    const children = [...(kids.get(seq) ?? [])].sort((a, b) => order.get(a)! - order.get(b)!);
    for (const c of children) visit(c, depth + 1);
  };
  for (const i of items) if (!parentOf.has(i.seq)) visit(i.seq, 0);
  return out;
}

// ─── 在等谁 ───────────────────────────────────────────────────────────────────

export type BoardWaitingOn =
  | { kind: 'owner'; what: 'decide' | 'accept' }
  | { kind: 'steward'; what: 'execute' | 'work' }
  | { kind: 'external'; who?: string };

export interface WaitingInput {
  state: BoardState;
  pendingDecisions: number;
  /** 管家写的「在等谁」（`--waiting-on`）。 */
  waitingOn?: string;
  stage?: string;
}

/**
 * 这一项在等谁（按顺序取第一条成立的）：
 *   - 你提交了决定、管家还没标执行：等管家执行；
 *   - 待拍板 / 待验收：等你；
 *   - 管家写了 `--waiting-on`：就是它（外部的人、PR 作者、评审群……）；
 *   - 等待中、没写等谁：等外部（有阶段就用阶段，如「等作者」）；
 *   - 其余（进行中）：管家在推进。
 */
export function boardWaitingOn(item: WaitingInput): BoardWaitingOn {
  if (item.pendingDecisions > 0) return { kind: 'steward', what: 'execute' };
  if (isAsking(item.state)) return { kind: 'owner', what: item.state === 'accept' ? 'accept' : 'decide' };
  const who = item.waitingOn?.trim();
  if (who) return { kind: 'external', who };
  if (item.state === 'waiting') return { kind: 'external', ...(item.stage?.trim() ? { who: item.stage.trim() } : {}) };
  return { kind: 'steward', what: 'work' };
}

// ─── 总览 ─────────────────────────────────────────────────────────────────────

/**
 * 总览的分组，按这个顺序从上到下：
 *   1. needs_you：要你拍板 / 验收（你提交了决定、管家还没执行的不算）；
 *   2. overdue：过了复查时间（`--next-check`）；
 *   3. stalled：超过 3 天没有任何更新、也没约复查时间——最容易跟丢的；
 *   4. active：进行中（最近有动静）；
 *   5. waiting：等待中（最近有动静、没约复查时间）；
 *   6. parked：暂时搁置——约了以后的复查时间，到点前不用管（到点进 overdue）。
 */
export const OVERVIEW_GROUPS = ['needs_you', 'overdue', 'stalled', 'active', 'waiting', 'parked'] as const;
export type OverviewGroup = typeof OVERVIEW_GROUPS[number];

export interface OverviewInput extends TreeNodeInput, WaitingInput {
  title: string;
  stateAt: number;
  updatedAt: number;
  createdAt: number;
  nextCheckAt?: number;
  /**
   * 最近一次有人（管家或你）动过这一项或它的子孙的时间（服务端按历史和更新时间算好，有子任务的取子树里最晚的）；
   * 旧 daemon 不给。用来判断很久没动。
   */
  lastActivityAt?: number;
  /** 同上，只看这一项自己；复查时间之后有没有动过按它算（和巡检的「该看一眼」同一口径）。旧 daemon 不给（按 lastActivityAt）。 */
  ownActivityAt?: number;
}

/** 最近一次进展：历史里最后一条人写的记录、字段更新、建项时间里最晚的那个。 */
export function boardLastActivity(item: Pick<OverviewInput, 'lastActivityAt' | 'updatedAt' | 'createdAt'>): number {
  return Math.max(item.lastActivityAt ?? 0, item.updatedAt, item.createdAt);
}

/**
 * 复查时间的状态（和巡检的「该看一眼」同一口径）：
 *   - none：没约；
 *   - later：约在以后（暂时搁置）；
 *   - due：到点了，而且那之后没有任何进展；
 *   - passed：到点了，但那之后有进展（管家看过、写了进展，只是没重设复查时间）——按没约复查时间处理，不一直挂在
 *     「过了复查时间」里。
 */
export type BoardCheckStatus = 'none' | 'later' | 'due' | 'passed';

export function boardCheckStatus(item: Pick<OverviewInput, 'nextCheckAt' | 'lastActivityAt' | 'ownActivityAt' | 'updatedAt' | 'createdAt'>, now: number): BoardCheckStatus {
  if (item.nextCheckAt === undefined) return 'none';
  if (item.nextCheckAt > now) return 'later';
  // 复查约在这一项上：子任务有进展不算这一项被看过。
  const own = Math.max(item.ownActivityAt ?? item.lastActivityAt ?? 0, item.updatedAt, item.createdAt);
  return own > item.nextCheckAt ? 'passed' : 'due';
}

/** 很久没动：没约以后的复查时间（没约、或到点后有过进展），且超过 3 天没有任何进展。已结束的不算。 */
export function boardIdleTooLong(item: Pick<OverviewInput, 'state' | 'nextCheckAt' | 'lastActivityAt' | 'ownActivityAt' | 'updatedAt' | 'createdAt'>, now: number): boolean {
  const check = boardCheckStatus(item, now);
  return !isEnded(item.state) && (check === 'none' || check === 'passed') && now - boardLastActivity(item) >= BOARD_STALE_MS;
}

/** 没结束的一项在总览里归哪一组（已结束的返回 undefined）。 */
export function boardOverviewGroup(item: OverviewInput, now: number): OverviewGroup | undefined {
  if (isEnded(item.state)) return undefined;
  if (isAsking(item.state) && item.pendingDecisions === 0) return 'needs_you';
  const check = boardCheckStatus(item, now);
  if (check === 'due') return 'overdue';
  if (check === 'later') return 'parked';
  if (boardIdleTooLong(item, now)) return 'stalled';
  return item.state === 'waiting' ? 'waiting' : 'active';
}

/**
 * 总览顶上那一排的计数：每一项按它自己的组数，和它所在的树被放进哪一段无关（一项过了复查时间、但它所在的树因为别的
 * 子任务排在「要你拍板」里，这一项照样算进「过了复查时间」）。
 */
export function overviewGroupCounts(items: readonly OverviewInput[], now: number): Map<OverviewGroup, number> {
  const out = new Map<OverviewGroup, number>();
  for (const i of items) {
    const g = boardOverviewGroup(i, now);
    if (g) out.set(g, (out.get(g) ?? 0) + 1);
  }
  return new Map(OVERVIEW_GROUPS.filter(g => out.has(g)).map(g => [g, out.get(g)!]));
}

/** 同一组里谁先：等得最久 / 过期最久 / 最久没动的在前；搁置的按复查时间先到的在前。 */
function groupMetric(item: OverviewInput, group: OverviewGroup): number {
  switch (group) {
    case 'needs_you': return item.stateAt;
    case 'overdue':
    case 'parked': return item.nextCheckAt ?? Number.MAX_SAFE_INTEGER;
    default: return boardLastActivity(item);
  }
}

export interface OverviewRow<T> {
  item: T;
  /** 在树里第几层（顶层 0）。 */
  depth: number;
  /** 这一项自己的组；已结束、只是作为没结束的子任务的上级显示出来时为 undefined。 */
  group?: OverviewGroup;
}

export interface OverviewSection<T> {
  group: OverviewGroup;
  rows: Array<OverviewRow<T>>;
  /** 这一组里自己就属于这一组的项数（同一棵树里别的组的项只是跟着显示）。 */
  count: number;
}

interface Rank { rank: number; metric: number; seq: number }

const cmpRank = (a: Rank, b: Rank): number => a.rank - b.rank || a.metric - b.metric || a.seq - b.seq;

/**
 * 总览：没结束的事项按树分组排好。一棵树放在它里面最该看的那一项所在的组；树里只列没结束的项，以及没结束的
 * 子任务的已结束上级（灰着显示，保住层级）。同一层兄弟之间也按「最该看的在前」排。
 */
export function buildBoardOverview<T extends OverviewInput>(items: readonly T[], now: number): Array<OverviewSection<T>> {
  const bySeq = new Map(items.map(i => [i.seq, i]));
  const parentOf = effectiveParents(items);
  const kids = childrenIndex(parentOf);
  const own = new Map<number, OverviewGroup | undefined>(items.map(i => [i.seq, boardOverviewGroup(i, now)]));
  // 每一项连同子树里最该看的那一项（没有没结束的项时为 undefined）。
  const best = new Map<number, Rank | undefined>();
  const bestOf = (seq: number): Rank | undefined => {
    if (best.has(seq)) return best.get(seq);
    best.set(seq, undefined);
    const item = bySeq.get(seq)!;
    const group = own.get(seq);
    let top: Rank | undefined = group
      ? { rank: OVERVIEW_GROUPS.indexOf(group), metric: groupMetric(item, group), seq }
      : undefined;
    for (const c of kids.get(seq) ?? []) {
      const r = bestOf(c);
      if (r && (!top || cmpRank(r, top) < 0)) top = r;
    }
    best.set(seq, top);
    return top;
  };
  const sections = new Map<OverviewGroup, { roots: Array<{ seq: number; rank: Rank }> }>();
  for (const i of items) {
    if (parentOf.has(i.seq)) continue;
    const rank = bestOf(i.seq);
    if (!rank) continue;
    const group = OVERVIEW_GROUPS[rank.rank]!;
    const s = sections.get(group) ?? { roots: [] };
    s.roots.push({ seq: i.seq, rank });
    sections.set(group, s);
  }
  const out: Array<OverviewSection<T>> = [];
  for (const group of OVERVIEW_GROUPS) {
    const s = sections.get(group);
    if (!s) continue;
    const rows: Array<OverviewRow<T>> = [];
    const visit = (seq: number, depth: number) => {
      const g = own.get(seq);
      rows.push({ item: bySeq.get(seq)!, depth, ...(g ? { group: g } : {}) });
      const children = (kids.get(seq) ?? [])
        .map(c => ({ seq: c, rank: bestOf(c) }))
        .filter((c): c is { seq: number; rank: Rank } => !!c.rank)
        .sort((a, b) => cmpRank(a.rank, b.rank));
      for (const c of children) visit(c.seq, depth + 1);
    };
    for (const root of s.roots.sort((a, b) => cmpRank(a.rank, b.rank))) visit(root.seq, 0);
    out.push({ group, rows, count: rows.filter(r => r.group === group).length });
  }
  return out;
}
