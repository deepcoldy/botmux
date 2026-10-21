import { describe, expect, it } from 'vitest';
import {
  decideSessionStartGatedSubmitWarning,
  diagnoseSubmitFailure,
  diagnoseBackendSubmitFailure,
  SUBMIT_FAILURE_ACTIVE_WINDOW_MS,
} from '../src/services/submit-failure-diagnosis.js';
import { messages as enMessages } from '../src/i18n/en.js';
import { messages as zhMessages } from '../src/i18n/zh.js';
import { t } from '../src/i18n/index.js';

/**
 * submit_unconfirmed 发卡前的失败现场分类（纯函数）：
 *   - logged_out / interactive_menu / draft_parked 来自当前屏幕文本（ANSI 先清洗）；
 *   - still_active 只来自 PTY/结构化活跃度时钟，是弱证据（只用于有限静默）；
 *   - 屏幕门证据优先于活跃度；其余（含空屏幕）一律 unknown。
 */

const NOW = 1_000_000_000_000;

interface ScreenCase {
  name: string;
  screenText: string;
  reason: string;
  matched: string;
}

const SCREEN_CASES: ScreenCase[] = [
  {
    name: 'codex 风 waiting for login',
    screenText: 'Codex CLI\n\nWaiting for login to complete in browser...',
    reason: 'logged_out',
    matched: 'logged_out:waiting_for_login',
  },
  {
    name: 'Please run /login 提示',
    screenText: 'Error: not authenticated.\nPlease run /login to authenticate.',
    reason: 'logged_out',
    matched: 'logged_out:please_run_login',
  },
  {
    name: 'traex 真机登录页 Sign in to TraeCode CLI',
    screenText: 'Sign in to TraeCode CLI\nUse arrow keys to select an account',
    reason: 'logged_out',
    matched: 'logged_out:sign_in_to',
  },
  {
    name: 'Unauthorized 鉴权失效',
    screenText: 'Request failed: Unauthorized (credentials expired)',
    reason: 'logged_out',
    matched: 'logged_out:unauthorized',
  },
  {
    name: '403 与 auth 近邻共现',
    screenText: 'Error: 403 Forbidden — auth token missing or expired',
    reason: 'logged_out',
    matched: 'logged_out:http_401_403',
  },
  {
    name: 'hooks review 确认界面',
    screenText: 'New hooks need review\n❯ Yes\n  No',
    reason: 'interactive_menu',
    matched: 'interactive_menu:hooks_need_review',
  },
  {
    name: 'Legacy TraeCode 迁移菜单',
    screenText: 'Legacy TraeCode CLI data detected in ~/.trae. Migrate?\n❯ Yes\n  No',
    reason: 'interactive_menu',
    matched: 'interactive_menu:legacy_trae_migrate',
  },
  {
    name: 'Replace goal? 确认框',
    screenText: 'A conversation is already running. Replace goal?',
    reason: 'interactive_menu',
    matched: 'interactive_menu:replace_goal',
  },
  {
    name: 'Press enter to continue 暂停页',
    screenText: 'Update downloaded.\nPress enter to continue',
    reason: 'interactive_menu',
    matched: 'interactive_menu:press_enter',
  },
  {
    name: 'Update now 更新提示',
    screenText: 'A new CLI version is available. Update now?',
    reason: 'interactive_menu',
    matched: 'interactive_menu:update_now',
  },
  {
    name: 'Codex workspace trust title',
    screenText: 'Trust this folder?\n› 1. Trust and continue\n  2. Quit',
    reason: 'interactive_menu',
    matched: 'interactive_menu:trust_this_folder',
  },
  {
    name: 'Codex workspace trust option only',
    screenText: '› 1. Trust and continue\n  2. Quit',
    reason: 'interactive_menu',
    matched: 'interactive_menu:trust_and_continue',
  },
  {
    name: '行首编号选择光标 ❯ 1.',
    screenText: 'Choose an option:\n\n❯ 1. Continue\n  2. Start over',
    reason: 'interactive_menu',
    matched: 'interactive_menu:numbered_cursor',
  },
  {
    name: '正文停在 [Pasted Content 3882 chars]',
    screenText: '❯\n[Pasted Content 3882 chars]\n⏎ to submit',
    reason: 'draft_parked',
    matched: 'draft_parked:pasted_content',
  },
];

