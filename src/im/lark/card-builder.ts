import type { ProjectInfo } from '../../services/project-scanner.js';
import type { CliId } from '../../adapters/cli/types.js';
import type { AdoptableSession } from '../../core/session-discovery.js';
import type { DisplayMode } from '../../types.js';

const cliDisplayNames: Record<CliId, string> = {
  'claude-code': 'Claude',
  'aiden': 'Aiden',
  'coco': 'CoCo',
  'codex': 'Codex',
  'gemini': 'Gemini',
  'opencode': 'OpenCode',
};

export function getCliDisplayName(cliId: CliId): string {
  return cliDisplayNames[cliId] ?? cliId;
}

/** Escape Lark markdown special characters in user-controlled strings. */
function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\]/g, c => `\\${c}`);
}

/**
 * Build a Feishu interactive card with terminal button + action buttons.
 * @param showManageButtons - When true, include restart & close buttons (used in DM cards with write token).
 */
export function buildSessionCard(
  sessionId: string,
  rootId: string,
  terminalUrl: string,
  title: string,
  cliId?: CliId,
  showManageButtons?: boolean,
): string {
  const cliName = getCliDisplayName(cliId ?? 'claude-code');
  const actions: any[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: showManageButtons ? '🖥️ 打开可操作终端' : '🖥️ 打开终端' },
      type: 'primary',
      multi_url: {
        url: terminalUrl,
        pc_url: terminalUrl,
        android_url: terminalUrl,
        ios_url: terminalUrl,
      },
    },
  ];
  if (!showManageButtons) {
    // Group card: show "get write link" button (DM card already has the write token)
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔑 获取操作链接' },
      type: 'default',
      value: { action: 'get_write_link', root_id: rootId, session_id: sessionId },
    });
  }
  if (showManageButtons) {
    // DM card: include restart button
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `🔄 重启 ${cliName}` },
      type: 'default',
      value: { action: 'restart', root_id: rootId, session_id: sessionId },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '❌ 关闭会话' },
    type: 'danger',
    value: { action: 'close', root_id: rootId, session_id: sessionId },
  });
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥️ ${escapeMd(title)}` },
      template: 'blue',
    },
    elements: [
      { tag: 'action', actions },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Feishu card API rejects payloads exceeding ~109 KB (error 230025).
 * Cap markdown content byte size with headroom for card JSON overhead.
 */
const MAX_CONTENT_BYTES = 100_000;

/** Truncate content to fit within MAX_CONTENT_BYTES, keeping the tail (most recent output). */
function truncateContent(content: string): string {
  if (Buffer.byteLength(content, 'utf-8') <= MAX_CONTENT_BYTES) return content;
  // Binary search for the longest suffix that fits
  const lines = content.split('\n');
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = lines.slice(mid).join('\n');
    if (Buffer.byteLength(candidate, 'utf-8') <= MAX_CONTENT_BYTES - 30) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return `… (已截断)\n${lines.slice(lo).join('\n')}`;
}

/**
 * Build a Feishu streaming card that shows live terminal output + controls.
 * This card is PATCHed in-place as the CLI works.
 *
 * displayMode:
 *   - 'hidden'     — body collapsed; only header + main controls visible.
 *   - 'screenshot' — img element (rendered server-side, uploaded for img_key).
 *   - 'text'       — markdown element with terminal text content.
 *
 * Quick-action buttons (Esc, ^C, Tab, Space, Enter, ←↑↓→, ½屏 ↑/↓) appear
 * whenever displayMode !== 'hidden', regardless of body type.
 */
export function buildStreamingCard(
  sessionId: string,
  rootId: string,
  terminalUrl: string,
  title: string,
  screenContent: string,
  status: 'starting' | 'working' | 'idle' | 'analyzing',
  cliId?: CliId,
  displayMode: DisplayMode = 'hidden',
  cardNonce?: string,
  imageKey?: string,
  adoptMode?: boolean,
  showTakeover?: boolean,
): string {
  void cliId;
  const templateMap = { starting: 'yellow', working: 'blue', idle: 'green', analyzing: 'purple' } as const;
  const statusMap = { starting: '启动中…', working: '工作中', idle: '等待输入', analyzing: '正在分析…' } as const;

  const elements: any[] = [];

  // ── Output body ─────────────────────────────────────────────────────────
  if (displayMode === 'screenshot') {
    if (imageKey) {
      elements.push({
        tag: 'img',
        img_key: imageKey,
        alt: { tag: 'plain_text', content: '' },
        mode: 'fit_horizontal',
        preview: true,
      });
    } else {
      elements.push({ tag: 'markdown', content: '_(等待第一张截图…)_' });
    }
    elements.push({ tag: 'hr' });
  } else if (displayMode === 'text') {
    const displayContent = truncateContent(screenContent) || '(等待输出…)';
    elements.push({ tag: 'markdown', content: displayContent });
    elements.push({ tag: 'hr' });
  }

  // ── Main control row: display toggle, mode toggle, terminal, manage ─────
  const headerActions: any[] = [];

  headerActions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: displayMode === 'hidden' ? '📖 显示输出' : '📕 隐藏输出' },
    type: 'default' as const,
    value: { action: 'toggle_display', root_id: rootId, session_id: sessionId, ...(cardNonce ? { card_nonce: cardNonce } : {}) },
  });
  if (displayMode !== 'hidden') {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: displayMode === 'text' ? '🖼️ 截图' : '📝 文字' },
      type: 'default' as const,
      value: { action: 'toggle_mode', root_id: rootId, session_id: sessionId, ...(cardNonce ? { card_nonce: cardNonce } : {}) },
    });
  }
  if (displayMode === 'screenshot') {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔃 刷新' },
      type: 'default' as const,
      value: { action: 'refresh_screenshot', root_id: rootId, session_id: sessionId, ...(cardNonce ? { card_nonce: cardNonce } : {}) },
    });
  }
  headerActions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '🖥️ 打开终端' },
    type: 'primary',
    multi_url: { url: terminalUrl, pc_url: terminalUrl, android_url: terminalUrl, ios_url: terminalUrl },
  });
  headerActions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '🔑 获取操作链接' },
    type: 'default',
    value: { action: 'get_write_link', root_id: rootId, session_id: sessionId },
  });
  if (adoptMode) {
    if (showTakeover) {
      headerActions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '🔄 接管' },
        type: 'default' as const,
        value: { action: 'takeover', root_id: rootId, session_id: sessionId },
      });
    }
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏏ 断开' },
      type: 'danger' as const,
      value: { action: 'disconnect', root_id: rootId, session_id: sessionId },
    });
  } else {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '❌ 关闭会话' },
      type: 'danger' as const,
      value: { action: 'close', root_id: rootId, session_id: sessionId },
    });
  }
  elements.push({ tag: 'action', actions: headerActions });

  // ── Quick-action keys (only when the screenshot is visible — in text mode
  //    there's no visible cursor/input, so these keys would fire blindly) ──
  if (displayMode === 'screenshot') {
    const mkKey = (label: string, key: string) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type: 'default' as const,
      value: { action: 'term_action', root_id: rootId, session_id: sessionId, key },
    });
    elements.push({
      tag: 'action',
      actions: [
        mkKey('Esc', 'esc'),
        mkKey('^C', 'ctrlc'),
        mkKey('Tab', 'tab'),
        mkKey('␣ Space', 'space'),
        mkKey('↵ Enter', 'enter'),
      ],
    });
    elements.push({
      tag: 'action',
      actions: [
        mkKey('←', 'left'),
        mkKey('↑', 'up'),
        mkKey('↓', 'down'),
        mkKey('→', 'right'),
        mkKey('⇞ 上半屏', 'half_page_up'),
        mkKey('⇟ 下半屏', 'half_page_down'),
      ],
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥️ ${escapeMd(title)} — ${statusMap[status]}` },
      template: templateMap[status],
    },
    elements,
  };
  return JSON.stringify(card);
}

