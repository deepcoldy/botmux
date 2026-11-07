/**
 * 决策看板「自动发现可以关的项」：关闭条件 / 依赖 / 复查时间的解析，以及按事实判断一项该给什么提示。
 * 纯函数，不碰磁盘和网络；daemon 的后台巡检（service.sweepHints）先查好 PR 状态，再在存储的写事务里
 * 用这里的 {@link evaluateHints} 对最新的行求值，所以判断和落库之间不会被管家的改动插队。
 *
 * 只提示、不改状态：条件满足时在这一项上标「建议关闭 / 建议推进 / 该看一眼」并记一条历史，
 * 由管家核对后自己改状态。
 */
import type { Locale } from '../../i18n/types.js';
import type { BoardCloseWhen, BoardHint, BoardHintKind, BoardItem, BoardLink, BoardState } from './model.js';

const PR_REF = /^[\w.-]+\/[\w.-]+#\d+$/;

/**
 * `--close-when`：
 *   - `pr:owner/repo#12 merged`（也认 `pr=…`）
 *   - `item:66 done`（也认 `item:#66 done`）
 *   - `manual`：只由管家判断，巡检不提示
 *   - `auto`：去掉显式条件，回到默认（挂了 PR 就按 PR 全部合入判断）
 */
export function parseCloseWhenSpec(raw: string): BoardCloseWhen | 'auto' | { error: string } {
  const value = raw.trim().replace(/\s+/g, ' ');
  const lower = value.toLowerCase();
  if (lower === 'manual') return { kind: 'manual' };
  if (lower === 'auto') return 'auto';
  const pr = /^pr[:=](\S+) merged$/i.exec(value);
  if (pr) {
    if (!PR_REF.test(pr[1]!)) return { error: `PR 要写成 owner/repo#编号：${pr[1]}` };
    return { kind: 'pr', ref: pr[1]! };
  }
  const item = /^item[:=]#?(\d{1,9}) done$/i.exec(value);
  if (item) return { kind: 'item', seq: Number(item[1]) };
  return { error: `--close-when 只认 "pr:owner/repo#12 merged" / "item:66 done" / manual / auto：${raw}` };
}

export function formatCloseWhen(c: BoardCloseWhen): string {
  switch (c.kind) {
    case 'pr': return `pr:${c.ref} merged`;
    case 'item': return `item:${c.seq} done`;
    case 'manual': return 'manual';
  }
}

/** 存储里的 JSON → 关闭条件；格式不对的按没写处理（不让一行坏数据挡住整张看板）。 */
export function closeWhenFromJson(json: string | null | undefined): BoardCloseWhen | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v?.kind === 'manual') return { kind: 'manual' };
    if (v?.kind === 'pr' && typeof v.ref === 'string' && PR_REF.test(v.ref)) return { kind: 'pr', ref: v.ref };
    if (v?.kind === 'item' && Number.isSafeInteger(v.seq) && (v.seq as number) > 0) return { kind: 'item', seq: v.seq as number };
  } catch { /* 坏数据按没写 */ }
  return undefined;
}

/** `--depends-on 66,#70 71`：逗号或空白分隔的编号；`none` 清空。 */
export function parseDependsOnSpec(raw: string): number[] | { error: string } {
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'none') return [];
  const out: number[] = [];
  for (const part of value.split(/[\s,，]+/).filter(Boolean)) {
    const m = /^#?(\d{1,9})$/.exec(part);
    if (!m) return { error: `--depends-on 要写事项编号（如 66,70），不认识：${part}` };
    const seq = Number(m[1]);
    if (seq <= 0) return { error: `--depends-on 的编号从 1 开始：${part}` };
    if (!out.includes(seq)) out.push(seq);
  }
  if (out.length > 32) return { error: '--depends-on 最多 32 项' };
  return out;
}

export function dependsOnFromJson(json: string | null | undefined): number[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return undefined;
    const seqs = v.filter((x): x is number => Number.isSafeInteger(x) && x > 0);
    return seqs.length ? seqs : undefined;
  } catch { return undefined; }
}

