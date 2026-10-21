import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLinkDestination } from 'markdown-it/lib/helpers/index.mjs';
import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  PendingAsk,
} from '../../core/ask-types.js';
import { AskDispatchError } from '../../core/ask-types.js';
import { getAskSnapshot, submitAsk, toggleAsk, tryResolveAsk } from '../../core/ask-broker.js';
import { logger } from '../../utils/logger.js';
import { t, localeForBot, type Locale } from '../../i18n/index.js';
import { askOptionLayoutForBot, type AskOptionLayout } from './ask-option-layout.js';
import { replyMessage, sendMessage, sendUserMessage, updateMessage, uploadFile } from './client.js';
import { TRANSIENT_LARK_CODES } from './api-gate.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from './turn-reply-card-size.js';
import { larkCodeFromMessage, structuredLarkCode } from './lark-errors.js';
import { requestGrantForAskClicker } from './ask-grant-request.js';
import { publishReplyCardAsk, replyCardAskCanAct } from '../../core/turn-reply-ask.js';

/** 旧单选即答动作（保留兼容旧卡片回调；Task 5 新增 ask_submit 路径）。 */
export const ASK_SELECT_ACTION = 'ask_select';

/** 新多问 Submit 动作（form 内提交按钮携带此 action）。 */
export const ASK_SUBMIT_ACTION = 'ask_submit';

/** 累积勾选动作。飞书会 silent-drop form + select_static，所以 v0.1.8 用按钮态。 */
export const ASK_TOGGLE_ACTION = 'ask_toggle';

const MAX_BUTTONS_PER_ACTION_ROW = 4;

/** Worst-case placeholder for ask dispatchUuid (ask- + 40 hex = 44 chars,
 * ask-persist-store.ts dispatchUuidForAsk). Used when an ask lacks a real
 * dispatchUuid so the byte budget still reflects the wire payload. */
const ASK_DISPATCH_UUID_WORST_CASE = 'ask-'.padEnd(44, '0');

export interface AskCardActionData {
  context?: { open_message_id?: string };
  open_message_id?: string;
  operator?: { open_id?: string };
  action?: {
    value?: Record<string, unknown>;
    form_value?: Record<string, unknown>;
  };
}

export interface AskCardDispatcherDeps {
  sendMessage?: typeof sendMessage;
  sendUserMessage?: typeof sendUserMessage;
  replyMessage?: typeof replyMessage;
  updateMessage?: typeof updateMessage;
  uploadFile?: typeof uploadFile;
}

/** 点击处理的可注入依赖。目前只有「未授权 → 弹授权卡」这一路（供单测替换）。 */
export interface AskCardActionDeps {
  requestGrant?: typeof requestGrantForAskClicker;
  larkAppId?: string;
}

