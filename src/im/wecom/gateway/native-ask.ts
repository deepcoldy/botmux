import { createHash } from 'node:crypto';
import type { NativeGatewayAskCallback, NativeGatewayAskSnapshot } from '../../../core/native-gateway-contract.js';
import type { WecomCardEvent, WecomTemplateCard, WecomInboundMessage } from '../protocol/types.js';
import { isAskExecutionStale } from './core-client.js';

export interface NativeAskCore {
  asks(sessionId: string, triggerId: string): Promise<NativeGatewayAskSnapshot[]>;
  answerAsk(sessionId: string, body: NativeGatewayAskCallback): Promise<{ outcome: string }>;
}

interface AskReceipt {
  snapshot: NativeGatewayAskSnapshot;
  conversationId: string;
  recipient: string;
  requester: string;
  chatType: 'single' | 'group';
  status: 'sending' | 'sent' | 'uncertain';
  eventIds: Record<string, true>;
}

export interface NativeAskState {
  nativeAsks?: Record<string, AskReceipt>;
}

/** Option buttons on one page of an ask card; the page's other buttons are next-page and submit. */
const WECOM_ASK_OPTIONS_PER_PAGE = 4;

/** Told to whoever answers by text an ask that can no longer be answered. */
const WECOM_ASK_STALE_TEXT = '这个提问已失效：对应的会话或任务已结束，无法再回答。';

/** What an ask card becomes when a click finds the ask can no longer be answered: no buttons left. */
function staleAskCard(taskId: string): WecomTemplateCard {
  return {
    card_type: 'text_notice',
    task_id: taskId,
    main_title: { title: '提问已失效' },
    sub_title_text: '对应的会话或任务已结束，无法再回答。',
  };
}

/**
 * Answer one ask, or learn that the core definitely refused it as no longer
 * live (409 `stale_execution`, core-client.ts). Any other failure — 5xx, a
 * timeout, no connection, another refusal — is not a verdict and propagates.
 */
async function answerOrStale(
  core: NativeAskCore,
  sessionId: string,
  body: NativeGatewayAskCallback,
): Promise<{ outcome: string } | 'stale'> {
  try {
    return await core.answerAsk(sessionId, body);
  } catch (error) {
    if (isAskExecutionStale(error)) {
      return 'stale';
    }
    throw error;
  }
}

export function buildWecomAskCard(
  snapshot: NativeGatewayAskSnapshot,
  page = 0,
  confirmEmpty = false,
): WecomTemplateCard {
  const ask = snapshot.ask;
  const hasForm = ask.questions.some(q => !!q.input);
  const choices = (hasForm ? [] : ask.questions)
    .flatMap((q, qi) => q.options.map((option, oi) => ({ qi, oi, option, q })));
  const perPage = WECOM_ASK_OPTIONS_PER_PAGE;
  const pages = Math.max(1, Math.ceil(choices.length / perPage));
  page = Math.min(Math.max(page, 0), pages - 1);
  const selected = ask.selections ?? [];
  const buttons: NonNullable<WecomTemplateCard['button_list']> = choices
    .slice(page * perPage, (page + 1) * perPage)
    .map(({ qi, oi, option }) => ({
      text: `${selected[qi]?.includes(option.key) ? '✓ ' : ''}${ask.questions.length > 1 ? `${qi + 1}.` : ''}${option.label}`.slice(0, 40),
      key: `ask:toggle:${qi}:${oi}`,
    }));
  if (pages > 1) {
    buttons.push({ text: '下一页', key: `ask:page:${(page + 1) % pages}` });
  }
  if (choices.length) {
    buttons.push({
      text: confirmEmpty ? '确认提交空答案' : '提交答案',
      key: confirmEmpty ? 'ask:confirm' : 'ask:submit',
      style: 1,
    });
  }
  return {
    card_type: buttons.length ? 'button_interaction' : 'text_notice',
    task_id: `ask_${createHash('sha256').update(JSON.stringify([ask.askId, ask.nonce, snapshot.origin])).digest('hex').slice(0, 48)}`,
    main_title: { title: '请回答 CLI 提问', desc: `${page + 1}/${pages}` },
    sub_title_text: ask.questions
      .map((q, i) => `${i + 1}. ${q.prompt}${q.multiSelect ? '（可多选）' : ''}`)
      .join('\n')
      .slice(0, 2000)
      + (hasForm
        ? `\n表单提交：/ask ${ask.askId} ${JSON.stringify(Object.fromEntries(ask.questions.map((q, i) => [
          `q${i}`,
          q.input ? (q.input.type === 'number' ? '数字' : '文字') : (q.multiSelect ? [] : q.options[0]?.key ?? ''),
        ])))}（选项及输入均按原问题校验）`
        : `\n文字回答：/ask ${ask.askId} 你的答案`),
    ...(buttons.length ? { button_list: buttons } : {}),
    card_action: { type: 0 },
  };
}