/**
 * Build a Feishu interactive card with a dropdown selector for projects.
 * Returns a JSON string suitable for msg_type: 'interactive'.
 */
export function buildRepoSelectCard(projects: ProjectInfo[], currentPath?: string, rootMessageId?: string): string {
  const options = projects.map((p, i) => {
    const currentTag = p.path === currentPath ? ' ← 当前' : '';
    const typeTag = p.type === 'worktree' ? ' [worktree]' : '';
    return {
      text: { tag: 'plain_text' as const, content: `${i + 1}. ${p.name} (${p.branch})${typeTag}${currentTag}` },
      value: p.path,
    };
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '📁 项目仓库管理' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `当前活跃项目：**${escapeMd(currentPath ?? 'N/A')}**`,
        },
      },
      {
        tag: 'hr',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '选择仓库并切换' },
            options,
            value: { key: 'repo_switch', root_id: rootMessageId ?? '' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '▶️ 直接开启会话' },
            type: 'primary',
            value: { action: 'skip_repo', root_id: rootMessageId ?? '' },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'lark_md',
            content: '也可以回复 `/repo <编号>` 切换，例如：`/repo 1`',
          },
        ],
      },
    ],
  };

  return JSON.stringify(card);
}

// ─── TUI Prompt cards ───────────────────────────────────────────────────────