export function createLarkAskCardDispatcher(
  deps: AskCardDispatcherDeps = {},
): AskCardDispatcher {
  const send = deps.sendMessage ?? sendMessage;
  const sendUser = deps.sendUserMessage ?? sendUserMessage;
  const reply = deps.replyMessage ?? replyMessage;
  const update = deps.updateMessage ?? updateMessage;
  // 惰性取用：只有超预算的卡才需要上传附件。
  const upload: typeof uploadFile = (...args) => (deps.uploadFile ?? uploadFile)(...args);

  return {
    async send(ask) {
      if (ask.chatId.startsWith('doc:') && !ask.deliveryTarget) {
        throw new AskDispatchError('Confirmation card cannot be delivered: document session has no verified recipient', false);
      }
      if (ask.deliveryTarget && (!ask.deliveryTarget.openId.startsWith('ou_')
        || ask.deliveryTarget.openId !== ask.answererOpenId)) {
        throw new AskDispatchError('Confirmation card cannot be delivered: invalid document author', false);
      }
      if (ask.replyCardTarget) {
        try { return { messageId: await publishReplyCardAsk(ask) }; }
        catch (err) {
          const { retryable, detail } = classifyAskDispatchError(err);
          throw new AskDispatchError(detail, retryable);
        }
      }
      const { json: cardJson, promptTruncated } = renderAskCard(ask);
      // botmux 把 chat-scope session 的 routing anchor 也叫 rootMessageId,
      // 但在 chat-scope 下它实际是 chat_id (oc_...) 而非 message_id (om_...).
      // 飞书 /messages/{id}/reply 只接受 om_ — 用 oc_ 会 400 invalid message_id.
      // 所以这里要按前缀判断是否真的能 reply.
      const canReplyToRoot = !ask.deliveryTarget &&
        typeof ask.rootMessageId === 'string' && ask.rootMessageId.startsWith('om_');
      const sendToRecipient = (content: string, type: string, uuid?: string) => ask.deliveryTarget
        ? sendUser(ask.larkAppId, ask.deliveryTarget.openId, content, type, uuid)
        : send(ask.larkAppId, ask.chatId, content, type, uuid);
      // Pass the ask's stable dispatchUuid as the Feishu message uuid so a
      // re-send after a daemon restart (restart-resume) dedupes server-side and
      // returns the ORIGINAL message_id instead of posting a second card.
      const uuid = ask.dispatchUuid;
      try {
        // 问题正文超出整卡 30KB 预算时卡片内只展示截断版，全文先作为附件发出，
        // 让审批人始终能看到完整信息（对齐 turn reply card 的 sendOverflow）。
        // 附件先于卡片发送：瞬时失败整体按同一分类重试，附件 uuid 由 dispatchUuid
        // 派生，重试/重启重发都会被飞书去重；确定性失败（如缺上传权限）不阻断
        // 卡片——宁可只看到截断版，也不能让审批卡整张发不出、被误报「未获确认」。
        if (promptTruncated) {
          try {
            await sendPromptAttachment(ask, upload, (content, fileUuid) => canReplyToRoot
              ? reply(ask.larkAppId, ask.rootMessageId!, content, 'file', true, fileUuid)
              : sendToRecipient(content, 'file', fileUuid));
          } catch (err) {
            if (classifyAskDispatchError(err).retryable) throw err;
            logger.warn(`[ask:${ask.askId}] failed to send full-question attachment; sending truncated card only: ${
              err instanceof Error ? err.message : String(err)}`);
          }
        }
        const messageId = canReplyToRoot
          ? await reply(ask.larkAppId, ask.rootMessageId!, cardJson, 'interactive', true, uuid)
          : await sendToRecipient(cardJson, 'interactive', uuid);
        return { messageId };
      } catch (err) {
        // Re-throw as a typed AskDispatchError so the broker's bounded retry can
        // decide transient-vs-deterministic without importing HTTP types
        // (codex P1-3). The same uuid is reused on retry → server-side dedupe.
        const { retryable, detail } = classifyAskDispatchError(err);
        throw new AskDispatchError(detail, retryable);
      }
    },
    async onSettle(ask, result) {
      if (ask.replyCardTarget) { await publishReplyCardAsk(ask, result); return; }
      if (!ask.cardMessageId) return;
      try {
        await update(ask.larkAppId, ask.cardMessageId, buildAskCard(ask, result));
      } catch (err) {
        logger.warn(
          `[ask:${ask.askId}] failed to patch settled card: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}


/**
 * Classify a Feishu card-send failure into "worth retrying" vs "give up now"
 * (codex P1-3). PURE + exported so the retry decision is unit-tested directly
 * (executable decision seam) rather than asserted against source text.
 *
 * Retryable (transient — a re-send with the same uuid may succeed / dedupe):
 *   - a well-known transient Lark business code (TRANSIENT_LARK_CODES), checked
 *     FIRST so it wins even on an HTTP 400 or a 2xx-body business error
 *   - no HTTP response at all (network reset, DNS, timeout)
 *   - HTTP 429 (rate limited) or any 5xx (server-side)
 * Not retryable (deterministic — re-sending repeats the same failure):
 *   - HTTP 4xx other than 429 (bad request, permission, not found)
 *   - message withdrawn (target gone)
 *   - anything we can't positively classify → fail closed (retry is unsafe when
 *     we can't prove idempotency).
 *
 * Extraction mirrors bot-registry.formatLarkError: status at `response.status`
 * or `.status`; Feishu code at `response.data.code` / `.code` / message tail.
 */
export function classifyAskDispatchError(err: unknown): { retryable: boolean; detail: string } {
  const e = err as {
    isAxiosError?: boolean; name?: string; message?: string;
    response?: { status?: number; data?: { code?: number; msg?: string } };
    status?: number; code?: number; config?: unknown;
  } | null | undefined;

  const detail =
    (e && (e.response?.data?.msg || e.message)) ||
    (typeof err === 'string' ? err : 'unknown dispatch error');

  // A whitelisted transient business code is retryable regardless of HTTP
  // status / error shape (codex P1-3) — check it before the status branches.
  // Structured code first (axios `response.data.code` / top-level `code` /
  // LarkApiError.code), then the `(code: NNN)` tail of `detail`. NOTE the text
  // scanned is `detail` (= `response.data.msg || message`, or the bare string
  // when a string was thrown), NOT api-gate.extractLarkBusinessCode's
  // `err.message` — a deliberate boundary difference kept from the original.
  const larkCode = structuredLarkCode(e) ?? larkCodeFromMessage(typeof detail === 'string' ? detail : '');
  if (larkCode !== undefined && TRANSIENT_LARK_CODES.has(larkCode)) {
    return { retryable: true, detail: `lark code ${larkCode} (transient): ${detail}` };
  }

  const looksAxios =
    !!e && (e.isAxiosError === true || e.name === 'AxiosError' || (!!e.config && (!!e.response || e.status != null)));

  if (looksAxios) {
    const status = e!.response?.status ?? e!.status;
    if (status === undefined) return { retryable: true, detail: `no-response: ${detail}` }; // network/transport
    if (status === 429 || (status >= 500 && status <= 599)) return { retryable: true, detail: `http ${status}: ${detail}` };
    return { retryable: false, detail: `http ${status}: ${detail}` }; // deterministic 4xx
  }

  // Non-axios (plain Error / string) without a transient code. MessageWithdrawn
  // and other `res.code !== 0` 2xx-body throws land here — HTTP already
  // succeeded, so a re-send repeats the same deterministic outcome. Fail closed.
  return { retryable: false, detail: `non-transport: ${detail}` };
}

export function isAskCardAction(action?: string): boolean {
  return action === ASK_SELECT_ACTION || action === ASK_SUBMIT_ACTION || action === ASK_TOGGLE_ACTION;
}

export async function handleAskCardAction(
  data: AskCardActionData,
  deps: AskCardActionDeps = {},
): Promise<{ toast: { type: string; content: string } } | Record<string, unknown> | undefined> {
  const value = data.action?.value;
  const action = asString(value?.action);
  if (!isAskCardAction(action)) return undefined;

  const askId = asString(value?.ask_id);
  const nonce = asString(value?.nonce);
  const by = data.operator?.open_id;
  // Resolve the bot locale from the pending ask (best-effort — a stale/missing
  // ask falls back to the process-default locale).
  const locale = localeForBot(askId ? getAskSnapshot(askId)?.larkAppId : undefined);
  if (!askId || !nonce || !by) {
    return staleToast(locale);
  }
  const pending = getAskSnapshot(askId);
  if (deps.larkAppId && pending && pending.larkAppId !== deps.larkAppId) return staleToast(locale);
  if (pending?.replyCardTarget && !replyCardAskCanAct(pending, data.context?.open_message_id ?? data.open_message_id)) return staleToast(locale);

  /** unauthorized 不再是死胡同：复用对话路径的授权卡向 owner 申请，toast 告诉点击者
   *  「已申请、通过后再点一次」。其余 outcome 原样交给 toastForOutcome。 */
  const outcomeResponse = (outcome: AskClickOutcome) =>
    outcome === 'unauthorized'
      ? escalateUnauthorized(askId, nonce, by, locale, deps)
      : toastForOutcome(outcome, locale);

  // 旧单选即答路径：按钮直接携带 key，调用 tryResolveAsk（单问单选便捷封装）。
  // accepted 时直接返回终态卡片，让飞书在回调响应里同步替换——不依赖 onSettle 异步 PATCH
  // （异步 PATCH 在飞书侧常因回调已返回而被忽略，导致卡片停在未作答态）。
  if (action === ASK_SELECT_ACTION) {
    const selected = asString(value?.key);
    if (!selected) return staleToast(locale);
    const outcome = tryResolveAsk({ askId, nonce, selected, by });
    if (outcome !== 'accepted') return outcomeResponse(outcome);
    return settledCardResponse(askId, {
      kind: 'answered',
      answers: [[selected]],
      by,
      comment: null,
      timedOut: false,
    });
  }

  if (action === ASK_TOGGLE_ACTION) {
    const questionIndex = asNumber(value?.question_index);
    const key = asString(value?.key);
    if (!Number.isInteger(questionIndex) || !key) return staleToast(locale);
    const outcome = toggleAsk({ askId, nonce, questionIndex, key, by });
    if (outcome !== 'toggled') return outcomeResponse(outcome);
    const updated = getAskSnapshot(askId);
    if (!updated) return staleToast(locale);
    if (updated.replyCardTarget) return inlineAskResponse(updated);
    return JSON.parse(buildAskCard(updated)) as Record<string, unknown>;
  }

  // 新 Submit 路径：优先从按钮累积态提交；兼容旧 form_value 回调。
  // 同 ASK_SELECT_ACTION：accepted 时同步返回终态卡片。
  if (action === ASK_SUBMIT_ACTION) {
    // 空提交二次确认标志。飞书按钮 value 回传只可靠保留字符串（对齐 settings-card 的
    // next_value:'true' 与 toggle 的 String(i)），故按字符串判定；同时容忍真布尔，
    // 兼容潜在的非飞书调用方。true = 用户已在 arm 卡片上再点了一次，允许空提交落地。
    const confirmEmpty = value?.confirm_empty === 'true' || value?.confirm_empty === true;
    const formValue = data.action?.form_value ?? {};
    if (Object.keys(formValue).length > 0) {
      // 推断问题数量：找最大 qN 的 N+1
      const questionCount = guessQuestionCount(formValue);
      const selections = parseFormSelections(formValue, questionCount);
      const outcome = submitAsk({ askId, nonce, by, selections, confirmEmpty });
      if (outcome === 'needs_empty_confirm') return armEmptyConfirmResponse(askId, locale);
      if (outcome !== 'accepted') return outcomeResponse(outcome);
      return settledCardResponse(askId, {
        kind: 'answered',
        answers: selections,
        by,
        comment: null,
        timedOut: false,
      });
    }
    // 累积按钮路径。submitAsk 在鉴权 + nonce + 单选约束全过后，若「全多选且全空」返回
    // needs_empty_confirm（防手滑）——空提交二次确认的判定全在 broker 内，卡片不再自行
    // 预检（否则会绕过 nonce/canTalk，且需重复 mixed-question 规则）。
    const outcome = submitAsk({ askId, nonce, by, confirmEmpty });
    if (outcome === 'needs_empty_confirm') return armEmptyConfirmResponse(askId, locale);
    if (outcome !== 'accepted') return outcomeResponse(outcome);
    const updated = getAskSnapshot(askId);
    const answers = updated?.selections ?? updated?.questions.map(() => []) ?? [];
    return settledCardResponse(askId, {
      kind: 'answered',
      answers,
      by,
      comment: null,
      timedOut: false,
    });
  }
  return staleToast(locale);
}

/**
 * 空提交二次确认的卡片响应：重渲染当前 pending ask，arm 一个红色「确认空提交」按钮
 * + 警示条，并附 warning toast。
 *
 * 关键：必须包成 `{ card: { type: 'raw', data } }` —— event-dispatcher 的
 * shapeCardActionResult 认「已整形响应」的标志是顶层 `toast`/`card`/`deferredCard`
 * 之一；若把 card 字段摊在顶层再塞个 toast，它只认 toast、raw card 不会被 patch，
 * 用户只看到 toast、arm 按钮不出现（外层整形契约）。这里同时带 card + toast，二者都生效。
 */
function armEmptyConfirmResponse(askId: string, locale?: Locale): Record<string, unknown> | undefined {
  const ask = getAskSnapshot(askId);
  if (!ask) return staleToast(locale);
  if (ask.replyCardTarget) return {
    ...inlineAskResponse(ask, undefined, true),
    toast: { type: 'warning', content: t('card.ask.toast.empty_confirm_needed', undefined, locale) },
  };
  return {
    card: {
      type: 'raw',
      data: JSON.parse(buildAskCard(ask, undefined, { confirmEmptyArmed: true })) as Record<string, unknown>,
    },
    toast: { type: 'warning', content: t('card.ask.toast.empty_confirm_needed', undefined, locale) },
  };
}

/**
 * 构建 settled 终态卡片响应，让飞书在卡片回调响应里**同步**替换原卡片。
 *
 * 为什么需要这个：ASK_SELECT / ASK_SUBMIT 成功 settle 后，若只返回 `undefined`
 * （toastForOutcome('accepted')），飞书不会原地更新卡片，只能依赖 settle() 里
 * dispatcher.onSettle 异步调 updateMessage 去 PATCH——但异步 PATCH 在飞书侧常因
 * 回调响应已返回而被忽略/时序竞争，导致卡片停在未作答态。
 * 这里直接返回终态卡片 JSON，飞书在同一次回调响应里替换，与 ASK_TOGGLE / grant
 * card 的同步替换路径一致。onSettle 仍保留作兜底（双重更新同内容，幂等无害）。
 */
function settledCardResponse(askId: string, result: AskResult): Record<string, unknown> | undefined {
  const updated = getAskSnapshot(askId);
  if (!updated) return undefined;
  if (updated.replyCardTarget) return inlineAskResponse(updated, result);
  return JSON.parse(buildAskCard(updated, result)) as Record<string, unknown>;
}

function inlineAskResponse(ask: PendingAsk, result?: AskResult, confirmEmptyArmed = false): Record<string, unknown> {
  return { afterAck: async () => { await publishReplyCardAsk(ask, result, confirmEmptyArmed, true); } };
}

/**
 * 构建 ask 卡片 JSON 字符串。
 *
 * 未 settle 时：
 *   - 单问单选：每个选项一个按钮，点击即 settle（旧 ask_select 语义）
 *   - 多问或多选：每个选项一个按钮用于累积勾选，最后用 Submit settle
 *
 * 注意：飞书服务端会 silent-drop `form` 内的 select_static / multi_select_static，
 * 所以这里只使用稳定的 `action` + `button` 结构。
 *
 * 已 settle 时：渲染状态摘要，展示每问的选中标签（answered），或超时/失效信息。
 */
export function buildAskCard(ask: PendingAsk, result?: AskResult, opts?: { confirmEmptyArmed?: boolean }): string {
  return renderAskCard(ask, result, opts).json;
}

/**
 * 按飞书卡片请求体 30KB 上限（与 turn reply card 同一把尺子）渲染 ask 卡：
 * 问题正文默认完整渲染；整卡超预算时把过长的正文统一截到能放下的最大长度并附
 * 「完整内容见附件」，由发送方把全文作为文件发出。纯函数、只依赖 ask 本身，
 * 首发 / 勾选重绘 / settle PATCH 得到一致的截断结果。
 */
export function renderAskCard(
  ask: PendingAsk,
  result?: AskResult,
  opts?: { confirmEmptyArmed?: boolean },
): { json: string; promptTruncated: boolean } {
  const measureUuid = ask.dispatchUuid ?? ASK_DISPATCH_UUID_WORST_CASE;
  const receiveId = ask.deliveryTarget?.openId ?? ask.chatId;
  const full = renderAskCardWithCap(ask, result, opts, Infinity);
  if (turnReplyCardRequestBytes(full, receiveId, measureUuid) <= TURN_REPLY_CARD_MAX_BYTES) {
    return { json: full, promptTruncated: false };
  }
  const longest = Math.max(0, ...ask.questions.map((_, i) => questionPrompt(ask, i).length));
  // 二分出能放进预算的最大单题字符上限（只影响超过该上限的题）。
  let lo = 0;
  let hi = longest;
  let best = renderAskCardWithCap(ask, result, opts, 0);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const json = renderAskCardWithCap(ask, result, opts, mid);
    if (turnReplyCardRequestBytes(json, receiveId, measureUuid) <= TURN_REPLY_CARD_MAX_BYTES) {
      best = json;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // 若正文截到 0 仍超限（如超长选项标签），超限与正文无关，原样返回最小形态。
  return { json: best, promptTruncated: true };
}

/** 未 settle 的文本作答批次会把选项标签并进问题正文展示；settle 后只展示原问题。 */
function questionPrompt(ask: PendingAsk, index: number, settled = false): string {
  const q = ask.questions[index]!;
  const textReplyRequired = ask.questions.some(item => item.inputMode === 'text');
  return !settled && textReplyRequired && q.options.length
    ? `${q.prompt}\n\n${q.options.map(o => o.label).join(' / ')}` : q.prompt;
}

function capPrompt(prompt: string, cap: number, locale?: Locale): string {
  if (prompt.length <= cap) return prompt;
  let head = prompt.slice(0, cap);
  // 不切断 UTF-16 代理对，避免产生孤立代理导致整卡 JSON 非法。
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…\n\n${t('card.ask.prompt_truncated', undefined, locale)}`;
}

/** 完整问题正文（附件内容）。 */
export function askPromptAttachmentText(ask: PendingAsk): string {
  const locale = localeForBot(ask.larkAppId);
  return ask.questions.map((q, i) => {
    const lines = [`## ${t('card.ask.question_n', { n: i + 1 }, locale)}`, '', q.prompt];
    if (q.options.length) lines.push('', ...q.options.map(o => `- ${o.label}`));
    return lines.join('\n');
  }).join('\n\n') + '\n';
}

async function sendPromptAttachment(
  ask: PendingAsk,
  upload: typeof uploadFile,
  deliver: (content: string, uuid: string | undefined) => Promise<string>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-ask-'));
  try {
    const path = join(dir, `ask-${ask.askId.replace(/[^\w-]/g, '_').slice(0, 40)}-question.md`);
    writeFileSync(path, askPromptAttachmentText(ask), { mode: 0o600 });
    const fileKey = await upload(ask.larkAppId, path);
    const uuid = ask.dispatchUuid
      ? `askf_${createHash('sha256').update(ask.dispatchUuid).digest('hex').slice(0, 32)}`
      : undefined;
    await deliver(JSON.stringify({ file_key: fileKey }), uuid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderAskCardWithCap(
  ask: PendingAsk,
  result: AskResult | undefined,
  opts: { confirmEmptyArmed?: boolean } | undefined,
  promptCap: number,
): string {
  const locale = localeForBot(ask.larkAppId);
  const optionLayout = askOptionLayoutForBot(ask.larkAppId);
  const deadline = new Date(ask.deadlineAt).toLocaleString('zh-CN');
  const status = result ? settleStatus(result, ask, locale) : undefined;
  const confirmEmptyArmed = !!opts?.confirmEmptyArmed && !status;

  // 截止时间 + 可答复人 字段行（settled 与 unsettled 均展示）
  const metaDiv = {
    tag: 'div',
    fields: [
      { is_short: true, text: { tag: 'lark_md', content: `**${t('card.ask.field.deadline', undefined, locale)}**\n${escapeMd(deadline)}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**${t('card.ask.field.answerable', undefined, locale)}**\n${approverSummary(ask, locale)}` } },
    ],
  };

  const elements: Array<Record<string, unknown>> = [metaDiv];
  if (ask.deliveryTarget) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text',
      content: t('card.ask.document_origin', {
        document: ask.deliveryTarget.fileToken, comment: ask.deliveryTarget.commentId,
      }, locale),
    }] });
  }

  if (status) {
    // 已 settle：保留原问题内容，再展示状态摘要。审批卡若在点击后
    // 只留下「已选择」，审批人就无法回看自己批准了什么。
    elements.push({ tag: 'hr' });
    for (let i = 0; i < ask.questions.length; i++) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${t('card.ask.question_n', { n: i + 1 }, locale)}**\n${escapeQuestion(capPrompt(questionPrompt(ask, i, true), promptCap, locale))}`,
        },
      });
    }
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: status },
    });
  } else {
    // 未 settle：只用 action/buttons，避免 form+select 被飞书服务端静默丢弃。
    elements.push({ tag: 'hr' });

    const textReplyRequired = ask.questions.some(q => q.inputMode === 'text');
    const requiresSubmit = textReplyRequired || ask.questions.length > 1 || ask.questions.some((q) => q.multiSelect || q.defaultSelectedKeys !== undefined);
    const selections = ask.selections ?? ask.questions.map(() => []);

    for (let i = 0; i < ask.questions.length; i++) {
      const q = ask.questions[i]!;
      const prompt = capPrompt(questionPrompt(ask, i), promptCap, locale);

      // 问题标题。问题正文完整渲染：审批按钮的效力取决于完整信息，展示层截断
      // 会让批准人在信息不全的情况下做决定。空 prompt 已在 ask-api 归一化时以
      // bad_question_shape 拒绝。整卡超飞书 30KB 请求体上限时由 renderAskCard 的
      // 字节预算截断并改由附件承载全文（promptCap 默认 Infinity，即不截断）。
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${t('card.ask.question_n', { n: i + 1 }, locale)}**\n${escapeQuestion(prompt)}`,
        },
      });

      if (textReplyRequired) continue; // A batch with text inputs is answered in conversation.
      const selected = new Set(selections[i] ?? []);
      const optionButtons = q.options.map((opt) => ({
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: requiresSubmit ? optionLabel(q.multiSelect, selected.has(opt.key), opt.label) : opt.label,
        },
        type: selected.has(opt.key) ? 'primary' : 'default',
        value: requiresSubmit
          ? {
              action: ASK_TOGGLE_ACTION,
              ask_id: ask.askId,
              nonce: ask.nonce,
              question_index: String(i),
              key: opt.key,
            }
          : {
              action: ASK_SELECT_ACTION,
              ask_id: ask.askId,
              nonce: ask.nonce,
              key: opt.key,
            },
      }));
      appendActionRows(elements, optionButtons, optionLayout);
    }

    if (requiresSubmit && !textReplyRequired) {
      elements.push({ tag: 'hr' });
      // 空提交二次确认：用户一个选项都没勾就点了提交，且至少有一问是多选（多选允许
      // 「一个都不选」，但极可能是手滑）。第一次拦下来、渲染警示 + 把 Submit 按钮的
      // value 打上 confirm_empty；用户再点一次才真正 settle 空答案。arm 态只活在按钮
      // value 里（随卡片走），broker 不留状态，天然对 daemon 重启幂等。
      if (confirmEmptyArmed) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: t('card.ask.empty_warning', undefined, locale) },
        });
      }
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: confirmEmptyArmed
                ? t('card.ask.submit_confirm_empty', undefined, locale)
                : t('card.ask.submit', undefined, locale),
            },
            type: confirmEmptyArmed ? 'danger' : 'primary',
            value: {
              action: ASK_SUBMIT_ACTION,
              ask_id: ask.askId,
              nonce: ask.nonce,
              // Feishu 按钮 value 只可靠地保留字符串（布尔/数字会被字符串化，见
              // settings-card 的 `next_value:'true'` 约定 + toggle 的 `String(i)`）。
              // 故 arm 标志用字符串 'true'，读取端按字符串判定。
              ...(confirmEmptyArmed ? { confirm_empty: 'true' } : {}),
            },
          },
        ],
      });
    }

    // 自定义回复提示：选项都不满意时，直接在话题里回复一句文字即可当答案。
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: t(ask.deliveryTarget ? 'card.ask.document_reply_hint'
          : ask.originKind === 'native-user-input-async' ? 'card.ask.async_reply_hint'
            : textReplyRequired ? 'card.ask.text_reply_hint' : 'card.ask.custom_reply_hint', undefined, locale) },
      ],
    });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: result ? templateForResult(result) : 'blue',
      title: { tag: 'plain_text', content: result ? t('card.ask.title_done', undefined, locale) : t('card.ask.title', undefined, locale) },
    },
    elements,
  });
}

