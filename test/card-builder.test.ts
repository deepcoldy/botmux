/**
 * Unit tests for card-builder: buildSessionCard, buildStreamingCard,
 * buildRepoSelectCard, getCliDisplayName.
 *
 * These are pure functions — no mocking required.
 *
 * Run:  pnpm vitest run test/card-builder.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildSessionCard,
  buildStreamingCard,
  buildRepoSelectCard,
  buildSessionClosedCard,
  buildRelayPickerCard,
  buildPrivateSnapshotCard,
  getCliDisplayName,
} from '../src/im/lark/card-builder.js';
import type { RelayPickerEntry } from '../src/im/lark/card-builder.js';
import type { ProjectInfo } from '../src/services/project-scanner.js';
import { globalConfigPath } from '../src/global-config.js';

// The terminal button's URL wrapping now depends on the global dashboard
// setting `openTerminalInFeishu` (read via readGlobalConfig at build time):
// default → direct URL, opt-in → Feishu sidebar wrapper. Isolate HOME to an
// empty temp dir so these tests see the DEFAULT (no config.json → direct),
// independent of whatever the test runner's real ~/.botmux/config.json holds.
let cardTestHome: string;
beforeEach(() => {
  cardTestHome = mkdtempSync(join(tmpdir(), 'botmux-card-builder-'));
  vi.stubEnv('HOME', cardTestHome);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cardTestHome, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function parse(json: string): any {
  return JSON.parse(json);
}

function findActions(card: any): any[] {
  const actionEl = card.elements.find((e: any) => e.tag === 'action');
  return actionEl?.actions ?? [];
}

function buttonTexts(actions: any[]): string[] {
  return actions
    .filter((a: any) => a.tag === 'button')
    .map((a: any) => a.text.content);
}

function expectSidebarUrl(actual: string, targetUrl: string): void {
  const u = new URL(actual);
  expect(`${u.origin}${u.pathname}`).toBe('https://applink.feishu.cn/client/web_url/open');
  expect(u.searchParams.get('mode')).toBe('sidebar-semi');
  expect(u.searchParams.get('min_width')).toBe('350');
  expect(u.searchParams.get('width')).toBe('800');
  expect(u.searchParams.get('max_width')).toBe('1200');
  expect(u.searchParams.get('reload')).toBe('false');
  expect(u.searchParams.get('url')).toBe(targetUrl);
}

/** Default mode: the terminal button links straight to the terminal URL on
 *  every platform field (no Feishu sidebar wrapper). */
function expectDirectUrl(actual: string, targetUrl: string): void {
  expect(actual).toBe(targetUrl);
}

/** Opt into the Feishu sidebar wrapper for the current (isolated) HOME. */
function enableOpenTerminalInFeishu(): void {
  writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { openTerminalInFeishu: true } }));
}

// ─── getCliDisplayName ────────────────────────────────────────────────────

describe('getCliDisplayName', () => {
  it('should return "Claude" for claude-code', () => {
    expect(getCliDisplayName('claude-code')).toBe('Claude');
  });

  it('should return "Aiden" for aiden', () => {
    expect(getCliDisplayName('aiden')).toBe('Aiden');
  });

  it('should return "CoCo" for coco', () => {
    expect(getCliDisplayName('coco')).toBe('CoCo');
  });

  it('should return "Codex" for codex', () => {
    expect(getCliDisplayName('codex')).toBe('Codex');
  });

  it('should return "Gemini" for gemini', () => {
    expect(getCliDisplayName('gemini')).toBe('Gemini');
  });

  it('should return "OpenCode" for opencode', () => {
    expect(getCliDisplayName('opencode')).toBe('OpenCode');
  });

  it('should return "MTR" for mtr', () => {
    expect(getCliDisplayName('mtr')).toBe('MTR');
  });

  it('should return "Hermes" for hermes', () => {
    expect(getCliDisplayName('hermes')).toBe('Hermes');
  });

  it('should return "Mira" for mira', () => {
    expect(getCliDisplayName('mira')).toBe('Mira');
  });

  it('should return "Pi" for pi', () => {
    expect(getCliDisplayName('pi')).toBe('Pi');
  });
});

// ─── buildSessionCard ─────────────────────────────────────────────────────