const NEGATIVE_SCREENS: { name: string; screenText: string }[] = [
  {
    // traex 启动骨架屏：loading 横幅绝不能判成菜单/登录；❯ 后是普通提示不是编号。
    name: 'traex 启动 loading 骨架屏',
    screenText: [
      '│ model:     loading   /model to change',
      '│',
      '❯ Ask TraeCode CLI to do anything',
    ].join('\n'),
  },
  {
    name: '已就绪 banner',
    screenText: '✻ Welcome to Claude Code v2.0 — type /help for commands',
  },
  {
    name: '普通执行中屏幕（无命中词）',
    screenText: '⠋ Fetching repository context…\n  src/worker.ts\n  src/config.ts',
  },
  {
    name: '普通代码输出',
    screenText: '3 files changed, 82 insertions(+), 14 deletions(-)',
  },
  {
    name: '空文本',
    screenText: '',
  },
];

describe('diagnoseSubmitFailure 屏幕证据', () => {
  it.each(SCREEN_CASES)('$name → $reason ($matched)', ({ screenText, reason, matched }) => {
    const d = diagnoseSubmitFailure({ screenText, nowMs: NOW });
    expect(d.reason).toBe(reason);
    expect(d.evidence).toBe('screen');
    expect(d.matched).toBe(matched);
  });

  it.each(NEGATIVE_SCREENS)('负例 $name → unknown/none', ({ screenText }) => {
    const d = diagnoseSubmitFailure({ screenText, nowMs: NOW });
    expect(d.reason).toBe('unknown');
    expect(d.evidence).toBe('none');
    expect(d.matched).toBeUndefined();
  });

  it('ANSI 彩色包裹的命中文本仍识别', () => {
    const d = diagnoseSubmitFailure({
      screenText: '\x1b[32m\x1b[1mwaiting for login\x1b[0m',
      nowMs: NOW,
    });
    expect(d.reason).toBe('logged_out');
    expect(d.evidence).toBe('screen');
    expect(d.matched).toBe('logged_out:waiting_for_login');
  });

  it('裸 401/403 数字（无登录/鉴权词共现）不判登录门', () => {
    const d = diagnoseSubmitFailure({
      screenText: 'http stats: 200 ok=12, 403 blocked=7, 500 errors=1',
      nowMs: NOW,
    });
    expect(d.reason).toBe('unknown');
  });
});

describe('diagnoseSubmitFailure still_active 活跃度', () => {
  it('19s 前有活动 → still_active（默认窗口 20s）', () => {
    const d = diagnoseSubmitFailure({
      screenText: '',
      lastActivityAtMs: NOW - 19_000,
      nowMs: NOW,
    });
    expect(d.reason).toBe('still_active');
    expect(d.evidence).toBe('activity');
    expect(d.matched).toBeUndefined();
    expect(SUBMIT_FAILURE_ACTIVE_WINDOW_MS).toBe(20_000);
  });

  it('21s 前的活动 → unknown', () => {
    const d = diagnoseSubmitFailure({
      screenText: '',
      lastActivityAtMs: NOW - 21_000,
      nowMs: NOW,
    });
    expect(d.reason).toBe('unknown');
    expect(d.evidence).toBe('none');
  });

  it.each([0, undefined])('lastActivityAtMs=%s → unknown', (lastActivityAtMs) => {
    const d = diagnoseSubmitFailure({ screenText: '', lastActivityAtMs, nowMs: NOW });
    expect(d.reason).toBe('unknown');
  });

  it('activeWindowMs 可注入（边界 <= 算活跃）', () => {
    const input = { screenText: '', lastActivityAtMs: NOW - 5_000, nowMs: NOW };
    expect(diagnoseSubmitFailure({ ...input, activeWindowMs: 4_000 }).reason).toBe('unknown');
    expect(diagnoseSubmitFailure({ ...input, activeWindowMs: 5_000 }).reason).toBe('still_active');
  });

  it('普通执行中屏幕但无新鲜活动 → unknown', () => {
    const d = diagnoseSubmitFailure({
      screenText: '⠋ Fetching repository context…',
      lastActivityAtMs: NOW - 21_000,
      nowMs: NOW,
    });
    expect(d.reason).toBe('unknown');
  });
});

describe('diagnoseSubmitFailure 优先级', () => {
  it('登录屏同时有新鲜活动 → logged_out（屏幕门优先于活跃度）', () => {
    const d = diagnoseSubmitFailure({
      screenText: 'Sign in to TraeCode CLI',
      lastActivityAtMs: NOW - 1_000,
      nowMs: NOW,
    });
    expect(d.reason).toBe('logged_out');
    expect(d.evidence).toBe('screen');
    expect(d.matched).toBe('logged_out:sign_in_to');
  });

  it('菜单屏同帧有 [Pasted Content] → interactive_menu（菜单优先于 draft_parked）', () => {
    const d = diagnoseSubmitFailure({
      screenText: 'Hooks need review\n[Pasted Content 3882 chars]',
      lastActivityAtMs: NOW - 1_000,
      nowMs: NOW,
    });
    expect(d.reason).toBe('interactive_menu');
    expect(d.evidence).toBe('screen');
    expect(d.matched).toBe('interactive_menu:hooks_need_review');
  });
});