/**
 * 从 form_value 中推断问题数量（取最大 qN 索引 + 1，最少 1）。
 */
function guessQuestionCount(formValue: Record<string, unknown>): number {
  let max = -1;
  for (const key of Object.keys(formValue)) {
    const m = key.match(/^q(\d+)$/);
    if (m) {
      const idx = parseInt(m[1]!, 10);
      if (idx > max) max = idx;
    }
  }
  return max >= 0 ? max + 1 : 1;
}

/**
 * 防御式解析 Lark form_value，将每个 q<i> 字段的编码选项解析为选中 key 数组。
 *
 * 字段值可能为：
 *  - string[]（multi_select_static 多选）
 *  - string（select_static 单选，或 comma/semicolon 分隔的字符串）
 *
 * 每个编码值格式为 `<questionIndex>::<key>`，只收集 prefix 匹配的条目并剥去前缀。
 * 导出供单元测试直接调用。
 */
export function parseFormSelections(
  formValue: Record<string, unknown>,
  questionCount: number,
): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < questionCount; i++) {
    const raw = formValue[`q${i}`];
    // 规范化为字符串数组
    let tokens: string[];
    if (Array.isArray(raw)) {
      tokens = raw.filter((v): v is string => typeof v === 'string');
    } else if (typeof raw === 'string') {
      // 逗号或分号分隔的备用格式
      tokens = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    } else {
      tokens = [];
    }
    // 筛选出 prefix 匹配 `i::` 的 token，剥去前缀取 key
    const prefix = `${i}::`;
    const keys = tokens
      .filter((t) => t.startsWith(prefix))
      .map((t) => t.slice(prefix.length));
    result.push(keys);
  }
  return result;
}

