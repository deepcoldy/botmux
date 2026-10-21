/**
 * Pure classification of the terminal state seen right before a
 * submit_unconfirmed card is sent.
 *
 * Screen-gate evidence (login page / blocking menu / draft parked in the
 * composer) wins over the activity clock: a gate screen does not advance on
 * its own, so "the CLI was recently printing" cannot explain it away.
 * `still_active` is deliberately weak — it only justifies a bounded number of
 * extra silences, never a conclusion about what happened to the message.
 */
import { stripAnsiScreenText } from '../utils/idle-detector.js';

export type SubmitFailureDiagnosisReason =
  | 'logged_out'        // 登录/鉴权门
  | 'interactive_menu'  // 菜单/迁移/hooks review/确认框等键盘选择界面
  | 'draft_parked'      // 正文停在 composer，尚未提交
  | 'still_active'      // CLI 仍有持续活动证据（弱证据，只用于有限度静默，不用于下结论）
  | 'unknown';

export interface SubmitFailureDiagnosis {
  reason: SubmitFailureDiagnosisReason;
  /** 命中证据来自屏幕文本还是活跃度时钟；unknown 为 none */
  evidence: 'screen' | 'activity' | 'none';
  /** 命中的规则稳定 id（用于日志，禁止回传屏幕原文） */
  matched?: string;
}

export interface SubmitFailureDiagnosisInput {
  /** renderer/backend 当前可见屏幕原文（可含 ANSI，内部清洗）；ZMX 等拿不到时传 '' */
  screenText?: string;
  /** 最近一次 PTY/结构化活动的 epoch ms；0/undefined 表示无 */
  lastActivityAtMs?: number;
  /** Claude-only composer parsing; avoid interpreting other CLI prompts as drafts. */
  cliId?: string;
  nowMs?: number;                       // 测试注入
  activeWindowMs?: number;              // 默认 SUBMIT_FAILURE_ACTIVE_WINDOW_MS
}

export const SUBMIT_FAILURE_ACTIVE_WINDOW_MS = 20_000;

interface ScreenRule {
  id: string;
  re: RegExp;
}

const LOGGED_OUT_RULES: readonly ScreenRule[] = [
  { id: 'logged_out:waiting_for_login', re: /waiting for login\b/i },
  { id: 'logged_out:please_run_login', re: /please run\s+\/login\b/i },
  { id: 'logged_out:run_login', re: /\brun\s+\/login\b/i },
  { id: 'logged_out:not_logged_in', re: /not logged in\b/i },
  { id: 'logged_out:please_login', re: /please log[ -]?in\b/i },
  // traex 真机登录页原文 "Sign in to TraeCode CLI"
  { id: 'logged_out:sign_in_to', re: /sign in to\b/i },
  { id: 'logged_out:unauthorized', re: /\bunauthorized\b/i },
  // 401/403 必须与登录/鉴权词共现，裸数字不匹配
  { id: 'logged_out:http_401_403', re: /\b40[13]\b[^]{0,60}(?:login|auth|sign in|forbidden)/i },
];

const INTERACTIVE_MENU_RULES: readonly ScreenRule[] = [
  { id: 'interactive_menu:hooks_need_review', re: /hooks need review/i },
  // 真机迁移菜单 "Legacy TraeCode … migrate"
  { id: 'interactive_menu:legacy_trae_migrate', re: /legacy\s*trae(?:code)?[^\n]{0,40}migrat/i },
  { id: 'interactive_menu:migration_target', re: /\bmigrat(?:e|ion)[^\n]{0,30}(?:data|session|legacy)/i },
  { id: 'interactive_menu:replace_goal', re: /replace goal\s*\?/i },
  { id: 'interactive_menu:press_enter', re: /press enter to continue/i },
  { id: 'interactive_menu:update_now', re: /update now/i },
  { id: 'interactive_menu:trust_files', re: /trust the files/i },
  { id: 'interactive_menu:trust_this_folder', re: /trust this folder/i },
  { id: 'interactive_menu:trust_and_continue', re: /trust and continue/i },
  // 行首编号选择光标（» 是 codex ≥0.154 画的选中光标）
  { id: 'interactive_menu:numbered_cursor', re: /(?:^|[\n\r])\s*[›❯»]\s*\d+\s*[.)]/ },
];

