/**
 * mention-reverify.ts — 群消息「@ 晚落定」（mention late resolution）的有界补偿。
 *
 * 背景（2026-11-11 现场取证）：用户在群里 @ 本 bot 时，飞书服务端要在消息发出后
 * ~0.1–3s 才把 mention 解析落定（REST 单条详情：updated=true，update_time ≈
 * create_time + delta）。若 im.message.receive_v1 的 WS 快照先于落定到达，
 * receive 路径的 pre-admission @ 闸会把这条消息当「没 @ 我们」静默忽略（DEBUG 级，
 * 无 WARN、无 triggered 记录）；im.message.updated_v1 的编辑补 @ 救援路径只做
 * **一次** REST 回读，同样可能赶在落定之前——两条路径都漏时，这条 @ 永久丢失
 * （message listener 按设计跳过它识别出的显式 @，不构成兜底）。
 *
 * 本模块只放纯逻辑与进程内登记表；排期与回读编排住在 event-dispatcher 里
 * （需要复用其闭包内的 processMessageEvent / 权威回读 / 幂等闸）：
 *  - contentHasMentionPlaceholder：识别「用户输入过 @」（正文里的 @_user_N 占位符），
 *    作为值得补偿的廉价信号——没打 @ 的普通群聊消息绝不进入补偿，REST 放大有界。
 *  - mentionPlaceholdersSettled：占位符在 mention 落定后**仍留在正文里**（飞书靠它
 *    关联 mentions[]），所以只有「还有占位符没对上已落定的 mentions[] 条目」才值得
 *    回读；@ 了别人的普通消息快照里早已落定，不产生任何回读。
 *  - mentionReverifyEnabled / parseReverifyDelaysMs：总开关与重试节奏（env 可调）。
 *  - acquire/releaseReverifySlot：按 `${larkAppId}:${messageId}` 记账的有界登记表，
 *    同一消息的补偿排期有总量硬上限（防「补偿派发→再被忽略→再补偿」的病态循环），
 *    进程内 pending 容量有上限（防消息风暴撑爆定时器）。
 *
 * 幂等不新增持久化：补派发复用编辑补 @ 的既有幂等（triggered-message-store +
 * pendingMessageTriggers + dispatch 侧 duplicate 检查），seen-store 的 claim 不
 * 重复触发（补偿不走 WS 投递层）。
 */

/** 正文里「用户输入过 @」的占位符形态（text 消息的 text 字段）。 */
const MENTION_PLACEHOLDER_RE = /@_user_\d+/;

export interface MentionReverifyMessageLike {
  content?: string;
  body?: { content?: string };
}

/**
 * 消息正文是否携带 @ 占位符（= 用户输入过 @，只是尚未解析/未指向本 bot）。
 * 兼容 WS 事件形态（content 为 JSON 串）与 REST 行形态（body.content），
 * 以及编辑解包后的纯文本残留。解析失败退回原串匹配，绝不抛出。
 */
export function contentHasMentionPlaceholder(
  message: MentionReverifyMessageLike | null | undefined,
): boolean {
  const raw = message?.content ?? message?.body?.content;
  if (typeof raw !== 'string' || raw.length === 0) return false;
  try {
    const parsed = JSON.parse(raw);
    const text = parsed?.text;
    if (typeof text === 'string') {
      if (MENTION_PLACEHOLDER_RE.test(text)) return true;
      // post 富文本：未解析的 at 节点可能仍带占位符 user_id。
      const inner = parsed?.zh_cn ?? parsed?.en_us ?? parsed;
      if (Array.isArray(inner?.content)) {
        for (const paragraph of inner.content) {
          if (!Array.isArray(paragraph)) continue;
          for (const node of paragraph) {
            if (node?.tag === 'at'
              && typeof node?.user_id === 'string'
              && MENTION_PLACEHOLDER_RE.test(node.user_id)) {
              return true;
            }
          }
        }
      }
      return false;
    }
  } catch { /* 非 JSON 正文：退回原串直接匹配 */ }
  return MENTION_PLACEHOLDER_RE.test(raw);
}

const MENTION_PLACEHOLDER_GLOBAL_RE = /@_user_\d+/g;

