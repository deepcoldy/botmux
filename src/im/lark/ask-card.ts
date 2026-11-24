import { hasAskForm } from '../../core/ask-form.js';
import { renderAskFormBody } from './ask-form-elements.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  PendingAsk,
} from '../../core/ask-types.js';
import { AskDispatchError } from '../../core/ask-types.js';
import { applyAskForm, getAskSnapshot, submitAsk, submitAskChoices, submitAskForm, toggleAsk, tryResolveAsk } from '../../core/ask-broker.js';
import { askChoiceProblem } from '../../core/ask-choice.js';
import { logger } from '../../utils/logger.js';
import { t, localeForBot, type Locale } from '../../i18n/index.js';
import {
  ASK_CARD_ELEMENT_LIMIT, ASK_DENSITIES, askCardConfig, askFooter, askPresentation, askReplyHint, buildAskChoiceBody, buildAskListBody,
  buildAskSettledBody, countCardElements, deadlineLine, escapeMd, escapeQuestion, pendingHeader, settledHeader, submittedByLine,
  type AskDensity,
} from './ask-card-look.js';
import { formValueTypes, parseAskChoiceFormValue } from './ask-choice-form.js';
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

/** 旧 Card 1.0 的累积勾选动作；输入表单使用独立 Card 2.0 提交。 */
export const ASK_TOGGLE_ACTION = 'ask_toggle';
export const ASK_FORM_ACTION = 'ask_form_submit';

/** One submit for a whole checker form: every checker (`opt_<i>_<j>`) and own-answer input
 *  (`custom_<i>`) arrives in `form_value`. A new action name, so a daemon that predates it
 *  ignores the click instead of reading it as an older submit. */
export const ASK_CHOICE_SUBMIT_ACTION = 'ask_choice_submit';

import { parseAskCustomFields, supportsAskCustomInput } from '../../core/ask-custom-input.js';
import { permissionAskSettleStatus } from './ask-permission-status.js';

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
      const { json: cardJson, promptTruncated, descriptionsTruncated, fits } = renderAskCard(ask);
      // botmux 把 chat-scope session 的 routing anchor 也叫 rootMessageId,
      // 但在 chat-scope 下它实际是 chat_id (oc_...) 而非 message_id (om_...).
      // 飞书 /messages/{id}/reply 只接受 om_ — 用 oc_ 会 400 invalid message_id.
      // 所以这里要按前缀判断是否真的能 reply.
      const replyRoot = ask.cardRootMessageId ?? ask.rootMessageId;
      const canReplyToRoot = !ask.deliveryTarget &&
        typeof replyRoot === 'string' && replyRoot.startsWith('om_');
      const sendToRecipient = (content: string, type: string, uuid?: string) => ask.deliveryTarget
        ? sendUser(ask.larkAppId, ask.deliveryTarget.openId, content, type, uuid)
        : send(ask.larkAppId, ask.chatId, content, type, uuid);
      // Pass the ask's stable dispatchUuid as the Feishu message uuid so a
      // re-send after a daemon restart (restart-resume) dedupes server-side and
      // returns the ORIGINAL message_id instead of posting a second card.
      const uuid = ask.dispatchUuid;
      const truncated = promptTruncated || descriptionsTruncated;
      const sendAttachment = () => sendPromptAttachment(ask, upload, (content, fileUuid) => canReplyToRoot
        ? reply(ask.larkAppId, replyRoot!, content, 'file', true, fileUuid)
        : sendToRecipient(content, 'file', fileUuid));
      const attachmentFailed = (err: unknown) => logger.warn(`[ask:${ask.askId}] failed to send full-question attachment; sending truncated card only: ${
        err instanceof Error ? err.message : String(err)}`);
      try {
        // 问题正文或选项说明超出整卡 30KB 预算时卡片内只展示截断版，全文先作为附件发出，
        // 让审批人始终能看到完整信息（对齐 turn reply card 的 sendOverflow）。
        // 附件先于卡片发送：瞬时失败整体按同一分类重试，附件 uuid 由 dispatchUuid
        // 派生，重试/重启重发都会被飞书去重；确定性失败（如缺上传权限）不阻断
        // 卡片——宁可只看到截断版，也不能让审批卡整张发不出、被误报「未获确认」。
        if (truncated && fits) {
          try { await sendAttachment(); } catch (err) {
            if (classifyAskDispatchError(err).retryable) throw err;
            attachmentFailed(err);
          }
        }
        const messageId = canReplyToRoot
          ? await reply(ask.larkAppId, replyRoot!, cardJson, 'interactive', true, uuid)
          : await sendToRecipient(cardJson, 'interactive', uuid);
        // 截到最小仍超预算的卡大概率被飞书拒收：附件改在卡片送达后发，避免话题里只留下一个孤立文件；
        // 此时卡片已送达，附件失败只记日志。
        if (truncated && !fits) await sendAttachment().catch(attachmentFailed);
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
  return action === ASK_SELECT_ACTION || action === ASK_SUBMIT_ACTION || action === ASK_TOGGLE_ACTION || action === ASK_FORM_ACTION
    || action === ASK_CHOICE_SUBMIT_ACTION;
}