/**
 * Build a Feishu interactive card for a TUI prompt detected by ScreenAnalyzer.
 * Select-type options get buttons; input-type options shown in list with a note.
 */
export function buildTuiPromptCard(
  rootId: string,
  sessionId: string,
  description: string,
  options: Array<{ label?: string; text: string; selected: boolean; type?: string; keys?: string[] }>,
  multiSelect?: boolean,
  toggledIndices?: number[],
): string {
  const hasInputOption = options.some(o => o.type === 'input');
  const toggled = new Set(toggledIndices ?? []);

  // Build option list — skip confirm-type (shown as button only)
  const optionLines = options
    .filter(o => o.type !== 'confirm')
    .map((opt) => {
      const i = options.indexOf(opt);
      const label = opt.label || String(i + 1);
      if (opt.type === 'toggle') {
        const check = toggled.has(i) ? '☑' : '☐';
        return `${check} ${label}. ${escapeMd(opt.text)}`;
      }
      return opt.selected
        ? `**${label}. ${escapeMd(opt.text)}**`
        : `${label}. ${escapeMd(opt.text)}`;
    }).join('\n');

  // Build buttons — each carries its AI-provided key sequence
  const buttons: any[] = [];
  for (const opt of options) {
    const originalIndex = options.indexOf(opt);
    if (opt.type === 'input') continue;

    const isFinal = opt.type === 'select' || opt.type === 'confirm';
    const btnLabel = opt.type === 'confirm'
      ? `✅ ${opt.text}`
      : (opt.label || String(originalIndex + 1));

    buttons.push({
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: btnLabel },
      type: ((opt.type === 'confirm' || toggled.has(originalIndex)) ? 'primary' : opt.selected ? 'primary' : 'default') as 'primary' | 'default',
      value: {
        action: 'tui_keys',
        root_id: rootId,
        session_id: sessionId,
        keys: JSON.stringify(opt.keys ?? []),
        is_final: isFinal ? '1' : '0',
        selected_index: String(originalIndex),
        selected_text: opt.text,
        option_type: opt.type ?? 'select',
      },
    });
  }

  const elements: any[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: optionLines },
    },
    { tag: 'hr' },
    { tag: 'action', actions: buttons },
  ];

  // Form with input field for "Type something" options
  if (hasInputOption) {
    const inputOpt = options.find(o => o.type === 'input');
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'form',
      name: 'tui_input_form',
      elements: [
        {
          tag: 'input',
          name: 'tui_custom_input',
          placeholder: { tag: 'plain_text', content: '输入自定义回复…' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '📝 发送自定义回复' },
          type: 'primary',
          name: 'tui_input_submit',
          action_type: 'form_submit',
          value: {
            action: 'tui_text_input',
            root_id: rootId,
            session_id: sessionId,
            input_keys: JSON.stringify(inputOpt?.keys ?? []),
          },
        },
      ],
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: escapeMd(description) },
      template: 'orange',
    },
    elements,
  };
  return JSON.stringify(card);
}

/**
 * Build a "processing" TUI prompt card — shown immediately when user clicks a button.
 */
export function buildTuiPromptProcessingCard(selectedText: string): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '正在执行…' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `选择: **${escapeMd(selectedText)}**` },
      },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Build a resolved TUI prompt card — shows which option was selected.
 */
export function buildTuiPromptResolvedCard(selectedText: string): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `已选择` },
      template: 'green',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**${escapeMd(selectedText)}**` },
      },
    ],
  };
  return JSON.stringify(card);
}

// ─── Adopt cards ─────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

export function buildAdoptSelectCard(sessions: AdoptableSession[], rootMessageId?: string): string {
  const options = sessions.map((s) => {
    const project = s.cwd.split('/').pop() || s.cwd;
    const cliName = getCliDisplayName(s.cliId);
    const uptime = s.startedAt ? formatDuration(Date.now() - s.startedAt) : '未知';
    return {
      text: { tag: 'plain_text' as const, content: `${cliName} · ${project} · ${s.tmuxTarget} · ${uptime}` },
      value: JSON.stringify({ tmuxTarget: s.tmuxTarget, cliPid: s.cliPid }),
    };
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '📡 选择要接入的 CLI 会话' },
    },
    elements: [
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '选择 CLI 会话' },
            options,
            value: { key: 'adopt_select', root_id: rootMessageId ?? '' },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}
