/**
 * 决策看板写群关联时核实群：用本机 bot 的凭据查 `GET im/v1/chats/:chat_id`，先管家 bot 自己，
 * 查不到再依次试本机其他 bot（分小批并发，按顺序取第一个查到的）。
 *
 * 这里只编排「按什么顺序、试到什么时候为止」和报错怎么写；真正发请求的 {@link ChatProbe} 由 daemon
 * 用各 bot 的凭据在进程内存里建（见 daemon.ts）。凭据不经过这里：报错只带 appId 和飞书返回的
 * 错误码 / 原因，不带请求、响应头或任何密钥。
 */

import { TRANSIENT_LARK_CODES } from '../../im/lark/api-gate.js';

/** 一个 bot 的查群能力。appId 只用来写报错。 */
export interface ChatProbe {
  appId: string;
  /** 返回飞书的响应体 `{ code, msg, data }`；网络错误、超时等直接抛。 */
  fetchChat(chatId: string, signal: AbortSignal): Promise<{ code?: unknown; msg?: unknown; data?: { name?: unknown } }>;
}

export interface ChatProbeFailure {
  appId: string;
  /** 飞书错误码；网络错误 / 超时没有。 */
  code?: number;
  reason: string;
}

export type ChatLookupResult =
  | { ok: true; chatId: string; appId: string; name?: string }
  | { ok: false; chatId: string; failures: ChatProbeFailure[]; timedOut: boolean };

/**
 * 「群确实不存在」的证据：open_chat_id 非法或不存在（99992356，真机实测原文）、invalid chat_id（232006）。
 * 只有拿到这类码，才能把已核实的群降成未核实。232011 / 230002（这个 bot 不在群里）、频控等暂态码、
 * 超时和网络错误都只说明「这次没核实成」，不证明群没了。
 *
 * 只服务看板写群关联前的核实，在这里局部定义：不要挪进 error-classify 的 PERMANENT_TARGET_CODES
 *（轮询熔断专用）或 api-gate 的 TRANSIENT_LARK_CODES（发送侧重试专用），那两张表会驱动别的行为。
 */
export const CHAT_NOT_FOUND_CODES: ReadonlySet<number> = new Set([99992356, 232006]);

export interface ChatLookupOptions {
  /** 管家 bot 之后，其他 bot 每批并发几个。 */
  batchSize?: number;
  /** 单次请求的超时。 */
  perCallTimeoutMs?: number;
  /** 一次核实的总时长上限：到点还没查到就按查不到处理（CLI 那头在等）。 */
  totalTimeoutMs?: number;
  /**
   * 绝对截止时间（毫秒时间戳）。一条命令里几个群共用一份预算时由调用方传入；和 totalTimeoutMs 取先到的。
   * 已经过了就一个 bot 都不试，直接按超时返回。
   */
  deadline?: number;
}

const DEFAULTS = { batchSize: 6, perCallTimeoutMs: 5_000, totalTimeoutMs: 20_000 } as const;

/** 飞书的错误说明常带一长串示例和文档指引：只留第一句，再限长，报错里几十个 bot 归并后仍能读。 */
function shortReason(text: string): string {
  const first = text.split(/(?<=[.。])\s/)[0]!.trim();
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

function failureFrom(appId: string, error: unknown, aborted: boolean): ChatProbeFailure {
  // SDK 对非 2xx 抛 AxiosError，飞书的错误码在响应体里；只取 code / msg，不带请求配置。
  const body = (error as { response?: { data?: { code?: unknown; msg?: unknown } } } | undefined)?.response?.data;
  if (body && typeof body.code === 'number') {
    return { appId, code: body.code, reason: typeof body.msg === 'string' && body.msg ? shortReason(body.msg) : `code ${body.code}` };
  }
  if (aborted) return { appId, reason: 'timeout' };
  const message = error instanceof Error ? error.message : String(error);
  return { appId, reason: shortReason(message.split('\n')[0]!) || 'request failed' };
}

/** 单次查群：超时或 `cancel` 被触发（同批排在前面的 bot 已经查到）时中止请求并立即返回。 */
async function probeOnce(probe: ChatProbe, chatId: string, timeoutMs: number, cancel: AbortSignal):
  Promise<{ ok: true; name?: string } | { ok: false; failure: ChatProbeFailure }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCancel: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
    onCancel = () => {
      controller.abort();
      reject(new Error('cancelled'));
    };
    if (cancel.aborted) onCancel();
    else cancel.addEventListener('abort', onCancel, { once: true });
  });
  try {
    const res = await Promise.race([probe.fetchChat(chatId, controller.signal), timeout]);
    const code = typeof res?.code === 'number' ? res.code : Number.NaN;
    if (code === 0) {
      const name = typeof res.data?.name === 'string' ? res.data.name.trim() : '';
      return { ok: true, ...(name ? { name } : {}) };
    }
    const msg = typeof res?.msg === 'string' && res.msg ? shortReason(res.msg) : `code ${String(res?.code)}`;
    return { ok: false, failure: { appId: probe.appId, ...(Number.isFinite(code) ? { code } : {}), reason: msg } };
  } catch (error) {
    return { ok: false, failure: failureFrom(probe.appId, error, controller.signal.aborted) };
  } finally {
    if (timer) clearTimeout(timer);
    if (onCancel) cancel.removeEventListener('abort', onCancel);
  }
}