function mentionEntryHasIdentity(mention: unknown): boolean {
  const id = (mention as { id?: unknown } | null | undefined)?.id;
  if (typeof id === 'string') return id.trim() !== '';
  if (!id || typeof id !== 'object') return false;
  return ['open_id', 'union_id', 'user_id', 'app_id'].some(field => {
    const value = (id as Record<string, unknown>)[field];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/**
 * 正文里的 @ 占位符是否已全部落定：每个 `@_user_N` 在 mentions[] 里都有同 key、
 * 且带身份（open_id / union_id / user_id / app_id 任一）的条目。正文里没有占位符
 *（从没打 @、编辑时删掉了 @、消息已撤回）同样视为已落定——没有可等的 mention。
 *
 * 调用方已确认「没 @ 本 bot」时，已落定 = @ 的是别人或 @ 已不在正文里：快照与
 * 权威回读据此给出同一个结论，排期入口和回读终止判定共用本函数，两处不会分叉。
 * 兼容 WS 事件形态（mentions[].id 是对象）与 REST 行形态（id 是字符串）。
 */
export function mentionPlaceholdersSettled(
  message: (MentionReverifyMessageLike & { mentions?: unknown }) | null | undefined,
): boolean {
  const raw = message?.content ?? message?.body?.content;
  const keys = new Set(typeof raw === 'string' ? raw.match(MENTION_PLACEHOLDER_GLOBAL_RE) ?? [] : []);
  if (keys.size === 0) return true;
  const mentions: unknown[] = Array.isArray(message?.mentions) ? message.mentions : [];
  for (const key of keys) {
    const settled = mentions.some(mention =>
      (mention as { key?: unknown } | null | undefined)?.key === key && mentionEntryHasIdentity(mention));
    if (!settled) return false;
  }
  return true;
}

/** 默认节奏：覆盖实测 0.1–3s 的落定窗口并留 5 倍余量，总跨度 ~16s。 */
export const DEFAULT_MENTION_REVERIFY_DELAYS_MS: readonly number[] = [2_500, 7_000, 16_000];

/** 总开关：测试版默认开启，BOTMUX_MENTION_REVERIFY=0 关闭。 */
export function mentionReverifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BOTMUX_MENTION_REVERIFY !== '0';
}

/** 解析 BOTMUX_MENTION_REVERIFY_DELAYS_MS（逗号分隔的毫秒）；非法/缺省回落默认。 */
export function parseReverifyDelaysMs(
  raw: string | undefined,
  fallback: readonly number[] = DEFAULT_MENTION_REVERIFY_DELAYS_MS,
): number[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [...fallback];
  const parts = raw
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(ms => Number.isFinite(ms) && ms > 0 && ms <= 60_000);
  if (parts.length === 0) return [...fallback];
  parts.sort((a, b) => a - b);
  return parts.slice(0, 5);
}

/** 同一消息补偿排期的总量硬上限（跨多次排期累计；正常路径一次排期即终结）。 */
export const MENTION_REVERIFY_MAX_SCHEDULES = 6;
/** 进程内同时 pending 的补偿排期上限（消息风暴保险丝）。 */
export const MENTION_REVERIFY_MAX_PENDING = 300;
/** 登记表保留上限（含已完成条目）：长跑进程的内存与扫描有界；只淘汰非 pending 条目。 */
export const MENTION_REVERIFY_MAX_RETAINED = 2000;

export type ReverifyAcquireResult = 'ok' | 'busy' | 'budget-exhausted' | 'capacity-full';

interface ReverifyState {
  /** 历史累计排期次数（防病态循环，跨 pending 生命周期持久到条目被淘汰）。 */
  schedulesUsed: number;
  /** 是否有进行中的排期（含整个重试梯与回读执行窗口；容量按它计）。 */
  pending: boolean;
}

const reverifyStates = new Map<string, ReverifyState>();
let pendingReverifyCount = 0;

/** O(1)：当前进行中的补偿排期数。 */
export function reverifyPendingCount(): number {
  return pendingReverifyCount;
}

/** 有界保留：超限时从最旧开始淘汰**非 pending** 条目（Map 迭代序 = 插入序）。
 * 淘汰会丢掉该 key 的累计预算——可接受：持久幂等闸是 triggered-store，一条
 * 未触发过的旧消息被重新补偿本身是正确行为。 */
function pruneRetained(): void {
  if (reverifyStates.size <= MENTION_REVERIFY_MAX_RETAINED) return;
  for (const [key, state] of reverifyStates) {
    if (reverifyStates.size <= MENTION_REVERIFY_MAX_RETAINED) break;
    if (!state.pending) reverifyStates.delete(key);
  }
}

/**
 * 为一次补偿排期登记。容量闸作用于**每一次** 非 pending→pending 迁移（新 key
 * 与历史 key 的重新排期同样计费），不是只在插入新条目时检查。返回：
 *  - 'ok'：登记成功（schedulesUsed+1、占用一个 pending 名额）；
 *  - 'busy'：该 key 已有进行中的排期（含整个重试梯）；
 *  - 'budget-exhausted'：该 key 累计排期次数已达硬上限（且条目未被淘汰）；
 *  - 'capacity-full'：进程 pending 总量已达上限。
 * 调用方对非 'ok' 一律放弃（可留日志），绝不重试自旋。
 */
export function acquireReverifySlot(key: string): ReverifyAcquireResult {
  const state = reverifyStates.get(key);
  if (state?.pending) return 'busy';
  if (pendingReverifyCount >= MENTION_REVERIFY_MAX_PENDING) return 'capacity-full';
  if (state && state.schedulesUsed >= MENTION_REVERIFY_MAX_SCHEDULES) return 'budget-exhausted';
  const target = state ?? { schedulesUsed: 0, pending: false };
  if (!state) {
    reverifyStates.set(key, target);
    pruneRetained();
  }
  target.pending = true;
  target.schedulesUsed += 1;
  pendingReverifyCount += 1;
  return 'ok';
}

/** 释放 pending 名额（schedulesUsed 保留，作为该 key 的累计预算）。
 * 调用方只在整条重试梯终结（派发/已触发/指向他人/放弃/异常）时调用。 */
export function releaseReverifySlot(key: string): void {
  const state = reverifyStates.get(key);
  if (state?.pending) {
    state.pending = false;
    pendingReverifyCount -= 1;
  }
}

/** Test-only：登记表当前保留条目数（含已完成未淘汰的）。 */
export function _reverifyRetainedCountForTest(): number {
  return reverifyStates.size;
}

/** Test-only：清空登记表。 */
export function _resetReverifyForTest(): void {
  reverifyStates.clear();
  pendingReverifyCount = 0;
}
