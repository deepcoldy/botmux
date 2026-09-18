import type { BotConfig } from '../../bot-registry.js';
import type { CotEntry } from '../../types.js';
import { subjectFromArgsString } from '../../services/cot-subject.js';
import {
  replyCardIsTerminal, type ReplyCardTool, type TurnReplyCardRecord, type ReplyCardActivity,
} from '../../services/turn-reply-card.js';
import { buildTurnReplyAskElements, turnReplyAskSummary } from './turn-reply-ask-elements.js';
import { buildCardBodyElements, cardUsageFooterSegment, createReplyCard } from './md-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from './turn-reply-card-size.js';

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
        subject: entry.subject || subjectFromArgsString(entry.args),
      });
    } else if (entry.kind === 'tool_result') {
      const tool = tools.get(entry.id);
      if (tool) {
        tool.completed = true;
        if (showResults) tool.result = entry.result;
      }
    }
  }
  return [...tools.values()];
}

/** Only text already emitted by the CLI is available here (often a summary). */
export function publicReplyCardActivity(entries: readonly CotEntry[]): ReplyCardActivity[] {
  return entries.flatMap((entry, index): ReplyCardActivity[] => entry.kind === 'thinking' || entry.kind === 'text'
    ? [{ kind: 'thinking', id: `thinking:${index}`, text: entry.text }]
    : entry.kind === 'tool_call' ? [{ kind: 'tool', id: entry.id }] : []);
}

function bounded(text: string, bytes: number, measure = (value: string) => Buffer.byteLength(value, 'utf8')): string {
  if (measure(text) <= bytes) return text;
  if (bytes < measure('…')) return '';
  let result = '';
  let size = 0;
  for (const char of text) {
    size += measure(char);
    if (size > bytes - measure('…')) break;
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

function toolLine(tool: ReplyCardTool, subjectLimit = Infinity): string {
  return `${toolIcon(tool.name)} **${bounded(publicText(tool.name), 120)}**${tool.completed ? ' ✓' : ''}`
    + (tool.subject ? ` · ${publicText(bounded(tool.subject, subjectLimit))}` : '');
}

interface ProcessEntry { kind: 'tool' | 'text'; content: string; label?: string }
interface ProcessPreview { content: string; shownTools: number }

// Markdown is inside a card JSON string, itself inside the request JSON.
// Subtract the two string envelopes to measure its additive wire cost.
function processTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(text)), 'utf8') - 6;
}

function closeProcessCodeFence(text: string): string {
  // An upstream excerpt or our size clipping may end inside a code block.
  // Keep that block from swallowing later entries and the truncation notice.
  let openFence = '';
  for (const line of text.split('\n')) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence) continue;
    if (!openFence) {
      // A backtick fence's info string cannot contain backticks. Such a line
      // may be inline code, so appending a closing fence would open a new block.
      if (fence[1][0] === '`' && fence[2].includes('`')) continue;
      openFence = fence[1];
    } else if (fence[1][0] === openFence[0] && fence[1].length >= openFence.length && !fence[2].trim()) openFence = '';
  }
  return text + (openFence ? `\n${openFence}` : '');
}

function boundedProcessEntry(text: string, limit: number): string {
  let budget = limit;
  while (budget > 0) {
    const result = closeProcessCodeFence(bounded(text, budget, processTextBytes));
    const excess = processTextBytes(result) - limit;
    if (excess <= 0) return result;
    budget -= excess;
  }
  return '';
}

function processPreview(entries: ProcessEntry[], byteLimit: number, notice: string): ProcessPreview {
  const tools = entries.filter(entry => entry.kind === 'tool');
  const texts = entries.filter(entry => entry.kind === 'text');
  const cost = (entry: ProcessEntry) => processTextBytes(entry.content) + processTextBytes('\n');
  const totalCost = (group: ProcessEntry[]) => group.reduce((sum, entry) => sum + cost(entry), 0);
  // Only on overflow: keep recent entries from both categories, lending unused
  // space to the other so progress cannot consume the entire tool history.
  const toolBudget = Math.min(totalCost(tools), Math.max(Math.floor(byteLimit / 2), byteLimit - totalCost(texts)));
  const rendered = new Map<ProcessEntry, string>();
  const fit = (group: ProcessEntry[], budget: number) => {
    for (let index = group.length - 1; index >= 0; index--) {
      const entry = group[index];
      if (cost(entry) <= budget) {
        rendered.set(entry, entry.content);
        budget -= cost(entry);
      } else {
        // If even the newest entry is too large, retain its beginning. Never
        // count a tool whose label cannot fit as a displayed tool call.
        const limit = budget - processTextBytes('\n');
        if (index === group.length - 1 && limit >= processTextBytes((entry.label ?? '') + '…')) {
          const clipped = boundedProcessEntry(entry.content, limit);
          if (clipped && (!entry.label || clipped.startsWith(entry.label))) rendered.set(entry, clipped);
        }
        break;
      }
    }
  };
  fit(tools, toolBudget);
  fit(texts, byteLimit - toolBudget);
  const content = entries.filter(entry => rendered.has(entry)).map(entry => rendered.get(entry)!).join('\n');
  return { content: content ? `${content}\n\n${notice}` : notice, shownTools: tools.filter(entry => rendered.has(entry)).length };
}

