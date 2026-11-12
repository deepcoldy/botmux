/**
 * 项目群迁入会话通知与确认卡片（宿主直发至迁入话题，不经主控模型自由群发）。
 *
 * 设计约束：
 *   - 卡片只渲染宿主核验过的会话元数据（来源 Bot、会话摘要、迁入方式、看板状态与未登记原因），
 *     绝不拼入私聊 transcript、终端屏幕或工作目录。
 *   - 按钮 value 只携带路由定位字段（chat_id / root_id / source_app / source_session / route_rev / title），
 *     绝不放任何用户 open_id / union_id；点击人身份一律由飞书回调签名里的 operator 校验。
 */
import { safeScrubAndTruncate } from '../../services/insight/scrub.js';
import type { ProjectAttachmentSourceKind } from '../../services/project-workstream-attachments.js';
import { escapeLarkMd } from './dash-card-common.js';

export const PROJECT_IMPORT_CARD_ACTION_PREFIX = 'project_import_';
export const PROJECT_IMPORT_CONFIRM_ACTION = 'project_import_confirm';

export type ProjectImportUnattachedReason =
  | 'project_uninitialized'
  | 'pending_confirmation'
  | 'source_owner_unknown'
  | 'source_owner_authorization_required'
  | 'coordinator_owner_required'
  | 'source_unavailable';

export interface ProjectImportCardCommon {
  chatId: string;
  rootMessageId: string;
  sourceSessionId: string;
  sourceLarkAppId: string;
  sourceBotName?: string;
  sourceKind: ProjectAttachmentSourceKind;
  routeRevision: number;
  sessionTitle?: string;
}

export type ProjectImportCardInput =
  | (ProjectImportCardCommon & {
    state: 'pending';
    reason: ProjectImportUnattachedReason;
    canConfirm: boolean;
    proposedTitle?: string;
  })
  | (ProjectImportCardCommon & {
    state: 'registered';
    workstreamTitle: string;
    confirmedByOpenId?: string;
    registrationMode?: 'human_card' | 'human_turn' | 'coordinator_notice';
  })
  | {
    state: 'gone';
    detail?: string;
  };

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/u;
const FORBIDDEN_TITLES = new Set(['子任务', '子项目', '新对话', '新会话', '会话', 'New Chat', 'New Session', 'Untitled']);

