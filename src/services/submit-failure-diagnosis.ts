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
  | 'draft_parked'      // 正文已粘贴进 composer 但没提交（[Pasted Content N chars]）
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
  // 行首编号选择光标
  { id: 'interactive_menu:numbered_cursor', re: /(?:^|[\n\r])\s*[›❯]\s*\d+\s*[.)]/ },
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