/** A draft is kept only when the card that shows it still fits a reply / card request. */
function askDraftFits(draft: PendingAsk): boolean {
  return turnReplyCardRequestBytes(buildAskCard(draft), draft.deliveryTarget?.openId ?? draft.chatId,
    draft.dispatchUuid ?? ASK_DISPATCH_UUID_WORST_CASE) <= TURN_REPLY_CARD_MAX_BYTES - (draft.replyCardTarget ? 4000 : 0);
}

/** Says which question breaks which rule; the card and the user's ticks stay as they are. */
function choiceProblemToast(
  questions: PendingAsk['questions'], selections: ReadonlyArray<ReadonlyArray<string>>, texts: ReadonlyArray<string | null>, locale: Locale,
): { toast: { type: string; content: string } } | undefined {
  const problem = askChoiceProblem(questions, selections, texts);
  if (!problem) return undefined;
  const key = problem.kind === 'too_many' ? 'card.ask.toast.too_many' : 'card.ask.toast.unanswered';
  return { toast: { type: 'warning', content: t(key, { n: problem.questionIndex + 1 }, locale) } };
}

function unreadableFormToast(askId: string, fieldTypes: Record<string, string>, locale: Locale): { toast: { type: string; content: string } } {
  logger.warn(`[ask:${askId}] submitted form has an option field of unknown shape; nothing was answered: ${JSON.stringify(fieldTypes)}`);
  return { toast: { type: 'warning', content: t('card.ask.toast.unreadable', undefined, locale) } };
}

