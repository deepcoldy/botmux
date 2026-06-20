import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  PendingAsk,
} from '../../core/ask-types.js';
import { getAskSnapshot, submitAsk, toggleAsk, tryResolveAsk } from '../../core/ask-broker.js';
import { logger } from '../../utils/logger.js';
import { t, localeForBot, type Locale } from '../../i18n/index.js';
import { replyMessage, sendMessage, updateMessage } from './client.js';

/** 旧单选即答动作（保留兼容旧卡片回调；Task 5 新增 ask_submit 路径）。 */
export const ASK_SELECT_ACTION = 'ask_select';

/** 新多问 Submit 动作（form 内提交按钮携带此 action）。 */
export const ASK_SUBMIT_ACTION = 'ask_submit';

/** 累积勾选动作。飞书会 silent-drop form + select_static，所以 v0.1.8 用按钮态。 */
export const ASK_TOGGLE_ACTION = 'ask_toggle';

const MAX_BUTTONS_PER_ACTION_ROW = 4;

export interface AskCardActionData {
  operator?: { open_id?: string };
  action?: {
    value?: Record<string, unknown>;
    form_value?: Record<string, unknown>;
  };
}

export interface AskCardDispatcherDeps {
  sendMessage?: typeof sendMessage;
  replyMessage?: typeof replyMessage;
  updateMessage?: typeof updateMessage;
}

export function createLarkAskCardDispatcher(
  deps: AskCardDispatcherDeps = {},
): AskCardDispatcher {
  const send = deps.sendMessage ?? sendMessage;
  const reply = deps.replyMessage ?? replyMessage;
  const update = deps.updateMessage ?? updateMessage;

  return {
    async send(ask) {
      const cardJson = buildAskCard(ask);
      // botmux 把 chat-scope session 的 routing anchor 也叫 rootMessageId,
      // 但在 chat-scope 下它实际是 chat_id (oc_...) 而非 message_id (om_...).
      // 飞书 /messages/{id}/reply 只接受 om_ — 用 oc_ 会 400 invalid message_id.
      // 所以这里要按前缀判断是否真的能 reply.
      const canReplyToRoot =
        typeof ask.rootMessageId === 'string' && ask.rootMessageId.startsWith('om_');
      const messageId = canReplyToRoot
        ? await reply(ask.larkAppId, ask.rootMessageId!, cardJson, 'interactive', true)
        : await send(ask.larkAppId, ask.chatId, cardJson, 'interactive');
      return { messageId };
    },
    async onSettle(ask, result) {
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

export function isAskCardAction(action?: string): boolean {
  return action === ASK_SELECT_ACTION || action === ASK_SUBMIT_ACTION || action === ASK_TOGGLE_ACTION;
}

export async function handleAskCardAction(
  data: AskCardActionData,
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

  // 旧单选即答路径：按钮直接携带 key，调用 tryResolveAsk（单问单选便捷封装）
  if (action === ASK_SELECT_ACTION) {
    const selected = asString(value?.key);
    if (!selected) return staleToast(locale);
    return toastForOutcome(tryResolveAsk({ askId, nonce, selected, by }), locale);
  }

  if (action === ASK_TOGGLE_ACTION) {
    const questionIndex = asNumber(value?.question_index);
    const key = asString(value?.key);
    if (!Number.isInteger(questionIndex) || !key) return staleToast(locale);
    const outcome = toggleAsk({ askId, nonce, questionIndex, key, by });
    if (outcome !== 'toggled') return toastForOutcome(outcome, locale);
    const updated = getAskSnapshot(askId);
    if (!updated) return staleToast(locale);
    return JSON.parse(buildAskCard(updated)) as Record<string, unknown>;
  }

  // 新 Submit 路径：优先从按钮累积态提交；兼容旧 form_value 回调。
  if (action === ASK_SUBMIT_ACTION) {
    const formValue = data.action?.form_value ?? {};
    if (Object.keys(formValue).length > 0) {
      // 推断问题数量：找最大 qN 的 N+1
      const questionCount = guessQuestionCount(formValue);
      const selections = parseFormSelections(formValue, questionCount);
      return toastForOutcome(submitAsk({ askId, nonce, by, selections }), locale);
    }
    return toastForOutcome(submitAsk({ askId, nonce, by }), locale);
  }

  return staleToast(locale);
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
export function buildAskCard(ask: PendingAsk, result?: AskResult): string {
  const locale = localeForBot(ask.larkAppId);
  const deadline = new Date(ask.deadlineAt).toLocaleString('zh-CN');
  const status = result ? settleStatus(result, ask, locale) : undefined;

  // 截止时间 + 可答复人 字段行（settled 与 unsettled 均展示）
  const metaDiv = {
    tag: 'div',
    fields: [
      { is_short: true, text: { tag: 'lark_md', content: `**${t('card.ask.field.deadline', undefined, locale)}**\n${escapeMd(deadline)}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**${t('card.ask.field.answerable', undefined, locale)}**\n${escapeMd(approverSummary(ask, locale))}` } },
    ],
  };

  const elements: Array<Record<string, unknown>> = [metaDiv];

  if (status) {
    // 已 settle：展示状态摘要，无可交互组件
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: status },
    });
  } else {
    // 未 settle：只用 action/buttons，避免 form+select 被飞书服务端静默丢弃。
    elements.push({ tag: 'hr' });

    const requiresSubmit = ask.questions.length > 1 || ask.questions.some((q) => q.multiSelect);
    const selections = ask.selections ?? ask.questions.map(() => []);

    for (let i = 0; i < ask.questions.length; i++) {
      const q = ask.questions[i]!;

      // 问题标题
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${t('card.ask.question_n', { n: i + 1 }, locale)}**\n${escapeMd(truncate(q.prompt, 512, locale))}`,
        },
      });

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
      appendActionRows(elements, optionButtons);
    }

    if (requiresSubmit) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.ask.submit', undefined, locale) },
            type: 'primary',
            value: {
              action: ASK_SUBMIT_ACTION,
              ask_id: ask.askId,
              nonce: ask.nonce,
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
        { tag: 'plain_text', content: t('card.ask.custom_reply_hint', undefined, locale) },
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
  return `**${t('card.ask.invalidated', undefined, locale)}**\n${escapeMd(result.reason)}`;
}

function templateForResult(result: AskResult): string {
  switch (result.kind) {
    case 'answered': return 'green';
    case 'timedOut': return 'orange';
    case 'invalidated': return 'grey';
  }
}

function approverSummary(_ask: PendingAsk, locale?: Locale): string {
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

function appendActionRows(elements: Array<Record<string, unknown>>, actions: Array<Record<string, unknown>>): void {
  for (let i = 0; i < actions.length; i += MAX_BUTTONS_PER_ACTION_ROW) {
    elements.push({
      tag: 'action',
      actions: actions.slice(i, i + MAX_BUTTONS_PER_ACTION_ROW),
    });
  }
}

function truncate(s: string, maxChars: number, locale?: Locale): string {
  if (s.length <= maxChars) return s || t('common.empty_paren', undefined, locale);
  return `${s.slice(0, maxChars)}\n\n${t('common.truncated_short', undefined, locale)}`;
}

function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\]/g, (c) => `\\${c}`);
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
