/**
 * `/dismiss` 的确认卡、点击后的「已提交」卡，以及解散后的私聊回执卡。
 *
 * 确认按钮把 `confirmation_state` 原样带回，card-handler 再以
 * `/dismiss --confirm=<state>` 重入 handleCommand —— 校验、关会话、解散群只有一条路径。
 * 回执卡的清理按钮同理只带清理任务 id，删除走 `/cleanup-wt` 同一个 runWorktreeCleanupJob。
 */
import { t, type Locale } from '../../i18n/index.js';
import type { WorktreeSafetyStatus } from '../../services/git-worktree.js';
import type { WorktreeCleanupOffer, WorktreeCleanupRun } from '../../core/worktree-cleanup-run.js';
import { TABLE_AUTO_ROW_STYLE } from './table-style.js';

export const DISMISS_CONFIRM_ACTION = 'dismiss_confirm';

const card = (title: string, template: string, elements: unknown[]): Record<string, unknown> => ({
  schema: '2.0',
  config: { update_multi: true, wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: title }, template },
  body: { direction: 'vertical', elements },
});

/** 卡片表格一行：哪个 Bot、哪个会话（已由调用方渲染成纯文本）。 */
export interface DismissCardRow {
  bot: string;
  task: string;
}

export function buildDismissConfirmCard(args: {
  chatId: string;
  invokerOpenId: string;
  confirmationState: string;
  rows: DismissCardRow[];
  loc: Locale;
}): string {
  const { loc, rows } = args;
  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: rows.length > 0
        ? t('cmd.dismiss.card_steps', { count: String(rows.length) }, loc)
        : t('cmd.dismiss.card_steps_no_session', undefined, loc),
    },
  ];
  if (rows.length > 0) {
    elements.push({
      tag: 'table',
      page_size: 10,
      ...TABLE_AUTO_ROW_STYLE,
      columns: [
        { name: 'bot', display_name: t('cmd.dismiss.col_bot', undefined, loc), data_type: 'text', width: '140px' },
        { name: 'task', display_name: t('cmd.dismiss.col_session', undefined, loc), data_type: 'text', width: 'auto' },
      ],
      rows,
    });
  }
  elements.push(
    { tag: 'hr' },
    { tag: 'markdown', content: t('cmd.dismiss.card_keep', undefined, loc) },
    { tag: 'markdown', content: `<font color='grey'>${t('cmd.dismiss.card_note', undefined, loc)}</font>` },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t('cmd.dismiss.confirm_button', undefined, loc) },
      type: 'danger',
      behaviors: [{
        type: 'callback',
        value: {
          action: DISMISS_CONFIRM_ACTION,
          chat_id: args.chatId,
          invoker_open_id: args.invokerOpenId,
          confirmation_state: args.confirmationState,
        },
      }],
    },
  );
  return JSON.stringify(card(`⚠️ ${t('cmd.dismiss.card_title', undefined, loc)}`, 'red', elements));
}

/** 点击确认后原地替换：去掉按钮，防止重复点击，并说明结果会从哪里来。 */
export function buildDismissSubmittedCard(loc: Locale): Record<string, unknown> {
  return card(`⏳ ${t('cmd.dismiss.card_title', undefined, loc)}`, 'grey',
    [{ tag: 'markdown', content: t('cmd.dismiss.submitted', undefined, loc) }]);
}

// ─── 解散后的私聊回执：可一键清理这些会话用过的 worktree ──────────────────────

export const DISMISS_CLEANUP_WT_ACTION = 'dismiss_cleanup_wt';

function safetyLine(safety: WorktreeSafetyStatus, loc: Locale): string {
  return [
    safety.uncommittedCount > 0
      ? t('cmd.close.worktree_check_uncommitted_warn', { n: String(safety.uncommittedCount) }, loc)
      : t('cmd.close.worktree_check_uncommitted_ok', undefined, loc),
    safety.ignoredCount > 0
      ? t('cmd.close.worktree_check_ignored_warn', { n: String(safety.ignoredCount) }, loc)
      : t('cmd.close.worktree_check_ignored_ok', undefined, loc),
    safety.ahead > 0
      ? t('cmd.close.worktree_check_ahead_warn', { n: String(safety.ahead) }, loc)
      : t('cmd.close.worktree_check_ahead_ok', undefined, loc),
  ].join('　');
}

