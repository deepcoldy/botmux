import type { BotConfig } from '../../bot-registry.js';
import type { CotEntry } from '../../types.js';
import { subjectFromArgsString } from '../../services/cot-subject.js';
import {
  replyCardIsTerminal, type ReplyCardTool, type TurnReplyCardRecord, type ReplyCardActivity,
} from '../../services/turn-reply-card.js';
import { buildTurnReplyAskElements, turnReplyAskSummary } from './turn-reply-ask-elements.js';
import { buildCardBodyElements, cardUsageFooterSegment, createReplyCard } from './md-card.js';

export interface TurnReplyCardPresentation {
  locale?: 'zh' | 'en';
  showProcess: boolean;
  showToolResults: boolean;
  canStop: boolean;
  workingDir?: string;
  showLiveUsage?: boolean;
}

/** Extract tools without mixing provider-supplied reasoning into tool output. */
export function publicReplyCardTools(entries: readonly CotEntry[], showResults: boolean): ReplyCardTool[] {
  const tools = new Map<string, ReplyCardTool>();
  for (const entry of entries) {
    if (entry.kind === 'tool_call') {
      tools.set(entry.id, {
        id: entry.id, name: entry.name,
        subject: (entry.subject || subjectFromArgsString(entry.args)).slice(0, 1000),
      });
    } else if (entry.kind === 'tool_result') {
      const tool = tools.get(entry.id);
      if (tool) {
        tool.completed = true;
        if (showResults) tool.result = entry.result.slice(0, 2000);
      }
    }
  }
  return [...tools.values()];
}

/** Only text already emitted by the CLI is available here (often a summary). */
export function publicReplyCardActivity(entries: readonly CotEntry[]): ReplyCardActivity[] {
  return entries.flatMap((entry, index): ReplyCardActivity[] => entry.kind === 'thinking' || entry.kind === 'text'
    ? [{ kind: 'thinking', id: `thinking:${index}`, text: bounded(entry.text, 4000) }]
    : entry.kind === 'tool_call' ? [{ kind: 'tool', id: entry.id }] : []);
}

function bounded(text: string, bytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text;
  let result = '';
  let size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char, 'utf8');
    if (size > bytes - 4) break;
    result += char;
  }
  return `${result}…`;
}

function publicText(text: string): string {
  // Tool arguments/results are display data; never execute their @mentions.
  return text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Match the tool categories used by CoT, including Codex's exec command names. */
function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (/bash|shell|command|(^|[^a-z])exec([^a-z]|$)/.test(n)) return '💻';
  if (/write|edit|patch/.test(n)) return '✏️';
  if (/read|notebook/.test(n)) return '📖';
  if (/grep|glob|search|fetch/.test(n)) return '🔍';
  if (/task|todo|plan/.test(n)) return '📋';
  return '🔧';
}

function toolLine(tool: ReplyCardTool, subjectLimit: number): string {
  return `${toolIcon(tool.name)} **${bounded(publicText(tool.name), 120)}**${tool.completed ? ' ✓' : ''}`
    + (tool.subject ? ` · ${publicText(bounded(tool.subject, subjectLimit))}` : '');
}

interface ProcessEntry { kind: 'tool' | 'text'; content: string }

function processPreview(entries: ProcessEntry[], en: boolean): { content: string; shownTools: number } {
  const entryLimit = 20;
  const notice = en ? 'Some earlier entries or long content have been omitted.' : '部分较早的过程记录或长内容已省略。';
  const byteLimit = 7000 - Buffer.byteLength(`\n\n${notice}`, 'utf8');
  const tools = entries.filter(entry => entry.kind === 'tool');
  const texts = entries.filter(entry => entry.kind === 'text');
  // Reserve half for each category; lend unused slots and bytes to the other.
  const selectedTools = tools.slice(-Math.max(entryLimit / 2, entryLimit - texts.length));
  const selectedTexts = texts.slice(-Math.max(entryLimit / 2, entryLimit - tools.length));
  const cost = (entry: ProcessEntry) => Buffer.byteLength(entry.content, 'utf8') + 1;
  const totalCost = (group: ProcessEntry[]) => group.reduce((sum, entry) => sum + cost(entry), 0);
  const toolBudget = Math.min(totalCost(selectedTools), Math.max(Math.floor(byteLimit / 2), byteLimit - totalCost(selectedTexts)));
  const rendered = new Map<ProcessEntry, string>();
  let omitted = selectedTools.length + selectedTexts.length < entries.length;
  const fit = (group: ProcessEntry[], budget: number) => {
    // Short entries keep their full text. Share the remainder across long
    // entries so one large output cannot remove another entry's tool label.
    const bySize = [...group].sort((a, b) => cost(a) - cost(b));
    bySize.forEach((entry, index) => {
      const limit = Math.floor(budget / (bySize.length - index)) - 1;
      const content = bounded(entry.content, limit);
      rendered.set(entry, content);
      omitted ||= content !== entry.content;
      budget -= Buffer.byteLength(content, 'utf8') + 1;
    });
  };
  fit(selectedTools, toolBudget);
  fit(selectedTexts, byteLimit - toolBudget);
  const content = entries.filter(entry => rendered.has(entry)).map(entry => rendered.get(entry)!).join('\n');
  return { content: content + (omitted ? `\n\n${notice}` : ''), shownTools: selectedTools.length };
}

