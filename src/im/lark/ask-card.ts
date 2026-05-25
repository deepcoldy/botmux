import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  PendingAsk,
} from '../../core/ask-types.js';
import { tryResolveAsk } from '../../core/ask-broker.js';
import { logger } from '../../utils/logger.js';
import { replyMessage, sendMessage, updateMessage } from './client.js';

export const ASK_SELECT_ACTION = 'ask_select';

export interface AskCardActionData {
  operator?: { open_id?: string };
  action?: {
    value?: Record<string, unknown>;
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
  return action === ASK_SELECT_ACTION;
}

export function handleAskCardAction(data: AskCardActionData): { toast: { type: string; content: string } } | undefined {
  const value = data.action?.value;
  if (!isAskCardAction(asString(value?.action))) return undefined;

  const askId = asString(value?.ask_id);
  const nonce = asString(value?.nonce);
  const selected = asString(value?.key);
  const by = data.operator?.open_id;
  if (!askId || !nonce || !selected || !by) {
    return staleToast();
  }

  return toastForOutcome(tryResolveAsk({ askId, nonce, selected, by }));
}

export function buildAskCard(ask: PendingAsk, result?: AskResult): string {
  const prompt = truncate(ask.prompt, 512);
  const deadline = new Date(ask.deadlineAt).toLocaleString('zh-CN');
  const status = result ? settleStatus(result, ask) : undefined;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**问题**\n${escapeMd(prompt)}`,
      },
    },
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**截止**\n${escapeMd(deadline)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**可答复**\n${escapeMd(approverSummary(ask))}` } },
      ],
    },
  ];

  if (status) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: status },
    });
  } else {
    elements.push({ tag: 'hr' });
    for (const row of chunk(ask.options, 4)) {
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'default',
        columns: row.map((option) => ({
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: option.label },
              type: 'primary',
              value: {
                action: ASK_SELECT_ACTION,
                ask_id: ask.askId,
                nonce: ask.nonce,
                key: option.key,
              },
            },
          ],
        })),
      });
    }
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
  }
}

function staleToast(): { toast: { type: string; content: string } } {
  return { toast: { type: 'warning', content: '⚠️ 此 ask 已失效' } };
}

function settleStatus(result: AskResult, ask: PendingAsk): string {
  if (result.kind === 'answered') {
    const label = ask.options.find((o) => o.key === result.selected)?.label ?? result.selected;
    return `**已选择：${escapeMd(label)}**\n操作人：${escapeMd(short(result.by, 28))}`;
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

function chunk<T>(values: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
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