export async function dispatchWecomAsks(ctx: {
  state: NativeAskState;
  core: NativeAskCore;
  sessionId: string;
  triggerId: string;
  message: WecomInboundMessage;
  sendCard(recipient: string, card: WecomTemplateCard): Promise<void>;
  save(): void;
  allowed(): boolean;
}): Promise<void> {
  const asks = await ctx.core.asks(ctx.sessionId, ctx.triggerId);
  if (!ctx.allowed()) {
    return;
  }
  for (const snapshot of asks) {
    if (!ctx.allowed()) {
      return;
    }
    const card = buildWecomAskCard(snapshot);
    const key = card.task_id;
    let row = ctx.state.nativeAsks?.[key];
    if (!row) {
      row = {
        snapshot,
        conversationId: ctx.message.conversationId,
        recipient: ctx.message.conversationId,
        requester: ctx.message.userId,
        chatType: ctx.message.chatType,
        status: 'sending',
        eventIds: {},
      };
      (ctx.state.nativeAsks ??= {})[key] = row;
      ctx.save();
      try {
        await ctx.sendCard(row.recipient, card);
        row.status = 'sent';
        ctx.save();
      } catch {
        row.status = 'uncertain';
        ctx.save();
        continue;
      }
    }
    if (row.status === 'sent' && ctx.allowed()) {
      await ctx.core.answerAsk(ctx.sessionId, {
        action: 'delivered',
        askId: snapshot.ask.askId,
        nonce: snapshot.ask.nonce,
        origin: snapshot.origin,
        messageId: key,
      });
    }
  }
}

/**
 * A button on an ask card. Who clicked, in which chat, and whether this
 * callback is new are checked first; any of those failing stays silent. Past
 * them, an ask that can no longer be answered — its task ended as far as the
 * gateway knows (`current` false), or the core definitely refused the answer
 * as stale — turns the card into a notice without buttons.
 */