/**
 * 点击者没有答复权限时，向 owner 弹一张授权卡（复用对话路径那套 grant 卡 + pending 表），
 * 并把 toast 从死胡同「你没有权限」换成「已申请授权，通过后再点一次」。
 *
 * **授权通过后仍需再点一次**：ask 的答案取决于点的是哪个按钮，daemon 无从代替用户决定，
 * 所以不像对话路径那样重放触发消息（ask-grant-request 故意不挂 messageData）。这里
 * 也不动 broker 状态——unauthorized 本来就不改 ask，ask 保持 pending 等着被再点。
 *
 * ask 已失效 / 已 settle / nonce 不匹配时不发卡：授权也救不回一个已结束或不存在的 ask。
 * 这几条正常由 broker 先判（它的门序是 stale → already_settled → unauthorized），这里
 * 再自查一遍是纵深防御——把「不为已决的 ask 骚扰 owner」从对 broker 内部顺序的隐式依赖
 * 变成本函数自己的显式前置条件（pi review F2）。
 */
function escalateUnauthorized(
  askId: string,
  nonce: string,
  clickerOpenId: string,
  locale: Locale | undefined,
  deps: AskCardActionDeps,
): { toast: { type: string; content: string } } {
  const ask = getAskSnapshot(askId);
  if (!ask || ask.settled || ask.nonce !== nonce) return staleToast(locale);
  // A responder lock is not a missing group grant. Never ask the owner to
  // grant a forwarded-card clicker access to the document author's decision.
  if (ask.deliveryTarget) {
    return { toast: { type: 'warning', content: t('card.ask.toast.unauthorized', undefined, locale) } };
  }
  const requestGrant = deps.requestGrant ?? requestGrantForAskClicker;
  const outcome = requestGrant(
    {
      larkAppId: ask.larkAppId,
      chatId: ask.chatId,
      cardMessageId: ask.cardMessageId,
      rootMessageId: ask.rootMessageId,
    },
    clickerOpenId,
  );
  switch (outcome) {
    case 'sent':
      return { toast: { type: 'info', content: t('card.ask.toast.grant_requested', undefined, locale) } };
    case 'pending':
      return { toast: { type: 'info', content: t('card.ask.toast.grant_pending', undefined, locale) } };
    case 'denied':
      // owner 已明确拒绝，还在冷却期 —— 说实话，别谎报「等 owner 处理」。
      return { toast: { type: 'warning', content: t('card.ask.toast.grant_denied', undefined, locale) } };
    case 'unavailable':
      // 发不出授权卡（开放模式无 owner / owner 关了自动发卡）→ 回落原文案。
      return { toast: { type: 'warning', content: t('card.ask.toast.unauthorized', undefined, locale) } };
  }
}

