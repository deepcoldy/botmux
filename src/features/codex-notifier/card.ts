import type { CodexTaskCompletedEvent, CodexTaskStatus } from './types.js';
import { canOpenCodexAppThread, isCodexAppThreadId } from './app-opener.js';

const STATUS_META: Record<CodexTaskStatus, { label: string; template: string; title: string }> = {
  completed: { label: '已完成', template: 'green', title: '🤖 BotMux：💬 Codex 任务完成了，快来看看～' },
  failed: { label: '失败', template: 'red', title: '🤖 BotMux：⚠️ Codex 任务失败了' },
  cancelled: { label: '已取消', template: 'orange', title: '🤖 BotMux：⏹️ Codex 任务已取消' },
};
function safeSingleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : normalized;
}

function safeMultiline(value: string, maxLength: number): string {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(normalized);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : normalized;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_\[\]\(\)<>@~]/g, '\\$&');
}

/**
 * 构建不含终端链接或写令牌的完成通知卡。接管回调只携带 eventId，服务端据账本取真实事件。
 */
export function buildCodexCompletionCard(
  event: CodexTaskCompletedEvent,
  options: { platform?: NodeJS.Platform } = {},
): string {
  const meta = STATUS_META[event.status];
  const isSideConversation = event.conversationKind === 'side';
  const canOpenApp = !isSideConversation
    && event.clientSurface === 'codex-app'
    && isCodexAppThreadId(event.threadId)
    && canOpenCodexAppThread(event.threadId, options.platform);
  const clientLabel = event.clientSurface === 'codex-app'
    ? isSideConversation ? 'Codex App Side Chat' : 'Codex App'
    : event.clientSurface === 'codex-cli'
    ? 'Codex CLI'
    : 'Codex App/CLI';
  const project = safeSingleLine(event.cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'Codex App', 80);
  const nativeTitle = safeSingleLine(event.title ?? '', 180);
  const conversationTitle = nativeTitle.startsWith(`${project} · `)
    ? nativeTitle
    : nativeTitle && nativeTitle !== project
    ? `${project} · ${nativeTitle}`
    : nativeTitle || project;
  const finalPreview = safeMultiline(event.finalPreview ?? '', 6500);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: `💬 **会话名**: ${escapeMarkdownText(conversationTitle)}`,
    },
    {
      tag: 'markdown',
      content: `Agent: \`Codex\`；载体: \`${clientLabel}\`；状态: \`${meta.label}\``,
      margin: '4px 0px 0px 0px',
    },
  ];

  if (finalPreview) {
    elements.push(
      { tag: 'hr' },
      { tag: 'markdown', content: '📝 **AI 回复**' },
      {
        tag: 'div',
        element_id: 'main_content',
        text: {
          tag: 'plain_text',
          content: finalPreview,
          lines: 30,
        },
        margin: '4px 0px 0px 0px',
      },
    );
  }

  const actionColumns: Array<Record<string, unknown>> = [];
  if (!isSideConversation) {
    actionColumns.push({
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        type: 'primary',
        text: { tag: 'plain_text', content: '在飞书中继续处理' },
        behaviors: [{
          type: 'callback',
          value: { action: 'codex_notifier_continue', event_id: event.eventId },
        }],
      }],
    });
  }
  if (canOpenApp) {
    actionColumns.push({
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        type: 'default',
        text: { tag: 'plain_text', content: '打开 Codex App ↗' },
        behaviors: [{
          type: 'callback',
          value: { action: 'codex_notifier_open_app', event_id: event.eventId },
        }],
      }],
    });
  }

  if (actionColumns.length > 0) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: '8px',
      margin: '8px 0px 0px 0px',
      columns: actionColumns,
    });
  }
  elements.push({
      tag: 'markdown',
      text_size: 'notation',
      content: isSideConversation
        ? '🤖 Side Chat 是临时会话；BotMux 会同步结果，但暂不提供接管或回到原会话。'
        : canOpenApp
        ? '🤖 点击后会请求运行 BotMux 的 Mac 打开原 Codex App 会话。'
        : '🤖 BotMux 已同步任务结果；请先点击按钮接管，再回复卡片话题继续对话。',
      margin: '4px 0px 0px 0px',
    });

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: meta.template,
      title: { tag: 'plain_text', content: meta.title },
    },
    body: { direction: 'vertical', elements },
  });
}

/**
 * 构建回调完成后的 V2 结果卡，确保可安全替换原始完成通知卡。
 */
export function buildCodexNotifierResultCard(
  title: string,
  content: string,
  template: 'blue' | 'green' | 'red',
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      direction: 'vertical',
      elements: [{
        tag: 'markdown',
        content: escapeMarkdownText(content),
      }],
    },
  };
}