export function buildTurnReplyCard(record: TurnReplyCardRecord, presentation: TurnReplyCardPresentation): string {
  const en = presentation.locale === 'en';
  const terminal = replyCardIsTerminal(record);
  const pendingAsks = (record.asks ?? []).filter(entry => !entry.result && !entry.ask.settled);
  const phaseLabels = en
    ? { queued: 'Queued', working: 'Working', waiting: 'Waiting for a response', stopping: 'Stopping', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped', ambiguous: 'Interrupted' }
      : { queued: '等待执行', working: '处理中', waiting: '等待响应', stopping: '正在停止', completed: '已完成', failed: '执行失败', cancelled: '已停止', ambiguous: '执行状态待确认' };
  const phaseIcons = { queued: '⏳', working: '🧠', waiting: '⏳', stopping: '⏹', completed: '✅', failed: '❌', cancelled: '⏹', ambiguous: '⚠️' };
  const toolCount = presentation.showProcess ? record.tools.length : 0;
  const duration = record.durationMs !== undefined ? record.durationMs
    : !terminal && record.startedAtMs ? Date.now() - record.startedAtMs : undefined;
  const title = [
    pendingAsks.length ? (en ? 'Waiting for your response' : '等待你确认') : phaseLabels[record.phase],
    duration !== undefined ? `${(Math.max(0, duration) / 1000).toFixed(1)}s` : '',
  ].filter(Boolean).join(' · ');

  const card = record.finalCard
    ? JSON.parse(record.finalCard) as ReturnType<typeof createReplyCard>
    : createReplyCard([]);
  if (record.overflowMessageId) {
    // Keep the canonical footer and feedback controls. Full original content
    // is in the native attachment; a visible notice always accompanies it.
    card.body.elements = card.body.elements.filter(element =>
      element.element_id === 'botmux_reply_footer' || element.element_id === 'botmux_feedback');
    card.body.elements.unshift({ tag: 'markdown', content: en
      ? 'The full answer is included in this turn’s **Markdown attachment**.'
      : '完整答复较长，已作为本轮的 **Markdown 附件**发送，请查看附件。' });
  }

  if (pendingAsks.length) {
    card.body.elements.unshift(...buildTurnReplyAskElements(pendingAsks[0], presentation.locale));
    if (pendingAsks.length > 1) card.body.elements.push({ tag: 'markdown', text_size: 'notation', content: en
      ? `${pendingAsks.length - 1} more requests will appear after this one is answered.`
      : `还有 ${pendingAsks.length - 1} 个待回答请求，完成当前问题后依次显示。` });
  }
  if (!record.finalCard && !pendingAsks.length) {
    const latest = record.progress.at(-1);
    const content = latest ? bounded(latest, 6000)
      : terminal ? (en ? 'No final answer was provided. See the turn record below.' : '本轮没有提供最终答复，可查看下方过程记录。')
        : (en ? 'Working on your request…' : '正在处理你的请求…');
    card.body.elements.push(...buildCardBodyElements(content, presentation.workingDir, 'disabled'));
  }

  const process: ProcessEntry[] = [];
  if (presentation.showProcess) {
    const latest = record.activity?.at(-1);
    if (!terminal && !record.finalCard && !pendingAsks.length && latest?.kind === 'thinking') {
      card.body.elements.push({ tag: 'markdown', content: `🧠 ${publicText(bounded(latest.text, 600))}` });
    }
    if (!terminal && !record.finalCard && !pendingAsks.length && record.tools.length) {
      card.body.elements.push({ tag: 'markdown', content: record.tools.slice(-2).map(tool =>
        toolLine(tool, 300),
      ).join('\n') });
    }
  }
  const activity: ReplyCardActivity[] = record.activity ?? [
    ...record.progress.map((text, i) => ({ kind: 'progress' as const, id: String(i), text })),
    ...record.tools.map(tool => ({ kind: 'tool' as const, id: tool.id })),
  ];
  for (const item of activity) {
    if (item.kind === 'progress') {
      if (terminal || record.finalCard || record.progress.length > 1 || pendingAsks.length) process.push({ kind: 'text', content: `💬 ${publicText(bounded(item.text, 600))}` });
    } else if (item.kind === 'ask') {
      const entry = record.asks?.find(entry => entry.ask.askId === item.id);
      if (entry?.result) process.push({ kind: 'text', content: bounded(turnReplyAskSummary(entry, presentation.locale), 1200) });
    } else if (presentation.showProcess && item.kind === 'thinking') {
      process.push({ kind: 'text', content: `🧠 ${publicText(bounded(item.text, 1200))}` });
    } else if (presentation.showProcess && item.kind === 'tool') {
      const tool = record.tools.find(tool => tool.id === item.id);
      if (tool) process.push({ kind: 'tool', content: toolLine(tool, 400)
        + (presentation.showToolResults && tool.result ? `\n${publicText(bounded(tool.result, 600))}` : '') });
    }
  }
  if (process.length) {
    const preview = processPreview(process, en);
    const toolCountLabel = preview.shownTools < toolCount
      ? (en ? `${preview.shownTools} of ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'} shown` : `已展示 ${preview.shownTools} / ${toolCount} 次工具调用`)
      : (en ? `${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}` : `${toolCount} 次工具调用`);
    const footerIndex = card.body.elements.findIndex(element =>
      element.element_id === 'botmux_feedback' || element.element_id === 'botmux_reply_footer');
    card.body.elements.splice(footerIndex < 0 ? card.body.elements.length : footerIndex, 0, {
      tag: 'collapsible_panel', expanded: false,
      background_color: 'grey-50', padding: '4px 12px 12px 12px', margin: '4px 0px 0px 0px',
      border: { color: 'grey-50', corner_radius: '8px' },
      header: {
        title: { tag: 'plain_text', content: toolCount
          ? (en ? `📋 Activity (${toolCountLabel})` : `📋 执行过程（${toolCountLabel}）`)
          : presentation.showProcess ? (en ? '📋 Activity' : '📋 执行过程') : (en ? '📋 Turn record' : '📋 本轮记录') },
        background_color: 'grey-50', padding: '10px 12px 10px 12px',
        icon: { tag: 'standard_icon', token: 'down_outlined', color: 'grey', size: '16px 16px' },
        icon_position: 'right', icon_expanded_angle: -180,
      },
      elements: [{ tag: 'markdown', content: preview.content }],
    });
  }

  // A runtime status is separate from a model-authored layout title.
  card.body.elements.unshift({ tag: 'markdown', element_id: 'botmux_turn_status', content: `${pendingAsks.length ? '🙋' : phaseIcons[record.phase]} **${title}**` });
  const usage = presentation.showLiveUsage && record.usage
    ? cardUsageFooterSegment(record.usage, presentation.locale, 'streaming') : null;
  if (usage) card.body.elements.push({ tag: 'markdown', element_id: 'botmux_turn_usage', text_size: 'notation', content: usage });
  if (!terminal && !record.finalCard && ['working', 'waiting'].includes(record.phase) && presentation.canStop) {
    card.body.elements.push({ tag: 'column_set', columns: [{ tag: 'column', width: 'auto', elements: [{
      tag: 'button', text: { tag: 'plain_text', content: en ? '⏹ Stop' : '⏹ 停止' }, type: 'danger',
      behaviors: [{ type: 'callback', value: {
        action: 'stop_turn', session_id: record.sessionId, root_id: record.rootId,
        lark_app_id: record.larkAppId, chat_id: record.chatId, reply_card_turn_id: record.turnId,
        ...(record.dispatchAttempt !== undefined ? { reply_card_attempt: record.dispatchAttempt } : {}),
      } }],
    }] }] });
  }
  // Feedback becomes clickable after runtime settlement, avoiding a feedback
  // callback racing with the last status PATCH.
  if (!terminal) card.body.elements = card.body.elements.filter(element => element.element_id !== 'botmux_feedback');
  return JSON.stringify(card);
}

export function replyCardPresentation(config: Pick<BotConfig, 'thinkingCard' | 'thinkingCardToolResult' | 'noCotChats' | 'hiddenStreamingCardButtons'>, chatId: string): Pick<TurnReplyCardPresentation, 'showProcess' | 'showToolResults' | 'canStop'> {
  return {
    showProcess: config.thinkingCard !== false && !config.noCotChats?.includes(chatId),
    showToolResults: config.thinkingCardToolResult !== false,
    canStop: !config.hiddenStreamingCardButtons?.includes('stop'),
  };
}
