/**
 * 「工作流 ›」入口（设计 2026-11-03 §11.2）：工作流任务消息签名行最右侧的一个小按钮，
 * 点开看这个 run 的实时流程图。
 *
 * - 只出现在「节点交给群里的 Bot 执行」的 run 上（run.json 冻结 nodeExecutor='bot'）。调用方
 *   拿不到这一前提、或拿不到 Dashboard 地址时传 undefined，卡片逐字节保持原样。
 * - 链接不带任何凭证，按本机 Dashboard 有没有可用的飞书 H5 免登分两种：
 *   - 有：`<Dashboard 地址>/workflow/<主 Bot appId>/<runId>`，PC 走品牌感知的 sidebar AppLink
 *     在飞书侧边栏打开（侧边栏里靠 H5 免登确认身份），手机端不认 mode，给原链接；谁能看什么
 *     由 Dashboard 按 D6 判；
 *   - 没有：侧边栏是独立的浏览器环境，带不过去 Dashboard 登录态，只会落到登录页；改为在浏览器
 *     里打开 Dashboard 的 `/#/workflows/<runId>`，和进度卡原来的「Web 详情」一样。
 * - 按钮放进签名行（`botmux_reply_actions` 那一行）最右侧一列，与 `attachOncallGroupButton`
 *   往右侧加一列同一个做法；卡片没有签名行就不加（纯文本 / post / 流式卡本来就没有）。
 */

import type { Locale } from '../../i18n/index.js';
import { sidebarAppLink } from '../../core/decision-board/model.js';
import { workflowSidebarEntryPath } from '../../core/workflow-sidebar-link.js';
import type { Brand } from './lark-hosts.js';
import { buildReplyCardChromeRow, REPLY_CARD_ACTIONS_ELEMENT_ID } from './reply-card-actions.js';
import {
  REPLY_CARD_FOOTER_ELEMENT_ID,
  WORKFLOW_SIDEBAR_ENTRY_ELEMENT_ID,
  WORKFLOW_SIDEBAR_ENTRY_LABEL,
} from './reply-card-footer-signature.js';

export { WORKFLOW_SIDEBAR_ENTRY_ELEMENT_ID };

export interface WorkflowSidebarEntryLink {
  /** 网页链接：侧边栏入口时是手机端按钮目标，浏览器入口时是唯一目标。 */
  url: string;
  /** 飞书侧边栏 AppLink（PC 按钮目标）；只有本机配了 H5 免登时才有。 */
  appLink?: string;
  locale?: Locale;
}