export function buildTurnReplyCard(record: TurnReplyCardRecord, presentation: TurnReplyCardPresentation): string {
  const en = presentation.locale === 'en';
  const terminal = replyCardIsTerminal(record);
  const pendingAsks = (record.asks ?? []).filter(entry => !entry.result && !entry.ask.settled);
  const phaseLabels = en
    ? { queued: 'Queued', working: 'Working', waiting: 'Waiting for a response', stopping: 'Stopping', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped', ambiguous: 'Interrupted' }
      : { queued: '等待执行', working: '处理中', waiting: '等待响应', stopping: '正在停止', completed: '已完成', failed: '执行失败', cancelled: '已停止', ambiguous: '执行状态待确认' };
  const phaseIcons = { queued: '⏳', working: '💭', waiting: '⏳', stopping: '⏹', completed: '✅', failed: '❌', cancelled: '⏹', ambiguous: '⚠️' };
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
  let setProcessPreview: ((preview: ProcessPreview) => void) | undefined;
  if (presentation.showProcess) {
    // A coalesced snapshot often ends in a tool call; keep its preceding
    // narration visible until a newer narration or another card view replaces it.
    const latest = record.activity?.slice().reverse().find(item => item.kind === 'thinking' && item.text.trim());
    if (!terminal && !record.finalCard && !pendingAsks.length && latest?.kind === 'thinking') {
      card.body.elements.push({ tag: 'markdown', content: `💭 ${publicText(bounded(latest.text, 600))}` });
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
      if (terminal || record.finalCard || record.progress.length > 1 || pendingAsks.length) process.push({ kind: 'text', content: `💬 ${publicText(item.text)}` });
    } else if (item.kind === 'ask') {
      const entry = record.asks?.find(entry => entry.ask.askId === item.id);
      if (entry?.result) process.push({ kind: 'text', content: turnReplyAskSummary(entry, presentation.locale) });
    } else if (presentation.showProcess && item.kind === 'thinking') {
      process.push({ kind: 'text', content: `💭 ${publicText(item.text)}` });
    } else if (presentation.showProcess && item.kind === 'tool') {
      const tool = record.tools.find(tool => tool.id === item.id);
      if (tool) process.push({ kind: 'tool', label: toolLine({ ...tool, subject: '' }), content: toolLine(tool)
        + (presentation.showToolResults && tool.result ? `\n${publicText(tool.result)}` : '') });
    }
  }
  if (process.length) {
    for (const entry of process) entry.content = closeProcessCodeFence(entry.content);
    const footerIndex = card.body.elements.findIndex(element =>
      element.element_id === 'botmux_feedback' || element.element_id === 'botmux_reply_footer');
    const panel = {
      tag: 'collapsible_panel', expanded: false,
      background_color: 'grey-50', padding: '4px 12px 12px 12px', margin: '4px 0px 0px 0px',
      border: { color: 'grey-50', corner_radius: '8px' },
      header: {
        title: { tag: 'plain_text', content: '' },
        background_color: 'grey-50', padding: '10px 12px 10px 12px',
        icon: { tag: 'standard_icon', token: 'down_outlined', color: 'grey', size: '16px 16px' },
        icon_position: 'right', icon_expanded_angle: -180,
      },
      elements: [{ tag: 'markdown', content: '' }],
    };
    setProcessPreview = preview => {
      const toolCountLabel = preview.shownTools < toolCount
        ? (en ? `${preview.shownTools} of ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'} shown` : `已展示 ${preview.shownTools} / ${toolCount} 次工具调用`)
        : (en ? `${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}` : `${toolCount} 次工具调用`);
      panel.header.title.content = toolCount
        ? (en ? `📋 Activity (${toolCountLabel})` : `📋 执行过程（${toolCountLabel}）`)
        : presentation.showProcess ? (en ? '📋 Activity' : '📋 执行过程') : (en ? '📋 Turn record' : '📋 本轮记录');
      panel.elements[0].content = preview.content;
    };
    setProcessPreview({ content: process.map(entry => entry.content).join('\n'), shownTools: process.filter(entry => entry.kind === 'tool').length });
    card.body.elements.splice(footerIndex < 0 ? card.body.elements.length : footerIndex, 0, panel);
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
  let serialized = JSON.stringify(card);
  if (setProcessPreview && turnReplyCardRequestBytes(serialized, record.chatId) > TURN_REPLY_CARD_MAX_BYTES) {
    const notice = en ? 'Card size limit reached. Some activity has been truncated; recent entries are shown.'
      : '卡片内容超出容量，部分执行过程已截断，保留最近记录。';
    setProcessPreview({ content: notice, shownTools: 0 });
    serialized = JSON.stringify(card);
    let budget = TURN_REPLY_CARD_MAX_BYTES - turnReplyCardRequestBytes(serialized, record.chatId) - processTextBytes('\n\n');
    while (budget > 0) {
      setProcessPreview(processPreview(process, budget, notice));
      serialized = JSON.stringify(card);
      const excess = turnReplyCardRequestBytes(serialized, record.chatId) - TURN_REPLY_CARD_MAX_BYTES;
      if (excess <= 0) break;
      budget -= excess;
      // Leave a notice even if the answer/controls consume all available space.
      // The store handles an oversized final answer with its existing file path.
      setProcessPreview({ content: notice, shownTools: 0 });
      if (budget <= 0) serialized = JSON.stringify(card);
    }
  }
  return serialized;
}

export function replyCardPresentation(config: Pick<BotConfig, 'thinkingCard' | 'thinkingCardToolResult' | 'noCotChats' | 'hiddenStreamingCardButtons'>, chatId: string): Pick<TurnReplyCardPresentation, 'showProcess' | 'showToolResults' | 'canStop'> {
  return {
    showProcess: config.thinkingCard !== false && !config.noCotChats?.includes(chatId),
    showToolResults: config.thinkingCardToolResult !== false,
    canStop: !config.hiddenStreamingCardButtons?.includes('stop'),
  };
}