const DURATION_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/**
 * `--next-check`：相对时间 `+30m` / `+2h` / `+3d` / `+1w`，或带时区的 ISO 时间
 *（`2026-11-10T09:30+08:00`、`…Z`）；`none` 清空。不收不带时区的写法：daemon 和管家可能不在同一时区。
 */
export function parseNextCheckSpec(raw: string, now: number): number | null | { error: string } {
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'none') return null;
  const rel = /^\+(\d{1,4})\s*([mhdw])$/i.exec(value);
  if (rel) {
    const ms = Number(rel[1]) * DURATION_UNITS[rel[2]!.toLowerCase()]!;
    if (ms <= 0) return { error: '--next-check 要晚于现在' };
    return now + ms;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const at = Date.parse(value);
    // 已经过去的时间写进去永远不会触发（写入本身就把 updated_at 推到了它后面），当成写错拒掉。
    if (Number.isFinite(at)) return at > now ? at : { error: `--next-check 要晚于现在：${raw}` };
  }
  return { error: `--next-check 写相对时间（+2h、+3d）或带时区的时间（2026-11-10T09:30+08:00），none 清空：${raw}` };
}

export type PrMergeState = 'open' | 'merged' | 'closed';

export interface HintFacts {
  now: number;
  locale: Locale;
  /** 查过的 PR 状态；undefined = 这轮没查到（网络、频控、没权限），不据此下结论。 */
  prState(ref: string): PrMergeState | undefined;
  /** 看板上另一项的状态；undefined = 没有这一项。 */
  itemState(seq: number): BoardState | undefined;
}

export interface HintCandidate {
  kind: BoardHintKind;
  key: string;
  reason: string;
}

export interface HintEvaluation {
  /** 按优先级排好：建议关闭 > 建议推进 > 该看一眼。由调用方跳过管家收起过的 key 后取第一个。 */
  candidates: HintCandidate[];
  /** 判断要用的 PR 状态这轮有没查到的：为 true 时调用方保留这一项现有的提示，不清也不换。 */
  unknown: boolean;
}

const ENDED: ReadonlySet<BoardState> = new Set(['done', 'closed']);

export function isEndedState(state: BoardState | undefined): boolean {
  return !!state && ENDED.has(state);
}

/** 这一项判断关闭要看哪些 PR（巡检据此决定查哪些）。 */
export function closePrRefs(item: Pick<BoardItem, 'closeWhen'>, links: readonly BoardLink[]): string[] {
  if (item.closeWhen?.kind === 'manual' || item.closeWhen?.kind === 'item') return [];
  if (item.closeWhen?.kind === 'pr') return [item.closeWhen.ref];
  return [...new Set(links.filter(l => l.kind === 'pr').map(l => l.ref))];
}

function text(locale: Locale, zh: string, en: string): string {
  return locale === 'en' ? en : zh;
}

function seqList(seqs: number[]): string {
  return seqs.map(s => `#${s}`).join('、');
}

/**
 * 一项该给哪些提示。已结束（完成 / 关闭）的项不给。
 *   - 关闭：显式 pr 条件 → 这个 PR 合入；显式 item 条件 → 那一项完成；没写 → 挂的 PR 全部合入；manual → 不判断。
 *   - 推进：依赖都结束了；或判断关闭用的 PR 没合入就被关了（多半要换 PR 或重新评估）。
 *   - 该看一眼：过了复查时间，且那之后这一项没有更新。
 */
