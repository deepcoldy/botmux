import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  PendingAsk,
} from '../../core/ask-types.js';
import { submitAsk, tryResolveAsk } from '../../core/ask-broker.js';
import { logger } from '../../utils/logger.js';
import { replyMessage, sendMessage, updateMessage } from './client.js';

/** 旧单选即答动作（保留兼容旧卡片回调；Task 5 新增 ask_submit 路径）。 */
export const ASK_SELECT_ACTION = 'ask_select';

/** 新多问 Submit 动作（form 内提交按钮携带此 action）。 */
export const ASK_SUBMIT_ACTION = 'ask_submit';

/** form 名称常量，与 workflow-cards.ts 形式对齐。 */
const ASK_FORM_NAME = 'ask_form';

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
      const messageId = ask.rootMessageId
        ? await reply(ask.larkAppId, ask.rootMessageId, cardJson, 'interactive', true)
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
  return action === ASK_SELECT_ACTION || action === ASK_SUBMIT_ACTION;
}

export function handleAskCardAction(data: AskCardActionData): { toast: { type: string; content: string } } | undefined {
  const value = data.action?.value;
  const action = asString(value?.action);
  if (!isAskCardAction(action)) return undefined;

  const askId = asString(value?.ask_id);
  const nonce = asString(value?.nonce);
  const by = data.operator?.open_id;
  if (!askId || !nonce || !by) {
    return staleToast();
  }

  // 旧单选即答路径：按钮直接携带 key，调用 tryResolveAsk（单问单选便捷封装）
  if (action === ASK_SELECT_ACTION) {
    const selected = asString(value?.key);
    if (!selected) return staleToast();
    return toastForOutcome(tryResolveAsk({ askId, nonce, selected, by }));
  }

  // 新 Submit 路径：从 form_value 中防御式解析各问答案，调 submitAsk
  if (action === ASK_SUBMIT_ACTION) {
    const formValue = data.action?.form_value ?? {};
    // 推断问题数量：找最大 qN 的 N+1
    const questionCount = guessQuestionCount(formValue);
    const selections = parseFormSelections(formValue, questionCount);
    return toastForOutcome(submitAsk({ askId, nonce, by, selections }));
  }

  return staleToast();
}

/**
 * 构建 ask 卡片 JSON 字符串。
 *
 * 未 settle 时：将所有问题包在一个 form 内，每问渲染标题 div + 下拉选择组件，
 * 最后附一个 `action_type:'form_submit'` 的提交按钮。
 * 单选问题用 `select_static`，多选问题用 `multi_select_static`。
 *
 * 已 settle 时：渲染状态摘要，展示每问的选中标签（answered），或超时/失效信息。
 */
export function buildAskCard(ask: PendingAsk, result?: AskResult): string {
  const deadline = new Date(ask.deadlineAt).toLocaleString('zh-CN');
  const status = result ? settleStatus(result, ask) : undefined;

  // 截止时间 + 可答复人 字段行（settled 与 unsettled 均展示）
  const metaDiv = {
    tag: 'div',
    fields: [
      { is_short: true, text: { tag: 'lark_md', content: `**截止**\n${escapeMd(deadline)}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**可答复**\n${escapeMd(approverSummary(ask))}` } },
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
    // 未 settle：多问 form，每问一个标题 div + 选择组件，最后一个 Submit 按钮
    elements.push({ tag: 'hr' });

    // form 内的元素列表
    const formElements: Array<Record<string, unknown>> = [];

    for (let i = 0; i < ask.questions.length; i++) {
      const q = ask.questions[i]!;

      // 问题标题
      formElements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**问题 ${i + 1}**\n${escapeMd(truncate(q.prompt, 512))}`,
        },
      });

      // 选项组件：单选 select_static / 多选 multi_select_static
      const selectTag = q.multiSelect ? 'multi_select_static' : 'select_static';
      const placeholder = q.multiSelect ? '可多选' : '请选择';
      formElements.push({
        tag: selectTag,
        name: `q${i}`,
        placeholder: { tag: 'plain_text', content: placeholder },
        options: q.options.map((opt) => ({
          text: { tag: 'plain_text', content: opt.label },
          // value 编码 questionIndex::key，供 handler 解析
          value: `${i}::${opt.key}`,
        })),
      });
    }

    // Submit 按钮，放在 form 内，`action_type:'form_submit'` 与 workflow-cards.ts 完全一致
    formElements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '提交' },
      type: 'primary',
      action_type: 'form_submit',
      value: {
        action: ASK_SUBMIT_ACTION,
        ask_id: ask.askId,
        nonce: ask.nonce,
      },
    });

    elements.push({
      tag: 'form',
      name: ASK_FORM_NAME,
      elements: formElements,
    });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: result ? templateForResult(result) : 'blue',
      title: { tag: 'plain_text', content: result ? 'botmux ask 已结束' : 'botmux ask' },
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

function toastForOutcome(outcome: AskClickOutcome): { toast: { type: string; content: string } } | undefined {
  switch (outcome) {
    case 'accepted':
      return undefined;
    case 'unauthorized':
      return { toast: { type: 'warning', content: '你没有权限回答这个 ask' } };
    case 'already_settled':
      return { toast: { type: 'info', content: '这个 ask 已经被回答或结束' } };
    case 'stale':
      return staleToast();
    case 'toggled':
      // 累积勾选，不弹 toast
      return undefined;
  }
}

function staleToast(): { toast: { type: string; content: string } } {
  return { toast: { type: 'warning', content: '⚠️ 此 ask 已失效' } };
}

/**
 * 生成已结束状态的摘要文本。
 *
 * answered：遍历每个问题，把选中的 key 映射为 label 并渲染。
 * timedOut / invalidated：展示对应说明。
 */
function settleStatus(result: AskResult, ask: PendingAsk): string {
  if (result.kind === 'answered') {
    // 每问一行：问题N：<选中标签>
    const lines = result.answers.map((keys, i) => {
      const q = ask.questions[i];
      if (!q) return `问题${i + 1}：（无法解析）`;
      const labels = keys.map((key) => q.options.find((o) => o.key === key)?.label ?? key);
      return `问题${i + 1}：${labels.join(', ')}`;
    });
    const summary = lines.join('\n');
    return `**已选择**\n${escapeMd(summary)}\n操作人：${escapeMd(short(result.by, 28))}`;
  }
  if (result.kind === 'timedOut') {
    return '**超时未答**';
  }
  return `**已失效**\n${escapeMd(result.reason)}`;
}

function templateForResult(result: AskResult): string {
  switch (result.kind) {
    case 'answered': return 'green';
    case 'timedOut': return 'orange';
    case 'invalidated': return 'grey';
  }
}

function approverSummary(ask: PendingAsk): string {
  if (ask.approvers.size === 0) return '无可用答复人';
  const values = [...ask.approvers].map((id) => short(id, 18));
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 3).join(', ')} +${values.length - 3}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s || '（空）';
  return `${s.slice(0, maxChars)}\n\n…（已截断）`;
}

function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\]/g, (c) => `\\${c}`);
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