describe('buildSessionCard', () => {
  const SID = 'sess-001';
  const ROOT = 'om_root';
  const URL = 'https://example.com/terminal';
  const TITLE = 'My Session';

  it('should return valid JSON', () => {
    const json = buildSessionCard(SID, ROOT, URL, TITLE);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('should have wide_screen_mode config', () => {
    const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
    expect(card.config.wide_screen_mode).toBe(true);
  });

  it('should set blue header template with escaped title', () => {
    const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
    expect(card.header.template).toBe('blue');
    expect(card.header.title.tag).toBe('plain_text');
    expect(card.header.title.content).toContain(TITLE);
  });

  it('should escape markdown special characters in title', () => {
    const card = parse(buildSessionCard(SID, ROOT, URL, 'Fix *bold* and [link]'));
    expect(card.header.title.content).toContain('\\*bold\\*');
    expect(card.header.title.content).toContain('\\[link\\]');
  });

  it('should default to "Claude" display name when cliId is omitted', () => {
    // The cliName is used in the restart button text; without showManageButtons
    // we won't see it, but with showManageButtons we can verify it.
    const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, undefined, true));
    const actions = findActions(card);
    const restartBtn = actions.find((a: any) => a.value?.action === 'restart');
    expect(restartBtn.text.content).toContain('Claude');
  });

  // ── Group card (showManageButtons = false / undefined) ─────────────────

  describe('group card (showManageButtons=false)', () => {
    it('should have terminal button with primary type and multi_url', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
      const actions = findActions(card);
      const terminalBtn = actions[0];
      expect(terminalBtn.type).toBe('primary');
      expect(terminalBtn.text.content).toContain('打开终端');
      expectDirectUrl(terminalBtn.multi_url.url, URL);
      expectDirectUrl(terminalBtn.multi_url.pc_url, URL);
      expect(terminalBtn.multi_url.android_url).toBe(URL);
      expect(terminalBtn.multi_url.ios_url).toBe(URL);
    });

    it('wraps the terminal link in the Feishu sidebar when openTerminalInFeishu is on', () => {
      enableOpenTerminalInFeishu();
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
      const terminalBtn = findActions(card)[0];
      expectSidebarUrl(terminalBtn.multi_url.url, URL);
      expectSidebarUrl(terminalBtn.multi_url.pc_url, URL);
      // mobile fields stay direct in both modes
      expect(terminalBtn.multi_url.android_url).toBe(URL);
      expect(terminalBtn.multi_url.ios_url).toBe(URL);
    });

    it('should include "get write link" button', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
      const actions = findActions(card);
      const linkBtn = actions.find((a: any) => a.value?.action === 'get_write_link');
      expect(linkBtn).toBeDefined();
      expect(linkBtn.text.content).toContain('获取操作链接');
      expect(linkBtn.value.root_id).toBe(ROOT);
      expect(linkBtn.value.session_id).toBe(SID);
    });

    it('should NOT include restart button', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
      const actions = findActions(card);
      const restartBtn = actions.find((a: any) => a.value?.action === 'restart');
      expect(restartBtn).toBeUndefined();
    });

    it('should include close button with danger type', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
      const actions = findActions(card);
      const closeBtn = actions.find((a: any) => a.value?.action === 'close');
      expect(closeBtn).toBeDefined();
      expect(closeBtn.type).toBe('danger');
      expect(closeBtn.text.content).toContain('关闭会话');
      expect(closeBtn.value.root_id).toBe(ROOT);
      expect(closeBtn.value.session_id).toBe(SID);
    });

    it('should have exactly 3 buttons (terminal, get_write_link, close)', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
      const actions = findActions(card);
      expect(actions).toHaveLength(3);
    });
  });

  // ── DM card (showManageButtons = true) ─────────────────────────────────

  describe('DM card (showManageButtons=true)', () => {
    it('should label terminal button as "打开可操作终端"', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, undefined, true));
      const actions = findActions(card);
      expect(actions[0].text.content).toContain('打开可操作终端');
    });

    it('should include restart button with CLI display name', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, 'gemini', true));
      const actions = findActions(card);
      const restartBtn = actions.find((a: any) => a.value?.action === 'restart');
      expect(restartBtn).toBeDefined();
      expect(restartBtn.text.content).toContain('Gemini');
      expect(restartBtn.value.root_id).toBe(ROOT);
      expect(restartBtn.value.session_id).toBe(SID);
    });

    it('should NOT include "get write link" button', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, undefined, true));
      const actions = findActions(card);
      const linkBtn = actions.find((a: any) => a.value?.action === 'get_write_link');
      expect(linkBtn).toBeUndefined();
    });

    it('should include close button', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, undefined, true));
      const actions = findActions(card);
      const closeBtn = actions.find((a: any) => a.value?.action === 'close');
      expect(closeBtn).toBeDefined();
    });

    it('should have exactly 3 buttons (terminal, restart, close)', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, undefined, true));
      const actions = findActions(card);
      expect(actions).toHaveLength(3);
    });
  });

  // ── Adopt session (adoptMode = true) ──────────────────────────────────
  // Live failure reported by user: the FIRST card after /adopt showed
  // "❌ 关闭会话" + action=close, which would tear down the user's CLI
  // (botmux never owned it in adopt mode). Must instead show "⏏ 断开"
  // + action=disconnect, which only kills the bridge worker.
  describe('adopt session (adoptMode=true)', () => {
    it('group adopt card uses "⏏ 断开" + action=disconnect, not "关闭会话" + close', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, undefined, false, true));
      const actions = findActions(card);
      const disconnectBtn = actions.find((a: any) => a.value?.action === 'disconnect');
      expect(disconnectBtn).toBeDefined();
      expect(disconnectBtn.type).toBe('danger');
      expect(disconnectBtn.text.content).toContain('断开');
      // The legacy "❌ 关闭会话" + action=close MUST NOT appear.
      const closeBtn = actions.find((a: any) => a.value?.action === 'close');
      expect(closeBtn).toBeUndefined();
      expect(JSON.stringify(card)).not.toContain('关闭会话');
    });

    it('DM adopt card (showManage=true + adopt=true) also uses 断开 button', () => {
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, 'claude-code', true, true));
      const actions = findActions(card);
      const disconnectBtn = actions.find((a: any) => a.value?.action === 'disconnect');
      expect(disconnectBtn).toBeDefined();
      const closeBtn = actions.find((a: any) => a.value?.action === 'close');
      expect(closeBtn).toBeUndefined();
    });

    it('DM adopt card omits the restart button entirely', () => {
      // Adopt mode never owned the user's CLI — restarting would kill
      // their tmux pane / Claude process. The button must NOT render in
      // the DM management card under adoptMode.
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, 'claude-code', true, true));
      const actions = findActions(card);
      const restartBtn = actions.find((a: any) => a.value?.action === 'restart');
      expect(restartBtn).toBeUndefined();
      expect(JSON.stringify(card)).not.toContain('重启');
    });

    it('non-adopt DM card still has the restart button (regression)', () => {
      // Behaviour unchanged for non-adopt DMs.
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, 'claude-code', true));
      const actions = findActions(card);
      const restartBtn = actions.find((a: any) => a.value?.action === 'restart');
      expect(restartBtn).toBeDefined();
    });

    it('non-adopt card retains the original "❌ 关闭会话" button (regression)', () => {
      // Without adoptMode, behaviour must be unchanged.
      const card = parse(buildSessionCard(SID, ROOT, URL, TITLE));
      const actions = findActions(card);
      const closeBtn = actions.find((a: any) => a.value?.action === 'close');
      expect(closeBtn).toBeDefined();
      expect(closeBtn.text.content).toContain('关闭会话');
    });
  });
});

// ─── buildStreamingCard ───────────────────────────────────────────────────

