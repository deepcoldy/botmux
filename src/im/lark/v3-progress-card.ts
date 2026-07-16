/**
 * v3 run-level progress card.
 *
 * This is intentionally a pure renderer: the journal/envelope projection lives
 * in `workflows/v3/progress-projection.ts`, while daemon-side send/PATCH
 * lifecycle lives elsewhere.  Keeping the card on the projected allowlist is
 * also a data-boundary — goals, parameter values, error messages and local
 * paths never reach this renderer.
 */

import { config } from '../../config.js';
import type { V3ProgressView } from '../../workflows/v3/progress-projection.js';
import type { V3RunSaveActionValue } from './v3-run-save-card.js';

export interface V3ProgressCardOptions {
  /** Override the dashboard link (primarily for tests). */
  webDetailUrl?: string;
  /**
   * Pre-authorized action payloads prepared from the immutable run envelope.
   * The renderer never derives identity or nonces itself.
   */
  saveActions?: {
    chat: V3RunSaveActionValue;
  };
}

const MAX_INLINE_IDS = 5;

export function v3ProgressRunDetailUrl(runId: string): string {
  return `http://${config.dashboard.externalHost}:${config.dashboard.port}/#/v3/${encodeURIComponent(runId)}`;
}

/** Render one complete Feishu card body from the safe v3 progress projection. */
export function buildV3ProgressCard(
  view: V3ProgressView,
  options: V3ProgressCardOptions = {},
): string {
  const chrome = statusChrome(view.status);
  const completed = view.counts.done + view.counts.skipped + view.counts.cancelled;
  const webDetailUrl = options.webDetailUrl ?? v3ProgressRunDetailUrl(view.runId);
  const source = sourceLabel(view.source);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**状态**\n${chrome.emoji} ${chrome.label}` },
        },
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**进度**\n${completed} / ${view.counts.total} 节点完成`,
          },
        },
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**来源**\n${escapeMd(source)}` },
        },
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**Run ID**\n${escapeMd(view.runId)}` },
        },
      ],
    },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `更新时间：${formatUpdatedAt(view.updatedAt)}` }],
    },
  ];

  if (view.currentNodeIds.length > 0) {
    appendSection(elements, '🏃 当前节点', formatIdList(view.currentNodeIds));
  }

  if (view.waitingNodeIds.length > 0) {
    appendSection(elements, '⏸ 等待', formatIdList(view.waitingNodeIds));
  }

  if (view.loops.length > 0) {
    appendSection(
      elements,
      '🔁 循环',
      view.loops.map((loop) => {
        const effectiveMax = loop.maxIterations + loop.granted;
        const budget = effectiveMax > 0 ? ` / ${effectiveMax}` : '';
        const grant = loop.granted > 0 ? ` · 已追加 ${loop.granted} 轮` : '';
        const decision = loop.lastDecision ? ` · ${loopDecisionLabel(loop.lastDecision)}` : '';
        return `${escapeMd(loop.loopId)}：第 ${loop.iteration}${budget} 轮${grant}${decision}`;
      }).join('\n'),
    );
  }

  if (view.revisit.count > 0) {
    const refreshed = view.revisit.refreshedNodeIds.length > 0
      ? ` · 刷新 ${formatIdList(view.revisit.refreshedNodeIds)}`
      : '';
    appendSection(elements, '↩️ 回访', `${view.revisit.count} 次${refreshed}`);
  }

  if (view.issue) {
    const parts: string[] = [];
    if (view.issue.nodeId) parts.push(`节点 ${escapeMd(view.issue.nodeId)}`);
    if (view.issue.errorClass) parts.push(escapeMd(view.issue.errorClass));
    if (view.issue.errorCode) parts.push(`\`${escapeMd(view.issue.errorCode)}\``);
    appendSection(elements, '⚠️ 错误码', parts.length > 0 ? parts.join(' · ') : 'UNKNOWN');
  }

  if (view.uncertainHostEffectCount && view.uncertainHostEffectCount > 0) {
    appendSection(
      elements,
      '⚠️ 外部效果待核实',
      `流程已停止，但有 ${view.uncertainHostEffectCount} 个外部操作的最终状态无法确认。请在 Web 详情中核对，不要直接重试该节点。`,
    );
  }

  appendTerminalHint(elements, view);

  if (
    view.status === 'starting' ||
    view.status === 'running' ||
    view.status === 'waiting' ||
    view.status === 'blocked'
  ) {
    appendSection(elements, '停止运行', `\`/workflow cancel ${escapeMd(view.runId)}\``);
  }

  if (view.status === 'succeeded' && view.source.kind === 'ad_hoc' && options.saveActions) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '保存到本群' },
          type: 'primary',
          value: options.saveActions.chat,
        },
      ],
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Web 详情（需登录）' },
        type: 'default',
        multi_url: {
          url: webDetailUrl,
          pc_url: webDetailUrl,
          android_url: webDetailUrl,
          ios_url: webDetailUrl,
        },
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: chrome.template,
      title: { tag: 'plain_text', content: headerTitle(view, chrome) },
    },
    elements,
  });
}

