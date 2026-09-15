import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  diagnoseSubmitFailure,
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

  it('worker 源码引用了三个 submitDiag key', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    for (const key of DIAG_KEYS) {
      expect(worker).toContain(`'${key}'`);
    }
  });
});