describe('buildStreamingCard', () => {
  const SID = 'sess-stream';
  const ROOT = 'om_root_stream';
  const URL = 'https://example.com/term';
  const TITLE = 'Stream Task';
  const CONTENT = '```\n$ npm test\nAll passed\n```';

  it('should return valid JSON', () => {
    const json = buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('should have wide_screen_mode config', () => {
    const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working'));
    expect(card.config.wide_screen_mode).toBe(true);
  });

  // ── Header / status / template color ───────────────────────────────────

  describe('header status and color', () => {
    it('should show yellow template and "启动中..." for starting status', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'starting'));
      expect(card.header.template).toBe('yellow');
      expect(card.header.title.content).toContain('启动中…');
    });

    it('should show blue template and "工作中" for working status', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'working'));
      expect(card.header.template).toBe('blue');
      expect(card.header.title.content).toContain('工作中');
    });

    it('should show green template and "等待输入" for idle status', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'idle'));
      expect(card.header.template).toBe('green');
      expect(card.header.title.content).toContain('等待输入');
    });

    it('should include escaped title in header', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, 'Fix *bug*', '', 'idle'));
      expect(card.header.title.content).toContain('Fix \\*bug\\*');
      expect(card.header.title.content).toContain('等待输入');
    });

    it('should show red usage-limit status with retry time', () => {
      const card = parse(buildStreamingCard(
        SID,
        ROOT,
        URL,
        TITLE,
        '',
        'limited',
        'codex',
        'hidden',
        undefined,
        undefined,
        false,
        false,
        undefined,
        {
          limited: true,
          kind: 'usage',
          retryAtMs: new Date(2026, 4, 19, 22, 36).getTime(),
          retryLabel: '10:36 PM',
          retryReady: false,
        },
      ));

      expect(card.header.template).toBe('red');
      expect(card.header.title.content).toContain('限额已达');
      expect(JSON.stringify(card)).toContain('10:36 PM');
      const actions = findActions(card);
      expect(actions.find((a: any) => a.value?.action === 'retry_last_task')).toBeUndefined();
    });

    it('should show retry-ready status and retry button after reset time', () => {
      const card = parse(buildStreamingCard(
        SID,
        ROOT,
        URL,
        TITLE,
        '',
        'limited',
        'codex',
        'hidden',
        'nonce_123',
        undefined,
        false,
        false,
        undefined,
        {
          limited: true,
          kind: 'usage',
          retryAtMs: new Date(2026, 4, 19, 22, 36).getTime(),
          retryLabel: '10:36 PM',
          retryReady: true,
        },
      ));

      expect(card.header.template).toBe('green');
      expect(card.header.title.content).toContain('可重试');
      const actions = findActions(card);
      const retryBtn = actions.find((a: any) => a.value?.action === 'retry_last_task');
      expect(retryBtn).toBeDefined();
      expect(retryBtn.text.content).toContain('重发上一条任务');
      expect(retryBtn.value.root_id).toBe(ROOT);
      expect(retryBtn.value.session_id).toBe(SID);
      expect(retryBtn.value.card_nonce).toBe('nonce_123');
    });
  });

  // ── Hidden display mode ────────────────────────────────────────────────

  describe('hidden display mode', () => {
    it('should NOT include markdown content element', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working', undefined, 'hidden'));
      const mdElements = card.elements.filter((e: any) => e.tag === 'markdown');
      expect(mdElements).toHaveLength(0);
    });

    it('should NOT include hr separator before actions', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working', undefined, 'hidden'));
      const hrElements = card.elements.filter((e: any) => e.tag === 'hr');
      expect(hrElements).toHaveLength(0);
    });

    it('should show toggle button text as "显示输出"', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working', undefined, 'hidden'));
      const actions = findActions(card);
      const toggleBtn = actions.find((a: any) => a.value?.action === 'toggle_display');
      expect(toggleBtn.text.content).toContain('显示输出');
    });

    it('should default to hidden when displayMode is undefined', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working'));
      const mdElements = card.elements.filter((e: any) => e.tag === 'markdown');
      expect(mdElements).toHaveLength(0);
    });
  });

  // ── Screenshot display mode ────────────────────────────────────────────

  describe('screenshot display mode', () => {
    it('should include screenshot placeholder when no image is available', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working', undefined, 'screenshot'));
      const mdElements = card.elements.filter((e: any) => e.tag === 'markdown');
      expect(mdElements).toHaveLength(1);
      expect(mdElements[0].content).toBe('_(等待第一张截图…)_');
    });

    it('should include hr separator after screenshot output', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working', undefined, 'screenshot'));
      expect(card.elements[0].tag).toBe('markdown');
      expect(card.elements[1].tag).toBe('hr');
    });

    it('should show toggle button text as "隐藏输出"', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working', undefined, 'screenshot'));
      const actions = findActions(card);
      const toggleBtn = actions.find((a: any) => a.value?.action === 'toggle_display');
      expect(toggleBtn.text.content).toContain('隐藏输出');
    });

    it('should include export text and refresh buttons', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'working', undefined, 'screenshot'));
      const actions = findActions(card);
      expect(actions.find((a: any) => a.value?.action === 'export_text')).toBeDefined();
      expect(actions.find((a: any) => a.value?.action === 'refresh_screenshot')).toBeDefined();
    });
  });

  // ── Nonce embedding ────────────────────────────────────────────────────

  describe('cardNonce embedding', () => {
    it('should embed card_nonce in toggle button value when provided', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'working', undefined, 'hidden', 'nonce_123'));
      const actions = findActions(card);
      const toggleBtn = actions.find((a: any) => a.value?.action === 'toggle_display');
      expect(toggleBtn.value.card_nonce).toBe('nonce_123');
    });

    it('should NOT include card_nonce when not provided', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'working', undefined, 'hidden'));
      const actions = findActions(card);
      const toggleBtn = actions.find((a: any) => a.value?.action === 'toggle_display');
      expect(toggleBtn.value).not.toHaveProperty('card_nonce');
    });

    it('should NOT include card_nonce when undefined is passed explicitly', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'working', undefined, 'hidden', undefined));
      const actions = findActions(card);
      const toggleBtn = actions.find((a: any) => a.value?.action === 'toggle_display');
      expect(toggleBtn.value).not.toHaveProperty('card_nonce');
    });
  });

  // ── Action buttons ─────────────────────────────────────────────────────

  describe('action buttons', () => {
    it('should include terminal button with multi_url', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'idle'));
      const actions = findActions(card);
      const termBtn = actions.find((a: any) => a.multi_url);
      expect(termBtn).toBeDefined();
      expectDirectUrl(termBtn.multi_url.url, URL);
      expectDirectUrl(termBtn.multi_url.pc_url, URL);
      expect(termBtn.multi_url.android_url).toBe(URL);
      expect(termBtn.multi_url.ios_url).toBe(URL);
      expect(termBtn.type).toBe('primary');
    });

    it('should include get_write_link button', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'idle'));
      const actions = findActions(card);
      const linkBtn = actions.find((a: any) => a.value?.action === 'get_write_link');
      expect(linkBtn).toBeDefined();
      expect(linkBtn.value.root_id).toBe(ROOT);
      expect(linkBtn.value.session_id).toBe(SID);
    });

    it('should include close button with danger type', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'idle'));
      const actions = findActions(card);
      const closeBtn = actions.find((a: any) => a.value?.action === 'close');
      expect(closeBtn).toBeDefined();
      expect(closeBtn.type).toBe('danger');
    });

    it('should have exactly 4 buttons (toggle, terminal, get_write_link, close)', () => {
      const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'idle'));
      const actions = findActions(card);
      expect(actions).toHaveLength(4);
    });
  });

  // ── CLI display name ───────────────────────────────────────────────────

  it('should default cliId to claude-code', () => {
    // The cliName is used internally; verify it doesn't throw and produces valid output
    const json = buildStreamingCard(SID, ROOT, URL, TITLE, '', 'idle');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ─── buildRepoSelectCard ──────────────────────────────────────────────────

describe('buildRepoSelectCard', () => {
  const projects: ProjectInfo[] = [
    { name: 'alpha', path: '/home/user/alpha', type: 'repo', branch: 'main' },
    { name: 'beta', path: '/home/user/beta', type: 'worktree', branch: 'feat-x' },
    { name: 'gamma', path: '/home/user/gamma', type: 'repo', branch: 'develop' },
  ];

  // The current-dir text + 「直接开启会话」and the manual input + button are
  // each wrapped in a column_set for same-row layout, so a plain top-level
  // .find() no longer reaches the div / input / button. Walk into column_set
  // columns and form elements to collect every node by tag.
  function deepFind(card: any, tag: string): any[] {
    const out: any[] = [];
    const walk = (els: any[]) => {
      for (const el of els ?? []) {
        if (el?.tag === tag) out.push(el);
        if (Array.isArray(el?.columns)) el.columns.forEach((c: any) => walk(c.elements));
        if (Array.isArray(el?.elements)) walk(el.elements);
        if (Array.isArray(el?.actions)) walk(el.actions);
      }
    };
    walk(card.elements);
    return out;
  }

  it('should return valid JSON', () => {
    const json = buildRepoSelectCard(projects);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('should have wide_screen_mode config', () => {
    const card = parse(buildRepoSelectCard(projects));
    expect(card.config.wide_screen_mode).toBe(true);
  });

  it('should have blue header with project management title', () => {
    const card = parse(buildRepoSelectCard(projects));
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('项目仓库管理');
  });

  // ── Current path display ───────────────────────────────────────────────

  describe('current path display', () => {
    it('should show currentPath when provided', () => {
      const card = parse(buildRepoSelectCard(projects, '/home/user/alpha'));
      const divEl = deepFind(card, 'div')[0];
      expect(divEl.text.content).toContain('/home/user/alpha');
    });

    it('should show "N/A" when currentPath is undefined', () => {
      const card = parse(buildRepoSelectCard(projects));
      const divEl = deepFind(card, 'div')[0];
      expect(divEl.text.content).toContain('N/A');
    });

    it('should escape markdown special chars in currentPath', () => {
      const card = parse(buildRepoSelectCard(projects, '/home/user/[special]'));
      const divEl = deepFind(card, 'div')[0];
      expect(divEl.text.content).toContain('\\[special\\]');
    });

    it('uses the "当前工作目录" label (not "项目")', () => {
      const card = parse(buildRepoSelectCard(projects, '/home/user/alpha'));
      const divEl = deepFind(card, 'div')[0];
      expect(divEl.text.content).toContain('当前工作目录');
      expect(divEl.text.content).not.toContain('当前活跃项目');
    });
  });

  // ── Project options ────────────────────────────────────────────────────

  describe('project options', () => {
    it('should render all projects as select_static options', () => {
      const card = parse(buildRepoSelectCard(projects));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.options).toHaveLength(3);
    });

    it('should use 1-based numbering in option text', () => {
      const card = parse(buildRepoSelectCard(projects));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.options[0].text.content).toMatch(/^1\./);
      expect(selectStatic.options[1].text.content).toMatch(/^2\./);
      expect(selectStatic.options[2].text.content).toMatch(/^3\./);
    });

    it('should include project name and branch in option text', () => {
      const card = parse(buildRepoSelectCard(projects));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.options[0].text.content).toContain('alpha');
      expect(selectStatic.options[0].text.content).toContain('main');
    });

    it('should use path as option value', () => {
      const card = parse(buildRepoSelectCard(projects));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.options[0].value).toBe('/home/user/alpha');
      expect(selectStatic.options[1].value).toBe('/home/user/beta');
    });

    it('should tag worktree projects with [worktree]', () => {
      const card = parse(buildRepoSelectCard(projects));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.options[1].text.content).toContain('[worktree]');
      // Non-worktree should NOT have the tag
      expect(selectStatic.options[0].text.content).not.toContain('[worktree]');
    });

    it('should tag current project with "当前"', () => {
      const card = parse(buildRepoSelectCard(projects, '/home/user/alpha'));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.options[0].text.content).toContain('当前');
      // Other projects should NOT have the tag
      expect(selectStatic.options[1].text.content).not.toContain('当前');
      expect(selectStatic.options[2].text.content).not.toContain('当前');
    });
  });

  // ── rootMessageId ──────────────────────────────────────────────────────

  describe('rootMessageId', () => {
    it('should embed rootMessageId in select value', () => {
      const card = parse(buildRepoSelectCard(projects, undefined, 'om_root_123'));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.value.root_id).toBe('om_root_123');
    });

    it('should default rootMessageId to empty string', () => {
      const card = parse(buildRepoSelectCard(projects));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.value.root_id).toBe('');
    });
  });

  // ── Skip repo button ──────────────────────────────────────────────────

  describe('skip repo button', () => {
    it('should include "直接开启会话" button with primary type, paired with the current-dir row', () => {
      const card = parse(buildRepoSelectCard(projects, undefined, 'om_root'));
      const skipBtn = deepFind(card, 'button').find((b: any) => b.value?.action === 'skip_repo');
      expect(skipBtn).toBeDefined();
      expect(skipBtn.type).toBe('primary');
      expect(skipBtn.text.content).toContain('直接开启会话');
      expect(skipBtn.value.root_id).toBe('om_root');
      // It now lives in the top column_set (next to 当前工作目录), NOT in the
      // switch-dropdown action row.
      const switchRow = card.elements.find((e: any) => e.tag === 'action');
      expect(switchRow.actions.some((a: any) => a.value?.action === 'skip_repo')).toBe(false);
      expect(card.elements[0].tag).toBe('column_set');
      const topButtons = deepFind({ elements: [card.elements[0]] }, 'button');
      expect(topButtons.some((b: any) => b.value?.action === 'skip_repo')).toBe(true);
    });
  });

  // ── Note element ──────────────────────────────────────────────────────

  describe('note element', () => {
    it('should include hint about /repo command', () => {
      const card = parse(buildRepoSelectCard(projects));
      const noteEl = card.elements.find((e: any) => e.tag === 'note');
      expect(noteEl).toBeDefined();
      const noteContent = noteEl.elements[0].content;
      expect(noteContent).toContain('/repo');
    });
  });

  // ── Element structure ─────────────────────────────────────────────────

  describe('element structure', () => {
    it('should have 6 top-level elements: dir+skip column_set, hr, switch action, worktree action, manual form, note', () => {
      const card = parse(buildRepoSelectCard(projects));
      expect(card.elements).toHaveLength(6);
      expect(card.elements[0].tag).toBe('column_set'); // 当前工作目录 + 直接开启会话
      expect(card.elements[1].tag).toBe('hr');
      expect(card.elements[2].tag).toBe('action');     // 选择仓库并切换 dropdown
      expect(card.elements[3].tag).toBe('action');     // worktree dropdown
      expect(card.elements[4].tag).toBe('form');       // manual entry
      expect(card.elements[5].tag).toBe('note');
    });

    it('manual-entry form carries an input + form_submit button (same row via column_set)', () => {
      const card = parse(buildRepoSelectCard(projects, undefined, 'om_root'));
      const form = card.elements.find((e: any) => e.tag === 'form' && e.name === 'repo_manual_form');
      expect(form).toBeDefined();
      // input + button now share a row inside a column_set under the form
      expect(form.elements[0].tag).toBe('column_set');
      const input = deepFind({ elements: [form] }, 'input')[0];
      expect(input.name).toBe('repo_manual_path');
      const btn = deepFind({ elements: [form] }, 'button').find((b: any) => b.name === 'repo_manual_submit');
      expect(btn.action_type).toBe('form_submit');
      expect(btn.value.action).toBe('repo_manual_submit');
      expect(btn.value.root_id).toBe('om_root');
    });

    it('keeps the manual-entry form even when no main repos exist (worktree action omitted)', () => {
      const onlyWorktrees: ProjectInfo[] = [
        { name: 'beta', path: '/home/user/beta', type: 'worktree', branch: 'feat-x' },
      ];
      const card = parse(buildRepoSelectCard(onlyWorktrees));
      // column_set(dir+skip), hr, switch action, form, note — worktree action dropped, form stays
      expect(card.elements.map((e: any) => e.tag)).toEqual(['column_set', 'hr', 'action', 'form', 'note']);
    });
  });

  // ── Worktree-open dropdown ─────────────────────────────────────────────

  describe('worktree-open dropdown', () => {
    function worktreeSelect(card: any): any {
      const actionEls = card.elements.filter((e: any) => e.tag === 'action');
      for (const el of actionEls) {
        const sel = el.actions.find((a: any) => a.value?.key === 'repo_worktree');
        if (sel) return sel;
      }
      return undefined;
    }

    it('should list only main repos (no existing worktrees)', () => {
      const card = parse(buildRepoSelectCard(projects));
      const sel = worktreeSelect(card);
      expect(sel.options).toHaveLength(2);
      const labels = sel.options.map((o: any) => o.text.content);
      expect(labels.join()).toContain('alpha');
      expect(labels.join()).toContain('gamma');
      expect(labels.join()).not.toContain('beta');
    });

    it('should carry the repo path as the option value and root_id in value', () => {
      const card = parse(buildRepoSelectCard(projects, undefined, 'om_root'));
      const sel = worktreeSelect(card);
      expect(sel.options[0].value).toBe('/home/user/alpha');
      expect(sel.value.root_id).toBe('om_root');
    });

    it('should be omitted when no main repos exist', () => {
      const onlyWorktrees: ProjectInfo[] = [
        { name: 'beta', path: '/home/user/beta', type: 'worktree', branch: 'feat-x' },
      ];
      const card = parse(buildRepoSelectCard(onlyWorktrees));
      expect(worktreeSelect(card)).toBeUndefined();
    });
  });

  // ── Empty projects list ───────────────────────────────────────────────

  describe('empty projects list', () => {
    it('should render with zero options', () => {
      const card = parse(buildRepoSelectCard([]));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const selectStatic = actionEl.actions.find((a: any) => a.tag === 'select_static');
      expect(selectStatic.options).toHaveLength(0);
    });
  });
});