function headerTitle(
  view: V3ProgressView,
  chrome: ReturnType<typeof statusChrome>,
): string {
  const title = sanitizePlainTitle(view.title);
  return title
    ? `${chrome.emoji} ${title} · ${chrome.label}`
    : `${chrome.emoji} Workflow v3 · ${chrome.label}`;
}

function appendSection(
  elements: Array<Record<string, unknown>>,
  title: string,
  content: string,
): void {
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${title}**\n${content}` },
  });
}

function appendTerminalHint(
  elements: Array<Record<string, unknown>>,
  view: V3ProgressView,
): void {
  if (view.status !== 'succeeded') return;

  if (view.source.kind === 'ad_hoc') {
    appendSection(
      elements,
      '保存复用',
      `\`/workflow save ${escapeMd(view.runId)} [名称]\``,
    );
  } else if (view.source.kind === 'saved_definition') {
    appendSection(
      elements,
      '再次运行',
      `来源：${escapeMd(view.source.workflowId)} · v${view.source.humanVersion}\n` +
        `\`/workflow run ${escapeMd(view.source.workflowId)}\``,
    );
  }
}

function sourceLabel(source: V3ProgressView['source']): string {
  switch (source.kind) {
    case 'ad_hoc': return '即兴编排';
    case 'saved_definition': return `已保存 · ${source.workflowId} · v${source.humanVersion}`;
    case 'manual_cli': return '本地 CLI';
    case 'legacy_v3': return '旧版 v3';
  }
}

function statusChrome(status: V3ProgressView['status']): {
  emoji: string;
  label: string;
  template: string;
} {
  switch (status) {
    case 'starting': return { emoji: '⏳', label: '准备中', template: 'blue' };
    case 'running': return { emoji: '🔄', label: '运行中', template: 'blue' };
    case 'cancelling': return { emoji: '⏹', label: '取消中', template: 'orange' };
    case 'cancelled': return { emoji: '⏹', label: '已取消', template: 'grey' };
    case 'waiting': return { emoji: '⏸', label: '等待中', template: 'orange' };
    case 'blocked': return { emoji: '🚧', label: '已阻塞', template: 'orange' };
    case 'succeeded': return { emoji: '✅', label: '已完成', template: 'green' };
    case 'failed': return { emoji: '❌', label: '失败', template: 'red' };
  }
}

function loopDecisionLabel(decision: NonNullable<V3ProgressView['loops'][number]['lastDecision']>): string {
  switch (decision) {
    case 'exit': return '已退出';
    case 'continue': return '继续';
    case 'exhausted': return '轮次耗尽';
  }
}

function formatIdList(ids: readonly string[]): string {
  const visible = ids.slice(0, MAX_INLINE_IDS).map(escapeMd);
  const remaining = ids.length - visible.length;
  return `${visible.join('、')}${remaining > 0 ? ` 等 ${ids.length} 个` : ''}`;
}

function formatUpdatedAt(iso: string): string {
  // Projection emits an ISO timestamp.  Keep it timezone-explicit and avoid
  // host-locale output so PATCHes/tests are deterministic across machines.
  return escapePlainText(
    iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z'),
  );
}

function sanitizePlainTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Plain text cannot inject markdown, but line/control characters can still
  // distort the header. Collapse them, then truncate by Unicode code point so
  // an emoji/surrogate pair is never cut in half.
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length <= 60 ? normalized : `${chars.slice(0, 60).join('')}…`;
}

/** Escape user-controlled identifiers in Lark markdown fields. */
function escapeMd(value: string): string {
  return value.replace(/[\\*_~`\[\]<>]/g, (char) => `\\${char}`);
}

/** Plain-text card fields do not parse markdown but must not accept newlines. */
function escapePlainText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}