/**
 * probes[0] 是管家 bot，先单独试；查不到再把其余的按 batchSize 一批批并发试，同一批里按 probes
 * 顺序取第一个查到的：排在前面的都已失败、当前这个查到了就立即返回，并中止同批其余请求，不等
 * 最慢的那个超时。总时长到点就停（还没轮到的 bot 不再试）。
 */
export async function lookupChatAcrossBots(chatId: string, probes: readonly ChatProbe[], options: ChatLookupOptions = {}): Promise<ChatLookupResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULTS.batchSize);
  const perCall = Math.max(1, options.perCallTimeoutMs ?? DEFAULTS.perCallTimeoutMs);
  const deadline = Math.min(Date.now() + Math.max(1, options.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs), options.deadline ?? Infinity);
  const failures: ChatProbeFailure[] = [];
  const batches: ChatProbe[][] = [];
  if (probes.length) batches.push([probes[0]!]);
  for (let i = 1; i < probes.length; i += batchSize) batches.push(probes.slice(i, i + batchSize));
  for (const batch of batches) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, chatId, failures, timedOut: true };
    const cancel = new AbortController();
    const pending = batch.map(p => probeOnce(p, chatId, Math.min(perCall, left), cancel.signal));
    for (let i = 0; i < batch.length; i++) {
      const r = await pending[i]!;
      if (r.ok) {
        cancel.abort();
        return { ok: true, chatId, appId: batch[i]!.appId, ...(r.name ? { name: r.name } : {}) };
      }
      failures.push(r.failure);
    }
  }
  return { ok: false, chatId, failures, timedOut: false };
}

/**
 * 查不到的结果里有没有「群确实不存在」的证据（{@link CHAT_NOT_FOUND_CODES}）：任一 bot 报了就算，与顺序、
 * 是不是管家无关。查到了的结果（ok）由编排层保证压倒同次的这类码，不会走到这里。
 */
export function lookupProvesChatNotFound(result: Extract<ChatLookupResult, { ok: false }>): boolean {
  return result.failures.some(f => f.code !== undefined && CHAT_NOT_FOUND_CODES.has(f.code));
}

/**
 * 这次没查到只是暂时的：每个失败都是超时 / 网络错误（没有飞书错误码）或飞书的暂态码（频控、正在发送等，
 * 只读引用 api-gate 的 TRANSIENT_LARK_CODES）。只用来给报错分层（「稍后重试」还是「核对群 ID」），
 * 不参与降级判定。
 */
export function isTransientLookupFailure(result: Extract<ChatLookupResult, { ok: false }>): boolean {
  return result.failures.every(f => f.code === undefined || TRANSIENT_LARK_CODES.has(f.code));
}

function failureText(f: ChatProbeFailure): string {
  return f.code !== undefined ? `${f.code} ${f.reason}` : f.reason;
}

/**
 * 查不到时给管家看的报错：管家 bot 的原因单列，其余 bot 按原因归并计数（本机可能有几十个 bot，
 * 逐个列出没法读）。最后写清楚怎么处理。
 */
export function formatChatLookupFailure(result: Extract<ChatLookupResult, { ok: false }>, stewardAppId: string): string {
  const lines = [`没能核实群 ${result.chatId}${result.timedOut ? '（核实超时，没试完本机所有 bot）' : ''}：`];
  const own = result.failures.find(f => f.appId === stewardAppId);
  lines.push(`  - 管家 bot ${stewardAppId}：${own ? failureText(own) : '没有试到'}`);
  const others = result.failures.filter(f => f.appId !== stewardAppId);
  if (others.length) {
    const grouped = new Map<string, number>();
    for (const f of others) grouped.set(failureText(f), (grouped.get(failureText(f)) ?? 0) + 1);
    const parts = [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([text, n]) => `${text} ×${n}`);
    const rest = grouped.size > 4 ? `；另有 ${grouped.size - 4} 种原因` : '';
    lines.push(`  - 本机其他 ${others.length} 个 bot：${parts.join('；')}${rest}`);
  } else if (!result.timedOut) {
    lines.push('  - 本机没有其他可用的 bot');
  }
  lines.push(isTransientLookupFailure(result)
    ? '查群暂时失败（超时、网络错误或飞书频控），群 ID 不一定有问题：稍后重试。'
      + '确实要先写上：加 --allow-unverified-chat，看板上会标「未核实」。'
    : '先核对群 ID（群设置里的群 ID，或群链接里 oc_ 开头的那段），并确认本机有 bot 在这个群里。'
      + '确实要先写上：加 --allow-unverified-chat，看板上会标「未核实」。');
  return lines.join('\n');
}

/**
 * 一条命令里有几个群查不到时的报错：前 maxExpanded 个群按 {@link formatChatLookupFailure} 展开，其余只列
 * 群 ID 和个数——一项最多挂 32 个群，全展开有上百行，管家读不完。
 */
export function formatChatLookupFailures(
  results: ReadonlyArray<Extract<ChatLookupResult, { ok: false }>>,
  stewardAppId: string,
  maxExpanded = 3,
): string {
  const shown = results.slice(0, maxExpanded).map(r => formatChatLookupFailure(r, stewardAppId));
  const rest = results.slice(maxExpanded).map(r => r.chatId);
  if (rest.length) {
    const ids = rest.length > 10 ? `${rest.slice(0, 10).join('、')} 等` : rest.join('、');
    shown.push(`另有 ${rest.length} 个群也没能核实：${ids}`);
  }
  return shown.join('\n');
}