function toastForOutcome(outcome: AskClickOutcome, locale?: Locale): { toast: { type: string; content: string } } | undefined {
  switch (outcome) {
    case 'accepted':
      return undefined;
    case 'unauthorized':
      return { toast: { type: 'warning', content: t('card.ask.toast.unauthorized', undefined, locale) } };
    case 'already_settled':
      return { toast: { type: 'info', content: t('card.ask.toast.already_settled', undefined, locale) } };
    case 'stale':
      return staleToast(locale);
    case 'toggled':
      // 累积勾选，不弹 toast
      return undefined;
    case 'needs_empty_confirm':
      // 正常路径由 handleAskCardAction 提前拦成 arm 卡片响应，不会走到这里；
      // 兜底给个 warning toast，避免静默。
      return { toast: { type: 'warning', content: t('card.ask.toast.empty_confirm_needed', undefined, locale) } };
  }
}

function staleToast(locale?: Locale): { toast: { type: string; content: string } } {
  return { toast: { type: 'warning', content: t('card.ask.toast.stale', undefined, locale) } };
}

/**
 * 生成已结束状态的摘要文本。
 *
 * answered：遍历每个问题，把选中的 key 映射为 label 并渲染。
 * timedOut / invalidated：展示对应说明。
 */
function settleStatus(result: AskResult, ask: PendingAsk, locale?: Locale): string {
  if (result.kind === 'answered') {
    // 自定义回复（替代语义）：没有任何选中项、只有一段自定义文字 → 单独渲染。
    const hasSelection = result.answers.some((keys) => keys.length > 0);
    if (result.comment && !hasSelection) {
      return `**${t('card.ask.custom_reply', undefined, locale)}**\n${escapeMd(result.comment)}\n${t('common.operator', { by: escapeMd(short(result.by, 28)) }, locale)}`;
    }
    // 每问一行：问题N：<选中标签>
    const lines = result.answers.map((keys, i) => {
      const q = ask.questions[i];
      if (!q) return t('card.ask.q_unparseable', { n: i + 1 }, locale);
      const labels = keys.map((key) => q.options.find((o) => o.key === key)?.label ?? key);
      return t('card.ask.q_summary_line', { n: i + 1, labels: labels.join(', ') }, locale);
    });
    const summary = lines.join('\n');
    const commentLine = result.comment ? `\n${t('card.ask.supplement', { comment: escapeMd(result.comment) }, locale)}` : '';
    return `**${t('card.ask.selected', undefined, locale)}**\n${escapeMd(summary)}${commentLine}\n${t('common.operator', { by: escapeMd(short(result.by, 28)) }, locale)}`;
  }
  if (result.kind === 'timedOut') {
    return `**${t('card.ask.timed_out', undefined, locale)}**`;
  }
  const detail = result.failureCode === 'claimant_gone'
    ? t('card.ask.invalidated_claimant_gone', undefined, locale)
    : result.failureCode === 'answer_undelivered'
      ? t('card.ask.invalidated_answer_undelivered', undefined, locale)
      : escapeMd(result.reason);
  return `**${t('card.ask.invalidated', undefined, locale)}**\n${detail}`;
}