// ─── buildSessionClosedCard ─────────────────────────────────────────────────

describe('buildSessionClosedCard', () => {
  function findMarkdownContent(card: any): string {
    const md = card.elements.find((e: any) => e.tag === 'markdown');
    return md?.content ?? '';
  }

  it('embeds the CLI-native resume command in a code block when provided', () => {
    const card = parse(buildSessionClosedCard(
      'sess-1', 'om_root', 'My topic', 'claude-code', '/srv/app',
      'claude --resume cli-99',
    ));
    const md = findMarkdownContent(card);
    expect(md).toContain('claude --resume cli-99');
    // Code-fenced so users can long-press to copy in Lark
    expect(md).toMatch(/```\nclaude --resume cli-99\n```/);
    // Must NOT print the legacy `botmux resume <id>` text — that command
    // re-enables the bridge in botmux but is not the CLI-native resume the
    // user asked for.
    expect(md).not.toContain('botmux resume');
  });

  it('renders the working dir line', () => {
    const card = parse(buildSessionClosedCard(
      'sess-2', 'om_root', '', 'codex', '/proj/x',
      'codex resume cdx-uuid',
    ));
    expect(findMarkdownContent(card)).toContain('/proj/x');
  });

  it('shows a fallback note when the CLI cannot resume from CLI args (gemini/opencode)', () => {
    const card = parse(buildSessionClosedCard(
      'sess-3', 'om_root', 'topic', 'opencode', undefined, null,
    ));
    const md = findMarkdownContent(card);
    expect(md).toContain('不支持');
    expect(md).not.toMatch(/```/);
  });

  it('emits a Resume button targeting the closed sessionId', () => {
    const card = parse(buildSessionClosedCard(
      'sess-4', 'om_root_X', 'topic', 'claude-code', undefined,
      'claude --resume sess-4',
    ));
    const action = card.elements.find((e: any) => e.tag === 'action');
    const resumeBtn = action.actions.find((a: any) => a.value?.action === 'resume');
    expect(resumeBtn).toBeDefined();
    expect(resumeBtn.value.session_id).toBe('sess-4');
    expect(resumeBtn.value.root_id).toBe('om_root_X');
    expect(resumeBtn.type).toBe('primary');
  });
});

describe('buildRelayPickerCard', () => {
  // Helpers that walk past the search-form prefix to find session
  // interactive_containers regardless of how the picker layout evolves.
  function containers(card: any): any[] {
    return card.body.elements.filter((e: any) => e.tag === 'interactive_container');
  }
  function searchInput(card: any): any | undefined {
    return card.body.elements.find((e: any) => e.tag === 'input' && e.name === 'search');
  }
  function confirmButton(card: any): any | undefined {
    for (const e of card.body.elements) {
      if (e.tag !== 'column_set') continue;
      const btn = e.columns?.[0]?.elements?.[0];
      if (btn?.tag === 'button' && btn?.behaviors?.[0]?.value?.action === 'relay_confirm') return btn;
    }
    return undefined;
  }

  function fixtureEntries(n: number): RelayPickerEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      sessionId: `sess-${i + 1}`,
      chatLabel: `Chat ${i + 1}`,
      title: `session ${i + 1}`,
      chatMode: 'group' as const,
      lastMessageAt: Date.now() - (i + 1) * 60_000,
    }));
  }

  it('uses Lark v2 schema (schema: 2.0) with a body.elements array', () => {
    const card = parse(buildRelayPickerCard([], 'oc_target', 'om_target_root', 'ou_invoker_test'));
    expect(card.schema).toBe('2.0');
    expect(card.body.elements).toBeDefined();
  });

  it('always renders the search input at the top with auto-submit behavior, even when entry list is empty', () => {
    const card = parse(buildRelayPickerCard([], 'oc_target', 'om_target_root', 'ou_invoker_test'));
    const input = searchInput(card);
    expect(input).toBeDefined();
    // v2 input.behaviors fires on Enter / submit icon click — no separate
    // 搜索 button needed (used to render as "..." in cramped column).
    expect(input.behaviors).toHaveLength(1);
    expect(input.behaviors[0].type).toBe('callback');
    expect(input.behaviors[0].value.action).toBe('relay_search');
    expect(input.behaviors[0].value.target_chat_id).toBe('oc_target');
  });

  it('carries target_scope in interactive values (defaults to chat, thread when passed)', () => {
    // Default → chat-scope (legacy普通群-flat behavior).
    const flat = parse(buildRelayPickerCard(fixtureEntries(1), 'oc_target', 'oc_target', 'ou_invoker_test'));
    expect(searchInput(flat).behaviors[0].value.target_scope).toBe('chat');
    expect(containers(flat)[0].behaviors[0].value.target_scope).toBe('chat');
    // Explicit thread → carried through so the confirm handler routes 话题.
    const topic = parse(buildRelayPickerCard(fixtureEntries(1), 'oc_target', 'om_topic_root', 'ou_invoker_test', undefined, undefined, 'thread'));
    expect(searchInput(topic).behaviors[0].value.target_scope).toBe('thread');
    expect(containers(topic)[0].behaviors[0].value.target_scope).toBe('thread');
    expect(containers(topic)[0].behaviors[0].value.root_id).toBe('om_topic_root');
  });

  it('carries target_chat_type in interactive values (defaults to group, p2p when passed) and swaps DM copy', () => {
    // Default → group (legacy behavior + legacy cards).
    const grp = parse(buildRelayPickerCard(fixtureEntries(1), 'oc_target', 'oc_target', 'ou_invoker_test'));
    expect(searchInput(grp).behaviors[0].value.target_chat_type).toBe('group');
    expect(containers(grp)[0].behaviors[0].value.target_chat_type).toBe('group');
    expect(grp.header.title.content).toMatch(/本群|this group/);
    // p2p → carried through so relay_confirm flips the session chatType; the
    // header + confirm copy switch to the DM variants.
    const dm = parse(buildRelayPickerCard(fixtureEntries(1), 'oc_dm', 'om_dm_root', 'ou_invoker_test', undefined, { selectedSessionId: fixtureEntries(1)[0].sessionId }, 'thread', 'p2p'));
    expect(searchInput(dm).behaviors[0].value.target_chat_type).toBe('p2p');
    expect(containers(dm)[0].behaviors[0].value.target_chat_type).toBe('p2p');
    expect(dm.header.title.content).toMatch(/单聊|DM/);
    const confirmBtn = JSON.stringify(dm.body.elements);
    expect(confirmBtn).toMatch(/接力到本单聊|into this DM/);
  });

  it('renders "no relayable sessions" notice when entries empty (form still shown)', () => {
    const card = parse(buildRelayPickerCard([], 'oc_target', 'om_target_root', 'ou_invoker_test'));
    const md = card.body.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content).toMatch(/没有可接力|No relayable/);
    expect(containers(card)).toHaveLength(0);
  });

  it('paginates: 12 entries renders only the first 5 by default + paginator row', () => {
    const card = parse(buildRelayPickerCard(fixtureEntries(12), 'oc_target', 'om_target_root', 'ou_invoker_test'));
    expect(containers(card)).toHaveLength(5);
    expect(containers(card)[0].behaviors[0].value.session_id).toBe('sess-1');
    expect(containers(card)[4].behaviors[0].value.session_id).toBe('sess-5');

    // Paginator column_set with prev/next buttons.
    const paginator = card.body.elements.find((e: any) =>
      e.tag === 'column_set'
      && e.columns?.some((c: any) => c.elements?.[0]?.behaviors?.[0]?.value?.action === 'relay_page'));
    expect(paginator).toBeDefined();
    const prev = paginator.columns[0].elements[0];
    const next = paginator.columns[2].elements[0];
    expect(prev.disabled).toBe(true);  // on page 0
    expect(next.disabled).toBe(false);
    expect(next.behaviors[0].value.page).toBe(1);
  });

  it('jumping to page 2 (0-indexed) shows entries 11–12, next button disabled', () => {
    const card = parse(buildRelayPickerCard(fixtureEntries(12), 'oc_t', 'om_r', 'ou_invoker_test', undefined, { page: 2 }));
    const c = containers(card);
    expect(c).toHaveLength(2); // 12 - 10 = 2 on the last page
    expect(c[0].behaviors[0].value.session_id).toBe('sess-11');
    const paginator = card.body.elements.find((e: any) =>
      e.tag === 'column_set'
      && e.columns?.some((cc: any) => cc.elements?.[0]?.behaviors?.[0]?.value?.action === 'relay_page'));
    expect(paginator.columns[2].elements[0].disabled).toBe(true);
  });

  it('hides paginator when entries fit on a single page', () => {
    const card = parse(buildRelayPickerCard(fixtureEntries(3), 'oc_t', 'om_r', 'ou_invoker_test'));
    const hasPaginator = card.body.elements.some((e: any) =>
      e.tag === 'column_set'
      && e.columns?.some((c: any) => c.elements?.[0]?.behaviors?.[0]?.value?.action === 'relay_page'));
    expect(hasPaginator).toBe(false);
  });

  it('filters by case-insensitive substring match on title / chatLabel / cwd / cliId', () => {
    const entries: RelayPickerEntry[] = [
      { sessionId: 's1', chatLabel: 'Project Alpha', title: 'PR review',  chatMode: 'group', workingDir: '/work/api' },
      { sessionId: 's2', chatLabel: 'Team docs',     title: 'docs sync',  chatMode: 'group', workingDir: '/work/docs' },
      { sessionId: 's3', chatLabel: 'Marketing',     title: 'launch plan', chatMode: 'group', workingDir: '/work/marketing' },
    ];
    const card = parse(buildRelayPickerCard(entries, 'oc_t', 'om_r', 'ou_invoker_test', undefined, { searchQuery: 'docs' }));
    const c = containers(card);
    expect(c).toHaveLength(1);
    expect(c[0].behaviors[0].value.session_id).toBe('s2');
  });

  it('shows "no matches" notice when search filters everything out', () => {
    const card = parse(buildRelayPickerCard(fixtureEntries(3), 'oc_t', 'om_r', 'ou_invoker_test', undefined, { searchQuery: 'xyz_no_match' }));
    expect(containers(card)).toHaveLength(0);
    const allMd = card.body.elements.filter((e: any) => e.tag === 'markdown').map((e: any) => e.content).join('\n');
    expect(allMd).toMatch(/没有匹配|No sessions match/);
  });

  it('selection highlights the chosen card and appends a confirm button', () => {
    const card = parse(buildRelayPickerCard(fixtureEntries(3), 'oc_t', 'om_r', 'ou_invoker_test', undefined, { selectedSessionId: 'sess-2' }));
    const c = containers(card);
    expect(c[0].background_style).toBe('default');
    expect(c[1].background_style).toBe('laser');
    expect(c[2].background_style).toBe('default');

    const btn = confirmButton(card);
    expect(btn).toBeDefined();
    expect(btn.behaviors[0].value.session_id).toBe('sess-2');
  });

  it('renders a disabled "running" button (no confirm action) when the selected session is mid-turn', () => {
    const entries = fixtureEntries(3);
    entries[1] = { ...entries[1], running: true }; // sess-2 is mid-turn
    const card = parse(buildRelayPickerCard(entries, 'oc_t', 'om_r', 'ou_invoker_test', undefined, { selectedSessionId: 'sess-2' }));

    // No clickable confirm button (it carries no relay_confirm action).
    expect(confirmButton(card)).toBeUndefined();

    // Instead a disabled button with the "running" label exists.
    let disabledBtn: any;
    for (const e of card.body.elements) {
      if (e.tag !== 'column_set') continue;
      const btn = e.columns?.[0]?.elements?.[0];
      if (btn?.tag === 'button' && btn?.disabled === true && !btn?.behaviors) { disabledBtn = btn; break; }
    }
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn.text.content).toMatch(/运行中|running/i);
  });

  it('renders the normal clickable confirm button when the selected session is NOT running', () => {
    const entries = fixtureEntries(3);
    entries[1] = { ...entries[1], running: false };
    const card = parse(buildRelayPickerCard(entries, 'oc_t', 'om_r', 'ou_invoker_test', undefined, { selectedSessionId: 'sess-2' }));
    const btn = confirmButton(card);
    expect(btn).toBeDefined();
    expect(btn.behaviors[0].value.session_id).toBe('sess-2');
  });

  it('falls back to no-confirm state if selectedSessionId is filtered out', () => {
    const card = parse(buildRelayPickerCard(fixtureEntries(3), 'oc_t', 'om_r', 'ou_invoker_test', undefined, { selectedSessionId: 'sess-vanished' }));
    expect(confirmButton(card)).toBeUndefined();
    // Hint markdown should still be there.
    const allMd = card.body.elements.filter((e: any) => e.tag === 'markdown').map((e: any) => e.content).join('\n');
    expect(allMd).toMatch(/点击上方|Tap any/);
  });

  it('container markdown shows title / status / type / location / time on five labelled lines', () => {
    const entries: RelayPickerEntry[] = [
      { sessionId: 'sess-1', chatLabel: 'Project Alpha 讨论群', title: 'fix the deadlock bug', chatMode: 'group', lastMessageAt: Date.now() - 60_000 },
    ];
    const card = parse(buildRelayPickerCard(entries, 'oc_t', 'om_r', 'ou_invoker_test'));
    const md = containers(card)[0].elements[0].content;
    const lines = md.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\*\*fix the deadlock bug\*\*$/);
    // Status line — idle by default (no `running` flag on the fixture).
    expect(lines[1]).toMatch(/^(状态|Status): (⚪ 空闲|⚪ Idle)$/);
    expect(lines[2]).toMatch(/^(类型|Type): (普通群|group chat)$/);
    expect(lines[3]).toMatch(/(位置|Where): Project Alpha 讨论群/);
    expect(lines[4]).toMatch(/(活跃|Active): /);
  });

  it('status line shows 运行中 / Running for a session flagged running', () => {
    const entries: RelayPickerEntry[] = [
      { sessionId: 'sess-1', chatLabel: 'Chat', title: 'busy task', chatMode: 'group', running: true },
    ];
    const card = parse(buildRelayPickerCard(entries, 'oc_t', 'om_r', 'ou_invoker_test'));
    const md = containers(card)[0].elements[0].content;
    expect(md).toMatch(/(状态|Status): 🟢 (运行中|Running)/);
  });

  it('uses "单聊" / "direct message" as the location for p2p, ignoring chatLabel', () => {
    const entries: RelayPickerEntry[] = [
      { sessionId: 'sess-p2p', chatLabel: 'some_p2p_chat_id', title: 'private chat', chatMode: 'p2p' },
    ];
    const card = parse(buildRelayPickerCard(entries, 'oc_t', 'om_r', 'ou_invoker_test'));
    const md = containers(card)[0].elements[0].content;
    expect(md).toMatch(/(类型|Type): (单聊|direct message)/);
    expect(md).toMatch(/(位置|Where): (单聊|direct message)/);
    expect(md).not.toContain('some_p2p_chat_id');
  });

  it('embeds invoker_open_id into every interactive button value (owner-only guard)', () => {
    // Card-handler refuses re-renders / confirms when the clicker's open_id
    // disagrees with the invoker_open_id carried in the value. To make that
    // work, every clickable element here must stamp the invoker into its
    // callback `value` — search input, session containers, paginator
    // buttons, confirm button. Skipping any one would leave a click path
    // unprotected.
    const card = parse(buildRelayPickerCard(
      fixtureEntries(12), 'oc_t', 'om_r', 'ou_specific_invoker',
      undefined, { selectedSessionId: 'sess-1' },
    ));

    // Collect every `value` object on any button/container/input by walking
    // the card tree; verify each one carries invoker_open_id.
    const values: any[] = [];
    const walk = (node: any) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== 'object') return;
      if (node.behaviors) for (const b of node.behaviors) if (b.value) values.push(b.value);
      if (node.value && typeof node.value === 'object' && (node.value as any).action) values.push(node.value);
      for (const v of Object.values(node)) walk(v);
    };
    walk(card);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v.invoker_open_id).toBe('ou_specific_invoker');
    }
  });
});

// ─── buildPrivateSnapshotCard (private /card ephemeral snapshot) ─────────────

describe('buildPrivateSnapshotCard', () => {
  const build = (over: Partial<{
    imageKey?: string; screen: string; status: any; usageLimit: any;
  }> = {}) => parse(buildPrivateSnapshotCard(
    'https://t.example/ro',
    'my session',
    over.status ?? 'idle',
    'claude-code',
    over.imageKey,
    over.screen ?? '',
    'sess-9',
    'om_anchor',
    'zh',
    over.usageLimit,
  ));

  function allButtons(card: any): any[] {
    return card.elements
      .filter((e: any) => e.tag === 'action')
      .flatMap((e: any) => e.actions ?? []);
  }

  it('exposes exactly open-terminal (link), get_write_link, close — no patch-driven controls', () => {
    const card = build({ screen: 'hello' });
    const btns = allButtons(card);
    const actions = btns.map((b: any) => b.value?.action).filter(Boolean);
    expect(actions.sort()).toEqual(['close', 'get_write_link']);
    // open-terminal is a URL button (no callback action)
    const link = btns.find((b: any) => b.multi_url);
    expectDirectUrl(link.multi_url.url, 'https://t.example/ro');
    expectDirectUrl(link.multi_url.pc_url, 'https://t.example/ro');
    expect(link.multi_url.android_url).toBe('https://t.example/ro');
    expect(link.multi_url.ios_url).toBe('https://t.example/ro');
    // none of the patch-driven / quick-key controls leak in
    for (const bad of ['toggle_display', 'export_text', 'refresh_screenshot', 'term_action']) {
      expect(actions).not.toContain(bad);
    }
  });

  it('callback buttons carry root_id/session_id/cli_id for handler resolution', () => {
    const card = build({ screen: 'x' });
    const btns = allButtons(card);
    for (const action of ['get_write_link', 'close']) {
      const b = btns.find((x: any) => x.value?.action === action);
      expect(b.value).toMatchObject({ root_id: 'om_anchor', session_id: 'sess-9', cli_id: 'claude-code' });
    }
  });

  it("pins visibility:'private' on callback buttons so close stays ephemeral if privateCard is later turned off", () => {
    const card = build({ screen: 'x' });
    const btns = allButtons(card);
    const closeBtn = btns.find((b: any) => b.value?.action === 'close');
    expect(closeBtn.value.visibility).toBe('private');
  });

  it('never embeds a writable terminal link', () => {
    const json = buildPrivateSnapshotCard('https://t.example/ro', 't', 'idle', 'claude-code', undefined, 'tok-bearing-content', 'sess-9', 'om_anchor', 'zh');
    // only the read-only URL appears; no second token-bearing markdown link
    const mdLinks = JSON.parse(json).elements.filter((e: any) => e.tag === 'markdown');
    expect(mdLinks.every((m: any) => !m.content.includes('?token='))).toBe(true);
  });

  it('renders a code-block text fallback when there is no screenshot', () => {
    const card = build({ screen: 'line1\nline2\n$ done' });
    const md = card.elements.find((e: any) => e.tag === 'markdown' && /```/.test(e.content));
    expect(md).toBeDefined();
    expect(md.content).toContain('line1');
    expect(md.content).toContain('$ done');
  });

  it('renders the screenshot (no text block) when an imageKey is present', () => {
    const card = build({ imageKey: 'img_v2_abc', screen: 'should-not-render' });
    const img = card.elements.find((e: any) => e.tag === 'img');
    expect(img.img_key).toBe('img_v2_abc');
    const codeMd = card.elements.find((e: any) => e.tag === 'markdown' && /```/.test(e.content));
    expect(codeMd).toBeUndefined();
  });

  it('omits the body entirely when there is neither screenshot nor screen text', () => {
    const card = build({ screen: '   \n  ' });
    expect(card.elements.find((e: any) => e.tag === 'img')).toBeUndefined();
    expect(card.elements.find((e: any) => e.tag === 'markdown' && /```/.test(e.content))).toBeUndefined();
  });

  it('uses a fence longer than any backtick run in the content', () => {
    const card = build({ screen: 'a\n```\nfenced\n```\nb' });
    const md = card.elements.find((e: any) => e.tag === 'markdown' && /`{4,}/.test(e.content));
    // content has a ``` run → fence must be at least 4 backticks
    expect(md).toBeDefined();
    expect(md.content.startsWith('````')).toBe(true);
  });

  it('marks the header with the private lock glyph and carries the private note', () => {
    const card = build({ screen: 'x' });
    expect(card.header.title.content.startsWith('🔒')).toBe(true);
    const note = card.elements.find((e: any) => e.tag === 'note');
    expect(JSON.stringify(note)).toContain('🔒');
  });
});
