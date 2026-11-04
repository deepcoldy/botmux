/**
 * 拉群开始 (design 2026-11-03 workflow-dashboard-orchestration §4.5 第 3、4 步,
 * E6/E7): the main topic's root card and the summary posted after the clarify
 * session moved in.
 *
 * - The ROOT CARD is a top-level message of the new topic group, which makes
 *   it a topic root by itself (no bot @-mentions itself). Workflow title,
 *   initiator, node count; the signature row carries the「工作流 ›」entry.
 *   After 「放弃」 it is updated in place to say so.
 * - The SUMMARY is a plain-text reply in that topic: goal, the confirmed
 *   spec's main points, the flow link. Text written by people or the model
 *   is never rendered as markdown.
 *
 * Pure renderers: no IO.
 */

import type { LaunchRootCardView, LaunchSummaryView } from '../../workflows/v3/draft-launch.js';
import { workflowSignatureRow, type WorkflowSidebarEntryLink } from './workflow-sidebar-entry.js';

function plain(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

function md(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,128}$/;

/** The main topic's root card (schema 2.0, patchable). */
export function buildV3LaunchRootCard(view: LaunchRootCardView, entry?: WorkflowSidebarEntryLink): string {
  const elements: Array<Record<string, unknown>> = [];
  // The initiator's open_id is the main bot's own (it sends this card).
  elements.push(OPEN_ID_RE.test(view.initiatorOpenId)
    ? md(`发起人：<at id=${view.initiatorOpenId}></at>`)
    : plain('发起人：未知'));
  elements.push(plain(`节点数：${view.nodeCount}`));
  if (view.abandoned) {
    elements.push(plain('这次启动已放弃：这个群保留，工作流不会再在这里启动。'));
  } else {
    elements.push(plain('这是工作流的主话题：进度、审批和运行中的调整都在这里。'));
  }
  elements.push({ tag: 'hr' });
  elements.push(workflowSignatureRow(md(`<font color='grey'>botmux · 工作流 ${view.runId.replace(/[^A-Za-z0-9._-]/g, '')}</font>`), entry));
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      template: view.abandoned ? 'grey' : 'blue',
      title: { tag: 'plain_text', content: `🧭 工作流「${view.title.slice(0, 120)}」${view.abandoned ? '（已放弃）' : ''}` },
    },
    body: { direction: 'vertical', elements },
  });
}

/** The summary text replied into the main topic. `flowUrl`: the run page. */
export function buildV3LaunchSummaryText(view: LaunchSummaryView, flowUrl?: string): string {
  const lines = [`工作流「${view.title}」已拉群，下面是确认过的需求：`, '', `目标：${view.goal.slice(0, 2000)}`];
  if (view.requirement && view.requirement !== view.goal) lines.push(`需求：${view.requirement}`);
  if (view.nodes.length > 0) {
    lines.push('', '要点：');
    for (const node of view.nodes) lines.push(`- ${node.id}：${node.goal}`);
  }
  if (view.sessionNote) lines.push('', view.sessionNote);
  if (flowUrl) lines.push('', `流程图：${flowUrl}`);
  return lines.join('\n');
}