function templateForResult(result: AskResult): string {
  switch (result.kind) {
    case 'answered': return 'green';
    case 'timedOut': return 'orange';
    case 'invalidated': return 'grey';
  }
}

function approverSummary(ask: PendingAsk, locale?: Locale): string {
  if (ask.answererOpenId) {
    // XPI can resolve this id from union_id in another app. It is valid for the
    // broker's callback authorization, but embedding it as an at/person card
    // resource can make Lark reject the whole card with 230099. Keep ordinary
    // same-app asks unchanged; only the three XPI origins use a neutral label.
    if (ask.originKind?.startsWith('host_cross_principal_')) {
      return t('card.ask.answerable_designated_member', undefined, locale);
    }
    return `<at id=${ask.answererOpenId}></at>`;
  }
  // 答复权限 = canTalk：谁能在该群跟 bot 说话谁就能答。卡片统一显示「本群可对话成员」，
  // 不再按 open_id 列名单（鉴权在 broker 点击时按 canTalk 判定）。
  return t('card.ask.answerable_talk_members', undefined, locale);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

function optionLabel(multiSelect: boolean, selected: boolean, label: string): string {
  if (multiSelect) return `${selected ? '☑' : '☐'} ${label}`;
  return `${selected ? '◉' : '○'} ${label}`;
}

function appendActionRows(
  elements: Array<Record<string, unknown>>,
  actions: Array<Record<string, unknown>>,
  layout: AskOptionLayout,
): void {
  if (layout === 'vertical') {
    // 竖放：一行一按钮。单列 column_set（flex_mode:'none' + weighted 列宽）让按钮
    // 单列排布，长选项标签不被同排按钮挤压。column_set 在旧版卡片 schema 同样
    // 受支持，无需迁移 schema 2.0。
    for (const action of actions) {
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'small',
        columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [action] }],
      });
    }
    return;
  }
  for (let i = 0; i < actions.length; i += MAX_BUTTONS_PER_ACTION_ROW) {
    elements.push({
      tag: 'action',
      actions: actions.slice(i, i + MAX_BUTTONS_PER_ACTION_ROW),
    });
  }
}