function cleanSingleLine(raw: string | undefined, maxChars: number): string {
  const withoutBoilerplate = (raw ?? '')
    .replace(/^(Adopt:\s*|\[Relay\]\s*|\[迁入\]\s*)/iu, '')
    .replace(/^[#*>\-\s`]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const scrubbed = safeScrubAndTruncate(withoutBoilerplate, maxChars * 4).text
    .replace(/\s+/gu, ' ')
    .trim();
  const codePoints = Array.from(scrubbed);
  if (codePoints.length <= maxChars) return scrubbed;
  return `${codePoints.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

/** 生成满足 attach 标题约束（非空、非“子任务/子项目”、不超过 24 字）的默认子任务标题。 */
export function deriveImportWorkstreamTitle(input: {
  proposedTitle?: string;
  existingTitle?: string;
  sourceTitle?: string;
  recentSummary?: string;
  botName?: string;
  sessionId: string;
}): string {
  for (const candidate of [input.proposedTitle, input.existingTitle, input.sourceTitle, input.recentSummary]) {
    const cleaned = cleanSingleLine(candidate, 24);
    if (cleaned && !FORBIDDEN_TITLES.has(cleaned)) return cleaned;
  }
  const botPrefix = cleanSingleLine(input.botName, 10) || '迁入';
  const shortId = (input.sessionId || 'session').slice(0, 8);
  return cleanSingleLine(`${botPrefix}会话 ${shortId}`, 24) || `迁入会话 ${shortId}`;
}

function cardEnvelope(title: string, template: string, elements: unknown[]): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { direction: 'vertical', elements },
  };
}

function formatBotLabel(appId: string, botName?: string): string {
  const trimmed = cleanSingleLine(botName, 32);
  if (!trimmed || trimmed === appId) return `\`${escapeLarkMd(appId)}\``;
  return `${escapeLarkMd(trimmed)} (\`${escapeLarkMd(appId)}\`)`;
}

function formatSessionLine(input: ProjectImportCardCommon): string {
  const shortId = input.sourceSessionId.slice(0, 8);
  const titlePart = cleanSingleLine(input.sessionTitle, 40);
  const label = titlePart
    ? `${escapeLarkMd(titlePart)} · \`${escapeLarkMd(shortId)}\``
    : `\`${escapeLarkMd(input.sourceSessionId)}\``;
  return `**迁入会话**：${label}（方式：\`${escapeLarkMd(input.sourceKind)}\`，路由代次：\`#${input.routeRevision}\`）`;
}

function formatUnattachedReason(reason: ProjectImportUnattachedReason): string {
  switch (reason) {
    case 'project_uninitialized':
      return '项目未初始化，已通知主控：本群处于项目群协作模式但尚未创建项目记录，已自动通知主控先执行 `botmux project init` 初始化项目并登记看板。';
    case 'source_owner_unknown':
      return '源会话缺少主人身份记录（`source_owner_unknown`），主控无法在静默回合自动核验归属；需本人点击下方「确认登记」认领该会话并纳入项目看板。';
    case 'pending_confirmation':
      return '会话已迁入本项目群，等待纳入项目看板（主控处理中，本人也可直接点击下方「确认登记」立即登记）。';
    case 'source_owner_authorization_required':
      return '源会话归属其他成员（`source_owner_authorization_required`），当前主控无权直接登记；需源会话主人在本话题执行 `botmux project workstream grant` 获取授权码后再由主控登记。';
    case 'coordinator_owner_required':
      return '当前项目主控会话缺少明确的主人身份（`project_coordinator_owner_required`），请先由项目主人在群内 @主控 发起真人回合后再登记。';
    case 'source_unavailable':
      return '源会话当前已关闭、非普通话题会话或已迁离本话题，暂不可登记。';
  }
}

function confirmHintNote(reason: ProjectImportUnattachedReason): string {
  if (reason === 'source_owner_unknown') {
    return '点击「确认登记」即以当前点击人身份显式认领该无主会话，并同步写入项目置顶进度卡（全程留存审计记录）。';
  }
  return '点击「确认登记」立即将该话题纳入项目看板并同步置顶进度卡（留存审计记录）。';
}

export function buildProjectImportCard(input: ProjectImportCardInput): Record<string, unknown> {
  if (input.state === 'gone') {
    return cardEnvelope('项目会话迁入 · 卡片已失效', 'grey', [
      {
        tag: 'markdown',
        content: escapeLarkMd(input.detail || '目标项目群配置或源会话已变更，此卡片不再有效。'),
      },
    ]);
  }

  const baseLines = [
    `**来源 Bot**：${formatBotLabel(input.sourceLarkAppId, input.sourceBotName)}`,
    formatSessionLine(input),
  ];

  if (input.state === 'registered') {
    const modeLine = input.confirmedByOpenId && OPEN_ID.test(input.confirmedByOpenId)
      ? `**确认人**：<at id=${input.confirmedByOpenId}></at>`
      : input.registrationMode === 'coordinator_notice'
        ? '**登记方式**：同主人会话由主控通知回合自动登记，已同步项目置顶卡'
        : '**登记状态**：已完成登记并同步项目置顶卡';
    return cardEnvelope('项目会话迁入 · 已登记看板', 'green', [
      {
        tag: 'markdown',
        content: [
          ...baseLines,
          `**看板状态**：已登记项目看板（子任务：**${escapeLarkMd(cleanSingleLine(input.workstreamTitle, 24) || '迁入任务')}**）`,
          modeLine,
        ].join('\n'),
      },
    ]);
  }

  const headerTitle = input.reason === 'project_uninitialized'
    ? '项目会话迁入 · 项目未初始化，已通知主控'
    : input.canConfirm
      ? '项目会话迁入 · 待确认登记'
      : '项目会话迁入 · 尚未登记看板';
  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: [
        ...baseLines,
        '**看板状态**：尚未登记项目看板',
        `**原因说明**：${formatUnattachedReason(input.reason)}`,
      ].join('\n'),
    },
  ];

  if (input.canConfirm) {
    const proposed = input.proposedTitle ? cleanSingleLine(input.proposedTitle, 24) : undefined;
    const buttonValue: Record<string, string> = {
      action: PROJECT_IMPORT_CONFIRM_ACTION,
      chat_id: input.chatId,
      root_id: input.rootMessageId,
      source_app: input.sourceLarkAppId,
      source_session: input.sourceSessionId,
      route_rev: String(input.routeRevision),
      ...(proposed ? { title: proposed } : {}),
    };
    elements.push(
      { tag: 'hr' },
      { tag: 'markdown', content: `<font color='grey'>${escapeLarkMd(confirmHintNote(input.reason))}</font>` },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '确认登记' },
        type: 'primary',
        behaviors: [{ type: 'callback', value: buttonValue }],
      },
    );
  }

  return cardEnvelope(headerTitle, 'orange', elements);
}
