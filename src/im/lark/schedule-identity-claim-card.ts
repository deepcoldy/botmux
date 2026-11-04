/**
 * 定时任务身份认领卡（发卡与回调见 core/schedule-identity-claim）。
 *
 * 四种状态：
 *   - pending：任务到点时没有可用身份。写清是哪个任务、为什么要认领、认领后会以
 *     认领人身份跑什么（提示词摘要），只有一个「认领」按钮。
 *   - claimed：已认领。显示认领人和认领时间，按钮是「改为我认领」「重新执行」。
 *   - resolved：任务现在按创建人跑（没人认领前创建人恢复了权限，或 Dashboard 编辑记了新
 *     创建人、清掉了认领），无需认领，去掉按钮。
 *   - gone：任务已删除，去掉按钮。
 *
 * 按钮 value 只带任务 id 和 `claim_rev`（渲染这张卡时任务当前认领的时间，没有认领为
 * 空串），用来在回调里做「卡片是不是旧的」比较。身份一律取回调的 operator，value 里
 * 从不放 open_id / union_id。
 */
import { t, type Locale } from '../../i18n/index.js';
import type { ScheduleIdentityGapReason } from '../../services/schedule-authority-store.js';
import { escapeLarkMd } from './dash-card-common.js';

export const SCHEDULE_IDENTITY_ACTION_PREFIX = 'schedule_identity_';
export const SCHEDULE_IDENTITY_CLAIM_ACTION = 'schedule_identity_claim';
export const SCHEDULE_IDENTITY_RECLAIM_ACTION = 'schedule_identity_reclaim';
export const SCHEDULE_IDENTITY_RERUN_ACTION = 'schedule_identity_rerun';

/** 提示词摘要上限：够认领人看清要做什么，又不把卡片撑成整篇提示词。 */
const PROMPT_EXCERPT_CHARS = 300;
const PROMPT_EXCERPT_LINES = 8;
const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;

export interface ScheduleClaimCardTask {
  id: string;
  name: string;
  /** 给人看的执行时间表（parsed.display，缺省用原始 schedule）。 */
  schedule: string;
  prompt: string;
}

interface CommonInput {
  task: ScheduleClaimCardTask;
  /** 本 Bot 身份鉴权管着的工具，原样来自 triggerUserAuth.tools。 */
  tools: readonly string[];
  timeZone: string;
  locale: Locale;
}

export type ScheduleClaimCardInput =
  | (CommonInput & {
    state: 'pending';
    reason: ScheduleIdentityGapReason;
    /** 失去权限的创建人 / 认领人（reason 不是 no_creator 时）。 */
    lapsedOpenId?: string;
    /** 任务当前记录的认领时间（认领人失权时仍在），作为按钮的 claim_rev。 */
    currentClaimedAt?: string;
    lastFiredAt: string;
  })
  | (CommonInput & {
    state: 'claimed';
    claim: { openId: string; claimedAt: string };
  })
  | (CommonInput & {
    state: 'resolved';
    creatorOpenId: string;
  })
  | { state: 'gone'; taskId: string; locale: Locale };

const card = (title: string, template: string, elements: unknown[]): Record<string, unknown> => ({
  schema: '2.0',
  config: { update_multi: true, wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: title }, template },
  body: { direction: 'vertical', elements },
});

function mention(openId: string | undefined): string {
  if (openId && OPEN_ID.test(openId)) return `<at id=${openId}></at>`;
  return escapeLarkMd(openId ?? '—');
}

function formatTime(iso: string, timeZone: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeLarkMd(iso);
  return date.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { timeZone, hour12: false });
}

function toolsLabel(tools: readonly string[], locale: Locale): string {
  const labels = tools.map(tool => tool === 'lark-cli' ? 'lark-cli --as user' : tool);
  return escapeLarkMd(labels.join(locale === 'en' ? ', ' : '、'));
}

/** 提示词摘要：按字符截断（不切坏多字节字符），行数也设上限；逐行转义、逐行着色
 *  （一个 font 标签跨多行时飞书渲染不稳定）。 */