/** Keep labelled web links usable without enabling arbitrary question markup. */
function escapeQuestion(s: string): string {
  let cursor = 0;
  let rendered = '';
  for (const match of s.matchAll(/\[([^\]\r\n]+)\]\(/g)) {
    const start = match.index!;
    if (start < cursor || s[start - 1] === '!') continue;
    const escapes = s.slice(0, start).match(/\\+$/)?.[0].length ?? 0;
    if (escapes % 2) continue;
    const destination = parseLinkDestination(s, start + match[0].length, s.length);
    if (!destination.ok || s[destination.pos] !== ')') continue;
    let url: URL;
    try { url = new URL(destination.str); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    // Parentheses are legal URL characters but must not terminate a Markdown link.
    const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
    rendered += escapeMd(s.slice(cursor, start)) + `[${escapeMd(match[1]!)}](${href})`;
    cursor = destination.pos + 1;
  }
  return rendered + escapeMd(s.slice(cursor));
}

function escapeMd(s: string): string {
  // A mention is structured Lark markup: escaping the underscore in its ID
  // makes the entire card invalid. Keep complete user/bot mentions atomic.
  return s.replace(/<at\s+id=(?:"ou_[\w-]+"|'ou_[\w-]+'|ou_[\w-]+)\s*><\/at>|[*_~`\[\]\\]/g,
    (token) => token.startsWith('<at') ? token : `\\${token}`);
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