/** 拿不到 Dashboard 地址或 id 不合法时返回 undefined（不出按钮）。 */
export function workflowSidebarEntryLink(input: {
  dashboardOrigin: string | undefined;
  mainLarkAppId: string;
  runId: string;
  brand: Brand;
  /** 本机 Dashboard 有可用的飞书 H5 免登（`dashboardH5LoginAvailable()`）。 */
  sidebar: boolean;
  locale?: Locale;
}): WorkflowSidebarEntryLink | undefined {
  const path = workflowSidebarEntryPath(input.mainLarkAppId, input.runId);
  if (!input.dashboardOrigin || !path) return undefined;
  let origin: string;
  try {
    const parsed = new URL(input.dashboardOrigin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    origin = parsed.origin;
  } catch {
    return undefined;
  }
  const locale = input.locale ? { locale: input.locale } : {};
  if (!input.sidebar) return { url: `${origin}/#/workflows/${input.runId}`, ...locale };
  const url = `${origin}${path}`;
  return { url, appLink: sidebarAppLink(url, input.brand), ...locale };
}

/**
 * 子 Bot 在节点落点的回复卡（§5.5）：只有登记了工作流交接的节点会话（session 上有
 * `workflowNode` 标记，标记只来自已核验的 bot 执行模式交接）才带入口；普通会话一律没有。
 *
 * ⚠️ 目前只有节点话题落点：节点会话就是那个话题的会话，标记一直留着、一直带入口，正合 §5.5。
 * 主话题落点（设计 PR 5b）会把交接交给子 Bot 在主话题里**复用的已有会话**，现在没有任何地方
 * 在 attempt 结束时清掉标记——5b 必须二选一：attempt 结束（成功 / 受阻 / 取消 / 被替代）时清
 * 掉这个标记，或在这里按 attempt 是否仍在进行判断，否则这个会话之后的所有回复都会一直带入口。
 */
export function workflowNodeSessionEntry(
  marker: { runId: string; orchestratorAppId: string } | undefined,
  entryFor: (mainLarkAppId: string, runId: string) => WorkflowSidebarEntryLink | undefined,
): WorkflowSidebarEntryLink | undefined {
  return marker ? entryFor(marker.orchestratorAppId, marker.runId) : undefined;
}

function entryLabel(link: WorkflowSidebarEntryLink): string {
  return WORKFLOW_SIDEBAR_ENTRY_LABEL[link.locale === 'en' ? 'en' : 'zh'];
}

/** schema 2.0 卡片里的入口按钮。 */
export function buildWorkflowSidebarEntryButton(link: WorkflowSidebarEntryLink): Record<string, unknown> {
  return {
    tag: 'button',
    element_id: WORKFLOW_SIDEBAR_ENTRY_ELEMENT_ID,
    text: { tag: 'plain_text', content: entryLabel(link) },
    type: 'default',
    size: 'small',
    behaviors: [link.appLink
      ? { type: 'open_url', default_url: link.url, pc_url: link.appLink }
      : { type: 'open_url', default_url: link.url }],
  };
}

/** schema 1.0 卡片（进度卡）里的入口按钮。 */
export function buildWorkflowSidebarEntryV1Button(link: WorkflowSidebarEntryLink): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: entryLabel(link) },
    type: 'default',
    multi_url: link.appLink
      ? { url: link.appLink, pc_url: link.appLink, android_url: link.url, ios_url: link.url }
      : { url: link.url, pc_url: link.url, android_url: link.url, ios_url: link.url },
  };
}

/**
 * 卡片自带的签名行（工作流节点卡 / 回报卡 / 主 Bot 自己执行的交接卡）：没有入口时原样返回
 * 那个签名元素；有入口时与按钮排进同一行，按钮在最右侧。
 */
export function workflowSignatureRow(
  signature: Record<string, unknown>,
  link: WorkflowSidebarEntryLink | undefined,
): Record<string, unknown> {
  if (!link) return signature;
  return buildReplyCardChromeRow({ footer: { element: signature }, controls: [buildWorkflowSidebarEntryButton(link)] })!;
}

function hasEntry(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasEntry);
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  if (node.element_id === WORKFLOW_SIDEBAR_ENTRY_ELEMENT_ID) return true;
  return hasEntry(node.elements) || hasEntry(node.columns);
}

/**
 * 给已经组装好的 schema 2.0 回复卡加入口：并进签名行（`botmux_reply_actions`）最右侧一列；
 * 签名行只有一个页脚元素时，把它与按钮合成同一行。没有入口、卡片没有签名行、或已经加过时
 * 原样返回同一个字符串。
 */
export function attachWorkflowSidebarEntry(raw: string, link: WorkflowSidebarEntryLink | undefined): string {
  if (!link) return raw;
  let card: any;
  try { card = JSON.parse(raw); } catch { return raw; }
  const elements = card?.body?.elements;
  if (!Array.isArray(elements) || hasEntry(elements)) return raw;
  const button = buildWorkflowSidebarEntryButton(link);
  const chromeRow = elements.find((item: any) => item?.element_id === REPLY_CARD_ACTIONS_ELEMENT_ID && Array.isArray(item.columns));
  if (chromeRow) {
    chromeRow.columns.push({ tag: 'column', width: 'auto', vertical_align: 'center', elements: [button] });
    return JSON.stringify(card);
  }
  const footerIndex = elements.findIndex((item: any) => item?.element_id === REPLY_CARD_FOOTER_ELEMENT_ID && item.tag === 'markdown');
  if (footerIndex < 0) return raw;
  elements[footerIndex] = buildReplyCardChromeRow({ footer: { element: elements[footerIndex] }, controls: [button] });
  return JSON.stringify(card);
}