export async function wecomAskCardEvent(ctx: {
  state: NativeAskState;
  core: NativeAskCore;
  current?: (origin: NativeGatewayAskSnapshot['origin']) => boolean;
  event: WecomCardEvent;
  save(): void;
  allowed(user: string): boolean;
  update(card: WecomTemplateCard): Promise<void>;
}): Promise<boolean> {
  if (!ctx.event.taskId.startsWith('ask_')) {
    return false;
  }
  const row = ctx.state.nativeAsks?.[ctx.event.taskId];
  const event = ctx.event;
  const expectedChatType = row && row.recipient === row.requester ? 'single' : row?.chatType;
  if (!row
    || row.status !== 'sent'
    || !ctx.allowed(row.requester)
    || !ctx.allowed(event.userId)
    || row.eventIds[event.messageId]
    || event.receivedAt + 4500 <= Date.now()
    || event.conversationId !== row.recipient
    || event.chatType !== expectedChatType) {
    return true;
  }
  const snapshot = row.snapshot;
  const ask = snapshot.ask;
  const parts = event.eventKey.split(':');
  if (parts[0] !== 'ask') {
    return true;
  }
  row.eventIds[event.messageId] = true;
  ctx.save();
  if (ctx.current?.(snapshot.origin) === false) {
    await ctx.update(staleAskCard(event.taskId));
    return true;
  }
  if (parts[1] === 'page') {
    await ctx.update(buildWecomAskCard(snapshot, Number(parts[2]) || 0));
    return true;
  }
  const questionIndex = Number(parts[2]);
  const optionIndex = Number(parts[3]);
  const option = ask.questions[questionIndex]?.options[optionIndex];
  if (!['toggle', 'submit', 'confirm'].includes(parts[1]) || parts[1] === 'toggle' && !option) {
    return true;
  }
  const result = await answerOrStale(ctx.core, snapshot.origin.sessionId, {
    origin: snapshot.origin,
    askId: ask.askId,
    nonce: ask.nonce,
    by: event.userId,
    action: parts[1] === 'toggle' ? 'toggle' : 'submit',
    ...(option ? { questionIndex, key: option.key } : {}),
    confirmEmpty: parts[1] === 'confirm',
  });
  if (result === 'stale') {
    await ctx.update(staleAskCard(event.taskId));
    return true;
  }
  if (result.outcome === 'toggled') {
    const latest = await ctx.core.asks(snapshot.origin.sessionId, snapshot.origin.turnId);
    const next = latest.find(item => item.ask.askId === ask.askId);
    if (next) {
      row.snapshot = next;
    }
    ctx.save();
    await ctx.update(buildWecomAskCard(row.snapshot));
    return true;
  }
  // Someone already answered this ask (a double click, or a second person):
  // the card already shows the submitted answer, so leave it as it is.
  if (result.outcome === 'already_settled') {
    return true;
  }
  if (result.outcome === 'needs_empty_confirm') {
    await ctx.update(buildWecomAskCard(snapshot, 0, true));
    return true;
  }
  const title = result.outcome === 'accepted' ? '答案已提交' : '提问已失效或答案不完整';
  await ctx.update({ card_type: 'text_notice', task_id: event.taskId, main_title: { title } });
  return true;
}

/**
 * A text answer `/ask <askId> <answer>`. The answerer, the chat and the ask's
 * requester are checked first; any of those failing stays silent. Past them, an
 * ask that can no longer be answered — its task ended as far as the gateway
 * knows (`current` false), the core definitely refused the answer as stale, or
 * the core judged it stale — is told to the answerer with one reply.
 */
export async function wecomAskText(ctx: {
  state: NativeAskState;
  core: NativeAskCore;
  current?: (origin: NativeGatewayAskSnapshot['origin']) => boolean;
  message: WecomInboundMessage;
  allowed(user: string): boolean;
  /** Reply to `message` in the chat it came from. */
  reply(text: string): Promise<void>;
}): Promise<boolean> {
  const match = ctx.message.text.trim().match(/^\/ask\s+(\S+)\s+([\s\S]+)$/);
  if (!match) {
    return false;
  }
  const row = Object.values(ctx.state.nativeAsks ?? {})
    .find(row => row.snapshot.ask.askId === match[1] && row.recipient === ctx.message.conversationId);
  if (!row
    || row.status !== 'sent'
    || !ctx.allowed(row.requester)
    || !ctx.allowed(ctx.message.userId)
    || ctx.message.chatType !== (row.recipient === row.requester ? 'single' : row.chatType)) {
    return true;
  }
  if (ctx.current?.(row.snapshot.origin) === false) {
    await ctx.reply(WECOM_ASK_STALE_TEXT);
    return true;
  }
  const result = await answerOrStale(ctx.core, row.snapshot.origin.sessionId, {
    origin: row.snapshot.origin,
    askId: match[1],
    nonce: row.snapshot.ask.nonce,
    by: ctx.message.userId,
    action: 'text',
    text: match[2],
  });
  if (result === 'stale' || result.outcome === 'stale') {
    await ctx.reply(WECOM_ASK_STALE_TEXT);
  }
  return true;
}