/** 私聊回执（被解散的群收不到）：列出 worktree 与安全检查，按钮只带清理任务 id。 */
export function buildDismissReceiptCard(args: {
  offers: readonly WorktreeCleanupOffer[];
  invokerOpenId: string;
  loc: Locale;
}): string {
  const { loc, offers } = args;
  const ready = offers.filter((o): o is Extract<WorktreeCleanupOffer, { status: 'ready' }> => o.status === 'ready');
  const elements: unknown[] = [{ tag: 'markdown', content: t('cmd.dismiss.receipt_body', undefined, loc) }];
  if (offers.length > 0) {
    const lines = offers.map(o => o.status === 'ready'
      ? `\`${o.dir}\`\n${safetyLine(o.safety, loc)}`
      : o.status === 'busy'
        ? t('cmd.dismiss.receipt_busy', { path: o.dir, count: String(o.activeCount) }, loc)
        : t('cmd.dismiss.receipt_unchecked', { path: o.dir, error: o.error }, loc));
    elements.push(
      { tag: 'hr' },
      { tag: 'markdown', content: `**🗂️ ${t('cmd.dismiss.receipt_worktrees', undefined, loc)}**\n${lines.join('\n\n')}` },
    );
  }
  if (ready.length > 0) {
    const risky = ready.some(o => o.safety.dirty || o.safety.ahead > 0);
    elements.push(
      { tag: 'markdown', content: `<font color='grey'>${t('cmd.dismiss.receipt_effect', undefined, loc)}</font>` },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('cmd.dismiss.cleanup_button', { count: String(ready.length) }, loc) },
        type: risky ? 'danger' : 'primary',
        behaviors: [{
          type: 'callback',
          value: {
            action: DISMISS_CLEANUP_WT_ACTION,
            job_ids: ready.map(o => o.jobId).join(','),
            invoker_open_id: args.invokerOpenId,
          },
        }],
      },
    );
  }
  return JSON.stringify(card(`✅ ${t('cmd.dismiss.receipt_title', undefined, loc)}`, 'green', elements));
}

/** 点击清理后原地替换：去掉按钮，防止重复点击。 */
export function buildWorktreeCleanupRunningCard(loc: Locale): Record<string, unknown> {
  return card(`⏳ ${t('cmd.dismiss.cleanup_title', undefined, loc)}`, 'grey',
    [{ tag: 'markdown', content: t('cmd.dismiss.cleanup_running', undefined, loc) }]);
}

export function buildWorktreeCleanupResultCard(
  results: ReadonlyArray<{ id: string; run: WorktreeCleanupRun }>,
  loc: Locale,
): string {
  const lines = results.map(({ id, run }) => {
    switch (run.status) {
      case 'removed': return t('cmd.dismiss.cleanup_removed', { path: run.dir }, loc);
      case 'not_found': return t('cmd.dismiss.cleanup_gone', undefined, loc);
      case 'unreadable': return t('cmd.dismiss.cleanup_unreadable', { error: run.error }, loc);
      case 'identity_changed': return t('cmd.dismiss.cleanup_identity_changed', { path: run.dir }, loc);
      case 'busy': return t('cmd.dismiss.cleanup_busy', { path: run.dir, count: String(run.activeCount) }, loc);
      case 'changed': return t('cmd.dismiss.cleanup_changed', { path: run.dir }, loc);
      case 'failed': return t('cmd.dismiss.cleanup_failed', { path: run.dir, error: run.error, id }, loc);
    }
  });
  const allRemoved = results.every(r => r.run.status === 'removed');
  return JSON.stringify(card(`🧹 ${t('cmd.dismiss.cleanup_title', undefined, loc)}`, allRemoved ? 'green' : 'orange',
    [{ tag: 'markdown', content: lines.join('\n') }]));
}