const DIAG_KEYS = [
  'submitDiag.logged_out',
  'submitDiag.interactive_menu',
  'submitDiag.draft_parked',
] as const;

describe('submitDiag i18n 文案接缝', () => {
  it.each(DIAG_KEYS)('%s 在 zh/en 都存在且非空', (key) => {
    expect(Object.prototype.hasOwnProperty.call(zhMessages, key)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(enMessages, key)).toBe(true);
    expect(zhMessages[key]).toBeTruthy();
    expect(enMessages[key]).toBeTruthy();
  });

  it.each(DIAG_KEYS)('%s 两张文案都保留 {cliName} 与 {preview}', (key) => {
    expect(zhMessages[key]).toContain('{cliName}');
    expect(zhMessages[key]).toContain('{preview}');
    expect(enMessages[key]).toContain('{cliName}');
    expect(enMessages[key]).toContain('{preview}');
  });

  it.each(DIAG_KEYS)('%s en 渲染后模板本身不含 CJK', (key) => {
    const rendered = t(key, { cliName: 'TraeCode CLI', preview: 'run the tests' }, 'en');
    expect(rendered).not.toMatch(/[一-鿿]/);
  });

  it('zh 渲染后包含原消息预览', () => {
    for (const key of DIAG_KEYS) {
      const rendered = t(key, { cliName: 'TraeCode CLI', preview: '帮我跑一下测试' }, 'zh');
      expect(rendered).toContain('原消息：帮我跑一下测试');
    }
  });
});

describe('expanded Claude composer draft', () => {
  const screenText = 'previous response\n────────────────────────\n❯ <botmux_reminder>reply</botmux_reminder>\\\n  <user_message>\\\n  first line\\\n  second line\\\n  </user_message>\n────────────────────────\n  bypass permissions on';
  it('finds a parked BotMux payload even while the previous turn is active', () => {
    expect(diagnoseSubmitFailure({ screenText, cliId: 'claude-code', nowMs: NOW, lastActivityAtMs: NOW })).toEqual({ reason: 'draft_parked', evidence: 'screen', matched: 'draft_parked:claude_composer' });
  });
  it('does not reinterpret another CLI or quoted transcript as a draft', () => {
    expect(diagnoseSubmitFailure({ screenText, cliId: 'codex' }).reason).toBe('unknown');
    expect(diagnoseSubmitFailure({ screenText: '<user_message>quoted example</user_message>\n────────────────────────\n❯\n────────────────────────', cliId: 'claude-code' }).reason).toBe('unknown');
  });
});

describe('collapsed pasted-text chip in Claude composer', () => {
  // Mirrors a real Claude Code 2.1.289 capture: while a turn is running, one
  // bracketed-paste frame whose Enter was lost sits in the only (bottom)
  // composer box as a collapsed chip — the expanded <user_message> shape never
  // renders because BotMux does not paste a second time.
  const RULE = '────────────────────────────────────────────────────────────';
  const parkedChipScreen = [
    '▐▛███▛█   Claude Code v2.1.289',
    '/tmp/bmx-probe',
    '',
    '● Running python sleep with busy marker',
    '  ❯  $ python3 -c "import time; time.sleep(20)"',
    '',
    'Razzmatazzing… (6s)',
    RULE,
    '❯ [Pasted text #2 +3 lines]',
    '  paste again to expand',
    RULE,
  ].join('\n');

  it('detects a parked multi-line paste rendered as a collapsed chip', () => {
    expect(diagnoseSubmitFailure({ screenText: parkedChipScreen, cliId: 'claude-code', nowMs: NOW, lastActivityAtMs: NOW })).toEqual({ reason: 'draft_parked', evidence: 'screen', matched: 'draft_parked:claude_pasted_chip' });
  });

  it('ignores a chip quoted in transcript when the current composer is empty', () => {
    const emptyComposer = [
      '● I quoted your earlier input: [Pasted text #2 +3 lines] in my reply',
      RULE,
      '❯ ',
      RULE,
      '  bypass permissions on',
    ].join('\n');
    expect(diagnoseSubmitFailure({ screenText: emptyComposer, cliId: 'claude-code' }).reason).toBe('unknown');
  });

  it('needs the composer prompt marker: a chip-shaped line elsewhere in a box is not a draft', () => {
    const noPrompt = [RULE, '[Pasted text #2 +3 lines]', '  some other pane content', RULE].join('\n');
    expect(diagnoseSubmitFailure({ screenText: noPrompt, cliId: 'claude-code' }).reason).toBe('unknown');
  });

  it('is gated to the claude-code family like the expanded-composer rule', () => {
    expect(diagnoseSubmitFailure({ screenText: parkedChipScreen, cliId: 'codex' }).reason).toBe('unknown');
    expect(diagnoseSubmitFailure({ screenText: parkedChipScreen }).reason).toBe('unknown');
  });
});