const DRAFT_PARKED_RULES: readonly ScreenRule[] = [
  // 真机反馈：3882 字停在 [Pasted Content N chars]
  { id: 'draft_parked:pasted_content', re: /\[\s*pasted content\s+\d+\s+chars?\s*\]/i },
];

function matchScreenRule(rules: readonly ScreenRule[], screen: string): string | undefined {
  for (const rule of rules) {
    if (rule.re.test(screen)) return rule.id;
  }
  return undefined;
}

// Claude Code ≥2.1 renders a multi-line bracketed paste that is parked in the
// composer as a collapsed chip ("[Pasted text #2 +3 lines]") until pasted
// again. BotMux delivers exactly one bracketed frame, so the expanded
// `<user_message>` shape never appears on its own — the chip is the only
// on-screen evidence the payload is stuck unsubmitted.
const CLAUDE_PASTED_TEXT_CHIP = /\[\s*pasted text\s+#\d+(?:\s*\+\d+\s+lines?)?\s*\]/i;

function claudeComposerDraftMatch(screen: string): string | undefined {
  const rows = screen.split(/\r?\n/);
  const separator = (line: string) => /^\s*[─━═╌-]{10,}\s*$/.test(line);
  // Only the last input box, bounded by two full-width rules, is evidence.
  // Assistant transcript text or an idle suggestion outside it is not a draft.
  for (let bottom = rows.length - 1; bottom >= 0; bottom--) {
    if (!separator(rows[bottom])) continue;
    let top = bottom - 1;
    while (top >= 0 && !separator(rows[top])) top--;
    if (top < 0) continue;
    const body = rows.slice(top + 1, bottom);
    if (!/^\s*❯/.test(body[0] ?? '')) continue;
    const bodyText = body.join('\n');
    if (bodyText.includes('<user_message>')) return 'draft_parked:claude_composer';
    if (CLAUDE_PASTED_TEXT_CHIP.test(bodyText)) return 'draft_parked:claude_pasted_chip';
  }
  return undefined;
}

export function diagnoseSubmitFailure(input: SubmitFailureDiagnosisInput): SubmitFailureDiagnosis {
  // 优先级（高到低）：logged_out > interactive_menu > draft_parked >
  // still_active > unknown。屏幕门证据优先于活跃度。
  const screen = stripAnsiScreenText(input.screenText ?? '');
  const loggedOut = matchScreenRule(LOGGED_OUT_RULES, screen);
  if (loggedOut) return { reason: 'logged_out', evidence: 'screen', matched: loggedOut };
  const interactiveMenu = matchScreenRule(INTERACTIVE_MENU_RULES, screen);
  if (interactiveMenu) return { reason: 'interactive_menu', evidence: 'screen', matched: interactiveMenu };
  const draftParked = matchScreenRule(DRAFT_PARKED_RULES, screen);
  if (draftParked) return { reason: 'draft_parked', evidence: 'screen', matched: draftParked };
  if (input.cliId === 'claude-code') {
    const composerDraft = claudeComposerDraftMatch(screen);
    if (composerDraft) return { reason: 'draft_parked', evidence: 'screen', matched: composerDraft };
  }

  const nowMs = input.nowMs ?? Date.now();
  const activeWindowMs = input.activeWindowMs ?? SUBMIT_FAILURE_ACTIVE_WINDOW_MS;
  if (
    typeof input.lastActivityAtMs === 'number'
    && input.lastActivityAtMs > 0
    && nowMs - input.lastActivityAtMs <= activeWindowMs
  ) {
    return { reason: 'still_active', evidence: 'activity' };
  }
  return { reason: 'unknown', evidence: 'none' };
}

/** Worker-side inputs: the backend decides whether a captured screen is even
 *  authoritative. ZMX pane history is not a live view, so its text must never
 *  trip a screen gate (logged-out / menu / parked draft). */
export interface BackendSubmitFailureInput {
  backendType?: string;
  /** Current viewport/backend screen (may contain ANSI). Ignored for ZMX. */
  capturedScreenText?: string;
  /** Session CLI id — the Claude composer rules are claude-code-only. */
  cliId?: string;
  lastActivityAtMs?: number;
  nowMs?: number;
  activeWindowMs?: number;
}

/** Assemble the worker's pre-card diagnosis in one testable place: blanks the
 *  screen for backends whose history is non-authoritative, then delegates to
 *  the pure classifier. */
export function diagnoseBackendSubmitFailure(input: BackendSubmitFailureInput): SubmitFailureDiagnosis {
  return diagnoseSubmitFailure({
    cliId: input.cliId,
    screenText: input.backendType === 'zmx' ? '' : input.capturedScreenText,
    lastActivityAtMs: input.lastActivityAtMs,
    nowMs: input.nowMs,
    activeWindowMs: input.activeWindowMs,
  });
}

/** Claude Code writes the first prompt's transcript record only after all of
 *  its SessionStart hooks finish. On a loaded host that took minutes
 *  (2026-10-20: prompt submitted 17:46:26, hooks reported 17:49:00, record
 *  17:49:01), so a missing record before botmux's own SessionStart hook has
 *  reported is expected, not a failed submit. This bounds the wait in case the
 *  hook never reports at all. */
export const SUBMIT_SESSION_START_WAIT_MAX_MS = 10 * 60_000;
/** The record followed the SessionStart report within ~1s in the sample above;
 *  leave a loaded disk an order of magnitude before concluding. */
export const SUBMIT_POST_SESSION_START_GRACE_MS = 10_000;
/** Floor for any verdict, independent of PTY activity: slow UserPromptSubmit
 *  hooks defer the record by 5–15s, and two 20s rechecks is the budget the
 *  weak-activity path granted before PTY activity stopped counting. */
export const SUBMIT_GATED_MIN_WAIT_MS = 40_000;

/**
 * Verdict for a deferred submit recheck that still finds no transcript record,
 * for a spawn whose CLI reports a deterministic SessionStart signal (Claude
 * family with botmux's hook installed). Only that signal and the transcript
 * decide; PTY activity counts for nothing either way, because a CLI waiting on
 * its hooks and a composer holding an unsubmitted paste both keep redrawing:
 * on 2026-10-20 "pty-output shows the CLI is active" postponed the warning for
 * a prompt stuck in the composer three times, and still let a false warning
 * through for a prompt that Claude was merely holding until its hooks finished.
 */
export function decideSessionStartGatedSubmitWarning(state: {
  /** When the SessionStart signal arrived for this spawn; undefined = not yet. */
  sessionStartAtMs: number | undefined;
  /** When this submission's confirmation chain started. */
  waitingSinceMs: number;
  nowMs: number;
  graceMs?: number;
  minWaitMs?: number;
  maxWaitMs?: number;
}): { warn: false; reason: 'session-start-pending' | 'post-session-start-grace' | 'min-wait' }
  | { warn: true; reason: 'record-missing-after-session-start' | 'session-start-never-reported' } {
  const waitedMs = state.nowMs - state.waitingSinceMs;
  if (state.sessionStartAtMs === undefined) {
    return waitedMs >= (state.maxWaitMs ?? SUBMIT_SESSION_START_WAIT_MAX_MS)
      ? { warn: true, reason: 'session-start-never-reported' }
      : { warn: false, reason: 'session-start-pending' };
  }
  if (state.nowMs - state.sessionStartAtMs < (state.graceMs ?? SUBMIT_POST_SESSION_START_GRACE_MS)) {
    return { warn: false, reason: 'post-session-start-grace' };
  }
  if (waitedMs < (state.minWaitMs ?? SUBMIT_GATED_MIN_WAIT_MS)) return { warn: false, reason: 'min-wait' };
  return { warn: true, reason: 'record-missing-after-session-start' };
}