export function evaluateHints(
  item: Pick<BoardItem, 'state' | 'closeWhen' | 'dependsOn' | 'nextCheckAt' | 'updatedAt' | 'seq'>,
  links: readonly BoardLink[],
  facts: HintFacts,
): HintEvaluation {
  if (isEndedState(item.state)) return { candidates: [], unknown: false };
  const { locale } = facts;
  const close: HintCandidate[] = [];
  const advance: HintCandidate[] = [];
  let unknown = false;

  const cw = item.closeWhen;
  if (cw?.kind === 'item') {
    const state = cw.seq === item.seq ? undefined : facts.itemState(cw.seq);
    if (state === 'done') {
      close.push({ kind: 'close', key: `close:item:${cw.seq}`, reason: text(locale, `#${cw.seq} 已完成`, `#${cw.seq} is done`) });
    } else if (state === 'closed') {
      advance.push({ kind: 'advance', key: `advance:item-closed:${cw.seq}`,
        reason: text(locale, `关闭条件里的 #${cw.seq} 已关闭（没有完成）`, `#${cw.seq} from the close condition was closed without being done`) });
    }
  } else if (cw?.kind !== 'manual') {
    const refs = closePrRefs(item, links);
    if (refs.length) {
      const states = refs.map(ref => ({ ref, state: facts.prState(ref) }));
      if (states.some(s => s.state === undefined)) {
        unknown = true;
      } else if (states.every(s => s.state === 'merged')) {
        const label = refs.length === 1 ? `PR ${refs[0]}` : text(locale, `关联的 ${refs.length} 个 PR`, `all ${refs.length} linked PRs`);
        close.push({ kind: 'close', key: `close:pr:${[...refs].sort().join(',')}`,
          reason: text(locale, `${label} 已合入`, `${label} ${refs.length === 1 ? 'is' : 'are'} merged`) });
      } else if (states.every(s => s.state !== 'open')) {
        // 都结束了，但有没合入就关掉的：不是「可以关」，是「要重新看」。
        const dropped = states.filter(s => s.state === 'closed').map(s => s.ref).sort();
        advance.push({ kind: 'advance', key: `advance:pr-closed:${dropped.join(',')}`,
          reason: text(locale, `PR ${dropped.join('、')} 没有合入就关闭了`, `PR ${dropped.join(', ')} closed without merging`) });
      }
    }
  }

  const deps = (item.dependsOn ?? []).filter(s => s !== item.seq);
  if (deps.length) {
    const states = deps.map(seq => ({ seq, state: facts.itemState(seq) }));
    // 依赖里有不存在的编号时不下结论（编号写错了，不能当作「都结束了」）。
    if (states.every(s => isEndedState(s.state))) {
      const sorted = [...deps].sort((a, b) => a - b);
      const closed = states.filter(s => s.state === 'closed').map(s => s.seq);
      advance.push({ kind: 'advance', key: `advance:deps:${sorted.join(',')}`,
        reason: closed.length
          ? text(locale, `依赖的 ${seqList(sorted)} 都已结束（${seqList(closed)} 是关闭，不是完成）`,
            `dependencies ${sorted.map(s => `#${s}`).join(', ')} have all ended (${closed.map(s => `#${s}`).join(', ')} closed, not done)`)
          : text(locale, `依赖的 ${seqList(sorted)} 都已完成`, `dependencies ${sorted.map(s => `#${s}`).join(', ')} are all done`) });
    }
  }

  const stale: HintCandidate[] = [];
  if (item.nextCheckAt !== undefined && facts.now >= item.nextCheckAt && item.updatedAt < item.nextCheckAt) {
    stale.push({ kind: 'stale', key: `stale:${item.nextCheckAt}`,
      reason: text(locale, '过了复查时间还没有更新', 'past its next check time with no update') });
  }

  return { candidates: [...close, ...advance, ...stale], unknown };
}

/**
 * 这条提示是不是只靠 PR 状态得出的、且用到的 PR 仍是这一项现在判断关闭要看的那些。PR 这轮查不到时，
 * 只有这类提示可以原样保留；靠依赖、事项条件、复查时间得出的，或 PR 已经换掉的，照常重算。
 */
export function hintRestsOnPrs(key: string, refs: readonly string[]): boolean {
  const m = /^(?:close:pr|advance:pr-closed):(.+)$/.exec(key);
  if (!m) return false;
  return m[1]!.split(',').every(ref => refs.includes(ref));
}

/** 跳过管家收起过的提示，取优先级最高的那个。 */
export function pickHint(evaluation: HintEvaluation, dismissed: readonly string[]): HintCandidate | undefined {
  return evaluation.candidates.find(c => !dismissed.includes(c.key));
}

export function hintFromJson(json: string | null | undefined): BoardHint | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if ((v.kind === 'close' || v.kind === 'advance' || v.kind === 'stale')
      && typeof v.key === 'string' && typeof v.reason === 'string' && typeof v.at === 'number') {
      return { kind: v.kind, key: v.key, reason: v.reason, at: v.at };
    }
  } catch { /* 坏数据按没有提示 */ }
  return undefined;
}

export function keyListFromJson(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** 已通知 / 已收起的 key 只留最近这么多条：一项一辈子的提示不会多，留个上限防坏数据无限长。 */
export const HINT_KEY_HISTORY = 32;

export function appendKey(list: readonly string[], key: string): string[] {
  const next = [...list.filter(k => k !== key), key];
  return next.slice(-HINT_KEY_HISTORY);
}

export const HINT_LABELS: Record<Locale, Record<BoardHintKind, string>> = {
  zh: { close: '建议关闭', advance: '建议推进', stale: '该看一眼' },
  en: { close: 'Suggest closing', advance: 'Suggest moving on', stale: 'Check in' },
};

/** 历史里记的那一句：「建议关闭：PR owner/repo#12 已合入」。 */
export function hintEventText(hint: Pick<BoardHint, 'kind' | 'reason'>, locale: Locale): string {
  return `${HINT_LABELS[locale][hint.kind]}${locale === 'en' ? ': ' : '：'}${hint.reason}`;
}

export interface HintNoticeEntry {
  seq: number;
  title: string;
  hint: Pick<BoardHint, 'kind' | 'reason'>;
  /** 这一项在飞书里打开的链接；没有对外地址时省略。 */
  link?: string;
}

/** 一轮通知里最多逐项列这么多条，其余写「另有 N 项」：通知要短，全量在看板上。 */
export const HINT_NOTICE_MAX_ENTRIES = 20;

/** 管家群里的那一条：横幅 + 逐项一行。也是送进管家会话的正文（会话里另加执行指引）。 */
export function formatHintNotice(entries: readonly HintNoticeEntry[], locale: Locale): string {
  const zh = locale !== 'en';
  const shown = entries.slice(0, HINT_NOTICE_MAX_ENTRIES);
  const head = zh
    ? `【决策看板 · 提示】巡检发现 ${entries.length} 项可能可以推进或关闭（只是提示，状态没改）：`
    : `[Decision board · hint] The board check found ${entries.length} item(s) that may be ready to move on or close (hints only; no state was changed):`;
  const lines = shown.map(e => `#${e.seq} ${e.title.replace(/\s+/g, ' ').trim()} — ${hintEventText(e.hint, locale)}${e.link ? ` ${e.link}` : ''}`);
  const more = entries.length - shown.length;
  if (more > 0) lines.push(zh ? `另有 ${more} 项，见看板。` : `${more} more on the board.`);
  return [head, ...lines].join('\n');
}

/** 送进管家会话的正文：通知 + 按 guide 处理的指引（零注入的管家也能照着做）。 */
export function formatHintPrompt(entries: readonly HintNoticeEntry[], locale: Locale): string {
  const tail = locale === 'en'
    ? 'Follow "Board hints" in `botmux board guide`: verify each item, then change its state with `botmux board set`, or keep it as is with `botmux board set <n> --dismiss-hint`.'
    : '按 `botmux board guide` 里「收到提示」一节处理：逐项核对现状，该改状态的用 `botmux board set` 改；核对后不改的用 `botmux board set <编号> --dismiss-hint` 收起提示。';
  return `${formatHintNotice(entries, locale)}\n\n${tail}`;
}

let hintTurnSeq = 0;

/** 提示回合的 id：`board:<appId>:hint-<round>-<seq>`。worker 按 `board:` 前缀走看板投递协议；批次号解析（纯数字）不会误认它。 */
export function formatHintTurnId(larkAppId: string, round: number): string {
  return `board:${larkAppId}:hint-${round}-${++hintTurnSeq}`;
}

export function parseHintTurnId(turnId: string): { appId: string; round: number; seq?: number } | null {
  const m = /^board:([^:]+):hint-(\d{1,16})(?:-(\d+))?$/.exec(turnId);
  return m ? { appId: m[1]!, round: Number(m[2]), ...(m[3] !== undefined ? { seq: Number(m[3]) } : {}) } : null;
}
