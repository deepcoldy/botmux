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

const RUN_ID_CHAR = /[A-Za-z0-9._-]/;

function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

/**
 * The card JSON (as `GET /im/v1/messages/:id` with
 * `card_msg_content_type=user_card_content` returns it) is a launch root card
 * of exactly `runId`: some text of it carries the signature
 * 「botmux · 工作流 <runId>」with `runId` as a whole word (a longer run id that
 * merely starts with it does not count).
 */
export function isLaunchRootCardOf(rawContent: unknown, runId: string): boolean {
  if (typeof rawContent !== 'string' || !runId) return false;
  let card: unknown;
  try { card = JSON.parse(rawContent); } catch { return false; }
  const needle = `botmux · 工作流 ${runId}`;
  for (const text of stringsOf(card)) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const next = text[at + needle.length];
      if (next === undefined || !RUN_ID_CHAR.test(next)) return true;
      from = at + 1;
    }
  }
  return false;
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
