/**
 * Unit tests for card-builder: buildSessionCard, buildStreamingCard,
 * buildRepoSelectCard, getCliDisplayName.
 *
 * These are pure functions — no mocking required.
 *
 * Run:  pnpm vitest run test/card-builder.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  buildSessionCard,
  buildStreamingCard,
  buildRepoSelectCard,
  getCliDisplayName,
} from '../src/im/lark/card-builder.js';
import type { ProjectInfo } from '../src/services/project-scanner.js';

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
      expect(terminalBtn.multi_url.url).toBe(URL);
      expect(terminalBtn.multi_url.pc_url).toBe(URL);
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
      expect(termBtn.multi_url.url).toBe(URL);
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
      const divEl = card.elements.find((e: any) => e.tag === 'div');
      expect(divEl.text.content).toContain('/home/user/alpha');
    });

    it('should show "N/A" when currentPath is undefined', () => {
      const card = parse(buildRepoSelectCard(projects));
      const divEl = card.elements.find((e: any) => e.tag === 'div');
      expect(divEl.text.content).toContain('N/A');
    });

    it('should escape markdown special chars in currentPath', () => {
      const card = parse(buildRepoSelectCard(projects, '/home/user/[special]'));
      const divEl = card.elements.find((e: any) => e.tag === 'div');
      expect(divEl.text.content).toContain('\\[special\\]');
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
    it('should include "直接开启会话" button with primary type', () => {
      const card = parse(buildRepoSelectCard(projects, undefined, 'om_root'));
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      const skipBtn = actionEl.actions.find((a: any) => a.value?.action === 'skip_repo');
      expect(skipBtn).toBeDefined();
      expect(skipBtn.type).toBe('primary');
      expect(skipBtn.text.content).toContain('直接开启会话');
      expect(skipBtn.value.root_id).toBe('om_root');
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
    it('should have 4 top-level elements: div, hr, action, note', () => {
      const card = parse(buildRepoSelectCard(projects));
      expect(card.elements).toHaveLength(4);
      expect(card.elements[0].tag).toBe('div');
      expect(card.elements[1].tag).toBe('hr');
      expect(card.elements[2].tag).toBe('action');
      expect(card.elements[3].tag).toBe('note');
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
