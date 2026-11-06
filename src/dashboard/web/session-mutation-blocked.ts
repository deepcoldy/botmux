import type { ProtectedSessionMutationReason } from '../../core/session-mutation-guard.js';

/**
 * 把 daemon「会话还有未处理完的任务，拒绝本次改动」的 409 回包翻成人话。
 *
 * `session_mutation_pending` / `codex_app_dispatch_pending` 来自 dashboard-ipc-server 的
 * rejectProtectedSessionMutation：保存 Agent 配置、重启会话前，只要有会话还压着已接收、
 * 但没送进 CLI 的输入（待办池、等选仓库、排队消息、Codex App 未落定的派发……）就整体拒绝。
 * 回包里的 blockingSessions 列出了是哪些会话、卡在什么；这里把它们说清楚，并告诉用户
 * 怎么办，而不是把错误码原样显示出来。
 */

type Translate = (key: string, params?: Record<string, string | number>) => string;

const BLOCKED_ERRORS = new Set(['session_mutation_pending', 'codex_app_dispatch_pending']);

/** 每个原因对应的文案键；两种排队消息对用户来说是同一件事，共用一条。 */
const REASON_KEYS: Record<ProtectedSessionMutationReason, string> = {
  queued_todo: 'sessionMutation.reasonQueuedTodo',
  repository_setup: 'sessionMutation.reasonRepositorySetup',
  activation_head: 'sessionMutation.reasonActivationHead',
  activation_tail: 'sessionMutation.reasonQueuedMessages',
  principal_lane_tail: 'sessionMutation.reasonQueuedMessages',
  initial_start: 'sessionMutation.reasonInitialStart',
  codex_app_dispatch: 'sessionMutation.reasonCodexAppDispatch',
};

/** 这两种状态不会自己结束，要用户动手；其余的等消息送达后自然解除。 */
const NEEDS_USER_ACTION = new Set(['queued_todo', 'repository_setup']);

/** 列表最多点名几个会话，其余折叠成「等 N 个会话」。 */
const MAX_LISTED_SESSIONS = 3;
const MAX_TITLE_CHARS = 30;

interface BlockingSession {
  sessionId: string;
  title: string;
  reasons: string[];
}

function parseBlockingSessions(value: unknown): BlockingSession[] {
  if (!Array.isArray(value)) return [];
  const sessions: BlockingSession[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { sessionId, title, reasons } = item as Record<string, unknown>;
    if (typeof sessionId !== 'string' || !sessionId) continue;
    sessions.push({
      sessionId,
      title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '',
      reasons: Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string') : [],
    });
  }
  return sessions;
}

function sessionLabel(session: BlockingSession, tr: Translate): string {
  const chars = [...session.title];
  const title = chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS).join('')}…` : session.title;
  return title
    ? tr('sessionMutation.titled', { title })
    : tr('sessionMutation.untitled', { id: session.sessionId.slice(0, 8) });
}

function reasonText(reasons: readonly string[], tr: Translate): string {
  const keys = reasons.map(r => REASON_KEYS[r as ProtectedSessionMutationReason] ?? 'sessionMutation.reasonOther');
  const unique = [...new Set(keys.length ? keys : ['sessionMutation.reasonOther'])];
  return unique.map(key => tr(key)).join(tr('sessionMutation.reasonSep'));
}

/**
 * 是这类拒绝时返回「受影响的会话 + 怎么办」的说明（不带「未保存 / 重启失败」这类前缀，
 * 由调用方按场景补）；不是这类拒绝返回 null，调用方照常走自己的错误文案。
 */
export function sessionMutationBlockedText(body: unknown, tr: Translate): string | null {
  if (!body || typeof body !== 'object') return null;
  const { error, blockingSessions } = body as Record<string, unknown>;
  if (typeof error !== 'string' || !BLOCKED_ERRORS.has(error)) return null;

  const sessions = parseBlockingSessions(blockingSessions);
  const sentences: string[] = [];
  if (sessions.length > 0) {
    const listed = sessions.slice(0, MAX_LISTED_SESSIONS).map(session =>
      tr('sessionMutation.sessionItem', { label: sessionLabel(session, tr), reasons: reasonText(session.reasons, tr) }));
    const hidden = sessions.length - listed.length;
    if (hidden > 0) listed.push(tr('sessionMutation.more', { count: hidden }));
    sentences.push(tr('sessionMutation.affected', { sessions: listed.join(tr('sessionMutation.listSep')) }));
  }

  const reasons = new Set(sessions.flatMap(session => session.reasons));
  if (reasons.has('queued_todo')) sentences.push(tr('sessionMutation.adviceQueuedTodo'));
  if (reasons.has('repository_setup')) sentences.push(tr('sessionMutation.adviceRepositorySetup'));
  const needsAction = [...reasons].some(reason => NEEDS_USER_ACTION.has(reason));
  const waits = reasons.size === 0 || [...reasons].some(reason => !NEEDS_USER_ACTION.has(reason));
  if (waits) sentences.push(tr(needsAction ? 'sessionMutation.adviceWaitOthers' : 'sessionMutation.adviceWait'));
  return sentences.join(tr('sessionMutation.sentenceSep'));
}