export function promptExcerpt(prompt: string): string {
  const chars = Array.from(prompt.trim());
  let lines = chars.slice(0, PROMPT_EXCERPT_CHARS).join('').split(/\r?\n/);
  let truncated = chars.length > PROMPT_EXCERPT_CHARS;
  if (lines.length > PROMPT_EXCERPT_LINES) {
    lines = lines.slice(0, PROMPT_EXCERPT_LINES);
    truncated = true;
  }
  if (truncated) lines[lines.length - 1] += ' …';
  return lines.map(line => line.trim() ? `<font color='grey'>${escapeLarkMd(line)}</font>` : '').join('\n');
}

function button(label: string, type: 'primary' | 'default', action: string, taskId: string, claimRev: string): unknown {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value: { action, task_id: taskId, claim_rev: claimRev } }],
  };
}

function taskLines(input: CommonInput): string {
  return t('scheduler.claim.task_line', {
    name: escapeLarkMd(input.task.name),
    id: input.task.id,
    schedule: escapeLarkMd(input.task.schedule),
  }, input.locale);
}

function promptBlock(input: CommonInput): unknown {
  return {
    tag: 'markdown',
    content: `${t('scheduler.claim.prompt_label', undefined, input.locale)}\n${promptExcerpt(input.task.prompt)}`,
  };
}

export function buildScheduleIdentityClaimCard(input: ScheduleClaimCardInput): Record<string, unknown> {
  if (input.state === 'gone') {
    return card(t('scheduler.claim.title_gone', undefined, input.locale), 'grey', [
      { tag: 'markdown', content: t('scheduler.claim.gone_body', { id: input.taskId }, input.locale) },
    ]);
  }
  const loc = input.locale;
  const tools = toolsLabel(input.tools, loc);
  if (input.state === 'pending') {
    const reason = input.reason === 'creator_revoked'
      ? t('scheduler.claim.reason_creator_revoked', { who: mention(input.lapsedOpenId) }, loc)
      : input.reason === 'claimant_revoked'
        ? t('scheduler.claim.reason_claimant_revoked', { who: mention(input.lapsedOpenId) }, loc)
        : t('scheduler.claim.reason_no_creator', undefined, loc);
    return card(t('scheduler.claim.title_pending', undefined, loc), 'orange', [
      {
        tag: 'markdown',
        content: [
          taskLines(input),
          t('scheduler.claim.why', { reason, tools }, loc),
          t('scheduler.claim.last_fired', { time: formatTime(input.lastFiredAt, input.timeZone, loc) }, loc),
          t('scheduler.claim.effect_pending', { tools }, loc),
        ].join('\n'),
      },
      promptBlock(input),
      { tag: 'hr' },
      { tag: 'markdown', content: `<font color='grey'>${t('scheduler.claim.note_pending', undefined, loc)}</font>` },
      button(t('scheduler.claim.button_claim', undefined, loc), 'primary',
        SCHEDULE_IDENTITY_CLAIM_ACTION, input.task.id, input.currentClaimedAt ?? ''),
    ]);
  }
  if (input.state === 'resolved') {
    return card(t('scheduler.claim.title_resolved', undefined, loc), 'grey', [
      {
        tag: 'markdown',
        content: [
          taskLines(input),
          t('scheduler.claim.resolved_body', { who: mention(input.creatorOpenId) }, loc),
        ].join('\n'),
      },
      promptBlock(input),
    ]);
  }
  return card(t('scheduler.claim.title_claimed', undefined, loc), 'green', [
    {
      tag: 'markdown',
      content: [
        taskLines(input),
        t('scheduler.claim.claimed_by', {
          who: mention(input.claim.openId),
          time: formatTime(input.claim.claimedAt, input.timeZone, loc),
          tools,
        }, loc),
      ].join('\n'),
    },
    promptBlock(input),
    { tag: 'hr' },
    { tag: 'markdown', content: `<font color='grey'>${t('scheduler.claim.note_claimed', undefined, loc)}</font>` },
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        { tag: 'column', width: 'auto', elements: [button(t('scheduler.claim.button_reclaim', undefined, loc), 'default',
          SCHEDULE_IDENTITY_RECLAIM_ACTION, input.task.id, input.claim.claimedAt)] },
        { tag: 'column', width: 'auto', elements: [button(t('scheduler.claim.button_rerun', undefined, loc), 'primary',
          SCHEDULE_IDENTITY_RERUN_ACTION, input.task.id, input.claim.claimedAt)] },
      ],
    },
  ]);
}