describe('diagnoseBackendSubmitFailure worker seam', () => {
  const RULE = '────────────────────────────────────────────────────────────';
  const parkedChipScreen = [
    RULE,
    '❯ [Pasted text #7 +2 lines]',
    '  paste again to expand',
    RULE,
  ].join('\n');

  it('threads the session cliId so a Claude chip is classified on a live backend', () => {
    expect(diagnoseBackendSubmitFailure({ backendType: 'pty', cliId: 'claude-code', capturedScreenText: parkedChipScreen, nowMs: NOW }).matched).toBe('draft_parked:claude_pasted_chip');
  });

  it('does not apply the claude-only composer rule when cliId is absent', () => {
    expect(diagnoseBackendSubmitFailure({ backendType: 'pty', capturedScreenText: parkedChipScreen, nowMs: NOW }).reason).toBe('unknown');
  });

  it('ignores captured screen text on ZMX, whose pane history is non-authoritative', () => {
    const loginScreen = 'some stale pane text\nplease run /login\n';
    expect(diagnoseBackendSubmitFailure({ backendType: 'zmx', cliId: 'claude-code', capturedScreenText: loginScreen, nowMs: NOW }).reason).toBe('unknown');
  });

  it('still uses the activity clock on ZMX after the screen is blanked', () => {
    const loginScreen = 'please run /login';
    expect(diagnoseBackendSubmitFailure({ backendType: 'zmx', cliId: 'claude-code', capturedScreenText: loginScreen, lastActivityAtMs: NOW, nowMs: NOW })).toEqual({ reason: 'still_active', evidence: 'activity' });
  });
});

describe('decideSessionStartGatedSubmitWarning (2026-10-20 incident timelines)', () => {
  const at = (hms: string) => Date.parse(`2026-10-20T${hms}Z`);

  it('8c6fc852: no warning while Claude holds the record until its late SessionStart', () => {
    // Prompt submitted 17:46:26, in-band confirm gave up 17:46:35; every 20s
    // recheck saw only PTY activity; SessionStart reported 17:49:00, record 17:49:01.
    const waitingSinceMs = at('17:46:35');
    for (const recheck of ['17:46:55', '17:47:15', '17:47:35', '17:47:55', '17:48:15', '17:48:35', '17:48:55']) {
      expect(decideSessionStartGatedSubmitWarning({ sessionStartAtMs: undefined, waitingSinceMs, nowMs: at(recheck) }))
        .toEqual({ warn: false, reason: 'session-start-pending' });
    }
    // A recheck right after the report still leaves the record time to land.
    expect(decideSessionStartGatedSubmitWarning({ sessionStartAtMs: at('17:49:00'), waitingSinceMs, nowMs: at('17:49:05') }))
      .toEqual({ warn: false, reason: 'post-session-start-grace' });
  });

  it('f2eaabca: a prompt stuck in the composer is still reported once SessionStart has come and gone', () => {
    const waitingSinceMs = at('17:46:31');
    expect(decideSessionStartGatedSubmitWarning({ sessionStartAtMs: undefined, waitingSinceMs, nowMs: at('17:47:31') }).warn)
      .toBe(false);
    expect(decideSessionStartGatedSubmitWarning({ sessionStartAtMs: at('17:49:09'), waitingSinceMs, nowMs: at('17:49:31') }))
      .toEqual({ warn: true, reason: 'record-missing-after-session-start' });
  });

  it('a mid-session turn waits at least the minimum budget, regardless of PTY activity', () => {
    const sessionStartAtMs = at('10:00:00');
    const waitingSinceMs = at('12:00:00');
    expect(decideSessionStartGatedSubmitWarning({ sessionStartAtMs, waitingSinceMs, nowMs: at('12:00:20') }))
      .toEqual({ warn: false, reason: 'min-wait' });
    expect(decideSessionStartGatedSubmitWarning({ sessionStartAtMs, waitingSinceMs, nowMs: at('12:00:40') }).warn).toBe(true);
  });

  it('warns eventually when the SessionStart hook never reports', () => {
    const waitingSinceMs = at('12:00:00');
    expect(decideSessionStartGatedSubmitWarning({ sessionStartAtMs: undefined, waitingSinceMs, nowMs: at('12:09:59') }).warn).toBe(false);
    expect(decideSessionStartGatedSubmitWarning({ sessionStartAtMs: undefined, waitingSinceMs, nowMs: at('12:10:00') }))
      .toEqual({ warn: true, reason: 'session-start-never-reported' });
  });
});