/** Input form: turn ticked checkers / dropdown picks into the `q<i>` values the form validator reads. */
function inputFormValues(ask: PendingAsk, formValue: unknown): ReturnType<typeof parseAskChoiceFormValue> | { kind: 'values'; values: Record<string, unknown>; selections: string[][] } {
  const parsed = parseAskChoiceFormValue(ask.questions, formValue);
  if (parsed.kind !== 'ok') return parsed;
  const values = { ...parsed.fields };
  ask.questions.forEach((q, i) => {
    if (q.input || Object.hasOwn(values, `q${i}`)) return; // an older select_static card sends q<i> itself
    const keys = parsed.selections[i]!;
    values[`q${i}`] = q.multiSelect || keys.length !== 1 ? keys : keys[0];
  });
  return { kind: 'values', values, selections: parsed.selections };
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
    outcome === 'unauthorized' && (!pending?.answererOpenId || pending.answererOpenId === by)
      ? escalateUnauthorized(askId, nonce, by, locale, deps)
      : toastForOutcome(outcome, locale);

  if (action === ASK_FORM_ACTION) {
    const read = pending && hasAskForm(pending.questions) ? inputFormValues(pending, data.action?.form_value) : undefined;
    if (read?.kind === 'stale') return staleToast(locale);
    if (read?.kind === 'unreadable') return unreadableFormToast(askId, read.fieldTypes, locale);
    const outcome = submitAskForm({ askId, nonce, by, values: read?.kind === 'values' ? read.values : data.action?.form_value });
    if (outcome === 'invalid_form' && pending && read?.kind === 'values') {
      const answered = choiceProblemToast(pending.questions, read.selections, pending.questions.map(q => q.input ? 'input' : null), locale);
      if (answered) return answered;
    }
    if (outcome !== 'accepted') return outcomeResponse(outcome);
    const result = getAskSnapshot(askId)?.result;
    return result ? settledCardResponse(askId, result) : undefined;
  }
  // Stale controls from another presentation cannot reset a user's form draft.
  if (pending && hasAskForm(pending.questions)) return staleToast(locale);
  if (action === ASK_CHOICE_SUBMIT_ACTION) {
    if (!pending) return staleToast(locale);
    const formValue = data.action?.form_value;
    const read = parseAskChoiceFormValue(pending.questions, formValue);
    if (read.kind === 'stale') return staleToast(locale);
    if (read.kind === 'unreadable') return unreadableFormToast(askId, read.fieldTypes, locale);
    if (!read.sawChoiceField && pending.questions.some(q => q.options.length)) {
      // Unticked checkers may legitimately be left out; a form that never carries any is the
      // unverified wire shape going wrong. Field names and types only, never the values.
      logger.warn(`[ask:${askId}] choice form submitted without any option field: ${JSON.stringify(formValueTypes(formValue))}`);
    }
    const outcome = submitAskChoices({ askId, nonce, by, selections: read.selections, fields: read.fields,
      revision: asNumber(value?.revision), confirmEmpty: value?.confirm_empty === 'true' || value?.confirm_empty === true,
      canRenderDraft: askDraftFits });
    if (outcome === 'accepted') {
      const result = getAskSnapshot(askId)?.result;
      return result ? settledCardResponse(askId, result) : undefined;
    }
    if (outcome === 'needs_empty_confirm') return armEmptyConfirmResponse(askId, locale);
    if (outcome === 'draft_conflict') {
      const current = getAskSnapshot(askId);
      if (current) return refreshedDraftResponse(current, locale, true);
    }
    if (outcome === 'invalid_choice') {
      const texts = supportsAskCustomInput(pending) ? parseAskCustomFields(read.fields, pending.questions) ?? [] : [];
      return choiceProblemToast(pending.questions, read.selections, texts, locale) ?? toastForOutcome(outcome, locale);
    }
    return outcomeResponse(outcome);
  }
  if (value?.custom_form === 'v1' && (action === ASK_TOGGLE_ACTION || action === ASK_SUBMIT_ACTION)) {
    const outcome = applyAskForm({ askId, nonce, by, revision: asNumber(value.revision),
      fields: data.action?.form_value ?? {},
      canRenderDraft: askDraftFits,
      ...(action === ASK_TOGGLE_ACTION ? { toggle: { questionIndex: asNumber(value.question_index), key: asString(value.key) ?? '', custom: value.custom_choice === 'true' } } : {}),
      confirmEmpty: value.confirm_empty === 'true',
    });
    if (outcome === 'needs_empty_confirm') return armEmptyConfirmResponse(askId, locale);
    const updated = getAskSnapshot(askId);
    if (outcome === 'accepted') return settledCardResponse(askId, updated?.result!);
    if ((outcome === 'toggled' || outcome === 'draft_conflict') && updated) {
      return refreshedDraftResponse(updated, locale, outcome === 'draft_conflict');
    }
    if (outcome === 'invalid_custom') return { toast: { type: 'warning', content: t('card.ask.toast.invalid_custom', undefined, locale) } };
    return outcomeResponse(outcome);
  }

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
    const outcome = pending && supportsAskCustomInput(pending)
      ? applyAskForm({ askId, nonce, by, revision: 0, fields: {}, toggle: { questionIndex, key },
        canRenderDraft: draft => turnReplyCardRequestBytes(buildAskCard(draft), draft.chatId, draft.dispatchUuid)
          <= TURN_REPLY_CARD_MAX_BYTES - (draft.replyCardTarget ? 4000 : 0) })
      : toggleAsk({ askId, nonce, questionIndex, key, by });
    if (outcome === 'draft_conflict') {
      const current = getAskSnapshot(askId);
      if (current) return refreshedDraftResponse(current, locale, true);
    }
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

function refreshedDraftResponse(ask: PendingAsk, locale: Locale, conflict = false): Record<string, unknown> {
  const response = ask.replyCardTarget ? inlineAskResponse(ask)
    : { card: { type: 'raw', data: JSON.parse(buildAskCard(ask)) } };
  return { ...response, ...(conflict ? { toast: {
    type: 'warning', content: t('card.ask.toast.draft_conflict', undefined, locale),
  } } : {}) };
}

function inlineAskResponse(ask: PendingAsk, result?: AskResult, confirmEmptyArmed = false): Record<string, unknown> {
  return { afterAck: async () => { await publishReplyCardAsk(ask, result, confirmEmptyArmed, true); } };
}

/**
 * 构建 ask 卡片 JSON 字符串（Card JSON 2.0）。
 *
 * 未 settle：每问一个灰底分区（题型小字、问题、选项行、可选的「自己写答案」输入框），整张卡一个
 * form、一个「提交」按钮，勾选只在客户端本地生效；单问单选且无自填、无预选的卡保留「点一下即提交」。
 * 已 settle：保留每问的题型、问题与作答（✓ 选项 / 自填内容 / 输入值），审批人仍能回看问了什么、答了什么。
 */
export function buildAskCard(ask: PendingAsk, result?: AskResult, opts?: { confirmEmptyArmed?: boolean }): string {
  return renderAskCard(ask, result, opts).json;
}

/**
 * 按飞书卡片请求体 30KB 上限（与 turn reply card 同一把尺子）与 Card 2.0 每卡 200 个元素的上限渲染 ask 卡：
 * 先选能放进元素上限的最密排布（每选项一行 → 裸勾选框 → 每问一个下拉框 → 去掉分区与题型小字），
 * 再在该排布内按字节预算截断：问题正文与选项说明默认完整渲染；整卡超预算时先让选项说明让路（统一截到
 * 能放下的最大长度），说明全省略仍放不下才截问题正文——批准的效力取决于正文。任一截断（含下拉框排布
 * 放不下的说明）都由发送方把全文作为文件发出。`fits` 为 false 表示截到最小仍超预算。纯函数、只依赖
 * ask 本身，首发 / 重绘 / settle PATCH 得到一致的结果。
 */
export function renderAskCard(
  ask: PendingAsk,
  result?: AskResult,
  opts?: { confirmEmptyArmed?: boolean },
): { json: string; promptTruncated: boolean; descriptionsTruncated: boolean; fits: boolean } {
  const measureUuid = ask.dispatchUuid ?? ASK_DISPATCH_UUID_WORST_CASE;
  const receiveId = ask.deliveryTarget?.openId ?? ask.chatId;
  const fits = (json: string) => turnReplyCardRequestBytes(json, receiveId, measureUuid) <= TURN_REPLY_CARD_MAX_BYTES;
  const longestDescription = Math.max(0, ...ask.questions.flatMap(q => q.options.map(o => o.description?.length ?? 0)));
  const longestPrompt = Math.max(0, ...ask.questions.map(q => q.prompt.length));
  type Rendered = { json: string; promptTruncated: boolean; descriptionsTruncated: boolean; fits: boolean };
  const withinElements = (json: string) => countCardElements(JSON.parse(json)) <= ASK_CARD_ELEMENT_LIMIT;
  let last: Rendered | undefined;
  for (const density of ASK_DENSITIES) {
    const render = (promptCap: number, descriptionCap: number) => renderAskCardWithCap(ask, result, opts, promptCap, descriptionCap, density);
    const fitBytes = (): Rendered => {
      const full = render(Infinity, Infinity);
      if (fits(full.json)) return { json: full.json, promptTruncated: false, descriptionsTruncated: full.descriptionsTruncated, fits: true };
      if (longestDescription > 0) {
        const withoutDescriptions = render(Infinity, 0).json;
        if (fits(withoutDescriptions)) return { promptTruncated: false, descriptionsTruncated: true, fits: true,
          json: largestFitting(1, longestDescription - 1, cap => render(Infinity, cap).json, fits) ?? withoutDescriptions };
      }
      const json = largestFitting(0, longestPrompt - 1, cap => render(cap, 0).json, fits);
      return { json: json ?? render(0, 0).json, promptTruncated: true, descriptionsTruncated: longestDescription > 0, fits: json !== undefined };
    };
    // Cutting text never removes an element (a cut prompt may add its notice line), so an
    // uncut render over the element limit rules this density out before any byte fitting.
    if (density !== ASK_DENSITIES.at(-1) && !withinElements(render(Infinity, Infinity).json)) continue;
    last = fitBytes();
    if (density === ASK_DENSITIES.at(-1) || (last.fits && withinElements(last.json))) return last;
  }
  return last!;
}

/** 二分出 `renderAt(cap)` 仍放得进预算的最大 cap（渲染体积随 cap 单调不减）。 */
function largestFitting(lo: number, hi: number, renderAt: (cap: number) => string, fits: (json: string) => boolean): string | undefined {
  let best: string | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const json = renderAt(mid);
    if (fits(json)) { best = json; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** 显式 ask 的 `--mention`：只在待答的群内卡上点名；settle 后的卡和发给文档作者的私聊卡不带。 */
function askMention(ask: PendingAsk, result: AskResult | undefined): string | undefined {
  return !result && !ask.deliveryTarget && ask.mentionedOpenId && /^ou_[A-Za-z0-9_-]+$/.test(ask.mentionedOpenId)
    ? `<at id=${ask.mentionedOpenId}></at>` : undefined;
}

function capPrompt(prompt: string, cap: number, locale?: Locale): string {
  if (prompt.length <= cap) return prompt;
  let head = prompt.slice(0, cap);
  // 不切断 UTF-16 代理对，避免产生孤立代理导致整卡 JSON 非法。
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…\n\n${t('card.ask.prompt_truncated', undefined, locale)}`;
}

/** 完整问题正文与选项说明（附件内容）。 */
export function askPromptAttachmentText(ask: PendingAsk): string {
  const locale = localeForBot(ask.larkAppId);
  const separator = locale === 'en' ? ': ' : '：';
  return ask.questions.map((q, i) => {
    const lines = [`## ${t('card.ask.question_n', { n: i + 1 }, locale)}`, '', q.prompt];
    if (q.options.length) lines.push('', ...q.options.map(o => o.description
      ? `- ${o.label}${separator}${o.description.replace(/\n/g, '\n  ')}` : `- ${o.label}`));
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
  descriptionCap: number,
  density: AskDensity,
): { json: string; descriptionsTruncated: boolean } {
  const locale = localeForBot(ask.larkAppId);
  const mention = askMention(ask, result);
  const presentation = askPresentation(ask);
  const prompt = (text: string) => escapeQuestion(capPrompt(text, promptCap, locale));
  const elements: Array<Record<string, unknown>> = [];
  if (ask.deliveryTarget) {
    elements.push({ tag: 'markdown', text_size: 'notation', content: t('card.ask.document_origin', {
      document: ask.deliveryTarget.fileToken, comment: ask.deliveryTarget.commentId,
    }, locale) });
  }
  let header: Record<string, unknown>;
  let descriptionsTruncated: boolean;
  if (!result && density === 'list') {
    // Too large for any control within the element limit: list it, answer by chat reply.
    const body = buildAskListBody(ask, { locale, prompt, descriptionCap });
    header = pendingHeader(ask, locale, 'text_reply');
    if (mention) elements.push({ tag: 'markdown', content: mention });
    elements.push(...body.elements, askFooter(deadlineLine(ask, locale), [
      ask.deliveryTarget || ask.originKind === 'native-user-input-async' ? askReplyHint(ask, locale) ?? ''
        : t('card.ask.list_reply_hint', undefined, locale),
      body.descriptionsTruncated ? t('card.ask.descriptions_truncated', undefined, locale) : '',
    ]));
    descriptionsTruncated = body.descriptionsTruncated;
  } else if (presentation === 'input_form') {
    const capped = { ...ask, questions: ask.questions.map(q => ({ ...q, prompt: capPrompt(q.prompt, promptCap, locale) })) };
    const body = renderAskFormBody(capped, locale, result, Math.min(300, promptCap), { mention, descriptionCap, density });
    header = result ? settledHeader(ask, result, locale) : pendingHeader(ask, locale, presentation);
    elements.push(...body.elements);
    descriptionsTruncated = body.descriptionsTruncated;
  } else if (result) {
    const permission = permissionAskSettleStatus(ask, result, locale);
    const detail = permission?.detail ?? (result.kind !== 'invalidated' ? undefined
      : result.failureCode === 'claimant_gone' ? t('card.ask.invalidated_claimant_gone', undefined, locale)
        : result.failureCode === 'answer_undelivered' ? t('card.ask.invalidated_answer_undelivered', undefined, locale)
          : escapeMd(result.reason));
    const body = buildAskSettledBody(ask, result, { locale, prompt, descriptionCap, detail, density });
    header = settledHeader(ask, result, locale, permission?.headline);
    elements.push(...body.elements, askFooter(result.kind === 'answered'
      ? submittedByLine(result.by, ask, locale) : deadlineLine(ask, locale)));
    descriptionsTruncated = body.descriptionsTruncated;
  } else {
    const confirmEmptyArmed = !!opts?.confirmEmptyArmed;
    const body = buildAskChoiceBody(ask, { locale, density, prompt, descriptionCap, confirmEmptyArmed });
    header = pendingHeader(ask, locale, presentation);
    if (mention) elements.push({ tag: 'markdown', content: mention });
    elements.push(...body.elements, askFooter(deadlineLine(ask, locale), [
      askReplyHint(ask, locale) ?? '',
      body.descriptionsTruncated ? t('card.ask.descriptions_truncated', undefined, locale) : '',
    ]));
    descriptionsTruncated = body.descriptionsTruncated;
  }
  return { descriptionsTruncated, json: JSON.stringify({
    schema: '2.0', config: askCardConfig(), header, body: { vertical_spacing: '12px', elements },
  }) };
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
    case 'invalid_custom':
      return { toast: { type: 'warning', content: t('card.ask.toast.invalid_custom', undefined, locale) } };
    case 'draft_conflict':
      return { toast: { type: 'warning', content: t('card.ask.toast.draft_conflict', undefined, locale) } };
    case 'toggled':
      // 累积勾选，不弹 toast
      return undefined;
    case 'invalid_form':
    case 'invalid_choice':
      return { toast: { type: 'warning', content: locale === 'en' ? 'Complete the required fields and check their formats; your draft is unchanged.' : '请补齐必填项并检查格式；已填内容保留，尚未提交。' } };
    case 'needs_empty_confirm':
      // 正常路径由 handleAskCardAction 提前拦成 arm 卡片响应，不会走到这里；
      // 兜底给个 warning toast，避免静默。
      return { toast: { type: 'warning', content: t('card.ask.toast.empty_confirm_needed', undefined, locale) } };
  }
}

function staleToast(locale?: Locale): { toast: { type: string; content: string } } {
  return { toast: { type: 'warning', content: t('card.ask.toast.stale', undefined, locale) } };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}
